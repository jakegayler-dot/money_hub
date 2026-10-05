// Read-only data API for Sentinel's voice agent (see lib/sentinelRead.js).
//
// Its own key, not the app's sign-in: Authorization: Bearer
// <SENTINEL_ACTION_KEY>. Mounted in index.js BEFORE the app's sign-in
// guard, so /api/sentinel/read is exempt from it and nothing else is.
// GET only; anything else is refused without touching the database.
import crypto from 'node:crypto';
import { Router } from 'express';
import { ah } from '../lib/asyncHandler.js';
import { catalog, readCollection, ReadError } from '../lib/sentinelRead.js';

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** Bearer SENTINEL_ACTION_KEY, compared in constant time. */
export function requireActionKey(req, res, next) {
  const key = process.env.SENTINEL_ACTION_KEY;
  if (!key) return res.status(503).json({ error: 'Sentinel actions are not configured' });
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  // Hash both sides so timingSafeEqual always compares equal lengths.
  if (!m || !crypto.timingSafeEqual(digest(m[1].trim()), digest(key))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const router = Router();
router.use(requireActionKey);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).set('Allow', 'GET').json({ error: 'Read only: use GET.' });
  }
  next();
});

router.get('/', (req, res) => res.json(catalog()));

router.get('/:collection', ah(async (req, res) => {
  try {
    res.json(await readCollection(req.params.collection, req.query));
  } catch (err) {
    if (err instanceof ReadError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

router.use((req, res) => res.status(404).json({ error: 'Not found. GET /api/sentinel/read lists the collections.' }));

export default router;
