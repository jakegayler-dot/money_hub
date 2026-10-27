// Goal studies (Jake, 2026-10-27): "let's say I want to buy a quarter of land".
// Sentinel works out what the goal does on the farm side (its farm agent reads
// Quarter Section and the cattle manager and simulates the crop years); this is
// the money side. It runs the 2-year cash forecast with the purchase in three
// years Sentinel's simulation picked (bad, normal, good), judges each like a
// farm lender (lib/purchaseCheck.js), finds how far revenue can fall before it
// stops working and the most it could pay, and tries the changes that might make
// it work (more down, a longer term, a lower price, buying later, trimming costs).
//
// The farm's flows come from Sentinel as dated amounts:
//   { label, amount (+ in, − out), month: 'YYYY-MM', revenue: true for crop or cattle sales, part: 'farm'|'goal' }
// part 'farm' is the existing farm's next crop year, which Money Hub's own
// forecast doesn't carry yet (it has this year's crop in the bins and the cattle
// estimates, nothing for next year's crop): it is added to the baseline, both
// with and without the purchase, and only when the forecast has no next-crop
// sales of its own. part 'goal' is what the goal itself earns or costs.

import { loadForecast } from './forecast.js';
import { runScenario } from './scenario.js';
import { purchaseVerdict, verdictInputs } from './purchaseCheck.js';
import { goalPurchase } from './goals.js';
import { addMonths } from './dates.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ymOk = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const GRAIN = /canola|wheat|barley|oat|pea|lentil|flax|durum|grain|crop/i;
const RENT = /\brent\b|land rent|cash rent/i;
export const STUDY_MONTHS = 24;
const CASES = ['bad', 'base', 'good'];
const shiftYm = (ym, n) => addMonths(`${ym}-15`, n).slice(0, 7);

/** Validates Sentinel's flows; returns { flows } or { error }. */
export function flowsFromInput(list) {
  if (!Array.isArray(list)) return { error: 'flows must be a list.' };
  const out = [];
  for (const f of list) {
    const amount = Number(f?.amount);
    if (!Number.isFinite(amount) || !amount) continue;
    if (!ymOk(f.month)) return { error: `"${f.label || 'a flow'}" needs a month, YYYY-MM.` };
    out.push({ label: String(f.label || (amount > 0 ? 'Income' : 'Cost')).slice(0, 80), amount: r2(amount), month: f.month,
      revenue: !!f.revenue, part: f.part === 'farm' ? 'farm' : 'goal', kind: f.kind === 'rent' ? 'rent' : null });
  }
  return { flows: out };
}

/** Whether the forecast already carries next crop year's grain sales (from next August on). */
export function hasNextCrop(ctx) {
  const y = Number(String(ctx.today).slice(0, 4)) + (String(ctx.today).slice(5, 7) >= '08' ? 1 : 0);
  const from = `${y}-08-01`;
  return ctx.flows.some((f) => f.amount > 0 && f.date >= from && ['contract', 'estimate_in', 'inventory'].includes(f.kind)
    && GRAIN.test(`${f.ref?.commodity || ''} ${f.label || ''}`) && !/calf|calves|steer|heifer|cattle|cow/i.test(f.label || ''));
}

/** The baseline with the existing farm's next crop year added; rent the forecast already has isn't added twice. */
export function withFarmYear(ctx, farmFlows, notes) {
  if (!farmFlows.length) return ctx;
  if (hasNextCrop(ctx)) { notes.push('Money Hub already has next year\'s crop sales, so Sentinel\'s estimate of the existing farm\'s crop year was left out.'); return ctx; }
  const end = ctx.win?.endStr || '9999-12-31';
  let rentHad = ctx.flows.filter((f) => f.kind === 'bill' && f.amount < 0 && RENT.test(f.label || '') && f.date >= ctx.today && f.date < end).reduce((t, f) => t - f.amount, 0);
  const added = [];
  for (const [i, f] of farmFlows.entries()) {
    let amount = f.amount;
    if (f.kind === 'rent' && rentHad > 0) { const take = Math.min(rentHad, -amount); rentHad -= take; amount = r2(amount + take); if (!amount) continue; }
    added.push({ key: `goalstudy:farm:${i}`, kind: amount > 0 ? 'estimate_in' : 'estimate_out', label: `${f.label} (Sentinel's estimate)`, date: `${f.month}-15`,
      amount, farm: 1, taxable: amount, estimate: true, ref: { goal_study: true, revenue: f.revenue } });
  }
  notes.push('Money Hub\'s forecast had no next crop year, so the existing farm\'s crop year is Sentinel\'s estimate from Quarter Section (sales, inputs, other costs and the rent not already in Money Hub).');
  return { ...ctx, flows: [...ctx.flows, ...added] };
}

