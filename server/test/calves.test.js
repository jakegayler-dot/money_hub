// Calves can be sold once 6 months old (Nov 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sellableFrom } from '../lib/inventoryForecast.js';

test('6 months after the earliest birth date', () => {
  assert.equal(sellableFrom('2026-04-10'), '2026-10-10');
  assert.equal(sellableFrom('2026-08-31'), '2027-02-28', 'month-end');
  assert.equal(sellableFrom(null), null);
});
