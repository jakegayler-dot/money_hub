// Financial statements (lib/financials.js; the balance sheet is
// routes/balanceSheet.js): GET /income-statement and /cash-flow for a
// calendar year (?year=2026) or a range (?from=&to=), and the inventory
// count that starts a period.
import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { incomeStatement, cashFlowStatement } from '../lib/financials.js';
import { todayISO } from '../lib/dates.js';

const router = Router();
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

/** The period asked for: ?year= or ?from=&to=; default this calendar year. */
function period(q) {
  if (q.from || q.to) {
    if (!isDate(q.from) || !isDate(q.to)) return { error: 'from and to are dates, YYYY-MM-DD.' };
    if (q.from > q.to) return { error: '"from" is after "to".' };
    return { from: q.from, to: q.to, year: null };
  }
  const year = Number(q.year) || Number(todayISO().slice(0, 4));
  if (year < 2000 || year > 2100) return { error: 'year looks wrong.' };
  return { from: `${year}-01-01`, to: `${year}-12-31`, year };
}

router.get('/income-statement', ah(async (req, res) => {
  const p = period(req.query);
  if (p.error) return res.status(400).json({ error: p.error });
  const current = await incomeStatement(p);
  // A calendar year comes with last year beside it.
  const prior = p.year ? await incomeStatement({ from: `${p.year - 1}-01-01`, to: `${p.year - 1}-12-31` }) : null;
  res.json({ ...current, year: p.year, prior });
}));

router.get('/cash-flow', ah(async (req, res) => {
  const p = period(req.query);
  if (p.error) return res.status(400).json({ error: p.error });
  res.json({ ...(await cashFlowStatement(p)), year: p.year });
}));

// An inventory count on a date (the year-end count):
// { date, grain, feed, market_cattle } — dollars at market value. Replaces any count for that day.
router.put('/inventory-count', ah(async (req, res) => {
  const b = req.body || {};
  if (!isDate(b.date)) return res.status(400).json({ error: 'date is YYYY-MM-DD.' });
  const vals = [['crop_feed', 'grain', b.grain], ['crop_feed', 'livestock', b.feed], ['market_livestock', 'livestock', b.market_cattle]];
  for (const [, , v] of vals) if (v != null && v !== '' && !(Number(v) >= 0)) return res.status(400).json({ error: 'Values are dollar amounts, zero or more.' });
  await pool.query(`DELETE FROM inventory_valuations WHERE date = $1 AND source = 'manual'`, [b.date]);
  for (const [cls, owner, v] of vals) {
    await pool.query(`INSERT INTO inventory_valuations (date, item_class, owner, value, source) VALUES ($1, $2, $3, $4, 'manual')`,
      [b.date, cls, owner, Number(v) || 0]);
  }
  res.json({ ok: true });
}));

router.get('/inventory-count', ah(async (req, res) => {
  if (!isDate(req.query.date)) return res.status(400).json({ error: 'date is YYYY-MM-DD.' });
  const { rows } = await pool.query(`SELECT item_class, owner, value FROM inventory_valuations WHERE date = $1 AND source = 'manual'`, [req.query.date]);
  const get = (c, o) => Number(rows.find((r) => r.item_class === c && r.owner === o)?.value ?? 0);
  res.json(rows.length ? { date: req.query.date, grain: get('crop_feed', 'grain'), feed: get('crop_feed', 'livestock'), market_cattle: get('market_livestock', 'livestock') } : null);
}));

export default router;
