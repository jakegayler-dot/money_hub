// Pure builder for the Sentinel snapshot: database rows in, snapshot body
// out. No DB, no network, no clock except the `now` passed in — so every
// rule here (window, projections, rounding, Regina "today") is testable in
// isolation. The push/scheduling side lives in sentinel.js.
//
// Contract: the snapshot must contain EVERY item whose start date falls in
// [from, to] — Sentinel deletes anything it holds for Money Hub in that
// window that's missing. So this either builds the complete list or throws;
// it never returns a partial one.

import { toISODate, addMonths, addDays } from './dates.js';

export const WINDOW_PAST_DAYS = 30;
export const WINDOW_FUTURE_DAYS = 548;
const TITLE_MAX = 120;
const SOURCE_ID_MAX = 200;

// Saskatchewan: America/Regina is UTC−6 all year (no DST), so "today" is
// simply the UTC calendar date six hours ago. 03:00 UTC on Oct 1 is still
// Sep 30 at the farm.
const REGINA_OFFSET_MS = 6 * 60 * 60 * 1000;
export function reginaToday(now = new Date()) {
  return new Date(now.getTime() - REGINA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * NUMERIC → integer cents without float drift. node-pg returns NUMERIC as a
 * string ("1234.57"), which is parsed digit by digit; a JS number is
 * stringified first. Rounds half away from zero at the third decimal.
 */
export function toCents(value) {
  if (value == null || value === '') return null;
  let s = typeof value === 'number' ? String(value) : String(value).trim();
  if (typeof value === 'number' && /e/i.test(s)) s = value.toFixed(10);
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && !m[3])) throw new Error(`Not a money amount: ${JSON.stringify(value)}`);
  const sign = m[1] === '-' ? -1 : 1;
  const whole = Number(m[2] || '0');
  const frac = (m[3] || '').padEnd(3, '0');
  let cents = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) throw new Error(`Amount out of range: ${s}`);
  return sign * cents || 0;
}

