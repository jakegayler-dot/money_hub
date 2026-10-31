// The household budget (Jake, Oct 30): "take my balance at end of August 2027 and divide it by the number of
// months till August. That's how much discretionary spending I have."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { householdBudget } from '../lib/forecast.js';

const months = (y, m, n) => Array.from({ length: n }, (_, i) => ({ year: y + Math.floor((m - 1 + i) / 12), month: ((m - 1 + i) % 12) + 1 }));

test('the balance at the end of next August ÷ the months to it, rounded down to $10', () => {
  // Oct 2026 → Aug 2027 is 11 months; a dip before it doesn't set it.
  const bal = [28000, 5000, 120000, 90000, 80000, 70000, 60000, 50000, 45000, 40000, 33000, 120000, 200000];
  const b = householdBudget(bal, 1, months(2026, 10, 13));
  assert.equal(b.bindingIdx, 10);
  assert.equal(b.room, 3000);
  assert.equal(b.perMonth, 3000);
});

test('in August it is next August, not this one', () => {
  const b = householdBudget(Array(14).fill(26000), 1, months(2026, 8, 14));
  assert.equal(b.bindingIdx, 12);
  assert.equal(b.perMonth, 2000);
});

test('below zero at the end of August means no budget; the share applies as given', () => {
  assert.equal(householdBudget([5000, -1200], 1, months(2027, 7, 2)).perMonth, 0);
  assert.equal(householdBudget([12000], 0.8, months(2027, 8, 1)).perMonth, 9600, 'no August after this month: the last month');
});

test('Oct 31 to Aug 30 is 9.95 months: the balance ÷ that (Jake, Oct 31)', () => {
  const meta = months(2026, 10, 13);
  const bal = Array(13).fill(0); bal[10] = 39800;
  const b = householdBudget(bal, 1, meta, '2026-10-31');
  assert.equal(b.until, '2027-08-30');
  assert.equal(Math.round(b.months * 100) / 100, 9.95);
  assert.equal(b.perMonth, 3990);
});
