// A household budget that fits the forecast (Jake, 2026-10-24: "generate a
// budget that sits within the forecast constraints"; held to the cash floor,
// 12 months ahead, by category and by person, adopted with a button).
//
// The forecast already has everything else: income, contracts, bills, loans,
// card statements, fees, estimates and the household's essentials. Take its
// discretionary spending out, and each month-end t has some headroom: cash
// minus the floor (what must be paid in the weeks after it). A discretionary
// budget of D a month spends D in every month up to t, so it fits when
//     headroom_t − D × (months up to t) ≥ 0   for every t,
// and the most it can be is the smallest headroom_t / months_t. Discretionary
// spending isn't part of the floor (only must-pay items are), so the floor
// doesn't move with D — this is exact, and checked by re-running the forecast.
//
// That's the ceiling, not the budget: the budget is what the household
// actually spends on discretionary (last six full months, bills left out)
// when that fits under it — the room left over stays as cash — and is cut
// down to the ceiling, category by category in the same proportions, when
// it doesn't. Shared across Jake and Ashley the same way. Essentials, bills and loan payments
// aren't part of it: they're what the forecast already holds, shown for the
// full picture. Adopting it sets the forecast's discretionary budget to D.
import { pool, getSetting } from '../db.js';
import { loadForecast, evaluate } from './forecast.js';
import { spendingMix } from './personal.js';
import { todayISO } from './dates.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const label = (m) => `${MONTHS[m.month - 1]} ${m.year}`;
export const STEP = 10; // the budget is a round number of dollars, rounded down so it always fits

const isDisc = (f) => f.kind === 'personal' && f.ref?.bucket === 'discretionary';

/** Discretionary flows of D a month over the window, dated the way the forecast dates them. */
export function discretionaryFlows(meta, today, D) {
  return meta.map((m, i) => ({
    key: `budget:disc:${m.year}-${pad(m.month)}`, kind: 'personal', label: 'Discretionary budget',
    date: i === 0 ? today : `${m.year}-${pad(m.month)}-15`, amount: -D, farm: 0, estimate: true, ref: { bucket: 'discretionary' },
  })).filter(() => D > 0);
}

