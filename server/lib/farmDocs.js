// Invoices and receipts the farm writes (Jake, 2026-10-26: "a way to
// generate invoices and receipts"). Three kinds:
//
//   invoice          the farm bills a customer (hay, custom work, a private
//                    cattle sale). Open, it's money owed to the farm — in
//                    Cash Flow on its due date. Marked paid, the deposit is
//                    booked (or an entry already in the ledger is linked)
//                    and it gets a receipt number: the same document then
//                    prints as the receipt.
//   sale_receipt     a sale paid on the spot: the deposit is booked now.
//   payment_receipt  the farm pays someone (land rent, casual labour, a cash
//                    buy): the payment is booked now, and the PDF has a line
//                    for them to sign that they were paid.
//
// Lines are { description, qty, unit_price, gst (true = 5% GST on it),
// category_id }. Booking files the money under the lines' categories (one
// category → that category; several → split), with GST on the entry so the
// GST return sees it, under the document's owner.
import { getSetting } from '../db.js';
import { insertTransaction, removeTransaction, ownerOf, payeeId } from './postings.js';
import { SEGMENT_COLUMNS, segmentValues, validateSegment } from './segments.js';
import { toISODate, todayISO } from './dates.js';

export const KINDS = { invoice: 'INV', sale_receipt: 'RCT', payment_receipt: 'PMT' };
export const GST_RATE = 0.05;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };

/** Cleans the lines and works out the totals (pure — exported for tests). */
export function totalsOf(lines) {
  const clean = (Array.isArray(lines) ? lines : []).map((l) => {
    const qty = l.qty === '' || l.qty == null ? 1 : Number(l.qty);
    const unit = Number(l.unit_price);
    return {
      description: String(l.description || '').trim(), qty, unit_price: r2(unit),
      gst: !!l.gst, category_id: l.category_id ? Number(l.category_id) : null,
      amount: r2(qty * unit),
    };
  }).filter((l) => l.description || l.amount);
  for (const l of clean) {
    if (!l.description) throw bad('Every line needs a description.');
    if (!Number.isFinite(l.amount) || !(l.qty > 0)) throw bad(`"${l.description}": the quantity and price must be numbers, quantity more than zero.`);
  }
  const subtotal = r2(clean.reduce((a, l) => a + l.amount, 0));
  const gst = r2(clean.filter((l) => l.gst).reduce((a, l) => a + l.amount * GST_RATE, 0));
  return { lines: clean, subtotal, gst, total: r2(subtotal + gst) };
}

/** The next number for a kind: INV-0001, RCT-0001, PMT-0001 (an invoice's receipt takes the next RCT). */
async function nextNumber(client, prefix) {
  const { rows: [r] } = await client.query(
    `SELECT MAX(CAST(SUBSTRING(n FROM '[0-9]+$') AS INTEGER)) AS top FROM (
       SELECT number AS n FROM farm_documents WHERE number LIKE $1
       UNION ALL SELECT receipt_number FROM farm_documents WHERE receipt_number LIKE $1) x`, [`${prefix}-%`]);
  return `${prefix}-${String((Number(r.top) || 0) + 1).padStart(4, '0')}`;
}

