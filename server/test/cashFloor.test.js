// The cash floor: at each month-end, what must be paid in the next 60 days
// whether or not money comes in. Capital, estimates and the household
// budget are left out (the budget is sized from the room above the floor,
// Oct 24); each scope sees its own share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowFor, evaluate, mustPayBetween } from '../lib/forecast.js';
import { runScenario } from '../lib/scenario.js';

const TODAY = '2026-10-23';
const ctxWith = (flows, extra = {}) => ({
  win: windowFor(12, TODAY), today: TODAY, flows, lookahead: [], groups: new Map(), known: [], floorDays: 60,
  accounts: [{ id: 1, name: 'Ops', balance: 100000, farm: 1 }, { id: 2, name: 'House', balance: 20000, farm: 0 }],
  bills: [], loans: [], contracts: [], estimates: [], inventory: { items: [] },
  tax: { available: false }, ...extra,
});
const f = (kind, date, amount, farm = 1, ref = {}, estimate = false) => ({ key: `${kind}:${date}:${amount}`, kind, label: kind, date, amount, farm, taxable: 0, estimate, ref });

const flows = [
  f('loan', '2026-11-01', -40000),                       // land payment
  f('bill', '2026-12-10', -5000),
  f('card', '2026-11-20', -3000, 0.5),                   // half farm, half household
  f('personal', '2026-11-15', -2500, 0, { bucket: 'budget' }),       // the household budget: not must-pay
  f('estimate_out', '2026-11-25', -9000, 1, {}, true),   // estimate: left out
  f('whatif', '2026-11-05', -60000),                     // a purchase: left out
  f('gst', '2026-12-20', 3000),                          // a refund isn't owed
  f('bill', '2027-04-15', -80000),                       // spring inputs
  f('contract', '2026-11-30', 90000),
];

test('only what must be paid counts, in the window', () => {
  const m = mustPayBetween(flows, '2026-11-01', '2026-12-31', 'everything');
  assert.equal(m.total, 40000 + 5000 + 3000);
  assert.deepEqual(m.parts, { loans: 40000, bills: 5000, cards: 3000, tax: 0, household: 0, fees: 0 });
});

test('each month-end’s floor is the next 60 days; it rises ahead of spring', () => {
  const ev = evaluate(flows, ctxWith(flows), { scope: 'everything' });
  const t = ev.trajectory;
  assert.equal(t[0].floor, 40000 + 5000 + 3000);        // end of Oct → Nov 1 to Dec 31
  assert.equal(t[1].floor, 5000);                       // end of Nov → December's bill
  assert.equal(t[4].floor, 80000);                      // end of Feb → April inputs
  assert.equal(t[6].floor, 0);                          // end of Apr: paid
  assert.equal(ev.floorNow, 48000);                     // Oct 23 + 60 days
  assert.equal(t[0].headroom, t[0].balance - t[0].floor);
});

test('scopes: farm floor carries the farm share only', () => {
  const ev = evaluate(flows, ctxWith(flows), { scope: 'farm' });
  assert.equal(ev.trajectory[0].floor, 40000 + 5000 + 1500);
  const hh = evaluate(flows, ctxWith(flows), { scope: 'personal' });
  assert.equal(hh.trajectory[0].floor, 1500); // the household's half of the card
});

test('the last months see past the window through the lookahead', () => {
  const ctx = ctxWith([], { lookahead: [f('loan', '2027-11-01', -40000)] });
  const ev = evaluate([], ctx, { scope: 'everything' });
  assert.equal(ev.trajectory[11].floor, 40000); // end of Sep 2027
});

test('tightest month: least cash over its floor, not the lowest balance', () => {
  const ev = evaluate(flows, ctxWith(flows), { scope: 'everything' });
  const worst = Math.min(...ev.trajectory.map((t) => t.headroom));
  assert.equal(ev.trajectory[ev.tightIdx].headroom, worst);
});

test('a new loan in a what-if raises the scenario’s floor', () => {
  const ctx = ctxWith([]);
  const r = runScenario(ctx, { loans_new: [{ amount: 100000, rate: 6, years: 5, per_year: 1, start_month: '2026-11', first_month: '2027-02' }] }, { includeTax: false });
  const plan = r.plan.trajectory.months;
  const scn = r.scenario.trajectory.months;
  assert.equal(plan[2].floor, 0);
  assert.ok(scn[2].floor > 20000, 'end of Dec sees the Feb payment'); // the first annual payment
  assert.equal(r.floor, 0);
});
