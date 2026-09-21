import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM accounts ORDER BY ledger, account_type');
  res.json(rows);
}));

router.post('/', ah(async (req, res) => {
  const {
    name, ledger, account_type, opening_balance = 0, source_system = 'manual',
    fee_amount = 0, fee_frequency = 'none', fee_notes = null,
  } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO accounts (name, ledger, account_type, opening_balance, source_system, fee_amount, fee_frequency, fee_notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [name, ledger, account_type, opening_balance, source_system, fee_amount, fee_frequency, fee_notes]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', ah(async (req, res) => {
  const { name, opening_balance, fee_amount, fee_frequency, fee_notes } = req.body;
  const { rows } = await pool.query(
    `UPDATE accounts SET
       name = COALESCE($1, name),
       opening_balance = COALESCE($2, opening_balance),
       fee_amount = COALESCE($3, fee_amount),
       fee_frequency = COALESCE($4, fee_frequency),
       fee_notes = COALESCE($5, fee_notes)
     WHERE id = $6 RETURNING *`,
    [name, opening_balance, fee_amount, fee_frequency, fee_notes, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

export default router;