/**
 * The most a month that keeps every month-end at or above the floor, from
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
  const base = ctx.flows.filter((f) => !isDisc(f));
  const current = ctx.flows.filter(isDisc);
  const currentMonthly = current.length ? r2(-current[0].amount) : 0;

  // Headroom with no discretionary spending, then the most a month that keeps it.
  const ev0 = evaluate(base, ctx, { scope: 'everything' });
  const { max, bindingIdx, shortfall } = maxMonthly(ev0.trajectory.map((t) => t.headroom));
  const ceiling = Math.max(0, Math.floor(max / STEP) * STEP);

  // The budget: what the household actually spends when that fits (room left over stays as cash),
  // cut down to the ceiling when it doesn't. No history yet: the ceiling is all there is to go on.
  const mix = await spendingMix(today, 6);
  const discCats = mix.discretionary;
  const typicalDisc = r2(discCats.reduce((a, c) => a + c.monthly, 0));
  const typicalRounded = Math.ceil(typicalDisc / STEP) * STEP;
  const monthly = typicalDisc > 0 ? Math.min(typicalRounded, ceiling) : ceiling;
  const fits = typicalDisc > 0 && typicalRounded <= ceiling;

  // Checked by running the forecast with it.
  const ev = evaluate([...base, ...discretionaryFlows(meta, today, monthly)], ctx, { scope: 'everything' });
  const tight = ev.trajectory[ev.tightIdx];
  const evNow = evaluate(ctx.flows, ctx, { scope: 'everything' });

  // Shared by category and by person, in proportion to what the household actually spends.
  const amounts = shareOut(discCats, monthly, (c) => c.monthly);
  const categories = discCats.map((c, i) => {
    const a = amounts[i];
    const f = c.monthly ? a / c.monthly : 0;
    const jake = Math.round(c.jake * f); const ashley = Math.round(c.ashley * f);
    return { category: c.category, category_ids: c.category_ids, amount: a, typical: c.monthly, jake, ashley, untagged: a - jake - ashley };
  }).filter((c) => c.amount > 0);
  const people = categories.reduce((p, c) => ({ jake: p.jake + c.jake, ashley: p.ashley + c.ashley, untagged: p.untagged + c.untagged }), { jake: 0, ashley: 0, untagged: 0 });

  // What the forecast already holds for the household each month (not part of the budget).
  const n = meta.length;
  const household = (f) => 1 - (f.farm ?? 1);
  const avg = (pred) => r2(ctx.flows.filter((f) => f.amount < 0 && f.date < ctx.win.endStr && pred(f)).reduce((a, f) => a - f.amount * household(f), 0) / n);
  const scheduledItems = new Map();
  for (const f of ctx.flows) {
    if (f.amount >= 0 || f.date >= ctx.win.endStr || !['bill', 'loan', 'lease', 'card', 'fee'].includes(f.kind)) continue;
    const v = -f.amount * household(f);
    if (v < 0.005) continue;
    const name = f.kind === 'card' ? 'Card statements' : f.kind === 'fee' ? 'Account fees' : (f.label || 'Bill');
    scheduledItems.set(name, (scheduledItems.get(name) || 0) + v);
  }
  const holds = {
    essentials: avg((f) => f.kind === 'personal' && f.ref?.bucket === 'essential'),
    essential_categories: mix.essential.map((c) => ({ category: c.category, monthly: c.monthly })),
    scheduled: avg((f) => ['bill', 'loan', 'lease', 'card', 'fee'].includes(f.kind)),
    scheduled_items: [...scheduledItems].map(([name, v]) => ({ name, monthly: r2(v / n) })).filter((x) => x.monthly >= 1).sort((a, b) => b.monthly - a.monthly),
  };

  // The one adopted, with this month's spending against it.
  const adopted = await getSetting('personal_budget_plan', null);
  const spentThisMonth = Object.fromEntries([...mix.thisMonth].map(([k, v]) => [k, r2(v)]));

  return {
    today, months: n,
    monthly, ceiling, fits, current_monthly: currentMonthly, typical: typicalDisc,
    cut_pct: !fits && typicalDisc > 0 ? Math.round((1 - monthly / typicalDisc) * 100) : 0,
    history_months: mix.months,
    shortfall: shortfall ? { month: label(meta[shortfall.idx]), amount: shortfall.amount } : null,
    binding: bindingIdx >= 0 ? { month: label(meta[bindingIdx]), months_to_it: bindingIdx + 1, headroom: r2(ev0.trajectory[bindingIdx].headroom) } : null,
    tightest: { month: label(tight), headroom: tight.headroom, balance: tight.balance, floor: tight.floor },
    // Month by month: cash above the floor with this budget, and with what the forecast uses now.
    path: ev.trajectory.map((t, i) => ({ month: label(t), headroom: t.headroom, now: evNow.trajectory[i].headroom })),
    categories, people,
    holds,
    adopted: adopted && typeof adopted === 'object' ? adopted : null,
    spent_this_month: spentThisMonth,
  };
}

/** Makes `plan` (from generateBudget) the forecast's discretionary budget and the household's category budgets. */
export async function adoptBudget(plan) {
  const monthly = Number(plan?.monthly);
  if (!Number.isFinite(monthly) || monthly < 0) {
    throw Object.assign(new Error('monthly is required: the budget a month, in dollars.'), { status: 400 });
  }
  const categories = (Array.isArray(plan.categories) ? plan.categories : []).map((c) => ({
    category: String(c.category || ''), category_ids: (c.category_ids || []).map(Number).filter(Boolean),
    amount: Number(c.amount) || 0, jake: Number(c.jake) || 0, ashley: Number(c.ashley) || 0, untagged: Number(c.untagged) || 0,
  })).filter((c) => c.category);
  const set = (key, value) => pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
  await set('personal_budget_mode', 'actual');
  await set('personal_discretionary_month', monthly);
  const saved = { adopted_on: todayISO(), monthly, categories };
  await set('personal_budget_plan', saved);
  return saved;
}
