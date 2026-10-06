// Links unpaid bills to the ledger entry that paid them — whether that
// entry came from a statement, was typed in, or was posted before the bill
// existed. A bill pays from the transaction with exactly its total, going
// out, in a window around the due date, that doesn't already pay
// something else.
//
// Linked automatically only when it's unambiguous both ways: the bill has
// one such payment, and that payment fits no other unpaid bill. When
// several fit, the business name breaks the tie; otherwise they're shown
// on the Bills tab as suggestions to confirm with one tap. A payment once
// unlinked from a bill ("Not this payment") is never linked automatically again.
import { pool, withTransaction } from '../db.js';
import { linkBillToTransaction, linkLoanPaymentToTransaction, linkBillsToTransaction, refundVendorCredit, PostingError } from './postings.js';
import { toISODate, addDays } from './dates.js';
import { suggestLoanPayment, closeToScheduled } from './loanMatch.js';
import { closedMonth } from './periods.js';
import { matchPending } from './receipts.js';

// One-off invoices often get paid late (or early), so they look further;
// a monthly bill must stay inside its own cycle.
const WINDOW = {
  one_time: { before: 7, after: 180 },
  monthly: { before: 20, after: 25 },
  quarterly: { before: 30, after: 45 },
};

const GENERIC = new Set(['inv', 'invoice', 'bill', 'the', 'and', 'ltd', 'inc', 'for', 'rent', 'land', 'payment', 'pmt', 'from']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w) && !/^\d+$/.test(w));

/** Payments that could have paid this bill, best first. */
export async function billCandidates(db, bill, limit = 20) {
  const w = WINDOW[bill.frequency] || WINDOW.one_time;
  const from = bill.frequency === 'one_time' && bill.received_date ? toISODate(bill.received_date) : null;
  const { rows } = await db.query(
    `SELECT t.id, t.date, t.amount, t.description, p.name AS payee, a.name AS account_name, cc.name AS card_name,
            EXISTS (SELECT 1 FROM bill_link_rejections x WHERE x.transaction_id = t.id) AS rejected_before
     FROM transactions t
     LEFT JOIN payees p ON p.id = t.payee_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     WHERE t.amount < 0 AND NOT t.is_transfer
       -- exactly the bill; a financed bill: from the invoice up to what was owing that day (+2% for the lender's own interest math)
       AND (abs(t.amount + $1) < 0.005
            OR ($8::bool AND -t.amount BETWEEN $1 - 1 AND (SELECT bill_owing(b, t.date) FROM bills b WHERE b.id = $7) * 1.02 + 5))
       AND NOT (t.account_id IS NOT NULL AND t.credit_card_id IS NOT NULL)
       AND t.date BETWEEN COALESCE($2::date, $3::date - 90) - $4::int AND $3::date + $5::int
       AND NOT EXISTS (SELECT 1 FROM bills x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM loan_payments x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM contract_payments x WHERE x.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM owner_draws x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM bill_link_rejections x WHERE x.transaction_id = t.id AND x.bill_id = $7)
     ORDER BY abs(t.date - $3::date), t.id
     LIMIT $6`,
    [Number(bill.owing_now ?? bill.amount), from, toISODate(bill.due_date), w.before, w.after, limit, bill.id, !!bill.is_financed]
  );
  const named = [...words(bill.name), ...words(bill.vendor)];
  return rows.map((t) => ({
    id: t.id, date: toISODate(t.date), amount: Number(t.amount), description: t.description,
    payee: t.payee, account: t.account_name || (t.card_name ? `${t.card_name} (card)` : null),
    rejected_before: t.rejected_before,
    name_match: named.some((x) => `${t.description || ''} ${t.payee || ''}`.toLowerCase().includes(x)),
  }));
}

/** The one payment to link for each bill, where it's unambiguous. */
function pickLinks(bills, candsByBill) {
  const pick = new Map();
  for (const b of bills) {
    let list = candsByBill.get(b.id) || [];
    // A financed bill matches a range of amounts, so it needs the business named too.
    if (b.is_financed) list = list.filter((c) => c.name_match);
    if (list.length > 1) {
      const named = list.filter((c) => c.name_match);
      if (named.length) list = named;
    }
    // Once you've said a payment wasn't some bill, it's only ever suggested.
    if (list.length === 1 && !list[0].rejected_before) pick.set(b.id, list[0].id);
  }
  // A payment that fits more than one bill (two $4,200 rents) goes to none.
  const fits = new Map();
  for (const [, list] of candsByBill) for (const c of list) fits.set(c.id, (fits.get(c.id) || 0) + 1);
  for (const [billId, txId] of pick) {
    if (fits.get(txId) > 1) {
      // …unless this bill is the only one whose name it carries.
      const named = [...candsByBill].filter(([, l]) => l.some((c) => c.id === txId && c.name_match));
      if (!(named.length === 1 && named[0][0] === billId)) pick.delete(billId);
    }
  }
  return pick;
}

