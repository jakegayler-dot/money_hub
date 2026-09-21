import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';

const router = Router();

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
  } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO bills (name, ledger, category, amount, frequency, received_date, due_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, ledger, category, amount, frequency, received_date, due_date, notes]
  );
  res.status(201).json(rows[0]);
}));

// Marking a bill paid optionally links it to the ledger transaction that
// actually paid it, and — for a recurring bill — rolls the due date
// forward and re-opens it as unpaid, so a monthly/quarterly bill doesn't
// have to be re-entered by hand every cycle.
router.post('/:id/pay', ah(async (req, res) => {
  const { paid_date = new Date().toISOString().slice(0, 10), linked_transaction_id = null } = req.body;

  const { rows: existingRows } = await pool.query('SELECT * FROM bills WHERE id = $1', [req.params.id]);
  if (!existingRows.length) return res.status(404).json({ error: 'not found' });
  const bill = existingRows[0];

  await pool.query(
    `UPDATE bills SET status = 'paid', paid_date = $1, linked_transaction_id = $2 WHERE id = $3`,
    [paid_date, linked_transaction_id, bill.id]
  );

  if (bill.frequency === 'monthly' || bill.frequency === 'quarterly') {
    const monthsToAdd = bill.frequency === 'monthly' ? 1 : 3;
    const nextDue = new Date(bill.due_date);
    nextDue.setMonth(nextDue.getMonth() + monthsToAdd);
    const { rows: nextRows } = await pool.query(
      `INSERT INTO bills (name, ledger, category, amount, frequency, due_date, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'unpaid',$7) RETURNING *`,
      [bill.name, bill.ledger, bill.category, bill.amount, bill.frequency,
       nextDue.toISOString().slice(0, 10), bill.notes]
    );
    return res.json({ paid: bill.id, nextBill: nextRows[0] });
  }

  res.json({ paid: bill.id, nextBill: null });
}));

router.patch('/:id', ah(async (req, res) => {
  const { name, amount, due_date, category, notes } = req.body;
  const { rows } = await pool.query(
    `UPDATE bills SET
       name = COALESCE($1, name),
       amount = COALESCE($2, amount),
       due_date = COALESCE($3, due_date),
       category = COALESCE($4, category),
       notes = COALESCE($5, notes)
     WHERE id = $6 RETURNING *`,
    [name, amount, due_date, category, notes, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM bills WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