/** The entry that moves the money: in for a sale, out for a payment. */
async function book(client, doc, { account_id, date }) {
  if (!account_id) throw bad('Which account did the money go into or come out of?');
  const { rows: [acct] } = await client.query('SELECT id FROM accounts WHERE id = $1', [account_id]);
  if (!acct) throw bad('That account is not on file.');
  const sign = doc.kind === 'payment_receipt' ? -1 : 1;
  const owner = ownerOf(doc, { segment: 'grain' });
  const lines = doc.lines || [];
  // Each category's share, GST included.
  const byCat = new Map();
  for (const l of lines) {
    const k = l.category_id || null;
    byCat.set(k, r2((byCat.get(k) || 0) + l.amount * (l.gst ? 1 + GST_RATE : 1)));
  }
  const groups = [...byCat];
  let splits = [];
  let category_id = null;
  if (groups.length === 1) category_id = groups[0][0];
  else {
    splits = groups.map(([cat, amt]) => ({ amount: r2(sign * amt), category_id: cat, memo: null, ledger: undefined, is_capex: false, owner }));
    // The pieces add to the total exactly.
    const off = r2(sign * Number(doc.total) - splits.reduce((a, s) => a + s.amount, 0));
    if (splits.length && Math.abs(off) >= 0.005) splits[0].amount = r2(splits[0].amount + off);
    for (const s of splits) s.ledger = owner.is_segment_split ? 'business' : (['jake', 'ashley'].includes(owner.segment) ? 'personal' : 'business');
  }
  const label = doc.kind === 'invoice' ? `Invoice ${doc.number}` : doc.kind === 'sale_receipt' ? `Receipt ${doc.number}` : `Payment ${doc.number}`;
  return insertTransaction(client, {
    account_id, date, amount: r2(sign * Number(doc.total)),
    description: `${label} — ${doc.party_name}${doc.paid_by ? ` (${doc.paid_by})` : ''}`,
    category_id, splits, payee_id: doc.payee_id || null,
    gst_amount: Number(doc.gst) > 0 ? r2(sign * Number(doc.gst)) : null,
    owner, awaiting_statement: 'fed',
  });
}

/** Creates a document; a sale or payment receipt is booked straight away. */
export async function createDoc(client, body) {
  const kind = body.kind;
  if (!KINDS[kind]) throw bad('kind is invoice, sale_receipt or payment_receipt.');
  const party = String(body.party_name || '').trim();
  if (!party) throw bad(kind === 'payment_receipt' ? 'Who was paid?' : 'Who is it to?');
  const segErr = validateSegment(body);
  if (segErr) throw bad(segErr);
  const t = totalsOf(body.lines);
  if (!t.lines.length) throw bad('Add at least one line.');
  if (!(t.total > 0)) throw bad('The total must be more than zero.');
  const date = body.date || todayISO();
  const due = kind === 'invoice' ? (body.due_date || null) : null;
  const pid = await payeeId(client, party);
  const number = await nextNumber(client, KINDS[kind]);
  const { rows: [doc] } = await client.query(
    `INSERT INTO farm_documents (kind, number, party_name, party_address, payee_id, date, due_date, lines, subtotal, gst, total, notes, paid_by,
       ${SEGMENT_COLUMNS.join(', ')})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,${SEGMENT_COLUMNS.map((_, i) => `$${14 + i}`).join(',')}) RETURNING *`,
    [kind, number, party, String(body.party_address || '').trim() || null, pid, date, due, JSON.stringify(t.lines), t.subtotal, t.gst, t.total,
      String(body.notes || '').trim() || null, String(body.paid_by || '').trim() || null, ...segmentValues(body.segment || body.is_segment_split ? body : { segment: 'grain' })]);
  if (kind !== 'invoice') return markPaid(client, doc.id, { account_id: body.account_id, date, transaction_id: body.transaction_id, paid_by: body.paid_by });
  return doc;
}

/**
 * Money moved: books it (or links `transaction_id`, an entry already in the
 * ledger — it keeps its own category if it has one) and, for an invoice,
 * gives it its receipt number.
 */
