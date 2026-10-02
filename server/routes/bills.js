import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { validateSegment, segmentValues, SEGMENT_COLUMNS } from '../lib/segments.js';
import { payBill, removeTransaction, linkBillToTransaction, expenseCategoryFor } from '../lib/postings.js';
import { autoLinkBills, autoLinkBillsSoon, billCandidates } from '../lib/billMatch.js';
import { CONFIRMED_SQL } from '../lib/periods.js';
import { todayISO, toISODate, addMonths } from '../lib/dates.js';
import { matchPending } from '../lib/receipts.js';

// "$13,$14,..." placeholder run for the segment columns, starting at n.
const segPlaceholders = (n) => SEGMENT_COLUMNS.map((_, i) => `$${n + i}`).join(',');
const SEG_COLS = SEGMENT_COLUMNS.join(', ');

const router = Router();

// `amount` is treated as the GST-inclusive total. Given that total and a
// GST rate, the tax component is amount * pct / (100 + pct) — not
// amount * pct / 100, which would double-count the tax already folded
// into the total. Rounded to cents; subtotal is whatever remains.
function splitGst(amount, hasGst, pct) {
  const total = Number(amount) || 0;
  if (!hasGst) return { gst_amount: 0, subtotal_amount: total };
  const rate = Number(pct) || 0;
  const gst = Math.round((total * rate / (100 + rate)) * 100) / 100;
  return { gst_amount: gst, subtotal_amount: Math.round((total - gst) * 100) / 100 };
}

// A bill's category is one from the shared category list; `category`
// (text) is kept as that category's name for anything still reading it.
async function categoryName(id) {
  if (!id) return null;
  const { rows } = await pool.query('SELECT name FROM expense_categories WHERE id = $1', [id]);
  return rows[0]?.name ?? null;
}

// Each bill with its category, the ledger entry that paid it (and whether a
// statement has confirmed that entry), its invoice photo, and — for unpaid
// bills — payments already in the ledger that look like they paid it.
// Unambiguous payments are linked first, so the list is current.
router.get('/', ah(async (req, res) => {
  try { await autoLinkBills(); } catch (e) { console.error('Bill auto-link failed:', e.message); }
  const status = ['paid', 'unpaid'].includes(req.query.status) ? req.query.status : null;
  const where = status ? 'WHERE b.status = $1' : '';
  const params = status ? [status] : [];
  const { rows } = await pool.query(
    `SELECT b.*,
            CASE WHEN pc.id IS NULL THEN ec.name ELSE pc.name || ' › ' || ec.name END AS category_full,
            t.date AS paid_tx_date, t.amount AS paid_tx_amount, t.description AS paid_tx_description,
            a.name AS paid_account, cc.name AS paid_card,
            CASE WHEN t.id IS NULL THEN NULL ELSE ${CONFIRMED_SQL('t')} END AS paid_confirmed,
            (SELECT r.id FROM receipts r
             WHERE r.bill_id = b.id OR (b.linked_transaction_id IS NOT NULL AND r.transaction_id = b.linked_transaction_id)
             ORDER BY (r.bill_id = b.id) DESC, r.id LIMIT 1) AS invoice_receipt_id
     FROM bills b
     LEFT JOIN expense_categories ec ON ec.id = b.category_id
     LEFT JOIN expense_categories pc ON pc.id = ec.parent_id
     LEFT JOIN transactions t ON t.id = b.linked_transaction_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     ${where}
     ORDER BY (b.status = 'unpaid') DESC, b.due_date ASC`,
    params
  );
  const out = [];
  for (const b of rows) {
    out.push({
      ...b,
      paid_tx_date: b.paid_tx_date ? toISODate(b.paid_tx_date) : null,
      paid_tx_amount: b.paid_tx_amount == null ? null : Number(b.paid_tx_amount),
      suggestions: b.status === 'unpaid' ? await billCandidates(pool, b, 4) : [],
    });
  }
  res.json(out);
}));

// "This payment paid this bill" — a ledger entry already there.
router.post('/:id/link', ah(async (req, res) => {
  const txId = Number(req.body?.transaction_id);
  if (!txId) return res.status(400).json({ error: 'transaction_id is required.' });
  const r = await withTransaction((client) => linkBillToTransaction(client, Number(req.params.id), txId));
  setImmediate(() => matchPending().catch(() => {}));
  res.json({ ok: true, nextBill: r.nextBill });
}));

