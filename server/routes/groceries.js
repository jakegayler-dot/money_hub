// Groceries page: spending by food type against a typical month, the price
// book (each item's price at each store), cost-cutting suggestions, and the
// catalogued lines of each receipt (lib/groceries.js).
import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { toISODate } from '../lib/dates.js';
import { grocerySummary, priceBook, latestAdvice, makeAdvice, backfillGroceries, backfillState, FOOD_TYPES, unitPrice, printedKey } from '../lib/groceries.js';
import { recheckReceiptDates } from '../lib/receiptDates.js';
import { getSetting } from '../db.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 12, 3), 36);
  const [summary, prices, advice, { rows: recent }, { rows: [waiting] }] = await Promise.all([
    grocerySummary({ months }), priceBook({}), latestAdvice(),
    pool.query(`SELECT g.receipt_id, g.date, g.store, COUNT(*) AS lines, SUM(g.amount) AS total, SUM(g.discount) AS saved
                FROM grocery_items g GROUP BY 1, 2, 3 ORDER BY g.date DESC, g.receipt_id DESC LIMIT 40`),
    pool.query(`SELECT COUNT(*) FILTER (WHERE grocery IS NULL AND extracted IS NOT NULL AND status NOT IN ('failed', 'not_receipt', 'reading')) AS unchecked,
                       COUNT(*) FILTER (WHERE grocery = 'failed') AS failed FROM receipts`),
  ]);
  const budget = await getSetting('grocery_budget_month', null);
  // What's inside each food type over the last six months: the items, most spent first.
  const { rows: items } = await pool.query(
    `SELECT food_type, item, SUM(amount) AS spent, COUNT(*) AS times, to_char(MAX(date), 'YYYY-MM-DD') AS last
     FROM grocery_items WHERE date >= CURRENT_DATE - 183 AND item <> 'unreadable' GROUP BY 1, 2 ORDER BY 3 DESC`);
  const topItems = {};
  for (const r of items) {
    const list = (topItems[r.food_type] = topItems[r.food_type] || []);
    if (list.length < 12) list.push({ item: r.item, spent: Number(r.spent), times: Number(r.times), last: r.last });
  }
  res.json({
    budget: budget == null || budget === '' ? null : Number(budget), top_items: topItems,
    summary, prices, advice, food_types: FOOD_TYPES, reader: !!process.env.ANTHROPIC_API_KEY,
    receipts: recent.map((r) => ({ id: r.receipt_id, date: toISODate(r.date), store: r.store, lines: Number(r.lines), total: Number(r.total), saved: Number(r.saved) })),
    backfill: { ...backfillState(), unchecked: Number(waiting.unchecked), failed: Number(waiting.failed) },
  });
}));

router.get('/receipts/:id', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM grocery_items WHERE receipt_id = $1 ORDER BY id', [req.params.id]);
  res.json(rows.map((r) => ({ ...r, date: toISODate(r.date) })));
}));

// Fix a line the reader got wrong. The same printed line at the same store is
// fixed everywhere, so the price book stays tidy.
router.patch('/items/:id', ah(async (req, res) => {
  const { rows: [g] } = await pool.query('SELECT * FROM grocery_items WHERE id = $1', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const item = req.body.item != null ? String(req.body.item).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80) : g.item;
  const foodType = req.body.food_type != null ? String(req.body.food_type) : g.food_type;
  if (!item) return res.status(422).json({ error: 'The item needs a name.' });
  if (!FOOD_TYPES.includes(foodType)) return res.status(422).json({ error: `Food type must be one of ${FOOD_TYPES.join(', ')}.` });
  const sizeValue = req.body.size_value !== undefined ? (req.body.size_value === null || req.body.size_value === '' ? null : Number(req.body.size_value)) : g.size_value;
  const sizeUnit = req.body.size_unit !== undefined ? (req.body.size_unit || null) : g.size_unit;
  const up = unitPrice({ amount: g.amount, qty: g.qty, size_value: sizeValue, size_unit: sizeUnit });
  await pool.query('UPDATE grocery_items SET size_value = $2, size_unit = $3, unit = $4, unit_price = $5 WHERE id = $1', [g.id, sizeValue, sizeUnit, up.unit, up.unit_price]);
  // Learned: the same printed line is this item on every receipt, past and future, at any store.
  const key = g.printed ? printedKey(g.printed) : null;
  if (key) {
    await pool.query(
      `INSERT INTO grocery_corrections (printed, item, food_type) VALUES ($1, $2, $3)
       ON CONFLICT (printed) DO UPDATE SET item = EXCLUDED.item, food_type = EXCLUDED.food_type, updated_at = now()`, [key, item, foodType]);
  }
  const { rows: same } = await pool.query('SELECT id, printed FROM grocery_items WHERE printed IS NOT NULL');
  const ids = [g.id, ...(key ? same.filter((x) => printedKey(x.printed) === key).map((x) => x.id) : [])];
  const { rowCount } = await pool.query('UPDATE grocery_items SET item = $2, food_type = $3 WHERE id = ANY($1::int[])', [ids, item, foodType]);
  res.json({ updated: rowCount });
}));

// The monthly grocery budget: a dollar amount, or null to use the typical month.
router.put('/budget', ah(async (req, res) => {
  const v = req.body?.budget === null || req.body?.budget === '' ? null : Number(req.body?.budget);
  if (v != null && (!Number.isFinite(v) || v < 0)) return res.status(400).json({ error: 'The budget is a dollar amount, or blank to use a typical month.' });
  await pool.query(`INSERT INTO settings (key, value) VALUES ('grocery_budget_month', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(v)]);
  res.json({ budget: v });
}));

// Re-check receipt dates read the wrong way round (day and month swapped), where the bank entry shows the real day.
router.post('/recheck-dates', ah(async (req, res) => { res.json({ changed: await recheckReceiptDates() }); }));

router.post('/advice', ah(async (req, res) => {
  try { res.json(await makeAdvice()); } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

// Catalogue past receipts (in the background; the page polls GET /).
router.post('/backfill', ah(async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'Set ANTHROPIC_API_KEY to read receipts.' });
  res.json(await backfillGroceries({ retryFailed: !!req.body?.retry_failed }));
}));

export default router;
