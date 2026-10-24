// A card that isn't itemized (Oct 24): its payments stand in for the
// purchases, so they take the card's spending category instead of showing
// as uncategorized; an itemized card's payments are transfers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { linkCardPaymentToTransaction } from '../lib/postings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, ops, household;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const client = { query: (t, p) => q(t, p) };

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  ops = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('RBC Farm Business', 'business', 'operating', 0) RETURNING id`)).id;
  household = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Household card spending', 'variable_seasonal', 'personal', 'expense') RETURNING id`)).id;
});
after(async () => { await db?.close(); });

const payment = (amount, date = '2026-10-07') => one(
  `INSERT INTO transactions (account_id, ledger, date, amount, description, segment) VALUES ($1, 'business', $2, $3, 'Online Banking payment - 2677 CIBC MASTERCARD', 'ashley') RETURNING id`,
  [ops, date, amount]);

test('a payment on a card that is not itemized takes the card\'s spending category', async () => {
  const card = (await one(`INSERT INTO credit_cards (name, issuer, last4, apr_purchase, segment, payment_category_id)
    VALUES ('Ashley CIBC', 'CIBC', '2677', 20.99, 'ashley', $1) RETURNING id`, [household])).id;
  const { id } = await payment(-1731.94);
  await linkCardPaymentToTransaction(client, card, id);
  const t = await one('SELECT is_transfer, category_id FROM transactions WHERE id = $1', [id]);
  assert.equal(t.is_transfer, false);
  assert.equal(t.category_id, household);
});

test('a card with no spending category leaves its payments uncategorized; an itemized card\'s are transfers', async () => {
  const plain = (await one(`INSERT INTO credit_cards (name, issuer, last4, apr_purchase, segment) VALUES ('Other CIBC', 'CIBC', '5314', 20.99, 'ashley') RETURNING id`)).id;
  const a = await payment(-400, '2026-09-18');
  await linkCardPaymentToTransaction(client, plain, a.id);
  assert.equal((await one('SELECT category_id FROM transactions WHERE id = $1', [a.id])).category_id, null);

  const itemized = (await one(`INSERT INTO credit_cards (name, issuer, last4, apr_purchase, segment, payment_category_id, ledger_start_date, ledger_opening_balance)
    VALUES ('Itemized', 'CIBC', '9999', 20.99, 'ashley', $1, '2026-01-01', 0) RETURNING id`, [household])).id;
  const b = await payment(-250, '2026-09-20');
  await linkCardPaymentToTransaction(client, itemized, b.id);
  const t = await one('SELECT is_transfer, category_id FROM transactions WHERE id = $1', [b.id]);
  assert.equal(t.is_transfer, true);
  assert.equal(t.category_id, null);
});