router.post('/', ah(async (req, res) => {
  const {
    name, ledger = 'business', category_id = null, amount, frequency = 'one_time',
    received_date = null, due_date, notes = null,
    has_gst = false, gst_pct = 5,
  } = req.body;

  const segmentError = validateSegment(req.body);
  if (segmentError) return res.status(400).json({ error: segmentError });

  // Empty strings from an optional form field are not valid DATE input —
  // coerce them (and empty text) to NULL rather than letting the insert fail.
  const { gst_amount, subtotal_amount } = splitGst(amount, has_gst, gst_pct);
  // An agent may send a typed category instead of an id — put it on the shared list.
  const catId = category_id || (req.body.category ? await expenseCategoryFor(pool, req.body.category) : null);
  const category = await categoryName(catId);
  const { rows } = await pool.query(
    `INSERT INTO bills
      (name, ledger, category, amount, frequency, received_date, due_date, notes, has_gst, gst_pct, gst_amount, subtotal_amount,
       ${SEG_COLS}, category_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,${segPlaceholders(13)},$${13 + SEGMENT_COLUMNS.length}) RETURNING *`,
    [name, ledger, category, amount, frequency, received_date || null, due_date, notes || null,
     !!has_gst, gst_pct, gst_amount, subtotal_amount,
     ...segmentValues(req.body), catId]
  );
  autoLinkBillsSoon(); // already paid? find the payment
  res.status(201).json(rows[0]);
}));

// Marking a bill paid moves real money: when account_id is given, this
// creates the actual ledger transaction (negative = outflow, for the full
// invoice total) in that account IN THE SAME DB TRANSACTION as updating the
// account's balance and flipping the bill to paid — so the balance always
// reflects bills that have actually been paid, not just ones logged as
// paid. account_id is optional only for backward compatibility with bills
// paid before this existed; omitting it marks the bill paid without moving
// any balance, which will look wrong on the Accounts page.
// For a recurring bill, this also rolls the due date forward and re-opens
// it as unpaid, so a monthly/quarterly bill doesn't have to be re-entered
// by hand every cycle.
router.post('/:id/pay', ah(async (req, res) => {
  const {
    paid_date = todayISO(),
    account_id = null,
    paid_by_check = false,
  } = req.body;
  const r = await withTransaction((client) => payBill(client, req.params.id, { account_id, date: paid_date, paid_by_check }));
  if (!r) return res.status(404).json({ error: 'not found' });
  setImmediate(() => matchPending().catch(() => {})); // a photographed invoice attaches to this payment
  autoLinkBillsSoon(); // a recurring bill's next cycle may already be paid
  res.json({ paid: r.bill.id, nextBill: r.nextBill });
}));

// Editing an UNPAID bill is always safe — nothing downstream depends on its
// numbers yet. Once a bill is PAID, though, it has a linked transaction
// that already moved real money and already changed an account balance;
// silently changing the bill's amount/due_date/GST after that would leave
// the bill record disagreeing with the transaction it produced, with
// nothing keeping them in sync. So those fields are locked once paid —
// name/category/notes (cosmetic, no side effects) stay editable always.
// To correct a paid bill's amount, reverse the payment (delete the linked
// transaction, which is a separate, deliberate action) and re-enter it.
// Reverses a paid bill back to unpaid: deletes its linked transaction
// (restoring the account balance it deducted) and clears paid_date/
// linked_transaction_id. This is the supported way to fix a paid bill's
// amount or due date — undo the payment, edit the now-unpaid bill, then
// pay it again — rather than editing a paid bill in place and leaving its
// transaction pointing at stale numbers.
router.post('/:id/unpay', ah(async (req, res) => {
  const bill = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM bills WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows.length) return null;
    const bill = rows[0];
    if (bill.status !== 'paid') return bill;
    // Null the FK reference before deleting the transaction it points to.
    const { rows: updated } = await client.query(
      `UPDATE bills SET status = 'unpaid', paid_date = NULL, linked_transaction_id = NULL WHERE id = $1 RETURNING *`,
      [bill.id]
    );
    // A bill matched to a transaction that was already in the ledger just
    // lets go of it; a payment made from the Bills tab is deleted.
    if (bill.linked_transaction_id && !bill.linked_existing) await removeTransaction(client, bill.linked_transaction_id);
    if (bill.linked_transaction_id && bill.linked_existing) {
      await client.query('INSERT INTO bill_link_rejections (bill_id, transaction_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [bill.id, bill.linked_transaction_id]);
    }
    await client.query('UPDATE bills SET linked_existing = false WHERE id = $1', [bill.id]);
    // Paying a recurring bill created next cycle's bill. Reopening this one
    // makes that copy a duplicate (the forecast would count the cycle
    // twice), so remove it — only if it's still unpaid and untouched.
    if (bill.frequency === 'monthly' || bill.frequency === 'quarterly') {
      const nextDue = addMonths(toISODate(bill.due_date), bill.frequency === 'monthly' ? 1 : 3);
      await client.query(
        `DELETE FROM bills WHERE id = (
           SELECT id FROM bills WHERE status = 'unpaid' AND name = $1 AND frequency = $2
             AND amount = $3 AND due_date = $4 AND id > $5 ORDER BY id LIMIT 1)`,
        [bill.name, bill.frequency, bill.amount, nextDue, bill.id]
      );
    }
    return updated[0];
  });

  if (!bill) return res.status(404).json({ error: 'not found' });
  res.json(bill);
}));

