import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { requireIngestKey } from '../lib/ingestAuth.js';
import { loadBalanceSheet } from '../lib/balanceSheet.js';
import { OWNERS } from '../lib/segments.js';
import { todayISO } from '../lib/dates.js';

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
    return 'price_per_unit must be a number if sent — omit it to use the Money Hub price list';
  }
  if (it.item_class && !CLASSES.includes(it.item_class)) return `item_class must be one of ${CLASSES.join(', ')}`;
  if (isNum(it.quantity_contracted) && Number(it.quantity_contracted) > Number(it.quantity)) return 'quantity_contracted is more than quantity';
  if (it.segment && !OWNERS.includes(it.segment)) return `segment must be one of ${OWNERS.join(', ')}`;
  return null;
}

const COLS = `source, external_id, item_class, commodity, quantity, unit, quantity_contracted, price_per_unit, location, as_of, segment, notes`;
const values = (it) => [
  it.source || 'manual', it.external_id || null, it.item_class || 'crop', it.commodity, Number(it.quantity), it.unit,
  isNum(it.quantity_contracted) ? Number(it.quantity_contracted) : null,
  isNum(it.price_per_unit) ? Number(it.price_per_unit) : null,
  it.location || null, it.as_of || todayISO(), it.segment || null, it.notes || null,
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
         segment = EXCLUDED.segment, notes = EXCLUDED.notes, updated_at = now()
       RETURNING id, price_per_unit`,
      v
    );
    accepted++;
    results.push({ external_id: it.external_id, ok: true, id: rows[0].id, priced_by: rows[0].price_per_unit != null ? 'source' : 'price list' });
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

  // Flag anything that ended up with no price at all, so the pushing
  // system (and whoever reads its logs) knows it's counting at $0.
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

// ---- Price list -------------------------------------------------------
// Market price per commodity + unit, used for any inventory item whose
// source didn't send a price. Kept in Money Hub (or pushed from a price
// feed via /prices/ingest) so bin counts and prices can come from
// different places.
router.get('/prices', ah(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM commodity_prices ORDER BY commodity, unit`);
  res.json(rows);
}));

async function upsertPrice(p, source) {
  const { rows } = await pool.query(
    `INSERT INTO commodity_prices (commodity, unit, price_per_unit, as_of, source, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (lower(commodity), lower(unit)) DO UPDATE SET
       commodity = EXCLUDED.commodity, unit = EXCLUDED.unit, price_per_unit = EXCLUDED.price_per_unit,
       as_of = EXCLUDED.as_of, source = EXCLUDED.source, notes = EXCLUDED.notes, updated_at = now()
     RETURNING *`,
    [p.commodity, p.unit, Number(p.price_per_unit), p.as_of || todayISO(), source, p.notes || null]
  );
  return rows[0];
}
const priceError = (p) =>
  (!p.commodity || !p.unit ? 'commodity and unit are required'
    : !isNum(p.price_per_unit) || Number(p.price_per_unit) < 0 ? 'price_per_unit must be a number' : null);

router.put('/prices', ah(async (req, res) => {
  const err = priceError(req.body);
  if (err) return res.status(400).json({ error: err });
  res.json(await upsertPrice(req.body, 'manual'));
}));

router.post('/prices/ingest', requireIngestKey, ah(async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : (req.body.items || [req.body]);
  const source = (!Array.isArray(req.body) && req.body.source) || 'ingest';
  const results = [];
  for (const p of items) {
    const err = priceError(p);
    if (err) { results.push({ commodity: p.commodity || null, ok: false, error: err }); continue; }
    const row = await upsertPrice(p, source);
    results.push({ commodity: row.commodity, unit: row.unit, ok: true });
  }
  res.json({ received: items.length, results });
}));

router.delete('/prices/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM commodity_prices WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM inventory_items WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
