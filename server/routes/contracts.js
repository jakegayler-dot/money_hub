import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import {
  settleContract, linkContractToTransaction, unlinkContractPayment, settleContractByHand, reopenContractByHand,
  contractAllowancePct,
} from '../lib/postings.js';
import { toISODate } from '../lib/dates.js';
import { todayISO } from '../lib/dates.js';
import { ledgerForSegment } from '../lib/segments.js';
import { requireIngestKey } from '../lib/ingestAuth.js';

const router = Router();
const setSetting = (db, key, value) => db.query(
  'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);

// total_value falls back to quantity × price when not given explicitly, so
// a pushing system can send either the extended value or the components.
function resolveTotal({ total_value, quantity, price_per_unit }) {
  if (total_value != null && total_value !== '') return Number(total_value);
  if (quantity != null && price_per_unit != null) {
    return Math.round(Number(quantity) * Number(price_per_unit) * 100) / 100;
  }
  return null;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

// The payment date drives which forecast month the money lands in, so a
// fabricated one is worse than none. The rule, in order:
//   1. An explicitly known expected_payment_date wins (a real override,
//      never a guess — pushing systems must not fabricate this field).
//   2. Confirmed delivery date → payment = delivery + 7 days (override the
//      terms per contract with payment_terms_days).
//   3. No delivery scheduled yet → the last day of the contract period,
//      the latest date the delivery window allows, so the forecast leans
//      conservative until a delivery date firms up.
const DEFAULT_PAYMENT_TERMS_DAYS = 7;
function resolvePaymentDate({ expected_payment_date, delivery_date, contract_period_end, payment_terms_days }) {
  if (expected_payment_date) return expected_payment_date;
  if (delivery_date) return addDays(delivery_date, payment_terms_days ?? DEFAULT_PAYMENT_TERMS_DAYS);
  if (contract_period_end) return contract_period_end;
  return null;
}

// Each contract with the deposits linked to it (by your agent, or by hand).
// Nothing is linked or suggested automatically.
router.get('/', ah(async (req, res) => {
  const status = ['open', 'delivered', 'settled', 'cancelled'].includes(req.query.status) ? req.query.status : null;
  const { rows } = await pool.query(
    `SELECT c.*, GREATEST(c.total_value - c.received_amount, 0) AS remaining,
            COALESCE((SELECT json_agg(json_build_object(
                'id', t.id, 'date', t.date, 'amount', t.amount, 'description', t.description,
                'account', a.name, 'created_here', cp.created_here, 'is_split', t.is_split,
                'awaiting_statement', t.awaiting_statement,
                'documents', (SELECT json_agg(json_build_object('id', r.id, 'mime', r.mime) ORDER BY r.id) FROM receipts r WHERE r.transaction_id = t.id)
                ) ORDER BY t.date, t.id)
              FROM contract_payments cp JOIN transactions t ON t.id = cp.transaction_id
              LEFT JOIN accounts a ON a.id = t.account_id
              WHERE cp.contract_id = c.id), '[]'::json) AS deposits,
            COALESCE((SELECT json_agg(json_build_object('id', r.id, 'mime', r.mime, 'uploaded_at', r.uploaded_at) ORDER BY r.id)
              FROM receipts r WHERE r.contract_id = c.id), '[]'::json) AS documents
     FROM sale_contracts c
     ${status ? 'WHERE c.status = $1' : ''}
     ORDER BY (c.status IN ('open','delivered')) DESC, c.expected_payment_date ASC`,
    status ? [status] : []
  );
  const out = [];
  for (const c of rows) {
    out.push({
      ...c,
      remaining: Number(c.remaining),
      deposits: c.deposits.map((d) => ({ ...d, date: toISODate(d.date), amount: Number(d.amount) })),
    });
  }
  res.json(out);
}));

// How far under the contract value deposits can come and still settle it
// on their own (checkoff and levies). Default 3%.
router.get('/settings', ah(async (req, res) => {
  res.json({ deduction_allowance_pct: await contractAllowancePct() });
}));
router.post('/settings', ah(async (req, res) => {
  const v = Number(req.body?.deduction_allowance_pct);
  if (!Number.isFinite(v) || v < 0 || v >= 50) return res.status(400).json({ error: 'Allowance must be between 0 and 50 (%).' });
  await setSetting(pool, 'contract_deduction_allowance_pct', v);
  res.json({ deduction_allowance_pct: v });
}));

// ---- Agent linking ----------------------------------------------------
// Your agent links ledger entries (deposits already in the ledger) to
// contracts — Money Hub never guesses. Same API key as the other ingest
// endpoints (X-Api-Key). See INGEST_API.md §6.

// Open contracts, and incoming deposits not linked to anything, to work from.
router.get('/ingest/reference', requireIngestKey, ah(async (req, res) => {
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.since || '')) ? req.query.since : null;
  const { rows: contracts } = await pool.query(
    `SELECT c.id, c.external_id, c.counterparty, c.commodity, c.quantity, c.unit, c.price_per_unit, c.total_value, c.received_amount,
            GREATEST(c.total_value - c.received_amount, 0) AS remaining, c.delivery_date, c.expected_payment_date, c.status,
            COALESCE((SELECT json_agg(json_build_object('transaction_id', t.id, 'date', t.date, 'amount', t.amount, 'description', t.description) ORDER BY t.date)
                      FROM contract_payments cp JOIN transactions t ON t.id = cp.transaction_id WHERE cp.contract_id = c.id), '[]'::json) AS linked
     FROM sale_contracts c WHERE c.status IN ('open', 'delivered') ORDER BY c.expected_payment_date, c.id`);
  const { rows: deposits } = await pool.query(
    `SELECT t.id AS transaction_id, t.date, t.amount, t.description, a.name AS account, p.name AS payee
     FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN payees p ON p.id = t.payee_id
     WHERE t.amount > 0 AND NOT t.is_transfer AND t.date >= COALESCE($1::date, CURRENT_DATE - 400)
       AND NOT EXISTS (SELECT 1 FROM contract_payments x WHERE x.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM vendor_credits x WHERE x.refund_transaction_id = t.id)
     ORDER BY t.date DESC, t.id DESC LIMIT 500`, [since]);
  const d = (v) => (v ? toISODate(v) : null);
  res.json({
    open_contracts: contracts.map((c) => ({
      ...c, total_value: Number(c.total_value), received_amount: Number(c.received_amount), remaining: Number(c.remaining),
      delivery_date: d(c.delivery_date), expected_payment_date: d(c.expected_payment_date),
    })),
    unlinked_deposits: deposits.map((t) => ({ ...t, date: d(t.date), amount: Number(t.amount) })),
  });
}));