const scaleRevenue = (ctx, k) => (k === 1 ? ctx : { ...ctx, flows: ctx.flows.map((f) => (f.ref?.goal_study && f.ref.revenue ? { ...f, amount: r2(f.amount * k), taxable: r2(f.taxable * k) } : f)) });

/** One run: the goal bought in its month with its own flows, judged. */
function runOne(ctx, goal, goalFlows, vin, { revenueK = 1, costsPct = 0, opts }) {
  const c = scaleRevenue(ctx, revenueK);
  const sc = {
    purchases: [goalPurchase(goal, goal.buy_month)],
    oneoffs: goalFlows.map((f) => ({ label: f.label, amount: f.revenue ? r2(f.amount * revenueK) : f.amount, month: f.month, treatment: 'farm' })),
  };
  if (costsPct) sc.costs_pct = costsPct;
  const result = runScenario(c, sc, opts);
  return { result, verdict: purchaseVerdict(result, vin) };
}

const compact = ({ result, verdict }) => ({
  verdict: verdict.verdict, label: verdict.label, headline: verdict.headline,
  tests: verdict.tests.map((t) => ({ id: t.id, status: t.status, detail: t.detail })),
  lowest: { month: result.scenario.low_month, balance: r2(result.scenario.low) },
  lowest_without: { month: result.plan.low_month, balance: r2(result.plan.low) },
  end_change: verdict.figures.end_change, cash_up_front: verdict.figures.cash_up_front, annual_payments: verdict.figures.annual_payments,
  free_cash: verdict.tests.find((t) => t.id === 'reserve')?.deployable ?? null, // cash today after the floor and the reserve
  months: result.scenario.trajectory.months.map((m, i) => ({ month: `${m.year}-${String(m.month).padStart(2, '0')}`,
    without: Math.round(result.plan.trajectory.months[i]?.balance ?? 0), with: Math.round(m.balance) })),
});
const RANK = { viable: 2, tight: 1, not_viable: 0 };

/** The lowest x in [lo, hi] where ok(x) holds, assuming ok is monotone (false below, true above). */
function lowestOk(ok, lo, hi, steps = 10) {
  if (!ok(hi)) return null;
  if (ok(lo)) return lo;
  for (let i = 0; i < steps; i++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; }
  return hi;
}

/**
 * The study. goal: a goals row (price, down_pct, rate, years, per_year, fees,
 * kind, funding, owner) plus buy_month. farm: { cases: { bad, base, good } each
 * { flows: [...] } } from Sentinel. ctx/vin may be passed in (tests).
 */
