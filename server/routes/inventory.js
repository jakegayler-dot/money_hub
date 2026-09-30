import { Router } from 'express';
import { pool, getSetting } from '../db.js';
import { FALLBACK_KEY, nextMonthDay } from '../lib/inventoryForecast.js';
import { ah } from '../lib/asyncHandler.js';
import { requireIngestKey } from '../lib/ingestAuth.js';
import { loadBalanceSheet } from '../lib/balanceSheet.js';
import { OWNERS } from '../lib/segments.js';
import { todayISO, toISODate } from '../lib/dates.js';

const router = Router();
const CLASSES = ['crop', 'forage', 'market_livestock', 'breeding_livestock', 'other'];
const isNum = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));

router.get('/', ah(async (req, res) => {
  const { inventoryGroups, inventoryRows } = await loadBalanceSheet();
  res.json({ groups: inventoryGroups, items: inventoryRows });
}));

function validate(it) {
  if (!it.commodity) return 'commodity is required';
  if (!isNum(it.quantity) || Number(it.quantity) < 0) return 'quantity is required (0 or more)';
  if (!it.unit) return 'unit is required (bu, tonnes, bales, head...)';
  if (it.price_per_unit != null && it.price_per_unit !== '' && (!isNum(it.price_per_unit) || Number(it.price_per_unit) < 0)) {
    return 'price_per_unit must be a number if sent — omit it only if the item has no estimate (it then counts at $0)';
  }
  if (it.item_class && !CLASSES.includes(it.item_class)) return `item_class must be one of ${CLASSES.join(', ')}`;
  if (isNum(it.quantity_contracted) && Number(it.quantity_contracted) > Number(it.quantity)) return 'quantity_contracted is more than quantity';
  if (it.segment && !OWNERS.includes(it.segment)) return `segment must be one of ${OWNERS.join(', ')}`;
  if (it.expected_sale_date && !/^\d{4}-\d{2}-\d{2}$/.test(String(it.expected_sale_date).slice(0, 10))) return 'expected_sale_date must be YYYY-MM-DD';
  return null;
}

const COLS = `source, external_id, item_class, commodity, quantity, unit, quantity_contracted, price_per_unit, location, as_of, segment, notes, expected_sale_date`;
const values = (it) => [
  it.source || 'manual', it.external_id || null, it.item_class || 'crop', it.commodity, Number(it.quantity), it.unit,
  isNum(it.quantity_contracted) ? Number(it.quantity_contracted) : null,
  isNum(it.price_per_unit) ? Number(it.price_per_unit) : null,
  it.location || null, it.as_of || todayISO(), it.segment || null, it.notes || null, it.expected_sale_date || null,
];

// ---- Automated ingest -------------------------------------------------
// For Quarter Section (grain bins, bale stacks) and Livestock Manager
// (herd). Upserts on (source, external_id).
//
// Snapshot mode — { source, snapshot: true, items } — also DELETES this
// source's items missing from the push: inventory is a current-state
// count, so an emptied bin or a fed-out bale stack must stop counting.
// Add "scope": ["crop"] (or ["forage"], or both) to limit that cleanup to
// those item classes, so a system can push grain and bales on separate
// schedules without one push deleting the other's items. Items outside
// the scope are rejected in a scoped push.
// Guard: an empty snapshot is refused unless confirm_empty is true, so a
// broken export can't silently zero out the farm.
router.post('/ingest', requireIngestKey, ah(async (req, res) => {
  const body = req.body;
  const snapshot = !Array.isArray(body) && body && body.snapshot === true;
  const items = Array.isArray(body) ? body : (body.items || [body]);
  const snapshotSource = snapshot ? body.source : null;
  const scope = snapshot && Array.isArray(body.scope) && body.scope.length ? body.scope : null;
  if (snapshot && !snapshotSource) return res.status(400).json({ error: 'snapshot mode requires a top-level "source"' });
  if (scope && scope.some((c) => !CLASSES.includes(c))) return res.status(400).json({ error: `scope entries must be item classes: ${CLASSES.join(', ')}` });
  if (snapshot && items.length === 0 && body.confirm_empty !== true) {
    return res.status(400).json({ error: 'Empty snapshot refused — it would delete this source\'s inventory. Send confirm_empty: true if that is really intended.' });
  }

  const results = [];
  // Every external_id in the payload counts as PRESENT, whether or not it
  // saved: a snapshot removes only what's absent from the push. An item
  // that failed validation keeps its previous values instead of being
  // deleted because of one bad field.
  const seen = items.map((raw) => raw && raw.external_id).filter(Boolean);
  let accepted = 0;
  for (const raw of items) {
    const it = { ...raw, source: snapshotSource || raw.source || 'ingest' };
    if (!it.external_id) { results.push({ ok: false, error: 'external_id is required for pushed inventory' }); continue; }
    if (scope && !scope.includes(it.item_class || 'crop')) {
      results.push({ external_id: it.external_id, ok: false, error: `item_class "${it.item_class || 'crop'}" is outside this push's scope (${scope.join(', ')})` });
      continue;
    }
    const err = validate(it);
    if (err) { results.push({ external_id: it.external_id, ok: false, error: err }); continue; }
    const v = values(it);
    const { rows } = await pool.query(
      `INSERT INTO inventory_items (${COLS}) VALUES (${v.map((_, i) => `$${i + 1}`).join(',')})
       ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
         item_class = EXCLUDED.item_class, commodity = EXCLUDED.commodity, quantity = EXCLUDED.quantity,
         unit = EXCLUDED.unit, quantity_contracted = EXCLUDED.quantity_contracted,
         price_per_unit = EXCLUDED.price_per_unit, location = EXCLUDED.location, as_of = EXCLUDED.as_of,
         segment = EXCLUDED.segment, notes = EXCLUDED.notes, expected_sale_date = EXCLUDED.expected_sale_date, updated_at = now()
       RETURNING id, price_per_unit`,
      v
    );
    accepted++;
    results.push({ external_id: it.external_id, ok: true, id: rows[0].id, priced_by: rows[0].price_per_unit != null ? 'source' : 'missing — counted at $0' });
  }

  // A push where nothing was accepted removes nothing — an export that
  // sends only broken rows must not zero out the farm.
  let removed = 0;
  let skippedCleanup = false;
  if (snapshot && accepted === 0 && items.length > 0) skippedCleanup = true;
  if (snapshot && !skippedCleanup) {
    const params = [snapshotSource, seen];
    let classFilter = '';
    if (scope) { params.push(scope); classFilter = `AND item_class::text = ANY($3::text[])`; }
    const { rowCount } = await pool.query(
      `DELETE FROM inventory_items
       WHERE source = $1 AND external_id IS NOT NULL AND NOT (external_id = ANY($2::text[])) ${classFilter}`,
      params
    );
    removed = rowCount;
  }

  // Flag anything pushed without a price, so the pushing system (and
  // whoever reads its logs) knows it's counting at $0 — Money Hub has no
  // price list to fall back on; the estimate belongs in the manager.
  const pushedSources = new Set(items.map((raw) => snapshotSource || raw.source || 'ingest'));
  const { inventoryGroups } = await loadBalanceSheet();
  const unpriced = inventoryGroups
    .filter((g) => g.needs_price > 0 && g.items.some((i) => pushedSources.has(i.source)))
    .map((g) => `${g.commodity} (${g.unit})`);
  res.json({
    received: items.length, results, removed_missing_from_snapshot: removed,
    ...(skippedCleanup ? { snapshot_cleanup_skipped: 'no items were accepted, so nothing was removed' } : {}),
    needs_price: unpriced,
  });
}));

