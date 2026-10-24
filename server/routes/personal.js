import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { personalPlan, spendingBreakdown } from '../lib/personal.js';
import { ownerCheck } from '../lib/ownerCheck.js';
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

// Where household spending went: ?from=YYYY-MM-DD&to=YYYY-MM-DD (to exclusive; default the last 12 months).
router.get('/breakdown', ah(async (req, res) => {
  const today = todayISO();
  const iso = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null);
  const to = iso(req.query.to) || new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const from = iso(req.query.from) || `${Number(today.slice(0, 4)) - 1}${today.slice(4, 7)}-01`;
  res.json(await spendingBreakdown({ from, to, today }));
}));

// { savings_pct, cap, mode: 'actual'|'plan', monthly_budget } — cap / monthly_budget null or '' for none.
router.put('/settings', ah(async (req, res) => {
  const b = req.body || {};
  if (b.savings_pct !== undefined) {
    const pct = Number(b.savings_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: 'Savings is a percentage from 0 to 100.' });
    await setSetting('personal_savings_pct', pct);
  }
  if (b.mode !== undefined) {
    if (!['actual', 'plan'].includes(b.mode)) return res.status(400).json({ error: 'mode is actual or plan.' });
    await setSetting('personal_budget_mode', b.mode);
  }
  if (b.monthly_budget !== undefined) {
    const v = b.monthly_budget === null || b.monthly_budget === '' ? null : Number(b.monthly_budget);
    if (v != null && (!Number.isFinite(v) || v < 0)) return res.status(400).json({ error: 'The monthly budget is a dollar amount, or blank to use what you actually spend.' });
    await setSetting('personal_discretionary_month', v);
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

// Spending counted as farm that's probably household (lib/ownerCheck.js).
router.get('/owner-check', ah(async (req, res) => { res.json(await ownerCheck()); }));

// A person settled this entry's owner (after setting it, or "farm is right").
router.post('/owner-check/:id/confirm', ah(async (req, res) => {
  const { rowCount } = await pool.query('UPDATE transactions SET owner_confirmed = true WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
}));

export default router;
