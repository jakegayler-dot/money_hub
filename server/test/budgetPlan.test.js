// A budget that fits the forecast, and essentials that no longer lose a
// month's groceries to a yearly bill (Oct 24).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { maxMonthly, shareOut } from '../lib/budgetPlan.js';
import { essentialsModel, spendingMix } from '../lib/personal.js';
import { ownerSplits } from '../lib/forecast.js';

test('the most a month: the tightest month-end, spread over the months up to it', () => {
  // 3,000 above the floor after one month, 4,000 after two, 1,500 after three: 500 a month.
  const r = maxMonthly([3000, 4000, 1500, 9000]);
  assert.equal(r.max, 500);
  assert.equal(r.bindingIdx, 2);
  assert.equal(r.shortfall, null);
  const s = maxMonthly([2000, -700, 100]);
  assert.equal(s.max, 0);
  assert.deepEqual(s.shortfall, { idx: 1, amount: 700 });
});

test('shared out in $5s that add up exactly', () => {
  const out = shareOut([{ w: 300 }, { w: 120 }, { w: 80 }], 1000, (x) => x.w);
  assert.equal(out.reduce((a, v) => a + v, 0), 1000);
  assert.deepEqual(out, [600, 240, 160]);
  const odd = shareOut([{ w: 1 }, { w: 1 }, { w: 1 }], 100, (x) => x.w);
  assert.equal(odd.reduce((a, v) => a + v, 0), 100);
  assert.deepEqual(shareOut([], 100, () => 1), []);
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, acct, groc, dining, ins;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  acct = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('Joint', 'personal', 'operating', 0) RETURNING id`)).id;
  const cat = async (name) => (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ($1, 'variable_seasonal', 'personal', 'expense') RETURNING id`, [name])).id;
  groc = await cat('Groceries'); dining = await cat('Dining out'); ins = await cat('Home insurance');
  const tx = (date, amount, category, segment = 'jake') => one(
    `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, segment) VALUES ($1, 'personal', $2, $3, 'x', $4, $5) RETURNING id`,
    [acct, date, amount, category, segment]);
  // Six full months: 1,000 of groceries and 300 of dining out (two thirds Ashley's) each.
  await tx('2026-03-20', -10, groc); // first month on file: partial, skipped
  for (const m of ['04', '05', '06', '07', '08', '09']) {
    await tx(`2026-${m}-10`, -1000, groc);
    await tx(`2026-${m}-12`, -100, dining, 'jake');
    await tx(`2026-${m}-14`, -200, dining, 'ashley');
  }
  // A yearly bill paid in June: it's forecast as a bill, so the estimate leaves it out.
  const paid = await tx('2026-06-01', -2400, ins);
  await db.query(`INSERT INTO bills (name, amount, due_date, status, linked_transaction_id) VALUES ('Home insurance', 2400, '2026-06-01', 'paid', $1)`, [paid.id]);
});
after(async () => { await db?.close(); });

test('essentials without bill payments: a yearly bill no longer counts as everyday spending', async () => {
  const ess = await essentialsModel('2026-10-24');
  assert.equal(ess.unscheduled('2026-11'), 1000);
  assert.equal(ess.unscheduled('2027-06'), 1000); // not 3,400 where last June had the bill
});

test('the mix: what each discretionary category typically costs, and whose it is', async () => {
  const mix = await spendingMix('2026-10-24', 6);
  assert.equal(mix.months, 6);
  const d = mix.discretionary.find((c) => c.category === 'Dining out');
  assert.equal(d.monthly, 300);
  assert.equal(d.jake, 100);
  assert.equal(d.ashley, 200);
  assert.ok(!mix.essential.some((c) => c.category === 'Home insurance'));
});

test('owner splits work with itemized card purchases (the forecast crashed on them, mh79)', async () => {
  const card = (await one(`INSERT INTO credit_cards (name, apr_purchase, ledger_start_date, ledger_opening_balance) VALUES ('Visa', 20, '2026-01-01', 0) RETURNING id`)).id;
  await db.query(`INSERT INTO transactions (credit_card_id, ledger, date, amount, description, category_id, segment) VALUES ($1, 'personal', '2026-10-01', -80, 'Amazon', $2, 'ashley')`, [card, dining]);
  const s = await ownerSplits('2026-10-24');
  assert.ok(s.household.ashley > 0);
});
