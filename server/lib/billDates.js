import { addMonths, toISODate } from './dates.js';

const BILL_STEP_MONTHS = { monthly: 1, quarterly: 3 };

/**
 * Dates an unpaid bill will be owed before `toExclusive`: the bill itself
 * (even if overdue — it still hasn't been paid) plus, for a recurring bill,
 * the later instances the app creates as each one is paid. Only one
 * instance of a recurring bill exists at a time, so without this a monthly
 * bill would count once in a 12-month forecast instead of every month.
 * Later instances are counted only from tomorrow on.
 */
export function billDates(bill, todayStr, toExclusive) {
  const first = toISODate(bill.due_date);
  const out = first < toExclusive ? [first] : [];
  const step = BILL_STEP_MONTHS[bill.frequency];
  if (!step || !out.length) return out;
  for (let k = 1; k < 600; k++) {
    const d = addMonths(first, k * step);
    if (d >= toExclusive) break;
    if (d > todayStr) out.push(d);
  }
  return out;
}

