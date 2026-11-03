// The household budget by line (Nov 1; Nov 3: fixed costs out, travel one small line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINES, lineFor, lineBudgets, monthTotal, whoseKey, isFixed } from '../lib/householdBudget.js';

test('the standard bracket adds to 100%, and travel is small', () => {
  assert.equal(LINES.reduce((a, l) => a + l.pct, 0), 100);
  assert.ok(LINES.find((l) => l.key === 'travel').pct <= 3);
  assert.ok(!LINES.some((l) => l.key === 'subscriptions'));
});

test('fixed costs are not in the budget (Nov 3)', () => {
  const none = { cats: new Set(), payees: new Set() };
  for (const c of ['Auto insurance', 'Home › Phone & internet', 'Home › Utilities', 'Electricity', 'Subscriptions', 'AI tools', 'Mortgage', 'Vehicle registration'])
    assert.ok(isFixed({ category: c }, none), c);
  for (const c of ['Food › Groceries', 'Regular Gas', 'Airfare', 'Hotels/AirBnb', 'Dining out', 'Kids'])
    assert.ok(!isFixed({ category: c }, none), c);
  assert.ok(isFixed({ category: 'Gym', category_id: 7 }, { cats: new Set([7]), payees: new Set() }), 'a category a recurring bill uses');
  assert.ok(isFixed({ category: 'Shopping', transaction_id: 3 }, { cats: new Set(), payees: new Set([9]) }, new Map([[3, 9]])), 'a recurring bill’s payee');
});

test('ledger categories land on their line; airfare and lodging are one travel line', () => {
  const cases = { 'Food › Groceries': 'groceries', 'Food › Restaurants': 'dining', 'Regular Gas': 'fuel', 'Hotels/AirBnb': 'travel', Airfare: 'travel',
    Kids: 'kids', 'Clothing & shoes': 'shopping', 'Personal care': 'health', Alcohol: 'dining', 'Fun › Entertainment': 'fun', 'Parking & transit': 'fuel', Uncategorized: 'other' };
  for (const [name, key] of Object.entries(cases)) assert.equal(lineFor(name), key, name);
});

test('a set line holds from its month on; the rest follow Cash Flow', () => {
  const o = [{ key: 'groceries', from_month: '2026-11', amount: 1500 }];
  assert.equal(lineBudgets(5000, o, '2026-10').find((l) => l.key === 'groceries').budget, 2000);
  const dec = lineBudgets(5000, o, '2026-12');
  assert.equal(dec.find((l) => l.key === 'groceries').budget, 1500);
  assert.equal(dec.find((l) => l.key === 'travel').budget, 100);
  assert.equal(lineBudgets(50850, [], '2026-11').reduce((a, l) => a + l.budget, 0), 50850, 'whole dollars that add up');
  assert.equal(monthTotal(5000, [], '2026-12'), 5000);
  assert.equal(monthTotal(5000, o, '2026-12'), 5000 - 2000 + 1500);
  assert.equal(lineBudgets(5000, [...o, { key: 'groceries', from_month: '2027-02', amount: null }], '2027-03').find((l) => l.key === 'groceries').budget, 2000);
});

test('whose', () => {
  assert.equal(whoseKey({ segment: 'jake' }), 'jake');
  assert.equal(whoseKey({ is_segment_split: true, segment_jake_pct: 50, segment_ashley_pct: 50 }), 'both');
  assert.equal(whoseKey({ is_segment_split: true, segment_grain_pct: 70, segment_jake_pct: 30 }), 'mixed');
});
