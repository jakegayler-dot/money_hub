import express, { Router } from 'express';
import crypto from 'node:crypto';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { isAuthorized } from '../lib/appAuth.js';
import { processReceipt, matchReceipt, attachReceipt, readerEnabled } from '../lib/receipts.js';
import { toISODate } from '../lib/dates.js';

// Upload is mounted before the sign-in guard so the iPhone Shortcut can
// post with a key instead of a browser session.
export const receiptUpload = Router();

const sameText = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const uploadKeyOk = (req) => {
  const key = process.env.RECEIPT_UPLOAD_KEY;
  const sent = req.get('x-receipt-key');
  return !!key && !!sent && sameText(sent, key);
};

// What kind of file the bytes are (the Content-Type a phone sends isn't
// always right). Claude reads JPEG, PNG, WebP, GIF and PDF.
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf.slice(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buf.slice(4, 8).toString() === 'ftyp') return 'heic';
  return null;
}

// A Shortcut can send the photo three ways: as the raw body ("File"), as a
// form field ("Form" — multipart), or base64 inside JSON. Take any of them.
function imageFrom(req) {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || !buf.length) return null;
  const type = String(req.get('content-type') || '');
  const boundary = /multipart\/form-data/i.test(type) && (type.match(/boundary=(?:"([^"]+)"|([^;]+))/i) || []).slice(1).find(Boolean);
  if (boundary) {
    const sep = Buffer.from(`--${boundary}`);
    let at = buf.indexOf(sep);
    while (at !== -1) {
      const next = buf.indexOf(sep, at + sep.length);
      if (next === -1) break;
      const part = buf.subarray(at + sep.length, next);
      const headEnd = part.indexOf('\r\n\r\n');
      if (headEnd !== -1) {
        const body = part.subarray(headEnd + 4, part.length - 2); // drop the trailing CRLF
        if (body.length > 64 && sniff(body)) return body;
      }
      at = next;
    }
    return null;
  }
  if (/json/i.test(type)) {
    try {
      const j = JSON.parse(buf.toString('utf8'));
      const b64 = j.image || j.file || j.photo || Object.values(j).find((v) => typeof v === 'string' && v.length > 1000);
      return b64 ? Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64') : null;
    } catch { return null; }
  }
  return buf;
}

receiptUpload.post('/', express.raw({ type: () => true, limit: '25mb' }), ah(async (req, res) => {
  if (!isAuthorized(req) && !uploadKeyOk(req)) return res.status(401).json({ error: 'Missing or wrong X-Receipt-Key.' });
  const buf = imageFrom(req);
  if (!buf || !buf.length) {
    const got = Buffer.isBuffer(req.body) ? req.body.length : 0;
    console.warn(`Receipt upload with no image: content-type "${req.get('content-type') || 'none'}", ${got} bytes`);
    return res.status(400).json({
      error: got
        ? `Got ${got} bytes as "${req.get('content-type') || 'no type'}" but no photo in it. In the Shortcut set Request Body to File and pick the Converted Image.`
        : 'No photo arrived. In the Shortcut, set Request Body to File and tap the File field to pick "Converted Image".',
    });
  }
  const mime = sniff(buf);
  if (mime === 'heic') return res.status(415).json({ error: 'HEIC photo — convert it to JPEG first (the Shortcut’s "Convert Image" step does this).' });
  if (!mime) return res.status(415).json({ error: 'Not a JPEG, PNG, WebP or GIF image, or a PDF.' });
  // A photo added on the Bills tab belongs to that bill: the bill already
  // says what it's for, so it isn't read — it's filed as that invoice, and
  // attaches to the bill's payment once there is one.
  const billId = Number(req.query.bill_id) || null;
  if (billId) {
    const { rows: [bill] } = await pool.query('SELECT * FROM bills WHERE id = $1', [billId]);
    if (!bill) return res.status(404).json({ error: 'Bill not found.' });
    const ex = {
      is_receipt: true, doc_type: 'invoice', party: bill.name,
      date: toISODate(bill.received_date || bill.due_date), due_date: toISODate(bill.due_date),
      total: Number(bill.amount), gst: bill.has_gst ? Number(bill.gst_amount) : null,
      category: bill.category, category_id: bill.category_id, notes: '',
    };
    const { rows: [r] } = await pool.query(
      `INSERT INTO receipts (source, mime, bytes, image, bill_id, extracted, status) VALUES ('app', $1, $2, $3, $4, $5, 'billed') RETURNING id`,
      [mime, buf.length, buf, billId, ex]
    );
    await matchReceipt(r.id).catch((e) => console.error('Invoice attach failed', r.id, e.message));
    return res.status(201).json({ id: r.id, ok: true, message: 'Invoice photo added to the bill.' });
  }
  const { rows: [r] } = await pool.query(
    `INSERT INTO receipts (source, mime, bytes, image) VALUES ($1, $2, $3, $4) RETURNING id`,
    [uploadKeyOk(req) ? 'shortcut' : 'app', mime, buf.length, buf]
  );
  setImmediate(() => processReceipt(r.id).catch((e) => console.error('Receipt read failed', r.id, e.message)));
  res.status(201).json({ id: r.id, ok: true, message: readerEnabled() ? 'Receipt saved — reading it now.' : 'Receipt saved.' });
}));

const router = Router();

const LIST = `
  SELECT r.id, r.uploaded_at, r.source, r.bytes, r.mime, r.status, r.extracted, r.candidates, r.transaction_id, r.error, r.matched_at, r.bill_id,
         b.name AS bill_name, b.due_date AS bill_due, b.status AS bill_status, b.amount AS bill_amount,
         t.date AS tx_date, t.amount AS tx_amount, t.description AS tx_description, a.name AS tx_account, cc.name AS tx_card
  FROM receipts r
  LEFT JOIN transactions t ON t.id = r.transaction_id
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
  LEFT JOIN bills b ON b.id = r.bill_id`;
