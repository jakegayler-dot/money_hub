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
import { linkBillToTransaction, PostingError } from './postings.js';
import { toISODate } from './dates.js';
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
     WHERE abs(t.amount + $1) < 0.005 AND t.amount < 0 AND NOT t.is_transfer
       AND NOT (t.account_id IS NOT NULL AND t.credit_card_id IS NOT NULL)
       AND t.date BETWEEN COALESCE($2::date, $3::date - 90) - $4::int AND $3::date + $5::int
       AND NOT EXISTS (SELECT 1 FROM bills x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM loan_payments x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM sale_contracts x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM owner_draws x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM bill_link_rejections x WHERE x.transaction_id = t.id AND x.bill_id = $7)
     ORDER BY abs(t.date - $3::date), t.id
     LIMIT $6`,
    [Number(bill.amount), from, toISODate(bill.due_date), w.before, w.after, limit, bill.id]
  );
  const named = words(bill.name);
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
    const { rows: bills } = await pool.query(`SELECT * FROM bills WHERE status = 'unpaid' ORDER BY due_date, id`);
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
