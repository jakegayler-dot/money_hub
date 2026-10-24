import { Router } from 'express';
import { pool, withTransaction, getSetting } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { gstReport, gstPeriods, farmIncomeTax } from '../lib/tax.js';
import { assertOpen } from '../lib/periods.js';
import { toISODate, addDays } from '../lib/dates.js';
import { CRA_GST_SQL } from '../lib/gstMatch.js';
import { TAX_KINDS, guessTaxKind } from '../lib/taxMoves.js';

const router = Router();
const yearOf = (q) => Number(q) || new Date().getFullYear();
const setSetting = (db, key, value) => db.query(
  `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  [key, JSON.stringify(value)]
);
const clearSetting = (db, key) => db.query('DELETE FROM settings WHERE key = $1', [key]);

// ---- GST -------------------------------------------------------------------

router.get('/gst', ah(async (req, res) => res.json(await gstReport(yearOf(req.query.year)))));

router.put('/gst/frequency', ah(async (req, res) => {
  const f = req.body?.frequency;
  if (!['monthly', 'quarterly', 'annual'].includes(f)) return res.status(400).json({ error: 'frequency must be monthly, quarterly or annual' });
  await setSetting(pool, 'gst_filing_frequency', f);
  res.json({ frequency: f });
}));

const findPeriod = async (start) => {
  const year = Number(String(start).slice(0, 4));
  const frequency = String(await getSetting('gst_filing_frequency', 'quarterly'));
  return gstPeriods(year, frequency).find((p) => p.start === start) || null;
};

// Record a return as filed: the date and the net as filed (negative = refund).
router.post('/gst/file', ah(async (req, res) => {
  const { period_start, filed_on, net_amount, notes = null } = req.body || {};
  const p = await findPeriod(period_start);
  if (!p) return res.status(400).json({ error: 'Unknown GST period.' });
  if (!filed_on || net_amount === undefined || net_amount === '' || Number.isNaN(Number(net_amount))) {
    return res.status(400).json({ error: 'Filed date and the net amount as filed are required (negative for a refund).' });
  }
  await pool.query(
    `INSERT INTO gst_returns (period_start, period_end, filed_on, net_amount, notes) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (period_start) DO UPDATE SET filed_on = EXCLUDED.filed_on, net_amount = EXCLUDED.net_amount, notes = EXCLUDED.notes`,
    [p.start, p.end, filed_on, Number(net_amount), notes]
  );
  res.json({ filed: p.start });
}));

router.post('/gst/unfile', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM gst_returns WHERE period_start = $1', [req.body?.period_start]);
  if (!rows.length) return res.status(404).json({ error: 'not filed' });
  if (rows[0].settlement_transaction_id) return res.status(409).json({ error: 'Unlink the refund or payment first.' });
  await pool.query('DELETE FROM gst_returns WHERE period_start = $1', [req.body.period_start]);
  res.json({ ok: true });
}));

// Deposits (refund) or payments that could settle a filed return: within
// three years after the period ends (a refund can build up for years), closest to the filed amount first. One
// CRA deposit often pays out several quarters, so a deposit already linked
// to another return is offered too (`settles` names those quarters).
router.get('/gst/candidates', ah(async (req, res) => {
  const { rows: [ret] } = await pool.query('SELECT * FROM gst_returns WHERE period_start = $1', [req.query.period_start]);
  if (!ret) return res.status(404).json({ error: 'File the return first.' });
  const net = Number(ret.net_amount);
  const { rows } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, a.name AS account_name,
            (SELECT string_agg(to_char(g.period_start, 'YYYY-MM-DD'), ', ' ORDER BY g.period_start)
             FROM gst_returns g WHERE g.settlement_transaction_id = t.id) AS settles
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.date > $1 AND t.date <= $2
       AND (NOT t.is_transfer OR t.tax_kind IN ('gst_refund', 'gst_payment') OR EXISTS (SELECT 1 FROM gst_returns g WHERE g.settlement_transaction_id = t.id))
       AND ${net <= 0 ? 't.amount > 0' : 't.amount < 0'}
       AND t.id IS DISTINCT FROM $4
     ORDER BY abs(abs(t.amount) - $3), t.date LIMIT 15`,
    [toISODate(ret.period_end), addDays(toISODate(ret.period_end), 1100), Math.abs(net), ret.settlement_transaction_id]
  );
  res.json(rows.map((r) => ({ ...r, date: toISODate(r.date), amount: Number(r.amount) })));
}));

