import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { validateSegment, ledgerForSegment } from '../lib/segments.js';
import { todayISO, toISODate } from '../lib/dates.js';
import { loadBalanceSheet } from '../lib/balanceSheet.js';

const router = Router();
const round2 = (n) => Math.round(n * 100) / 100;

function validateCard(c) {
  if (!c.name && !c.issuer) return 'name or issuer is required';
  if (c.apr_purchase == null || Number.isNaN(Number(c.apr_purchase))) return 'apr_purchase is required';
  if (c.annual_fee_month != null && c.annual_fee_month !== '' && (c.annual_fee_month < 1 || c.annual_fee_month > 12)) {
    return 'annual_fee_month must be 1-12';
  }
  return validateSegment(c);
}

// ---- Cards --------------------------------------------------------------
// Each card, with its outstanding balance, next amount due, grace-period
// status (was the last statement paid in full by its due date), and
// reward categories — everything the Purchase Evaluator's "is it worth
// using a card" question and the dashboard's liability figures need.
router.get('/', ah(async (req, res) => {
  const [{ rows: cards }, { rows: statements }, { rows: rewards }] = await Promise.all([
    pool.query(`SELECT * FROM credit_cards ORDER BY (status = 'active') DESC, name`),
    pool.query(`SELECT * FROM credit_card_statements ORDER BY due_date DESC`),
    pool.query(`SELECT * FROM credit_card_reward_categories ORDER BY category`),
  ]);
  const today = todayISO();
  const byCard = new Map();
  for (const s of statements) {
    if (!byCard.has(s.credit_card_id)) byCard.set(s.credit_card_id, []);
    byCard.get(s.credit_card_id).push(s);
  }
  const rewardsByCard = new Map();
  for (const r of rewards) {
    if (!rewardsByCard.has(r.credit_card_id)) rewardsByCard.set(r.credit_card_id, []);
    rewardsByCard.get(r.credit_card_id).push(r);
  }

  const out = cards.map((c) => {
    const own = (byCard.get(c.id) || []).sort((a, b) => toISODate(b.due_date).localeCompare(toISODate(a.due_date)));
    const unpaid = own.filter((s) => !s.paid).sort((a, b) => toISODate(a.due_date).localeCompare(toISODate(b.due_date)));
    const nextDue = unpaid[0] || null;
    const lastAny = own[0] || null; // most recent statement, paid or not
    const overdueUnpaid = unpaid.filter((s) => toISODate(s.due_date) < today);
    // The full amount currently owed, not just the soonest cycle's — a
    // card behind by more than one unpaid statement owes all of them.
    const outstanding = c.current_balance != null
      ? Number(c.current_balance)
      : round2(unpaid.reduce((s, st) => s + Number(st.statement_balance) - Number(st.paid_amount || 0), 0));

    return {
      ...c,
      outstanding_balance: outstanding,
      utilization_pct: c.credit_limit ? round2((outstanding / Number(c.credit_limit)) * 100) : null,
      next_due: nextDue ? {
        id: nextDue.id,
        amount: round2(Number(nextDue.statement_balance) - Number(nextDue.paid_amount || 0)),
        due_date: toISODate(nextDue.due_date),
        overdue: toISODate(nextDue.due_date) < today,
      } : null,
      overdue_count: overdueUnpaid.length,
      // Grace period on new purchases survives only if the last statement
      // was paid in full by ITS due date — this reflects that, not the
      // current cycle (which may still be open).
      grace_period_intact: lastAny ? (lastAny.paid ? !!lastAny.paid_in_full : null) : null,
      last_statement: lastAny ? {
        id: lastAny.id, due_date: toISODate(lastAny.due_date),
        balance: Number(lastAny.statement_balance), paid: lastAny.paid, paid_in_full: lastAny.paid_in_full,
      } : null,
      reward_categories: rewardsByCard.get(c.id) || [],
    };
  });
  res.json(out);
}));

