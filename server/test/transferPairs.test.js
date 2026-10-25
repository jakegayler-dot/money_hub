// Pairing both sides of transfers between your own accounts (Oct 24).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { findPairs, pairTransfers } from '../lib/transferPairs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, farm, personal, ashley, groceries;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const client = { query: (t, p) => q(t, p) };
const t = (id, account_id, date, amount, description, extra = {}) => ({ id, account_id, date, amount, description, is_transfer: false, ...extra });

test('pairs opposite amounts on two accounts within 5 days when one reads like a transfer', () => {
  const p = findPairs([
    t(1, 1, '2026-10-01', -500, 'Transfer to RBC Personal - Jake'),
    t(2, 2, '2026-10-02', 500, 'Transfer from Farm'),
    t(3, 1, '2026-10-03', -80, 'CO-OP GAS BAR'),
    t(4, 2, '2026-10-03', 80, 'Refund'), // neither reads like a transfer
    t(5, 1, '2026-10-01', -700, 'Online transfer'),
    t(6, 2, '2026-10-12', 700, 'Deposit'), // 11 days apart
  ]);
  assert.deepEqual(p.map(([o, i]) => [o.id, i.id]), [[1, 2]]);
});

test('an ambiguous match is left alone; the nearest date wins when there is one', () => {
  assert.equal(findPairs([
    t(1, 1, '2026-10-05', -300, 'e-Transfer sent'),
    t(2, 2, '2026-10-04', 300, 'e-Transfer received'),
    t(3, 3, '2026-10-06', 300, 'e-Transfer received'),
  ]).length, 0);
  const p = findPairs([
    t(1, 1, '2026-10-05', -300, 'e-Transfer sent'),
    t(2, 2, '2026-10-05', 300, 'e-Transfer received'),
    t(3, 3, '2026-10-08', 300, 'e-Transfer received'),
  ]);
  assert.deepEqual(p.map(([o, i]) => [o.id, i.id]), [[1, 2]]);
});

test('same account never pairs with itself', () => {
  assert.equal(findPairs([t(1, 1, '2026-10-05', -300, 'Transfer'), t(2, 1, '2026-10-05', 300, 'Transfer')]).length, 0);
});

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  const acct = async (name) => (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ($1, 'business', 'operating', 0) RETURNING id`, [name])).id;
  farm = await acct('RBC Farm Business'); personal = await acct('RBC Personal - Jake'); ashley = await acct('Ashley RBC Personal');
  groceries = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Groceries', 'variable_seasonal', 'personal', 'expense') RETURNING id`)).id;
});
after(async () => { await db?.close(); });

const tx = async (account, date, amount, description, category = null, isTransfer = false) => (await one(
  `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, is_transfer) VALUES ($1, 'business', $2, $3, $4, $5, $6) RETURNING id`,
  [account, date, amount, description, category, isTransfer])).id;

test('in the books: both sides become transfers pointing at each other; a categorized entry is never touched', async () => {
  const out = await tx(farm, '2026-10-01', -5210, 'Transfer to RBC Personal - Jake - e-Transfer');
  const inn = await tx(personal, '2026-10-01', 5210, 'e-Transfer received');
  const spent = await tx(farm, '2026-10-02', -120, 'Transfer fee', groceries);
  const back = await tx(ashley, '2026-10-02', 120, 'e-Transfer received');
  const made = await pairTransfers(client);
  assert.equal(made.length, 1);
  const a = await one('SELECT is_transfer, transfer_peer_id FROM transactions WHERE id = $1', [out]);
  const b = await one('SELECT is_transfer, transfer_peer_id FROM transactions WHERE id = $1', [inn]);
  assert.deepEqual([a.is_transfer, a.transfer_peer_id, b.is_transfer, b.transfer_peer_id], [true, inn, true, out]);
  assert.equal((await one('SELECT transfer_peer_id FROM transactions WHERE id = $1', [spent])).transfer_peer_id, null);
  assert.equal((await one('SELECT transfer_peer_id FROM transactions WHERE id = $1', [back])).transfer_peer_id, null);
  assert.equal((await pairTransfers(client)).length, 0); // nothing twice
});
