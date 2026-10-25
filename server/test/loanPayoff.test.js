// Loans that end in a lump (Jake, Oct 24: the CRA arrangement — $4,389 a
// month, then the rest on Jan 1), single payments changed or dropped by
// hand, and a bill that pays a loan off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { applyPayoff, repriceOpen } from '../lib/loanMatch.js';
import { payBill, unpayLoanFromBill } from '../lib/postings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, ops;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const client = { query: (t, p) => q(t, p) };
const open = (loan) => db.query(
  `SELECT due_date::text AS d, principal_amount::float AS p, interest_amount::float AS i, is_payoff, is_manual FROM loan_payments
   WHERE loan_id = $1 AND NOT paid ORDER BY due_date`, [loan]).then((r) => r.rows);
const owed = async (loan) => Number((await one(
  `SELECT l.principal - COALESCE((SELECT SUM(principal_amount) FROM loan_payments WHERE loan_id = l.id AND paid), 0) AS v FROM loans l WHERE id = $1`, [loan])).v);

async function newLoan() {
  const loan = (await one(`INSERT INTO loans (name, lender, purpose, principal, interest_rate_pct, term_months, start_date, segment, payment_frequency)
    VALUES ('CRA Income Tax Owing', 'CRA', 'term', 20000, 9, 6, '2026-10-01', 'jake', 'monthly') RETURNING id`)).id;
  for (const d of ['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01']) {
    await db.query('INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount) VALUES ($1, $2, 4000, 100)', [loan, d]);
  }
  await repriceOpen(client, loan, { payment: 4389 });
  return loan;
}

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  ops = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('Chequing', 'personal', 'operating', 0) RETURNING id`)).id;
});
after(async () => { await db?.close(); });

test('a payoff date: regular payments before it, then everything left plus interest on it, nothing after', async () => {
  const loan = await newLoan();
  await db.query("UPDATE loans SET payoff_date = '2027-01-01' WHERE id = $1", [loan]);
  await applyPayoff(client, loan);
  const rows = await open(loan);
  assert.deepEqual(rows.map((r) => r.d), ['2026-11-01', '2026-12-01', '2027-01-01']);
  assert.ok(Math.abs(rows[0].p + rows[0].i - 4389) < 0.01 && Math.abs(rows[1].p + rows[1].i - 4389) < 0.01);
  const lump = rows[2];
  assert.equal(lump.is_payoff, true);
  assert.ok(Math.abs(rows.reduce((a, r) => a + r.p, 0) - 20000) < 0.01, 'the lump takes every dollar left');
  assert.ok(lump.i > 0 && lump.i < lump.p * 0.09 * (31 / 365) + 0.01, 'a month of interest on what is left');

  // Clearing it puts the balance back on regular payments.
  await db.query('UPDATE loans SET payoff_date = NULL WHERE id = $1', [loan]);
  await applyPayoff(client, loan);
  const back = await open(loan);
  assert.ok(back.every((r) => !r.is_payoff));
  assert.ok(back.slice(0, -1).every((r) => Math.abs(r.p + r.i - 4389) < 0.01));
  assert.ok(Math.abs(back.reduce((a, r) => a + r.p, 0) - 20000) < 0.01);
});

test('one payment changed by hand stays as entered; the rest re-price around it', async () => {
  const loan = await newLoan();
  const second = (await open(loan))[1];
  await db.query(`UPDATE loan_payments SET principal_amount = 9000 - interest_amount, is_manual = true WHERE loan_id = $1 AND due_date = $2`, [loan, second.d]);
  await repriceOpen(client, loan);
  const rows = await open(loan);
  assert.ok(Math.abs(rows[1].p + rows[1].i - 9000) < 0.01);
  assert.ok(Math.abs(rows[0].p + rows[0].i - 4389) < 0.01 && Math.abs(rows[2].p + rows[2].i - 4389) < 0.01);
  assert.ok(Math.abs(rows.reduce((a, r) => a + r.p, 0) - 20000) < 0.01);
});

test('a one-time bill that pays a loan: paying it records the payment and closes the loan; unpaying reopens it', async () => {
  const loan = await newLoan();
  await db.query("UPDATE loans SET payoff_date = '2027-01-01' WHERE id = $1", [loan]);
  await applyPayoff(client, loan);
  const bill = (await one(`INSERT INTO bills (name, ledger, amount, due_date, loan_id) VALUES ('CRA payoff', 'personal', 20200, '2026-11-01', $1) RETURNING id`, [loan])).id;
  const r = await payBill(client, bill, { account_id: ops, date: '2026-11-01' });
  assert.ok(r.transaction);
  assert.ok(await owed(loan) < 0.01, 'paid off');
  assert.equal((await open(loan)).length, 0, 'nothing left scheduled');
  const p = await one('SELECT * FROM loan_payments WHERE linked_transaction_id = $1', [r.transaction.id]);
  assert.ok(p && p.paid);

  await unpayLoanFromBill(client, r.transaction.id);
  assert.ok(Math.abs(await owed(loan) - 20000) < 0.01);
  assert.ok((await open(loan)).length >= 2);
});
