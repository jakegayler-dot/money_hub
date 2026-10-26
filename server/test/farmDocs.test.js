// Invoices and receipts the farm writes (Jake, Oct 26).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { totalsOf, createDoc, markPaid, markUnpaid, writePdf } from '../lib/farmDocs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, acct, hay, rent;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const client = { query: (t, p) => q(t, p) };

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  acct = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('Farm ops', 'business', 'operating', 1000) RETURNING id`)).id;
  hay = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Hay sales', 'variable_seasonal', 'business', 'income') RETURNING id`)).id;
  rent = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Land rent', 'fixed', 'business', 'expense') RETURNING id`)).id;
});
after(async () => { await db?.close(); });

test('totals: quantity × price, 5% GST only on GST lines', () => {
  const t = totalsOf([{ description: 'Round bales', qty: 40, unit_price: 85, gst: true }, { description: 'Delivery', qty: 1, unit_price: 150 }]);
  assert.equal(t.subtotal, 3550);
  assert.equal(t.gst, 170);
  assert.equal(t.total, 3720);
  assert.throws(() => totalsOf([{ description: '', qty: 1, unit_price: 5 }]), /description/);
});

test('an invoice: open, then paid — the deposit is booked under its category with GST, it gets a receipt number; undone, the deposit goes', async () => {
  const inv = await createDoc(client, { kind: 'invoice', party_name: 'Neighbour Ranch', date: '2026-10-26', due_date: '2026-11-25', segment: 'livestock',
    lines: [{ description: 'Round bales', qty: 40, unit_price: 85, gst: true, category_id: hay }] });
  assert.equal(inv.number, 'INV-0001');
  assert.equal(inv.status, 'open');
  const paid = await markPaid(client, inv.id, { account_id: acct, date: '2026-11-20', paid_by: 'cheque 1043' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.receipt_number, 'RCT-0001');
  const tx = await one('SELECT * FROM transactions WHERE id = $1', [paid.transaction_id]);
  assert.equal(Number(tx.amount), 3570);
  assert.equal(Number(tx.gst_amount), 170);
  assert.equal(tx.category_id, hay);
  assert.equal(tx.segment, 'livestock');
  assert.equal(Number((await one('SELECT opening_balance FROM accounts WHERE id = $1', [acct])).opening_balance), 4570);
  await markUnpaid(client, inv.id);
  assert.equal((await one('SELECT COUNT(*)::int AS n FROM transactions')).n, 0);
  assert.equal(Number((await one('SELECT opening_balance FROM accounts WHERE id = $1', [acct])).opening_balance), 1000);
});

test('a payment receipt is booked as money out at once, split by category', async () => {
  const d = await createDoc(client, { kind: 'payment_receipt', party_name: 'Bob Landlord', date: '2026-10-26', account_id: acct, paid_by: 'cheque 412', segment: 'grain',
    lines: [{ description: '2026 cash rent', qty: 160, unit_price: 55, category_id: rent }, { description: 'Fence repair', qty: 1, unit_price: 200 }] });
  assert.equal(d.number, 'PMT-0001');
  assert.equal(d.status, 'paid');
  const tx = await one('SELECT * FROM transactions WHERE id = $1', [d.transaction_id]);
  assert.equal(Number(tx.amount), -9000);
  const pieces = (await db.query('SELECT amount::float AS a FROM transaction_splits WHERE transaction_id = $1 ORDER BY amount', [tx.id])).rows.map((r) => r.a);
  assert.deepEqual(pieces, [-8800, -200]);
  // And it prints.
  const chunks = [];
  const sink = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
  const done = new Promise((r) => sink.on('finish', r));
  await writePdf(d, sink);
  await done;
  const buf = Buffer.concat(chunks);
  assert.equal(buf.subarray(0, 4).toString(), '%PDF');
});
