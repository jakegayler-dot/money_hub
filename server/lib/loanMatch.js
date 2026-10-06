// Loans that follow the real payments.
//
// Which loan a bank line pays: the line names it (the loan's name, its
// lender, the lender's initials — "AAFC" for Agriculture and Agri-Food
// Canada — a name it has shown up as on statements before, or the payee it
// was paid to last time). Which scheduled payment: that loan's OLDEST unpaid
// one, never a later one while an earlier one is still open. Without a
// name, only an exact amount near its due date identifies it.
//
// What the payment did: the bank's actual amount is what was paid. Interest
// is what the balance actually earned since the last payment (simple daily
// interest at the loan's rate, the way Canadian farm lenders charge it);
// the rest is principal. Then the rest of the schedule is rebuilt from the
// real balance on the payment dates already on file, at the payment the
// lender actually takes — so the next estimate is what the bank will
// really take.
import { toISODate } from './dates.js';
import { dueDateFor } from './amortization.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const dayNum = (d) => { const [y, m, dd] = toISODate(d).split('-').map(Number); return Date.UTC(y, m - 1, dd) / 86400000; };
const daysBetween = (a, b) => Math.max(0, dayNum(b) - dayNum(a));

const STOP = new Set(['and', 'of', 'the', 'de', 'du', 'la', 'le', 'des', 'et', 'for', 'inc', 'ltd', 'corp']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const norm = (s) => words(s).join(' ');

/** "Agriculture and Agri-Food Canada" → "aafc". Null under three letters. */
export function initials(s) {
  const w = words(s).filter((x) => !STOP.has(x));
  return w.length >= 3 ? w.map((x) => x[0]).join('') : null;
}

/** What a loan goes by on a statement line. */
export function loanTerms(loan) {
  const terms = new Set();
  for (const s of [loan.name, loan.lender]) {
    const n = norm(s);
    if (n.length >= 3) terms.add(n);
    const i = initials(s);
    if (i) terms.add(i);
  }
  for (const s of String(loan.statement_names || '').split(',')) {
    const n = norm(s);
    if (n.length >= 3) terms.add(n);
  }
  return [...terms];
}

/** Whether `text` names the loan — a whole word or phrase, not a fragment ("aafc", not "aaf"). */
export function namesLoan(loan, text) {
  const hay = ` ${norm(text)} `;
  return loanTerms(loan).some((t) => hay.includes(` ${t} `));
}

/**
 * The scheduled payment a bank line most likely is, or null:
 * { payment, loan, by: 'name' | 'amount' }. `tx`: { description, payee_id,
 * payee_name, amount (negative), date }.
 */
export async function suggestLoanPayment(client, tx, { excludeIds = [] } = {}) {
  const { rows: loans } = await client.query('SELECT * FROM loans');
  const { rows: open } = await client.query(
    `SELECT lp.*, lp.principal_amount + lp.interest_amount AS total FROM loan_payments lp
     WHERE NOT lp.paid AND NOT lp.is_adjustment AND NOT (lp.id = ANY($1::int[])) ORDER BY lp.due_date, lp.id`, [excludeIds]);
  const oldest = new Map();
  for (const p of open) if (!oldest.has(p.loan_id)) oldest.set(p.loan_id, p);
  const text = `${tx.description || ''} ${tx.payee_name || ''}`;
  const named = loans.filter((l) => oldest.has(l.id) && ((tx.payee_id && l.payee_id === tx.payee_id) || namesLoan(l, text)));
  if (named.length === 1) return { payment: oldest.get(named[0].id), loan: named[0], by: 'name' };
  // No name: an exact amount (to the cent) due within 20 days, and only one.
  const paid = Math.abs(Number(tx.amount));
  const pool = named.length > 1 ? named.map((l) => oldest.get(l.id)) : open;
  const exact = pool.filter((p) => Math.abs(Number(p.total) - paid) < 0.005 && daysBetween(...[toISODate(p.due_date), tx.date].sort()) <= 20);
  if (exact.length === 1) {
    const loan = loans.find((l) => l.id === exact[0].loan_id);
    // Still never past an older open payment on the same loan.
    return { payment: oldest.get(loan.id), loan, by: 'amount' };
  }
  return null;
}

/** Whether an amount is close enough to a scheduled one to link without asking: within 35%. */
export const closeToScheduled = (paid, scheduled) => Number(scheduled) > 0 && Math.abs(Math.abs(paid) - Number(scheduled)) <= 0.35 * Number(scheduled);

/** Remember how this loan shows up, so the next statement line is recognised by name. */
export async function learnLoanName(client, loanId, tx) {
  if (tx.payee_id) await client.query('UPDATE loans SET payee_id = COALESCE(payee_id, $2) WHERE id = $1', [loanId, tx.payee_id]);
}

/**
 * Re-prices the rest of the schedule from a real balance: the payment dates
 * already on file are kept (they're the lender's calendar), each one's
 * interest is the days since the one before, and `payment` is the amount the
 * lender takes — or, with none, the level payment that clears the balance on
 * the last date. A payment too small to cover interest falls back to level.
 * Extra dates are added at the loan's frequency if the balance outlasts them;
 * dates after it's cleared are dropped.
 */
export function reamortize({ balance, ratePct, from, dates, payment = null, frequency = 'monthly' }) {
  const rate = Number(ratePct) / 100;
  let bal = round2(balance);
  if (bal <= 0.005 || !dates.length) return [];
  const level = () => {
    // Level payment over the dates on file, with interest by actual days.
    let lo = 0;
    let hi = bal * 2 + 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      let b = bal;
      let prev = from;
      for (const d of dates) { b = b + b * rate * daysBetween(prev, d) / 365 - mid; prev = d; }
      if (b > 0) lo = mid; else hi = mid;
    }
    return round2(hi);
  };
  let pay = payment != null ? Number(payment) : level();
  const firstInterest = bal * rate * daysBetween(from, dates[0]) / 365;
  if (pay <= firstInterest + 0.005) pay = level();
  const all = [...dates];
  const out = [];
  let prev = from;
  for (let k = 0; k < 600 && bal > 0.005; k++) {
    if (k >= all.length) all.push(dueDateFor(all[all.length - 1], frequency, 1));
    const d = all[k];
    const interest = round2(bal * rate * daysBetween(prev, d) / 365);
    let principal = round2(pay - interest);
    const last = payment == null && k === dates.length - 1;
    if (principal >= bal || last) principal = bal;
    if (principal < 0) principal = 0;
    bal = round2(bal - principal);
    out.push({ due_date: d, principal_amount: principal, interest_amount: interest });
    prev = d;
  }
  return out;
}

