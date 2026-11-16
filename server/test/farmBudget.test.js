// One budget for the sole proprietorship (Jake, Nov 15: "i just want all expenses included in the budget"). What's in it
// (Nov 16: "This category must include all that which is not already in cash flow forecast!"): Randy's rent is in the
// forecast, farm fuel is Fuel & vehicle, and the small capital buys at RB Auction count.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { budgetView, lineEntries, LINE_KEYS, whoseKey } from '../lib/householdBudget.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, ops, joint;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const TODAY = '2026-11-15';
const cat = {};
const payee = {};

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  ops = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Ops', 'business', 'operating', 0, 'grain') RETURNING id`)).id;
  joint = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Joint', 'personal', 'personal', 0, 'jake') RETURNING id`)).id;
  for (const n of ['Fuel & oil', 'Fertilizer', 'Seed', 'Repairs & maintenance', 'Groceries', 'Machinery', 'Equipment', 'Land Rent', 'Chemical']) {
    cat[n] = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ($1, 'variable_seasonal', 'business', 'expense') RETURNING id`, [n])).id;
  }
  for (const n of ['Randy Greenfeed', 'RB Auction', 'Nutrien']) payee[n] = (await one(`INSERT INTO payees (name) VALUES ($1) RETURNING id`, [n])).id;
  const add = (date, amount, category, { account = ops, segment = 'grain', gst = null, capex = false, split = null, to = null } = {}) => one(
    `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, segment, gst_amount, is_capex,
                               is_segment_split, segment_grain_pct, segment_jake_pct, payee_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [account, account === ops ? 'business' : 'personal', date, amount, category, cat[category], split ? null : segment, gst, capex, !!split,
      split?.[0] ?? null, split?.[1] ?? null, to ? payee[to] : null]);
  await add('2026-11-03', -2100, 'Fuel & oil', { gst: 100 });                 // farm fuel: $2,000 on Fuel & vehicle (GST comes back)
  await add('2026-11-04', -24000, 'Fertilizer');                              // nothing plans it: Other
  await add('2026-11-05', -380, 'Repairs & maintenance', { split: [50, 50] }); // $190 farm on Other, $190 Jake's on Household & home
  await add('2026-11-08', -640, 'Groceries', { account: joint, segment: 'jake' });
  await add('2026-11-06', -3400, 'Machinery', { capex: true, to: 'RB Auction' }); // a small capital buy: Other
  // A big capital buy the forecast already has as an estimate this month: not in the budget.
  await add('2026-11-09', -95000, 'Equipment', { capex: true });
  await one(`INSERT INTO cash_estimates (name, category, direction, amount, frequency, start_date) VALUES ('New drill', 'Equipment', 'outflow', 95000, 'one_time', '2026-11-20') RETURNING id`);
  // Seed planned by a spring estimate, but bought now: the estimate isn't this month, so it's in the budget.
  await add('2026-11-10', -1500, 'Seed');
  await one(`INSERT INTO cash_estimates (name, category, direction, amount, frequency, start_date) VALUES ('Seed', 'Seed', 'outflow', 40000, 'one_time', '2027-04-15') RETURNING id`);
  // Randy's rent: his rent bill is in the forecast (projected every year), though this payment isn't linked to it.
  await one(`INSERT INTO bills (name, ledger, amount, frequency, due_date, status, payee_id, category, category_id) VALUES ('Randy rent', 'business', 4200, 'one_time', '2025-11-01', 'paid', $1, 'Land Rent', $2) RETURNING id`, [payee['Randy Greenfeed'], cat['Land Rent']]);
  await add('2026-11-01', -4200, 'Land Rent', { to: 'Randy Greenfeed' });
  // Another landlord's rent bill on the parent category, paid under a sub-category with no payee: still the forecast's.
  const greenfeed = (await one(`INSERT INTO expense_categories (name, class, ledger, kind, parent_id) VALUES ('Greenfeed', 'variable_seasonal', 'business', 'expense', $1) RETURNING id`, [cat['Land Rent']])).id;
  await one(`INSERT INTO bills (name, ledger, amount, frequency, due_date, status, category, category_id) VALUES ('Dancey rent', 'business', 3000, 'one_time', '2025-11-02', 'paid', 'Land Rent', $1) RETURNING id`, [cat['Land Rent']]);
  await one(`INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, segment) VALUES ($1, 'business', '2026-11-02', -3000, 'cheque 512', $2, 'grain') RETURNING id`, [ops, greenfeed]);
  // An estimate that names the payee, dated a couple of weeks before the payment: planned, out.
  payee['Pattison Liquid'] = (await one(`INSERT INTO payees (name) VALUES ('Pattison Liquid') RETURNING id`)).id;
  await one(`INSERT INTO cash_estimates (name, direction, amount, frequency, start_date) VALUES ('Pattison Liquid fall fertilizer', 'outflow', 8000, 'one_time', '2026-10-28') RETURNING id`);
  await add('2026-11-11', -8000, 'Fertilizer', { to: 'Pattison Liquid' });
  // Land rent paid against its bill: planned, out.
  const rent = await add('2026-11-01', -7000, 'Fertilizer');
  await one(`INSERT INTO bills (name, ledger, amount, frequency, due_date, status, linked_transaction_id) VALUES ('Land rent', 'business', 7000, 'one_time', '2026-11-01', 'paid', $1) RETURNING id`, [rent.id]);
  // A lump sum on Nutrien's account, applied to its invoices (the invoices are the forecast's bills): out.
  const lump = await add('2026-11-12', -5000, 'Chemical', { to: 'Nutrien' });
  await one(`INSERT INTO vendor_on_account (transaction_id) VALUES ($1) RETURNING transaction_id`, [lump.id]);
  await one(`INSERT INTO settings (key, value) VALUES ('household_budget_by_month', $1)`, [JSON.stringify({ '2026-11': 3000 })]);
});
after(async () => { await db?.close(); });

