import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';

const router = Router();

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

router.get('/', ah(async (req, res) => {
  const { status } = req.query;
  const where = status ? 'WHERE status = $1' : '';
  const params = status ? [status] : [];
  const { rows } = await pool.query(
    `SELECT * FROM sale_contracts ${where}
     ORDER BY (status IN ('open','delivered')) DESC, expected_payment_date ASC`,
    params
  );
  res.json(rows);
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
router.post('/ingest', ah(async (req, res) => {
  const configuredKey = process.env.INGEST_API_KEY;
  if (!configuredKey) {
    return res.status(503).json({ error: 'Ingest is not enabled: set the INGEST_API_KEY environment variable on the server first.' });
  }
  if (req.get('x-api-key') !== configuredKey) {
    return res.status(401).json({ error: 'Invalid or missing X-Api-Key header.' });
  }

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

// Settling a contract is the moment money actually arrives: creates the
// inflow transaction (positive amount, tagged with the contract's
// enterprise segment), moves the account balance, marks the contract
// settled — one DB transaction, same integrity pattern as paying a bill.
// `amount` may override the contracted value, because final settlement
// often differs (dockage, grade adjustments, final weights).
router.post('/:id/settle', ah(async (req, res) => {
  const {
    account_id,
    settled_date = new Date().toISOString().slice(0, 10),
    amount = null,
  } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id is required — which account did the money land in?' });

  const contract = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM sale_contracts WHERE id = $1', [req.params.id]);
    if (!rows.length) return null;
    const contract = rows[0];
    if (contract.status === 'settled') return contract;

    const received = amount != null ? Number(amount) : Number(contract.total_value);
    const ledger = contract.segment === 'personal' ? 'personal' : 'business';
    const { rows: txRows } = await client.query(
      `INSERT INTO transactions (account_id, ledger, date, amount, description, entered_by, segment, cleared, cleared_date)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, true, $3) RETURNING id`,
      [account_id, ledger, settled_date, Math.abs(received),
       `Contract settled: ${contract.commodity}${contract.counterparty ? ` — ${contract.counterparty}` : ''}`,
       contract.segment]
    );
    await client.query(
      `UPDATE accounts SET opening_balance = opening_balance + $1 WHERE id = $2`,
      [Math.abs(received), account_id]
    );
    const { rows: updated } = await client.query(
      `UPDATE sale_contracts SET status = 'settled', linked_transaction_id = $1 WHERE id = $2 RETURNING *`,
      [txRows[0].id, contract.id]
    );
    return updated[0];
  });

  if (!contract) return res.status(404).json({ error: 'not found' });
  res.json(contract);
}));

// Mirror of a bill's unpay: deletes the settlement transaction, pulls the
// money back out of the balance, reopens the contract.
router.post('/:id/unsettle', ah(async (req, res) => {
  const contract = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM sale_contracts WHERE id = $1', [req.params.id]);
    if (!rows.length) return null;
    const contract = rows[0];
    if (contract.status !== 'settled') return contract;

    if (contract.linked_transaction_id) {
      const { rows: txRows } = await client.query('SELECT * FROM transactions WHERE id = $1', [contract.linked_transaction_id]);
      if (txRows.length) {
        const tx = txRows[0];
        await client.query(
          `UPDATE accounts SET opening_balance = opening_balance - $1 WHERE id = $2`,
          [tx.amount, tx.account_id]
        );
        await client.query('DELETE FROM transactions WHERE id = $1', [tx.id]);
      }
    }
    const { rows: updated } = await client.query(
      `UPDATE sale_contracts SET status = 'open', linked_transaction_id = NULL WHERE id = $1 RETURNING *`,
      [contract.id]
    );
    return updated[0];
  });

  if (!contract) return res.status(404).json({ error: 'not found' });
  res.json(contract);
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
      error: 'This contract is settled — the money was received and booked. Unsettle it first if something needs correcting.',
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
  if (currentRows[0].status === 'settled') {
    return res.status(409).json({ error: 'This contract is settled and linked to a booked transaction — unsettle it before deleting.' });
  }
  await pool.query('DELETE FROM sale_contracts WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

export default router;
