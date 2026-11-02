// The household budget by line (Nov 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINES, lineFor, lineBudgets, monthTotal, whoseKey } from '../lib/householdBudget.js';

test('the standard bracket adds to 100%', () => {
  assert.equal(LINES.reduce((a, l) => a + l.pct, 0), 100);
});

test('ledger categories land on their line', () => {
  const cases = { 'Food › Groceries': 'groceries', 'Food › Restaurants': 'dining', 'Dining out': 'dining', 'Regular Gas': 'vehicle', 'Auto insurance': 'vehicle',
    'Home › Phone & internet': 'home', 'Home › Utilities': 'home', 'Hotels/AirBnb': 'travel', Airfare: 'travel', Kids: 'kids', 'AI tools': 'subscriptions',
    Subscriptions: 'subscriptions', 'Clothing & shoes': 'shopping', Shopping: 'shopping', 'Personal care': 'health', Alcohol: 'dining',
    'Fun › Entertainment': 'fun', Gaming: 'fun', 'Attractions & activities': 'fun', 'Parking & transit': 'vehicle', Uncategorized: 'other' };
  for (const [name, key] of Object.entries(cases)) assert.equal(lineFor(name), key, name);
});

test('a set line holds from its month on; the rest follow Cash Flow', () => {
  const o = [{ key: 'groceries', from_month: '2026-11', amount: 1500 }];
  const oct = lineBudgets(5000, o, '2026-10'); const dec = lineBudgets(5000, o, '2026-12');
  assert.equal(oct.find((l) => l.key === 'groceries').budget, 1650);
  assert.equal(lineBudgets(50850, [], '2026-11').reduce((a, l) => a + l.budget, 0), 50850, 'whole dollars that add up');
  assert.equal(dec.find((l) => l.key === 'groceries').budget, 1500);
  assert.ok(dec.find((l) => l.key === 'groceries').set);
  assert.equal(dec.find((l) => l.key === 'dining').budget, 350);
  assert.equal(monthTotal(5000, [], '2026-12'), 5000, 'no lines set: Cash Flow’s figure');
  assert.equal(monthTotal(5000, o, '2026-12'), 5000 - 1650 + 1500);
  const back = [...o, { key: 'groceries', from_month: '2027-02', amount: null }];
  assert.equal(lineBudgets(5000, back, '2027-03').find((l) => l.key === 'groceries').budget, 1650, 'back to the bracket');
});

test('whose', () => {
  assert.equal(whoseKey({ segment: 'jake' }), 'jake');
  assert.equal(whoseKey({ is_segment_split: true, segment_jake_pct: 50, segment_ashley_pct: 50 }), 'both');
  assert.equal(whoseKey({ is_segment_split: true, segment_grain_pct: 70, segment_jake_pct: 30 }), 'mixed');
  assert.equal(whoseKey({ segment: null }), 'untagged');
});
