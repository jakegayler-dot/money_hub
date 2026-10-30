import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { liquidityFloor } from '../lib/calculations.js';
import { loadForecast, SCOPES } from '../lib/forecast.js';
import { scenarioContext } from '../lib/scenario.js';
import { runAndJudge } from '../lib/purchaseCheck.js';
import { todayISO } from '../lib/dates.js';

/**
 * Months from this one through the end of the crop year being marketed:
 * the crop year runs Sep to Aug, so from September it's this coming August
 * (Sep → 12 months), and before September it's the August after next, the
 * crop still to be harvested (Jan → 20 months).
 */
export const cropYearMonths = (today = todayISO()) => 21 - Number(today.slice(5, 7));

const router = Router();

// Forecast options from a query string or body: window, scope, accounts, tax.
function optionsFrom(src = {}) {
  const months = src.months === 'crop' ? cropYearMonths() : [12, 18, 24].includes(Number(src.months)) ? Number(src.months) : 12;
  const scope = SCOPES.includes(src.scope) ? src.scope : 'everything';
  let accounts = src.accounts;
  if (typeof accounts === 'string') accounts = accounts ? accounts.split(',') : null;
  accounts = Array.isArray(accounts) && accounts.length ? accounts.map(Number).filter(Boolean) : null;
  // Tax predictions are left out unless asked for (Jake, 2026-10-24).
  const includeTax = src.tax === '1' || src.tax === 1 || src.tax === true || src.include_tax === true;
  return { months, scope, accounts, includeTax };
}

// The cash forecast for a scope: GET /api/forecast?months=12&scope=farm&accounts=1,2&tax=1
router.get('/', ah(async (req, res) => {
  res.json(await liquidityFloor(optionsFrom(req.query)));
}));

// The most the cash floor can be (Jake, Oct 27: 20k max): { cap } in dollars.
router.put('/floor-cap', ah(async (req, res) => {
  const cap = Number(req.body?.cap);
  if (!Number.isFinite(cap) || cap < 0) return res.status(400).json({ error: 'The floor cap is a dollar amount, zero or more.' });
  await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['floor_cap', JSON.stringify(Math.round(cap))]);
  res.json({ cap: Math.round(cap) });
}));

// What can be re-priced, contracted, moved or deferred in a what-if.
router.get('/context', ah(async (req, res) => {
  const ctx = await loadForecast({ months: optionsFrom(req.query).months });
  res.json(scenarioContext(ctx));
}));

// Run a scenario: { scenario, months, scope, accounts, tax }.
router.post('/scenario', ah(async (req, res) => {
  // With a purchase or new loan in it, the result carries the verdict.
  res.json(await runAndJudge(req.body?.scenario || {}, optionsFrom(req.body || {})));
}));

// Saved scenarios.
router.get('/scenarios', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, data, updated_at FROM forecast_scenarios ORDER BY lower(name)');
  res.json(rows);
}));
router.post('/scenarios', ah(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the scenario a name.' });
  const { rows: [row] } = await pool.query(
    'INSERT INTO forecast_scenarios (name, data) VALUES ($1, $2) RETURNING id, name, data, updated_at', [name, req.body?.data || {}]);
  res.status(201).json(row);
}));
router.put('/scenarios/:id', ah(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the scenario a name.' });
  const { rows: [row] } = await pool.query(
    'UPDATE forecast_scenarios SET name = $1, data = $2, updated_at = now() WHERE id = $3 RETURNING id, name, data, updated_at',
    [name, req.body?.data || {}, req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  res.json(row);
}));
router.delete('/scenarios/:id', ah(async (req, res) => {
  await pool.query('DELETE FROM forecast_scenarios WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

export default router;
