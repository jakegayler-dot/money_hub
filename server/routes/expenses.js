import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { allocateBySegment } from '../lib/segments.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM expense_categories ORDER BY class, name');
  res.json(rows);
}));

// Actual money spent this year, split across grain/livestock/personal —
// distinct from the budgeted `expense_categories` totals above. Reads
// every outflow transaction (bills paid + manual entries alike, since both
// land in `transactions`) and allocates it by segment, splitting a
// percentage-split transaction proportionally rather than double-counting
// it in every bucket.
router.get('/segment-totals', ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT amount, segment, is_segment_split, segment_grain_pct, segment_livestock_pct, segment_personal_pct
     FROM transactions
     WHERE amount < 0 AND EXTRACT(YEAR FROM date) = $1`,
    [year]
  );

  const totals = { grain: 0, livestock: 0, personal: 0, unassigned: 0 };
  for (const row of rows) {
    const allocated = allocateBySegment(row.amount, row);
    totals.grain += allocated.grain;
    totals.livestock += allocated.livestock;
    totals.personal += allocated.personal;
    totals.unassigned += allocated.unassigned;
  }
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] * 100) / 100;

  res.json({ year, totals });
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