// Money to or from CRA that looks like GST/HST but isn't linked to a
// quarter — it's counting as income or spending until it is.
router.get('/gst/unlinked', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, a.name AS account_name, t.is_transfer
     FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN payees p ON p.id = t.payee_id
     WHERE t.date >= CURRENT_DATE - 550 AND ${CRA_GST_SQL}
       AND NOT EXISTS (SELECT 1 FROM gst_returns g WHERE g.settlement_transaction_id = t.id)
       AND t.tax_kind IS NULL
     ORDER BY t.date DESC LIMIT 30`);
  res.json(rows.map((r) => ({ ...r, date: toISODate(r.date), amount: Number(r.amount) })));
}));

// The refund (or payment) is GST moving between the farm and CRA — not
// income or expense — so it's treated like a transfer from here on.
router.post('/gst/settle', ah(async (req, res) => {
  const { period_start, transaction_id } = req.body || {};
  const out = await withTransaction(async (client) => {
    const { rows: [ret] } = await client.query('SELECT * FROM gst_returns WHERE period_start = $1 FOR UPDATE', [period_start]);
    if (!ret) return { status: 404, body: { error: 'File the return first.' } };
    const { rows: [tx] } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [transaction_id]);
    if (!tx) return { status: 404, body: { error: 'Transaction not found.' } };
    await assertOpen(client, tx.date);
    await client.query(
      `UPDATE transactions SET is_transfer = true, category_id = NULL, is_split = false,
         tax_kind = CASE WHEN amount > 0 THEN 'gst_refund' ELSE 'gst_payment' END,
         needs_review = CASE WHEN review_note LIKE 'Income with no category%' THEN false ELSE needs_review END,
         review_note = CASE WHEN review_note LIKE 'Income with no category%' THEN NULL ELSE review_note END
       WHERE id = $1`, [tx.id]
    );
    await client.query('DELETE FROM transaction_splits WHERE transaction_id = $1', [tx.id]);
    await client.query('UPDATE gst_returns SET settlement_transaction_id = $1 WHERE period_start = $2', [tx.id, period_start]);
    return { status: 200, body: { settled: period_start, transaction_id: tx.id } };
  });
  res.status(out.status).json(out.body);
}));

router.post('/gst/unsettle', ah(async (req, res) => {
  const out = await withTransaction(async (client) => {
    const { rows: [ret] } = await client.query('SELECT * FROM gst_returns WHERE period_start = $1 FOR UPDATE', [req.body?.period_start]);
    if (!ret?.settlement_transaction_id) return { status: 404, body: { error: 'Nothing linked.' } };
    const { rows: [tx] } = await client.query('SELECT * FROM transactions WHERE id = $1', [ret.settlement_transaction_id]);
    await client.query('UPDATE gst_returns SET settlement_transaction_id = NULL WHERE period_start = $1', [req.body.period_start]);
    // Still settling another quarter? Then it stays a transfer.
    const { rows: [other] } = await client.query('SELECT 1 FROM gst_returns WHERE settlement_transaction_id = $1 LIMIT 1', [ret.settlement_transaction_id]);
    if (tx && !other) {
      await assertOpen(client, tx.date);
      await client.query('UPDATE transactions SET is_transfer = false, tax_kind = NULL WHERE id = $1', [tx.id]);
    }
    return { status: 200, body: { ok: true } };
  });
  res.status(out.status).json(out.body);
}));

// ---- Money with CRA ------------------------------------------------------------
// What's marked as a refund or payment with CRA in a year, and lines from
// the last 18 months that look like CRA but aren't marked — including ones
// filed under a category (a GST refund booked as a program payment counts
// as farm income until it's marked).
router.get('/cra', ah(async (req, res) => {
  const year = yearOf(req.query.year);
  const { rows: marked } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, t.tax_kind, a.name AS account_name,
            (SELECT s.amount FROM transaction_splits s WHERE s.transaction_id = t.id AND NOT s.is_transfer LIMIT 1) AS interest,
            (SELECT string_agg(to_char(g.period_start, 'YYYY-MM-DD'), ', ' ORDER BY g.period_start)
               FROM gst_returns g WHERE g.settlement_transaction_id = t.id) AS quarters
     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.tax_kind IS NOT NULL AND EXTRACT(YEAR FROM t.date) = $1 ORDER BY t.date`, [year]);
  const { rows: maybe } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, t.ledger, a.name AS account_name, ec.name AS category_name, p.name AS payee_name, t.is_transfer
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN expense_categories ec ON ec.id = t.category_id
     WHERE t.tax_kind IS NULL AND t.credit_card_id IS NULL AND NOT t.is_debt_service AND t.date >= CURRENT_DATE - 550
       AND (COALESCE(t.description, '') || ' ' || COALESCE(p.name, '')) ~* '(\\mcra\\M|canada|revenue|receiver|rec gen|\\mrit\\M|\\mgst\\M|\\mhst\\M|income tax|tax refund|instal|\\mgovt?\\M|gov''t|government|\\mgc\\M|\\mfed\\M|federal)'
     ORDER BY t.date DESC LIMIT 200`);
  // A government deposit or payment with no tax words (a bank's "GOVT CANADA" / "FED GOV'T"): offered too,
  // as GST on the farm side and income tax on the personal side, marked unsure. Programs (AgriStability,
  // AgriInvest, crop insurance) and loans are left out.
  const GOVT = /\b(govt|gov't|government|gc|fed|federal)\b|\bcanada\b/i;
  const NOT_TAX = /agri|aafc|scic|crop|insur|stabil|invest|loan|fcc|farm credit|credit|benefit|ccb|child|carbon|climate|pension|cpp|oas|\bei\b|life/i;
  const suggestions = maybe
    .map((r) => {
      const text = `${r.description || ''} ${r.payee_name || ''}`;
      const sure = guessTaxKind(text, r.amount);
      const kind = sure || (GOVT.test(text) && !NOT_TAX.test(text)
        ? (r.ledger === 'personal' ? 'income_tax' : 'gst') + (Number(r.amount) > 0 ? '_refund' : '_payment') : null);
      return { ...r, date: toISODate(r.date), amount: Number(r.amount), kind, sure: !!sure };
    })
    .filter((r) => r.kind)
    .slice(0, 30);
  const sum = (k) => Math.round(marked.filter((r) => r.tax_kind === k).reduce((s, r) => s + Number(r.amount), 0) * 100) / 100;
  res.json({
    year, kinds: Object.fromEntries(Object.entries(TAX_KINDS).map(([k, v]) => [k, v.label])),
    totals: Object.fromEntries(Object.keys(TAX_KINDS).map((k) => [k, sum(k)])),
    marked: marked.map((r) => ({ ...r, date: toISODate(r.date), amount: Number(r.amount), interest: r.interest != null ? Number(r.interest) : null })),
    suggestions,
  });
}));

// ---- Income tax -------------------------------------------------------------

router.get('/income', ah(async (req, res) => {
  const { defer_sales, prepay_inputs, oia } = req.query;
  res.json(await farmIncomeTax(yearOf(req.query.year), { defer_sales, prepay_inputs, oia }));
}));

// Per-year inputs: CCA from your accountant (replaces the estimate), last
// year's tax owing (for the instalment's prior-year option). Empty clears.
router.put('/income/settings', ah(async (req, res) => {
  const year = yearOf(req.body?.year);
  for (const [field, key] of [['cca', `tax_cca_${year}`], ['prior_year_owing', `tax_prior_year_owing_${year}`]]) {
    if (req.body[field] === undefined) continue;
    const v = req.body[field];
    if (v === null || v === '') await clearSetting(pool, key);
    else if (Number.isNaN(Number(v)) || Number(v) < 0) return res.status(400).json({ error: `${field} must be a positive number` });
    else await setSetting(pool, key, Number(v));
  }
  res.json(await farmIncomeTax(year));
}));

router.put('/income/instalment', ah(async (req, res) => {
  const year = yearOf(req.body?.year);
  if (req.body?.paid) await setSetting(pool, `tax_instalment_paid_${year}`, { date: req.body.date || null, amount: Number(req.body.amount) || null });
  else await clearSetting(pool, `tax_instalment_paid_${year}`);
  res.json({ ok: true });
}));

export default router;
