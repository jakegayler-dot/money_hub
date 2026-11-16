// The GST return counts a vendor's invoices, not the payments on the account (Jake, Nov 15: Melfort Pipeline "send
// invoices that update our account balance, then i pay the account in lump sums. So it isnt right to have the transaction
// show up").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { gstReturn, claimOf } from '../lib/gstReturn.js';
import { settleVendorAccount } from '../lib/postings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const Y = new Date().getFullYear() - 1;
const Q3 = `${Y}-07-01`;
const Q4 = `${Y}-10-01`;
const id = {};

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  const ops = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Ops', 'business', 'operating', 0, 'grain') RETURNING id`)).id;
  const repairs = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Repairs & maintenance', 'variable_seasonal', 'business', 'expense') RETURNING id`)).id;
  const power = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Utilities', 'variable_seasonal', 'business', 'expense') RETURNING id`)).id;
  id.mp = (await one(`INSERT INTO payees (name) VALUES ('Melfort Pipeline') RETURNING id`)).id;
  id.sp = (await one(`INSERT INTO payees (name) VALUES ('SaskPower') RETURNING id`)).id;
  const bill = (name, payee, date, amount, gst, category, extra = {}) => one(
    `INSERT INTO bills (name, ledger, amount, frequency, received_date, due_date, status, payee_id, has_gst, gst_amount, subtotal_amount, category_id, segment)
     VALUES ($1, 'business', $2, $3, $4, $5::date + 30, 'unpaid', $6, $7, $8, $9, $10, 'grain') RETURNING id`,
    [name, amount, extra.frequency || 'one_time', date, date, payee, gst != null, gst ?? 0, amount - (gst ?? 0), category]);
  // Two Melfort Pipeline invoices in Q3: one with its GST and its paper, one with neither.
  id.a = (await bill('Melfort Pipeline #881', id.mp, `${Y}-08-05`, 1050, 50, repairs)).id;
  await one(`INSERT INTO receipts (mime, bytes, image, status, bill_id, extracted) VALUES ('image/jpeg', 1, '\\x00', 'billed', $1, '{}') RETURNING id`, [id.a]);
  id.b = (await bill('Melfort Pipeline #904', id.mp, `${Y}-09-10`, 296, null, repairs)).id;
  // One lump sum in Q4, paid on account: it pays both.
  id.pay = (await one(
    `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, segment, payee_id)
     VALUES ($1, 'business', $2, -1346, 'Melfort Pipeline', $3, 'grain', $4) RETURNING id`, [ops, `${Y}-10-20`, repairs, id.mp])).id;
  await one('INSERT INTO vendor_on_account (transaction_id) VALUES ($1) RETURNING transaction_id', [id.pay]);
  await settleVendorAccount({ query: q }, id.mp, `${Y}-12-31`);
  // A SaskPower bill invoiced in late September, paid in October with its own payment.
  id.sask = (await bill('SaskPower', id.sp, `${Y}-09-28`, 210, 10, power)).id;
  id.saskPay = (await one(
    `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, segment, payee_id)
     VALUES ($1, 'business', $2, -210, 'SaskPower', $3, 'grain', $4) RETURNING id`, [ops, `${Y}-10-05`, power, id.sp])).id;
  await one(`UPDATE bills SET status = 'paid', paid_date = $2, linked_transaction_id = $3 WHERE id = $1 RETURNING id`, [id.sask, `${Y}-10-05`, id.saskPay]);
  // Fuel bought at the pump in Q4: no invoice, counted on its entry.
  id.fuel = (await one(
    `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, segment, gst_amount)
     VALUES ($1, 'business', $2, -105, 'Fuel', $3, 'grain', 5) RETURNING id`, [ops, `${Y}-11-02`, repairs])).id;
});
after(async () => { await db?.close(); });

test('the invoices are the purchases, in the quarter of their dates; the lump sum is not', async () => {
  const paid = await one('SELECT status FROM bills WHERE id = $1', [id.a]);
  assert.equal(paid.status, 'paid', 'the lump sum paid the invoices');

  const q3 = await gstReturn(Q3);
  const keys = q3.expenses.map((e) => e.key).sort();
  assert.deepEqual(keys, [`b${id.a}`, `b${id.b}`, `b${id.sask}`].sort());
  const a = q3.expenses.find((e) => e.bill_id === id.a);
  assert.equal(a.itc, 50);
  assert.deepEqual(a.flags, [], 'its invoice is on the bill');
  assert.equal(a.invoice.status, 'paid');
  const b = q3.expenses.find((e) => e.bill_id === id.b);
  assert.deepEqual(b.flags, ['no_receipt_gst_unknown']);
  assert.equal(q3.expenses.find((e) => e.bill_id === id.sask).itc, 10);
  assert.equal(q3.lines[106], 60);
  assert.deepEqual(claimOf(q3), { [`b${id.a}`]: 50, [`b${id.sask}`]: 10 });

  const q4 = await gstReturn(Q4);
  assert.deepEqual(q4.expenses.map((e) => e.key), [String(id.fuel)], 'payments on the account and the bill payment are not purchases');
  assert.equal(q4.lines[106], 5);
});

test('an unpaid invoice counts in its own quarter', async () => {
  const late = (await one(
    `INSERT INTO bills (name, ledger, amount, frequency, received_date, due_date, status, payee_id, has_gst, gst_amount, subtotal_amount, segment)
     VALUES ('Melfort Pipeline #950', 'business', 525, 'one_time', $1, $1::date + 30, 'unpaid', $2, true, 25, 500, 'grain') RETURNING id`, [`${Y}-11-20`, id.mp])).id;
  const q4 = await gstReturn(Q4);
  const e = q4.expenses.find((x) => x.bill_id === late);
  assert.equal(e.itc, 25);
  assert.equal(e.invoice.status, 'unpaid');
});

test('a quarter filed when the payment was claimed: its claim moves to the invoices, nothing counted twice', async () => {
  // Q3 filed with nothing from these, Q4 filed claiming the SaskPower payment itself (the old way).
  await one(`INSERT INTO gst_returns (period_start, period_end, filed_on, net_amount, claimed) VALUES ($1, $2, $3, 0, '{}') RETURNING period_start`,
    [Q3, `${Y}-09-30`, `${Y}-10-15`]);
  await one(`INSERT INTO gst_returns (period_start, period_end, filed_on, net_amount, claimed) VALUES ($1, $2, $3, 0, $4) RETURNING period_start`,
    [Q4, `${Y}-12-31`, `${Y + 1}-01-15`, JSON.stringify({ [id.saskPay]: 10, [id.fuel]: 5 })]);
  const next = await gstReturn(`${Y + 1}-01-01`);
  const c = Object.fromEntries(next.carried.map((x) => [x.key, x.itc]));
  // Melfort's #881 was never claimed: it carries. SaskPower's was claimed on its payment: it doesn't.
  assert.equal(c[`b${id.a}`], 50);
  assert.equal(c[`b${id.sask}`], undefined);
  assert.equal(c[String(id.saskPay)], undefined);
  assert.equal(c[String(id.fuel)], undefined);
});