/** Principal still owed on a loan, from what was actually paid (and balance corrections). */
async function balanceExcluding(client, loan, paymentId) {
  const { rows: [r] } = await client.query(
    `SELECT COALESCE(SUM(principal_amount), 0) AS paid FROM loan_payments WHERE loan_id = $1 AND paid AND id <> $2`, [loan.id, paymentId]);
  return round2(Number(loan.principal) - Number(r.paid));
}

/** The day interest last settled before `date`: the latest earlier payment, verification, or the loan's start. */
async function lastSettled(client, loan, paymentId, date) {
  const { rows: [r] } = await client.query(
    `SELECT MAX(COALESCE(paid_date, due_date)) AS d FROM loan_payments
     WHERE loan_id = $1 AND paid AND id <> $2 AND COALESCE(paid_date, due_date) < $3`, [loan.id, paymentId, date]);
  return [toISODate(loan.start_date), toISODate(r.d), loan.last_verified_on && toISODate(loan.last_verified_on) < date ? toISODate(loan.last_verified_on) : null]
    .filter(Boolean).sort().pop();
}

/** Rebuilds the open payments after `afterDate` from `balance`, at `payment` (or level). */
async function rebuildRest(client, loan, { balance, from, afterDueDate, payment }) {
  const { rows: rest } = await client.query(
    `SELECT id, due_date FROM loan_payments WHERE loan_id = $1 AND NOT paid AND NOT is_adjustment AND due_date > $2 ORDER BY due_date, id`,
    [loan.id, afterDueDate]);
  if (!rest.length) return;
  const rows = reamortize({
    balance, ratePct: loan.interest_rate_pct, from, dates: rest.map((r) => toISODate(r.due_date)), payment,
    frequency: loan.payment_frequency || 'monthly',
  });
  for (let i = 0; i < Math.max(rows.length, rest.length); i++) {
    if (i < rest.length && i < rows.length) {
      await client.query('UPDATE loan_payments SET principal_amount = $2, interest_amount = $3, scheduled_principal = NULL, scheduled_interest = NULL WHERE id = $1',
        [rest[i].id, rows[i].principal_amount, rows[i].interest_amount]);
    } else if (i < rest.length) {
      await client.query('DELETE FROM loan_payments WHERE id = $1', [rest[i].id]); // cleared earlier than planned
    } else {
      await client.query('INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount) VALUES ($1,$2,$3,$4)',
        [loan.id, rows[i].due_date, rows[i].principal_amount, rows[i].interest_amount]);
    }
  }
}

