// The Books tab: are Money Hub's balances the bank's balances, what's
// left loose, and month-end close.
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { reconcileImport } from '../lib/statementIngest.js';
import { toISODate, todayISO, addDays } from '../lib/dates.js';
import { monthKey, monthLabel } from '../lib/periods.js';

const router = Router();
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const monthEnd = (key) => {
  const [y, m] = key.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this one
  return `${key.slice(0, 7)}-${String(last).padStart(2, '0')}`;
};

/**
 * Every account and itemized card with its statement checks: the latest
 * statement's result right now, and the latest date it's reconciled
 * through (a later edit can un-reconcile an old statement, so each is
 * recomputed on every load).
 */
async function ledgers(db) {
  const [{ rows: accounts }, { rows: cards }, { rows: imports }] = await Promise.all([
    db.query('SELECT id, name, ledger, opening_balance FROM accounts ORDER BY id'),
    db.query(`SELECT id, name, ledger_start_date FROM credit_cards WHERE status = 'active' AND ledger_start_date IS NOT NULL ORDER BY id`),
    db.query(`SELECT * FROM statement_imports WHERE closing_balance IS NOT NULL AND period_end IS NOT NULL ORDER BY period_end DESC, id DESC`),
  ]);
  const out = [];
  const add = async (kind, row, list) => {
    let latest = null;
    let through = null;
    const reconciledOn = [];
    for (const imp of list) {
      const rec = await reconcileImport(db, imp);
      if (!rec) continue;
      const item = { ...rec, period_end: toISODate(imp.period_end), manual: imp.source === 'manual-check', import_id: imp.id };
      if (!latest) latest = item;
      if (rec.reconciled) reconciledOn.push(item.period_end);
      if (rec.reconciled && (!through || item.period_end > through)) through = item.period_end;
    }
    out.push({
      kind, id: row.id, name: row.name,
      balance_now: kind === 'account' ? r2(row.opening_balance) : null,
      itemized_from: kind === 'card' ? toISODate(row.ledger_start_date) : null,
      latest, reconciled_through: through, reconciled_on: reconciledOn,
      status: !latest ? 'never' : latest.reconciled ? 'ok' : latest.explained_by_held ? 'held' : 'off',
    });
  };
  for (const a of accounts) await add('account', a, imports.filter((i) => i.account_id === a.id));
  for (const c of cards) await add('card', c, imports.filter((i) => i.credit_card_id === c.id));
  return out;
}

