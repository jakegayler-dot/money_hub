import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { validateSegment } from '../lib/segments.js';
import { insertTransaction, removeTransaction, ownerOf, ledgerForOwner, normalizeSplits } from '../lib/postings.js';
import { toISODate } from '../lib/dates.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const { ledger, from, to, account_id, credit_card_id, limit = 100 } = req.query;
  const conditions = [];
  const params = [];
  const add = (sql, v) => { params.push(v); conditions.push(sql.replace('?', `$${params.length}`)); };
  if (ledger) add('t.ledger = ?', ledger);
  if (from) add('t.date >= ?', from);
  if (to) add('t.date <= ?', to);
  if (account_id) add('t.account_id = ?', account_id);
  if (credit_card_id) add('t.credit_card_id = ?', credit_card_id);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(Number(limit) || 100, 1000));

  // Account and card names joined in so the ledger can say where each
  // entry came from (a card purchase has no account), plus split pieces.
  const { rows } = await pool.query(
    `SELECT t.*, a.name AS account_name, cc.name AS card_name, ec.name AS category_name,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', s.id, 'amount', s.amount, 'memo', s.memo, 'category_id', s.category_id,
                'category_name', sc.name, 'ledger', s.ledger, 'is_capex', s.is_capex,
                'segment', s.segment, 'is_segment_split', s.is_segment_split,
                'segment_grain_pct', s.segment_grain_pct, 'segment_livestock_pct', s.segment_livestock_pct,
                'segment_jake_pct', s.segment_jake_pct, 'segment_ashley_pct', s.segment_ashley_pct
              ) ORDER BY s.id)
              FROM transaction_splits s LEFT JOIN expense_categories sc ON sc.id = s.category_id
              WHERE s.transaction_id = t.id
            ), '[]'::json) AS splits
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     LEFT JOIN expense_categories ec ON ec.id = t.category_id
     ${where}
     ORDER BY t.date DESC, t.id DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows.map((r) => ({ ...r, date: toISODate(r.date), cleared_date: toISODate(r.cleared_date) })));
}));

// Manual entry. Either out of/into an account (account_id), or charged to
// a card (credit_card_id, no account — raises the card's balance; the card
// must be itemized, i.e. have a ledger start). `splits` divides one
// transaction into pieces, each with its own amount, category and owner;
// pieces must add up to the total. `is_transfer` marks money moving
// between things Money Hub tracks (not income or expense).
router.post('/', ah(async (req, res) => {
  const {
    account_id = null, credit_card_id = null, date, amount, description,
    category_id = null, purchase_class = null,
    is_mixed_use = false, mixed_use_business_pct = null,
    is_capex = false, is_transfer = false, entered_by = 'manual',
    cleared = true, splits: pieces = [],
  } = req.body;

  if (!account_id && !credit_card_id) return res.status(400).json({ error: 'Pick an account, or a card for a card purchase.' });
  if (!date || !Number(amount)) return res.status(400).json({ error: 'date and a non-zero amount are required.' });
  const segmentError = validateSegment(req.body);
  if (segmentError) return res.status(400).json({ error: segmentError });

  let card = null;
  if (credit_card_id && !account_id) {
    const { rows } = await pool.query('SELECT * FROM credit_cards WHERE id = $1', [credit_card_id]);
    card = rows[0];
    if (!card) return res.status(400).json({ error: 'card not found' });
    if (!card.ledger_start_date) {
      return res.status(400).json({
        error: `${card.name} isn't itemized yet — set its ledger start (date and balance on that date) on the Credit Cards tab before entering purchases on it.`,
      });
    }
  }

  let fallbackOwner = {};
  if (account_id) fallbackOwner = (await pool.query('SELECT * FROM accounts WHERE id = $1', [account_id])).rows[0] || {};
  else fallbackOwner = card;
  const owner = ownerOf(req.body, fallbackOwner);
  const ledger = req.body.ledger || ledgerForOwner(owner, fallbackOwner.ledger || 'business');
  const { splits, error } = normalizeSplits(pieces, Number(amount), owner, ledger);
  if (error) return res.status(400).json({ error });

  const row = await withTransaction((client) => insertTransaction(client, {
    account_id: account_id || null, credit_card_id: credit_card_id || null,
    ledger, date, amount: Number(amount), description, category_id: category_id || null, purchase_class,
    is_mixed_use, mixed_use_business_pct, is_capex, is_transfer, entered_by,
    cleared: account_id ? !!cleared : true, owner, splits,
  }));
  res.status(201).json(row);
}));

// Reconciliation only — flips `cleared` to true once the bank actually
// shows the money moving (e.g. a check finally gets cashed). This never
// touches the account balance a second time: the balance already moved
// when the transaction was recorded, exactly as a real checkbook register
// works.
router.post('/:id/clear', ah(async (req, res) => {
  const { cleared_date = new Date().toISOString().slice(0, 10) } = req.body;
  const { rows } = await pool.query(
    `UPDATE transactions SET cleared = true, cleared_date = $1 WHERE id = $2 RETURNING *`,
    [cleared_date, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.post('/:id/unclear', ah(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE transactions SET cleared = false, cleared_date = NULL WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

// Deleting a transaction reverses its effect on the account balance. A
// bill/loan/contract payment must be reversed from its own tab (so the
// item reopens); a statement line that produced it returns to the review
// queue.
router.delete('/:id', ah(async (req, res) => {
  const tx = await withTransaction((client) => removeTransaction(client, req.params.id));
  if (!tx) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
