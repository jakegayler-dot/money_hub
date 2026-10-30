import { Router } from 'express';
import { pool, getSetting } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { requireIngestKey } from '../lib/ingestAuth.js';
import { loadLandRent } from '../lib/landRent.js';

// Land rent (lib/landRent.js): the page, Quarter Section's rented fields coming in, and linking a payee to a landlord.
const router = Router();
const save = (key, value) => pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, JSON.stringify(value)]);
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

router.get('/rent', ah(async (req, res) => { res.json(await loadLandRent()); }));

// Quarter Section sends every rented and crop-share field each time it sends its crop plan; the last one stands.
router.post('/ingest', requireIngestKey, ah(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'items (a list of fields) is required' });
  const clean = items.filter((f) => f && f.field).slice(0, 500).map((f) => ({
    field: String(f.field).slice(0, 120), farm: f.farm ? String(f.farm).slice(0, 120) : null, landlord: f.landlord ? String(f.landlord).slice(0, 120) : null,
    tenure: ['rented', 'cropshare'].includes(f.tenure) ? f.tenure : 'rented', acres: num(f.acres), acres_total: num(f.acres_total),
    rent_per_acre: num(f.rent_per_acre), crop_share_pct: num(f.crop_share_pct), included: f.included !== false,
  }));
  await save('qs_rented_land', { at: new Date().toISOString(), source: String(req.body.source || 'quarter-section'), items: clean });
  res.json({ ok: true, fields: clean.length });
}));

// { payee, landlord } — landlord '' means "no Quarter Section land", null goes back to matching by name.
router.put('/alias', ah(async (req, res) => {
  const payee = String(req.body?.payee || '').trim();
  if (!payee) return res.status(400).json({ error: 'payee is required' });
  const alias = { ...((await getSetting('land_landlord_alias', {})) || {}) };
  if (req.body.landlord === null || req.body.landlord === undefined) delete alias[payee];
  else alias[payee] = String(req.body.landlord).slice(0, 120);
  await save('land_landlord_alias', alias);
  res.json(await loadLandRent());
}));

export default router;