async function looseEnds(db) {
  const year = new Date().getFullYear();
  const q = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);
  const [held, flagged, uncatSpend, uncatIncome, oneSided, unverified, pastDueBills, overdueLoans, noReceipt, receiptsWaiting] = await Promise.all([
    q(`SELECT COUNT(*) AS n FROM statement_lines WHERE status = 'held'`),
    q(`SELECT COUNT(*) AS n FROM transactions WHERE needs_review`),
    q(`SELECT COUNT(*) AS n FROM transaction_lines WHERE amount < 0 AND category_id IS NULL AND NOT is_transfer
         AND NOT is_debt_service AND NOT is_capex AND EXTRACT(YEAR FROM date) = $1`, [year]),
    q(`SELECT COUNT(*) AS n FROM transaction_lines WHERE amount > 0 AND category_id IS NULL AND NOT is_transfer
         AND NOT is_debt_service AND EXTRACT(YEAR FROM date) = $1`, [year]),
    q(`SELECT COUNT(*) AS n FROM transactions t WHERE t.is_transfer AND t.account_id IS NOT NULL AND t.credit_card_id IS NULL
         AND t.transfer_peer_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM owner_draws d WHERE d.linked_transaction_id = t.id)`),
    q(`SELECT COUNT(*) AS n FROM loans WHERE last_verified_on IS NULL OR last_verified_on < CURRENT_DATE - 90`),
    q(`SELECT COUNT(*) AS n FROM bills WHERE status = 'unpaid' AND due_date < CURRENT_DATE - 7`),
    q(`SELECT COUNT(*) AS n FROM loan_payments WHERE NOT paid AND NOT is_adjustment AND due_date < CURRENT_DATE - 7`),
    // Farm purchases over $50 this year with no receipt photo. Card
    // payments, transfers and loan payments aren't purchases.
    q(`SELECT COUNT(*) AS n FROM transactions t
       WHERE t.amount < -50 AND NOT t.is_transfer AND NOT t.is_debt_service
         AND NOT (t.account_id IS NOT NULL AND t.credit_card_id IS NOT NULL)
         AND EXTRACT(YEAR FROM t.date) = $1
         AND (t.segment IN ('grain', 'livestock') OR COALESCE(t.segment_grain_pct, 0) + COALESCE(t.segment_livestock_pct, 0) > 0
              OR (t.segment IS NULL AND NOT t.is_segment_split AND t.ledger = 'business'))
         AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)`, [year]),
    q(`SELECT COUNT(*) AS n FROM receipts WHERE status IN ('unmatched', 'unread')`),
  ]);
  return [
    { key: 'held', label: 'Statement lines waiting on Review', count: held, level: 'block', link: '/review' },
    { key: 'flagged', label: 'Transactions flagged for review', count: flagged, level: 'block', link: '/review' },
    { key: 'uncat_income', label: `Income with no category (${year})`, count: uncatIncome, level: 'block', link: '/review' },
    { key: 'uncat_spend', label: `Spending with no category (${year})`, count: uncatSpend, level: 'warn', link: '/ledgers' },
    { key: 'one_sided', label: 'One-sided transfers — fine if the other side is outside Money Hub (a loan advance, another bank); otherwise pair them', count: oneSided, level: 'info', link: '/ledgers' },
    { key: 'past_due_bills', label: 'Bills over a week past due and not marked paid — paid already? link the payment', count: pastDueBills, level: 'warn', link: '/bills' },
    { key: 'overdue_loans', label: 'Scheduled loan payments over a week past due and not recorded', count: overdueLoans, level: 'warn', link: '/loans' },
    { key: 'unverified', label: 'Loans not checked against the lender in 90 days', count: unverified, level: 'warn', link: '/loans' },
    { key: 'no_receipt', label: `Farm purchases over $50 with no receipt photo (${year})`, count: noReceipt, level: 'warn', link: '/receipts?missing=1' },
    { key: 'receipts_waiting', label: 'Receipt photos not yet matched to a transaction — normal until that statement is in', count: receiptsWaiting, level: 'info', link: '/receipts' },
  ];
}

