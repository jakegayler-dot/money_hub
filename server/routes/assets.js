import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { validateSegment, segmentValues, SEGMENT_COLUMNS } from '../lib/segments.js';
import { loadBalanceSheet } from '../lib/balanceSheet.js';
import { toISODate } from '../lib/dates.js';

const router = Router();
const CATEGORIES = ['land', 'buildings', 'machinery', 'vehicles', 'breeding_livestock', 'investments', 'other'];

// Assets with value rolled to today and 12 months out, their linked
// loans, and equity now and in 12 months.
router.get('/', ah(async (req, res) => {
  const { assets } = await loadBalanceSheet();
  res.json(assets);
}));

function validate(a) {
  if (!a.name) return 'name is required';
  if (a.category && !CATEGORIES.includes(a.category)) return `category must be one of ${CATEGORIES.join(', ')}`;
  if (a.value == null || Number.isNaN(Number(a.value))) return 'value is required';
  if (a.annual_change_pct != null && Number(a.annual_change_pct) <= -100) return 'annual change must be above -100%';
  return validateSegment(a);
}

// loan_ids (optional) = the full set of loans secured by this asset; loans
// not in the list are unlinked from it. Omit the field to leave links alone.
async function setLinkedLoans(client, assetId, loanIds) {
  if (!Array.isArray(loanIds)) return;
  await client.query(`UPDATE loans SET asset_id = NULL WHERE asset_id = $1 AND NOT (id = ANY($2::int[]))`, [assetId, loanIds]);
  if (loanIds.length) await client.query(`UPDATE loans SET asset_id = $1 WHERE id = ANY($2::int[])`, [assetId, loanIds]);
}

const COLS = ['name', 'category', 'value', 'value_date', 'annual_change_pct', 'cca_class', 'notes', ...SEGMENT_COLUMNS];
const values = (a) => [
  a.name, a.category || 'other', Number(a.value), toISODate(a.value_date) || new Date().toISOString().slice(0, 10),
  Number(a.annual_change_pct) || 0, a.cca_class || null, a.notes || null, ...segmentValues(a),
];

router.post('/', ah(async (req, res) => {
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  const row = await withTransaction(async (client) => {
    const v = values(req.body);
    const { rows } = await client.query(
      `INSERT INTO assets (${COLS.join(', ')}) VALUES (${v.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, v
    );
    await setLinkedLoans(client, rows[0].id, req.body.loan_ids);
    return rows[0];
  });
  res.status(201).json(row);
}));

router.patch('/:id', ah(async (req, res) => {
  const { rows: cur } = await pool.query('SELECT * FROM assets WHERE id = $1', [req.params.id]);
  if (!cur.length) return res.status(404).json({ error: 'not found' });
  const merged = { ...cur[0] };
  for (const [k, v] of Object.entries(req.body)) if (v !== undefined) merged[k] = v;
  const err = validate(merged);
  if (err) return res.status(400).json({ error: err });
  const row = await withTransaction(async (client) => {
    const v = values(merged);
    const { rows } = await client.query(
      `UPDATE assets SET ${COLS.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${COLS.length + 1} RETURNING *`,
      [...v, req.params.id]
    );
    await setLinkedLoans(client, rows[0].id, req.body.loan_ids);
    return rows[0];
  });
  res.json(row);
}));

// Loans secured by a deleted asset are unlinked (ON DELETE SET NULL), not deleted.
router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM assets WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
