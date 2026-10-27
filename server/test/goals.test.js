// Long-term goals (Jake, Oct 26): when each can be bought with the cash
// floor, the reserve, debt coverage and the down payment all met.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGoals, goalPurchase, explain } from '../lib/goals.js';

const H = 120;
const meta = Array.from({ length: H }, (_, i) => ({ year: 2026 + Math.floor((9 + i) / 12), month: ((9 + i) % 12) + 1 }));
// $20,000 a month free cash, a $50,000 floor, $100,000 to start, a $30,000 reserve; coverage room for $120k a year of payments at 1.25×.
const base = (over = {}) => ({
  meta, opening: 100000, net: new Array(H).fill(20000), floor: new Array(H).fill(50000), floorDays: 60, reserve: 30000,
  dscr: { capacity: 200000, threshold: 1.25, service: new Array(H).fill(40000), now: 5 }, ...over,
});

test('a cash purchase waits until the money is there with the reserve kept', () => {
  const [r] = planGoals(base(), [{ id: 1, name: 'Truck', kind: 'truck', price: 100000, funding: 'cash', owner: 'farm' }]);
  // $111,000 up front (GST and PST paid in cash): needs balance − floor − cost ≥ reserve the month bought.
  const up = 100000 * 1.11;
  const need = Math.ceil((50000 + 30000 + up - 100000) / 20000) - 1; // month index where 100000 + 20000(t+1) − up − 50000 ≥ 30000
  assert.equal(r.month_index, need);
  assert.ok(r.tests.every((x) => x.ok));
  const e = explain(base(), r);
  assert.match(e.headline, /Can be bought in/);
  assert.ok(e.conditions.find((c) => c.id === 'reserve').ok);
});

test('financed: thin money down is never a go; 25% down is', () => {
  const g = { id: 2, name: 'Tractor', kind: 'tractor', price: 400000, funding: 'financed', down_pct: 10, rate: 7, years: 7, per_year: 1, owner: 'farm' };
  const [thin] = planGoals(base(), [g]);
  assert.equal(thin.month_index, null);
  assert.equal(thin.tests.find((x) => x.id === 'equity').ok, false);
  const [ok] = planGoals(base(), [{ ...g, down_pct: 25 }]);
  assert.ok(ok.month_index != null);
  const p = goalPurchase({ ...g, down_pct: 25 }, '2027-01');
  assert.equal(p.deposit, 105000); // 25% of $420,000 with GST
});

test('debt coverage holds it back until older loans run off', () => {
  // Existing payments of $150k a year for three years, then $40k.
  const service = new Array(H).fill(40000).map((v, i) => (i < 36 ? 150000 : v));
  const g = { id: 3, name: 'Land', kind: 'land', price: 300000, funding: 'financed', down_pct: 30, rate: 6, years: 20, per_year: 1, owner: 'farm' };
  const [r] = planGoals(base({ dscr: { capacity: 200000, threshold: 1.25, service, now: 1.33 } }), [g]);
  assert.ok(r.month_index >= 36);
  assert.equal(r.now.find((x) => x.id === 'coverage').ok, false);
  assert.equal(r.first_ok.coverage, 36);
});

test('goals together: the second is no earlier than the first, and counts its cost', () => {
  const truck = { id: 1, name: 'Truck', kind: 'truck', price: 100000, funding: 'cash', owner: 'farm' };
  const tractor = { id: 2, name: 'Tractor', kind: 'tractor', price: 200000, funding: 'cash', owner: 'farm' };
  const [alone] = planGoals(base(), [tractor]);
  const [a, b] = planGoals(base(), [truck, tractor]);
  assert.ok(b.month_index >= a.month_index);
  assert.ok(b.month_index > alone.month_index, 'buying the truck first pushes the tractor back');
});
