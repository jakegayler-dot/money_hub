// Can the farm afford it? The verdict on a what-if that buys something
// with new debt, judged the way a farm lender or money manager would:
//
//   cash      the lowest forecast month, after the deposit, the payments
//             and the GST coming back, against the required cash floor
//             (overdrawn = no; under the floor = tight)
//   coverage  term debt coverage (FFSC, next 12 months) with the new
//             loans' full annual payments added: at or over the lender's
//             threshold (1.25×) = yes, 1.00–threshold = tight, under 1 = no
//   equity    the buyer's own stake in each deal; lenders want 15–25%
//             down, under 15% is tight
//   reserve   the cash going out up front against what's deployable today
//             (cash − floor − reserve target); more than that eats the
//             reserve = tight
//   op line   when the what-if runs an operating line: borrowing more on it
//             to get through = tight
//
// Any "no" makes it not viable; any "tight" makes it viable but tight.

import { termDebtCoverage, coverageWithAddedDebt, reserveStatus } from './calculations.js';
import { loadForecast } from './forecast.js';
import { runScenario } from './scenario.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const $ = (v) => `${v < 0 ? '−' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-CA')}`;
const x2 = (v) => `${v.toFixed(2)}×`;
export const EQUITY_MIN_PCT = 15;

/** What the verdict needs beyond the scenario run. */
export async function verdictInputs(year) {
  const [coverage, reserve] = await Promise.all([termDebtCoverage(), reserveStatus(year)]);
  return { coverage, reserveTarget: reserve.target };
}

/**
 * result: runScenario output (with purchases and new_debt_annual).
 * inputs: { coverage, reserveTarget }.
 */
export function purchaseVerdict(result, { coverage, reserveTarget = 0 }) {
  const p = result.plan;
  const s = result.scenario;
  const floor = Number(result.floor) || 0; // what today's cash must cover
  const buys = result.purchases || [];
  const tests = [];

  // Cash floor: at the tightest month-end, does cash cover what must be
  // paid in the days after it (the new loan's payments included)?
  const low = { value: r2(s.low), month: s.low_month, before: r2(p.low), before_month: p.low_month,
    tight_month: s.tight_month, tight_balance: r2(s.tight), floor: r2(s.tight_floor), headroom: r2(s.tight_headroom), headroom_before: r2(p.tight_headroom) };
  if (s.low < 0) {
    tests.push({ id: 'cash', label: 'Cash floor', status: 'fail', ...low,
      detail: `Cash goes overdrawn: ${$(s.low)} in ${s.low_month}${p.low >= 0 ? ` (it was ${$(p.low)} without it)` : ''}.` });
  } else if (s.tight_headroom < 0) {
    tests.push({ id: 'cash', label: 'Cash floor', status: 'caution', ...low,
      detail: `At the end of ${s.tight_month} cash is ${$(s.tight)}, short of the ${$(s.tight_floor)} that falls due in the following weeks${p.tight_headroom < 0 ? ' (already short without the purchase)' : ''}.` });
  } else {
    tests.push({ id: 'cash', label: 'Cash floor', status: 'pass', ...low,
      detail: `Tightest month is ${s.tight_month}: ${$(s.tight)} covers the ${$(s.tight_floor)} falling due after it, with ${$(s.tight_headroom)} to spare.` });
  }

  // Term debt coverage with the new loans' annual payments.
  const added = result.new_debt_annual?.farm || 0;
  const threshold = Number(coverage?.threshold) || 1.25;
  const before = coverage?.projected?.ratio ?? null;
  const after = coverage ? coverageWithAddedDebt(coverage, added) : null;
  const cov = { value: after == null ? null : r2(after), before: before == null ? null : r2(before), threshold, added_annual_payments: r2(added) };
  if (!added) {
    tests.push({ id: 'coverage', label: 'Debt coverage', status: 'na', ...cov, detail: 'No new farm debt, so the lender’s coverage test doesn’t change.' });
  } else if (after == null) {
    tests.push({ id: 'coverage', label: 'Debt coverage', status: 'na', ...cov, detail: 'Coverage could not be worked out.' });
  } else {
    const st = after >= threshold ? 'pass' : after >= 1 ? 'caution' : 'fail';
    const why = st === 'pass' ? `at or over the ${x2(threshold)} lenders want`
      : st === 'caution' ? `under the ${x2(threshold)} lenders want, though the payments are covered`
        : 'the farm doesn’t earn enough to make its term payments';
    tests.push({ id: 'coverage', label: 'Debt coverage', status: st, ...cov,
      detail: `${x2(after)} with ${$(added)} a year of new payments${before != null ? ` (${x2(before)} now)` : ''} — ${why}.` });
  }

  // Equity in each deal.
  if (buys.length) {
    const thin = buys.filter((b) => b.equity_pct != null && b.equity_pct < EQUITY_MIN_PCT);
    const least = Math.min(...buys.map((b) => b.equity_pct ?? 100));
    tests.push({ id: 'equity', label: 'Money down', status: thin.length ? 'caution' : 'pass', value: r2(least), min: EQUITY_MIN_PCT,
      detail: thin.length
        ? `${thin.map((b) => `${b.label}: ${Math.round(b.equity_pct)}% down`).join('; ')} — most ag lenders want ${EQUITY_MIN_PCT}–25%.`
        : `${Math.round(least)}% down${buys.length > 1 ? ' or more on each' : ''} — within what lenders ask.` });
  }

  // Cash up front vs what's deployable today.
  const upFront = r2(buys.reduce((t, b) => t + b.cash_up_front, 0));
  if (upFront > 0) {
    const cashToday = Number(p.trajectory?.opening) || 0;
    const deployable = r2(cashToday - floor - reserveTarget);
    tests.push({ id: 'reserve', label: 'Cash up front', status: upFront <= deployable ? 'pass' : 'caution', value: upFront, deployable,
      detail: upFront <= deployable
        ? `${$(upFront)} up front, out of ${$(deployable)} free after the floor and reserve.`
        : `${$(upFront)} up front is more than the ${$(Math.max(0, deployable))} free after the floor and ${$(reserveTarget)} reserve — it comes out of the reserve.` });
  }

  // Operating line.
  if (s.op_peak > (p.op_peak || 0) + 1) {
    tests.push({ id: 'opline', label: 'Operating line', status: 'caution', value: r2(s.op_peak),
      detail: `Leans on the operating line: ${$(s.op_peak)} at the peak, ${$(s.op_interest)} interest.` });
  }

  const verdict = tests.some((t) => t.status === 'fail') ? 'not_viable' : tests.some((t) => t.status === 'caution') ? 'tight' : 'viable';
  const worst = tests.filter((t) => t.status === (verdict === 'not_viable' ? 'fail' : 'caution'));
  const headline = verdict === 'viable'
    ? `Viable. ${tests.filter((t) => t.status === 'pass').slice(0, 2).map((t) => t.detail).join(' ')}`
    : `${verdict === 'not_viable' ? 'Not viable' : 'Viable but tight'}. ${worst.map((t) => t.detail).join(' ')}`;
  return {
    verdict, label: verdict === 'viable' ? 'Viable' : verdict === 'tight' ? 'Viable but tight' : 'Not viable',
    headline, tests,
    figures: {
      cash_up_front: upFront,
      annual_payments: r2((result.new_debt_annual?.farm || 0) + (result.new_debt_annual?.personal || 0)),
      lowest_month: low, end_change: r2(s.end - p.end),
      tax_change_y0: s.tax_y0 != null && p.tax_y0 != null ? r2(s.tax_y0 - p.tax_y0) : null,
      tax_change_y1: s.tax_y1 != null && p.tax_y1 != null ? r2(s.tax_y1 - p.tax_y1) : null,
    },
  };
}

/** Whether a scenario carries anything the verdict judges. */
export const needsVerdict = (sc = {}) => (sc.purchases || []).some((x) => Number(x.price) > 0) || (sc.loans_new || []).some((l) => Number(l.amount) > 0);

/**
 * Runs a scenario against the live forecast and judges it. opts: { months,
 * scope, accounts, includeTax }. The same run the Cash Flow what-if uses.
 */
export async function runAndJudge(scenario, opts = {}) {
  const ctx = await loadForecast({ months: opts.months || 12 });
  const result = runScenario(ctx, scenario || {}, opts);
  if (needsVerdict(scenario)) result.verdict = purchaseVerdict(result, await verdictInputs(ctx.win.y0));
  return result;
}

// ---- For Sentinel and other agents ------------------------------------------------

/** The purchase fields an agent can send, with what each means. */
export const PURCHASE_FIELDS = {
  label: 'what it is, e.g. "JD S780 combine"',
  price: 'purchase price before taxes (required)',
  trade_in: 'trade-in value, taken off the price before taxes',
  deposit: 'cash down payment',
  fees: 'documentation or other fees paid in cash',
  gst_pct: 'GST %, default 5',
  pst_pct: 'PST %, default 0 (Saskatchewan farm machinery is exempt; 6 for trucks, vehicles and most other goods)',
  taxes: '"financed" (default: GST and PST go on the loan) or "cash" (paid with the deposit)',
  rate: 'loan interest rate %',
  years: 'loan term in years, default 5',
  per_year: 'payments a year: 1 (default), 2, 4 or 12',
  month: 'month bought, YYYY-MM (default this month)',
  first_month: 'first payment, YYYY-MM (default one payment period after buying)',
  owner: '"farm" (default) or "personal"',
  cca_rate: 'CCA rate %: 20 machinery (default), 30 trucks, 10 frame buildings and bins, 4 buildings, 0 land',
};
const PCT_FIELDS = ['gst_pct', 'pst_pct', 'rate', 'cca_rate'];

/** Validates an agent's purchase; returns { purchase } or { error }. */
export function purchaseFromInput(src = {}) {
  const out = {};
  const bad = (m) => ({ error: m });
  const numIn = (k) => {
    if (src[k] === undefined || src[k] === null || src[k] === '') return undefined;
    const v = Number(String(src[k]).replace(/[$,%\s]/g, ''));
    return Number.isFinite(v) ? v : NaN;
  };
  for (const k of ['price', 'trade_in', 'deposit', 'fees', 'gst_pct', 'pst_pct', 'rate', 'years', 'cca_rate']) {
    const v = numIn(k);
    if (v === undefined) continue;
    if (Number.isNaN(v) || v < 0) return bad(`"${k}" must be a number, zero or more.`);
    if (PCT_FIELDS.includes(k) && v > 100) return bad(`"${k}" is a percent (0–100).`);
    out[k] = v;
  }
  if (!(out.price > 0)) return bad('"price" is required: the purchase price before taxes.');
  if (out.years !== undefined && (out.years < 0.5 || out.years > 40)) return bad('"years" must be between 0.5 and 40.');
  if (src.per_year !== undefined && src.per_year !== '') {
    const p = Number(src.per_year);
    if (![1, 2, 4, 12].includes(p)) return bad('"per_year" must be 1, 2, 4 or 12.');
    out.per_year = p;
  }
  for (const k of ['month', 'first_month']) {
    if (src[k] === undefined || src[k] === '') continue;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(src[k]))) return bad(`"${k}" must be a month, YYYY-MM.`);
    out[k] = String(src[k]);
  }
  if (src.taxes !== undefined && src.taxes !== '') {
    if (!['financed', 'cash'].includes(String(src.taxes))) return bad('"taxes" must be "financed" or "cash".');
    out.taxes = String(src.taxes);
  }
  if (src.owner !== undefined && src.owner !== '') {
    if (!['farm', 'personal'].includes(String(src.owner))) return bad('"owner" must be "farm" or "personal".');
    out.owner = String(src.owner);
  }
  if (src.label) out.label = String(src.label).trim().slice(0, 120);
  if (out.rate === undefined) out.rate = 0;
  return { purchase: out };
}

/** A compact answer for an agent: the verdict, the deal, and month-by-month cash with and without it. */
export function agentAnswer(result) {
  const v = result.verdict;
  const buy = (result.purchases || [])[0] || null;
  const plan = result.plan.trajectory.months;
  const scn = result.scenario.trajectory.months;
  return {
    verdict: v?.verdict ?? null,
    verdict_label: v?.label ?? null,
    headline: v?.headline ?? null,
    tests: v?.tests ?? [],
    purchase: buy,
    cash: {
      window: `${result.window.start} – ${result.window.end}`, scope: result.scope, required_floor: result.floor,
      lowest_without: { balance: result.plan.low, month: result.plan.low_month },
      lowest_with: { balance: result.scenario.low, month: result.scenario.low_month },
      end_without: result.plan.end, end_with: result.scenario.end,
      months_below_floor_with: result.scenario.months_below_floor,
    },
    tax: result.tax_available ? {
      [`change_${result.window.y0}`]: v?.figures.tax_change_y0 ?? null, [`change_${result.window.y0 + 1}`]: v?.figures.tax_change_y1 ?? null,
    } : null,
    months: scn.map((m, i) => ({
      month: `${m.year}-${String(m.month).padStart(2, '0')}`, balance_without: plan[i]?.balance ?? null, balance_with: m.balance,
    })),
    currency: 'CAD',
  };
}
