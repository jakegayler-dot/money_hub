// Pure builder for the financial summary behind Sentinel's Money tile:
// figures Money Hub has already computed (liquidity forecast, term debt
// coverage, balance sheet) plus a few raw sums in, the tile's body out.
// No DB, no network, no clock except the `now` passed in. The loading side
// lives in sentinel.js (loadSummaryInputs).
//
// Every amount goes out as integer cents via toCents (no float drift). A
// figure that can't be computed honestly is null with a line in `notes`
// saying why; a figure that's an approximation also gets a line.

import { toCents, reginaToday } from './sentinelSnapshot.js';
import { ownerWeights } from './segments.js';
import { toISODate, addDays } from './dates.js';

export const FORECAST_DAYS = 90;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const cents = (v) => toCents(v ?? 0) ?? 0;
const pad = (n) => String(n).padStart(2, '0');
const monthEnd = (year, month) => `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Whole dollars for a one-line status: 124037 → "$1,240". */
export function fmtDollars(c) {
  const d = Math.round(Math.abs(c) / 100).toLocaleString('en-CA');
  return `${c < 0 ? '-' : ''}$${d}`;
}

const PERSONAL_SEGMENTS = new Set(['personal', 'jake', 'ashley']);
/** Fraction of a row owned by the farm business (not Jake/Ashley personally). */
export function businessShare(row = {}) {
  if (!row.is_segment_split && PERSONAL_SEGMENTS.has(row.segment)) return 0;
  const w = ownerWeights(row);
  return Math.max(0, 1 - w.jake - w.ashley);
}

// ---- Cash flow: actual transactions, last 30 days -------------------------
export function cashFlowSummary(cf = {}) {
  const inflow = Math.max(cents(cf.inflow), 0);
  const outflow = Math.abs(cents(cf.outflow)); // accepts either sign
  return { net_30d_cents: inflow - outflow, inflow_30d_cents: inflow, outflow_30d_cents: outflow };
}

// ---- 90-day forecast from liquidityFloor() ----------------------------------
/**
 * Money Hub's forecast is MONTHLY: a running end-of-month balance for the
 * next 12 months (the "with estimates" basis every Money Hub screen uses).
 * Points: today's cash, then each month-end after today, through the month
 * that contains day 90. The floor is the app's required floor (buffer % of
 * average monthly business outflow over the trailing 12 months).
 */
export function forecastSummary(liquidity, today) {
  const horizon = addDays(today, FORECAST_DAYS);
  const floor = cents(liquidity.requiredFloor);
  const points = [{ date: today, balance_cents: cents(liquidity.startingBalance) }];
  for (const m of liquidity.trajectory || []) {
    const start = `${m.year}-${pad(m.month)}-01`;
    const end = monthEnd(m.year, m.month);
    if (start > horizon) break;
    if (end <= today) continue;
    points.push({ date: end, balance_cents: cents(m.balance) });
  }
  const min = points.reduce((a, b) => (b.balance_cents < a.balance_cents ? b : a));
  const firstBreach = points.find((p) => p.balance_cents < floor) || null;
  const pct = round(Number(liquidity.bufferPct ?? 0.15) * 100, 2);
  return {
    forecast: {
      points,
      floor_cents: floor,
      floor_rule: `${pct}% buffer`,
      min_balance_cents: min.balance_cents,
      min_date: min.date,
      breaches_floor: !!firstBreach,
    },
    firstBreach,
  };
}

// ---- Equity (Combined: the whole household, both ledgers) -------------------
/**
 * Same valuation as Money Hub's dashboard net worth and the Combined
 * equity card: account balances + capital assets valued today + uncontracted
 * inventory − outstanding loan principal − credit card balances. An
 * overdrawn account counts as a liability rather than a negative asset.
 */
export function equitySummary(bal) {
  let assets = 0;
  let liabilities = 0;
  for (const a of bal.accounts || []) {
    const c = cents(a.balance);
    if (c >= 0) assets += c; else liabilities += -c;
  }
  for (const a of bal.assets || []) assets += cents(a.value_now);
  for (const i of bal.inventoryRows || []) assets += cents(i.counted_value);
  for (const l of bal.loans || []) liabilities += cents(l.outstanding);
  for (const c of bal.creditCards || []) liabilities += cents(c.outstanding);
  return { assets_cents: assets, liabilities_cents: liabilities, equity_cents: assets - liabilities };
}

/**
 * Farm-business assets only (for ROA): business accounts + business share of
 * assets and inventory. Inventory rows carry their owner already resolved
 * (inventoryOwnerRow in balanceSheet.js — the loader applies it).
 */
export function businessAssetsCents(bal) {
  let total = 0;
  for (const a of bal.accounts || []) if (a.ledger === 'business') total += Math.max(cents(a.balance), 0);
  for (const a of bal.assets || []) total += Math.round(cents(a.value_now) * businessShare(a));
  for (const i of bal.inventoryRows || []) total += Math.round(cents(i.counted_value) * businessShare(i));
  return total;
}

// ---- Overdue obligations ----------------------------------------------------
// One definition, used by the Money tile, the dashboard and the Bills page:
// unpaid bills past due, scheduled loan payments past due and not recorded,
// and each card's CURRENT statement past due with money still owing. Card
// statements are cumulative, so an older unpaid statement is superseded by
// the newer one (cardStatements here is already latest-per-card).
export function overdueSummary(o = {}, today) {
  const out = { count: 0, total_cents: 0, bills: 0, loan_payments: 0, card_statements: 0 };
  const due = (d) => { const s = toISODate(d); return s != null && s < today; };
  for (const b of o.bills || []) {
    if (b.status === 'paid' || !due(b.due_date)) continue;
    out.bills++; out.total_cents += cents(b.amount);
  }
  for (const p of o.loanPayments || []) {
    if (p.paid || p.is_adjustment || !due(p.due_date)) continue;
    out.loan_payments++; out.total_cents += cents(p.principal_amount) + cents(p.interest_amount);
  }
  for (const s of o.cardStatements || []) {
    if (!due(s.due_date) || cents(s.amount) <= 0) continue;
    out.card_statements++; out.total_cents += cents(s.amount);
  }
  out.count = out.bills + out.loan_payments + out.card_statements;
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** "7 bills, 9 loan payments and 2 card statements" — each kind named for what it is. */
export function overdueLabel(o) {
  const parts = [
    o.bills ? plural(o.bills, 'bill', 'bills') : null,
    o.loan_payments ? plural(o.loan_payments, 'loan payment', 'loan payments') : null,
    o.card_statements ? plural(o.card_statements, 'card statement', 'card statements') : null,
  ].filter(Boolean);
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * inputs: {
 *   cashFlow30:   { inflow, outflow, lastTxDate }          business, non-transfer lines, last 30 days
 *   liquidity:    liquidityFloor() result
 *   coverage:     termDebtCoverage() result
 *   balance:      { accounts:[{ledger,balance}], assets, inventoryRows, loans, creditCards, needsPrice }
 *   ytd:          { revenue, expenses }                     business operating lines, Jan 1 → today
 *   trailing12:   { revenue, expenses, interest, lineCount } business operating lines + scheduled interest
 *   overdue:      { bills, loanPayments, cardStatements }
 * }
 */
export function buildSummary(inputs, { now = new Date() } = {}) {
  const today = reginaToday(now);
  const notes = [];

  // Cash flow
  const cash_flow = cashFlowSummary(inputs.cashFlow30);
  const lastTx = toISODate(inputs.cashFlow30?.lastTxDate);
  if (!lastTx) notes.push('Cash flow: no business transactions recorded yet, so the 30-day figures are zero.');
  else if (lastTx <= addDays(today, -30)) {
    notes.push(`Cash flow: no business transactions in the last 30 days (latest is ${lastTx}), so the figures are zero — statements may not be imported yet.`);
  }

  // Forecast
  const { forecast: forecast_90d, firstBreach } = forecastSummary(inputs.liquidity, today);
  notes.push('Forecast: monthly resolution (Money Hub forecasts month-end balances, with estimates), so points are month-ends, not weeks.');
  if (forecast_90d.floor_cents === 0) {
    notes.push('Forecast floor is $0: no business outflows in the last 12 months to size the buffer from.');
  }

  // Equity
  const bal = inputs.balance || {};
  const eq = equitySummary(bal);
  const equity = { ...eq, trend_12m: [{ month: today.slice(0, 7), equity_cents: eq.equity_cents }] };
  notes.push('Equity trend: one point (this month) — Money Hub keeps only current asset values, no balance-sheet history to trend from.');
  if (bal.needsPrice > 0) {
    notes.push(`Equity: ${bal.needsPrice} inventory item${bal.needsPrice === 1 ? '' : 's'} have no price and count as $0.`);
  }

  // Operating margin YTD (business ledger, cash basis)
  const ytdRev = cents(inputs.ytd?.revenue);
  const ytdExp = Math.abs(cents(inputs.ytd?.expenses));
  const t12Rev = cents(inputs.trailing12?.revenue);
  let op_margin_ytd_pct = null;
  // On a cash basis a grain farm has almost no revenue until the crop is
  // sold, so an early-year margin is noise (e.g. −1,100%). Not meaningful
  // when YTD revenue is under 10% of the trailing 12 months', or |margin| > 100%.
  const margin = ytdRev > 0 ? ((ytdRev - ytdExp) / ytdRev) * 100 : null;
  if (margin != null && (ytdRev * 10 < t12Rev || Math.abs(margin) > 100)) {
    notes.push(`Operating margin: not meaningful yet — only ${fmtDollars(ytdRev)} of revenue so far this year (cash basis).`);
  } else if (margin != null) {
    op_margin_ytd_pct = round(margin, 1);
    notes.push('Operating margin: cash basis (receipts − operating expenses paid since Jan 1, business ledger; excludes capital purchases, debt service and transfers; no depreciation or inventory change).');
  } else {
    notes.push('Operating margin: null — no business revenue recorded since Jan 1.');
  }

  // DSCR: Money Hub's own projected term debt coverage (the gating figure).
  const cov = inputs.coverage || {};
  const proj = cov.projected || {};
  let dscr = null;
  if (proj.ratio != null && Number.isFinite(Number(proj.ratio))) {
    dscr = round(Number(proj.ratio), 2);
    notes.push('DSCR: Money Hub\'s projected term debt coverage (FFSC) for the NEXT 12 months — committed + estimated cash flow after owner draws and operating-line interest ÷ scheduled term principal + interest.');
  } else {
    notes.push('DSCR: null — no term-debt principal or interest is scheduled in the next 12 months, so there is nothing to cover.');
  }
  const dscr_threshold = Number(cov.threshold ?? 1.25);

  // ROA: trailing 12 months business net income ÷ business assets today.
  const t12 = inputs.trailing12 || {};
  const bizAssets = businessAssetsCents(bal);
  let roa_pct = null;
  if (!(Number(t12.lineCount) > 0)) {
    notes.push('ROA: null — no business transactions in the last 12 months to measure income from.');
  } else if (bizAssets <= 0) {
    notes.push('ROA: null — no business assets recorded.');
  } else {
    const netIncome = cents(t12.revenue) - Math.abs(cents(t12.expenses)) - Math.abs(cents(t12.interest));
    const roa = (netIncome / bizAssets) * 100;
    if (Math.abs(roa) > 100) {
      notes.push(`ROA: not meaningful — ${fmtDollars(netIncome)} trailing-12-month net income against only ${fmtDollars(bizAssets)} of recorded farm-business assets (assets likely incomplete).`);
    } else roa_pct = round(roa, 1);
    if (roa_pct != null) notes.push('ROA: trailing-12-month cash-basis net income (after scheduled loan interest, before depreciation and tax) ÷ farm-business assets today (not an average).');
  }

  // Status line: the most pressing issue first. Floor and coverage use the
  // same pass/fail tests as the Money Hub dashboard (unrounded), so the tile
  // never says all is well while the dashboard shows a problem.
  const liq = inputs.liquidity || {};
  const floorBreach12 = liq.passes === false || (liq.trajectory || []).some((m) => Number(m.balance) < Number(liq.requiredFloor))
    ? (liq.trajectory || []).find((m) => Number(m.balance) < Number(liq.requiredFloor)) || liq.floorMonth || null
    : null;
  const coverageFails = proj.passes === false
    || (proj.ratio != null && Number.isFinite(Number(proj.ratio)) && Number(proj.ratio) < dscr_threshold);
  const overdue = overdueSummary(inputs.overdue, today);
  let status_line = 'Nothing needs attention';
  if (overdue.count > 0) {
    status_line = `${overdueLabel(overdue)} overdue (${fmtDollars(overdue.total_cents)})`;
  } else if (floorBreach12) {
    // The Money Hub dashboard's own check: any month-end in its rolling
    // 12-month forecast below the required floor (liquidityFloor().passes).
    status_line = `Cash dips below the floor in ${MONTH_NAMES[floorBreach12.month - 1]} ${floorBreach12.year}`;
  } else if (firstBreach) {
    status_line = 'Cash is below the floor now'; // only today's balance can be below here
  } else if (coverageFails) {
    status_line = `Debt coverage ${dscr.toFixed(2)}× — below ${dscr_threshold}×`;
  } else if (eq.equity_cents < 0) {
    status_line = `Liabilities exceed assets by ${fmtDollars(-eq.equity_cents)}`;
  }

  return {
    generated_at: now.toISOString(),
    summary: {
      status_line,
      cash_flow,
      forecast_90d,
      equity,
      performance: { op_margin_ytd_pct, dscr, dscr_threshold, roa_pct },
      notes,
    },
  };
}
