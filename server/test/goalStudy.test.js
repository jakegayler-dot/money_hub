import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowFor } from '../lib/forecast.js';
import { studyGoal, hasNextCrop, flowsFromInput, withFarmYear } from '../lib/goalStudy.js';
import { personalTax } from '../lib/taxRates.js';

const TODAY = '2026-10-27';
function ctxWith(flows, balance = 150000) {
  return {
    win: windowFor(24, TODAY), today: TODAY, flows, groups: new Map(), known: [],
    accounts: [{ id: 1, name: 'Ops', balance, farm: 1 }],
    bills: [], loans: [], contracts: [], estimates: [], inventory: { items: [] }, bufferPct: 0.15,
    tax: { available: true, netY0: 150000, taxY0: personalTax(150000, 2026).total, paidY0: null, priorOwingY0: null, paidPrev: null },
  };
}
const vin = { coverage: { threshold: 1.25, projected: { ratio: 2.4, ffsc: 240000, debt_service: 100000 } }, reserveTarget: 20000 };
const rent = { key: 'bill:1', kind: 'bill', label: 'SK Ltd — Land Rent', date: '2027-04-01', amount: -40000, farm: 1, taxable: -40000, estimate: false, ref: { bill_id: 1 } };
const calves = { key: 'est:1', kind: 'estimate_in', label: 'Calf sales', date: '2027-10-15', amount: 60000, farm: 1, taxable: 60000, estimate: true, ref: {} };
const quarter = { id: 1, name: 'NE 12 quarter', kind: 'land', price: 640000, trade_in: 0, fees: 3000, funding: 'financed', down_pct: 25, rate: 6.5, years: 25, per_year: 1, owner: 'farm', buy_month: '2027-03' };
// The existing farm's 2027 crop (Sentinel's estimate) and the quarter cropped.
const farmYear = (k) => [
  { label: '2027 crop inputs', amount: -300000, month: '2027-05', part: 'farm' },
  { label: 'Land rent 2027', amount: -90000, month: '2027-04', part: 'farm', kind: 'rent' },
  { label: '2027 crop sales', amount: 900000 * k, month: '2027-12', part: 'farm', revenue: true },
];
const land = (k) => [
  { label: 'Quarter: inputs', amount: -40000, month: '2027-05' },
  { label: 'Quarter: crop sales', amount: 95000 * k, month: '2027-12', revenue: true },
];
const farm = { cases: { bad: { flows: [...farmYear(0.7), ...land(0.7)] }, base: { flows: [...farmYear(1), ...land(1)] }, good: { flows: [...farmYear(1.2), ...land(1.2)] } } };

test('goal study: next year\'s crop is added only when Money Hub has none, and rent already billed isn\'t counted twice (Oct 27)', () => {
  const ctx = ctxWith([rent, calves]);
  assert.equal(hasNextCrop(ctx), false, 'calf sales are not a crop');
  const notes = [];
  const { flows } = flowsFromInput(farmYear(1).map((f) => ({ ...f })));
  const c = withFarmYear(ctx, flows, notes);
  const added = c.flows.filter((f) => f.ref?.goal_study);
  assert.equal(added.find((f) => /rent/i.test(f.label)).amount, -50000, '90,000 of rent less the 40,000 already billed');
  assert.ok(added.find((f) => /sales/.test(f.label)).ref.revenue);
  assert.match(notes[0], /no next crop year/);
  const withCrop = ctxWith([{ key: 'c:1', kind: 'contract', label: 'Canola — Bunge', date: '2027-11-10', amount: 50000, farm: 1, taxable: 50000, ref: { commodity: 'canola' } }]);
  assert.equal(hasNextCrop(withCrop), true);
  assert.equal(withFarmYear(withCrop, flows, []).flows.length, 1);
  assert.match(flowsFromInput([{ label: 'x', amount: 5, month: '2027' }]).error, /YYYY-MM/);
});

test('goal study: three years judged, how far sales can fall, the most it could cost, and what would fix it (Oct 27)', async () => {
  const s = await studyGoal(quarter, farm, { ctx: ctxWith([rent, calves]), vin });
  assert.deepEqual(Object.keys(s.cases), ['bad', 'base', 'good']);
  for (const k of ['bad', 'base', 'good']) assert.ok(['viable', 'tight', 'not_viable'].includes(s.cases[k].verdict), k);
  assert.ok(s.cases.good.lowest.balance >= s.cases.base.lowest.balance && s.cases.base.lowest.balance >= s.cases.bad.lowest.balance, 'better years, more cash');
  assert.equal(s.cases.base.months.length, 24);
  assert.equal(s.purchase.cash_up_front, 163000, '25% of 640,000 plus the 3,000 fees');
  assert.ok(s.purchase.annual_payments > 35000 && s.purchase.annual_payments < 45000);
  // Sales can fall some way and still work; lower sales never work better.
  const be = s.break_even_revenue;
  assert.ok(be.workable == null || (be.workable > 0.3 && be.workable <= 1.5));
  if (be.workable != null && be.comfortable != null) assert.ok(be.comfortable >= be.workable);
  // The most it could cost: a cheaper quarter works where a dearer one doesn't.
  const mp = s.max_price;
  if (mp.base_comfortable != null && mp.base_workable != null) assert.ok(mp.base_workable >= mp.base_comfortable);
  assert.ok(s.tries.some((t) => /35% down/.test(t.change)) && s.tries.some((t) => /30-year/.test(t.change)) && s.tries.some((t) => /12 months later \(2028-03\)/.test(t.change)));
  assert.ok(s.fixes.every((f) => s.tries.includes(f)));
  assert.match(s.notes.join(' '), /no next crop year/);

  // Too dear: the same quarter at three times the price doesn't work in a bad year, and the fixes say what helps.
  const dear = await studyGoal({ ...quarter, price: 2400000 }, farm, { ctx: ctxWith([rent, calves]), vin });
  assert.equal(dear.cases.bad.verdict, 'not_viable');
  assert.ok(dear.max_price.base_workable == null || dear.max_price.base_workable < 2400000);
});