const fmtCents = (c) => {
  const abs = Math.abs(c);
  const dollars = Math.floor(abs / 100).toLocaleString('en-CA');
  return `${c < 0 ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
};

const clip = (s, max) => {
  const str = String(s ?? '').trim();
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
};

const inWindow = (date, from, to) => date >= from && date <= to;

// Household (personal-ledger) bills go to the 'house' category and are
// shared with House Hub; everything on the business ledger is 'finance'.
// `ledger` is the app's own business/personal split and every bill carries
// it (NOT NULL, default business), so it's the one reliable signal.
export const billCategory = (bill) => (bill.ledger === 'personal' ? 'house' : 'finance');

/**
 * The snapshot window: Regina today − 30 days → today + 548 days, with
 * `from` pulled back to the oldest unpaid bill / loan payment / card
 * statement so overdue obligations stay in scope (and aren't deleted in
 * Sentinel just because they've aged out of the 30 days).
 */
export function computeWindow(rows, today) {
  let from = addDays(today, -WINDOW_PAST_DAYS);
  const to = addDays(today, WINDOW_FUTURE_DAYS);
  const unpaidDates = [
    ...(rows.bills || []).filter((b) => b.status !== 'paid').map((b) => b.due_date),
    ...(rows.loanPayments || []).filter((p) => !p.paid && !p.is_adjustment).map((p) => p.due_date),
    ...(rows.statements || []).filter((s) => !s.paid).map((s) => s.due_date),
  ].map(toISODate).filter(Boolean);
  for (const d of unpaidDates) if (d < from) from = d;
  return { from, to };
}

const linkFor = (appUrl, path) => (appUrl ? `${appUrl.replace(/\/+$/, '')}${path}` : undefined);

function makeItem(fields) {
  const item = { ...fields, title: clip(fields.title, TITLE_MAX) || '(untitled)', all_day: true };
  if (item.notes == null || item.notes === '') delete item.notes;
  if (item.deep_link == null) delete item.deep_link;
  if (item.share_scopes == null) delete item.share_scopes;
  if (item.amount_cents == null) { delete item.amount_cents; delete item.currency; }
  return item;
}

function billNotes(bill, extra) {
  const parts = [];
  if (bill.category) parts.push(`Category: ${bill.category}`);
  parts.push(`Ledger: ${bill.ledger || 'business'}`);
  const lines = [parts.join(' · ')];
  if (extra) lines.push(extra);
  if (bill.notes) lines.push(String(bill.notes));
  return lines.join('\n');
}

const FREQUENCY_MONTHS = { monthly: 1, quarterly: 3 };

/** Items for bills (real rows) plus projected future occurrences of unpaid recurring bills. */
export function billItems(bills, { from, to, appUrl }) {
  const items = [];
  for (const bill of bills) {
    const due = toISODate(bill.due_date);
    const unpaid = bill.status !== 'paid';
    const category = billCategory(bill);
    const amount_cents = toCents(bill.amount);
    const common = {
      kind: 'bill', category, title: bill.name, amount_cents, currency: 'CAD',
      // Sentinel strips amounts and deep links from what House Hub sees.
      deep_link: linkFor(appUrl, '/bills'),
      share_scopes: category === 'house' ? ['house'] : undefined,
    };

    if (unpaid || inWindow(due, from, to)) {
      items.push(makeItem({
        source_id: `bill:${bill.id}:${due}`, ...common,
        notes: billNotes(bill), starts_at: due, status: unpaid ? 'open' : 'done',
      }));
    }

    // Money Hub only creates the next row of a recurring bill when this one
    // is paid, so project the rest of the schedule from this (unpaid) row.
    // Each date is addMonths(anchor, k·step) from the original due date —
    // never chained — so a 31st doesn't drift to the 28th after February.
    const step = FREQUENCY_MONTHS[bill.frequency];
    if (unpaid && step) {
      for (let k = 1; ; k++) {
        const next = addMonths(due, k * step);
        if (next > to) break;
        if (next < from) continue;
        items.push(makeItem({
          source_id: `bill:${bill.id}:${next}`, ...common,
          notes: billNotes(bill, `Projected from the ${bill.frequency} schedule`),
          starts_at: next, status: 'scheduled',
        }));
      }
    }
  }
  return items;
}

export function loanPaymentItems(payments, { from, to, appUrl }) {
  const items = [];
  for (const p of payments) {
    if (p.is_adjustment) continue; // balance corrections, not money moving
    const due = toISODate(p.due_date);
    if (p.paid && !inWindow(due, from, to)) continue;
    const principal = toCents(p.principal_amount) || 0;
    const interest = toCents(p.interest_amount) || 0;
    const loanName = p.loan_name || p.lender || `Loan ${p.loan_id}`;
    items.push(makeItem({
      source_id: `loan-payment:${p.id}`, kind: 'bill', category: 'finance',
      title: `Loan payment: ${loanName}`,
      notes: [`Principal ${fmtCents(principal)} + interest ${fmtCents(interest)}`,
        p.lender && p.lender !== loanName ? `Lender: ${p.lender}` : null].filter(Boolean).join('\n'),
      starts_at: due, status: p.paid ? 'done' : 'open',
      amount_cents: principal + interest, currency: 'CAD',
      deep_link: linkFor(appUrl, '/loans'),
    }));
  }
  return items;
}

/**
 * Card statements: the amount is what's still owed on an open statement
 * (statement_balance − paid_amount, floored at 0 — the same figure the app's
 * forecast and card pages use), and the full statement_balance once paid.
 * The minimum payment goes in the notes.
 */
export function statementItems(statements, { from, to, appUrl }) {
  const items = [];
  for (const s of statements) {
    if (!s.due_date) continue;
    const due = toISODate(s.due_date);
    if (s.paid && !inWindow(due, from, to)) continue;
    const balance = toCents(s.statement_balance) || 0;
    const paidSoFar = toCents(s.paid_amount) || 0;
    const amount_cents = s.paid ? balance : Math.max(balance - paidSoFar, 0);
    const card = s.card_name || `Card ${s.credit_card_id}`;
    const notes = [
      `Statement balance ${fmtCents(balance)}`,
      s.minimum_payment != null ? `Minimum payment ${fmtCents(toCents(s.minimum_payment))}` : null,
      !s.paid && paidSoFar > 0 ? `Paid so far ${fmtCents(paidSoFar)}` : null,
      s.notes ? String(s.notes) : null,
    ].filter(Boolean).join('\n');
    items.push(makeItem({
      source_id: `card-statement:${s.id}`, kind: 'bill', category: 'finance',
      title: `${card} statement due`, notes,
      starts_at: due, status: s.paid ? 'done' : 'open',
      amount_cents, currency: 'CAD',
      deep_link: linkFor(appUrl, '/credit-cards'),
    }));
  }
  return items;
}

export function covenantItems(loans, { from, to, appUrl }) {
  const items = [];
  for (const loan of loans) {
    const date = toISODate(loan.covenant_date);
    if (!date || !inWindow(date, from, to)) continue;
    items.push(makeItem({
      source_id: `loan-covenant:${loan.id}:${date}`, kind: 'event', category: 'finance',
      title: `Covenant date: ${loan.name || loan.lender}`,
      notes: loan.covenant_notes || null,
      starts_at: date, status: 'scheduled',
      deep_link: linkFor(appUrl, '/loans'),
    }));
  }
  return items;
}

export function contractItems(contracts, { from, to, appUrl }) {
  const items = [];
  for (const c of contracts) {
    if (c.status === 'cancelled') continue;
    const date = toISODate(c.expected_payment_date);
    if (!date || !inWindow(date, from, to)) continue;
    const label = [c.commodity, c.counterparty].filter(Boolean).join(' — ');
    const qty = c.quantity != null ? `${Number(c.quantity)}${c.unit ? ` ${c.unit}` : ''}` : null;
    items.push(makeItem({
      source_id: `contract-payment:${c.id}`, kind: 'event', category: 'finance',
      title: `Payment expected: ${label || `contract ${c.id}`}`,
      notes: [`Contract value ${fmtCents(toCents(c.total_value) || 0)}${qty ? ` (${qty})` : ''}`,
        `Status: ${c.status}`, c.notes ? String(c.notes) : null].filter(Boolean).join('\n'),
      starts_at: date, status: c.status === 'settled' ? 'done' : 'scheduled',
      deep_link: linkFor(appUrl, '/contracts'),
    }));
  }
  return items;
}

/**
 * rows: { bills, loanPayments, statements, loans, contracts } — raw DB rows
 * (loanPayments joined with loan_name/lender, statements with card_name).
 */
export function buildSnapshot(rows, { now = new Date(), appUrl = null } = {}) {
  const today = reginaToday(now);
  const { from, to } = computeWindow(rows, today);
  const opts = { from, to, appUrl: appUrl || null };
  const items = [
    ...billItems(rows.bills || [], opts),
    ...loanPaymentItems(rows.loanPayments || [], opts),
    ...statementItems(rows.statements || [], opts),
    ...covenantItems(rows.loans || [], opts),
    ...contractItems(rows.contracts || [], opts),
  ];

  const seen = new Set();
  for (const item of items) {
    if (item.source_id.length > SOURCE_ID_MAX) throw new Error(`source_id too long: ${item.source_id}`);
    if (seen.has(item.source_id)) throw new Error(`Duplicate source_id in snapshot: ${item.source_id}`);
    seen.add(item.source_id);
  }
  items.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.source_id.localeCompare(b.source_id));
  return { generated_at: now.toISOString(), from, to, items };
}
