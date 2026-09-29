import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { requireIngestKey } from '../lib/ingestAuth.js';
import { loadBalanceSheet } from '../lib/balanceSheet.js';
import { OWNERS } from '../lib/segments.js';

const router = Router();
const CLASSES = ['crop', 'market_livestock', 'breeding_livestock', 'other'];

router.get('/', ah(async (req, res) => {
  const { inventoryGroups, inventoryRows } = await loadBalanceSheet();
  res.json({ groups: inventoryGroups, items: inventoryRows });
}));

function validate(it) {
  if (!it.commodity) return 'commodity is required';
  if (it.quantity == null || Number.isNaN(Number(it.quantity))) return 'quantity is required';
  if (!it.unit) return 'unit is required (bu, tonnes, head...)';
  if (it.price_per_unit == null || Number.isNaN(Number(it.price_per_unit))) return 'price_per_unit (estimated market price) is required';
  if (it.item_class && !CLASSES.includes(it.item_class)) return `item_class must be one of ${CLASSES.join(', ')}`;
  if (it.quantity_contracted != null && Number(it.quantity_contracted) > Number(it.quantity)) return 'quantity_contracted is more than quantity';
  if (it.segment && !OWNERS.includes(it.segment)) return `segment must be one of ${OWNERS.join(', ')}`;
  return null;
}

const COLS = `source, external_id, item_class, commodity, quantity, unit, quantity_contracted, price_per_unit, location, as_of, segment, notes`;
const values = (it) => [
  it.source || 'manual', it.external_id || null, it.item_class || 'crop', it.commodity, Number(it.quantity), it.unit,
  it.quantity_contracted != null && it.quantity_contracted !== '' ? Number(it.quantity_contracted) : null,
  Number(it.price_per_unit), it.location || null, it.as_of || new Date().toISOString().slice(0, 10),
  it.segment || null, it.notes || null,
];

// ---- Automated ingest -------------------------------------------------
// For Quarter Section (bins) and Livestock Manager (herd). Upserts on
// (source, external_id). Snapshot mode — { source, snapshot: true, items }
// — also DELETES this source's items missing from the push: inventory is
// a current-state count, so a bin that's been emptied must stop counting.
// Guard: an empty snapshot is refused unless confirm_empty is true, so a
// broken export can't silently zero out the farm.
router.post('/ingest', requireIngestKey, ah(async (req, res) => {
  const body = req.body;
  const snapshot = !Array.isArray(body) && body && body.snapshot === true;
  const items = Array.isArray(body) ? body : (body.items || [body]);
  const snapshotSource = snapshot ? body.source : null;
  if (snapshot && !snapshotSource) return res.status(400).json({ error: 'snapshot mode requires a top-level "source"' });
  if (snapshot && items.length === 0 && body.confirm_empty !== true) {
    return res.status(400).json({ error: 'Empty snapshot refused — it would delete all of this source\'s inventory. Send confirm_empty: true if that is really intended.' });
  }

  const results = [];
  const seen = [];
  for (const raw of items) {
    const it = { ...raw, source: snapshotSource || raw.source || 'ingest' };
    if (!it.external_id) { results.push({ ok: false, error: 'external_id is required for pushed inventory' }); continue; }
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
       RETURNING id`,
      v
    );
    seen.push(it.external_id);
    results.push({ external_id: it.external_id, ok: true, id: rows[0].id });
  }

  let removed = 0;
  if (snapshot) {
    const { rowCount } = await pool.query(
      `DELETE FROM inventory_items WHERE source = $1 AND external_id IS NOT NULL AND NOT (external_id = ANY($2::text[]))`,
      [snapshotSource, seen]
    );
    removed = rowCount;
  }
  res.json({ received: items.length, results, removed_missing_from_snapshot: removed });
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

router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM inventory_items WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
