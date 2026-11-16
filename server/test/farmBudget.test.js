// One budget for the sole proprietorship (Jake, Nov 15: "Why is spending and budget not accounting for farm purchases? This is
// a sole prop so spending and personal are all tied together into a single budget").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { budgetView, lineEntries, setLine, farmLineFor, farmBudgets, monthTotal, whoseKey } from '../lib/householdBudget.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, ops, joint;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const TODAY = '2026-11-15';
const cat = {};

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  ops = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Ops', 'business', 'operating', 0, 'grain') RETURNING id`)).id;
  joint = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Joint', 'personal', 'personal', 0, 'jake') RETURNING id`)).id;
  for (const n of ['Fuel & oil', 'Fertilizer', 'Repairs & maintenance', 'Groceries', 'Machinery']) {
    cat[n] = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ($1, 'variable_seasonal', 'business', 'expense') RETURNING id`, [n])).id;
  }
  const add = (date, amount, category, { account = ops, segment = 'grain', gst = null, capex = false, split = null } = {}) => one(
    `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, segment, gst_amount, is_capex,
                               is_segment_split, segment_grain_pct, segment_jake_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [account, account === ops ? 'business' : 'personal', date, amount, category, cat[category], split ? null : segment, gst, capex, !!split,
      split?.[0] ?? null, split?.[1] ?? null]);
  // Last November (the budget's basis) and this one.
  await add('2025-10-02', -10, 'Groceries', { account: joint, segment: 'jake' }); // the ledger starts in October 2025
  await add('2025-11-06', -1800, 'Fuel & oil');
  await add('2026-11-03', -2100, 'Fuel & oil', { gst: 100 });            // counts $2,000 (GST comes back)
  await add('2026-11-04', -24000, 'Fertilizer');
  await add('2026-11-05', -380, 'Repairs & maintenance', { split: [50, 50] }); // half farm, half Jake's
  await add('2026-11-07', -95000, 'Machinery', { capex: true });            // an asset: shown, not budgeted
  await add('2026-11-08', -640, 'Groceries', { account: joint, segment: 'jake' });
  // Land rent paid against its bill: the bills system plans it, so it's not in the budget.
  const rent = await add('2026-11-01', -7000, 'Repairs & maintenance');
  await one(`INSERT INTO bills (name, ledger, amount, frequency, due_date, status, linked_transaction_id) VALUES ('Land rent', 'business', 7000, 'one_time', '2026-11-01', 'paid', $1) RETURNING id`, [rent.id]);
  await one(`INSERT INTO settings (key, value) VALUES ('household_budget_by_month', $1)`, [JSON.stringify({ '2026-11': 3000 })]);
});
after(async () => { await db?.close(); });

test('farm categories land on farm lines', () => {
  assert.equal(farmLineFor('Fuel & oil › Diesel — dyed'), 'farm_fuel');
  assert.equal(farmLineFor('Crop inputs › Fertilizer'), 'farm_inputs');
  assert.equal(farmLineFor('Vet & medicine'), 'farm_livestock');
  assert.equal(farmLineFor('Custom work'), 'farm_hired');
  assert.equal(farmLineFor('Repairs & maintenance'), 'farm_repairs');
  assert.equal(farmLineFor('Office supplies'), 'farm_other');
  assert.equal(whoseKey({ segment: 'grain' }), 'grain');
});

test('a farm budget: set, else the same month last year, else the average month', () => {
  const spent = new Map([['2025-11', new Map([['farm_fuel', 1800]])], ['2025-12', new Map([['farm_fuel', 600]])]]);
  const b = farmBudgets(['2026-11', '2026-01'], [{ key: 'farm_inputs', from_month: '2026-06', amount: 5000 }], spent, '2025-11', '2026-11');
  const nov = b.get('2026-11');
  assert.deepEqual(nov.find((l) => l.key === 'farm_fuel'), { key: 'farm_fuel', label: 'Fuel & oil', budget: 1800, set: false, basis: 'last_year' });
  assert.equal(nov.find((l) => l.key === 'farm_inputs').budget, 5000);
  // January 2026: no January 2025 on file, so the average of the full months on file (Nov 2025 to Oct 2026).
  assert.equal(b.get('2026-01').find((l) => l.key === 'farm_fuel').basis, 'average');
  // Before the ledger's first full month: nothing to go on.
  assert.deepEqual(farmBudgets(['2025-10'], [], spent, '2025-11', '2026-11').get('2025-10')[0].basis, 'none');
});

test('Everything: the farm and the household in one budget; capital out; bills out; the farm lines leave Cash Flow alone', async () => {
  const v = await budgetView({ month: '2026-11', today: TODAY });
  assert.equal(v.who, 'all');
  const line = (k) => v.lines.find((l) => l.key === k);
  assert.equal(line('farm_fuel').spent, 2000);
  assert.equal(line('farm_fuel').budget, 1800, 'last November');
  assert.equal(line('farm_inputs').spent, 24000);
  assert.equal(line('farm_repairs').spent, 190);
  assert.equal(line('groceries').spent, 640);
  assert.equal(line('fuel').spent, 0);
  assert.equal(line('other').spent, 0);
  assert.equal(v.lines.filter((l) => l.part === 'household').reduce((a, l) => a + l.spent, 0), 640 + 190);
  assert.deepEqual(v.farm, { budget: 1800, spent: 26190, capital: 95000 });
  assert.equal(v.household.budget, 3000);
  assert.deepEqual(v.total, { budget: 4800, spent: 27020 });
  const nov = v.months.find((m) => m.month === '2026-11');
  assert.deepEqual([nov.budget, nov.spent, nov.farm, nov.household], [4800, 27020, 26190, 830]);

  // The farm alone, the household alone.
  const farm = await budgetView({ month: '2026-11', who: 'farm', today: TODAY });
  assert.ok(farm.lines.every((l) => l.part === 'farm'));
  assert.equal(farm.total.spent, 26190);
  const home = await budgetView({ month: '2026-11', who: 'both', today: TODAY });
  assert.equal(home.farm, null);
  assert.equal(home.total.spent, 830);

  // The entries behind a farm line.
  const e = await lineEntries({ month: '2026-11', line: 'farm_inputs', today: TODAY });
  assert.deepEqual(e.map((x) => [x.amount, x.whose]), [[24000, 'grain']]);

  // A farm line set by Jake holds, and Cash Flow's household budget doesn't move.
  await setLine({ key: 'farm_inputs', amount: 25000, from_month: '2026-11' });
  const after = await budgetView({ month: '2026-11', today: TODAY });
  assert.equal(after.lines.find((l) => l.key === 'farm_inputs').budget, 25000);
  assert.equal(monthTotal(3000, [{ key: 'farm_inputs', from_month: '2026-11', amount: 25000 }], '2026-11'), 3000);
});
