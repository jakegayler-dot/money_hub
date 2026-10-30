// Long-term goals (Jake, 2026-10-26: "buying a new tractor, diesel farm
// truck, piece of land … when xyz are met the tractor can be purchased and
// this will take x months/years").
//
// A goal is a purchase with its funding: cash, or a down payment and a loan
// (rate, term, payments a year). The planner finds the first month it can
// be bought with every condition met, the way a farm lender or money manager
// would judge it:
//
//   cash floor  every month-end for two years after buying covers what must
//               be paid in the weeks after it (the new payments included)
//   reserve     the month it's bought, cash is still the reserve target
//               above that floor
//   coverage    term debt coverage with the new payments at or over the
//               lender's threshold (1.25×), on the farm's debt as it runs off
//   money down  15% or more of a financed deal is the buyer's own
//
// The next 12 months are Cash Flow's forecast as it stands (household budget
// included). Past that, each year repeats it — same income, costs and bills —
// except loan payments, which follow their real schedules as loans pay down.
// Household spending is held at the budget rule's share (90%) of what a year
// leaves after bills, loans and the farm — not this year's Cash Flow budget,
// which also spends the cash already on hand; here that cash goes to the
// goals. A smaller share is shown too: spend less, buy sooner.
// Goals picked together go in the order given: each is bought no earlier
// than the one before, with that one's down payment and payments counted.
import { pool } from '../db.js';
import { loadForecast, evaluate } from './forecast.js';
import { purchaseTerms, loanSchedule } from './scenario.js';
import { termDebtCoverage, reserveStatus } from './calculations.js';
import { businessShare } from './segments.js';
import { toISODate, addMonths, addDays, todayISO } from './dates.js';

export const HORIZON = 120; // ten years
export const HOLD_MONTHS = 24; // the floor must hold this long after buying
export const EQUITY_MIN_PCT = 15;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');

export const KIND_DEFAULTS = {
  tractor: { label: 'Tractor', gst_pct: 5, pst_pct: 0, cca_rate: 30 },
  combine: { label: 'Combine', gst_pct: 5, pst_pct: 0, cca_rate: 30 },
  machinery: { label: 'Machinery', gst_pct: 5, pst_pct: 0, cca_rate: 30 },
  truck: { label: 'Truck', gst_pct: 5, pst_pct: 6, cca_rate: 30 },
  land: { label: 'Land', gst_pct: 0, pst_pct: 0, cca_rate: 0 },
  building: { label: 'Building or bins', gst_pct: 5, pst_pct: 6, cca_rate: 10 },
  cattle: { label: 'Breeding stock', gst_pct: 0, pst_pct: 0, cca_rate: 0 },
  other: { label: 'Other', gst_pct: 5, pst_pct: 6, cca_rate: 20 },
};

/** A goal as the what-if engine's purchase, bought in month `ym` (YYYY-MM). */
export function goalPurchase(g, ym) {
  const d = KIND_DEFAULTS[g.kind] || KIND_DEFAULTS.other;
  const gst = g.gst_pct ?? d.gst_pct; const pst = g.pst_pct ?? d.pst_pct;
  const price = Number(g.price) || 0;
  const trade = Math.min(price, Number(g.trade_in) || 0);
  const base = price - trade;
  const cash = g.funding === 'cash';
  // Financed: the down payment is a share of the price with its taxes (taxes go on the loan).
  const owed = base * (1 + (gst + pst) / 100);
  return {
    label: g.name, price, trade_in: trade, gst_pct: gst, pst_pct: pst, fees: Number(g.fees) || 0,
    taxes: cash ? 'cash' : 'financed',
    deposit: cash ? base : r2(owed * (Number(g.down_pct) || 0) / 100),
    rate: cash ? 0 : Number(g.rate) || 0, years: cash ? 1 : Number(g.years) || 5, per_year: Number(g.per_year) || 1,
    month: ym, owner: g.owner === 'personal' ? 'personal' : 'farm', cca_rate: g.cca_rate ?? d.cca_rate,
  };
}

