// One budget for the sole proprietorship (Jake, Nov 15: "i just want all expenses included in the budget, anything farm
// related goes in other").
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
  await add('2026-11-03', -2100, 'Fuel & oil', { gst: 100 });                 // farm: $2,000 on Other (GST comes back)
  await add('2026-11-04', -24000, 'Fertilizer');                              // farm: Other
  await add('2026-11-05', -380, 'Repairs & maintenance', { split: [50, 50] }); // $190 farm on Other, $190 Jake's on Household & home
  await add('2026-11-07', -95000, 'Machinery', { capex: true });              // an asset: not spending
  await add('2026-11-08', -640, 'Groceries', { account: joint, segment: 'jake' });
  // Land rent paid against its bill: the bills system plans it, so it's not in the budget.
  const rent = await add('2026-11-01', -7000, 'Fertilizer');
  await one(`INSERT INTO bills (name, ledger, amount, frequency, due_date, status, linked_transaction_id) VALUES ('Land rent', 'business', 7000, 'one_time', '2026-11-01', 'paid', $1) RETURNING id`, [rent.id]);
  await one(`INSERT INTO settings (key, value) VALUES ('household_budget_by_month', $1)`, [JSON.stringify({ '2026-11': 3000 })]);
});
after(async () => { await db?.close(); });

test('farm spending is on Other; the lines and the budget are the same as ever', async () => {
  const v = await budgetView({ month: '2026-11', today: TODAY });
  assert.deepEqual(v.lines.map((l) => l.key), LINE_KEYS, 'no new lines');
  const line = (k) => v.lines.find((l) => l.key === k);
  assert.equal(line('other').spent, 2000 + 24000 + 190);
  assert.equal(line('groceries').spent, 640);
  assert.equal(line('home').spent, 190);
  assert.equal(line('fuel').spent, 0, 'farm fuel is Other, not Fuel & vehicle');
  assert.equal(v.total.budget, 3000);
  assert.equal(v.total.spent, 26190 + 830);
  assert.equal(v.months.find((m) => m.month === '2026-11').spent, 27020);

  // Jake's view leaves the farm out.
  const jake = await budgetView({ month: '2026-11', who: 'jake', today: TODAY });
  assert.equal(jake.lines.find((l) => l.key === 'other').spent, 0);

  // The entries behind Other, farm ones tagged grain.
  const e = await lineEntries({ month: '2026-11', line: 'other', today: TODAY });
  assert.deepEqual(e.map((x) => [x.amount, x.whose]).sort((a, b) => b[0] - a[0]), [[24000, 'grain'], [2000, 'grain'], [190, 'mixed']]);
  assert.equal(whoseKey({ segment: 'livestock' }), 'livestock');
});
