import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { requireIngestKey } from '../lib/ingestAuth.js';
import { validateSegment, segmentValues, SEGMENT_COLUMNS } from '../lib/segments.js';
import { occurrences } from '../lib/estimates.js';
import { inventorySales } from '../lib/inventoryForecast.js';
import { todayISO, addMonths, toISODate } from '../lib/dates.js';

const router = Router();
const FREQUENCIES = ['one_time', 'monthly', 'quarterly', 'annual'];
const SEG_COLS = SEGMENT_COLUMNS.join(', ');

// Checks an estimate payload; returns an error string or null.
function validate(e) {
  if (!e.name) return 'name is required';
  if (!['inflow', 'outflow'].includes(e.direction)) return 'direction must be inflow or outflow';
  if (e.amount == null || Number.isNaN(Number(e.amount)) || Number(e.amount) < 0) return 'amount must be a positive number (direction says which way it moves)';
  if (!e.start_date) return 'start_date is required (the first or only occurrence)';
  if (e.frequency && !FREQUENCIES.includes(e.frequency)) return `frequency must be one of ${FREQUENCIES.join(', ')}`;
  if (e.end_date && e.end_date < e.start_date) return 'end_date is before start_date';
  return validateSegment(e);
}

// Listing includes each estimate's upcoming occurrences in the next 12
// months and a `stale` flag for one-offs whose date has already passed —
// those no longer count anywhere and should be retired or re-dated.
router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM cash_estimates ORDER BY status, start_date`
  );
  const today = todayISO();
  const horizon = addMonths(today, 12);
  res.json(rows.map((e) => {
    const next = occurrences(e, today, horizon);
    return { ...e, upcoming: next, next12_total: next.length * Number(e.amount), stale: e.status === 'active' && next.length === 0 };
  }));
}));

// What the forecast adds automatically from uncontracted inventory, with
// where each sale date came from, plus anything left out for lack of one.
router.get('/from-inventory', ah(async (req, res) => {
  res.json(await inventorySales());
}));

async function insertOrUpsert(e, { upsert }) {
  const cols = `source, external_id, name, category, commodity, direction, amount, frequency, start_date, end_date, status, notes, ${SEG_COLS}`;
  const vals = [
    e.source || 'manual', e.external_id || null, e.name, e.category || null, e.commodity || null, e.direction, Number(e.amount),
    e.frequency || 'one_time', e.start_date, e.end_date || null, e.status === 'retired' ? 'retired' : 'active',
    e.notes || null, ...segmentValues(e),
  ];
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
  const conflict = upsert
    ? `ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
         name = EXCLUDED.name, category = EXCLUDED.category, commodity = EXCLUDED.commodity, direction = EXCLUDED.direction,
         amount = EXCLUDED.amount, frequency = EXCLUDED.frequency, start_date = EXCLUDED.start_date,
         end_date = EXCLUDED.end_date, status = EXCLUDED.status, notes = EXCLUDED.notes,
         ${SEGMENT_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`
    : '';
  const { rows } = await pool.query(`INSERT INTO cash_estimates (${cols}) VALUES (${placeholders}) ${conflict} RETURNING *`, vals);
  return rows[0];
}

// ---- Automated ingest -------------------------------------------------
// Same key and idempotency rules as contract ingest. Body is an array of
// estimates, or { source, snapshot: true, items: [...] } — snapshot mode
// retires (not deletes) this source's estimates missing from the push, so
// a source can send its complete current plan and anything it dropped
// stops counting, with history kept.
router.post('/ingest', requireIngestKey, ah(async (req, res) => {
  const body = req.body;
  const snapshot = !Array.isArray(body) && body && body.snapshot === true;
  const items = Array.isArray(body) ? body : (body.items || [body]);
  const snapshotSource = snapshot ? body.source : null;
  if (snapshot && !snapshotSource) return res.status(400).json({ error: 'snapshot mode requires a top-level "source"' });

  const results = [];
  // Every external_id in the payload counts as PRESENT, whether or not it
  // saved: a snapshot removes only what's absent from the push. An item
  // that failed validation keeps its previous values instead of being
  // deleted because of one bad field.
  const seen = items.map((raw) => raw && raw.external_id).filter(Boolean);
  let accepted = 0;
  for (const raw of items) {
    const e = { ...raw, source: snapshotSource || raw.source || 'ingest' };
    if (!e.external_id) { results.push({ ok: false, error: 'external_id is required for pushed estimates' }); continue; }
    const err = validate(e);
    if (err) { results.push({ external_id: e.external_id, ok: false, error: err }); continue; }
    const row = await insertOrUpsert(e, { upsert: true });
    accepted++;
    results.push({ external_id: e.external_id, ok: true, id: row.id });
  }

  // A push where nothing was accepted retires nothing.
  let retired = 0;
  const skippedCleanup = snapshot && accepted === 0 && items.length > 0;
  if (snapshot && !skippedCleanup) {
    const { rowCount } = await pool.query(
      `UPDATE cash_estimates SET status = 'retired', updated_at = now()
       WHERE source = $1 AND status = 'active' AND external_id IS NOT NULL AND NOT (external_id = ANY($2::text[]))`,
      [snapshotSource, seen]
    );
    retired = rowCount;
  }
  res.json({
    received: items.length, results, retired_missing_from_snapshot: retired,
    ...(skippedCleanup ? { snapshot_cleanup_skipped: 'no items were accepted, so nothing was retired' } : {}),
  });
}));

router.post('/', ah(async (req, res) => {
  const e = { ...req.body, source: 'manual', external_id: null };
  const err = validate(e);
  if (err) return res.status(400).json({ error: err });
  res.status(201).json(await insertOrUpsert(e, { upsert: false }));
}));

router.patch('/:id', ah(async (req, res) => {
  const { rows: cur } = await pool.query('SELECT * FROM cash_estimates WHERE id = $1', [req.params.id]);
  if (!cur.length) return res.status(404).json({ error: 'not found' });
  const merged = { ...cur[0] };
  for (const [k, v] of Object.entries(req.body)) if (v !== undefined) merged[k] = v;
  merged.start_date = toISODate(merged.start_date);
  merged.end_date = merged.end_date ? toISODate(merged.end_date) : null;
  const err = validate(merged);
  if (err) return res.status(400).json({ error: err });
  const segVals = segmentValues(merged);
  const { rows } = await pool.query(
    `UPDATE cash_estimates SET name = $1, category = $2, direction = $3, amount = $4, frequency = $5,
       start_date = $6, end_date = $7, status = $8, notes = $9,
       ${SEGMENT_COLUMNS.map((c, i) => `${c} = $${10 + i}`).join(', ')}, updated_at = now()
     WHERE id = $${10 + SEGMENT_COLUMNS.length} RETURNING *`,
    [merged.name, merged.category || null, merged.direction, Number(merged.amount), merged.frequency,
     merged.start_date, merged.end_date || null, merged.status, merged.notes || null, ...segVals, req.params.id]
  );
  res.json(rows[0]);
}));

// Retiring keeps the record but removes it from every forecast — the
// right move when a committed item (a contract, a bill) has replaced the
// guess, so the same money isn't counted twice.
router.post('/:id/retire', ah(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE cash_estimates SET status = 'retired', updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.post('/:id/reactivate', ah(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE cash_estimates SET status = 'active', updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cash_estimates WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
