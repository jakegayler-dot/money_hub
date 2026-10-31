// Heads-ups ahead of tax, GST and program dates (Jake, Oct 31).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headsUp, LEAD_DAYS } from '../lib/calendar.js';

const items = [
  { id: 'gst:2026-07-01', date: '2026-11-30', kind: 'gst', title: 'GST return — Q3 2026', notes: 'A refund — file to get it.' },
  { id: 'tax:file:2026', date: '2027-06-15', kind: 'tax', title: 'File the 2026 T1 return' },
  { id: 'deadline:agriinvest_deposit:2026-12-31', date: '2026-12-31', kind: 'program', title: 'AgriInvest: deposit by the date on your deposit notice' },
  { id: 'gst:2026-04-01', date: '2026-07-31', kind: 'gst', title: 'GST return — Q2 2026 (filed)', done: true },
  { id: 'bill:4:2026-11-05', date: '2026-11-05', kind: 'bill', title: 'Truck insurance', amount: -640 },
  { id: 'stmt-out:a1:2026-11-20', date: '2026-11-20', kind: 'statement', title: 'Statement out — Ops' },
];

test('a heads-up before each tax, GST and program date; none for bills, statements or what’s done', () => {
  const h = headsUp(items, '2026-10-31', '2027-12-31', '2026-10-31');
  const by = Object.fromEntries(h.map((x) => [x.id, x]));
  assert.equal(by['heads:gst:2026-07-01'].date, '2026-11-16');
  assert.equal(LEAD_DAYS.gst, 14);
  assert.equal(by['heads:tax:file:2026'].date, '2027-05-16');
  assert.equal(by['heads:deadline:agriinvest_deposit:2026-12-31'].date, '2026-12-17');
  assert.match(by['heads:gst:2026-07-01'].title, /^Coming up in 14 days: GST return/);
  assert.equal(h.length, 3);
});

test('a heads-up already past is left out', () => {
  const h = headsUp([{ id: 'gst:x', date: '2026-11-05', kind: 'gst', title: 'GST' }], '2026-10-01', '2026-12-31', '2026-10-31');
  assert.equal(h.length, 0);
});
