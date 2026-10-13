import { Router } from 'express';
import { ah } from '../lib/asyncHandler.js';
import { OWNERS } from '../lib/segments.js';
import { balanceSheetStatement } from '../lib/statement.js';

const router = Router();

// GET /api/balance-sheet?entity=all|grain|livestock|jake|ashley
router.get('/', ah(async (req, res) => {
  const entity = String(req.query.entity || 'all');
  if (entity !== 'all' && !OWNERS.includes(entity)) return res.status(400).json({ error: `entity must be all, ${OWNERS.join(', ')}` });
  res.json(await balanceSheetStatement(entity));
}));

export default router;