/** Per-month readiness: what's stopping each month from closing. */
async function months(db, books) {
  const { rows: [span] } = await db.query('SELECT MIN(date) AS first FROM transactions');
  const { rows: closed } = await db.query('SELECT * FROM closed_periods');
  const closedBy = new Map(closed.map((c) => [toISODate(c.month), c]));
  if (!span.first) return [];
  const thisMonth = monthKey(todayISO());
  const list = [];
  let key = monthKey(span.first);
  while (key < thisMonth) {
    const end = monthEnd(key);
    const [{ rows: [h] }, { rows: [f] }] = await Promise.all([
      db.query(`SELECT COUNT(*) AS n FROM statement_lines WHERE status = 'held' AND date BETWEEN $1 AND $2`, [key, end]),
      db.query(`SELECT COUNT(*) AS n FROM transactions WHERE needs_review AND date BETWEEN $1 AND $2`, [key, end]),
    ]);
    const blockers = [];
    // Each account and card needs its own reconciled statement (or balance
    // check) for this month: one ending in the month, or up to 10 days
    // after it for statements that close early in the next month. A check
    // months later doesn't count — errors inside a month can offset.
    const grace = addDays(end, 10);
    for (const b of books) {
      if (b.kind === 'card' && b.itemized_from > end) continue; // not tracked yet then
      if (!b.reconciled_on.some((d) => d >= key && d <= grace)) {
        blockers.push(`${b.name}: no reconciled statement or balance check for ${monthLabel(key)}`);
      }
    }
    if (Number(h.n)) blockers.push(`${h.n} statement line${Number(h.n) === 1 ? '' : 's'} on Review`);
    if (Number(f.n)) blockers.push(`${f.n} flagged transaction${Number(f.n) === 1 ? '' : 's'}`);
    const c = closedBy.get(key);
    list.push({
      month: key, label: monthLabel(key), end,
      closed: !!c, closed_at: c?.closed_at || null, forced: !!c?.forced, note: c?.note || null,
      ready: blockers.length === 0, blockers,
    });
    const [y, m] = key.split('-').map(Number);
    key = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return list.reverse();
}

router.get('/', ah(async (req, res) => {
  const books = await ledgers(pool);
  const [checks, monthList, { rows: log }] = await Promise.all([
    looseEnds(pool), months(pool, books),
    pool.query('SELECT * FROM period_log ORDER BY at DESC LIMIT 20'),
  ]);
  res.json({
    ledgers: books, checks, months: monthList,
    log: log.map((l) => ({ ...l, month: toISODate(l.month), label: monthLabel(l.month) })),
  });
}));

// For an account or card with no statements coming in (cash, an
// investment account): "I checked — on DATE it was BALANCE." Stored like a
// statement with no lines, so it reconciles the same way.
router.post('/confirm', ah(async (req, res) => {
  const { account_id = null, credit_card_id = null, date, balance } = req.body || {};
  if ((!account_id && !credit_card_id) || !date || balance === undefined || balance === '' || Number.isNaN(Number(balance))) {
    return res.status(400).json({ error: 'An account or card, a date and the balance on that date are required.' });
  }
  if (date > todayISO()) return res.status(400).json({ error: 'The date can’t be in the future.' });
  const { rows } = await pool.query(
    `INSERT INTO statement_imports (source, external_id, account_id, credit_card_id, period_start, period_end, closing_balance)
     VALUES ('manual-check', $1, $2, $3, $4, $4, $5)
     ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET closing_balance = EXCLUDED.closing_balance, updated_at = now()
     RETURNING *`,
    [`${account_id ? `a${account_id}` : `c${credit_card_id}`}-${date}`, account_id || null, credit_card_id || null, date, Number(balance)]
  );
  res.status(201).json({ check: await reconcileImport(pool, rows[0]) });
}));

router.post('/close', ah(async (req, res) => {
  const { month, force = false, note = null } = req.body || {};
  if (!/^\d{4}-\d{2}(-01)?$/.test(String(month || ''))) return res.status(400).json({ error: 'month is required, e.g. 2026-09' });
  const key = monthKey(String(month).length === 7 ? `${month}-01` : month);
  if (key >= monthKey(todayISO())) return res.status(400).json({ error: 'Only a month that has ended can be closed.' });
  const books = await ledgers(pool);
  const entry = (await months(pool, books)).find((m) => m.month === key);
  if (entry && !entry.ready && !force) {
    return res.status(409).json({ error: `${monthLabel(key)} isn't ready to close.`, blockers: entry.blockers });
  }
  if (force && !String(note || '').trim()) return res.status(400).json({ error: 'Closing with open items needs a note saying why.' });
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO closed_periods (month, forced, note) VALUES ($1, $2, $3)
       ON CONFLICT (month) DO NOTHING`, [key, !!(force && entry && !entry.ready), note]
    );
    await client.query('INSERT INTO period_log (month, action, forced, note) VALUES ($1, $2, $3, $4)',
      [key, 'closed', !!(force && entry && !entry.ready), note]);
  });
  res.json({ closed: key });
}));

router.post('/reopen', ah(async (req, res) => {
  const { month, note = null } = req.body || {};
  if (!String(note || '').trim()) return res.status(400).json({ error: 'Say why it’s being reopened — it’s kept in the log.' });
  const key = monthKey(String(month).length === 7 ? `${month}-01` : month);
  const out = await withTransaction(async (client) => {
    const { rowCount } = await client.query('DELETE FROM closed_periods WHERE month = $1', [key]);
    if (rowCount) await client.query('INSERT INTO period_log (month, action, note) VALUES ($1, $2, $3)', [key, 'reopened', note]);
    return rowCount;
  });
  if (!out) return res.status(404).json({ error: `${monthLabel(key)} isn't closed.` });
  res.json({ reopened: key });
}));

export default router;
