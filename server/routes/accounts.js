import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { validateSegment, segmentValues, SEGMENT_COLUMNS } from '../lib/segments.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM accounts ORDER BY ledger, account_type');
  res.json(rows);
}));

// The owner fields on an account attribute its STARTING balance (what was
// in it before any transactions were recorded here) — see the accounts
// ownership comment in schema.sql.
router.post('/', ah(async (req, res) => {
  const {
    name, ledger, account_type, opening_balance = 0, source_system = 'manual',
    fee_amount = 0, fee_frequency = 'none', fee_notes = null,
  } = req.body;
  const segmentError = validateSegment(req.body);
  if (segmentError) return res.status(400).json({ error: segmentError });

  const { rows } = await pool.query(
    `INSERT INTO accounts
      (name, ledger, account_type, opening_balance, source_system, fee_amount, fee_frequency, fee_notes,
       ${SEGMENT_COLUMNS.join(', ')})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${SEGMENT_COLUMNS.map((_, i) => `$${9 + i}`).join(', ')}) RETURNING *`,
    [name, ledger, account_type, opening_balance, source_system, fee_amount, fee_frequency, fee_notes,
     ...segmentValues(req.body)]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', ah(async (req, res) => {
  const { name, opening_balance, fee_amount, fee_frequency, fee_notes } = req.body;

  const { rows: currentRows } = await pool.query('SELECT * FROM accounts WHERE id = $1', [req.params.id]);
  if (!currentRows.length) return res.status(404).json({ error: 'not found' });
  const current = currentRows[0];

  const effectiveSeg = {};
  for (const c of SEGMENT_COLUMNS) effectiveSeg[c] = req.body[c] !== undefined ? req.body[c] : current[c];
  const segmentError = validateSegment(effectiveSeg);
  if (segmentError) return res.status(400).json({ error: segmentError });

  const { rows } = await pool.query(
    `UPDATE accounts SET
       name = COALESCE($1, name),
       opening_balance = COALESCE($2, opening_balance),
       fee_amount = COALESCE($3, fee_amount),
       fee_frequency = COALESCE($4, fee_frequency),
       fee_notes = COALESCE($5, fee_notes),
       ${SEGMENT_COLUMNS.map((c, i) => `${c} = $${6 + i}`).join(', ')}
     WHERE id = $${6 + SEGMENT_COLUMNS.length} RETURNING *`,
    [name, opening_balance, fee_amount, fee_frequency, fee_notes, ...segmentValues(effectiveSeg), req.params.id]
  );
  res.json(rows[0]);
}));

export default router;
