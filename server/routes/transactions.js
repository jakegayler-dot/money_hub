import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const { ledger, from, to, limit = 100 } = req.query;
  const conditions = [];
  const params = [];

  if (ledger) {
    params.push(ledger);
    conditions.push(`ledger = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`date <= $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Number(limit));

  const { rows } = await pool.query(
    `SELECT * FROM transactions ${where} ORDER BY date DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows);
}));

// Manual entry — this is the v1 ingestion path. `is_mixed_use` +
// `mixed_use_business_pct` split cost basis between ledgers at entry time,
// so no post-hoc review-queue step is needed for v1.
//
// Recording a transaction and moving the owning account's balance happen
// in one DB transaction (withTransaction) so the ledger entry and the
// balance it represents can never fall out of sync with each other.
router.post('/', ah(async (req, res) => {
  const {
    account_id, ledger, date, amount, description,
    category_id = null, purchase_class = null,
    is_mixed_use = false, mixed_use_business_pct = null,
    is_capex = false, entered_by = 'manual',
    cleared = true,
  } = req.body;

  const row = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO transactions
        (account_id, ledger, date, amount, description, category_id,
         purchase_class, is_mixed_use, mixed_use_business_pct, is_capex, entered_by,
         cleared, cleared_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [account_id, ledger, date, amount, description, category_id,
       purchase_class, is_mixed_use, mixed_use_business_pct, is_capex, entered_by,
       !!cleared, cleared ? date : null]
    );
    await client.query(
      `UPDATE accounts SET opening_balance = opening_balance + $1 WHERE id = $2`,
      [amount, account_id]
    );
    return rows[0];
  });

  res.status(201).json(row);
}));

// Reconciliation only — flips `cleared` to true once the bank actually
// shows the money moving (e.g. a check finally gets cashed). This never
// touches the account balance a second time: the balance already moved
// when the transaction was recorded, exactly as a real checkbook register
// works. It's how a long-outstanding check stops looking like a mystery
// gap between this app's balance and the real bank statement.
router.post('/:id/clear', ah(async (req, res) => {
  const { cleared_date = new Date().toISOString().slice(0, 10) } = req.body;
  const { rows } = await pool.query(
    `UPDATE transactions SET cleared = true, cleared_date = $1 WHERE id = $2 RETURNING *`,
    [cleared_date, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

// Reverses a clear, in case it was marked by mistake.
router.post('/:id/unclear', ah(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE transactions SET cleared = false, cleared_date = NULL WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

// Deleting a transaction reverses its effect on the account balance —
// otherwise the balance would permanently keep money that was only ever
// recorded by mistake.
router.delete('/:id', ah(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
    if (!rows.length) return null;
    const tx = rows[0];
    await client.query(
      `UPDATE accounts SET opening_balance = opening_balance - $1 WHERE id = $2`,
      [tx.amount, tx.account_id]
    );
    await client.query('DELETE FROM transactions WHERE id = $1', [tx.id]);
    return tx;
  });
  if (!result) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