// Link entries to contracts: { links: [{ transaction_id, contract_id | contract_external_id }] }
// (or one such object). Each link is applied on its own; the reply says
// what happened to each, and where each contract now stands.
router.post('/ingest/link', requireIngestKey, ah(async (req, res) => {
  const body = req.body || {};
  const links = Array.isArray(body.links) ? body.links : Array.isArray(body) ? body : [body];
  if (!links.length || links.length > 200) return res.status(400).json({ error: 'Send 1–200 links.' });
  const results = [];
  for (const l of links) {
    const txId = Number(l?.transaction_id);
    let contractId = l?.contract_id != null ? Number(l.contract_id) : null;
    try {
      if (!txId) throw Object.assign(new Error('transaction_id is required.'), { status: 400 });
      if (!contractId && l?.contract_external_id) {
        const { rows: [c] } = await pool.query('SELECT id FROM sale_contracts WHERE external_id = $1', [String(l.contract_external_id)]);
        if (!c) throw Object.assign(new Error(`No contract with external_id ${l.contract_external_id}.`), { status: 404 });
        contractId = c.id;
      }
      if (!contractId) throw Object.assign(new Error('contract_id or contract_external_id is required.'), { status: 400 });
      const { rows: [cur] } = await pool.query('SELECT contract_id, created_here FROM contract_payments WHERE transaction_id = $1', [txId]);
      if (cur && cur.contract_id === contractId) {
        const { rows: [c] } = await pool.query('SELECT * FROM sale_contracts WHERE id = $1', [contractId]);
        results.push({ transaction_id: txId, contract_id: contractId, ok: true, note: 'Already linked.', status: c.status,
          received_amount: Number(c.received_amount), remaining: Math.max(0, Number(c.total_value) - Number(c.received_amount)) });
        continue;
      }
      if (cur && cur.created_here) throw Object.assign(new Error('That deposit was recorded by hand on another contract — change it on the Contracts tab.'), { status: 409 });
      const c = await withTransaction(async (client) => {
        if (cur) await unlinkContractPayment(client, txId); // moving it to another contract
        await client.query('DELETE FROM contract_link_rejections WHERE contract_id = $1 AND transaction_id = $2', [contractId, txId]);
        return (await linkContractToTransaction(client, contractId, txId)).contract;
      });
      results.push({ transaction_id: txId, contract_id: contractId, ok: true, moved_from: cur ? cur.contract_id : undefined,
        status: c.status, received_amount: Number(c.received_amount), remaining: Math.max(0, Number(c.total_value) - Number(c.received_amount)) });
    } catch (e) {
      results.push({ transaction_id: txId || null, contract_id: contractId, ok: false, error: e.message });
    }
  }
  res.status(results.every((r) => r.ok) ? 200 : 207).json({ results });
}));

