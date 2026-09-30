import { Router } from 'express';
import { ah } from '../lib/asyncHandler.js';
import { requireIngestKey } from '../lib/ingestAuth.js';
import { buildSnapshotFromDb } from '../lib/sentinel.js';

const router = Router();

// The exact body the Sentinel sync would POST right now, without sending
// it. Behind the ingest key: it lists every bill and amount.
router.get('/preview', requireIngestKey, ah(async (req, res) => {
  res.json(await buildSnapshotFromDb());
}));

export default router;