const shape = (r) => ({
  ...r, tx_date: toISODate(r.tx_date), tx_amount: r.tx_amount == null ? null : Number(r.tx_amount),
  bill_due: r.bill_due ? toISODate(r.bill_due) : null, bill_amount: r.bill_amount == null ? null : Number(r.bill_amount),
});

router.get('/', ah(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.status) { params.push(String(req.query.status).split(',')); where = `WHERE r.status = ANY($1)`; }
  const { rows } = await pool.query(`${LIST} ${where} ORDER BY r.uploaded_at DESC LIMIT 300`, params);
  res.json({ reader: readerEnabled(), upload_key_set: !!process.env.RECEIPT_UPLOAD_KEY, receipts: rows.map(shape) });
}));

// Farm purchases over $50 this year with no receipt photo — the same rule as the Books tab.
router.get('/missing', ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, t.gst_amount, p.name AS payee, a.name AS account_name, cc.name AS card_name
     FROM transactions t
     LEFT JOIN payees p ON p.id = t.payee_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     WHERE t.amount < -50 AND NOT t.is_transfer AND NOT t.is_debt_service
       AND NOT (t.account_id IS NOT NULL AND t.credit_card_id IS NOT NULL)
       AND EXTRACT(YEAR FROM t.date) = $1
       AND (t.segment IN ('grain', 'livestock') OR COALESCE(t.segment_grain_pct, 0) + COALESCE(t.segment_livestock_pct, 0) > 0
            OR (t.segment IS NULL AND NOT t.is_segment_split AND t.ledger = 'business'))
       AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)
     ORDER BY t.date DESC LIMIT 500`,
    [year]
  );
  res.json(rows.map((t) => ({ ...t, date: toISODate(t.date), amount: Number(t.amount), gst_amount: t.gst_amount == null ? null : Number(t.gst_amount) })));
}));

router.get('/:id/image', ah(async (req, res) => {
  const { rows: [r] } = await pool.query('SELECT mime, image FROM receipts WHERE id = $1', [req.params.id]);
  if (!r) return res.status(404).end();
  res.set('Content-Type', r.mime).set('Cache-Control', 'private, max-age=86400')
    .set('Content-Disposition', `inline; filename="document-${req.params.id}.${r.mime === 'application/pdf' ? 'pdf' : r.mime.split('/')[1]}"`)
    .send(r.image);
}));

router.post('/:id/retry', ah(async (req, res) => {
  await pool.query(`UPDATE receipts SET status = 'reading', error = NULL WHERE id = $1`, [req.params.id]);
  await processReceipt(Number(req.params.id));
  const { rows } = await pool.query(`${LIST} WHERE r.id = $1`, [req.params.id]);
  res.json(rows[0] ? shape(rows[0]) : null);
}));

// Correct what was read (or type it in when there's no reader), then match again.
router.patch('/:id', ah(async (req, res) => {
  const { rows: [r] } = await pool.query('SELECT * FROM receipts WHERE id = $1', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'not found' });
  const ex = { ...(r.extracted || {}), is_receipt: true };
  for (const k of ['date', 'total', 'gst', 'party', 'due_date', 'doc_type']) if (req.body[k] !== undefined) ex[k] = req.body[k] === '' ? null : req.body[k];
  if (ex.total != null) ex.total = Number(ex.total);
  if (ex.gst != null) ex.gst = Number(ex.gst);
  if (!['receipt', 'invoice', 'sales_ticket'].includes(ex.doc_type)) ex.doc_type = 'receipt';
  const status = r.status === 'matched' ? 'matched' : 'unmatched';
  await pool.query('UPDATE receipts SET extracted = $2, status = $3, error = NULL WHERE id = $1', [r.id, ex, status]);
  if (status !== 'matched') await matchReceipt(r.id);
  const { rows } = await pool.query(`${LIST} WHERE r.id = $1`, [r.id]);
  res.json(shape(rows[0]));
}));

// Transactions this receipt could belong to, for attaching by hand.
router.get('/:id/suggest', ah(async (req, res) => {
  const { rows: [r] } = await pool.query('SELECT extracted FROM receipts WHERE id = $1', [req.params.id]);
  const ex = r?.extracted || {};
  const incoming = ex.doc_type === 'sales_ticket';
  const total = Number(ex.total) || 0;
  const date = ex.date || toISODate(new Date());
  const { rows } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, a.name AS account_name, cc.name AS card_name
     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     WHERE ${incoming ? 't.amount > 0' : 't.amount < 0'} AND NOT t.is_transfer AND t.date BETWEEN $1::date - 30 AND $1::date + ${incoming ? 60 : 30}
       AND NOT EXISTS (SELECT 1 FROM receipts x WHERE x.transaction_id = t.id)
     ORDER BY abs(abs(t.amount) - $2), abs(t.date - $1::date) LIMIT 12`,
    [date, total]
  );
  res.json(rows.map((t) => ({ ...t, date: toISODate(t.date), amount: Number(t.amount) })));
}));

router.post('/:id/attach', ah(async (req, res) => {
  await attachReceipt(Number(req.params.id), Number(req.body?.transaction_id));
  res.json({ ok: true });
}));

router.post('/:id/detach', ah(async (req, res) => {
  await pool.query(`UPDATE receipts SET transaction_id = NULL, status = 'unmatched', matched_at = NULL WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM receipts WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
