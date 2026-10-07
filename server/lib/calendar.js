// The money calendar: everything with a date on it, in one list.
//
//   bills, recurring bills, loan payments, card statements, contract
//   payments  — from their own tables (already sent to Sentinel)
//   tax       — CRA: the Dec 31 farm instalment, the Apr 30 balance and the
//               Jun 15 filing deadline, with the amounts from the Tax tab
//   gst       — each GST return's due date, from the filing frequency set
//               on the Tax tab, with the refund or payment
//   deadlines — farm program dates (SCIC, AgriStability, AgriInvest, LPI),
//               year-end and anything added by hand: stored once as a
//               month and day (or "2nd Thursday of June") and repeated
//               every year, so a date that moves is fixed in one place
//
// Recurring payments are also LEARNED from the ledger: a payee paid on a
// steady cycle is suggested as a recurring bill, which once confirmed
// lands here, in Cash Flow, and in bill matching like any other bill.
import { pool, getSetting } from '../db.js';
import { toISODate, todayISO, addMonths, addDays } from './dates.js';
import { billDates } from './billDates.js';
import { LATEST_STATEMENTS_SQL } from './cardLedger.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayNum = (d) => { const [y, m, dd] = toISODate(d).split('-').map(Number); return Date.UTC(y, m - 1, dd) / 86400000; };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORD = ['', '1st', '2nd', '3rd', '4th', 'last'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The date a deadline falls on in `year`: a fixed day (clamped to month end) or the nth weekday. */
export function deadlineDate(d, year) {
  const m = Number(d.month);
  if (d.weekday != null && d.nth != null) {
    if (Number(d.nth) === 5) { // last
      for (let day = lastDay(year, m); day > 0; day--) if (new Date(Date.UTC(year, m - 1, day)).getUTCDay() === Number(d.weekday)) return `${year}-${pad(m)}-${pad(day)}`;
    }
    let count = 0;
    for (let day = 1; day <= lastDay(year, m); day++) {
      if (new Date(Date.UTC(year, m - 1, day)).getUTCDay() === Number(d.weekday) && ++count === Number(d.nth)) return `${year}-${pad(m)}-${pad(day)}`;
    }
  }
  return `${year}-${pad(m)}-${pad(Math.min(Number(d.day) || 1, lastDay(year, m)))}`;
}

/** "Jun 30", "2nd Thursday of June". */
export const describeRule = (d) => (d.weekday != null && d.nth != null
  ? `${ORD[d.nth]} ${DAYS[d.weekday]} of ${MONTHS[d.month - 1]}`
  : `${MONTHS[d.month - 1]} ${d.day}`);

const fill = (s, year) => String(s || '').replaceAll('{year}', String(year)).replaceAll('{prev}', String(year - 1)).replaceAll('{next}', String(year + 1));

/** Program and year-end deadlines in [from, to]. */
export async function deadlineItems(from, to, db = pool) {
  const { rows } = await db.query('SELECT * FROM calendar_deadlines WHERE enabled ORDER BY month, day, id');
  const out = [];
  const y0 = Number(from.slice(0, 4));
  const y1 = Number(to.slice(0, 4));
  for (const d of rows) {
    for (let y = y0; y <= y1; y++) {
      const date = deadlineDate(d, y);
      if (date < from || date > to) continue;
      out.push({
        id: `deadline:${d.key}:${date}`, date, kind: d.kind || 'program', title: fill(d.title, y),
        notes: fill(d.notes, y) || null, url: d.url || null, deadline_id: d.id, rule: describeRule(d), amount: null,
      });
    }
  }
  return out;
}

