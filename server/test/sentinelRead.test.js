// Sentinel read API: auth, catalog, filters, limits, errors, summaries and
// "nothing secret, nothing written" — against a real Postgres (PGlite, in
// process) with the app's own schema.sql applied.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import sentinelReadRoute from '../routes/sentinelRead.js';
import { requireSignIn } from '../lib/appAuth.js';
import { COLLECTION_NAMES, centsToDollars } from '../lib/sentinelRead.js';
import { reginaToday } from '../lib/sentinelSnapshot.js';
import { addDays, addMonths } from '../lib/dates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY = 'test-action-key-0123456789';
const FULL_NUMBER = '4520123412349999';
const T = reginaToday();
const d = (n) => addDays(T, n);

let db;
let server;
let base;
const ids = {};

// node-pg conventions: DATE → local-midnight Date, NUMERIC → string.
const pgLike = { 1082: (s) => new Date(`${s}T00:00:00`), 1700: (s) => s };

async function seed() {
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const acct = (name, ledger, type, bal, last4 = null) => one(
    `INSERT INTO accounts (name, ledger, account_type, opening_balance, last4) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [name, ledger, type, bal, last4]);
  ids.farm = (await acct('Farm Operating', 'business', 'operating', 25000, '9876543210')).id; // careless long "last4"
  ids.house = (await acct('Household Chequing', 'personal', 'personal', 3000)).id;
  ids.reserve = (await acct('Reserve', 'business', 'reserve', 10000)).id;

  const payee = async (n) => (await one(`INSERT INTO payees (name) VALUES ($1) RETURNING id`, [n])).id;
  ids.coop = await payee('Co-op');
  ids.viterra = await payee('Viterra');
  ids.power = await payee('SaskPower');

  ids.fuel = (await one(`INSERT INTO expense_categories (name, class, ledger, kind, annual_total) VALUES ('Fuel & oil', 'variable_seasonal', 'business', 'expense', 12000) RETURNING id`)).id;
  ids.diesel = (await one(`INSERT INTO expense_categories (name, class, ledger, kind, parent_id, annual_total) VALUES ('Diesel', 'variable_seasonal', 'business', 'expense', $1, 6000) RETURNING id`, [ids.fuel])).id;
  ids.util = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Utilities', 'overhead', 'business', 'expense') RETURNING id`)).id;
  ids.canola = (await one(`SELECT id FROM expense_categories WHERE name = 'Canola sales'`)).id;

  const tx = (o) => one(
    `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, payee_id, segment, is_transfer, is_split, cleared)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [o.account, o.ledger || 'business', o.date, o.amount, o.description, o.category || null, o.payee || null, o.segment || null,
      !!o.transfer, !!o.split, o.cleared ?? true]);
  ids.t1 = (await tx({ account: ids.farm, date: T, amount: -250, description: 'Co-op cardlock diesel', category: ids.diesel, payee: ids.coop, segment: 'grain' })).id;
  ids.t2 = (await tx({ account: ids.farm, date: d(-1), amount: 5000, description: 'Viterra canola settlement', category: ids.canola, payee: ids.viterra, segment: 'grain' })).id;
  ids.t3 = (await tx({ account: ids.house, ledger: 'personal', date: d(-2), amount: -120, description: 'SaskPower', payee: ids.power, split: true, cleared: false })).id;
  await db.query(`INSERT INTO transaction_splits (transaction_id, amount, category_id, ledger, segment) VALUES ($1, -70, $2, 'business', 'grain'), ($1, -50, $2, 'personal', 'jake')`, [ids.t3, ids.util]);
  ids.t4 = (await tx({ account: ids.farm, date: d(-3), amount: -1000, description: 'To reserve', transfer: true })).id;
  ids.t5 = (await tx({ account: ids.house, ledger: 'personal', date: d(-40), amount: -80, description: 'Co-op lunch', payee: ids.coop, segment: 'jake' })).id;

  const bill = (o) => one(
    `INSERT INTO bills (name, amount, frequency, due_date, status, paid_date, payee_id, category_id, ledger, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'business', $9) RETURNING id`,
    [o.name, o.amount, o.frequency || 'one_time', o.due, o.status || 'unpaid', o.paid || null, o.payee || null, o.category || null, o.notes || null]);
  ids.b1 = (await bill({ name: 'SaskPower — Inv 1', amount: 300, frequency: 'monthly', due: d(-5), payee: ids.power, category: ids.util, notes: 'x'.repeat(3000) })).id;
  ids.b2 = (await bill({ name: 'Co-op fuel invoice', amount: 1200, due: d(10), payee: ids.coop, category: ids.diesel })).id;
  ids.b3 = (await bill({ name: 'Old bill', amount: 50, due: d(-60), status: 'paid', paid: d(-58) })).id;
  await db.query(`INSERT INTO vendor_credits (payee_id, kind, amount, date) VALUES ($1, 'prepayment', 500, $2)`, [ids.coop, d(-20)]);

  ids.loan = (await one(`INSERT INTO loans (name, lender, purpose, principal, interest_rate_pct, term_months, start_date, covenant_notes)
    VALUES ('Grain truck', 'FCC', 'term', 50000, 6, 60, $1, 'Annual statements due') RETURNING id`, [d(-30)])).id;
  const lp = (due, paid) => db.query(`INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount, paid, paid_date) VALUES ($1, $2, 800, 250, $3, $4)`,
    [ids.loan, due, paid, paid ? due : null]);
  await lp(d(-33), true); await lp(d(-3), false); await lp(d(27), false); await lp(d(57), false);
  await db.query(`INSERT INTO loan_verifications (loan_id, verified_on, balance, interest_rate_pct, expected_balance, expected_rate_pct, source)
    VALUES ($1, $2, 49000, 6, 49200, 6, 'statement')`, [ids.loan, d(-10)]);

  ids.card = (await one(`INSERT INTO credit_cards (name, issuer, last4, apr_purchase, current_balance, credit_limit) VALUES ('Visa Gold', 'TD', '4321', 20.99, 750, 5000) RETURNING id`)).id;
  await db.query(`INSERT INTO credit_card_statements (credit_card_id, statement_date, due_date, statement_balance, minimum_payment) VALUES ($1, $2, $3, 700, 25)`, [ids.card, d(-6), d(15)]);
  await db.query(`INSERT INTO credit_card_reward_categories (credit_card_id, category, rate_pct) VALUES ($1, 'Fuel', 2)`, [ids.card]);

  await db.query(`INSERT INTO sale_contracts (commodity, quantity, unit, price_per_unit, total_value, counterparty, expected_payment_date, status)
    VALUES ('Canola', 1000, 'bu', 15, 15000, 'Viterra', $1, 'open')`, [d(20)]);
  await db.query(`INSERT INTO cash_estimates (name, direction, amount, start_date) VALUES ('Calf sales', 'inflow', 60000, $1)`, [d(45)]);
  await db.query(`INSERT INTO assets (name, category, value, value_date) VALUES ('Home quarter', 'land', 400000, $1)`, [d(-100)]);
  await db.query(`INSERT INTO inventory_items (commodity, quantity, unit, price_per_unit) VALUES ('Canola', 5000, 'bu', 13)`);
  await db.query(`INSERT INTO owner_draws (date, amount, note) VALUES ($1, 2000, 'Monthly draw')`, [d(-7)]);
  await db.query(`INSERT INTO reserve_transfers (date, amount, direction) VALUES ($1, 1000, 'sweep_in')`, [d(-3)]);
  await db.query(`INSERT INTO purchase_evaluations (name, price, purchase_class, decision) VALUES ('Bale processor', 30000, 'productive_tool', 'pass')`);
  ids.imp = (await one(`INSERT INTO statement_imports (source, external_id, account_id, period_start, period_end, opening_balance, closing_balance)
    VALUES ('agent', 'imp-1', $1, $2, $3, 20000, 25000) RETURNING id`, [ids.farm, d(-30), d(-1)])).id;
  await db.query(`INSERT INTO statement_lines (import_id, source, external_id, account_id, date, amount, description, payload, status, reason)
    VALUES ($1, 'agent', 'line-1', $2, $3, -42.5, 'UNKNOWN POS', $4, 'held', 'No match')`,
  [ids.imp, ids.farm, d(-4), JSON.stringify({ account_number: FULL_NUMBER, raw: 'secret raw line' })]);
  await db.query(`INSERT INTO receipts (mime, bytes, image, status, extracted, transaction_id)
    VALUES ('image/png', 4, decode('89504e47', 'hex'), 'matched', $1, $2)`,
  [JSON.stringify({ doc_type: 'receipt', date: T, party: 'Co-op', total: 250, gst: 11.9, card_number: FULL_NUMBER, items: [{ description: 'Diesel', amount: 250 }] }), ids.t1]);
  await db.query(`INSERT INTO gst_returns (period_start, period_end, filed_on, net_amount) VALUES ('2026-01-01', '2026-03-31', '2026-04-20', -812.4)`);
  await db.query(`INSERT INTO closed_periods (month, note) VALUES ('2026-01-01', 'Q1 done')`);
  await db.query(`INSERT INTO vendor_reconciliations (payee_id, statement_date, statement_balance, status) VALUES ($1, $2, 700, 'done')`, [ids.coop, d(-15)]);
  await db.query(`INSERT INTO forecast_scenarios (name, data) VALUES ('Dry year', '{"price_pct": -20}')`);
  await db.query(`INSERT INTO settings (key, value) VALUES ('some_api_token', '"tok-should-never-leak"')`);
}

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const query = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  await seed();

  const app = express();
  app.use('/api/sentinel/read', sentinelReadRoute);
  app.use('/api', requireSignIn); // same order as index.js
  app.get('/api/other', (req, res) => res.json({ ok: true }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await db?.close();
});

const auth = { Authorization: `Bearer ${KEY}` };
async function get(path, headers = auth, method = 'GET') {
  const res = await fetch(base + path, { method, headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const read = (path) => get(`/api/sentinel/read${path}`);
const withKey = async (fn) => {
  process.env.SENTINEL_ACTION_KEY = KEY;
  try { return await fn(); } finally { delete process.env.SENTINEL_ACTION_KEY; }
};

// ---- Auth ----------------------------------------------------------------

test('no SENTINEL_ACTION_KEY configured: 503', async () => {
  delete process.env.SENTINEL_ACTION_KEY;
  const r = await get('/api/sentinel/read');
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: 'Sentinel actions are not configured' });
});

test('missing or wrong key: 401; right key: 200', () => withKey(async () => {
  for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: KEY }, { 'X-Api-Key': KEY }, { Authorization: `Bearer ${KEY}x` }]) {
    const r = await get('/api/sentinel/read/accounts', headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.deepEqual(r.body, { error: 'Unauthorized' });
  }
  assert.equal((await get('/api/sentinel/read/accounts')).status, 200);
}));

test('only /api/sentinel/read is exempt from the app sign-in, and only with the key', () => withKey(async () => {
  process.env.APP_PASSWORD = 'hunter2-app-password';
  try {
    assert.equal((await get('/api/sentinel/read/accounts')).status, 200);
    const other = await get('/api/other'); // the key doesn't open anything else
    assert.equal(other.status, 401);
    assert.equal(other.body.signIn, true);
  } finally { delete process.env.APP_PASSWORD; }
}));

test('read only: anything but GET is refused', () => withKey(async () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await get('/api/sentinel/read/accounts', auth, m)).status, 405, m);
    assert.equal((await get('/api/sentinel/read/accounts', {}, m)).status, 401, `${m} without key`);
  }
}));

// ---- Catalog ---------------------------------------------------------------

test('catalog lists every collection with description, filters and fields', () => withKey(async () => {
  const r = await read('');
  assert.equal(r.status, 200);
  assert.equal(r.body.app, 'money_hub');
  const names = r.body.collections.map((c) => c.name);
  assert.deepEqual(names, COLLECTION_NAMES);
  for (const want of ['accounts', 'transactions', 'categories', 'bills', 'loans', 'loan_payments', 'credit_cards', 'contracts', 'estimates',
    'assets', 'inventory', 'balances', 'spending_by_category', 'budget_vs_actual', 'upcoming', 'cash_flow_forecast', 'liquidity', 'net_worth',
    'debt_coverage', 'overview']) assert.ok(names.includes(want), want);
  for (const c of r.body.collections) {
    assert.ok(c.description.length > 20 && !c.description.includes('\n'), c.name);
    assert.ok(c.filters.includes('id'), c.name);
    assert.ok(Array.isArray(c.fields) && c.fields.includes('id'), c.name);
  }
  const tx = r.body.collections.find((c) => c.name === 'transactions');
  for (const fl of ['search', 'id', 'from', 'to', 'account', 'category', 'payee', 'min_amount', 'max_amount', 'month', 'type']) assert.ok(tx.filters.includes(fl), fl);
}));

test('every collection answers in the contract shape, with only catalogued fields', () => withKey(async () => {
  const { body: cat } = await read('');
  for (const c of cat.collections) {
    const r = await read(`/${c.name}`);
    assert.equal(r.status, 200, `${c.name}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(Object.keys(r.body).sort(), ['collection', 'count', 'rows', 'total', 'truncated'], c.name);
    assert.equal(r.body.collection, c.name);
    assert.equal(r.body.count, r.body.rows.length);
    assert.ok(r.body.total >= r.body.count);
    assert.equal(r.body.truncated, r.body.total > r.body.count);
    assert.ok(r.body.count > 0, `${c.name} returned no rows from the seed`);
    for (const row of r.body.rows) {
      for (const k of Object.keys(row)) assert.ok(c.fields.includes(k), `${c.name}.${k} not in catalog fields`);
      for (const [k, v] of Object.entries(row)) {
        if (/(_date|_on)$/.test(k) && v != null && typeof v === 'string') assert.match(v, /^\d{4}-\d{2}-\d{2}$/, `${c.name}.${k}`);
      }
    }
  }
}));

