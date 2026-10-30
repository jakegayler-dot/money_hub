// Gift cards and rebates (Jake, Oct 29).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { cardBalances, useCard, giftCards, rebateExpected, receiveRebate, unreceiveRebate, rewardsSummary } from '../lib/rewards.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, acct, chem;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const client = { query: (t, p) => q(t, p) };

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  acct = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('Farm ops', 'business', 'operating', 1000) RETURNING id`)).id;
  chem = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Chemical', 'variable_seasonal', 'business', 'expense') RETURNING id`)).id;
});
after(async () => { await db?.close(); });

test('a gift card: uses come off the balance; used up, it is done; it can’t go below zero', async () => {
  const id = (await one(`INSERT INTO gift_cards (merchant, person, value, date) VALUES ('Co-op', 'Mom', 100, '2026-10-01') RETURNING id`)).id;
  await useCard(client, id, { date: '2026-10-05', amount: 40, description: 'groceries' });
  let [c] = await giftCards();
  assert.equal(c.balance, 60);
  await assert.rejects(() => useCard(client, id, { amount: 61 }), /Only 60.00 is left/);
  await useCard(client, id, { amount: 60 });
  [c] = await giftCards();
  assert.equal(c.balance, 0);
  assert.equal(c.status, 'used');
});

test('expiring and expired cards are flagged; a given card has no balance', () => {
  const rows = cardBalances([
    { id: 1, direction: 'received', status: 'active', value: 50, date: '2026-01-01', expires: '2026-11-15' },
    { id: 2, direction: 'received', status: 'active', value: 50, date: '2026-01-01', expires: '2026-10-01' },
    { id: 3, direction: 'given', status: 'active', value: 75, date: '2026-10-01' },
  ], [], '2026-10-29');
  assert.equal(rows[0].expiring, true);
  assert.equal(rows[1].expired, true);
  assert.equal(rows[2].balance, 0);
});

test('a rebate: spend × rate when no amount; received books the deposit under its category; undone, it goes', async () => {
  assert.equal(rebateExpected({ qualifying_spend: 85000, rate_pct: 4 }), 3400);
  assert.equal(rebateExpected({ amount: 1200, qualifying_spend: 85000, rate_pct: 4 }), 1200);
  const id = (await one(`INSERT INTO rebates (program, sponsor, qualifying_spend, rate_pct, status, expected_date, category_id) VALUES ('BASF 2026', 'BASF', 85000, 4, 'approved', '2027-02-15', $1) RETURNING id`, [chem])).id;
  const s0 = await rewardsSummary();
  assert.equal(s0.rebates.value, 3400);
  await receiveRebate(client, id, { account_id: acct, date: '2026-10-29' });
  const r = await one('SELECT * FROM rebates WHERE id = $1', [id]);
  assert.equal(r.status, 'received');
  const tx = await one('SELECT * FROM transactions WHERE id = $1', [r.transaction_id]);
  assert.equal(Number(tx.amount), 3400);
  assert.equal(tx.category_id, chem);
  await unreceiveRebate(client, id);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM transactions')).n, 0);
  assert.equal((await one('SELECT status FROM rebates WHERE id = $1', [id])).status, 'approved');
});