export async function markPaid(client, id, { account_id, date, transaction_id = null, paid_by } = {}) {
  const { rows: [doc] } = await client.query('SELECT * FROM farm_documents WHERE id = $1 FOR UPDATE', [id]);
  if (!doc) return null;
  if (doc.status === 'paid') throw bad(`${doc.number} is already paid.`);
  if (doc.status === 'void') throw bad(`${doc.number} is void.`);
  const on = date || todayISO();
  const by = paid_by != null && String(paid_by).trim() ? String(paid_by).trim() : doc.paid_by;
  let tx;
  let existing = false;
  if (transaction_id) {
    const { rows: [t] } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [transaction_id]);
    if (!t) throw bad('That ledger entry is not on file.');
    const wantIn = doc.kind !== 'payment_receipt';
    if (wantIn ? Number(t.amount) <= 0 : Number(t.amount) >= 0) throw bad(wantIn ? 'Pick money coming in.' : 'Pick money going out.');
    const { rows: [used] } = await client.query('SELECT number FROM farm_documents WHERE transaction_id = $1', [t.id]);
    if (used) throw bad(`That entry already pays ${used.number}.`);
    const lines = doc.lines || [];
    const cats = [...new Set(lines.map((l) => l.category_id).filter(Boolean))];
    if (!t.category_id && !t.is_split && cats.length === 1) await client.query('UPDATE transactions SET category_id = $1 WHERE id = $2', [cats[0], t.id]);
    tx = t; existing = true;
  } else {
    tx = await book(client, { ...doc, paid_by: by }, { account_id: Number(account_id) || null, date: on });
  }
  const receipt = doc.kind === 'invoice' ? await nextNumber(client, 'RCT') : null;
  const { rows: [out] } = await client.query(
    `UPDATE farm_documents SET status = 'paid', paid_date = $2, account_id = $3, transaction_id = $4, linked_existing = $5,
       receipt_number = COALESCE(receipt_number, $6), paid_by = $7 WHERE id = $1 RETURNING *`,
    [id, existing ? toISODate(tx.date) : on, tx.account_id || null, tx.id, existing, receipt, by]);
  return out;
}

/** Undoes a payment: the entry booked here goes; one already in the ledger stays, unlinked. The receipt number is kept for when it's paid again. */
export async function markUnpaid(client, id) {
  const { rows: [doc] } = await client.query('SELECT * FROM farm_documents WHERE id = $1 FOR UPDATE', [id]);
  if (!doc) return null;
  if (doc.status !== 'paid') return doc;
  const txId = doc.transaction_id;
  const { rows: [out] } = await client.query(
    `UPDATE farm_documents SET status = 'open', paid_date = NULL, account_id = NULL, transaction_id = NULL, linked_existing = false WHERE id = $1 RETURNING *`, [id]);
  if (txId && !doc.linked_existing) await removeTransaction(client, txId);
  return out;
}

/** Open documents only can be edited: lines, party, dates, notes, owner. */
export async function updateDoc(client, id, body) {
  const { rows: [doc] } = await client.query('SELECT * FROM farm_documents WHERE id = $1 FOR UPDATE', [id]);
  if (!doc) return null;
  if (doc.status !== 'open') throw bad(`${doc.number} is ${doc.status} — undo the payment first to change it.`);
  const merged = { ...doc, ...body };
  const segErr = validateSegment(merged);
  if (segErr) throw bad(segErr);
  const t = totalsOf(body.lines !== undefined ? body.lines : doc.lines);
  if (!t.lines.length || !(t.total > 0)) throw bad('Add at least one line, with a total over zero.');
  const party = String(merged.party_name || '').trim();
  if (!party) throw bad('Who is it to?');
  const pid = party !== doc.party_name ? await payeeId(client, party) : doc.payee_id;
  const { rows: [out] } = await client.query(
    `UPDATE farm_documents SET party_name = $2, party_address = $3, payee_id = $4, date = $5, due_date = $6, lines = $7, subtotal = $8, gst = $9, total = $10,
       notes = $11, paid_by = $12, ${SEGMENT_COLUMNS.map((c, i) => `${c} = $${13 + i}`).join(', ')} WHERE id = $1 RETURNING *`,
    [id, party, String(merged.party_address || '').trim() || null, pid, merged.date, doc.kind === 'invoice' ? (merged.due_date || null) : null,
      JSON.stringify(t.lines), t.subtotal, t.gst, t.total, String(merged.notes || '').trim() || null, String(merged.paid_by || '').trim() || null,
      ...segmentValues(merged)]);
  return out;
}

export async function letterhead() {
  const v = await getSetting('farm_letterhead', null);
  const o = v && typeof v === 'object' ? v : {};
  return { name: o.name || '', address: o.address || '', phone: o.phone || '', email: o.email || '', gst_number: o.gst_number || '' };
}