/** CRA income tax dates for the years around [from, to], with amounts from the Tax tab. */
export async function taxItems(from, to) {
  const { farmIncomeTax } = await import('./tax.js');
  const out = [];
  const y0 = Number(from.slice(0, 4)) - 1;
  const y1 = Number(to.slice(0, 4));
  for (let y = y0; y <= y1; y++) {
    const dates = { inst: `${y}-12-31`, bal: `${y + 1}-04-30`, file: `${y + 1}-06-15` };
    if (![dates.inst, dates.bal, dates.file].some((d) => d >= from && d <= to)) continue;
    const t = await farmIncomeTax(y).catch(() => null);
    const basis = t ? (t.scenario || t.projected) : null;
    const total = basis ? Number(basis.tax.total) : null;
    const paid = await getSetting(`tax_instalment_paid_${y}`, null);
    const inst = t?.instalment;
    if (dates.inst >= from && dates.inst <= to && inst?.required) {
      out.push({ id: `tax:inst:${y}`, date: dates.inst, kind: 'tax', title: `Farm income tax instalment for ${y} (CRA)`,
        amount: -r2(paid?.amount ?? inst.amount), done: !!paid, notes: 'Two-thirds of the estimated tax, or of last year\'s — whichever is less. On the Tax tab.', link: '/tax' });
    }
    if (dates.bal >= from && dates.bal <= to && total != null) {
      const owing = Math.max(0, total - Number(paid?.amount ?? (inst?.required ? inst.amount : 0)));
      out.push({ id: `tax:bal:${y}`, date: dates.bal, kind: 'tax', title: `${y} income tax balance due (CRA)`,
        amount: owing > 0.5 ? -r2(owing) : null, notes: 'Interest runs from today on anything unpaid, even though the return isn\'t due until June 15.', link: '/tax' });
    }
    if (dates.file >= from && dates.file <= to) {
      out.push({ id: `tax:file:${y}`, date: dates.file, kind: 'tax', title: `File the ${y} T1 return (self-employed farm)`, amount: null,
        notes: 'Your T1 and the farm statement (T2042). AgriStability and AgriInvest forms are due with it in Saskatchewan — see Jun 30.', link: '/tax' });
    }
  }
  return out;
}

/** GST returns due in [from, to], with the expected refund (+) or payment (−). */
export async function gstItems(from, to) {
  const { gstReport } = await import('./tax.js');
  const out = [];
  for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)); y++) {
    const rep = await gstReport(y).catch(() => null);
    for (const p of rep?.periods || []) {
      if (p.due < from || p.due > to) continue;
      const done = ['filed', 'settled'].includes(p.status);
      const net = p.filed_net ?? p.net;
      out.push({
        id: `gst:${p.start}`, date: p.due, kind: 'gst', title: `GST return — ${p.label}${done ? ' (filed)' : ''}`,
        amount: net == null || Math.abs(net) < 0.5 ? null : -r2(net), done,
        notes: net < 0 ? 'A refund — file to get it.' : 'A payment to CRA.', link: '/tax',
      });
    }
  }
  return out;
}

