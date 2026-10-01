import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { ownerWeights, OWNERS } from '../lib/segments.js';
import { payeeId } from '../lib/postings.js';

// Who was paid, or who paid: Cargill, Viterra, the auction mart, Co-op.
const router = Router();

router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, COUNT(t.id)::int AS uses
     FROM payees p LEFT JOIN transactions t ON t.payee_id = p.id
     GROUP BY p.id ORDER BY lower(p.name)`
  );
  res.json(rows);
}));

// Find-or-create by name (case-insensitive), so "cargill" and "Cargill"
// are one payee.
router.post('/', ah(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = await payeeId(pool, name);
  const { rows } = await pool.query('SELECT id, name FROM payees WHERE id = $1', [id]);
  res.status(201).json(rows[0]);
}));

router.patch('/:id', ah(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows: clash } = await pool.query('SELECT id FROM payees WHERE lower(name) = lower($1) AND id <> $2', [name, req.params.id]);
  if (clash.length) return res.status(409).json({ error: `"${name}" already exists.` });
  const { rows } = await pool.query('UPDATE payees SET name = $1 WHERE id = $2 RETURNING id, name', [name, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

// Totals by payee for one year: kind=expense (default) is money paid out,
// kind=income money received. Split pieces count at their own amounts and
// owners; transfers and loan payments are left out, like every other
// income/expense figure.
router.get('/totals', ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const owner = String(req.query.owner || 'all');
  if (owner !== 'all' && !OWNERS.includes(owner)) return res.status(400).json({ error: `owner must be all, ${OWNERS.join(', ')}` });
  const income = req.query.kind === 'income';
  const { rows } = await pool.query(
    `SELECT l.amount, l.segment, l.is_segment_split, l.segment_grain_pct, l.segment_livestock_pct,
            l.segment_jake_pct, l.segment_ashley_pct, t.payee_id, p.name AS payee
     FROM transaction_lines l
     JOIN transactions t ON t.id = l.transaction_id
     LEFT JOIN payees p ON p.id = t.payee_id
     WHERE l.is_transfer = false AND l.is_debt_service = false AND EXTRACT(YEAR FROM l.date) = $1
       AND ${income ? 'l.amount > 0' : 'l.amount < 0'}`,
    [year]
  );
  const by = new Map();
  for (const r of rows) {
    const w = owner === 'all' ? 1 : ownerWeights(r)[owner];
    if (!w) continue;
    const key = r.payee_id || 0;
    if (!by.has(key)) by.set(key, { payee_id: r.payee_id, name: r.payee || 'No payee recorded', total: 0, count: 0 });
    const e = by.get(key);
    e.total += Math.abs(Number(r.amount)) * w;
    e.count += 1;
  }
  const list = [...by.values()].map((e) => ({ ...e, total: Math.round(e.total * 100) / 100 }))
    .sort((a, b) => (!a.payee_id - !b.payee_id) || (b.total - a.total)); // "No payee recorded" last
  res.json({ year, owner, kind: income ? 'income' : 'expense', total: Math.round(list.reduce((s, e) => s + e.total, 0) * 100) / 100, payees: list });
}));

export default router;
