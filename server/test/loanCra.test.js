// Tax owed to CRA under a payment arrangement (Oct 24): a loan for the
// forecast, but its interest is not deductible — booked to a personal
// category, never Interest › Loan interest — and the principal is a transfer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { linkLoanPaymentToTransaction, resplitLoanPayments, CRA_INTEREST_CATEGORY } from '../lib/postings.js';
import { processLine } from '../lib/statementIngest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, ops, loan, pay, tx;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const client = { query: (t, p) => q(t, p) };

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  ops = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('RBC Farm Business', 'business', 'operating', 0) RETURNING id`)).id;
  loan = (await one(`INSERT INTO loans (name, lender, purpose, principal, interest_rate_pct, term_months, start_date, segment, is_cra_tax)
    VALUES ('CRA Income Tax Owing', 'CRA', 'term', 20000, 9, 6, '2026-06-01', 'jake', true) RETURNING id`)).id;
  pay = (await one(`INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount) VALUES ($1, '2026-07-01', 4239, 150) RETURNING id`, [loan])).id;
  tx = (await one(`INSERT INTO transactions (account_id, ledger, date, amount, description) VALUES ($1, 'business', '2026-07-02', -4389, 'Online Banking payment - 2922 CRA-REV TX OWI') RETURNING id`, [ops])).id;
});
after(async () => { await db?.close(); });

const pieces = () => db.query(
  `SELECT s.amount, s.ledger, s.is_transfer, c.name AS cat, s.segment FROM transaction_splits s LEFT JOIN expense_categories c ON c.id = s.category_id
   WHERE s.transaction_id = $1 ORDER BY s.amount DESC`, [tx]).then((r) => r.rows);

test('a CRA payment-arrangement payment: interest is personal and not deductible, principal is a transfer', async () => {
  await linkLoanPaymentToTransaction(client, pay, tx);
  const p = await pieces();
  assert.equal(p.length, 2);
  const interest = p.find((x) => !x.is_transfer);
  assert.ok(Number(interest.amount) < -140 && Number(interest.amount) > -160); // interest to the day it was paid
  assert.equal(interest.cat, CRA_INTEREST_CATEGORY);
  assert.equal(interest.ledger, 'personal');
  assert.equal(interest.segment, 'jake');
  const principal = p.find((x) => x.is_transfer);
  assert.equal(Math.round((Number(principal.amount) + Number(interest.amount)) * 100) / 100, -4389);
});

test('turning the CRA setting off re-files recorded payments as ordinary loan interest', async () => {
  await db.query('UPDATE loans SET is_cra_tax = false WHERE id = $1', [loan]);
  assert.equal(await resplitLoanPayments(client, loan), 1);
  const interest = (await pieces()).find((x) => !x.is_transfer);
  assert.equal(interest.cat, 'Loan interest');
  assert.equal(interest.ledger, 'business');
  await db.query('UPDATE loans SET is_cra_tax = true WHERE id = $1', [loan]);
  await resplitLoanPayments(client, loan);
  assert.equal((await pieces()).find((x) => !x.is_transfer).cat, CRA_INTEREST_CATEGORY);
});

test('a CRA payment off a bank statement goes on the arrangement; an instalment stays income tax', async () => {
  const next = (await one(`INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount) VALUES ($1, '2026-08-01', 4250, 139) RETURNING id`, [loan])).id;
  const target = { type: 'account', row: await one('SELECT * FROM accounts WHERE id = $1', [ops]) };
  const r = await processLine(client, { target, source: 'test', external_id: 'cra-1',
    payload: { date: '2026-08-03', amount: -4389, description: 'Online Banking payment - 2922 CRA-REV TX OWI' } });
  assert.equal(r.status, 'posted', r.reason);
  const p = await one('SELECT paid, linked_transaction_id FROM loan_payments WHERE id = $1', [next]);
  assert.equal(p.paid, true);
  assert.equal(p.linked_transaction_id, r.transaction_id);
  const inst = await processLine(client, { target, source: 'test', external_id: 'cra-2',
    payload: { date: '2026-09-15', amount: -3000, description: 'CRA (REVENUE) - TAX INSTALMENT' } });
  assert.equal(inst.status, 'held');
});
