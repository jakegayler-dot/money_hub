import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractParts, contractStatus, PAYMENT_DAYS } from '../lib/contracts.js';

const T = '2026-10-19';
const base = { total_value: 100000, received_amount: 0, quantity: 10000, expected_payment_date: '2027-01-31', status: 'open' };

test('status words from a source', () => {
  for (const w of ['filled', 'Completed', 'FULFILLED', 'closed', 'hauled', 'delivered']) assert.equal(contractStatus(w), 'delivered', w);
  for (const w of ['open', 'Active', 'partially_filled']) assert.equal(contractStatus(w), 'open', w);
  assert.equal(contractStatus('canceled'), 'cancelled');
  assert.equal(contractStatus('weird'), null);
});

test('open: all of it at the payment date', () => {
  assert.deepEqual(contractParts(base, T), [{ amount: 100000, date: '2027-01-31', part: 'open' }]);
});

test('delivered: owed two weeks after delivery', () => {
  const p = contractParts({ ...base, status: 'delivered', delivery_date: '2026-10-15' }, T);
  assert.deepEqual(p, [{ amount: 100000, date: '2026-10-29', part: 'hauled' }]);
  assert.equal(PAYMENT_DAYS, 14);
});

test('partly hauled: the hauled share now, the rest later; deposits come off the earliest', () => {
  const p = contractParts({ ...base, quantity_delivered: 4000, delivered_on: '2026-10-18', received_amount: 10000 }, T);
  assert.deepEqual(p, [{ amount: 30000, date: '2026-11-01', part: 'hauled' }, { amount: 60000, date: '2027-01-31', part: 'open' }]);
});

test('settlement tickets: their net replaces the contract value for the loads they cover', () => {
  const one = contractParts({ ...base, quantity_delivered: 4000, settlement_net: 39100, settlement_quantity: 4000, settlement_date: '2026-10-17' }, T);
  assert.deepEqual(one, [{ amount: 39100, date: '2026-10-20', part: 'ticketed' }, { amount: 60000, date: '2027-01-31', part: 'open' }]);
  const all = contractParts({ ...base, status: 'delivered', settlement_net: 98700, settlement_quantity: 10000, settlement_date: '2026-10-17' }, T);
  assert.deepEqual(all, [{ amount: 98700, date: '2026-10-20', part: 'ticketed' }]);
  const paid = contractParts({ ...base, status: 'delivered', settlement_net: 98700, settlement_quantity: 10000, settlement_date: '2026-10-17', received_amount: 98700 }, T);
  assert.deepEqual(paid, []);
});