/**
 * Links every unpaid bill it can. Repeats so a recurring bill's next cycle
 * (created by paying this one) can find its own payment. Returns the links made.
 */
export async function autoLinkBills() {
  const made = [];
  for (let pass = 0; pass < 6; pass++) {
    const { rows: bills } = await pool.query(
      `SELECT b.*, bill_owing(b, CURRENT_DATE) AS owing_now, p.name AS vendor
       FROM bills b LEFT JOIN payees p ON p.id = b.payee_id WHERE b.status = 'unpaid' ORDER BY b.due_date, b.id`);
    const cands = new Map();
    for (const b of bills) cands.set(b.id, await billCandidates(pool, b));
    const pick = pickLinks(bills, cands);
    let changed = 0;
    for (const [billId, txId] of pick) {
      const tx = cands.get(billId).find((c) => c.id === txId);
      if (await closedMonth(pool, tx.date)) continue;
      try {
        await withTransaction((client) => linkBillToTransaction(client, billId, txId));
        made.push({ bill_id: billId, transaction_id: txId });
        changed++;
      } catch (e) {
        if (!(e instanceof PostingError) && e.status !== 409) throw e;
      }
    }
    if (!changed) break;
  }
  if (made.length) await matchPending(); // invoice photos follow their bill onto the payment
  made.push(...await autoLinkVendorTotals());
  made.push(...await autoLinkDepositRefunds());
  made.push(...await autoLinkLoanPayments());
  return made;
}

/**
 * One payment for several of a vendor's bills: a payment to the vendor
 * (its payee, or its name in the description) for exactly what its two or
 * more oldest unpaid bills come to — or all of them. Linked when exactly
 * one payment fits; it's split into one piece per bill.
 */
export async function autoLinkVendorTotals() {
  const { rows: bills } = await pool.query(
    `SELECT b.*, bill_owing(b, CURRENT_DATE) AS owing_now, p.name AS vendor
     FROM bills b JOIN payees p ON p.id = b.payee_id
     WHERE b.status = 'unpaid' AND NOT b.is_financed ORDER BY b.payee_id, b.due_date, b.id`);
  const byVendor = new Map();
  for (const b of bills) byVendor.set(b.payee_id, [...(byVendor.get(b.payee_id) || []), b]);
  const made = [];
  for (const [vendorId, list] of byVendor) {
    if (list.length < 2) continue;
    const sums = [];
    let run = 0;
    list.forEach((b, i) => { run += Number(b.owing_now); if (i >= 1) sums.push({ k: i + 1, total: Math.round(run * 100) / 100 }); });
    const vw = words(list[0].vendor).map((w) => `%${w}%`);
    const first = list.reduce((d, b) => { const x = toISODate(b.received_date || b.due_date); return x < d ? x : d; }, '9999-12-31');
    const last = toISODate(list[list.length - 1].due_date);
    const { rows: pays } = await pool.query(
      `SELECT t.id, t.date, -t.amount AS paid FROM transactions t
       WHERE t.amount < 0 AND NOT t.is_transfer AND NOT t.is_debt_service
         AND (t.payee_id = $1 OR ($4::text[] <> '{}' AND lower(t.description) LIKE ANY ($4)))
         AND t.date BETWEEN $2::date - 7 AND $3::date + 60
         AND NOT EXISTS (SELECT 1 FROM bills x WHERE x.linked_transaction_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM loan_payments x WHERE x.linked_transaction_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM contract_payments x WHERE x.transaction_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM vendor_credits x WHERE x.transaction_id = t.id OR x.refund_transaction_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM bill_link_rejections x WHERE x.transaction_id = t.id)`,
      [vendorId, first, last, vw]);
    for (const s of sums) {
      const fit = pays.filter((t) => Math.abs(Number(t.paid) - s.total) < 0.015);
      if (fit.length !== 1 || await closedMonth(pool, fit[0].date)) continue;
      try {
        await withTransaction((client) => linkBillsToTransaction(client, list.slice(0, s.k).map((b) => b.id), fit[0].id));
        made.push({ bill_ids: list.slice(0, s.k).map((b) => b.id), transaction_id: fit[0].id });
        break; // the vendor's open bills changed — next pass picks up anything else
      } catch (e) {
        if (!(e instanceof PostingError) && e.status !== 409) throw e;
      }
    }
  }
  return made;
}

