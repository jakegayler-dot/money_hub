// A card's balance when itemizing started is debt from before (Oct 24): paying it down
// is a transfer, not this year's uncategorized spending — unless the card says otherwise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { linkCardPaymentToTransaction, reclassifyCardPayments } from '../lib/postings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, ops, card, pay;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const client = { query: (t, p) => q(t, p) };

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  ops = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('RBC Personal', 'personal', 'operating', 0) RETURNING id`)).id;
  card = (await one(`INSERT INTO credit_cards (name, apr_purchase, segment, ledger_start_date, ledger_opening_balance)
    VALUES ('RBC Signature', 20.99, 'ashley', '2026-01-01', 3000) RETURNING id`)).id;
  pay = (await one(`INSERT INTO transactions (account_id, ledger, date, amount, description, segment) VALUES ($1, 'personal', '2026-02-10', -5000, 'Payment - RBC VISA', 'ashley') RETURNING id`, [ops])).id;
});
after(async () => { await db?.close(); });

const state = async () => ({
  tx: await one('SELECT is_transfer, is_split, category_id FROM transactions WHERE id = $1', [pay]),
  pieces: (await db.query('SELECT amount, is_transfer FROM transaction_splits WHERE transaction_id = $1 ORDER BY amount', [pay])).rows,
});

test('by default, paying off a carried starting balance is a transfer, not spending', async () => {
  await linkCardPaymentToTransaction(client, card, pay);
  const { tx, pieces } = await state();
  assert.equal(tx.is_transfer, true);
  assert.equal(tx.is_split, false);
  assert.equal(pieces.length, 0);
});

test('a card set to count it as spending splits the payment: the starting balance as spending, the rest a transfer', async () => {
  await db.query('UPDATE credit_cards SET opening_balance_is_debt = false WHERE id = $1', [card]);
  await reclassifyCardPayments(client, card);
  const { tx, pieces } = await state();
  assert.equal(tx.is_split, true);
  assert.deepEqual(pieces.map((p) => [Number(p.amount), p.is_transfer]), [[-3000, false], [-2000, true]]);
  await db.query('UPDATE credit_cards SET opening_balance_is_debt = true WHERE id = $1', [card]);
  await reclassifyCardPayments(client, card);
  assert.equal((await state()).tx.is_transfer, true);
  assert.equal((await state()).pieces.length, 0);
});