test('the budget is everything the cash flow forecast does not already plan, on its proper line', async () => {
  const v = await budgetView({ month: '2026-11', today: TODAY });
  assert.deepEqual(v.lines.map((l) => l.key), LINE_KEYS, 'no new lines');
  const line = (k) => v.lines.find((l) => l.key === k);
  assert.equal(line('fuel').spent, 2000, 'farm fuel is Fuel & vehicle');
  assert.equal(line('fuel').farm, 2000);
  assert.equal(line('other').spent, 24000 + 190 + 3400 + 1500, 'fertilizer, the farm half of the repair, the RB Auction buy, the seed');
  assert.equal(line('other').farm, 24000 + 190 + 3400 + 1500);
  assert.ok(line('other').categories.some((c) => c.name === 'Machinery (capital)' && c.spent === 3400), 'the capital buy is named as one');
  assert.ok(!line('other').categories.some((c) => /Land Rent|Equipment|Chemical/.test(c.name)), 'rent, the planned drill and the lump sum are out');
  assert.equal(line('groceries').spent, 640);
  assert.equal(line('home').spent, 190, 'only the household half of the repair; a farm repair is not the home');
  assert.equal(v.total.budget, 3000);
  const farm = 2000 + 24000 + 190 + 3400 + 1500;
  assert.equal(v.total.spent, farm + 190 + 640);
  assert.equal(v.total.farm, farm);
  assert.equal(v.months.find((m) => m.month === '2026-11').farm, farm);

  // Jake's view leaves the farm out.
  const jake = await budgetView({ month: '2026-11', who: 'jake', today: TODAY });
  assert.equal(jake.lines.find((l) => l.key === 'other').spent, 0);
  assert.equal(jake.lines.find((l) => l.key === 'fuel').spent, 0);

  // The entries behind Other, farm ones tagged grain; the entries behind Fuel & vehicle.
  const e = await lineEntries({ month: '2026-11', line: 'other', today: TODAY });
  assert.deepEqual(e.map((x) => [x.amount, x.whose]).sort((a, b) => b[0] - a[0]), [[24000, 'grain'], [3400, 'grain'], [1500, 'grain'], [190, 'mixed']]);
  assert.deepEqual((await lineEntries({ month: '2026-11', line: 'fuel', today: TODAY })).map((x) => x.amount), [2000]);
  assert.equal(whoseKey({ segment: 'livestock' }), 'livestock');
});