/** A refundable deposit coming back: money in from the vendor for exactly what it still holds. */
export async function autoLinkDepositRefunds() {
  const { rows: credits } = await pool.query(
    `SELECT vc.*, p.name AS vendor FROM vendor_credits vc JOIN payees p ON p.id = vc.payee_id
     WHERE vc.kind = 'refundable' AND vc.status = 'open'
       AND NOT EXISTS (SELECT 1 FROM credit_applications ca WHERE ca.credit_id = vc.id)`);
  const made = [];
  for (const c of credits) {
    const vw = words(c.vendor).map((w) => `%${w}%`);
    const { rows } = await pool.query(
      `SELECT t.id, t.date FROM transactions t
       WHERE t.amount > 0 AND abs(t.amount - $2) < 0.005 AND t.date > $3::date AND NOT t.is_transfer
         AND (t.payee_id = $1 OR ($4::text[] <> '{}' AND lower(t.description) LIKE ANY ($4)))
         AND NOT EXISTS (SELECT 1 FROM vendor_credits x WHERE x.refund_transaction_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM contract_payments x WHERE x.transaction_id = t.id)`,
      [c.payee_id, Number(c.amount), toISODate(c.date), vw]);
    if (rows.length !== 1 || await closedMonth(pool, rows[0].date)) continue;
    try {
      await withTransaction((client) => refundVendorCredit(client, c.id, rows[0].id));
      made.push({ credit_id: c.id, transaction_id: rows[0].id });
    } catch (e) {
      if (!(e instanceof PostingError) && e.status !== 409) throw e;
    }
  }
  return made;
}

/**
 * Loan payments the bank took that came in as an ordinary line. A line
 * that names the loan (its name, lender, the lender's initials, or the
 * payee it was paid to before) is that loan's OLDEST open payment, as long
 * as the amount is within 35% of it — the actual amount is what's booked.
 * A line that names no loan links only on an exact scheduled amount near
 * its due date. Lines someone unlinked from a loan are left alone.
 */
export async function autoLinkLoanPayments() {
  const { rows: txs } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, t.payee_id, p.name AS payee_name FROM transactions t
     LEFT JOIN payees p ON p.id = t.payee_id
     WHERE t.account_id IS NOT NULL AND t.credit_card_id IS NULL AND t.amount < 0 AND NOT t.is_transfer AND NOT t.is_debt_service
       AND NOT t.is_split AND t.date >= CURRENT_DATE - 400
       AND NOT EXISTS (SELECT 1 FROM bills x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM loan_payments x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM contract_payments x WHERE x.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM vendor_credits x WHERE x.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM loan_link_rejections x WHERE x.transaction_id = t.id)
     ORDER BY t.date, t.id`);
  const made = [];
  for (const t of txs) {
    const date = toISODate(t.date);
    const s = await suggestLoanPayment(pool, { ...t, date });
    if (!s) continue;
    if (!closeToScheduled(t.amount, s.payment.total)) continue; // an AgriStability fee to AAFC isn't the loan
    if (toISODate(s.payment.due_date) > addDays(date, 60)) continue; // nothing due yet: not this
    if (await closedMonth(pool, t.date)) continue;
    try {
      await withTransaction((client) => linkLoanPaymentToTransaction(client, s.payment.id, t.id));
      made.push({ loan_payment_id: s.payment.id, transaction_id: t.id, by: s.by });
    } catch (e) {
      if (!(e instanceof PostingError) && e.status !== 409) throw e;
    }
  }
  return made;
}

let running = null;
/** Fire-and-forget version for after statements and entries arrive. */
export function autoLinkBillsSoon() {
  if (running) return running;
  running = autoLinkBills()
    .catch((e) => console.error('Bill auto-link failed:', e.message))
    .finally(() => { running = null; });
  return running;
}
