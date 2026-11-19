// Canada Child Benefit (Nov 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ccbYear, ccbFlows, benefitYearOf } from '../lib/ccb.js';

test('two under 6, July 2027, on $120,000 of 2026 family net income', () => {
  const r = ccbYear(2027, [2022, 2023], 120000);
  // 2 × 8,157 − 13.5% × (82,846 − 38,237) − 5.7% × (120,000 − 82,846)
  const want = 2 * 8157 - 0.135 * (82846 - 38237) - 0.057 * (120000 - 82846);
  assert.equal(r.annual, Math.round(want * 100) / 100);
  assert.equal(r.children, 2);
});

test('the under-6 rate ends the benefit year after the year a child turns 6; none at 18 or with high income', () => {
  assert.equal(ccbYear(2027, [2021], 0).annual, 6883, 'turns 6 in 2027');
  assert.equal(ccbYear(2026, [2021], 0).annual, 8157);
  assert.equal(ccbYear(2027, [2009], 0).annual, 0);
  assert.equal(ccbYear(2026, [2021, 2023], 500000).annual, 0);
});

test('flows: this benefit year at the actual, from July at the estimate from this year’s income', () => {
  assert.equal(benefitYearOf('2027-06'), 2026);
  assert.equal(benefitYearOf('2027-07'), 2027);
  const f = ccbFlows({ today: '2026-11-06', endStr: '2027-11-01', birthYears: [2021, 2023], actualMonthly: 900,
    incomeOf: (y) => (y === 2026 ? 120000 : 90000) });
  assert.equal(f[0].date, '2026-11-20');
  assert.equal(f.length, 12);
  assert.ok(f.filter((x) => x.date < '2027-07').every((x) => x.amount === 900 && x.basis === 'actual'));
  const july = f.find((x) => x.date === '2027-07-20');
  assert.equal(july.amount, ccbYear(2027, [2021, 2023], 120000).monthly);
  const none = ccbFlows({ today: '2026-11-21', endStr: '2027-01-01', birthYears: [2021], actualMonthly: null, incomeOf: (y) => (y === 2025 ? 60000 : 60000) });
  assert.equal(none[0].date, '2026-12-20', 'November’s is past');
  assert.equal(none[0].amount, ccbYear(2026, [2021], 60000).monthly, 'no actual: last year’s income');
});

test('no figure from Jake: this benefit year at what CRA paid, and no later year above it (Nov 19)', () => {
  // The formula on a low 2025 income said $1,359.50 a month; Ashley's deposits since July are $641.93.
  const f = ccbFlows({ today: '2026-11-19', endStr: '2027-09-01', birthYears: [2021, 2023], actualMonthly: null, paidMonthly: 641.93,
    incomeOf: () => 20000 });
  assert.ok(f.filter((x) => x.date < '2027-07').every((x) => x.amount === 641.93 && x.basis === 'paid'));
  const july = f.find((x) => x.date === '2027-07-20');
  assert.ok(ccbYear(2027, [2021, 2023], 20000).monthly > 641.93, 'the formula alone would be higher');
  assert.equal(july.amount, 641.93);
  assert.match(july.basis, /held to the \$641\.93 a month CRA pays now/);
  // Jake's own figure still wins over the deposits.
  assert.equal(ccbFlows({ today: '2026-11-19', endStr: '2027-01-01', birthYears: [2021, 2023], actualMonthly: 700, paidMonthly: 641.93, incomeOf: () => 20000 })[0].amount, 700);
});
