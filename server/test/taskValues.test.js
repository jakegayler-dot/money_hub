// What a task is worth (Jake, Oct 31).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueTasks } from '../lib/taskValues.js';
import { taskSnapshotItem } from '../lib/sentinelSnapshot.js';

const t = (o) => ({ task: true, ...o });

test('each task’s value and what it’s based on', () => {
  const items = valueTasks([
    t({ id: 'gst:2026-07-01', kind: 'gst', date: '2026-10-31', amount: -8000, title: 'GST return' }),
    t({ id: 'gst:2026-10-01', kind: 'gst', date: '2027-01-31', amount: 3200, title: 'GST return (refund)' }),
    t({ id: 'tax:inst:2026', kind: 'tax', date: '2026-12-31', amount: -12000, title: 'Instalment' }),
    t({ id: 'tax:bal:2026', kind: 'tax', date: '2027-04-30', amount: -24000, title: 'Balance' }),
    t({ id: 'tax:file:2026', kind: 'tax', date: '2027-06-15', amount: null, title: 'File T1' }),
    t({ id: 'deadline:agri_forms_final:2027-09-30', kind: 'program', date: '2027-09-30', title: 'AgriInvest forms' }),
    t({ id: 'rebate-claim:4', kind: 'program', date: '2026-11-15', title: 'Claim' }),
    t({ id: 'giftcard:2', kind: 'program', date: '2026-12-01', title: 'Gift card' }),
    t({ id: 'deadline:seeded_acreage:2027-06-25', kind: 'program', date: '2027-06-25', title: 'Seeded acreage' }),
  ], { rate: 7, matches: { 2026: { amount: 6420, ans: 642000 } }, rebates: new Map([[4, 2200]]), cards: new Map([[2, 64.5]]) });
  const v = Object.fromEntries(items.map((i) => [i.id, i.value ?? null]));
  assert.equal(v['gst:2026-07-01'], 100);              // 1.25% of 8,000
  assert.equal(v['gst:2026-10-01'], 3200);             // the refund
  assert.equal(v['tax:inst:2026'], 280);               // 12,000 × 7% × 4/12
  assert.equal(v['tax:bal:2026'], 140);                // 24,000 × 7% / 12
  assert.equal(v['tax:file:2026'], 1200);              // 5% of 24,000
  assert.equal(v['deadline:agri_forms_final:2027-09-30'], 6420);
  assert.equal(v['rebate-claim:4'], 2200);
  assert.equal(v['giftcard:2'], 64.5);
  assert.equal(v['deadline:seeded_acreage:2027-06-25'], null);
});

test('sent to Sentinel in the job and the notes', () => {
  const it = taskSnapshotItem({ id: 'rebate-claim:4', kind: 'program', title: 'Claim deadline — Nutrien', date: '2026-11-15', value: 2200, value_basis: 'the rebate, lost if it isn’t claimed' }, {});
  assert.deepEqual(it.job, { value_cents: 220000, value_basis: 'the rebate, lost if it isn’t claimed' });
  assert.match(it.notes, /^Worth about \$2,200\.00: the rebate/);
  assert.equal(taskSnapshotItem({ id: 'x', kind: 'program', title: 'X', date: '2026-11-15' }, {}).job, undefined);
});