// ---- Records and filters ----------------------------------------------------

test('transactions: newest first, names not ids, signed dollars, splits', () => withKey(async () => {
  const { body } = await read('/transactions');
  assert.equal(body.total, 5);
  const dates = body.rows.map((r) => r.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
  const t1 = body.rows.find((r) => r.id === ids.t1);
  assert.equal(t1.amount, -250);
  assert.equal(t1.date, T);
  assert.equal(t1.account, 'Farm Operating');
  assert.equal(t1.payee, 'Co-op');
  assert.equal(t1.category, 'Fuel & oil › Diesel');
  assert.equal(t1.owner, 'Grain');
  assert.equal(t1.kind, 'expense');
  assert.equal(t1.documents, 1);
  assert.equal(body.rows.find((r) => r.id === ids.t4).kind, 'transfer');
}));

test('transactions filters: search, account, payee, category (split pieces too), amounts, direction, type, dates, month', () => withKey(async () => {
  const idsOf = async (qs) => { const r = await read(`/transactions?${qs}`); assert.equal(r.status, 200, qs); return r.body.rows.map((x) => x.id).sort((a, b) => a - b); };
  assert.deepEqual(await idsOf('search=co-op'), [ids.t1, ids.t5]); // description or payee, any case
  assert.deepEqual(await idsOf('search=DIESEL'), [ids.t1]); // category
  assert.deepEqual(await idsOf('account=household'), [ids.t3, ids.t5]);
  assert.deepEqual(await idsOf(`account=${ids.farm}`), [ids.t1, ids.t2, ids.t4]);
  assert.deepEqual(await idsOf('payee=viterra'), [ids.t2]);
  assert.deepEqual(await idsOf('category=utilities'), [ids.t3]);
  assert.deepEqual(await idsOf('min_amount=1000'), [ids.t2, ids.t4]);
  assert.deepEqual(await idsOf('min_amount=100&max_amount=$300'), [ids.t1, ids.t3]);
  assert.deepEqual(await idsOf('direction=in'), [ids.t2]);
  assert.deepEqual(await idsOf('type=transfer'), [ids.t4]);
  assert.deepEqual(await idsOf('type=expense&owner=jake'), [ids.t3, ids.t5]);
  assert.deepEqual(await idsOf(`from=${d(-2)}&to=${d(-1)}`), [ids.t2, ids.t3]);
  assert.deepEqual(await idsOf(`month=${d(-40).slice(0, 7)}&payee=co-op`), [ids.t5]);
  assert.deepEqual(await idsOf('cleared=false'), [ids.t3]);
  assert.deepEqual(await idsOf('search=100%25_off'), []); // wildcards are literal
}));

test('id returns one record in full', () => withKey(async () => {
  const { body } = await read(`/transactions?id=${ids.t3}`);
  assert.equal(body.count, 1);
  assert.equal(body.total, 1);
  const t = body.rows[0];
  assert.equal(t.category, 'Split');
  assert.deepEqual(t.splits.map((s) => [s.amount, s.category, s.ledger, s.owner]), [[-70, 'Utilities', 'business', 'Grain'], [-50, 'Utilities', 'personal', 'Jake']]);
  assert.equal((await read('/transactions?id=999999')).body.count, 0);
}));

test('limit: default 50, max 200, truncated flag and total before limit', () => withKey(async () => {
  const r = await read('/transactions?limit=2');
  assert.equal(r.body.count, 2);
  assert.equal(r.body.total, 5);
  assert.equal(r.body.truncated, true);
  assert.deepEqual(r.body.rows.map((x) => x.id), [ids.t1, ids.t2]); // the two most recent
  for (let i = 0; i < 260; i++) {
    await db.query(`INSERT INTO owner_draws (date, amount, note) VALUES ($1, $2, 'bulk')`, [d(-400 - i), 10 + i]);
  }
  try {
    const big = await read('/owner_draws?limit=1000');
    assert.equal(big.body.count, 200);
    assert.equal(big.body.total, 261);
    assert.equal(big.body.truncated, true);
    assert.equal((await read('/owner_draws')).body.count, 50);
  } finally {
    await db.query(`DELETE FROM owner_draws WHERE note = 'bulk'`);
  }
}));

test('bills: status filters, owing, order, long text trimmed', () => withKey(async () => {
  const unpaid = (await read('/bills?status=unpaid')).body.rows;
  assert.deepEqual(unpaid.map((b) => b.id), [ids.b1, ids.b2]); // soonest first
  const overdue = (await read('/bills?status=overdue')).body.rows;
  assert.deepEqual(overdue.map((b) => b.id), [ids.b1]);
  assert.equal(overdue[0].overdue, true);
  assert.equal(overdue[0].vendor, 'SaskPower');
  assert.equal(overdue[0].category, 'Utilities');
  assert.ok(overdue[0].notes.length <= 1000 && overdue[0].notes.endsWith('…'));
  const paid = (await read('/bills?status=paid')).body.rows;
  assert.equal(paid[0].owing_now, 0);
  assert.equal((await read('/bills?vendor=co-op')).body.rows[0].owing_now, 1200);
  assert.deepEqual((await read(`/bills?from=${d(0)}&to=${d(30)}`)).body.rows.map((b) => b.id), [ids.b2]);
}));

test('loans, loan payments, cards, contracts, vendors read like the app', () => withKey(async () => {
  const [loan] = (await read('/loans')).body.rows;
  assert.equal(loan.name, 'Grain truck');
  assert.equal(loan.outstanding_balance, 48400); // 50,000 − 2 rows paid or already due
  assert.equal(loan.overdue_unrecorded_payments, 1);
  assert.deepEqual(loan.next_payment, { date: d(27), amount: 1050 });
  const pays = (await read('/loan_payments?status=unpaid')).body.rows;
  assert.deepEqual(pays.map((p) => p.due_date), [d(-3), d(27), d(57)]);
  assert.equal((await read('/loan_payments?status=overdue')).body.count, 1);
  assert.equal((await read('/loan_payments?loan=fcc&status=paid')).body.count, 1);
  const [card] = (await read('/credit_cards')).body.rows;
  assert.equal(card.balance_owed, 750);
  assert.equal(card.utilization_pct, 15);
  assert.deepEqual(card.next_due, { due_date: d(15), amount: 700, minimum_payment: 25, overdue: false });
  const [contract] = (await read('/contracts?status=unsettled')).body.rows;
  assert.equal(contract.remaining, 15000);
  const coop = (await read('/vendors?search=co-op')).body.rows[0];
  assert.equal(coop.owing, 1200);
  assert.equal(coop.deposits_held, 500);
  assert.equal(coop.net_owing, 700);
  assert.deepEqual((await read('/vendors?has_balance=true')).body.rows.map((v) => v.name).sort(), ['Co-op', 'SaskPower']);
}));

// ---- Summaries ----------------------------------------------------------------

test('balances: every account and card, with totals', () => withKey(async () => {
  const rows = (await read('/balances')).body.rows;
  const by = Object.fromEntries(rows.map((r) => [r.id, r.balance]));
  assert.equal(by.total_cash, 38000);
  assert.equal(by.business_cash, 35000);
  assert.equal(by.personal_cash, 3000);
  assert.equal(by.credit_card_debt, -750);
  assert.equal(by.net_liquidity, 37250);
  assert.equal(by[`account-${ids.farm}`], 25000);
  assert.equal(by[`card-${ids.card}`], -750);
  assert.equal((await read('/balances?kind=total')).body.count, 5);
}));

test('spending by category and budget vs actual match the Income & Expenses rules', () => withKey(async () => {
  const month = T.slice(0, 7);
  const sp = (await read(`/spending_by_category?month=${month}`)).body.rows;
  const fuel = sp.find((r) => r.name === 'Fuel & oil');
  assert.equal(fuel.total, 250);
  assert.deepEqual(fuel.subcategories, [{ name: 'Diesel', total: 250 }]);
  assert.equal(sp[0].id, 'total');
  assert.ok(!sp.some((r) => r.name === 'Canola sales')); // income isn't spending
  const inc = (await read(`/spending_by_category?year=${T.slice(0, 4)}&kind=income`)).body.rows;
  assert.equal(inc.find((r) => r.name === 'Grain sales').total, 5000);
  const farmOnly = (await read(`/spending_by_category?month=${month}&owner=jake`)).body.rows;
  assert.ok(!farmOnly.some((r) => r.name === 'Fuel & oil'));

  const bva = (await read(`/budget_vs_actual?month=${month}`)).body.rows;
  const fb = bva.find((r) => r.name === 'Fuel & oil');
  const m = Number(month.slice(5)) - 1;
  const pct = [0.0833, 0.0833, 0.0834, 0.0833, 0.0833, 0.0834, 0.0833, 0.0833, 0.0834, 0.0833, 0.0833, 0.0834][m];
  assert.equal(fb.budget, Math.round(18000 * pct * 100) / 100); // parent + subcategory budgets
  assert.equal(fb.actual, 250);
  assert.equal(fb.remaining, Math.round((18000 * pct - 250) * 100) / 100);
  const yr = (await read('/budget_vs_actual')).body.rows.find((r) => r.name === 'Fuel & oil');
  assert.equal(yr.budget, 18000);
  assert.equal((await read('/budget_vs_actual?over_budget=true')).body.rows.some((r) => r.name === 'Fuel & oil'), false);
}));

test('upcoming: next 30 days plus overdue, money out negative, recurring instances', () => withKey(async () => {
  const rows = (await read('/upcoming')).body.rows;
  const key = (r) => `${r.type}:${r.date}:${r.amount}:${r.overdue}`;
  const got = rows.map(key);
  assert.ok(got.includes(`bill:${d(-5)}:-300:true`));
  assert.ok(got.includes(`bill:${addMonths(d(-5), 1)}:-300:false`)); // next instance of the monthly bill
  assert.equal(rows.find((r) => r.date === addMonths(d(-5), 1) && r.type === 'bill').recurring_instance, true);
  assert.ok(got.includes(`bill:${d(10)}:-1200:false`));
  assert.ok(got.includes(`loan_payment:${d(-3)}:-1050:true`));
  assert.ok(got.includes(`loan_payment:${d(27)}:-1050:false`));
  assert.ok(got.includes(`card_payment:${d(15)}:-700:false`));
  assert.ok(got.includes(`contract_payment:${d(20)}:15000:false`));
  assert.ok(!got.some((g) => g.startsWith(`loan_payment:${d(57)}`))); // beyond 30 days
  assert.deepEqual(rows.map((r) => r.date), rows.map((r) => r.date).sort());
  const window = (await read(`/upcoming?from=${d(0)}&to=${d(60)}&include_overdue=false&type=loan_payment`)).body.rows;
  assert.deepEqual(window.map((r) => r.date), [d(27), d(57)]);
  assert.deepEqual((await read('/upcoming?direction=in')).body.rows.map((r) => r.type), ['contract_payment']);
}));

test('forecast, liquidity, net worth, coverage, overview, tax and GST summaries', () => withKey(async () => {
  const fc = (await read('/cash_flow_forecast')).body.rows;
  assert.equal(fc[0].id, 'summary');
  assert.equal(fc[0].starting_balance, 38000);
  assert.equal(fc.filter((r) => r.kind === 'month').length, 12);
  assert.equal((await read('/cash_flow_forecast?months=24')).body.total, 25);

  const [liq] = (await read('/liquidity')).body.rows;
  assert.equal(liq.cash_today, 38000);
  assert.equal(typeof liq.passes, 'boolean');

  const [nw] = (await read('/net_worth')).body.rows;
  assert.equal(nw.cash, 38000);
  assert.equal(nw.capital_assets, 400000);
  assert.equal(nw.inventory, 65000 * (4000 / 5000)); // 1,000 bu contracted → only 4,000 bu counted
  assert.equal(nw.loans_outstanding, 48400);
  assert.equal(nw.credit_card_debt, 750);
  assert.equal(nw.net_worth, 38000 + 400000 + 52000 - 48400 - 750);

  const cov = (await read('/debt_coverage')).body.rows;
  assert.deepEqual(cov.map((r) => r.id), ['projected', 'historical']);

  const [ov] = (await read('/overview')).body.rows;
  assert.equal(typeof ov.status_line, 'string');
  assert.ok(!JSON.stringify(ov).includes('_cents'));
  assert.equal(ov.forecast_90d.points[0].balance, 38000);

  const [tax] = (await read('/income_tax_estimate')).body.rows;
  assert.equal(tax.year, Number(T.slice(0, 4)));
  assert.ok(tax.projected && typeof tax.projected.net_income === 'number');
  assert.equal((await read(`/gst?year=${T.slice(0, 4)}`)).body.count >= 1, true);
}));

test('centsToDollars renames *_cents to dollars recursively', () => {
  assert.deepEqual(centsToDollars({ a_cents: 12345, b: [{ c_cents: -5 }], s: 'x' }), { a: 123.45, b: [{ c: -0.05 }], s: 'x' });
});

// ---- Errors ----------------------------------------------------------------

test('404 unknown collection, 422 bad filters', () => withKey(async () => {
  assert.equal((await read('/nope')).status, 404);
  assert.equal((await read('/settings')).status, 404); // internal tables aren't collections
  const bad = ['/transactions?colour=red', '/transactions?from=2026-13-01', '/transactions?from=yesterday', '/transactions?min_amount=lots',
    '/transactions?type=gift', '/transactions?limit=0', '/transactions?limit=abc', '/transactions?id=abc', '/transactions?search=a&search=b',
    `/transactions?from=${d(1)}&to=${d(0)}`, '/accounts?from=2026-01-01', '/spending_by_category?month=2026-1', '/transactions?sort=amount',
    '/transactions?account[]=1'];
  for (const p of bad) {
    const r = await read(p);
    assert.equal(r.status, 422, p);
    assert.equal(typeof r.body.error, 'string', p);
  }
}));

// ---- Nothing secret, nothing written ----------------------------------------------

async function fingerprint() {
  const { rows: tables } = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  const out = {};
  for (const { tablename } of tables) {
    const { rows: [r] } = await db.query(`SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM "${tablename}" t`);
    out[tablename] = `${r.n}:${r.h}`;
  }
  return out;
}

test('no secrets, full account numbers, raw payloads or images; nothing is written', () => withKey(async () => {
  process.env.APP_PASSWORD = 'hunter2-app-password';
  process.env.INGEST_API_KEY = 'ingest-key-should-never-leak';
  try {
    const before = await fingerprint();
    const { body: cat } = await read('');
    let all = JSON.stringify(cat);
    for (const c of cat.collections) all += JSON.stringify((await read(`/${c.name}?limit=200`)).body);
    for (const secret of [FULL_NUMBER, KEY, 'hunter2-app-password', 'ingest-key-should-never-leak', 'tok-should-never-leak', 'secret raw line', '9876543210', 'iVBOR', '89504e47']) {
      assert.ok(!all.includes(secret), `leaked ${secret}`);
    }
    assert.ok(!/"(image|payload|candidates|password|api_key|token|external_id)"/.test(all));
    const acct = (await read(`/accounts?id=${ids.farm}`)).body.rows[0];
    assert.equal(acct.last4, '3210');
    const [rec] = (await read('/receipts')).body.rows;
    assert.equal(rec.party, 'Co-op');
    assert.equal(rec.items, 1);
    assert.equal(rec.size_kb, 0);
    assert.deepEqual(await fingerprint(), before);
  } finally {
    delete process.env.APP_PASSWORD;
    delete process.env.INGEST_API_KEY;
  }
}));
