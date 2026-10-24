// A receipt's date, settled (Jake, 2026-10-24: half his grocery receipts
// came in with the wrong date). Till slips print dates every way — 24/10/26,
// 10/24/26, 26/10/24, 2026-10-24 — and a reader picking one ordering gets
// day and month (or year) backwards. So every way the printed date could be
// read is a candidate, and the evidence decides:
//   1. a bank or card entry for the receipt's total dated on that day or up
//      to six days after it (the money really left then) — strongest;
//   2. not after the day it was uploaded, and not more than three years
//      before;
//   3. the reader's own reading;
//   4. nearest the upload day.
import { pool } from '../db.js';
import { toISODate } from './dates.js';

const pad = (n) => String(n).padStart(2, '0');
const valid = (y, m, d) => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const year4 = (y) => (y < 100 ? 2000 + y : y);

/** Every date a printed string could be: "24/10/26" → 2026-10-24, 2026-24-10 (invalid), 2024-10-26, 2026-10-24… */
export function dateReadings(printed) {
  const s = String(printed || '');
  const out = new Set();
  const iso = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) {
    const [, y, a, b] = iso.map(Number);
    for (const v of [valid(y, a, b), valid(y, b, a)]) if (v) out.add(v);
  }
  const short = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (short && !iso) {
    const [, a, b, c] = short.map(Number);
    const y = year4(c);
    for (const v of [valid(y, b, a), valid(y, a, b)]) if (v) out.add(v); // D/M/Y, M/D/Y
    if (c <= 31 && String(short[3]).length === 2) {
      // Y/M/D and Y/D/M with a two-digit year first ("26/10/24").
      const yy = year4(a);
      for (const v of [valid(yy, b, c), valid(yy, c, b)]) if (v) out.add(v);
    }
  }
  // Month names ("OCT 24 2026", "24-OCT-26").
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = s.toLowerCase().match(/(\d{1,2})?\s*[-/ ]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*[-/ ]?\s*(\d{1,2})?[, ]*\s*[-/ ]?\s*(\d{2,4})?/);
  if (named) {
    const m = MONTHS.indexOf(named[2]) + 1;
    const d = Number(named[1] || named[3]);
    const y = named[4] ? year4(Number(named[4])) : null;
    if (y && d) { const v = valid(y, m, d); if (v) out.add(v); }
  }
  return [...out];
}

const days = (a, b) => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

/**
 * The receipt's date: the reader's date, unless another reading of the
 * printed date is better supported. Returns { date, changed, why }.
 */
export async function settleDate({ date, printed, total, uploaded }, db = pool) {
  const up = uploaded ? toISODate(uploaded) : toISODate(new Date());
  const cands = new Set(dateReadings(printed));
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    cands.add(date);
    // No printed text: the reader's date with day and month swapped is the usual mistake.
    if (!printed) { const [y, m, d] = date.split('-').map(Number); const v = valid(y, d, m); if (v) cands.add(v); }
  }
  const list = [...cands].filter((c) => days(c, up) <= 1 && days(up, c) <= 3 * 366);
  if (!list.length) return { date: date || null, changed: false, why: null };
  if (list.length === 1) return { date: list[0], changed: list[0] !== date, why: list[0] !== date ? 'the only reading of the printed date that isn\'t in the future' : null };
  const amt = Math.abs(Number(total) || 0);
  const scored = [];
  for (const c of list) {
    let score = 0;
    if (amt > 0) {
      const { rows } = await db.query(
        `SELECT 1 FROM transactions WHERE abs(abs(amount) - $1) < 0.01 AND date BETWEEN $2::date AND $2::date + 6 LIMIT 1`, [amt, c]);
        if (rows.length) score += 100;
    }
    if (c === date) score += 10;
    score -= Math.min(9, days(up, c) / 40); // nearer the upload day, a little better
    scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].c;
  return { date: best, changed: best !== date, matched: scored[0].score >= 90, why: best !== date ? 'a bank or card entry for the total matches that reading of the printed date' : null };
}

/**
 * Re-checks the dates of receipts already read (not ones fixed by hand):
 * where a bank or card entry for the total supports another reading of the
 * date and not the current one, the date moves, and its grocery lines with
 * it. Returns the receipts changed.
 */
export async function recheckReceiptDates(db = pool) {
  const { rows } = await db.query(
    `SELECT id, extracted, uploaded_at FROM receipts
     WHERE extracted IS NOT NULL AND COALESCE(extracted->>'date_set_by', '') <> 'hand' AND extracted->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$'`);
  const changed = [];
  for (const r of rows) {
    const ex = r.extracted;
    const s = await settleDate({ date: ex.date, printed: ex.date_printed, total: ex.total, uploaded: r.uploaded_at }, db);
    if (!s.changed || !s.matched) continue;
    await db.query('UPDATE receipts SET extracted = $2 WHERE id = $1', [r.id, { ...ex, date: s.date, date_read: ex.date_read || ex.date }]);
    await db.query('UPDATE grocery_items SET date = $2 WHERE receipt_id = $1', [r.id, s.date]);
    changed.push({ id: r.id, from: ex.date, to: s.date, party: ex.party || null });
  }
  return changed;
}