export async function studyGoal(goal, farm, { ctx, vin, scope = 'everything' } = {}) {
  ctx = ctx || await loadForecast({ months: STUDY_MONTHS });
  vin = vin || await verdictInputs(ctx.win.y0);
  const opts = { scope, includeTax: true };
  const notes = [];
  const today = String(ctx.today).slice(0, 7);
  const g = { ...goal, buy_month: ymOk(goal.buy_month) && goal.buy_month >= today ? goal.buy_month : today };
  const lastMonth = `${ctx.win.meta.at(-1).year}-${String(ctx.win.meta.at(-1).month).padStart(2, '0')}`;
  if (g.buy_month > lastMonth) notes.push(`Bought in ${g.buy_month}, after the ${STUDY_MONTHS}-month window ends (${lastMonth}): the window only shows the saving up.`);

  const cases = {}; const ctxs = {}; const goalFlows = {};
  for (const k of CASES) {
    const flows = farm?.cases?.[k]?.flows || farm?.cases?.base?.flows || [];
    ctxs[k] = withFarmYear(ctx, flows.filter((f) => f.part === 'farm'), k === 'base' ? notes : []);
    goalFlows[k] = flows.filter((f) => f.part !== 'farm');
    cases[k] = compact(runOne(ctxs[k], g, goalFlows[k], vin, { opts }));
  }

  // How far the normal year's sales (the farm's and the goal's) can fall before it stops working.
  const worksAt = (k, min) => (rk) => RANK[runOne(ctxs.base, g, goalFlows.base, vin, { revenueK: rk, opts }).verdict.verdict] >= min;
  const breakEven = {
    workable: lowestOk(worksAt(0, 1), 0.3, 1.5), // tight or better
    comfortable: lowestOk(worksAt(0, 2), 0.3, 1.5), // viable
  };

  // The most it could cost, in the normal and the bad year.
  const atPrice = (k, min) => (p) => RANK[runOne(ctxs[k], { ...g, price: p }, goalFlows[k], vin, { opts }).verdict.verdict] >= min;
  const price = Number(g.price);
  // Search q = 3×price − p from 0 up: the first q that works is the highest price that does (null: not even for free).
  const maxPrice = (k, min) => { const q = lowestOk((x) => atPrice(k, min)(price * 3 - x), 0, price * 3, 10); return q == null ? null : Math.round((price * 3 - q) / 1000) * 1000; };
  const max_price = { base_workable: maxPrice('base', 1), base_comfortable: maxPrice('base', 2), bad_workable: maxPrice('bad', 1) };

  // The changes that might make it work, each tried in the normal and the bad year.
  const tries = [];
  const variant = (change, gv, extra = {}) => {
    const r = Object.fromEntries(['base', 'bad'].map((k) => [k, runOne(ctxs[k], gv, extra.flows?.[k] || goalFlows[k], vin, { opts, costsPct: extra.costsPct || 0 }).verdict]));
    tries.push({ change, base: r.base.verdict, bad: r.bad.verdict, base_headline: r.base.headline });
  };
  if (g.funding !== 'cash') {
    for (const d of [Number(g.down_pct) + 10, Number(g.down_pct) + 25]) if (d <= 100) variant(`${d}% down instead of ${Number(g.down_pct)}%`, { ...g, down_pct: d });
    for (const y of [25, 30]) if (y > Number(g.years)) variant(`a ${y}-year term instead of ${Number(g.years)}`, { ...g, years: y });
  }
  for (const pct of [5, 10]) variant(`${pct}% off the price ($${Math.round(price * (1 - pct / 100)).toLocaleString('en-CA')})`, { ...g, price: r2(price * (1 - pct / 100)) });
  for (const n of [6, 12]) {
    const later = shiftYm(g.buy_month, n);
    const shift = (fl) => fl.map((f) => ({ ...f, month: shiftYm(f.month, n) }));
    variant(`buy ${n} months later (${later})`, { ...g, buy_month: later }, { flows: { base: shift(goalFlows.base), bad: shift(goalFlows.bad) } });
  }
  variant('farm costs trimmed 5%', g, { costsPct: -5 });
  const fixes = tries.filter((t) => RANK[t.base] > RANK[cases.base.verdict] || RANK[t.bad] > RANK[cases.bad.verdict]);

  return {
    studied_at: new Date().toISOString(), window: { from: today, to: lastMonth, months: STUDY_MONTHS }, scope,
    purchase: { price, buy_month: g.buy_month, down_pct: Number(g.down_pct), rate: Number(g.rate), years: Number(g.years), per_year: Number(g.per_year) || 1,
      cash_up_front: cases.base.cash_up_front, annual_payments: cases.base.annual_payments },
    cases, break_even_revenue: breakEven, max_price, tries, fixes, notes,
  };
}
