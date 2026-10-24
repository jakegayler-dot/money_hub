// Vendor credits with no cash (a canola contra), applying part of a credit
// on the invoice date, and auto-apply off per vendor. Real schema (PGlite).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { recordVendorCredit, applyVendorCredit, settleVendorAccount, removeVendorCredit } from '../lib/postings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, vendor, canola, fert;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  vendor = (await one(`INSERT INTO payees (name) VALUES ('Greenland') RETURNING id`)).id;
  canola = (await one(`SELECT id FROM expense_categories WHERE name = 'Canola sales'`)).id;
  fert = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Fertilizer x', 'variable_seasonal', 'business', 'expense') RETURNING id`)).id;
});
after(async () => { await db?.close(); });

const client = { query: (t, p) => q(t, p) };
const lines = async (txId) => (await db.query(
  `SELECT amount::float AS amount, category_id, is_transfer FROM transaction_lines WHERE transaction_id = $1 ORDER BY amount DESC`, [txId])).rows;

test('a credit with no cash: income in its category, held with the vendor, no account touched', async () => {
  const c = await recordVendorCredit(client, { payee_id: vendor, amount: 600, date: '2026-09-15', category_id: canola, owner: { segment: 'grain' }, note: 'canola contra' });
  const tx = await one('SELECT * FROM transactions WHERE id = $1', [c.transaction_id]);
  assert.equal(tx.account_id, null);
  assert.equal(Number(tx.amount), 0);
  assert.equal(tx.is_noncash, true);
  const l = await lines(tx.id);
  assert.deepEqual(l.map((x) => [x.amount, x.category_id, x.is_transfer]), [[600, canola, false], [-600, null, true]]);
});

test('part of a credit pays part of a bill, paid on the invoice date', async () => {
  const c = await one(`SELECT * FROM vendor_credits WHERE kind = 'credit'`);
  const bill = await one(`INSERT INTO bills (name, ledger, amount, frequency, received_date, due_date, status, payee_id, category_id, segment)
    VALUES ('Greenland inv 1', 'business', 500, 'one_time', '2026-09-20', '2026-10-20', 'unpaid', $1, $2, 'grain') RETURNING *`, [vendor, fert]);
  const r = await applyVendorCredit(client, c.id, bill.id, { on: '2026-09-20', amount: 400 });
  assert.equal(r.applied, 400);
  const b1 = await one('SELECT status, bill_owing(b, CURRENT_DATE)::float AS owing FROM bills b WHERE id = $1', [bill.id]);
  assert.deepEqual([b1.status, b1.owing], ['unpaid', 100]);
  const l = await lines(c.transaction_id);
  assert.deepEqual(l.map((x) => [x.amount, x.category_id, x.is_transfer]), [[600, canola, false], [-200, null, true], [-400, fert, false]]);
  // The rest pays it off: paid on the invoice date, not today; $100 of credit is left.
  const r2 = await applyVendorCredit(client, c.id, bill.id, { on: '2026-09-20' });
  assert.equal(r2.applied, 100);
  const b2 = await one('SELECT status, paid_date FROM bills WHERE id = $1', [bill.id]);
  assert.equal(b2.status, 'paid');
  assert.equal(String(b2.paid_date).slice(0, 10), '2026-09-20');
});

test('auto-apply off: a new credit waits instead of paying the oldest bill', async () => {
  await db.query('UPDATE payees SET auto_apply_credits = false WHERE id = $1', [vendor]);
  const bill = await one(`INSERT INTO bills (name, ledger, amount, frequency, received_date, due_date, status, payee_id, category_id, segment)
    VALUES ('Greenland inv 2', 'business', 300, 'one_time', '2026-09-25', '2026-10-25', 'unpaid', $1, $2, 'grain') RETURNING id`, [vendor, fert]);
  const c = await recordVendorCredit(client, { payee_id: vendor, amount: 300, date: '2026-09-26', category_id: canola });
  await settleVendorAccount(client, vendor, '2026-10-01');
  assert.equal((await one('SELECT status FROM bills WHERE id = $1', [bill.id])).status, 'unpaid');
  await db.query('UPDATE payees SET auto_apply_credits = true WHERE id = $1', [vendor]);
  await settleVendorAccount(client, vendor, '2026-10-01');
  assert.equal((await one('SELECT status FROM bills WHERE id = $1', [bill.id])).status, 'paid');
  // Removing the credit takes its entry off the books and reopens the bill.
  await removeVendorCredit(client, c.id);
  assert.equal((await one('SELECT status FROM bills WHERE id = $1', [bill.id])).status, 'unpaid');
  assert.equal((await db.query('SELECT 1 FROM transactions WHERE id = $1', [c.transaction_id])).rows.length, 0);
});
