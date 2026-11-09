// The household budget by line (Nov 1; Nov 9: everything the bills system doesn't cover).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINES, lineFor, lineBudgets, monthTotal, whoseKey, coveredByBills, billKey } from '../lib/householdBudget.js';

test('the standard bracket adds to 100%, and travel is small', () => {
  assert.equal(LINES.reduce((a, l) => a + l.pct, 0), 100);
  assert.ok(LINES.find((l) => l.key === 'travel').pct <= 3);
});

test('only what the bills system covers is left out (Nov 9) — never a guess from the category name', () => {
  const bills = { payees: new Set([9]), keys: [billKey('SaskPower - house'), billKey('Netflix'), billKey('Rogers (cell)')] };
  assert.deepEqual(bills.keys, ['saskpower', 'netflix', 'rogers']);
  const tx = new Map([
    [1, { payee_id: null, text: 'saskpowerpreauthorizeddebit' }], [2, { payee_id: 9, text: 'whatever' }],
    [3, { payee_id: null, text: 'saskenergy' }], [4, { payee_id: null, text: 'costcowholesale' }],
  ]);
  assert.ok(coveredByBills({ transaction_id: 1, category: 'Home › Utilities' }, bills, tx), 'a recurring bill’s name');
  assert.ok(coveredByBills({ transaction_id: 2 }, bills, tx), 'a recurring bill’s payee');
  assert.ok(coveredByBills({ transaction_id: 5, scheduled: true }, bills, tx), 'linked to a bill or loan payment');
  assert.ok(!coveredByBills({ transaction_id: 3, category: 'Home › Utilities' }, bills, tx), 'no bill for it: discretionary, whatever its category');
  assert.ok(!coveredByBills({ transaction_id: 4, category: 'Auto insurance' }, bills, tx));
});

test('ledger categories land on their line; airfare and lodging are one travel line', () => {
  const cases = { 'Food › Groceries': 'groceries', 'Food › Restaurants': 'dining', 'Regular Gas': 'fuel', 'Auto insurance': 'fuel', 'Home › Utilities': 'home', 'AI tools': 'subscriptions', 'Hotels/AirBnb': 'travel', Airfare: 'travel',
    Kids: 'kids', 'Clothing & shoes': 'shopping', 'Personal care': 'health', Alcohol: 'dining', 'Fun › Entertainment': 'fun', 'Parking & transit': 'fuel', Uncategorized: 'other' };
  for (const [name, key] of Object.entries(cases)) assert.equal(lineFor(name), key, name);
});

test('a set line holds from its month on; the rest follow Cash Flow', () => {
  const o = [{ key: 'groceries', from_month: '2026-11', amount: 1500 }];
  assert.equal(lineBudgets(5000, o, '2026-10').find((l) => l.key === 'groceries').budget, 1900);
  const dec = lineBudgets(5000, o, '2026-12');
  assert.equal(dec.find((l) => l.key === 'groceries').budget, 1500);
  assert.equal(dec.find((l) => l.key === 'travel').budget, 100);
  assert.equal(lineBudgets(50850, [], '2026-11').reduce((a, l) => a + l.budget, 0), 50850, 'whole dollars that add up');
  assert.equal(monthTotal(5000, [], '2026-12'), 5000);
  assert.equal(monthTotal(5000, o, '2026-12'), 5000 - 1900 + 1500);
  assert.equal(lineBudgets(5000, [...o, { key: 'groceries', from_month: '2027-02', amount: null }], '2027-03').find((l) => l.key === 'groceries').budget, 1900);
});

test('whose', () => {
  assert.equal(whoseKey({ segment: 'jake' }), 'jake');
  assert.equal(whoseKey({ is_segment_split: true, segment_jake_pct: 50, segment_ashley_pct: 50 }), 'both');
  assert.equal(whoseKey({ is_segment_split: true, segment_grain_pct: 70, segment_jake_pct: 30 }), 'mixed');
});
