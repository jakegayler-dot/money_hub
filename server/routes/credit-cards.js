import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { validateSegment } from '../lib/segments.js';
import { todayISO, toISODate } from '../lib/dates.js';
import { cardBalances } from '../lib/cardLedger.js';
import { payCard, recomputeCardStatement, removeTransaction, upsertCardStatement, anchorCard } from '../lib/postings.js';

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

  const balances = await cardBalances(pool, cards);
  const out = cards.map((c) => {
    // Newest cycle first. Statements are cumulative, so the latest one is
    // what's owed and due now; older unpaid ones are superseded by it.
    const cycle = (st) => toISODate(st.statement_date || st.due_date);
    const own = (byCard.get(c.id) || []).sort((a, b) => cycle(b).localeCompare(cycle(a)) || b.id - a.id);
    const latest = own[0] || null;
    const nextDue = latest && !latest.paid ? latest : null;
    const lastAny = latest;
    const { outstanding, itemized } = balances.get(c.id) || { outstanding: 0, itemized: false };
    // Grace period survives only if the last statement whose deadline has
    // come (paid, or past due) was paid IN FULL by its due date.
    const decided = own.find((st) => st.paid || toISODate(st.due_date) < today) || null;

    return {
      ...c,
      itemized,
      ledger_start_date: toISODate(c.ledger_start_date),
      outstanding_balance: outstanding,
      utilization_pct: c.credit_limit ? round2((outstanding / Number(c.credit_limit)) * 100) : null,
      next_due: nextDue ? {
        id: nextDue.id,
        amount: round2(Number(nextDue.statement_balance) - Number(nextDue.paid_amount || 0)),
        paid_so_far: Number(nextDue.paid_amount || 0),
        due_date: toISODate(nextDue.due_date),
        overdue: toISODate(nextDue.due_date) < today,
      } : null,
      overdue_count: nextDue && toISODate(nextDue.due_date) < today ? 1 : 0,
      grace_period_intact: decided ? decided.paid_in_full === true : null,
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
  const ok = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id FROM credit_cards WHERE id = $1', [req.params.id]);
    if (!rows.length) return false;
    // Purchases charged to the card go with it (they moved no account
    // balance). Payments out of bank accounts really happened, so they
    // stay — just no longer tied to this card.
    const { rows: purchases } = await client.query(
      'SELECT id FROM transactions WHERE credit_card_id = $1 AND account_id IS NULL', [req.params.id]
    );
    for (const t of purchases) await removeTransaction(client, t.id);
    await client.query(
      'UPDATE transactions SET credit_card_id = NULL, credit_card_statement_id = NULL WHERE credit_card_id = $1', [req.params.id]
    );
    await client.query('DELETE FROM credit_cards WHERE id = $1', [req.params.id]);
    return true;
  });
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

// Switch a card to itemized tracking by hand (an agent's first itemized
// statement does this automatically): from `start_date` its balance is
// `opening_balance` plus every purchase, refund and payment entered.
router.post('/:id/start-ledger', ah(async (req, res) => {
  const { start_date, opening_balance } = req.body || {};
  if (!start_date || opening_balance == null || Number.isNaN(Number(opening_balance))) {
    return res.status(400).json({ error: 'start_date and opening_balance (what the card owed on that date) are required.' });
  }
  const card = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM credit_cards WHERE id = $1', [req.params.id]);
    if (!rows.length) return null;
    // Also moves an itemized card's start EARLIER, for loading older statements.
    return anchorCard(client, rows[0], { start_date, opening_balance: Number(opening_balance) });
  });
  if (!card) return res.status(404).json({ error: 'not found' });
  res.json(card);
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
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const row = await withTransaction(async (client) => {
    if (statement_date) {
      // Same path as a statement pushed by an agent: deduped on its date,
      // and picks up any payment already made toward it.
      const s = await upsertCardStatement(client, req.params.id, {
        statement_date, due_date, statement_balance: Number(statement_balance),
        minimum_payment: num(minimum_payment), interest_amount: num(interest_amount),
      });
      if (notes) await client.query('UPDATE credit_card_statements SET notes = $1 WHERE id = $2', [notes, s.id]);
      return { ...s, notes: notes || s.notes };
    }
    const { rows } = await client.query(
      `INSERT INTO credit_card_statements
        (credit_card_id, statement_date, due_date, statement_balance, minimum_payment, interest_amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, null, due_date, Number(statement_balance), num(minimum_payment), num(interest_amount), notes]
    );
    return rows[0];
  });
  res.status(201).json(row);
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
  // A changed balance can turn partial payments into paid-in-full or back.
  const recomputed = await withTransaction((client) => recomputeCardStatement(client, rows[0].id));
  res.json(recomputed);
}));

router.delete('/statements/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM credit_card_statements WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

// Paying a statement: money out of an account toward this cycle. Goes
// through the same payCard() an agent's bank-statement line does. Partial
// payments add up; the cycle is paid once they cover statement_balance,
// and `paid_in_full` records whether that happened by the due date (the
// grace-period test). For an itemized card the payment is a transfer —
// the purchases are the expenses — otherwise the payment is the expense.
router.post('/statements/:id/pay', ah(async (req, res) => {
  const {
    account_id, amount = null, paid_date = todayISO(), paid_by_check = false,
  } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id is required — which account is this payment coming out of?' });

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM credit_card_statements WHERE id = $1', [req.params.id]);
    if (!rows.length) return null;
    const stmt = rows[0];
    if (stmt.paid) return stmt;
    const remaining = Number(stmt.statement_balance) - Number(stmt.paid_amount || 0);
    const pay = amount != null && amount !== '' ? Number(amount) : remaining;
    const r = await payCard(client, stmt.credit_card_id, {
      account_id, date: paid_date, amount: pay, statement_id: stmt.id, paid_by_check,
    });
    return r.statement;
  });

  if (!result) return res.status(404).json({ error: 'not found' });
  res.json(result);
}));

// Reverses payments recorded here by hand (deletes them, restoring the
// account balance) and reopens the cycle. Payments that came in from a
// bank statement are real money that moved — those are left alone; delete
// one from Ledgers if it was genuinely wrong.
router.post('/statements/:id/unpay', ah(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM credit_card_statements WHERE id = $1', [req.params.id]);
    if (!rows.length) return null;
    const { rows: manual } = await client.query(
      `SELECT id FROM transactions WHERE credit_card_statement_id = $1 AND account_id IS NOT NULL AND source IS NULL`,
      [req.params.id]
    );
    if (!manual.length) {
      const err = new Error('No hand-recorded payment to reverse on this statement — its payments came from bank statements.');
      err.status = 409;
      throw err;
    }
    for (const t of manual) await removeTransaction(client, t.id);
    return recomputeCardStatement(client, Number(req.params.id));
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
