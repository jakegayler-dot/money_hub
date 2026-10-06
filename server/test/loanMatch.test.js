import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initials, namesLoan, reamortize, closeToScheduled } from '../lib/loanMatch.js';

test('a loan is named by its lender, the lender\'s initials, or a statement name — whole words only', () => {
  const loan = { name: 'Cattle loan', lender: 'Agriculture and Agri-Food Canada', statement_names: 'AGRI LOAN PAD' };
  assert.equal(initials(loan.lender), 'aafc');
  assert.ok(namesLoan(loan, 'PAD AAFC LOAN 00123'));
  assert.ok(namesLoan(loan, 'Pre-authorized AGRI LOAN PAD #44'));
  assert.ok(namesLoan(loan, 'payment to Agriculture and Agri-Food Canada'));
  assert.ok(!namesLoan(loan, 'AAFCX transfer'));
  assert.ok(!namesLoan(loan, 'FCC LOAN PAYMENT'));
});

test('re-pricing from the real balance: same payment dates, the lender\'s actual payment, cleared exactly', () => {
  const rows = reamortize({ balance: 10000, ratePct: 6, from: '2026-01-15', dates: ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15'], payment: 2600 });
  assert.deepEqual(rows.map((r) => r.due_date), ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15']);
  assert.equal(rows[0].interest_amount, Math.round(10000 * 0.06 * 31 / 365 * 100) / 100);
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.principal_amount, 0) - 10000) < 0.01);
  // A bigger payment clears it early: later dates drop off.
  assert.equal(reamortize({ balance: 10000, ratePct: 6, from: '2026-01-15', dates: ['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15'], payment: 5100 }).length, 2);
  // No payment given: level over the dates on file.
  const level = reamortize({ balance: 10000, ratePct: 6, from: '2026-01-15', dates: ['2026-02-15', '2026-03-15', '2026-04-15'] });
  assert.equal(level.length, 3);
  const totals = level.map((r) => r.principal_amount + r.interest_amount);
  assert.ok(Math.max(...totals) - Math.min(...totals) < 1);
});

test('within 35% of the schedule counts as the payment; a lump far off does not', () => {
  assert.ok(closeToScheduled(-1180, 1000));
  assert.ok(!closeToScheduled(-2000, 1000));
});
