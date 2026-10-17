// The Quicken feed (lib/quicken.js): imports, and the account and category
// links that make them automatic. Agents use the same X-Api-Key as the
// other ingest endpoints; see INGEST_API.md §7.
import express, { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { validateSegment } from '../lib/segments.js';
import { toISODate } from '../lib/dates.js';
import { importQuicken, applyCategoryMapping, defaultImportFrom } from '../lib/quicken.js';

const router = Router();
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

// POST /api/quicken/import
//   JSON: { content: "<the QIF or CSV text>", filename, account, date_order, label }
//     or  { lines: [{ account, date, amount, payee, memo, category, num, splits }], label }
//   or the file itself as the body (text/plain, application/octet-stream),
//   with ?filename=&account=&date_order=&label= in the query string.
router.post('/import', express.text({ type: ['text/*', 'application/octet-stream', 'application/qif', 'application/x-qif'], limit: '25mb' }),
  ah(async (req, res) => {
    const raw = typeof req.body === 'string';
    const b = raw ? {} : (req.body || {});
    const q = req.query || {};
    const content = raw ? req.body : (Array.isArray(b.lines) ? b.lines : b.content);
    if (!content || (typeof content === 'string' && !content.trim())) {
      return res.status(400).json({ error: 'Send the export: the file as the body, or JSON with "content" (the file text) or "lines".' });
    }
    const dateOrder = b.date_order || q.date_order;
    if (dateOrder && !['mdy', 'dmy'].includes(dateOrder)) return res.status(400).json({ error: 'date_order is "mdy" (month first) or "dmy" (day first).' });
    const out = await importQuicken({
      content, filename: b.filename || q.filename || null, account: b.account || q.account || null,
      date_order: dateOrder || null, label: b.label || q.label || (req.get('x-api-key') ? 'agent' : 'upload'),
    });
    res.status(out.status).json(out.body);
  }));

// Everything the Quicken page shows.
router.get('/', ah(async (req, res) => {
  const [links, maps, imports, accounts, cards, categories] = await Promise.all([
    pool.query(`SELECT q.*, a.name AS account_name, c.name AS card_name, c.ledger_start_date IS NOT NULL AS card_itemized
                FROM quicken_accounts q LEFT JOIN accounts a ON a.id = q.account_id LEFT JOIN credit_cards c ON c.id = q.credit_card_id
                ORDER BY (q.account_id IS NULL AND q.credit_card_id IS NULL AND NOT q.ignored) DESC, lower(q.name)`),
    pool.query(`SELECT q.*, CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' › ' || c.name END AS category_name
                FROM quicken_categories q LEFT JOIN expense_categories c ON c.id = q.category_id
                LEFT JOIN expense_categories p ON p.id = c.parent_id
                ORDER BY (q.category_id IS NULL AND q.kind = 'standard') DESC, q.lines_seen DESC, lower(q.name)`),
    pool.query('SELECT * FROM quicken_imports ORDER BY received_at DESC LIMIT 15'),
    pool.query('SELECT id, name, last4 FROM accounts ORDER BY name'),
    pool.query(`SELECT id, name, last4 FROM credit_cards WHERE status = 'active' ORDER BY name`),
    pool.query(`SELECT c.id, c.kind, CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' › ' || c.name END AS name
                FROM expense_categories c LEFT JOIN expense_categories p ON p.id = c.parent_id ORDER BY 3`),
  ]);
  res.json({
    accounts: links.rows.map((r) => ({ ...r, import_from: toISODate(r.import_from), card_opening_balance: r.card_opening_balance == null ? null : Number(r.card_opening_balance) })),
    categories: maps.rows,
    imports: imports.rows,
    options: { accounts: accounts.rows, cards: cards.rows, categories: categories.rows },
  });
}));

// Link a Quicken account: { account_id } | { credit_card_id } | { ignored: true }, plus import_from and card_opening_balance.
router.put('/accounts/:id', ah(async (req, res) => {
  const b = req.body || {};
  if (b.import_from != null && b.import_from !== '' && !isDate(b.import_from)) return res.status(400).json({ error: 'import_from must be YYYY-MM-DD.' });
  const accountId = b.account_id ? Number(b.account_id) : null;
  const cardId = b.credit_card_id ? Number(b.credit_card_id) : null;
  if (accountId && cardId) return res.status(400).json({ error: 'Link it to an account or a card, not both.' });
  // Newly linked with no start date: a week before the last transaction already on file there.
  let from = b.import_from || null;
  if (!from && (accountId || cardId)) {
    const { rows: [cur] } = await pool.query('SELECT import_from FROM quicken_accounts WHERE id = $1', [req.params.id]);
    from = cur?.import_from ? toISODate(cur.import_from) : await defaultImportFrom({ account_id: accountId, credit_card_id: cardId });
  }
  const { rows: [row] } = await pool.query(
    `UPDATE quicken_accounts SET account_id = $1, credit_card_id = $2, ignored = $3, auto_matched = false,
       import_from = $4, card_opening_balance = $5 WHERE id = $6 RETURNING *`,
    [accountId, cardId, !!b.ignored && !accountId && !cardId, from,
     b.card_opening_balance === '' || b.card_opening_balance == null ? null : Number(b.card_opening_balance), req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  res.json(row);
}));

// Map a Quicken category: { category_id, owner: { segment } | { is_segment_split, segment_*_pct }, kind }.
// Lines already posted under it that are still uncategorized are filled in.
router.put('/categories/:id', ah(async (req, res) => {
  const b = req.body || {};
  const kind = b.kind || 'standard';
  if (!['standard', 'owner_draw', 'transfer'].includes(kind)) return res.status(400).json({ error: 'kind is standard, owner_draw or transfer.' });
  const owner = b.owner && (b.owner.segment || b.owner.is_segment_split) ? b.owner : null;
  if (owner) { const err = validateSegment(owner); if (err) return res.status(400).json({ error: err }); }
  const { rows: [row] } = await pool.query(
    'UPDATE quicken_categories SET category_id = $1, owner = $2, kind = $3, auto_matched = false WHERE id = $4 RETURNING *',
    [b.category_id ? Number(b.category_id) : null, owner, kind, req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  const filled = await applyCategoryMapping(row.id);
  res.json({ ...row, filled });
}));

export default router;
