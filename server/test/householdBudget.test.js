// The household budget (Jake, Oct 24): a share of the room above the cash
// floor, the most a month that keeps every month-end above it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { householdBudget } from '../lib/forecast.js';

test('the tightest month by room ÷ months-to-it sets it; 90%, rounded down to $10', () => {
  // Month 3 has 9,000 of room but three months of spending to cover: 3,000 a month.
  const b = householdBudget([10000, 8000, 9000, 20000], 0.9);
  assert.equal(b.bindingIdx, 2);
  assert.equal(b.room, 3000);
  assert.equal(b.perMonth, 2700);
});

test('a budget of that size keeps every month-end above the floor, with the spare left', () => {
  const head = [4100, 6050, 5333, 12000, 7777];
  const { perMonth, room } = householdBudget(head, 0.9);
  head.forEach((h, i) => assert.ok(h - perMonth * (i + 1) >= 0));
  assert.ok(perMonth <= room * 0.9 && perMonth > room * 0.9 - 10);
});

test('no room: a month already below the floor means no budget', () => {
  const b = householdBudget([5000, -1200, 3000], 0.9);
  assert.equal(b.perMonth, 0);
  assert.ok(b.room < 0);
});

test('the share is applied as given', () => {
  assert.equal(householdBudget([12000], 1).perMonth, 12000);
  assert.equal(householdBudget([12000], 0.8).perMonth, 9600);
});