// Take entries off their contracts: { transaction_ids: [...] }. The entries stay in the ledger.
router.post('/ingest/unlink', requireIngestKey, ah(async (req, res) => {
  const ids = (Array.isArray(req.body?.transaction_ids) ? req.body.transaction_ids : [req.body?.transaction_id]).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'transaction_ids is required.' });
  const results = [];
  for (const id of ids) {
    try {
      const { rows: [cp] } = await pool.query('SELECT created_here FROM contract_payments WHERE transaction_id = $1', [id]);
      if (cp?.created_here) throw new Error('That deposit was recorded by hand on the Contracts tab — remove it there.');
      const c = await withTransaction((client) => unlinkContractPayment(client, id));
      results.push({ transaction_id: id, ok: true, contract_id: c?.id, status: c?.status });
    } catch (e) {
      results.push({ transaction_id: id, ok: false, error: e.message });
    }
  }
  res.status(results.every((r) => r.ok) ? 200 : 207).json({ results });
}));

// Incoming deposits matching what you type (description, payee, amount) — for linking by hand.
router.get('/deposits', ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const num = Number(q.replace(/[$,\s]/g, ''));
  const { rows } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, a.name AS account,
            (SELECT c.commodity FROM contract_payments cp JOIN sale_contracts c ON c.id = cp.contract_id WHERE cp.transaction_id = t.id) AS on_contract
     FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN payees p ON p.id = t.payee_id
     WHERE t.amount > 0 AND NOT t.is_transfer
       AND (t.description ILIKE $1 OR p.name ILIKE $1 OR ($2::numeric IS NOT NULL AND abs(t.amount - $2::numeric) < 1))
     ORDER BY t.date DESC, t.id DESC LIMIT 15`,
    [`%${q.replace(/[%_]/g, '')}%`, Number.isFinite(num) && num > 0 ? num : null]);
  res.json(rows.map((t) => ({ ...t, date: toISODate(t.date), amount: Number(t.amount) })));
}));

// A deposit already in the ledger counts toward this contract.
router.post('/:id/link', ah(async (req, res) => {
  const txId = Number(req.body?.transaction_id);
  if (!txId) return res.status(400).json({ error: 'transaction_id is required.' });
  const r = await withTransaction((client) => linkContractToTransaction(client, Number(req.params.id), txId));
  res.json(r.contract);
}));

// Take a deposit off its contract (removed if it was recorded on this tab).
router.post('/:id/unlink', ah(async (req, res) => {
  const txId = Number(req.body?.transaction_id);
  if (!txId) return res.status(400).json({ error: 'transaction_id is required.' });
  const c = await withTransaction((client) => unlinkContractPayment(client, txId));
  res.json(c);
}));

// Settle a partly paid contract: mode 'deductions' (the rest was checkoff,
// freight, dockage) or 'short' (less was delivered).
router.post('/:id/settle-now', ah(async (req, res) => {
  const mode = req.body?.mode === 'short' ? 'short' : 'deductions';
  const c = await withTransaction((client) => settleContractByHand(client, Number(req.params.id), mode));
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
}));

// Settled → open again, deposits kept, deductions booking taken off.
router.post('/:id/reopen', ah(async (req, res) => {
  const c = await withTransaction((client) => reopenContractByHand(client, Number(req.params.id)));
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
}));

// ---- Automated ingest ------------------------------------------------
// The endpoint an outside system (another business's software, an agent, a
// script) pushes contracts to. Protected by an API key: set the
// INGEST_API_KEY variable on the server (Railway → service → Variables)
// and send the same value in the X-Api-Key header. Refused entirely until
// that variable is set — an open write endpoint on a public URL is not a
// default anyone should get silently.
// Accepts one contract object or an array. Each needs a stable external_id
// (its id in the source system): pushing the same external_id again
// UPDATES that contract instead of duplicating it, so the source can
// re-send its full contract list as often as it likes. A contract already
// settled here is left alone — its money has been received and booked.
router.post('/ingest', requireIngestKey, ah(async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const results = [];
  for (const item of items) {
    const {
      source = 'ingest', external_id, commodity, quantity = null, unit = null,
      price_per_unit = null, counterparty = null, delivery_date = null,
      contract_period_end = null, expected_payment_date = null, payment_terms_days = null,
      status = 'open', segment = 'grain', notes = null,
    } = item;
    const total = resolveTotal(item);
    // For AUTOMATED pushes the rule always wins: delivery + terms, else the
    // contract period's last day. A pushed expected_payment_date is only a
    // last resort when neither date exists — experience shows exporters
    // fabricate this field when their schema forces them to have one, and a
    // fabricated payment date silently drags the whole cash-flow forecast
    // to the wrong month. (Manual entry below keeps explicit-wins, because
    // a human typing a date means it.)
    const paymentDate =
      resolvePaymentDate({ expected_payment_date: null, delivery_date, contract_period_end, payment_terms_days })
      ?? expected_payment_date;

    if (!external_id || !commodity || !paymentDate || total == null) {
      results.push({ external_id: external_id || null, ok: false, error: 'external_id, commodity, total_value (or quantity + price_per_unit), and one of expected_payment_date / delivery_date / contract_period_end are required' });
      continue;
    }
    if (!['open', 'delivered', 'cancelled'].includes(status)) {
      results.push({ external_id, ok: false, error: `status must be open, delivered, or cancelled — "settled" can only happen here, when the money is actually received` });
      continue;
    }

    const { rows } = await pool.query(
      `INSERT INTO sale_contracts
        (source, external_id, commodity, quantity, unit, price_per_unit, total_value,
         counterparty, delivery_date, contract_period_end, expected_payment_date, status, segment, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET
         commodity = EXCLUDED.commodity,
         quantity = EXCLUDED.quantity,
         unit = EXCLUDED.unit,
         price_per_unit = EXCLUDED.price_per_unit,
         total_value = EXCLUDED.total_value,
         counterparty = EXCLUDED.counterparty,
         delivery_date = EXCLUDED.delivery_date,
         contract_period_end = EXCLUDED.contract_period_end,
         expected_payment_date = EXCLUDED.expected_payment_date,
         status = EXCLUDED.status,
         segment = EXCLUDED.segment,
         notes = EXCLUDED.notes
       WHERE sale_contracts.status != 'settled'
       RETURNING id, status`,
      [source, external_id, commodity, quantity, unit, price_per_unit, total,
       counterparty, delivery_date || null, contract_period_end || null, paymentDate, status, segment, notes]
    );
    results.push({ external_id, ok: true, skipped_settled: rows.length === 0, id: rows[0]?.id ?? null });
  }
  res.json({ received: items.length, results });
}));

// Manual create from the UI.
router.post('/', ah(async (req, res) => {
  const {
    commodity, quantity = null, unit = null, price_per_unit = null,
    counterparty = null, delivery_date = null, contract_period_end = null,
    expected_payment_date = null, payment_terms_days = null,
    segment = 'grain', notes = null,
  } = req.body;
  const total = resolveTotal(req.body);
  if (total == null) return res.status(400).json({ error: 'total_value, or quantity and price_per_unit, is required' });
  const paymentDate = resolvePaymentDate({ expected_payment_date, delivery_date, contract_period_end, payment_terms_days });
  if (!paymentDate) return res.status(400).json({ error: 'one of expected_payment_date, delivery_date, or contract_period_end is required' });

  const { rows } = await pool.query(
    `INSERT INTO sale_contracts
      (commodity, quantity, unit, price_per_unit, total_value, counterparty, delivery_date, contract_period_end, expected_payment_date, segment, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [commodity, quantity, unit, price_per_unit, total, counterparty,
     delivery_date || null, contract_period_end || null, paymentDate, segment, notes || null]
  );
  res.status(201).json(rows[0]);
}));

