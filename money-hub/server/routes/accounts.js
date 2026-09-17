import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM accounts ORDER BY ledger, account_type');
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { name, ledger, account_type, opening_balance = 0, source_system = 'manual' } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO accounts (name, ledger, account_type, opening_balance, source_system)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, ledger, account_type, opening_balance, source_system]
  );
  res.status(201).json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const { name, opening_balance } = req.body;
  const { rows } = await pool.query(
    `UPDATE accounts SET name = COALESCE($1, name), opening_balance = COALESCE($2, opening_balance)
     WHERE id = $3 RETURNING *`,
    [name, opening_balance, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

export default router;
