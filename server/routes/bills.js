import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';

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

// Default view: unpaid bills first (soonest due first), then paid history.
router.get('/', ah(async (req, res) => {
  const { status } = req.query;
  const where = status ? 'WHERE status = $1' : '';
  const params = status ? [status] : [];
  const { rows } = await pool.query(
    `SELECT * FROM bills ${where} ORDER BY (status = 'unpaid') DESC, due_date ASC`,
    params
  );
  res.json(rows);
}));

router.post('/', ah(async (req, res) => {
  const {
    name, ledger = 'business', category = null, amount, frequency = 'one_time',
    received_date = null, due_date, notes = null,
    has_gst = false, gst_pct = 5,
  } = req.body;
  // Empty strings from an optional form field are not valid DATE input —
  // coerce them (and empty text) to NULL rather than letting the insert fail.
  const { gst_amount, subtotal_amount } = splitGst(amount, has_gst, gst_pct);
  const { rows } = await pool.query(
    `INSERT INTO bills (name, ledger, category, amount, frequency, received_date, due_date, notes, has_gst, gst_pct, gst_amount, subtotal_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [name, ledger, category || null, amount, frequency, received_date || null, due_date, notes || null,
     !!has_gst, gst_pct, gst_amount, subtotal_amount]
  );
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
    paid_date = new Date().toISOString().slice(0, 10),
    account_id = null,
    paid_by_check = false,
  } = req.body;

  const bill = await withTransaction(async (client) => {
    const { rows: existingRows } = await client.query('SELECT * FROM bills WHERE id = $1', [req.params.id]);
    if (!existingRows.length) return null;
    const bill = existingRows[0];
    if (bill.status === 'paid') return bill;

    let linkedTransactionId = null;
    if (account_id) {
      // A check hits the account balance the moment it's sent (book
      // balance), but `cleared` stays false until it's reconciled against
      // the bank statement — see the `cleared` column comment in schema.sql.
      const { rows: txRows } = await client.query(
        `INSERT INTO transactions (account_id, ledger, date, amount, description, entered_by, cleared, cleared_date)
         VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7) RETURNING id`,
        [account_id, bill.ledger, paid_date, -Math.abs(Number(bill.amount)),
         `Bill paid: ${bill.name}${paid_by_check ? ' (check)' : ''}`,
         !paid_by_check, paid_by_check ? null : paid_date]
      );
      linkedTransactionId = txRows[0].id;
      await client.query(
        `UPDATE accounts SET opening_balance = opening_balance - $1 WHERE id = $2`,
        [Math.abs(Number(bill.amount)), account_id]
      );
    }

    await client.query(
      `UPDATE bills SET status = 'paid', paid_date = $1, linked_transaction_id = $2 WHERE id = $3`,
      [paid_date, linkedTransactionId, bill.id]
    );
    return { ...bill, status: 'paid', paid_date, linked_transaction_id: linkedTransactionId };
  });

  if (!bill) return res.status(404).json({ error: 'not found' });

  if (bill.frequency === 'monthly' || bill.frequency === 'quarterly') {
    const monthsToAdd = bill.frequency === 'monthly' ? 1 : 3;
    const nextDue = new Date(bill.due_date);
    nextDue.setMonth(nextDue.getMonth() + monthsToAdd);
    const { rows: nextRows } = await pool.query(
      `INSERT INTO bills (name, ledger, category, amount, frequency, due_date, status, notes, has_gst, gst_pct, gst_amount, subtotal_amount)
       VALUES ($1,$2,$3,$4,$5,$6,'unpaid',$7,$8,$9,$10,$11) RETURNING *`,
      [bill.name, bill.ledger, bill.category, bill.amount, bill.frequency,
       nextDue.toISOString().slice(0, 10), bill.notes,
       bill.has_gst, bill.gst_pct, bill.gst_amount, bill.subtotal_amount]
    );
    return res.json({ paid: bill.id, nextBill: nextRows[0] });
  }

  res.json({ paid: bill.id, nextBill: null });
}));

router.patch('/:id', ah(async (req, res) => {
  const { name, amount, due_date, category, notes, has_gst, gst_pct } = req.body;

  // Recompute the GST split whenever amount, has_gst, or gst_pct changes —
  // read the current row first so partial edits keep the values not sent.
  const { rows: currentRows } = await pool.query('SELECT * FROM bills WHERE id = $1', [req.params.id]);
  if (!currentRows.length) return res.status(404).json({ error: 'not found' });
  const current = currentRows[0];
  const effectiveAmount = amount ?? current.amount;
  const effectiveHasGst = has_gst ?? current.has_gst;
  const effectiveGstPct = gst_pct ?? current.gst_pct;
  const { gst_amount, subtotal_amount } = splitGst(effectiveAmount, effectiveHasGst, effectiveGstPct);

  const { rows } = await pool.query(
    `UPDATE bills SET
       name = COALESCE($1, name),
       amount = COALESCE($2, amount),
       due_date = COALESCE($3, due_date),
       category = COALESCE($4, category),
       notes = COALESCE($5, notes),
       has_gst = $6,
       gst_pct = $7,
       gst_amount = $8,
       subtotal_amount = $9
     WHERE id = $10 RETURNING *`,
    [name, amount, due_date, category, notes, effectiveHasGst, effectiveGstPct, gst_amount, subtotal_amount, req.params.id]
  );
  res.json(rows[0]);
}));

router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM bills WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
