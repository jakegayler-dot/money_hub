import { Router } from 'express';
import { createHash } from 'node:crypto';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { requireIngestKey } from '../lib/ingestAuth.js';
import { matchPending } from '../lib/receipts.js';
import { OWNERS } from '../lib/segments.js';
import { toISODate, todayISO, addDays } from '../lib/dates.js';
import { processLine, reconcileImport, KINDS } from '../lib/statementIngest.js';
import { anchorAccount, anchorCard, upsertCardStatement, PostingError } from '../lib/postings.js';

const router = Router();
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

// ---- Target resolution -----------------------------------------------------

/** The account or card a statement belongs to. Exactly one, or a 400 explaining the options. */
async function resolveTarget(db, s = {}) {
  const fail = async (msg) => {
    const [{ rows: a }, { rows: c }] = await Promise.all([
      db.query('SELECT id, name, last4 FROM accounts ORDER BY id'),
      db.query(`SELECT id, name, last4 FROM credit_cards WHERE status = 'active' ORDER BY id`),
    ]);
    const err = new Error(msg);
    err.status = 400;
    err.details = { accounts: a, credit_cards: c };
    throw err;
  };
  let rows = [];
  let type = 'account';
  if (s.account_id) rows = (await db.query('SELECT * FROM accounts WHERE id = $1', [s.account_id])).rows;
  else if (s.account_last4) rows = (await db.query('SELECT * FROM accounts WHERE last4 = $1', [String(s.account_last4)])).rows;
  else if (s.account_name) rows = (await db.query('SELECT * FROM accounts WHERE lower(name) = lower($1)', [s.account_name])).rows;
  else {
    type = 'card';
    if (s.credit_card_id) rows = (await db.query('SELECT * FROM credit_cards WHERE id = $1', [s.credit_card_id])).rows;
    else if (s.card_last4) rows = (await db.query('SELECT * FROM credit_cards WHERE last4 = $1', [String(s.card_last4)])).rows;
    else await fail('statement must identify its account (account_id, account_last4 or account_name) or card (credit_card_id or card_last4).');
  }
  if (rows.length === 0) await fail(`No ${type} matches that statement header.`);
  if (rows.length > 1) await fail(`More than one ${type} matches that statement header — send the id instead.`);
  return { type, row: rows[0] };
}

/**
 * Stable per-line id when the agent doesn't send one: the same statement
 * re-uploaded produces the same ids, so nothing is entered twice.
 * Identical lines on the same day (two $40 fuel fills) are told apart by
 * their order of appearance.
 */
