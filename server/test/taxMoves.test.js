// Money with CRA (Oct 24): a GST refund booked as a program payment, an
// income tax refund with refund interest, instalments — marked, they're
// transfers and out of farm income; refund interest stays taxable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { markTaxMove, unmarkTaxMove, guessTaxKind, looksLikeCraIncomeTax } from '../lib/taxMoves.js';
import { farmIncomeTax } from '../lib/tax.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, ops, personal, program;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const client = { query: (t, p) => q(t, p) };
const year = new Date().getFullYear();
const jan = `${year}-01-15`;

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  ops = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Ops', 'business', 'operating', 0, 'grain') RETURNING id`)).id;
  personal = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Joint', 'personal', 'personal', 0, 'jake') RETURNING id`)).id;
  program = (await one(`SELECT id FROM expense_categories WHERE name = 'Program payments'`)).id;
});
after(async () => { await db?.close(); });

const tx = (account, amount, description, extra = {}) => one(
  `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, segment)
   VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
  [account, account === ops ? 'business' : 'personal', extra.date || jan, amount, description, extra.category_id ?? null, account === ops ? 'grain' : 'jake']);
const counted = async (id) => (await db.query('SELECT amount, category_id FROM transaction_lines WHERE transaction_id = $1 AND NOT is_transfer', [id])).rows;

test('bank wording: what looks like CRA, and what it is', () => {
  assert.equal(guessTaxKind('CANADA RIT', 812.4), 'income_tax_refund');
  assert.equal(guessTaxKind('CRA (REVENUE) - TAX INSTALMENT', -3000), 'income_tax_payment');
  assert.equal(guessTaxKind('GST/HST REFUND CANADA', 35000), 'gst_refund');
  assert.equal(guessTaxKind('RECEIVER GENERAL', -900), 'gst_payment'); // the existing GST rule: remittances go to the Receiver General
  assert.equal(guessTaxKind('CRA PAYMENT', -900), 'income_tax_payment');
  assert.equal(guessTaxKind('CANADA GST CREDIT', 120), null);
  assert.equal(guessTaxKind('CANADA CCB', 600), null);
  assert.equal(guessTaxKind('FARM CREDIT CANADA', -2000), null);
  assert.ok(looksLikeCraIncomeTax('INCOME TAX REFUND'));
  assert.ok(!looksLikeCraIncomeTax('GST/HST REFUND'));
});

test('a GST refund booked as a program payment: marked, it leaves farm income', async () => {
  const before = await farmIncomeTax(year);
  const { id } = await tx(ops, 35000, 'GOVT CANADA', { category_id: program });
  const withIt = await farmIncomeTax(year);
  assert.ok(withIt.actual.revenue - before.actual.revenue > 34999, 'counted as farm revenue until marked');
  const up = await markTaxMove(client, id, { kind: 'gst_refund' });
  assert.equal(up.tax_kind, 'gst_refund');
  assert.equal(up.is_transfer, true);
  assert.equal(up.category_id, null);
  assert.deepEqual(await counted(id), []);
  const after = await farmIncomeTax(year);
  assert.ok(Math.abs(after.actual.revenue - before.actual.revenue) < 0.01);
  // Undo: ordinary money in again, flagged for a category.
  const un = await unmarkTaxMove(client, id);
  assert.equal(un.tax_kind, null);
  assert.equal(un.is_transfer, false);
  assert.equal(un.needs_review, true);
  await markTaxMove(client, id, { kind: 'gst_refund' });
});

test('an income tax refund with refund interest: the interest stays taxable income', async () => {
  const { id } = await tx(personal, 1240.5, 'CANADA RIT');
  await markTaxMove(client, id, { kind: 'income_tax_refund', interest: 40.5 });
  const lines = await counted(id);
  assert.equal(lines.length, 1);
  assert.equal(Number(lines[0].amount), 40.5);
  const cat = await one('SELECT name, kind FROM expense_categories WHERE id = $1', [lines[0].category_id]);
  assert.deepEqual(cat, { name: 'Interest income', kind: 'income' });
  const pieces = (await db.query('SELECT amount, is_transfer, segment::text AS segment FROM transaction_splits WHERE transaction_id = $1 ORDER BY id', [id])).rows;
  assert.deepEqual(pieces.map((p) => [Number(p.amount), p.is_transfer, p.segment]), [[1200, true, 'jake'], [40.5, false, 'jake']]);
});

test('direction and interest are checked', async () => {
  const { id } = await tx(ops, -4200, 'CRA TAX INSTALMENT');
  await assert.rejects(markTaxMove(client, id, { kind: 'income_tax_refund' }), (e) => e.status === 400 && /money in/.test(e.message));
  await assert.rejects(markTaxMove(client, id, { kind: 'income_tax_payment', interest: 10 }), (e) => e.status === 400);
  await assert.rejects(markTaxMove(client, id, { kind: 'nope' }), (e) => e.status === 400);
  const before = await farmIncomeTax(year);
  await markTaxMove(client, id, { kind: 'income_tax_payment' });
  const after = await farmIncomeTax(year);
  assert.ok(before.actual.expenses - after.actual.expenses > 4199, 'an instalment is not a farm expense');
});
