import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { personalPlan } from '../lib/personal.js';
import { todayISO } from '../lib/dates.js';

const router = Router();
const setSetting = (key, value) => pool.query(
  'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);

// The household's plan for the year: profit down to the discretionary limit,
// essentials, and each month's spending against the budget.
router.get('/', ah(async (req, res) => {
  const year = Number(req.query.year) || Number(todayISO().slice(0, 4));
  res.json(await personalPlan(year));
}));

// { savings_pct, cap } — cap null or '' for no cap.
router.put('/settings', ah(async (req, res) => {
  const b = req.body || {};
  if (b.savings_pct !== undefined) {
    const pct = Number(b.savings_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: 'Savings is a percentage from 0 to 100.' });
    await setSetting('personal_savings_pct', pct);
  }
  if (b.cap !== undefined) {
    const cap = b.cap === null || b.cap === '' ? null : Number(b.cap);
    if (cap != null && (!Number.isFinite(cap) || cap < 0)) return res.status(400).json({ error: 'The cap is a dollar amount, or blank for none.' });
    await setSetting('personal_discretionary_cap', cap);
  }
  res.json(await personalPlan(Number(todayISO().slice(0, 4))));
}));

// A category's bucket: 'essential', 'discretionary', or null to go back to the default.
router.put('/categories/:id', ah(async (req, res) => {
  const bucket = req.body?.bucket ?? null;
  if (bucket !== null && !['essential', 'discretionary'].includes(bucket)) return res.status(400).json({ error: 'essential or discretionary' });
  const { rowCount } = await pool.query('UPDATE expense_categories SET personal_bucket = $2 WHERE id = $1', [req.params.id, bucket]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.json(await personalPlan(Number(todayISO().slice(0, 4))));
}));

export default router;