/**
 * What a goal adds, month by month over the horizon (from month index `t`):
 * net cash (down payment out, GST back about three months on, the loan's
 * payments), the payments falling due in each month's floor window, and the
 * farm's annual payments for the coverage test.
 */
export function goalEffect(g, t, meta, floorDays = 60) {
  const ym = (i) => `${meta[i].year}-${pad(meta[i].month)}`;
  const p = goalPurchase(g, ym(t));
  const terms = purchaseTerms(p, {});
  const H = meta.length;
  const net = new Array(H).fill(0);
  const due = new Array(H).fill(0);
  net[t] -= terms.cash_up_front;
  if (terms.gst_refund > 0 && t + 3 < H) net[t + 3] += terms.gst_refund;
  const idx = new Map(meta.map((m, i) => [`${m.year}-${pad(m.month)}`, i]));
  const pays = terms.financed > 0
    ? loanSchedule({ amount: terms.financed, rate: terms.rate, years: terms.years, per_year: terms.per_year, first_month: addMonths(`${p.month}-01`, 12 / terms.per_year).slice(0, 7) }).payments
    : [];
  for (const x of pays) {
    const i = idx.get(x.date.slice(0, 7));
    if (i != null) net[i] -= x.payment;
    // In the floor of each month-end whose window it falls in.
    for (let k = 0; k < H; k++) {
      const start = monthStart(meta, k + 1);
      if (x.date >= start && x.date < addDays(start, floorDays)) due[k] += x.payment;
    }
  }
  return { terms, net, due, annual: terms.owner === 'farm' ? terms.annual_payment : 0, pays };
}
const monthStart = (meta, i) => {
  const last = meta[meta.length - 1];
  if (i < meta.length) return `${meta[i].year}-${pad(meta[i].month)}-01`;
  const d = new Date(Date.UTC(last.year, last.month - 1 + (i - meta.length + 1), 1));
  return d.toISOString().slice(0, 10);
};

/**
 * The tests for buying at month t, given the base (with earlier goals in).
 * base: { meta, opening, net[], floor[], reserve, dscr: { capacity, threshold, service[] } }.
 */
export function testsAt(base, g, eff, t, addedAnnual = 0) {
  const H = base.meta.length;
  let bal = base.opening; let without = base.opening;
  const head = []; const headWithout = [];
  for (let i = 0; i < H; i++) {
    bal += base.net[i] + eff.net[i];
    without += base.net[i];
    const cap = base.floorCap ?? Infinity; // the floor never goes over its cap (setting floor_cap)
    head.push(bal - Math.min(cap, base.floor[i] + eff.due[i]));
    headWithout.push(without - Math.min(cap, base.floor[i]));
  }
  // Two years after buying, every month-end must cover its floor; after that, the purchase mustn't
  // cause a shortfall (a month already short without it is flagged on its own, not held against it).
  let worst = Infinity; let worstIdx = t;
  for (let i = t; i < H; i++) {
    if (i > t + HOLD_MONTHS && headWithout[i] < 0) continue;
    if (head[i] < worst) { worst = head[i]; worstIdx = i; }
  }
  const out = [];
  out.push({ id: 'cash', ok: worst >= 0, value: r2(worst), month: worstIdx });
  out.push({ id: 'reserve', ok: head[t] >= base.reserve, value: r2(head[t]), need: r2(base.reserve) });
  if (eff.annual > 0 && base.dscr.capacity != null) {
    const svc = base.dscr.service[t] + addedAnnual + eff.annual;
    const ratio = svc > 0 ? base.dscr.capacity / svc : null;
    out.push({ id: 'coverage', ok: ratio != null && ratio >= base.dscr.threshold, value: ratio == null ? null : r2(ratio), need: base.dscr.threshold });
  } else {
    out.push({ id: 'coverage', ok: true, na: true });
  }
  const eq = eff.terms.financed > 0 ? eff.terms.equity_pct : 100;
  out.push({ id: 'equity', ok: eq >= EQUITY_MIN_PCT, value: r2(eq), need: EQUITY_MIN_PCT, na: !(eff.terms.financed > 0) });
  return out;
}