function fingerprint(target, line, occurrence) {
  const desc = String(line.description || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const key = `${target.type}:${target.row.id}|${line.date}|${round2(line.amount).toFixed(2)}|${desc}|${occurrence}`;
  return `fp:${createHash('sha1').update(key).digest('hex').slice(0, 20)}`;
}

async function saveLine(client, existing, fields) {
  if (existing) {
    const { rows } = await client.query(
      `UPDATE statement_lines SET import_id = COALESCE($1, import_id), date = $2, amount = $3, description = $4, kind = $5,
         payload = $6, status = $7::statement_line_status, reason = $8, candidates = $9, transaction_id = $10,
         resolved_at = CASE WHEN $7::text IN ('posted', 'matched', 'rejected') THEN now() ELSE NULL END
       WHERE id = $11 RETURNING *`,
      [fields.import_id, fields.date, fields.amount, fields.description, fields.kind, JSON.stringify(fields.payload),
       fields.status, fields.reason || null, fields.candidates ? JSON.stringify(fields.candidates) : null,
       fields.transaction_id || null, existing.id]
    );
    return rows[0];
  }
  const { rows } = await client.query(
    `INSERT INTO statement_lines
      (import_id, source, external_id, account_id, credit_card_id, date, amount, description, kind, payload,
       status, reason, candidates, transaction_id, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::statement_line_status,$12,$13,$14,
             CASE WHEN $11::text IN ('posted', 'matched', 'rejected') THEN now() ELSE NULL END)
     RETURNING *`,
    [fields.import_id, fields.source, fields.external_id, fields.account_id, fields.credit_card_id,
     fields.date, fields.amount, fields.description, fields.kind, JSON.stringify(fields.payload),
     fields.status, fields.reason || null, fields.candidates ? JSON.stringify(fields.candidates) : null,
     fields.transaction_id || null]
  );
  return rows[0];
}

// ---- Agent endpoints (X-Api-Key) ---------------------------------------------

// Everything an agent needs to fill in a line correctly, in one call:
// which accounts/cards exist, valid categories and owners, and what's
// scheduled (so it can label a line's kind with confidence).
router.get('/reference', requireIngestKey, ah(async (req, res) => {
  const soon = addDays(todayISO(), 60);
  const [accounts, cards, categories, bills, loanPays, contracts, payees] = await Promise.all([
    pool.query('SELECT id, name, ledger, account_type, last4, segment FROM accounts ORDER BY id'),
    pool.query(`SELECT id, name, issuer, last4, segment, ledger_start_date IS NOT NULL AS itemized
                FROM credit_cards WHERE status = 'active' ORDER BY id`),
    pool.query(`SELECT c.id, c.name, c.kind, c.class, c.ledger, p.name AS parent,
                       EXISTS (SELECT 1 FROM expense_categories k WHERE k.parent_id = c.id) AS has_subcategories
                FROM expense_categories c LEFT JOIN expense_categories p ON p.id = c.parent_id
                ORDER BY lower(COALESCE(p.name, c.name)), c.parent_id IS NOT NULL, lower(c.name)`),
    pool.query(`SELECT id, name, amount, due_date, frequency FROM bills WHERE status = 'unpaid' ORDER BY due_date`),
    pool.query(`SELECT lp.id, COALESCE(NULLIF(l.name, ''), l.lender) AS loan, l.lender,
                       lp.principal_amount + lp.interest_amount AS amount, lp.due_date
                FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
                WHERE lp.paid = false AND lp.is_adjustment = false AND lp.due_date <= $1
                ORDER BY lp.due_date`, [soon]),
    pool.query(`SELECT id, commodity, counterparty, total_value, expected_payment_date, status
                FROM sale_contracts WHERE status IN ('open', 'delivered') ORDER BY expected_payment_date`),
    pool.query('SELECT id, name FROM payees ORDER BY lower(name)'),
  ]);
  const d = (rows, ...keys) => rows.map((r) => {
    const o = { ...r };
    for (const k of keys) o[k] = toISODate(o[k]);
    return o;
  });
  res.json({
    kinds: KINDS,
    owners: OWNERS,
    accounts: accounts.rows,
    credit_cards: cards.rows,
    categories: categories.rows,
    unpaid_bills: d(bills.rows, 'due_date'),
    upcoming_loan_payments: d(loanPays.rows, 'due_date'),
    open_contracts: d(contracts.rows, 'expected_payment_date'),
    payees: payees.rows,
  });
}));

// One statement (or export) for one account or card. See INGEST_API.md §4.
router.post('/ingest', requireIngestKey, ah(async (req, res) => {
  const { source, statement = {}, lines } = req.body || {};
  if (!source) return res.status(400).json({ error: 'source is required (e.g. "statement-agent").' });
  if (!Array.isArray(lines)) return res.status(400).json({ error: 'lines must be an array.' });
  for (const k of ['period_start', 'period_end', 'due_date']) {
    if (statement[k] != null && !isDate(statement[k])) return res.status(400).json({ error: `statement.${k} must be YYYY-MM-DD.` });
  }

  let target;
  try {
    target = await resolveTarget(pool, statement);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, ...err.details });
  }
  const isCard = target.type === 'card';

  const historical = !!statement.historical;
  const setOpening = !!statement.set_opening_balance;
  // Anchoring needs to know the balance on the statement's first day.
  if (setOpening && (statement.opening_balance == null || !statement.period_start)) {
    return res.status(400).json({ error: 'set_opening_balance needs period_start and opening_balance.' });
  }
  // A card's purchases can only be itemized from a known starting balance.
  if (isCard && !target.row.ledger_start_date && (statement.opening_balance == null || !statement.period_start)) {
    return res.status(400).json({
      error: `${target.row.name} isn't itemized yet. Its first itemized statement must include period_start and opening_balance (the statement's "previous balance") so the running balance starts from the right number.`,
    });
  }

  let anchored = null;
  let imp;
  try {
    imp = await withTransaction(async (client) => {
      if (isCard && (setOpening || !target.row.ledger_start_date)) {
        const before = target.row.ledger_start_date ? toISODate(target.row.ledger_start_date) : null;
        target.row = await anchorCard(client, target.row, {
          start_date: statement.period_start, opening_balance: Number(statement.opening_balance),
        });
        anchored = { type: 'card', itemized_from: statement.period_start, previous_start: before };
      } else if (!isCard && setOpening) {
        const r = await anchorAccount(client, target.row.id, {
          as_of: statement.period_start, balance: Number(statement.opening_balance),
        });
        anchored = { type: 'account', as_of: statement.period_start, previous_balance: r.previous_balance, balance_now_before_lines: r.balance_now };
      }
      const vals = [
        source, statement.external_id || null, isCard ? null : target.row.id, isCard ? target.row.id : null,
        statement.period_start || null, statement.period_end || null,
        statement.opening_balance ?? null, statement.closing_balance ?? null,
        statement.due_date || null, statement.minimum_payment ?? null, statement.interest_charged ?? null, historical,
      ];
      if (statement.external_id) {
        const { rows } = await client.query(
          'SELECT id FROM statement_imports WHERE source = $1 AND external_id = $2', [source, statement.external_id]
        );
        if (rows.length) {
          const { rows: up } = await client.query(
            `UPDATE statement_imports SET account_id = $1, credit_card_id = $2, period_start = $3, period_end = $4,
               opening_balance = $5, closing_balance = $6, due_date = $7, minimum_payment = $8, interest_charged = $9,
               historical = $10, updated_at = now()
             WHERE id = $11 RETURNING *`,
            [...vals.slice(2), rows[0].id]
          );
          return up[0];
        }
      }
      const { rows } = await client.query(
        `INSERT INTO statement_imports
          (source, external_id, account_id, credit_card_id, period_start, period_end, opening_balance, closing_balance,
           due_date, minimum_payment, interest_charged, historical)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        vals
      );
      return rows[0];
    });
  } catch (err) {
    if (err instanceof PostingError || err.status === 409) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  const results = [];
  const seen = new Map();
  const categoryCache = new Map();
  for (const [index, raw] of lines.entries()) {
    const line = { ...raw };
    if (!isDate(line.date)) { results.push({ index, ok: false, error: 'date must be YYYY-MM-DD' }); continue; }
    const amt = Number(line.amount);
    if (line.amount == null || !Number.isFinite(amt) || amt === 0) { results.push({ index, ok: false, error: 'amount must be a non-zero number' }); continue; }
    line.amount = round2(amt);

    const baseKey = `${line.date}|${line.amount}|${String(line.description || '').toLowerCase().trim()}`;
    const occ = (seen.get(baseKey) || 0) + 1;
    seen.set(baseKey, occ);
    const external_id = line.external_id ? String(line.external_id) : fingerprint(target, line, occ);

    try {
      const saved = await withTransaction(async (client) => {
        const { rows: ex } = await client.query(
          'SELECT * FROM statement_lines WHERE source = $1 AND external_id = $2 FOR UPDATE', [source, external_id]
        );
        const existing = ex[0];
        if (existing && existing.status !== 'held') return { row: existing, already: true };
        const outcome = await processLine(client, { target, source, external_id, payload: line, historical, categoryCache });
        const row = await saveLine(client, existing, {
          import_id: imp.id, source, external_id,
          account_id: isCard ? null : target.row.id, credit_card_id: isCard ? target.row.id : null,
          date: line.date, amount: line.amount, description: line.description || null,
          kind: line.kind || 'standard', payload: line, ...outcome,
        });
        return { row, outcome };
      });
      results.push({
        index, ok: true, external_id, status: saved.row.status, already_processed: !!saved.already,
        transaction_id: saved.row.transaction_id, reason: saved.row.reason || undefined,
        note: saved.outcome?.note, candidates: saved.row.candidates || undefined,
      });
    } catch (err) {
      console.error('statement line failed', err);
      // Keep the line rather than lose it: into the queue with the error.
      try {
        await withTransaction(async (client) => {
          const { rows: ex } = await client.query('SELECT * FROM statement_lines WHERE source = $1 AND external_id = $2', [source, external_id]);
          if (ex.length && ex[0].status !== 'held') return;
          await saveLine(client, ex[0], {
            import_id: imp.id, source, external_id,
            account_id: isCard ? null : target.row.id, credit_card_id: isCard ? target.row.id : null,
            date: line.date, amount: line.amount, description: line.description || null,
            kind: line.kind || 'standard', payload: line, status: 'held', reason: `Server error: ${err.message}`,
          });
        });
      } catch { /* the error below is what the agent sees */ }
      results.push({ index, ok: false, external_id, status: 'held', error: err.message });
    }
  }

  // A card statement's header is also the billing cycle: log it so the
  // amount due shows up in the liquidity floor, and attach any payment
  // already made toward it.
  let cardStatement = null;
  if (isCard && statement.period_end && statement.due_date && statement.closing_balance != null) {
    cardStatement = await withTransaction(async (client) => {
      const s = await upsertCardStatement(client, target.row.id, {
        statement_date: statement.period_end, due_date: statement.due_date,
        statement_balance: Number(statement.closing_balance),
        minimum_payment: statement.minimum_payment ?? null, interest_amount: statement.interest_charged ?? null,
      });
      await client.query('UPDATE statement_imports SET credit_card_statement_id = $1 WHERE id = $2', [s.id, imp.id]);
      return s;
    });
  }

  const summary = { posted: 0, matched: 0, held: 0, rejected: 0, errors: 0 };
  for (const r of results) {
    if (!r.ok) summary.errors += 1;
    else summary[r.status] += 1;
  }
  const { rows: [freshImp] } = await pool.query('SELECT * FROM statement_imports WHERE id = $1', [imp.id]);
  // New transactions may be what waiting receipts belong to.
  setImmediate(() => matchPending().catch(() => {}));
  res.json({
    import_id: imp.id,
    target: { type: target.type, id: target.row.id, name: target.row.name },
    historical,
    anchored: anchored || undefined,
    received: lines.length,
    summary,
    card_statement: cardStatement ? { id: cardStatement.id, due_date: toISODate(cardStatement.due_date), balance: Number(cardStatement.statement_balance), paid: cardStatement.paid } : undefined,
    reconciliation: await reconcileImport(pool, freshImp),
    results,
  });
}));

// ---- Review queue (app UI) ---------------------------------------------------

const LINE_SELECT = `
  SELECT sl.*, a.name AS account_name, cc.name AS card_name,
         si.period_start, si.period_end
  FROM statement_lines sl
  LEFT JOIN accounts a ON a.id = sl.account_id
  LEFT JOIN credit_cards cc ON cc.id = sl.credit_card_id
  LEFT JOIN statement_imports si ON si.id = sl.import_id`;

const shapeLine = (r) => ({
  ...r, date: toISODate(r.date), amount: Number(r.amount),
  period_start: toISODate(r.period_start), period_end: toISODate(r.period_end),
});

router.get('/review', ah(async (req, res) => {
  const { rows } = await pool.query(`${LINE_SELECT} WHERE sl.status = 'held' ORDER BY sl.date, sl.id`);
  res.json(rows.map(shapeLine));
}));

router.get('/review/count', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM statement_lines WHERE status = 'held')::int AS lines,
            (SELECT COUNT(*) FROM transactions WHERE needs_review)::int AS flagged,
            (SELECT COUNT(*) FROM receipts WHERE status IN ('review', 'failed'))::int AS receipts`
  );
  // `held` is the total waiting — statement lines, flagged transactions and receipts needing a decision.
  const r = rows[0];
  res.json({ held: r.lines + r.flagged + r.receipts, lines: r.lines, flagged: r.flagged, receipts: r.receipts });
}));

router.get('/lines', ah(async (req, res) => {
  const params = [];
  const where = [];
  if (req.query.status) { params.push(req.query.status); where.push(`sl.status = $${params.length}`); }
  if (req.query.import_id) { params.push(req.query.import_id); where.push(`sl.import_id = $${params.length}`); }
  params.push(Math.min(Number(req.query.limit) || 200, 1000));
  const { rows } = await pool.query(
    `${LINE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sl.date DESC, sl.id DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows.map(shapeLine));
}));

router.get('/imports', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT si.*, a.name AS account_name, cc.name AS card_name,
            COUNT(sl.*) FILTER (WHERE sl.status = 'posted')::int AS posted,
            COUNT(sl.*) FILTER (WHERE sl.status = 'matched')::int AS matched,
            COUNT(sl.*) FILTER (WHERE sl.status = 'held')::int AS held,
            COUNT(sl.*) FILTER (WHERE sl.status = 'rejected')::int AS rejected
     FROM statement_imports si
     LEFT JOIN accounts a ON a.id = si.account_id
     LEFT JOIN credit_cards cc ON cc.id = si.credit_card_id
     LEFT JOIN statement_lines sl ON sl.import_id = si.id
     WHERE si.source <> 'manual-check'
     GROUP BY si.id, a.name, cc.name
     ORDER BY si.created_at DESC LIMIT 50`
  );
  const out = [];
  for (const r of rows) {
    out.push({
      ...r, period_start: toISODate(r.period_start), period_end: toISODate(r.period_end),
      reconciliation: await reconcileImport(pool, r),
    });
  }
  res.json(out);
}));

// Approve a held line, optionally with corrections. `overrides` can set
// any line field (kind, category, owner fields, splits, description) and
// say exactly what to link to: bill_id, loan_payment_id, contract_id,
// credit_card_id, from_account_id, counterparty_account_id,
// match_transaction_id — or post_as_new to skip the duplicate check.
// If it's still ambiguous the line stays held and the new reason is returned.
router.post('/lines/:id/approve', ah(async (req, res) => {
  const overrides = req.body?.overrides || {};
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM statement_lines WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows.length) return { status: 404, body: { error: 'not found' } };
    const line = rows[0];
    if (line.status !== 'held') return { status: 409, body: { error: `This line is already ${line.status}.` } };

    const target = line.account_id
      ? { type: 'account', row: (await client.query('SELECT * FROM accounts WHERE id = $1', [line.account_id])).rows[0] }
      : { type: 'card', row: (await client.query('SELECT * FROM credit_cards WHERE id = $1', [line.credit_card_id])).rows[0] };
    if (!target.row) return { status: 409, body: { error: 'The account or card this line belongs to no longer exists — reject it.' } };

    // Overrides replace the agent's fields; clearing an owner split or
    // category is done by sending null.
    const payload = { ...line.payload, ...overrides, date: toISODate(line.date), amount: Number(line.amount) };
    if (overrides.segment && !overrides.is_segment_split) payload.is_segment_split = false;
    const outcome = await processLine(client, {
      target, source: line.source, external_id: line.external_id, payload, approved: true,
      historical: line.import_id
        ? !!(await client.query('SELECT historical FROM statement_imports WHERE id = $1', [line.import_id])).rows[0]?.historical
        : false,
    });
    const saved = await saveLine(client, line, {
      date: toISODate(line.date), amount: Number(line.amount), description: payload.description || null,
      kind: payload.kind || 'standard', payload, ...outcome,
    });
    return { status: outcome.status === 'held' ? 409 : 200, body: { line: shapeLine(saved), note: outcome.note } };
  });
  res.status(result.status).json(result.body);
}));

router.post('/lines/:id/reject', ah(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE statement_lines SET status = 'rejected', resolved_at = now(),
       reason = COALESCE($2, reason)
     WHERE id = $1 AND status = 'held' RETURNING *`,
    [req.params.id, req.body?.note || null]
  );
  if (!rows.length) return res.status(409).json({ error: 'Only held lines can be rejected.' });
  res.json(shapeLine(rows[0]));
}));

export default router;