/** Everything on the money calendar from `from` to `to` (inclusive), soonest first. */
export async function calendarItems({ from, to, today = todayISO() }) {
  const toExcl = addDays(to, 1);
  const [{ rows: bills }, { rows: pays }, { rows: cards }, { rows: contracts }, { rows: loans }, deadlines, tax, gst] = await Promise.all([
    pool.query(`SELECT b.*, p.name AS vendor FROM bills b LEFT JOIN payees p ON p.id = b.payee_id WHERE b.status = 'unpaid'`),
    pool.query(`SELECT lp.*, COALESCE(NULLIF(l.name, ''), l.lender) AS loan FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
                WHERE NOT lp.paid AND NOT lp.is_adjustment AND lp.due_date <= $1`, [to]),
    pool.query(`SELECT s.*, cc.name AS card, GREATEST(s.statement_balance - COALESCE(s.paid_amount, 0), 0) AS owing
                FROM (${LATEST_STATEMENTS_SQL}) s JOIN credit_cards cc ON cc.id = s.credit_card_id WHERE NOT s.paid AND cc.status = 'active'`),
    pool.query(`SELECT * FROM sale_contracts WHERE status IN ('open', 'delivered') AND expected_payment_date IS NOT NULL`),
    pool.query(`SELECT id, COALESCE(NULLIF(name, ''), lender) AS name, covenant_date, covenant_notes FROM loans WHERE covenant_date IS NOT NULL`),
    deadlineItems(from, to), taxItems(from, to), gstItems(from, to),
  ]);
  const items = [...deadlines, ...tax, ...gst];
  for (const b of bills) {
    // Overdue ones show on today; a recurring one also shows its next cycles.
    for (const d of billDates(b, today, toExcl)) {
      const date = d < today ? today : d;
      if (date < from || date > to) continue;
      items.push({ id: `bill:${b.id}:${d}`, date, kind: 'bill', title: b.vendor && !b.name.includes(b.vendor) ? `${b.vendor} — ${b.name}` : b.name,
        amount: -r2(b.amount), overdue: d < today, due: d, recurring: b.frequency !== 'one_time', link: '/bills' });
    }
  }
  for (const p of pays) {
    const d = toISODate(p.due_date);
    const date = d < today ? today : d;
    if (date < from) continue;
    items.push({ id: `loan:${p.id}`, date, kind: 'loan', title: `Loan payment — ${p.loan}`, amount: -r2(Number(p.principal_amount) + Number(p.interest_amount)),
      overdue: d < today, due: d, link: '/loans' });
  }
  for (const c of cards) {
    const d = toISODate(c.due_date);
    const date = d < today ? today : d;
    if (date < from || date > to || Number(c.owing) < 0.5) continue;
    items.push({ id: `card:${c.id}`, date, kind: 'card', title: `${c.card} statement`, amount: -r2(c.owing), overdue: d < today, due: d, link: '/credit-cards' });
  }
  for (const c of contracts) {
    const d = toISODate(c.expected_payment_date);
    const left = Number(c.total_value) - Number(c.received_amount || 0);
    if (d < from || d > to || left < 0.5) continue;
    items.push({ id: `contract:${c.id}`, date: d, kind: 'contract', title: `${c.commodity}${c.counterparty ? ` — ${c.counterparty}` : ''} payment expected`, amount: r2(left), link: '/contracts' });
  }
  for (const l of loans) {
    const d = toISODate(l.covenant_date);
    if (d < from || d > to) continue;
    items.push({ id: `covenant:${l.id}`, date: d, kind: 'program', title: `Loan covenant / review — ${l.name}`, notes: l.covenant_notes || null, link: '/loans' });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || String(a.kind).localeCompare(String(b.kind)) || a.title.localeCompare(b.title));
}

// ---- Learning recurring payments from the ledger -----------------------------

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const CYCLES = [
  { frequency: 'monthly', days: 30.4, min: 25, max: 36, need: 3, months: 1 },
  { frequency: 'quarterly', days: 91, min: 80, max: 102, need: 3, months: 3 },
  { frequency: 'annual', days: 365, min: 340, max: 390, need: 2, months: 12 },
];

/**
 * Payees paid on a steady cycle in the last two years that don't already
 * have a recurring bill: { key, payee_id, name, frequency, amount (typical),
 * low, high, next_date, day, count, last_date, category_id, owner }.
 * A cycle counts when most gaps between payments sit inside it and there
 * are enough payments to show it (3 monthly or quarterly, 2 yearly).
 */
