// Deleting a duplicate account (Oct 31): its entries are matched to their copies in the real account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairTwins } from '../lib/accountDelete.js';

test('copies pair with the nearest same-amount entry within three days, each twin used once', () => {
  const copies = [{ id: 1, date: '2026-10-02', amount: -100 }, { id: 2, date: '2026-10-02', amount: -100 }, { id: 3, date: '2026-10-20', amount: -40 }, { id: 4, date: '2026-10-10', amount: -75 }];
  const reals = [{ id: 10, date: '2026-10-01', amount: -100 }, { id: 11, date: '2026-10-02', amount: -100 }, { id: 12, date: '2026-10-15', amount: -75 }];
  const { pairs, unmatched } = pairTwins(copies, reals);
  assert.deepEqual(pairs.map((p) => [p.copy.id, p.twin.id]), [[1, 11], [2, 10]]);
  assert.deepEqual(unmatched.map((x) => x.id).sort(), [3, 4], 'five days apart is not a copy');
});
