// Rent is a yearly obligation (Jake, Oct 30: "the 24 month cash flow doesn't account for rent obligations, e.g.
// December rents to Dancey, spring rents to Fennell"). Rent bills are entered one payment at a time, so the forecast
// had each landlord's next payment and nothing after it. Every rent bill from the last two years (paid or not) comes
// round again a year later, and the year after, at the same amount and on the same day, unless that landlord already
// has a bill of the same kind (land, pasture, bales) within two months of it. Committed, not an estimate: a lease is.
import { addMonths, toISODate } from './dates.js';

export const RENT_SQL = `SELECT b.*, p.name AS vendor FROM bills b LEFT JOIN payees p ON p.id = b.payee_id
  WHERE b.frequency = 'one_time' AND b.due_date > (now() - interval '25 months')
    AND (COALESCE(b.category, '') ~* '\\mrent\\M' OR b.name ~* '\\mrent\\M')`;
const WINDOW_DAYS = 60;
const days = (a, b) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400e3;
const kindOf = (b) => (/pasture/i.test(b.name || '') ? 'pasture' : /bale/i.test(b.name || '') ? 'bales' : 'land');
const landlordOf = (b) => String(b.vendor || b.payee_id || b.name || '').trim().toLowerCase();

/** The rent payments still to come that no bill covers yet: [{ bill, date }]. Pure. */
export function projectRent(rentBills, today, endStr) {
  const rows = rentBills.map((b) => ({ b, key: `${landlordOf(b)}|${kindOf(b)}`, due: toISODate(b.due_date) }));
  const taken = new Map(); // key → dates already covered (real bills, then projections)
  for (const r of rows) taken.set(r.key, [...(taken.get(r.key) || []), r.due]);
  const out = [];
  for (const r of rows.sort((a, b) => (a.due < b.due ? -1 : 1))) {
    for (let k = 1; k <= 3; k++) {
      const d = addMonths(r.due, 12 * k);
      if (d >= endStr) break;
      if (d < today) continue;
      const near = (taken.get(r.key) || []).some((x) => days(x, d) <= WINDOW_DAYS);
      if (near) continue;
      out.push({ bill: r.b, date: d });
      taken.set(r.key, [...(taken.get(r.key) || []), d]);
    }
  }
  return out;
}
