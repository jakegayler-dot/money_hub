import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { createDoc, updateDoc, markPaid, markUnpaid, writePdf, letterhead } from '../lib/farmDocs.js';
import { toISODate } from '../lib/dates.js';

// Invoices and receipts the farm writes (lib/farmDocs.js).
const router = Router();
const shape = (d) => d && ({
  ...d, date: toISODate(d.date), due_date: d.due_date ? toISODate(d.due_date) : null, paid_date: d.paid_date ? toISODate(d.paid_date) : null,
  subtotal: Number(d.subtotal), gst: Number(d.gst), total: Number(d.total),
});

router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.*, a.name AS account FROM farm_documents d LEFT JOIN accounts a ON a.id = d.account_id
     ORDER BY d.date DESC, d.id DESC`);
  res.json(rows.map(shape));
}));

// The farm's name, address, phone, email and GST number, printed at the top.
router.get('/letterhead', ah(async (req, res) => { res.json(await letterhead()); }));
router.put('/letterhead', ah(async (req, res) => {
  const b = req.body || {};
  const v = Object.fromEntries(['name', 'address', 'phone', 'email', 'gst_number'].map((k) => [k, String(b[k] || '').trim()]));
  await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['farm_letterhead', JSON.stringify(v)]);
  res.json(v);
}));

router.post('/', ah(async (req, res) => {
  const d = await withTransaction((c) => createDoc(c, req.body || {}));
  res.status(201).json(shape(d));
}));

router.patch('/:id', ah(async (req, res) => {
  const d = await withTransaction((c) => updateDoc(c, Number(req.params.id), req.body || {}));
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json(shape(d));
}));

// Paid: { account_id, date, paid_by } books the deposit; { transaction_id } links one already in the ledger.
router.post('/:id/pay', ah(async (req, res) => {
  const d = await withTransaction((c) => markPaid(c, Number(req.params.id), req.body || {}));
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json(shape(d));
}));

router.post('/:id/unpay', ah(async (req, res) => {
  const d = await withTransaction((c) => markUnpaid(c, Number(req.params.id)));
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json(shape(d));
}));

// Void keeps the number (numbers are never reused); a paid one is unpaid first.
router.post('/:id/void', ah(async (req, res) => {
  const d = await withTransaction(async (c) => {
    const { rows: [x] } = await c.query('SELECT status FROM farm_documents WHERE id = $1', [req.params.id]);
    if (!x) return null;
    if (x.status === 'paid') { const e = new Error('Undo the payment first, then void it.'); e.status = 400; throw e; }
    const { rows: [o] } = await c.query(`UPDATE farm_documents SET status = 'void' WHERE id = $1 RETURNING *`, [req.params.id]);
    return o;
  });
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json(shape(d));
}));

// Ledger entries that could be this document's payment: the right direction, near the amount, not paying anything else.
router.get('/:id/candidates', ah(async (req, res) => {
  const { rows: [d] } = await pool.query('SELECT * FROM farm_documents WHERE id = $1', [req.params.id]);
  if (!d) return res.status(404).json({ error: 'not found' });
  const sign = d.kind === 'payment_receipt' ? -1 : 1;
  const { rows } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, a.name AS account FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.credit_card_id IS NULL AND NOT t.is_transfer AND sign(t.amount) = $1
       AND t.date BETWEEN $2::date - 30 AND $2::date + 120
       AND abs(abs(t.amount) - $3) <= greatest(1, $3 * 0.02)
       AND NOT EXISTS (SELECT 1 FROM farm_documents x WHERE x.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM bills x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM loan_payments x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM contract_payments x WHERE x.transaction_id = t.id)
     ORDER BY abs(abs(t.amount) - $3), abs(t.date - $2::date) LIMIT 6`, [sign, toISODate(d.date), Number(d.total)]);
  res.json(rows.map((t) => ({ ...t, date: toISODate(t.date), amount: Number(t.amount) })));
}));

router.get('/:id/pdf', ah(async (req, res) => {
  const { rows: [d] } = await pool.query('SELECT * FROM farm_documents WHERE id = $1', [req.params.id]);
  if (!d) return res.status(404).json({ error: 'not found' });
  const asReceipt = req.query.as === 'receipt' && d.kind === 'invoice' && d.status === 'paid';
  const name = `${asReceipt ? d.receipt_number : d.number} ${d.party_name}`.replace(/[^\w.-]+/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}.pdf"`);
  await writePdf(d, res, { asReceipt });
}));

// Only an open or void document that never moved money can be deleted.
router.delete('/:id', ah(async (req, res) => {
  const { rows: [d] } = await pool.query('SELECT status, transaction_id FROM farm_documents WHERE id = $1', [req.params.id]);
  if (!d) return res.status(404).json({ error: 'not found' });
  if (d.status === 'paid') return res.status(400).json({ error: 'Undo the payment first.' });
  await pool.query('DELETE FROM farm_documents WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

export default router;
