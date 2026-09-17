import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const { ledger, from, to, limit = 100 } = req.query;
  const conditions = [];
  const params = [];

  if (ledger) {
    params.push(ledger);
    conditions.push(`ledger = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`date <= $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Number(limit));

  const { rows } = await pool.query(
    `SELECT * FROM transactions ${where} ORDER BY date DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

// Manual entry — this is the v1 ingestion path. `is_mixed_use` +
// `mixed_use_business_pct` split cost basis between ledgers at entry time,
// so no post-hoc review-queue step is needed for v1.
router.post('/', ah(async (req, res) => {
  const {
    account_id, ledger, date, amount, description,
    category_id = null, purchase_class = null,
    is_mixed_use = false, mixed_use_business_pct = null,
    is_capex = false, entered_by = 'manual',
  } = req.body;

  const { rows } = await pool.query(
    `INSERT INTO transactions
      (account_id, ledger, date, amount, description, category_id,
       purchase_class, is_mixed_use, mixed_use_business_pct, is_capex, entered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [account_id, ledger, date, amount, description, category_id,
     purchase_class, is_mixed_use, mixed_use_business_pct, is_capex, entered_by]
  );
  res.status(201).json(rows[0]);
}));

export default router;
