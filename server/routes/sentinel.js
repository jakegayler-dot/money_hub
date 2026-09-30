import { Router } from 'express';
import { ah } from '../lib/asyncHandler.js';
import { requireIngestKey } from '../lib/ingestAuth.js';
import { loadSnapshotRows, buildSummaryFromDb } from '../lib/sentinel.js';
import { buildSnapshot } from '../lib/sentinelSnapshot.js';

const router = Router();

// The exact bodies the Sentinel sync would POST right now, without sending
// them: the snapshot (its fields at the top level, as before) plus
// `summary`, the Money tile body sent to /v1/sources/money_hub/summary.
// Behind the ingest key: it lists every bill and amount.
router.get('/preview', requireIngestKey, ah(async (req, res) => {
  const now = new Date();
  const rows = await loadSnapshotRows();
  const snapshot = buildSnapshot(rows, { now, appUrl: process.env.APP_URL || null });
  let summary;
  try {
    summary = await buildSummaryFromDb(now, rows);
  } catch (err) {
    summary = { error: `Summary could not be built: ${err.message}` };
  }
  res.json({ ...snapshot, summary });
}));

export default router;
