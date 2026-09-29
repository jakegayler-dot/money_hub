// Calendar-date helpers that never touch time zones: every date is a plain
// 'YYYY-MM-DD' string in and out. node-pg returns DATE columns as local-
// midnight Date objects, so Dates are read with LOCAL getters (which is the
// calendar date that was stored); strings are split directly.

const pad = (n) => String(n).padStart(2, '0');

export function toISODate(d) {
  if (d == null) return null;
  if (d instanceof Date) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return String(d).slice(0, 10);
}

export function todayISO() {
  return toISODate(new Date());
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

/**
 * Adds calendar months, clamping to the end of the target month:
 * Jan 31 + 1 month = Feb 28 (not Mar 3). Always compute each schedule date
 * from the anchor date — addMonths(start, k) — never by chaining, or a
 * 31st-of-the-month schedule would drift to the 28th after February.
 */
export function addMonths(d, n) {
  const [y, m, day] = toISODate(d).split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(day, daysInMonth(ny, nm)))}`;
}

export function addDays(d, n) {
  const [y, m, day] = toISODate(d).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, day + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Fractional years between two dates (negative if b is before a). */
export function yearsBetween(a, b) {
  const [y1, m1, d1] = toISODate(a).split('-').map(Number);
  const [y2, m2, d2] = toISODate(b).split('-').map(Number);
  return (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / (365.25 * 86400000);
}

/** Month index of a date relative to an anchor month (0 = anchor's month). */
export function monthIndex(d, anchorYear, anchorMonth0) {
  const [y, m] = toISODate(d).split('-').map(Number);
  return (y - anchorYear) * 12 + (m - 1 - anchorMonth0);
}