/** Writes the document as a PDF to `out` (a writable stream). `asReceipt`: a paid invoice printed as its receipt. */
export async function writePdf(doc, out, { asReceipt = false } = {}) {
  const { default: PDFDocument } = await import('pdfkit');
  const lh = await letterhead();
  const pdf = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: doc.number } });
  pdf.pipe(out);
  const W = pdf.page.width - 108;
  const L = 54;
  const ink = '#1d232b'; const muted = '#5d6773'; const rule = '#c9ced4';
  const money = (n) => `$${Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtDate = (d) => { if (!d) return ''; const [y, m, dd] = toISODate(d).split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }); };
  const receiptView = doc.kind !== 'invoice' || asReceipt;
  const title = doc.kind === 'payment_receipt' ? 'PAYMENT RECEIPT' : receiptView ? 'RECEIPT' : 'INVOICE';
  const number = doc.kind === 'invoice' && asReceipt ? doc.receipt_number : doc.number;

  // Letterhead, left; the title and number, right.
  pdf.fillColor(ink).font('Helvetica-Bold').fontSize(16).text(lh.name || 'Your farm', L, 54, { width: W * 0.6 });
  pdf.font('Helvetica').fontSize(9.5).fillColor(muted);
  for (const line of [lh.address, [lh.phone, lh.email].filter(Boolean).join('  ·  '), lh.gst_number ? `GST/HST no. ${lh.gst_number}` : ''].flatMap((s) => String(s || '').split('\n')).filter(Boolean)) {
    pdf.text(line, { width: W * 0.6 });
  }
  pdf.font('Helvetica-Bold').fontSize(20).fillColor(ink).text(title, L + W * 0.5, 54, { width: W * 0.5, align: 'right' });
  pdf.font('Helvetica').fontSize(10).fillColor(muted).text(number, L + W * 0.5, pdf.y + 2, { width: W * 0.5, align: 'right' });
  if (doc.kind === 'invoice' && asReceipt) pdf.text(`for invoice ${doc.number}`, { width: W * 0.5, align: 'right' });

  let y = Math.max(pdf.y, 130) + 18;
  pdf.moveTo(L, y).lineTo(L + W, y).strokeColor(rule).lineWidth(0.8).stroke();
  y += 14;

  // Who, and the dates.
  const who = doc.kind === 'payment_receipt' ? 'PAID TO' : receiptView ? 'RECEIVED FROM' : 'BILL TO';
  pdf.font('Helvetica-Bold').fontSize(8).fillColor(muted).text(who, L, y);
  pdf.font('Helvetica-Bold').fontSize(11).fillColor(ink).text(doc.party_name, L, y + 12, { width: W * 0.55 });
  if (doc.party_address) pdf.font('Helvetica').fontSize(9.5).fillColor(muted).text(doc.party_address, { width: W * 0.55 });
  const leftEnd = pdf.y;
  const facts = [
    [receiptView && doc.kind === 'invoice' ? 'Paid on' : 'Date', fmtDate(receiptView && doc.kind === 'invoice' ? doc.paid_date : doc.date)],
    ...(doc.kind === 'invoice' && !asReceipt && doc.due_date ? [['Due', fmtDate(doc.due_date)]] : []),
    ...(receiptView && doc.paid_by ? [['Paid by', doc.paid_by]] : []),
  ];
  let fy = y;
  for (const [k, v] of facts) {
    pdf.font('Helvetica').fontSize(9.5).fillColor(muted).text(k, L + W * 0.6, fy, { width: W * 0.15 });
    pdf.fillColor(ink).text(v, L + W * 0.75, fy, { width: W * 0.25, align: 'right' });
    fy += 15;
  }
  y = Math.max(leftEnd, fy) + 22;

  // Lines.
  const cols = [[L, W * 0.52, 'Description', 'left'], [L + W * 0.52, W * 0.12, 'Qty', 'right'], [L + W * 0.64, W * 0.17, 'Unit price', 'right'], [L + W * 0.81, W * 0.19, 'Amount', 'right']];
  pdf.rect(L, y - 5, W, 20).fill('#eef0f2');
  pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(muted);
  for (const [x, w, h, a] of cols) pdf.text(h.toUpperCase(), x + (a === 'left' ? 6 : 0), y + 1, { width: w - 6, align: a });
  y += 22;
  pdf.font('Helvetica').fontSize(10).fillColor(ink);
  for (const l of doc.lines || []) {
    const desc = `${l.description}${l.gst ? '  (GST)' : ''}`;
    const h = Math.max(14, pdf.heightOfString(desc, { width: cols[0][1] - 6 }));
    if (y + h > pdf.page.height - 150) { pdf.addPage(); y = 54; }
    pdf.text(desc, L + 6, y, { width: cols[0][1] - 6 });
    pdf.text(Number(l.qty) % 1 ? String(Number(l.qty)) : String(Number(l.qty)), cols[1][0], y, { width: cols[1][1] - 6, align: 'right' });
    pdf.text(money(l.unit_price), cols[2][0], y, { width: cols[2][1] - 6, align: 'right' });
    pdf.text(money(l.amount), cols[3][0], y, { width: cols[3][1] - 6, align: 'right' });
    y += h + 6;
    pdf.moveTo(L, y - 3).lineTo(L + W, y - 3).strokeColor('#e3e6e9').lineWidth(0.5).stroke();
  }

  // Totals.
  y += 8;
  const tot = (k, v, bold = false) => {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? ink : muted).text(k, L + W * 0.55, y, { width: W * 0.26, align: 'right' });
    pdf.fillColor(ink).text(v, L + W * 0.81, y, { width: W * 0.19 - 6, align: 'right' });
    y += bold ? 20 : 15;
  };
  tot('Subtotal', money(doc.subtotal));
  if (Number(doc.gst) > 0) tot(`GST ${Math.round(GST_RATE * 100)}%`, money(doc.gst));
  pdf.moveTo(L + W * 0.6, y).lineTo(L + W, y).strokeColor(rule).lineWidth(0.8).stroke();
  y += 6;
  tot(receiptView ? (doc.kind === 'payment_receipt' ? 'Total paid' : 'Total received') : 'Total due', money(doc.total), true);

  if (receiptView) {
    pdf.font('Helvetica-Bold').fontSize(13).fillColor('#1f7a4d').text('PAID', L, y - 34, { width: 120 });
  }
  y += 16;
  if (doc.notes) {
    pdf.font('Helvetica-Bold').fontSize(8).fillColor(muted).text('NOTES', L, y);
    pdf.font('Helvetica').fontSize(9.5).fillColor(ink).text(doc.notes, L, y + 12, { width: W });
    y = pdf.y + 16;
  }
  if (doc.kind === 'invoice' && !asReceipt) {
    pdf.font('Helvetica').fontSize(9.5).fillColor(muted).text(`Please pay ${lh.name || 'us'}${doc.due_date ? ` by ${fmtDate(doc.due_date)}` : ''}, quoting ${doc.number}.`, L, y, { width: W });
    y = pdf.y + 16;
  }
  if (doc.kind === 'payment_receipt') {
    // For the person paid to sign.
    y = Math.max(y + 30, pdf.page.height - 170);
    pdf.font('Helvetica').fontSize(9.5).fillColor(ink).text(`I, ${doc.party_name}, received ${money(doc.total)} from ${lh.name || 'the farm'} on ${fmtDate(doc.paid_date || doc.date)}.`, L, y, { width: W });
    y = pdf.y + 34;
    pdf.moveTo(L, y).lineTo(L + W * 0.45, y).strokeColor(ink).lineWidth(0.6).stroke();
    pdf.moveTo(L + W * 0.6, y).lineTo(L + W, y).stroke();
    pdf.font('Helvetica').fontSize(8.5).fillColor(muted).text('Signature', L, y + 4).text('Date', L + W * 0.6, y + 4);
  }
  pdf.end();
}