export async function recurringSuggestions(today = todayISO()) {
  const { rows } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.payee_id, p.name AS payee, t.category_id, t.segment, t.is_segment_split,
            t.segment_grain_pct, t.segment_livestock_pct, t.segment_jake_pct, t.segment_ashley_pct, t.ledger
     FROM transactions t JOIN payees p ON p.id = t.payee_id
     WHERE t.amount < 0 AND NOT t.is_transfer AND NOT t.is_debt_service
       AND NOT (t.account_id IS NOT NULL AND t.credit_card_id IS NOT NULL)
       AND t.date >= $1::date - 730
       AND NOT EXISTS (SELECT 1 FROM loan_payments x WHERE x.linked_transaction_id = t.id)
     ORDER BY t.payee_id, t.date`, [today]);
  const { rows: have } = await pool.query(`SELECT DISTINCT payee_id FROM bills WHERE frequency <> 'one_time' AND payee_id IS NOT NULL`);
  const { rows: dismissed } = await pool.query('SELECT payee_id FROM recurring_dismissals');
  const skip = new Set([...have.map((h) => h.payee_id), ...dismissed.map((d) => d.payee_id)]);
  const byPayee = new Map();
  for (const r of rows) {
    if (skip.has(r.payee_id)) continue;
    if (!byPayee.has(r.payee_id)) byPayee.set(r.payee_id, []);
    byPayee.get(r.payee_id).push(r);
  }
  const out = [];
  for (const [payeeId, txs] of byPayee) {
    // One payment a day per payee (a split purchase isn't two bills).
    const all = [...new Map(txs.map((t) => [toISODate(t.date), t])).values()];
    if (all.length < 2) continue;
    // The longest chain of payments a cycle apart, walking back from one of
    // the last few — so a one-off extra payment to the same vendor (a
    // deposit, a second bill) doesn't hide the regular one.
    let best = null;
    for (const cycle of CYCLES) {
      for (let s = all.length - 1; s >= Math.max(0, all.length - 4); s--) {
        const chain = [all[s]];
        for (let i = s - 1; i >= 0; i--) {
          const gap = dayNum(chain[0].date) - dayNum(all[i].date);
          if (gap < cycle.min) continue;
          if (gap > cycle.max) break;
          chain.unshift(all[i]);
        }
        if (chain.length >= cycle.need && (!best || chain.length > best.days.length)) best = { cycle, days: chain };
      }
    }
    if (!best) continue;
    const { cycle, days } = best;
    const last = toISODate(days[days.length - 1].date);
    // Stopped: no payment for well over a cycle — not recurring any more.
    if (dayNum(today) - dayNum(last) > cycle.days * 1.6) continue;
    const amounts = days.map((t) => -Number(t.amount));
    const typical = median(amounts.slice(-6));
    // Wildly different amounts each time (a store, not a bill): not a bill.
    const spread = (Math.max(...amounts) - Math.min(...amounts)) / Math.max(typical, 1);
    if (cycle.frequency === 'monthly' && spread > 1.5) continue;
    const day = Math.round(median(days.map((t) => Number(toISODate(t.date).slice(8, 10)))));
    let next = addMonths(last, cycle.months);
    while (next < today) next = addMonths(next, cycle.months);
    if (cycle.frequency !== 'annual') next = `${next.slice(0, 8)}${pad(Math.min(day, lastDay(Number(next.slice(0, 4)), Number(next.slice(5, 7)))))}`;
    const recent = days[days.length - 1];
    const cats = new Map();
    for (const t of days) if (t.category_id) cats.set(t.category_id, (cats.get(t.category_id) || 0) + 1);
    const category = [...cats].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    out.push({
      key: `payee:${payeeId}`, payee_id: payeeId, name: recent.payee, frequency: cycle.frequency,
      amount: r2(typical), low: r2(Math.min(...amounts)), high: r2(Math.max(...amounts)),
      next_date: next, day, count: days.length, last_date: last, category_id: category,
      owner: {
        segment: recent.segment, is_segment_split: recent.is_segment_split, segment_grain_pct: recent.segment_grain_pct,
        segment_livestock_pct: recent.segment_livestock_pct, segment_jake_pct: recent.segment_jake_pct, segment_ashley_pct: recent.segment_ashley_pct,
      },
      ledger: recent.ledger,
    });
  }
  return out.sort((a, b) => a.next_date.localeCompare(b.next_date));
}