router.post('/', ah(async (req, res) => {
  const {
    name, issuer = null, last4 = null, credit_limit = null,
    apr_purchase, apr_cash_advance = null, annual_fee = 0, annual_fee_month = null,
    grace_period_days = 21, status = 'active', segment = null, notes = null,
    current_balance = null, current_balance_as_of = null,
  } = req.body;
  const err = validateCard(req.body);
  if (err) return res.status(400).json({ error: err });
  const resolvedName = (name && name.trim()) || issuer;

  const { rows } = await pool.query(
    `INSERT INTO credit_cards
      (name, issuer, last4, credit_limit, apr_purchase, apr_cash_advance, annual_fee, annual_fee_month,
       grace_period_days, status, segment, notes, current_balance, current_balance_as_of)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [resolvedName, issuer, last4, credit_limit || null, Number(apr_purchase),
     apr_cash_advance === '' ? null : apr_cash_advance, Number(annual_fee) || 0,
     annual_fee_month === '' ? null : annual_fee_month, Number(grace_period_days) || 21,
     status, segment || null, notes, current_balance === '' ? null : current_balance,
     current_balance_as_of || null]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', ah(async (req, res) => {
  const { rows: cur } = await pool.query('SELECT * FROM credit_cards WHERE id = $1', [req.params.id]);
  if (!cur.length) return res.status(404).json({ error: 'not found' });
  const merged = { ...cur[0] };
  for (const [k, v] of Object.entries(req.body)) if (v !== undefined) merged[k] = v;
  const err = validateCard(merged);
  if (err) return res.status(400).json({ error: err });

  const { rows } = await pool.query(
    `UPDATE credit_cards SET
       name = $1, issuer = $2, last4 = $3, credit_limit = $4, apr_purchase = $5, apr_cash_advance = $6,
       annual_fee = $7, annual_fee_month = $8, grace_period_days = $9, status = $10, segment = $11,
       notes = $12, current_balance = $13, current_balance_as_of = $14
     WHERE id = $15 RETURNING *`,
    [merged.name, merged.issuer || null, merged.last4 || null, merged.credit_limit || null,
     Number(merged.apr_purchase), merged.apr_cash_advance === '' ? null : merged.apr_cash_advance,
     Number(merged.annual_fee) || 0, merged.annual_fee_month === '' ? null : merged.annual_fee_month,
     Number(merged.grace_period_days) || 21, merged.status, merged.segment || null, merged.notes || null,
     merged.current_balance === '' ? null : merged.current_balance, merged.current_balance_as_of || null,
     req.params.id]
  );
  res.json(rows[0]);
}));

// Deleting a card removes its reward categories and statement history with
// it (ON DELETE CASCADE). Ledger transactions from payments already
// recorded are left alone — the money really moved.
router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM credit_cards WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

// ---- Reward categories --------------------------------------------------

router.post('/:id/rewards', ah(async (req, res) => {
  const { category, rate_pct, notes = null } = req.body;
  if (!category) return res.status(400).json({ error: 'category is required' });
  if (rate_pct == null || Number.isNaN(Number(rate_pct))) return res.status(400).json({ error: 'rate_pct is required' });
  const { rows } = await pool.query(
    `INSERT INTO credit_card_reward_categories (credit_card_id, category, rate_pct, notes)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params.id, category, Number(rate_pct), notes]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/rewards/:id', ah(async (req, res) => {
  const { category, rate_pct, notes } = req.body;
  const { rows } = await pool.query(
    `UPDATE credit_card_reward_categories SET
       category = COALESCE($1, category), rate_pct = COALESCE($2, rate_pct), notes = COALESCE($3, notes)
     WHERE id = $4 RETURNING *`,
    [category, rate_pct != null ? Number(rate_pct) : null, notes, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.delete('/rewards/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM credit_card_reward_categories WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

// ---- Statements (billing cycles) ----------------------------------------

router.get('/:id/statements', ah(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM credit_card_statements WHERE credit_card_id = $1 ORDER BY due_date DESC', [req.params.id]
  );
  res.json(rows);
}));

// Logs a new billing cycle — what the issuer says you owe and by when.
// This is the "bill": it sits unpaid in the liquidity floor and owner cash
// flow forecasts, at its due_date, until recorded paid below.
router.post('/:id/statements', ah(async (req, res) => {
  const { rows: cardRows } = await pool.query('SELECT * FROM credit_cards WHERE id = $1', [req.params.id]);
  if (!cardRows.length) return res.status(404).json({ error: 'card not found' });
  const {
    statement_date = null, due_date, statement_balance, minimum_payment = null,
    interest_amount = null, notes = null,
  } = req.body;
  if (!due_date) return res.status(400).json({ error: 'due_date is required' });
  if (statement_balance == null || Number.isNaN(Number(statement_balance))) {
    return res.status(400).json({ error: 'statement_balance is required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO credit_card_statements
      (credit_card_id, statement_date, due_date, statement_balance, minimum_payment, interest_amount, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.id, statement_date || null, due_date, Number(statement_balance),
     minimum_payment === '' || minimum_payment == null ? null : Number(minimum_payment),
     interest_amount === '' || interest_amount == null ? null : Number(interest_amount), notes]
  );
  res.status(201).json(rows[0]);
}));

// Editing an UNPAID statement is always safe. Once PAID, a transaction
// already moved money against these numbers — same lock as bills.js.
router.patch('/statements/:id', ah(async (req, res) => {
  const { rows: cur } = await pool.query('SELECT * FROM credit_card_statements WHERE id = $1', [req.params.id]);
  if (!cur.length) return res.status(404).json({ error: 'not found' });
  const current = cur[0];
  const { due_date, statement_balance, minimum_payment, interest_amount, statement_date, notes } = req.body;
  const touchesFinancials = due_date !== undefined || statement_balance !== undefined
    || minimum_payment !== undefined || interest_amount !== undefined;
  if (current.paid && touchesFinancials) {
    return res.status(409).json({
      error: 'This statement is already paid — its balance and due date are locked because a transaction already moved money based on them. Unpay it first to correct those.',
    });
  }
  const { rows } = await pool.query(
    `UPDATE credit_card_statements SET
       due_date = COALESCE($1, due_date), statement_balance = COALESCE($2, statement_balance),
       minimum_payment = COALESCE($3, minimum_payment), interest_amount = COALESCE($4, interest_amount),
       statement_date = COALESCE($5, statement_date), notes = COALESCE($6, notes)
     WHERE id = $7 RETURNING *`,
    [due_date, statement_balance, minimum_payment, interest_amount, statement_date, notes, req.params.id]
  );
  res.json(rows[0]);
}));

router.delete('/statements/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM credit_card_statements WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

// Paying a statement moves real money: creates the ledger transaction
// (a normal expense — a card payment isn't debt service, since the
// spending it settles never hit a Money Hub account until now), updates
// the paying account's balance, and marks the cycle paid — one DB
// transaction, same pattern as recording a bill or loan payment.
// `amount` lets you pay less than the full balance (a minimum payment);
// `paid_in_full` is computed from whether the FULL statement_balance was
// covered by due_date — the number that decides whether next cycle's
// grace period survives.
router.post('/statements/:id/pay', ah(async (req, res) => {
  const {
    account_id, amount = null, paid_date = todayISO(), paid_by_check = false,
  } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id is required — which account is this payment coming out of?' });

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT s.*, c.name AS card_name, c.segment FROM credit_card_statements s
       JOIN credit_cards c ON c.id = s.credit_card_id WHERE s.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return null;
    const stmt = rows[0];
    if (stmt.paid) return stmt;

    const pay = amount != null && amount !== '' ? Number(amount) : Number(stmt.statement_balance);
    const ledger = ledgerForSegment(stmt.segment);
    const { rows: txRows } = await client.query(
      `INSERT INTO transactions
        (account_id, ledger, date, amount, description, entered_by, segment, cleared, cleared_date)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, $8) RETURNING id`,
      [account_id, ledger, paid_date, -pay,
       `Credit card payment: ${stmt.card_name}${paid_by_check ? ' (check)' : ''}`,
       stmt.segment, !paid_by_check, paid_by_check ? null : paid_date]
    );
    await client.query(`UPDATE accounts SET opening_balance = opening_balance - $1 WHERE id = $2`, [pay, account_id]);

    const paidInFull = pay >= Number(stmt.statement_balance) - 0.005 && toISODate(paid_date) <= toISODate(stmt.due_date);
    const { rows: updated } = await client.query(
      `UPDATE credit_card_statements SET
         paid = true, paid_date = $1, paid_amount = $2, paid_in_full = $3,
         account_id = $4, linked_transaction_id = $5
       WHERE id = $6 RETURNING *`,
      [paid_date, pay, paidInFull, account_id, txRows[0].id, stmt.id]
    );
    return updated[0];
  });

  if (!result) return res.status(404).json({ error: 'not found' });
  res.json(result);
}));

// Reverses a recorded payment: deletes the linked transaction, restores
// the account balance, reopens the statement.
router.post('/statements/:id/unpay', ah(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM credit_card_statements WHERE id = $1', [req.params.id]);
    if (!rows.length) return null;
    const stmt = rows[0];
    if (!stmt.paid) return stmt;

    let txToDelete = null;
    if (stmt.linked_transaction_id) {
      const { rows: txRows } = await client.query('SELECT * FROM transactions WHERE id = $1', [stmt.linked_transaction_id]);
      if (txRows.length) txToDelete = txRows[0];
    }
    // Null the FK reference before deleting the transaction it points to —
    // otherwise the DELETE trips the foreign key immediately, before this
    // row ever stops pointing at it.
    const { rows: updated } = await client.query(
      `UPDATE credit_card_statements SET
         paid = false, paid_date = NULL, paid_amount = NULL, paid_in_full = NULL, linked_transaction_id = NULL
       WHERE id = $1 RETURNING *`,
      [stmt.id]
    );
    if (txToDelete) {
      await client.query(`UPDATE accounts SET opening_balance = opening_balance - $1 WHERE id = $2`, [txToDelete.amount, txToDelete.account_id]);
      await client.query('DELETE FROM transactions WHERE id = $1', [txToDelete.id]);
    }
    return updated[0];
  });
  if (!result) return res.status(404).json({ error: 'not found' });
  res.json(result);
}));

// ---- Rewards estimate -----------------------------------------------------
// What a hypothetical purchase would earn on each active card, by its best-
// matching reward category (case-insensitive) or its "everything else" /
// unmatched-category rate if one exists, else 0. This is a per-purchase
// estimate, not a total of rewards actually earned — Money Hub doesn't know
// which card paid for which ledger transaction.
router.get('/rewards/estimate', ah(async (req, res) => {
  const amount = Number(req.query.amount);
  const category = String(req.query.category || '').trim().toLowerCase();
  if (!amount || Number.isNaN(amount)) return res.status(400).json({ error: 'amount query param is required' });

  const [{ rows: cards }, { rows: rewards }] = await Promise.all([
    pool.query(`SELECT * FROM credit_cards WHERE status = 'active'`),
    pool.query(`SELECT * FROM credit_card_reward_categories`),
  ]);
  const byCard = new Map();
  for (const r of rewards) {
    if (!byCard.has(r.credit_card_id)) byCard.set(r.credit_card_id, []);
    byCard.get(r.credit_card_id).push(r);
  }
  const results = cards.map((c) => {
    const cats = byCard.get(c.id) || [];
    const exact = category ? cats.find((r) => r.category.toLowerCase() === category) : null;
    const fallback = cats.find((r) => /everything else|other|general/i.test(r.category));
    const match = exact || fallback || null;
    const rate = match ? Number(match.rate_pct) : 0;
    return {
      credit_card_id: c.id, name: c.name,
      matched_category: match ? match.category : null,
      rate_pct: rate, estimated_reward: round2(amount * (rate / 100)),
    };
  }).sort((a, b) => b.estimated_reward - a.estimated_reward);
  res.json({ amount, category: category || null, cards: results });
}));

export default router;
