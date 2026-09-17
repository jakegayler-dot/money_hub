import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM expense_categories ORDER BY class, name');
  res.json(rows);
}));

const EVEN_MONTHLY_PCT = [0.0833,0.0833,0.0834,0.0833,0.0833,0.0834,0.0833,0.0833,0.0834,0.0833,0.0833,0.0834];

router.post('/', ah(async (req, res) => {
  const { name, class: klass, ledger = 'business', annual_total = 0, monthly_pct = EVEN_MONTHLY_PCT } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO expense_categories (name, class, ledger, annual_total, monthly_pct)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [name, klass, ledger, annual_total, JSON.stringify(monthly_pct)]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', ah(async (req, res) => {
  const { annual_total, monthly_pct } = req.body;
  const { rows } = await pool.query(
    `UPDATE expense_categories
     SET annual_total = COALESCE($1, annual_total),
         monthly_pct = COALESCE($2, monthly_pct)
     WHERE id = $3 RETURNING *`,
    [annual_total, monthly_pct ? JSON.stringify(monthly_pct) : null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

export default router;
