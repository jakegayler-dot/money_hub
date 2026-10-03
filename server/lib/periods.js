// Month-end close: the guard every money path calls before it changes a
// transaction. A month is closed once its books have been checked against
// the bank; after that nothing dated in it may change until it's reopened
// on the Books tab.
import { toISODate } from './dates.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const monthKey = (date) => `${toISODate(date).slice(0, 7)}-01`;
export const monthLabel = (date) => {
  const [y, m] = toISODate(date).split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

class ClosedPeriodError extends Error {
  constructor(message) { super(message); this.status = 409; }
}

/** The closed month among `dates`, or null. */
export async function closedMonth(db, ...dates) {
  const keys = [...new Set(dates.filter(Boolean).map(monthKey))];
  if (!keys.length) return null;
  const { rows } = await db.query('SELECT month FROM closed_periods WHERE month = ANY($1::date[]) ORDER BY month LIMIT 1', [keys]);
  return rows[0] ? rows[0].month : null;
}

/** Throws (409) if any of `dates` falls in a closed month. */
export async function assertOpen(db, ...dates) {
  const m = await closedMonth(db, ...dates);
  if (m) throw new ClosedPeriodError(`${monthLabel(m)} is closed — reopen it on the Books tab to change anything dated in it.`);
}

/**
 * Re-setting an account's or card's balance shifts every past balance with
 * it, so it's refused while any month from `fromDate` on is closed.
 */
export async function assertNoClosedFrom(db, fromDate, what) {
  const { rows } = await db.query(
    'SELECT month FROM closed_periods WHERE month >= $1::date ORDER BY month DESC LIMIT 1',
    [fromDate ? monthKey(fromDate) : '0001-01-01']
  );
  if (rows.length) {
    throw new ClosedPeriodError(`${monthLabel(rows[0].month)} is closed, and changing ${what} would change its balances. Reopen it on the Books tab first.`);
  }
}

// Entries Money Hub made on your word (a bill marked paid, a payment
// recorded by hand, an entry typed into an account that gets statements)
// carry awaiting_statement until a statement line claims them.
// CONFIRMED_SQL is "not waiting on a statement".
export const CONFIRMED_SQL = (t = 't') => `(NOT ${t}.awaiting_statement)`;

// Still waiting, and a statement for the same account (or card, for a card
// purchase) covers its date and runs at least a week past it: that
// statement came in without it. Coverage is the import's period, or the
// span of its lines when the agent didn't send one. The week is the same
// slack the matcher allows between a typed date and the bank's date.
export const PASSED_SQL = (t = 't') => `(${t}.awaiting_statement AND EXISTS (
  SELECT 1 FROM statement_imports si
  JOIN LATERAL (SELECT MIN(date) AS lo, MAX(date) AS hi FROM statement_lines WHERE import_id = si.id) sp ON true
  WHERE (CASE WHEN ${t}.account_id IS NOT NULL THEN si.account_id = ${t}.account_id
              ELSE si.credit_card_id = ${t}.credit_card_id END)
    AND COALESCE(si.period_start, sp.lo) <= ${t}.date
    AND COALESCE(si.period_end, sp.hi) >= ${t}.date + 7))`;