/**
 * A scheduled payment was really made for `paid` on `date`: book what it
 * actually was (interest earned since the last payment, the rest principal)
 * and re-price the rest of the schedule at that payment.
 */
export async function applyActualPayment(client, paymentId, paid, date) {
  const { rows: [p] } = await client.query('SELECT * FROM loan_payments WHERE id = $1', [paymentId]);
  if (!p || p.is_adjustment) return null;
  const { rows: [loan] } = await client.query('SELECT * FROM loans WHERE id = $1', [p.loan_id]);
  const amount = round2(Math.abs(paid));
  const on = toISODate(date);
  const before = await balanceExcluding(client, loan, p.id);
  const since = await lastSettled(client, loan, p.id, on);
  const interest = Math.min(amount, Math.max(0, round2(before * Number(loan.interest_rate_pct) / 100 * daysBetween(since, on) / 365)));
  const principal = Math.min(round2(amount - interest), Math.max(before, 0));
  await client.query(
    `UPDATE loan_payments SET scheduled_principal = COALESCE(scheduled_principal, principal_amount),
       scheduled_interest = COALESCE(scheduled_interest, interest_amount), principal_amount = $2, interest_amount = $3 WHERE id = $1`,
    [p.id, principal, round2(amount - principal)]);
  // The lender's real payment is the estimate from here on, unless this was a one-off
  // (more than 35% off what was scheduled) — then the rest is levelled out instead.
  const scheduled = Number(p.scheduled_principal ?? p.principal_amount) + Number(p.scheduled_interest ?? p.interest_amount);
  const next = closeToScheduled(amount, scheduled) ? amount : null;
  await rebuildRest(client, loan, { balance: round2(before - principal), from: on, afterDueDate: toISODate(p.due_date), payment: next });
  if (next != null) await client.query('UPDATE loans SET verified_payment = $2 WHERE id = $1', [loan.id, next]);
  return { interest: round2(amount - principal), principal };
}

/** Undoes applyActualPayment when a payment is unlinked: back to the plan, the rest re-priced from it. */
export async function undoActualPayment(client, paymentId) {
  const { rows: [p] } = await client.query('SELECT * FROM loan_payments WHERE id = $1', [paymentId]);
  if (!p || p.scheduled_principal == null) return;
  await client.query(
    `UPDATE loan_payments SET principal_amount = scheduled_principal, interest_amount = scheduled_interest,
       scheduled_principal = NULL, scheduled_interest = NULL WHERE id = $1`, [p.id]);
  const { rows: [loan] } = await client.query('SELECT * FROM loans WHERE id = $1', [p.loan_id]);
  // Unpaid again: the balance it would have left is what the rest is priced from.
  const total = Number(p.scheduled_principal) + Number(p.scheduled_interest);
  const before = await balanceExcluding(client, loan, p.id);
  await rebuildRest(client, loan, {
    balance: round2(before - Number(p.scheduled_principal)), from: toISODate(p.due_date), afterDueDate: toISODate(p.due_date), payment: total,
  });
}

