import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { liquidityFloor } from '../lib/calculations.js';
import { loadForecast, requiredFloorFor } from '../lib/forecast.js';
import { runScenario, scenarioContext } from '../lib/scenario.js';

const router = Router();

// Forecast options from a query string or body: window, scope, accounts, tax.
function optionsFrom(src = {}) {
  const months = [12, 18, 24].includes(Number(src.months)) ? Number(src.months) : 12;
  const scope = ['everything', 'farm', 'personal'].includes(src.scope) ? src.scope : 'everything';
  let accounts = src.accounts;
  if (typeof accounts === 'string') accounts = accounts ? accounts.split(',') : null;
  accounts = Array.isArray(accounts) && accounts.length ? accounts.map(Number).filter(Boolean) : null;
  const includeTax = !(src.tax === '0' || src.tax === 0 || src.tax === false || src.include_tax === false);
  return { months, scope, accounts, includeTax };
}

// The cash forecast for a scope: GET /api/forecast?months=12&scope=farm&accounts=1,2&tax=1
router.get('/', ah(async (req, res) => {
  res.json(await liquidityFloor(optionsFrom(req.query)));
}));

// What can be re-priced, contracted, moved or deferred in a what-if.
router.get('/context', ah(async (req, res) => {
  const ctx = await loadForecast({ months: optionsFrom(req.query).months });
  res.json(scenarioContext(ctx));
}));

// Run a scenario: { scenario, months, scope, accounts, tax }.
router.post('/scenario', ah(async (req, res) => {
  const o = optionsFrom(req.body || {});
  const ctx = await loadForecast({ months: o.months });
  const floor = await requiredFloorFor(ctx.bufferPct);
  res.json(runScenario(ctx, req.body?.scenario || {}, { ...o, floor }));
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
