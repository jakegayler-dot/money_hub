import { pool } from '../db.js';
import { addMonths, toISODate } from './dates.js';

const STEP_MONTHS = { monthly: 1, quarterly: 3, annual: 12 };

/**
 * Dates on which an estimate occurs within [fromISO, toISOExclusive).
 * Occurrences before fromISO (normally today) are dropped on purpose: an
 * estimate whose date passed without the money moving is stale, not an
 * obligation — unlike an overdue bill, nobody is owed it.
 */
export function occurrences(est, fromISO, toISOExclusive) {
  const start = toISODate(est.start_date);
  const end = est.end_date ? toISODate(est.end_date) : null;
  const step = STEP_MONTHS[est.frequency];
  const out = [];
  if (!step) {
    if (start >= fromISO && start < toISOExclusive) out.push(start);
    return out;
  }
  for (let k = 0; k < 1200; k++) {
    const d = addMonths(start, k * step);
    if (d >= toISOExclusive || (end && d > end)) break;
    if (d >= fromISO) out.push(d);
  }
  return out;
}

/** Signed amount of one occurrence: + for inflow, − for outflow. */
export const signedAmount = (est) => (est.direction === 'inflow' ? 1 : -1) * Number(est.amount);

export async function activeEstimates() {
  const { rows } = await pool.query(`SELECT * FROM cash_estimates WHERE status = 'active'`);
  return rows;
}
