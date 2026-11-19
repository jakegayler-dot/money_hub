// Spending insights (Nov 19): what Claude returns is cleaned and tied to real purchases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFindings, prevMonth } from '../lib/spendingInsights.js';

test('the month just ended', () => {
  assert.equal(prevMonth('2026-11'), '2026-10');
  assert.equal(prevMonth('2027-01'), '2026-12');
  assert.equal(prevMonth('2026-11', 3), '2026-08');
});

test('findings: up to six, kinds kept to waste or saving, only purchases that exist', () => {
  const facts = { purchases: [{ id: 1, date: '2026-10-02', name: 'Tim Hortons', category: 'Coffee', amount: 4.5 }, { id: 2, date: '2026-10-09', name: 'Tim Hortons', category: 'Coffee', amount: 6 }] };
  const raw = [
    { kind: 'waste', title: 'Coffee runs', detail: '2 Tim Hortons stops', line: 'Dining out', save_per_month: 8.4, purchase_ids: [1, 2, 99, 2] },
    { kind: 'odd', title: 'x', detail: 'y', line: 'Nope', purchase_ids: [] },
    { kind: 'saving', title: '', detail: 'no title' },
    ...Array.from({ length: 8 }, (_, i) => ({ kind: 'saving', title: `t${i}`, detail: 'd' })),
  ];
  const f = cleanFindings(raw, facts);
  assert.equal(f.length, 5, 'six read, the one with no title dropped');
  assert.deepEqual(f[0].purchases.map((p) => p.id), [1, 2]);
  assert.equal(f[0].save_per_month, 8);
  assert.equal(f[1].kind, 'saving');
  assert.equal(f[1].line, null);
});
