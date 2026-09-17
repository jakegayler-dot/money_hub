import { Router } from 'express';
import { pool } from '../db.js';
import { reserveStatus } from '../lib/calculations.js';
import { ah } from '../lib/asyncHandler.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM owner_draws ORDER BY date DESC');
  res.json(rows);
}));

// The draw amount is fixed and reviewed on schedule — this endpoint records
// the transfer, it does not resize the draw. Resizing is a deliberate,
// separate action (see PATCH on a future /draw-policy resource).
router.post('/', ah(async (req, res) => {
  const { date, amount, note = null } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO owner_draws (date, amount, note) VALUES ($1,$2,$3) RETURNING *`,
    [date, amount, note]
  );
  res.status(201).json(rows[0]);
}));

router.get('/reserve', ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  res.json(await reserveStatus(year));
}));

// Surplus-to-reserve sweep in a strong month, or a draw-out when the
// reserve covers a shortfall — the fixed monthly draw itself never changes.
router.post('/reserve/transfer', ah(async (req, res) => {
  const { date, amount, direction, note = null } = req.body; // direction: sweep_in | draw_out
  const { rows } = await pool.query(
    `INSERT INTO reserve_transfers (date, amount, direction, note) VALUES ($1,$2,$3,$4) RETURNING *`,
    [date, amount, direction, note]
  );
  res.status(201).json(rows[0]);
}));

export default router;
