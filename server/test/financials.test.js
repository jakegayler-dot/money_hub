// Income statement by enterprise and the cash flow statement, against a
// real Postgres (PGlite) with the app's schema and a small farm year.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { incomeStatement, cashFlowStatement, recordInventory } from '../lib/financials.js';
import { assetValueAt } from '../lib/balanceSheet.js';
import { todayISO, addDays } from '../lib/dates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => new Date(`${s}T00:00:00`), 1700: (s) => s };
const T = todayISO();
const Y = Number(T.slice(0, 4));
const FROM = `${Y}-01-01`;
const TO = `${Y}-12-31`;
const d = (n) => { const x = addDays(T, n); return x < FROM ? FROM : x; };
let db;

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const query = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
  const cat = async (name) => (await one('SELECT id FROM expense_categories WHERE name = $1', [name])).id;
  const newCat = async (name, kind = 'expense') => (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ($1, 'overhead', 'business', $2) RETURNING id`, [name, kind])).id;
  const ops = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('Ops', 'business', 'operating', 50000) RETURNING id`)).id;
  const res = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('Reserve', 'business', 'reserve', 11000) RETURNING id`)).id;
  const fuel = await newCat('Fuel & oil');
  const ins = await newCat('Insurance');
  const groc = await newCat('Groceries');
  const tx = (o) => one(
    `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, segment, is_transfer, is_capex, is_debt_service, gst_amount, cleared)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true) RETURNING id`,
    [o.account || ops, o.ledger || 'business', o.date || d(-10), o.amount, o.desc, o.category || null, o.segment || null,
      !!o.transfer, !!o.capex, !!o.debt, o.gst ?? null]);
  await tx({ amount: 20000, desc: 'Canola', category: await cat('Canola sales'), segment: 'grain' });
  await tx({ amount: 8000, desc: 'Calves', category: await cat('Calf sales'), segment: 'livestock' });
  await tx({ amount: -1050, desc: 'Diesel', category: fuel, segment: 'grain', gst: 50 });
  await tx({ amount: -600, desc: 'Farm insurance', category: ins }); // no owner: shared
  await tx({ amount: -200, desc: 'Groceries', category: groc, segment: 'jake', ledger: 'personal' });
  await tx({ amount: -30000, desc: 'Tractor', segment: 'grain', capex: true });
  const a = await tx({ amount: -1000, desc: 'To reserve', transfer: true });
  const b = await tx({ account: res, amount: 1000, desc: 'From ops', transfer: true });
  await db.query('UPDATE transactions SET transfer_peer_id = $1 WHERE id = $2', [b.id, a.id]);
  await db.query('UPDATE transactions SET transfer_peer_id = $1 WHERE id = $2', [a.id, b.id]);
  // A cattle loan: payment of 800 principal + 250 interest this year.
  const loan = (await one(`INSERT INTO loans (name, lender, purpose, principal, interest_rate_pct, term_months, start_date, segment, created_at)
    VALUES ('Cattle loan', 'FCC', 'term', 50000, 6, 60, $1, 'livestock', $2) RETURNING id`, [`${Y - 1}-06-01`, `${Y - 1}-06-01`])).id;
  const pay = await tx({ amount: -1050, desc: 'FCC payment', segment: 'livestock', debt: true });
  await db.query(`INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount, paid, paid_date, linked_transaction_id)
    VALUES ($1, $2, 800, 250, true, $2, $3)`, [loan, d(-10), pay.id]);
  // Hauled canola not yet paid for; a vet bill received, not paid; a tractor depreciating.
  await db.query(`INSERT INTO sale_contracts (commodity, quantity, unit, price_per_unit, total_value, counterparty, expected_payment_date, status, segment, delivered_on)
    VALUES ('Canola', 1000, 'bu', 15, 15000, 'Viterra', $1, 'delivered', 'grain', $2)`, [d(9), d(-5)]);
  await db.query(`INSERT INTO bills (name, amount, has_gst, gst_amount, frequency, due_date, received_date, status, ledger, segment)
    VALUES ('Vet', 525, true, 25, 'one_time', $1, $2, 'unpaid', 'business', 'livestock')`, [d(20), d(-3)]);
  await db.query(`INSERT INTO assets (name, category, value, value_date, annual_change_pct, segment) VALUES ('Tractor', 'machinery', 100000, $1, -20, 'grain')`, [FROM]);
  // Inventory now, and the year-end count it's measured from.
  await db.query(`INSERT INTO inventory_items (commodity, item_class, quantity, unit, price_per_unit) VALUES ('Canola', 'crop', 5000, 'bu', 13), ('Hay', 'forage', 500, 'bales', 40)`);
  const yearEnd = `${Y - 1}-12-31`;
  await db.query(`INSERT INTO inventory_valuations (date, item_class, owner, value, source) VALUES ($1, 'crop_feed', 'grain', 50000, 'manual'), ($1, 'crop_feed', 'livestock', 10000, 'manual')`, [yearEnd]);
});

after(async () => { await db?.close(); });

const line = (list, label) => list.find((x) => x.label === label);

test('income statement: cash lines by enterprise, shared costs apart, household out', async () => {
  const s = await incomeStatement({ from: FROM, to: TO });
  assert.equal(line(s.revenue.lines, 'Grain sales').grain, 20000);
  assert.equal(line(s.revenue.lines, 'Cattle sales').livestock, 8000);
  assert.equal(line(s.expenses.lines, 'Fuel & oil').grain, 1000); // GST out
  const insurance = line(s.expenses.lines, 'Insurance');
  assert.deepEqual([insurance.grain, insurance.livestock, insurance.shared], [0, 0, 600]);
  assert.equal(line(s.expenses.lines, 'Interest').livestock, 250);
  assert.ok(!line(s.expenses.lines, 'Groceries'), 'household spending is not the farm’s');
  assert.equal(s.cash_net_income.total, 20000 + 8000 - 1000 - 600 - 250);
});

test('income statement: accrual adjustments', async () => {
  const s = await incomeStatement({ from: FROM, to: TO });
  const adj = (k) => [...s.revenue.adjustments, ...s.expenses.adjustments].find((x) => x.key === k);
  assert.equal(s.complete, true);
  assert.equal(adj('inventory_crop').grain, 65000 - 50000);
  assert.equal(adj('inventory_crop').livestock, 20000 - 10000);
  assert.equal(adj('receivables').grain, 15000);
  assert.equal(adj('payables').livestock, 500); // without its GST
  const dep = 100000 - assetValueAt({ value: 100000, value_date: FROM, annual_change_pct: -20 }, T);
  assert.ok(Math.abs(adj('depreciation').grain - dep) < 0.02);
  const expected = s.cash_net_income.total + 15000 + 10000 + 15000 - 500 - adj('accrued_interest').total - adj('depreciation').total;
  assert.ok(Math.abs(s.net_income.total - expected) < 0.02);
  assert.ok(Math.abs(s.net_income.total - (s.net_income.grain + s.net_income.livestock + s.net_income.shared)) < 0.02);
});

test('income statement: no opening count → inventory change left out and said so', async () => {
  const s = await incomeStatement({ from: `${Y}-03-01`, to: TO });
  assert.equal(s.complete, false);
  assert.ok(!s.revenue.adjustments.some((x) => x.key.startsWith('inventory')));
  assert.equal(s.notes[0].key, 'no_opening_inventory');
});

test('daily inventory record serves as a later period’s start', async () => {
  await recordInventory(T);
  const { rows } = await db.query(`SELECT item_class, owner, value FROM inventory_valuations WHERE source = 'daily' ORDER BY 1, 2`);
  assert.deepEqual(rows.map((r) => [r.item_class, r.owner, Number(r.value)]), [['crop_feed', 'grain', 65000], ['crop_feed', 'livestock', 20000]]);
});

test('cash flow statement reconciles to the bank accounts', async () => {
  const c = await cashFlowStatement({ from: FROM, to: TO });
  assert.equal(c.reconciles, true);
  assert.equal(c.closing_cash, 61000);
  const sec = (k) => c.sections.find((x) => x.key === k);
  const amt = (k, l) => sec(k).lines.find((x) => x.key === l)?.amount ?? 0;
  assert.equal(amt('operating', 'farm_receipts'), 28000);
  assert.equal(amt('operating', 'farm_payments'), -1650);
  assert.equal(amt('operating', 'interest_paid'), -250);
  assert.equal(amt('investing', 'capital_purchases'), -30000);
  assert.equal(amt('financing', 'loan_principal'), -800);
  assert.equal(amt('financing', 'household'), -200);
  assert.equal(c.net_change, 28000 - 1650 - 250 - 30000 - 800 - 200);
  assert.ok(Math.abs(c.opening_cash + c.net_change - c.closing_cash) < 0.01);
});
