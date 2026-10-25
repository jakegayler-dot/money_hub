// The household budget (Jake, 2026-10-24: "use a simple budget based on the
// amount above the floor"). The forecast works it out (lib/forecast.js,
// householdBudget): with bills, loans, card statements, fees, tax and the
// farm all in, each month-end has some room above the cash floor; the most
// a month the household could spend and keep every month-end above the floor
// is the smallest room ÷ months-to-it, and the budget is 90% of that,
// rounded down to $10. It covers everything that isn't a bill, a loan or a
// card statement, and Cash Flow spends it every month.
//
// This module explains it for the Personal page: the month-by-month room,
// the tightest month, and how the budget splits over the categories and
// people the household actually spends on (a guide, not separate limits).
import { loadForecast, evaluate } from './forecast.js';
import { spendingMix } from './personal.js';
import { todayISO } from './dates.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const label = (m) => `${MONTHS[m.month - 1]} ${m.year}`;
export const STEP = 10; // the budget is a round number of dollars, rounded down so it always fits

/**
 * (The same rule the forecast uses, kept for its test.) The most a month that keeps every month-end at or above the floor, from
 * the headroom with no discretionary spending (pure — exported for tests).
 * → { max, bindingIdx, shortfall: null | { idx, amount } }
 */
export function maxMonthly(headroom) {
  let max = Infinity; let bindingIdx = -1;
  headroom.forEach((h, i) => { const cap = h / (i + 1); if (cap < max) { max = cap; bindingIdx = i; } });
  if (!headroom.length) return { max: 0, bindingIdx: -1, shortfall: null };
  if (max < 0) {
    const worst = headroom.reduce((k, h, i) => (h < headroom[k] ? i : k), 0);
    return { max: 0, bindingIdx, shortfall: { idx: worst, amount: r2(-headroom[worst]) } };
  }
  return { max, bindingIdx, shortfall: null };
}

/** Shares `total` across items by `weight`, in whole $5s that add up exactly. */
export function shareOut(items, total, weight) {
  const sum = items.reduce((a, x) => a + weight(x), 0);
  if (!items.length || !sum || total <= 0) return items.map(() => 0);
  const raw = items.map((x) => (total * weight(x)) / sum);
  const out = raw.map((v) => Math.floor(v / 5) * 5);
  let left = Math.round(total - out.reduce((a, v) => a + v, 0));
  // The remainder in $5s to the biggest rounding losses; any odd dollars to the largest.
  const order = raw.map((v, i) => [v - out[i], i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  for (const i of order) { if (left < 5) break; out[i] += 5; left -= 5; }
  if (left) out[raw.indexOf(Math.max(...raw))] += left;
  return out;
}

export async function generateBudget({ today = todayISO(), months = 12 } = {}) {
  const ctx = await loadForecast({ months, today });
  const meta = ctx.win.meta;
  const p = ctx.personal || { per_month: 0, share: 0.9, room: 0, spent_this_month: 0, binding: null, shortfall: null };
  const monthly = p.per_month;
  const lbl = (x) => (x ? label(x) : null);

  // Cash above the floor at each month-end, with the budget spent.
  const ev = evaluate(ctx.flows, ctx, { scope: 'everything' });
  const tight = ev.trajectory[ev.tightIdx];

  // The budget shared over what the household actually spends on (last six full months, bills and
  // loans left out), and over who spends it — a guide to where it goes, not separate limits.
  const mix = await spendingMix(today, 6);
  const cats = [...mix.essential, ...mix.discretionary].sort((a, b) => b.monthly - a.monthly);
  const typical = r2(cats.reduce((a, c) => a + c.monthly, 0));
  const amounts = shareOut(cats, monthly, (c) => c.monthly);
  const categories = cats.map((c, i) => {
    const a = amounts[i];
    const f = c.monthly ? a / c.monthly : 0;
    const jake = Math.round(c.jake * f); const ashley = Math.round(c.ashley * f);
    return { category: c.category, category_ids: c.category_ids, amount: a, typical: c.monthly, jake, ashley, untagged: a - jake - ashley };
  }).filter((c) => c.amount > 0);
  const people = categories.reduce((x, c) => ({ jake: x.jake + c.jake, ashley: x.ashley + c.ashley, untagged: x.untagged + c.untagged }), { jake: 0, ashley: 0, untagged: 0 });

  // What's in the forecast for the household besides the budget: bills, loan payments, card statements, fees.
  const n = meta.length;
  const household = (f) => 1 - (f.farm ?? 1);
  const items = new Map();
  for (const f of ctx.flows) {
    if (f.amount >= 0 || f.date >= ctx.win.endStr || !['bill', 'loan', 'lease', 'card', 'fee'].includes(f.kind)) continue;
    const v = -f.amount * household(f);
    if (v < 0.005) continue;
    const name = f.kind === 'card' ? 'Card statements' : f.kind === 'fee' ? 'Account fees' : (f.label || 'Bill');
    items.set(name, (items.get(name) || 0) + v);
  }
  const scheduledItems = [...items].map(([name, v]) => ({ name, monthly: r2(v / n) })).filter((x) => x.monthly >= 1).sort((a, b) => b.monthly - a.monthly);

  return {
    today, months: n,
    monthly, share: p.share, room: p.room, typical,
    spent_this_month: p.spent_this_month,
    left_this_month: r2(Math.max(0, monthly - p.spent_this_month)),
    history_months: mix.months,
    shortfall: p.shortfall ? { month: lbl(p.shortfall), amount: p.shortfall.amount } : null,
    binding: p.binding ? { month: lbl(p.binding), months_to_it: p.binding.months_to_it } : null,
    tightest: { month: label(tight), headroom: tight.headroom, balance: tight.balance, floor: tight.floor },
    path: ev.trajectory.map((t) => ({ month: label(t), headroom: t.headroom })),
    categories, people,
    holds: { scheduled: r2(scheduledItems.reduce((a, x) => a + x.monthly, 0)), scheduled_items: scheduledItems },
    spent_by_category: Object.fromEntries([...mix.thisMonth].map(([k, v]) => [k, r2(v)])),
  };
}