/**
 * Plans goals in the order given. Each is placed at the first month (no
 * earlier than the goal before it) where every test passes; its cash and
 * payments then go into the base for the next. Pure — exported for tests.
 */
export function planGoals(base, goals) {
  const H = base.meta.length;
  const cur = { ...base, net: [...base.net], floor: [...base.floor] };
  let addedAnnual = new Array(H).fill(0);
  let from = 0;
  const out = [];
  for (const g of goals) {
    let found = null; let firstOk = {}; let lastTests = null;
    for (let t = from; t < H; t++) {
      const eff = goalEffect(g, t, base.meta, base.floorDays);
      const tests = testsAt(cur, g, eff, t, addedAnnual[t]);
      if (t === from) lastTests = tests;
      for (const x of tests) if (x.ok && firstOk[x.id] == null) firstOk[x.id] = t;
      if (tests.every((x) => x.ok)) { found = { t, eff, tests }; break; }
      lastTests = tests;
    }
    // Today's position on each test, for "what's holding it".
    const at = Math.min(from, H - 1);
    const effNow = goalEffect(g, at, base.meta, base.floorDays);
    const now = testsAt(cur, g, effNow, at, addedAnnual[at]);
    const res = { goal: g, now, first_ok: firstOk, after_unreached: from >= H, from: at };
    if (found) {
      const { t, eff, tests } = found;
      Object.assign(res, { month_index: t, tests, terms: stripTerms(eff.terms) });
      for (let i = 0; i < H; i++) { cur.net[i] += eff.net[i]; cur.floor[i] += eff.due[i]; }
      // The new farm payments count against coverage from the month bought, for as long as they run.
      const runs = eff.pays.map((x) => x.date.slice(0, 7));
      addedAnnual = addedAnnual.map((v, i) => {
        const m = `${base.meta[i].year}-${pad(base.meta[i].month)}`;
        const live = i >= t && (!runs.length || m <= runs[runs.length - 1]);
        return v + (live ? eff.annual : 0);
      });
      from = t;
    } else {
      // Never within the horizon: the tests at the end show what's still short.
      const effEnd = goalEffect(g, H - 1, base.meta, base.floorDays);
      Object.assign(res, { month_index: null, tests: testsAt(cur, g, effEnd, H - 1, addedAnnual[H - 1]), terms: stripTerms(effEnd.terms) });
      void lastTests;
      from = H; // the ones after it can't come before it
    }
    out.push(res);
  }
  return out;
}
const stripTerms = (t) => { const { payments, ...rest } = t; void payments; return rest; };

/**
 * The base the planner works on, from the live forecast. `budgetShare`
 * (0–1, optional) re-sizes the household budget to that share of the room
 * above the floor, to see what spending less would do.
 */