// "Record deposit": money for this contract landed in an account (entered
// by hand — it awaits the bank statement like any hand entry). `amount`
// defaults to what's left on the contract.
router.post('/:id/settle', ah(async (req, res) => {
  const { account_id, settled_date = todayISO(), amount = null } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id is required — which account did the money land in?' });
  const r = await withTransaction((client) => settleContract(client, req.params.id, { account_id, date: settled_date, amount }));
  if (!r) return res.status(404).json({ error: 'not found' });
  if (r.alreadyPaid) return res.status(409).json({ error: 'That contract is already settled — reopen it first to add a deposit.' });
  res.json(r.contract);
}));

// Older name for reopen.
router.post('/:id/unsettle', ah(async (req, res) => {
  const c = await withTransaction((client) => reopenContractByHand(client, Number(req.params.id)));
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
}));

// Same guardrail as bills: a settled contract's numbers are locked — its
// transaction already moved money. Unsettle first to correct them.
router.patch('/:id', ah(async (req, res) => {
  const {
    commodity, quantity, unit, price_per_unit, total_value, counterparty,
    delivery_date, contract_period_end, expected_payment_date, status, segment, notes,
    payment_terms_days,
  } = req.body;

  const { rows: currentRows } = await pool.query('SELECT * FROM sale_contracts WHERE id = $1', [req.params.id]);
  if (!currentRows.length) return res.status(404).json({ error: 'not found' });
  const current = currentRows[0];

  if (current.status === 'settled') {
    return res.status(409).json({
      error: 'This contract is settled — the money was received and booked. Reopen it first if something needs correcting.',
    });
  }
  if (status !== undefined && !['open', 'delivered', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'status can only be changed to open, delivered, or cancelled here — use /settle when the money arrives' });
  }

  const merged = {
    commodity: commodity ?? current.commodity,
    quantity: quantity ?? current.quantity,
    unit: unit ?? current.unit,
    price_per_unit: price_per_unit ?? current.price_per_unit,
    counterparty: counterparty ?? current.counterparty,
    delivery_date: delivery_date ?? current.delivery_date,
    contract_period_end: contract_period_end ?? current.contract_period_end,
    status: status ?? current.status,
    segment: segment ?? current.segment,
    notes: notes ?? current.notes,
  };
  // If the dates that drive the payment rule changed and no explicit
  // payment date came with them, re-derive: delivery + terms, else the
  // contract period's last day — same rule as everywhere else.
  merged.expected_payment_date = expected_payment_date
    ?? ((delivery_date !== undefined || contract_period_end !== undefined)
      ? resolvePaymentDate({
          expected_payment_date: null,
          delivery_date: merged.delivery_date,
          contract_period_end: merged.contract_period_end,
          payment_terms_days,
        }) ?? current.expected_payment_date
      : current.expected_payment_date);
  const total = total_value != null
    ? Number(total_value)
    : (quantity !== undefined || price_per_unit !== undefined)
      ? resolveTotal(merged) ?? Number(current.total_value)
      : Number(current.total_value);

  const { rows } = await pool.query(
    `UPDATE sale_contracts SET
       commodity = $1, quantity = $2, unit = $3, price_per_unit = $4, total_value = $5,
       counterparty = $6, delivery_date = $7, contract_period_end = $8, expected_payment_date = $9, status = $10,
       segment = $11, notes = $12
     WHERE id = $13 RETURNING *`,
    [merged.commodity, merged.quantity, merged.unit, merged.price_per_unit, total,
     merged.counterparty, merged.delivery_date, merged.contract_period_end, merged.expected_payment_date, merged.status,
     merged.segment, merged.notes, req.params.id]
  );
  res.json(rows[0]);
}));

router.delete('/:id', ah(async (req, res) => {
  const { rows: currentRows } = await pool.query('SELECT * FROM sale_contracts WHERE id = $1', [req.params.id]);
  if (!currentRows.length) return res.status(404).json({ error: 'not found' });
  const { rows: deps } = await pool.query('SELECT 1 FROM contract_payments WHERE contract_id = $1 LIMIT 1', [req.params.id]);
  if (currentRows[0].status === 'settled' || deps.length) {
    return res.status(409).json({ error: 'Deposits are counted toward this contract — unlink them before deleting it.' });
  }
  await pool.query('DELETE FROM sale_contracts WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

export default router;