router.patch('/:id', ah(async (req, res) => {
  const { name, amount, due_date, notes, has_gst, gst_pct } = req.body;
  if (req.body.category_id === undefined && req.body.category) req.body.category_id = await expenseCategoryFor(pool, req.body.category);
  const setsCategory = req.body.category_id !== undefined;
  const category = setsCategory ? await categoryName(req.body.category_id) : undefined;

  const { rows: currentRows } = await pool.query('SELECT * FROM bills WHERE id = $1', [req.params.id]);
  if (!currentRows.length) return res.status(404).json({ error: 'not found' });
  const current = currentRows[0];

  const touchesFinancials =
    amount !== undefined || due_date !== undefined || has_gst !== undefined || gst_pct !== undefined;
  if (current.status === 'paid' && touchesFinancials) {
    return res.status(409).json({
      error: 'This bill is already paid — its amount, due date, and GST are locked because a transaction already moved money based on them. Only name, category, notes, and owner can still be edited. To fix an amount, reverse the payment first.',
    });
  }

  // Owner tagging is categorization, not money — safe to change even on a
  // paid bill. But it's copied onto the linked transaction at pay time, so
  // an edit here is propagated there too, or the bill and its own
  // transaction would disagree about whose spend it is.
  const touchesSegment = SEGMENT_COLUMNS.some((c) => req.body[c] !== undefined);
  const effectiveSeg = {};
  for (const c of SEGMENT_COLUMNS) effectiveSeg[c] = req.body[c] !== undefined ? req.body[c] : current[c];
  if (touchesSegment) {
    const segmentError = validateSegment(effectiveSeg);
    if (segmentError) return res.status(400).json({ error: segmentError });
  }
  const segVals = segmentValues(effectiveSeg);
  const segSet = (start) => SEGMENT_COLUMNS.map((c, i) => `${c} = $${start + i}`).join(', ');

  const effectiveAmount = amount ?? current.amount;
  const effectiveHasGst = has_gst ?? current.has_gst;
  const effectiveGstPct = gst_pct ?? current.gst_pct;
  const { gst_amount, subtotal_amount } = splitGst(effectiveAmount, effectiveHasGst, effectiveGstPct);

  const bill = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE bills SET
         name = COALESCE($1, name),
         amount = COALESCE($2, amount),
         due_date = COALESCE($3, due_date),
         category = CASE WHEN $${11 + SEGMENT_COLUMNS.length} THEN $4 ELSE category END,
         category_id = CASE WHEN $${11 + SEGMENT_COLUMNS.length} THEN $${12 + SEGMENT_COLUMNS.length}::int ELSE category_id END,
         notes = COALESCE($5, notes),
         has_gst = $6,
         gst_pct = $7,
         gst_amount = $8,
         subtotal_amount = $9,
         ${segSet(10)}
       WHERE id = $${10 + SEGMENT_COLUMNS.length} RETURNING *`,
      [name, amount, due_date, category, notes, effectiveHasGst, effectiveGstPct, gst_amount, subtotal_amount,
       ...segVals, req.params.id, setsCategory, req.body.category_id || null]
    );
    const updated = rows[0];
    // The payment carries the bill's category when it had none of its own.
    if (setsCategory && updated.linked_transaction_id && req.body.category_id) {
      await client.query('UPDATE transactions SET category_id = $1 WHERE id = $2 AND category_id IS NULL AND NOT is_split',
        [req.body.category_id, updated.linked_transaction_id]);
    }

    if (touchesSegment && updated.linked_transaction_id) {
      await client.query(
        `UPDATE transactions SET ${segSet(1)} WHERE id = $${1 + SEGMENT_COLUMNS.length}`,
        [...segVals, updated.linked_transaction_id]
      );
    }
    return updated;
  });

  if (bill.status === 'unpaid') autoLinkBillsSoon();
  res.json(bill);
}));

router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM bills WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