export async function loadBase({ today = todayISO(), budgetShare = null } = {}) {
  const ctx = await loadForecast({ months: 12, today });
  const ev = evaluate(ctx.flows, ctx, { scope: 'everything' });
  const meta = Array.from({ length: HORIZON }, (_, i) => {
    const d = new Date(Date.UTC(ctx.win.y0, ctx.win.m0 + i, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  });
  const keyOf = (m) => `${m.year}-${pad(m.month)}`;
  const idx = new Map(meta.map((m, i) => [keyOf(m), i]));
  const endStr = monthStart(meta, HORIZON);

  // Loan payments on their real schedules, all ten years.
  const { rows: lp } = await pool.query(
    `SELECT lp.due_date, lp.principal_amount + lp.interest_amount AS total, l.segment, l.is_segment_split, l.segment_grain_pct, l.segment_livestock_pct
     FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
     WHERE NOT lp.paid AND NOT lp.is_adjustment AND lp.due_date < $1
       AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.loan_id = lp.loan_id AND b.status = 'unpaid' AND b.frequency = 'one_time' AND b.due_date <= lp.due_date)`,
    [endStr]).catch(() => ({ rows: [] }));
  const loanNet = new Array(HORIZON).fill(0);
  const farmService = new Array(HORIZON).fill(0); // farm loan payments in each month
  const pays = lp.map((p) => ({ date: toISODate(p.due_date) < today ? today : toISODate(p.due_date), amt: Number(p.total), farm: businessShare(p) }));
  for (const p of pays) {
    const i = idx.get(p.date.slice(0, 7));
    if (i == null) continue;
    loanNet[i] -= p.amt;
    farmService[i] += p.amt * p.farm;
  }
  const days = ctx.floorDays || 60;
  const loanDue = meta.map((_, k) => {
    const s = monthStart(meta, k + 1); const e = addDays(s, days);
    return pays.filter((p) => p.date >= s && p.date < e).reduce((a, p) => a + p.amt, 0);
  });

  // Year one from the forecast, less its loan payments (put back from the schedules above) and its household budget (sized below).
  const y1 = ev.trajectory;
  const budgetOf = (m) => m.items.filter((x) => x.kind === 'personal' && x.ref?.bucket === 'budget').reduce((a, x) => a + x.amount, 0);
  const loanOf = (m) => m.items.filter((x) => x.kind === 'loan').reduce((a, x) => a + x.amount, 0);
  const core = y1.map((m) => m.inflow + m.outflow - loanOf(m) - budgetOf(m));
  const p = ctx.personal || {};
  const share = budgetShare != null ? budgetShare : (p.share ?? 0.9);
  const perMonth = Number(p.per_month) || 0;
  // Everything due in each month-end's window (before the cap; testsAt applies it).
  const floor = meta.map((_, i) => Math.max(0, (y1[i % 12].floorDue ?? y1[i % 12].floor) - loanDue[i % 12] + loanDue[i]));
  // Household spending while saving for goals: the budget rule (its share of the room) applied to what a
  // year leaves after bills, loans and the farm — without the cash already on hand, which this year's Cash
  // Flow budget partly spends and which goes to the goals here. Held flat; a smaller share saves faster.
  const yearSurplus = core.reduce((a, v) => a + v, 0) + loanNet.slice(0, 12).reduce((a, v) => a + v, 0);
  const steady = Math.floor(Math.max(0, yearSurplus) * share / 12 / 10) * 10;
  const budget = meta.map((_, i) => (i === 0 ? -Math.max(0, steady - (p.spent_this_month || 0)) : -steady));
  const net = meta.map((_, i) => core[i % 12] + loanNet[i] + budget[i]);

  // Coverage: the lender's figure today, its debt service following the schedules as loans pay down.
  const [coverage, reserve] = await Promise.all([termDebtCoverage().catch(() => null), reserveStatus(ctx.win.y0).catch(() => ({ target: 0 }))]);
  const svc0 = farmService.slice(0, 12).reduce((a, v) => a + v, 0);
  const lenderSvc = coverage?.projected?.termDebtService ?? svc0;
  const service = meta.map((_, i) => {
    const mine = farmService.slice(i, i + 12).reduce((a, v) => a + v, 0);
    return svc0 > 0 ? lenderSvc * (mine / svc0) : mine;
  });
  return {
    today, meta, opening: ev.opening, net, floor, floorDays: days, floorCap: ctx.floorCap ?? null, reserve: r2(reserve?.target || 0),
    budget: { per_month: steady, cash_flow_budget: perMonth, share, year_surplus: r2(yearSurplus) },
    dscr: {
      capacity: coverage?.projected?.capacity ?? null, threshold: Number(coverage?.threshold) || 1.25,
      service, now: coverage?.projected?.ratio ?? null,
    },
  };
}

export const monthLabel = (m) => new Date(Date.UTC(m.year, m.month - 1, 1)).toLocaleDateString('en-CA', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const $ = (v) => `${v < 0 ? '−' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-CA')}`;
const span = (n) => {
  if (n <= 0) return 'now';
  const y = Math.floor(n / 12); const m = n % 12;
  return [y ? `${y} year${y === 1 ? '' : 's'}` : '', m ? `${m} month${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ');
};

/** Words for one planned goal: when, why then, and what each condition is. */
export function explain(base, r) {
  const L = (i) => monthLabel(base.meta[i]);
  const tst = (id) => r.tests.find((x) => x.id === id);
  const now = (id) => r.now.find((x) => x.id === id);
  const t = r.terms;
  const conditions = [];
  const c = tst('cash');
  conditions.push({ id: 'cash', label: 'Cash floor holds', ok: c.ok,
    detail: c.ok ? `After the ${$(t.cash_up_front)} up front${t.financed ? ` and ${$(t.annual_payment)} a year of payments` : ''}, the tightest month-end from then on is ${L(c.month)}, ${$(c.value)} above the floor.`
      : `Cash falls ${$(-c.value)} below the floor in ${L(c.month)}.` });
  const rv = tst('reserve');
  conditions.push({ id: 'reserve', label: 'Reserve kept', ok: rv.ok,
    detail: rv.ok ? `${$(rv.value)} above the floor the month it's bought — at least the ${$(rv.need)} reserve.` : `Only ${$(rv.value)} above the floor the month it's bought, under the ${$(rv.need)} reserve.` });
  const cv = tst('coverage');
  conditions.push({ id: 'coverage', label: `Debt coverage ${base.dscr.threshold.toFixed(2)}× or more`, ok: cv.ok, na: !!cv.na,
    detail: cv.na ? (t.owner === 'personal' ? 'A personal purchase: the farm lender’s coverage test doesn’t apply.' : base.dscr.capacity == null ? 'Coverage could not be worked out (not enough farm history).' : 'No new farm debt.')
      : `${cv.value?.toFixed(2)}× with its ${$(t.annual_payment)} a year of payments${base.dscr.now != null ? ` (${Number(base.dscr.now).toFixed(2)}× today)` : ''}.` });
  const eq = tst('equity');
  conditions.push({ id: 'equity', label: `${EQUITY_MIN_PCT}% or more down`, ok: eq.ok, na: !!eq.na,
    detail: eq.na ? 'Paid in cash.' : `${Math.round(eq.value)}% of the deal is your own money${eq.ok ? '' : ` — lenders want ${EQUITY_MIN_PCT}–25%. Raise the down payment.`}` });

  // What's holding it: the tests that fail today, and when each would pass on its own.
  const holding = r.now.filter((x) => !x.ok).map((x) => {
    const when = r.first_ok[x.id];
    const name = { cash: 'the cash floor', reserve: 'the reserve', coverage: 'debt coverage', equity: 'the down payment' }[x.id];
    const today = x.id === 'cash' ? `${$(-x.value)} short of the floor` : x.id === 'reserve' ? (x.value < 0 ? `below the floor, with a ${$(x.need)} reserve to keep on top` : `${$(x.value)} above the floor of the ${$(x.need)} reserve`)
      : x.id === 'coverage' ? `${x.value?.toFixed(2)}× of ${Number(x.need).toFixed(2)}×` : `${Math.round(x.value)}% down of ${x.need}%`;
    const at = r.from ? `if bought in ${L(r.from)}, after the goal above it` : 'if bought today';
    return { id: x.id, text: `${name}: ${today} ${at}${when != null ? `; met from ${L(when)}` : '; not met within ten years'}` };
  });
  const i = r.month_index;
  const headline = i == null && r.after_unreached
    ? 'Waits on the goal above it, which isn’t reached within ten years. Plan it on its own, or move it up.'
    : i == null
    ? `Not within ten years as things stand. ${holding.map((h) => h.text).join('. ')}.`
    : i === 0
      ? `Can be bought now: every condition is met.`
      : `Can be bought in ${L(i)} — ${span(i)} from now — once ${holding.length ? holding.map((h) => ({ cash: 'cash covers the floor after it', reserve: 'the reserve is there on top', coverage: 'debt coverage reaches the lender’s 1.25×', equity: 'the down payment is 15%' }[h.id])).join(' and ') : 'the money is there'}.`;
  return { when: i == null ? null : L(i), months: i, wait: i == null ? null : span(i), headline, conditions, holding, terms: t };
}
