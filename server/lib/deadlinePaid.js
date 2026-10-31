// Payment deadlines that are already paid (Jake, Oct 31: "why is sentinel saying to pay crop insurance when that
// bill has already been paid?").
//
// Some of the farm program dates in calendar_deadlines are payments — the SCIC crop premium, the RM's property
// taxes, the AgriStability fee, the AgriInvest deposit. Once a bill or a ledger payment matching one is found in
// that deadline's own season, the date is marked done and says when it was paid, so the calendar and Sentinel
// (which gets these items in its snapshot) stop telling him to pay it.
import { pool } from '../db.js';
import { addDays, toISODate } from './dates.js';

/**
 * Deadline key → what paying it looks like.
 *   text:     matched against the bill's name, the payee and the ledger description
 *   category: matched against the category's own name (the last part of "Parent › Child")
 *   window:   days before and after the deadline a payment counts for it (its season)
 */
export const PAYMENT_DEADLINES = {
  // Billed in summer, due Oct 31: a payment to SCIC from July on is this year's premium (spring SCIC payments are
  // the AgriStability fee or last year's).
  crop_premium: { text: /\bscic\b|sask\.?\s*crop|crop\s*insur/i, category: /crop insurance/i, window: [-120, 60] },
  // The RM's taxes for the year, paid once the notice is out (May on): a January payment is last year's arrears.
  property_tax: { text: /property tax|\brural municipality\b|\bR\.?\s?M\.? (of|no)\b/i, category: /^property tax/i, window: [-240, 45] },
  // The enrolment fee, Apr 30: named as AgriStability (crop premium payments go to SCIC too, so SCIC alone isn't it).
  agristability_enrol: { text: /agri-?stability/i, window: [-120, 45] },
  // The deposit into the AgriInvest account (money out to it, not the government's match coming back).
  agriinvest_deposit: { text: /agri-?invest/i, window: [-180, 60] },
};

const leaf = (c) => String(c || '').split('›').pop().trim();
const money = (n) => `$${Math.abs(Number(n)).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The deadline key in a calendar item id ("deadline:crop_premium:2026-10-31" → "crop_premium"). */
export function deadlineKey(item) {
  const m = /^deadline:(.+):(\d{4}-\d{2}-\d{2})$/.exec(String(item?.id || ''));
  return m ? m[1] : null;
}

/** Does this payment { date, amount, text, payee, category } pay deadline `key` falling on `date`? */
export function paysDeadline(key, date, p) {
  const rule = PAYMENT_DEADLINES[key];
  if (!rule || !p?.date) return false;
  const d = toISODate(p.date);
  if (d < addDays(date, rule.window[0]) || d > addDays(date, rule.window[1])) return false;
  if (!(Math.abs(Number(p.amount)) > 0)) return false;
  const text = [p.text, p.payee].filter(Boolean).join(' ');
  return rule.text.test(text) || (!!rule.category && rule.category.test(leaf(p.category)));
}

/**
 * Marks each payment deadline in `items` done when one of `payments` pays it: done, paid { date, amount, what },
 * the title says it's paid and the notes when. Returns the same list.
 */
export function markPaidDeadlines(items, payments) {
  for (const i of items) {
    const key = deadlineKey(i);
    if (!key || !PAYMENT_DEADLINES[key]) continue;
    const hits = payments.filter((p) => paysDeadline(key, i.date, p))
      .sort((a, b) => toISODate(b.date).localeCompare(toISODate(a.date)));
    if (!hits.length) continue;
    const p = hits[0];
    const when = toISODate(p.date);
    i.done = true;
    i.paid = { date: when, amount: Math.abs(Number(p.amount)), what: p.text || p.payee || null };
    if (!/— paid /.test(i.title)) i.title = `${i.title} — paid ${when}`;
    i.notes = [`Already paid: ${money(p.amount)} on ${when}${p.text ? ` (${p.text})` : ''}. Nothing to do.`, i.notes].filter(Boolean).join(' ');
  }
  return items;
}

/** Paid bills and ledger payments in [from, to], shaped for markPaidDeadlines. */
export async function loadPayments(from, to, db = pool) {
  const cat = (alias) => `(SELECT CASE WHEN pc.id IS NULL THEN c.name ELSE pc.name || ' › ' || c.name END
     FROM expense_categories c LEFT JOIN expense_categories pc ON pc.id = c.parent_id WHERE c.id = ${alias}.category_id)`;
  const [{ rows: bills }, { rows: txns }] = await Promise.all([
    db.query(
      `SELECT b.paid_date AS date, b.amount, b.name AS text, p.name AS payee, COALESCE(${cat('b')}, b.category) AS category
       FROM bills b LEFT JOIN payees p ON p.id = b.payee_id
       WHERE b.status = 'paid' AND b.paid_date BETWEEN $1 AND $2`, [from, to]),
    db.query(
      `SELECT t.date, t.amount, t.description AS text, p.name AS payee, ${cat('t')} AS category
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
       WHERE t.amount < 0 AND NOT COALESCE(t.is_transfer, false) AND t.date BETWEEN $1 AND $2`, [from, to]),
  ]);
  return [...bills, ...txns];
}

/** markPaidDeadlines over the payments in reach of `items`' payment deadlines. */
export async function applyPaidDeadlines(items, db = pool) {
  const due = items.filter((i) => PAYMENT_DEADLINES[deadlineKey(i)]);
  if (!due.length) return items;
  const dates = due.map((i) => i.date).sort();
  const from = addDays(dates[0], -365);
  const to = addDays(dates[dates.length - 1], 90);
  const payments = await loadPayments(from, to, db).catch(() => []);
  return markPaidDeadlines(items, payments);
}
