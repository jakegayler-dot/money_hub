// Groceries page: spending by food type against a typical month, the price
// book (each item's price at each store), cost-cutting suggestions, and the
// catalogued lines of each receipt (lib/groceries.js).
import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { toISODate } from '../lib/dates.js';
import { grocerySummary, priceBook, latestAdvice, makeAdvice, backfillGroceries, backfillState, FOOD_TYPES, unitPrice } from '../lib/groceries.js';

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
  res.json({
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
  const { rowCount } = await pool.query(
    `UPDATE grocery_items SET item = $3, food_type = $4 WHERE id = $1 OR (printed IS NOT NULL AND printed = $2 AND store = $5)`,
    [g.id, g.printed, item, foodType, g.store]);
  res.json({ updated: rowCount });
}));

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
