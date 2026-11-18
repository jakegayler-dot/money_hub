// The covered-call desk (lib/options; Jake, Nov 17).
//   GET    /api/options/rules              his rules        PUT /api/options/rules {…}
//   GET    /api/options/scan               the watchlist: moves, drop flags, expiries this week
//   GET    /api/options/alerts             drops the watcher noted
//   GET    /api/options/plan/:symbol       what his rules pick on it today (call, put, lots), ?overrides as query
//   GET    /api/options/strikes/:symbol    ?expiry= one expiry's calls and puts near the price
//   POST   /api/options/evaluate           { position } → max gain and loss, breakevens, income a day, the curve
//   GET/POST /api/options/positions, PATCH/DELETE /api/options/positions/:id
import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { SYMBOL } from '../lib/options/market.js';
import { evaluate, marketCalendar } from '../lib/options/strategy.js';
import { toISODate } from '../lib/dates.js';
import { usdCad } from '../lib/options/fx.js';
import { getRules, saveRules, scan, plan, strikes, alerts, positions, positionFields, lastSync, WIDE } from '../lib/options/desk.js';
import { optionCash, saveSource, tagEntry, untagEntry, insurance } from '../lib/options/cash.js';

const router = Router();
const sym = (s) => {
  const v = String(s || '').trim().toUpperCase();
  if (!SYMBOL.test(v)) throw Object.assign(new Error('A stock symbol, like NVDA.'), { status: 422 });
  return v;
};
const fail = (res, e) => res.status(e.status || 502).json({ error: e.message });

router.get('/fx', ah(async (req, res) => res.json(await usdCad())));
router.get('/hours', (req, res) => res.json(marketCalendar()));
router.get('/rules', ah(async (req, res) => res.json(await getRules())));
router.put('/rules', ah(async (req, res) => res.json(await saveRules(req.body || {}))));
router.get('/scan', ah(async (req, res) => { try { res.json(await scan()); } catch (e) { fail(res, e); } }));
router.get('/alerts', ah(async (req, res) => res.json(await alerts())));
router.get('/plan/:symbol', ah(async (req, res) => {
  try {
    const o = {};
    for (const [k, v] of Object.entries(req.query)) o[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
    res.json(await plan(sym(req.params.symbol), o));
  } catch (e) { fail(res, e); }
}));
router.get('/strikes/:symbol', ah(async (req, res) => {
  try { res.json(await strikes(sym(req.params.symbol), req.query.expiry ? String(req.query.expiry) : null)); } catch (e) { fail(res, e); }
}));
router.post('/evaluate', ah(async (req, res) => {
  const p = req.body?.position || {};
  if (!(Number(p.price) > 0)) return res.status(422).json({ error: 'The stock’s price is needed.' });
  const r = await getRules(); // his margin rule unless the position names its own
  res.json(evaluate(p, { margin: { pct: p.margin_pct ?? r.margin_pct, rate: p.margin_rate ?? r.margin_rate } }));
}));

// His option cash, from the brokerage entries already in Money Hub (lib/options/cash.js).
router.get('/cash', ah(async (req, res) => { const r = await getRules(); res.json(await optionCash({ symbols: [...r.watchlist, ...WIDE] })); }));
// The puts as insurance: what they cost, what the calls have paid back, the trading days left and the break-even.
router.get('/insurance', ah(async (req, res) => { try { res.json(await insurance()); } catch (e) { fail(res, e); } }));
router.put('/cash/source', ah(async (req, res) => { await saveSource(req.body || {}); res.json({ ok: true }); }));
router.put('/cash/:id', ah(async (req, res) => { try { res.json(await tagEntry(req.params.id, req.body || {})); } catch (e) { fail(res, e); } }));
router.delete('/cash/:id', ah(async (req, res) => res.json(await untagEntry(req.params.id))));

router.get('/sync', ah(async (req, res) => res.json(await lastSync())));
router.get('/positions', ah(async (req, res) => { try { res.json(await positions()); } catch (e) { fail(res, e); } }));
router.post('/positions', ah(async (req, res) => {
  try {
    const f = positionFields(req.body || {});
    const { rows: [r] } = await pool.query(
      `INSERT INTO options_positions (symbol, shares, cost, opened_on, legs, premium_collected, status, closed_on, closed_price, notes)
       VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7, $8, $9, $10) RETURNING id`,
      [f.symbol, f.shares, f.cost, f.opened_on, JSON.stringify(f.legs), f.premium_collected, f.status, f.closed_on, f.closed_price, f.notes]);
    res.status(201).json({ id: r.id });
  } catch (e) { fail(res, e); }
}));
router.patch('/positions/:id', ah(async (req, res) => {
  const { rows: [cur] } = await pool.query('SELECT * FROM options_positions WHERE id = $1', [Number(req.params.id)]);
  if (!cur) return res.status(404).json({ error: 'No such position' });
  try {
    const f = positionFields(req.body || {}, { ...cur, opened_on: toISODate(cur.opened_on), closed_on: toISODate(cur.closed_on) });
    await pool.query(
      `UPDATE options_positions SET symbol = $2, shares = $3, cost = $4, opened_on = COALESCE($5::date, opened_on), legs = $6, premium_collected = $7,
         status = $8, closed_on = $9, closed_price = $10, notes = $11 WHERE id = $1`,
      [cur.id, f.symbol, f.shares, f.cost, f.opened_on, JSON.stringify(f.legs), f.premium_collected, f.status, f.closed_on, f.closed_price, f.notes]);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
}));
router.delete('/positions/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM options_positions WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'No such position' });
  res.json({ ok: true });
}));

export default router;
