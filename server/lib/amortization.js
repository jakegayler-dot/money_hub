import { addMonths } from './dates.js';

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Builds a monthly schedule from a balance.
 *   - Level payment (default): the standard annuity payment over `months`.
 *   - Fixed payment (`payment` given): pays that amount until the balance
 *     is cleared — how lenders commonly handle a variable-rate change
 *     (payment stays, amortization stretches or shrinks).
 * Dates are anchored to the loan start (see dueFor below), so a loan paid
 * on the 31st lands on the last day of short months instead of drifting.
 * The final payment absorbs rounding so the balance ends at exactly zero.
 */
export function buildSchedule({ balance, ratePct, months, anchor, anchorOffset = 1, payment = null }) {
  // Payment k is due addMonths(anchor, anchorOffset + k). The anchor is
  // the loan's own start date, so a loan started on the 31st is due on the
  // 31st (or the month's last day) every month — never re-anchored to a
  // clamped short-month date, which would drag the day down permanently.
  const dueFor = (k) => addMonths(anchor, anchorOffset + k);
  const r = Number(ratePct) / 100 / 12;
  let bal = Number(balance);
  const rows = [];
  if (bal <= 0) return rows;

  let pay = payment != null ? Number(payment) : null;
  if (pay == null) {
    const n = Math.max(1, Math.round(months));
    pay = r === 0 ? bal / n : (bal * r) / (1 - Math.pow(1 + r, -n));
  } else if (r > 0 && pay <= bal * r) {
    throw new Error(`A payment of ${round2(pay)} doesn't cover the monthly interest of ${round2(bal * r)} — the balance would never go down.`);
  }

  for (let k = 0; k < 1200 && bal > 0.005; k++) {
    const interest = round2(bal * r);
    let principal = round2(pay - interest);
    if (principal >= bal || (payment == null && k === Math.round(months) - 1)) principal = round2(bal);
    bal = round2(bal - principal);
    rows.push({ due_date: dueFor(k), principal_amount: principal, interest_amount: interest });
  }
  return rows;
}

/** Remaining months for a fixed payment at a rate (for display). */
export function monthsToPayOff(balance, ratePct, payment) {
  const r = Number(ratePct) / 100 / 12;
  if (payment <= 0) return Infinity;
  if (r === 0) return Math.ceil(balance / payment);
  if (payment <= balance * r) return Infinity;
  return Math.ceil(-Math.log(1 - (r * balance) / payment) / Math.log(1 + r));
}
