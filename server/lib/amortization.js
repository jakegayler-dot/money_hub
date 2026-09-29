import { addMonths, addDays, yearsBetween, toISODate } from './dates.js';

const round2 = (n) => Math.round(n * 100) / 100;

export const FREQUENCIES = ['biweekly', 'monthly', 'quarterly', 'semiannual', 'annual'];
export const PERIODS_PER_YEAR = { biweekly: 26, monthly: 12, quarterly: 4, semiannual: 2, annual: 1 };
const MONTH_STEP = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

/**
 * Due date of payment number n counted from an anchor date. Biweekly steps
 * 14 days; everything else steps whole calendar months from the ANCHOR
 * (never chained), clamping to month end — so a loan paid on the 31st is
 * due on the 31st or the month's last day every time, never drifting.
 */
export function dueDateFor(anchor, frequency, n) {
  if (frequency === 'biweekly') return addDays(anchor, 14 * n);
  return addMonths(anchor, (MONTH_STEP[frequency] || 1) * n);
}

/** Number of payments to amortize over term_months at a frequency. */
export function periodsForTerm(termMonths, frequency) {
  return Math.max(1, Math.round((Number(termMonths) * PERIODS_PER_YEAR[frequency || 'monthly']) / 12));
}

/**
 * Builds a payment schedule from a balance.
 *   - Level payment (default): the standard annuity payment over `periods`.
 *   - Fixed payment (`payment` given): pays that amount each period until
 *     the balance is cleared — how lenders usually handle a variable-rate
 *     change (payment stays, payoff date moves).
 * Periodic rate = annual rate / payments per year.
 * `firstPeriodYears` (optional) charges the first payment's interest for
 * the actual time since the loan was advanced — e.g. an annual loan
 * advanced in March with its first payment on December 1 carries ~9
 * months of interest in that first payment, not a full year's.
 * The final payment absorbs rounding so the balance ends at exactly zero.
 */
export function buildSchedule({
  balance, ratePct, periods, anchor, anchorOffset = 1, frequency = 'monthly',
  payment = null, firstPeriodYears = null,
}) {
  const ppy = PERIODS_PER_YEAR[frequency] || 12;
  const annual = Number(ratePct) / 100;
  const r = annual / ppy;
  let bal = Number(balance);
  const rows = [];
  if (bal <= 0) return rows;

  const n = Math.max(1, Math.round(periods));
  let pay = payment != null ? Number(payment) : null;
  if (pay == null) {
    pay = r === 0 ? bal / n : (bal * r) / (1 - Math.pow(1 + r, -n));
  } else if (r > 0 && pay <= bal * r) {
    throw new Error(`A payment of ${round2(pay)} doesn't cover the ${frequency} interest of ${round2(bal * r)} — the balance would never go down.`);
  }

  for (let k = 0; k < 2000 && bal > 0.005; k++) {
    const interest = k === 0 && firstPeriodYears != null
      ? round2(bal * annual * Math.max(0, firstPeriodYears))
      : round2(bal * r);
    let principal = round2(pay - interest);
    if (principal >= bal || (payment == null && k === n - 1)) principal = round2(bal);
    if (principal < 0) principal = 0; // a long stub period can exceed one payment's interest
    bal = round2(bal - principal);
    rows.push({
      due_date: dueDateFor(anchor, frequency, anchorOffset + k),
      principal_amount: principal,
      interest_amount: interest,
    });
  }
  return rows;
}

/**
 * Schedule for a new (or re-termed) loan. With a first_payment_date, the
 * schedule is anchored there and the first payment's interest covers the
 * real time since start_date; otherwise the first payment is one period
 * after start_date.
 */
export function scheduleFromTerms({ principal, interest_rate_pct, term_months, start_date, payment_frequency, first_payment_date }) {
  const frequency = payment_frequency || 'monthly';
  const start = toISODate(start_date);
  const first = first_payment_date ? toISODate(first_payment_date) : null;
  return buildSchedule({
    balance: Number(principal),
    ratePct: Number(interest_rate_pct),
    periods: periodsForTerm(term_months, frequency),
    frequency,
    anchor: first || start,
    anchorOffset: first ? 0 : 1,
    firstPeriodYears: first ? Math.max(0, yearsBetween(start, first)) : null,
  });
}
