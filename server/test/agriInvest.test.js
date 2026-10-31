import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agriInvestFlows } from '../lib/agriInvest.js';

// Oct 30: "Agriinvest is a program based on revenue, so moneyhub can work it out... it's simply a cash inflow."
const flows = [
  { kind: 'inventory', date: '2026-12-31', amount: 67583, farm: 1, ref: { commodity: 'steer calves' } },
  { kind: 'contract', date: '2026-11-20', amount: 120000, farm: 1, ref: { commodity: 'canola' } },
  { kind: 'estimate_in', date: '2027-10-15', amount: 300000, farm: 1, ref: { category: 'Grain sales', commodity: 'wheat' } },
  { kind: 'estimate_in', date: '2027-11-01', amount: 70000, farm: 1, ref: { category: 'Cattle forecast' } },
  { kind: 'estimate_out', date: '2027-04-01', amount: -9000, farm: 1, ref: { category: 'Cattle forecast' } },
  { kind: 'estimate_in', date: '2027-02-01', amount: 4000, farm: 0, ref: { category: 'Wages' } },
  { kind: 'bill', date: '2027-01-10', amount: -6000, farm: 1, ref: { category_id: 8 } },
  { kind: 'bill', date: '2027-01-10', amount: -50000, farm: 1, ref: { category_id: 88 } },
];
const actual = { 2025: { sales: 400000, purchases: 20000 }, 2026: { sales: 250000, purchases: 10000 } };

test('each program year: 1% of sales less commodity purchases (ledger so far + forecast), paid the next June', () => {
  const out = agriInvestFlows({ flows, actual, purchaseIds: new Set([8]), today: '2026-05-30', endStr: '2028-12-01' });
  const by = Object.fromEntries(out.map((f) => [f.ref.program_year, f]));
  assert.equal(by[2025].date, '2026-06-15');
  assert.equal(by[2025].amount, 3800); // (400,000 − 20,000) × 1%
  assert.equal(by[2026].amount, 4275.83); // 250,000 + 67,583 + 120,000 − 10,000
  assert.equal(by[2027].amount, 3550); // 300,000 + 70,000 − 9,000 bulls − 6,000 livestock bill; wages and fertilizer don't count
  assert.equal(by[2027].date, '2028-06-15');
  assert.ok(out.every((f) => f.kind === 'estimate_in' && f.amount > 0));
});

test('capped at $10,000; nothing under $25,000 of sales; skipped once it has come in', () => {
  const big = agriInvestFlows({ flows: [], actual: { 2025: { sales: 3e6, purchases: 0 } }, today: '2026-05-30', endStr: '2027-01-01' });
  assert.equal(big[0].amount, 10000);
  assert.equal(agriInvestFlows({ flows: [], actual: { 2025: { sales: 20000, purchases: 0 } }, today: '2026-10-30', endStr: '2027-01-01' }).length, 0);
  assert.equal(agriInvestFlows({ flows: [], actual: { 2025: { sales: 3e5 }, 2026: { agriinvest_in: 2900 } }, today: '2026-10-30', endStr: '2027-01-01' }).length, 0);
});

test('June (Oct 31: "it arrives in June most years"): a late match counts from today for two months, then not', () => {
  const a = { 2025: { sales: 400000, purchases: 0 } };
  const late = agriInvestFlows({ flows: [], actual: a, today: '2026-07-20', endStr: '2027-01-01' });
  assert.equal(late[0].date, '2026-07-20');
  const skipped = [];
  assert.equal(agriInvestFlows({ flows: [], actual: a, today: '2026-10-31', endStr: '2027-01-01', skipped }).length, 0);
  assert.match(skipped[0].reason, /due in June 2026/);
  const next = agriInvestFlows({ flows: [], actual: { ...a, 2026: { sales: 300000, purchases: 0 } }, today: '2026-10-31', endStr: '2027-11-01' });
  assert.equal(next.find((f) => f.ref.program_year === 2026).date, '2027-06-15', 'inside a 12-month view');
});