router.post('/', ah(async (req, res) => {
  const it = { ...req.body, source: 'manual', external_id: null };
  const err = validate(it);
  if (err) return res.status(400).json({ error: err });
  const v = values(it);
  const { rows } = await pool.query(
    `INSERT INTO inventory_items (${COLS}) VALUES (${v.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, v
  );
  res.status(201).json(rows[0]);
}));

// Edit a hand-entered item (count, contracted share, price estimate,
// notes). Items from Quarter Section or Livestock Manager are refused —
// their next push would overwrite the change, so fix them in the manager.
router.patch('/:id', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM inventory_items WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const cur = rows[0];
  if (cur.source !== 'manual') {
    return res.status(409).json({ error: `This item comes from ${cur.source} — change it there; its next push would overwrite an edit made here.` });
  }
  const merged = { ...cur, expected_sale_date: toISODate(cur.expected_sale_date) };
  for (const k of ['quantity', 'quantity_contracted', 'price_per_unit', 'notes', 'location', 'expected_sale_date']) {
    if (req.body[k] !== undefined) merged[k] = req.body[k] === '' ? null : req.body[k];
  }
  const err = validate(merged);
  if (err) return res.status(400).json({ error: err });
  const { rows: up } = await pool.query(
    `UPDATE inventory_items SET quantity = $1, quantity_contracted = $2, price_per_unit = $3, notes = $4, location = $5,
       expected_sale_date = $6, as_of = CURRENT_DATE WHERE id = $7 RETURNING *`,
    [Number(merged.quantity), isNum(merged.quantity_contracted) ? Number(merged.quantity_contracted) : null,
     isNum(merged.price_per_unit) ? Number(merged.price_per_unit) : null, merged.notes || null, merged.location || null,
     merged.expected_sale_date || null, cur.id]
  );
  res.json(up[0]);
}));

// The fallback "sold by" date for uncontracted inventory with no other
// date — stored as month-day ("07-31"), always meaning the next one ahead.
router.get('/sale-fallback', ah(async (req, res) => {
  const value = await getSetting(FALLBACK_KEY, null);
  res.json({ value, next_date: nextMonthDay(value) });
}));

router.put('/sale-fallback', ah(async (req, res) => {
  const value = req.body?.value || null;
  if (value !== null && !nextMonthDay(value)) return res.status(400).json({ error: 'value must be "MM-DD", e.g. "07-31", or null to clear it.' });
  if (value === null) await pool.query('DELETE FROM settings WHERE key = $1', [FALLBACK_KEY]);
  else {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [FALLBACK_KEY, JSON.stringify(value)]
    );
  }
  res.json({ value, next_date: nextMonthDay(value) });
}));

router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM inventory_items WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
