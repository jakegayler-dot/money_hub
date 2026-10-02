// Receipts, invoices and sales tickets: read a photo with Claude, then
// attach it to the money it belongs to.
//   receipt       — something already paid: matched to the payment.
//   invoice       — a bill to pay: matched to the payment if it's already
//                   paid, otherwise turned into an unpaid Bill (so it's in
//                   the forecast) and attached to the payment later.
//   sales_ticket  — a grain settlement / cash ticket / auction statement:
//                   matched to the deposit; the deposit is split into the
//                   gross sale and each deduction (levies, freight…), and
//                   settles the open contract it belongs to.
//
// Reading needs ANTHROPIC_API_KEY (Railway → Variables). Without it,
// receipts wait as 'unread' and the date and total can be typed in on the
// Receipts page — matching works the same either way.
import { pool } from '../db.js';
import { toISODate } from './dates.js';
import { payeeId, linkBillToTransaction, linkContractToTransaction, incomeCategoryFor, normalizeSplits, ownerOf, PostingError } from './postings.js';
import { SEGMENT_COLUMNS } from './segments.js';
import { closedMonth } from './periods.js';
import { OWNERS } from './segments.js';

const MODEL = process.env.RECEIPT_MODEL || 'claude-haiku-4-5-20251001';
const r2 = (n) => Math.round(Number(n) * 100) / 100;

export const readerEnabled = () => !!process.env.ANTHROPIC_API_KEY;

const PROMPT = (categories, payees) => `You are reading a photo of a document for a Saskatchewan farm (grain and cattle) and its household. It is one of:
- "receipt": a purchase that's already paid (till slip, card receipt, paid-in-full invoice)
- "invoice": a bill the farm still has to pay (shows a due date or terms, amount owing)
- "sales_ticket": money the farm RECEIVED for something it sold — grain settlement or cash ticket (Cargill, Viterra, Richardson, Bunge, Parrish & Heimbecker, a crusher), livestock auction or order-buyer statement

Return ONLY a JSON object, no other text:
{
  "is_receipt": true,
  "doc_type": "receipt",            // receipt / invoice / sales_ticket
  "date": "YYYY-MM-DD",            // the document date (purchase date, invoice date, settlement date)
  "due_date": null,                 // invoice only: payment due date, or null
  "invoice_number": null,           // invoice only
  "total": 123.45,                  // receipt/invoice: amount paid or owed, positive (negative only for a refund slip). sales_ticket: the NET amount paid to the farm
  "gst": 5.50,                      // GST (or the GST part of HST) printed on it; null if none is printed. Never calculate it.
  "pst": 0,                         // Saskatchewan PST printed on it, or null
  "party": "Federated Co-op",       // the business — reuse a name from KNOWN BUSINESSES when it's the same one
  "card_last4": "1234",             // last 4 digits of the card used, if printed; else null
  "items": [{"description": "...", "amount": 0.00}],   // main lines, at most 15
  "category": "Diesel — dyed",      // the single best category from CATEGORIES, exact spelling, or null
  "farm_share_pct": 100,            // your judgement: % of the total that's farm (grain/cattle) vs household
  "owner": "grain",                 // grain, livestock, jake or ashley — who it's mainly for; null if unclear
  "commodity": null,                // sales_ticket: Canola, Wheat, Oats, Barley, Calves, Cull cows…
  "quantity": null, "unit": null,   // sales_ticket: e.g. 1851.87, "bu" / "t" / "head"
  "gross": null,                    // sales_ticket: gross value before deductions
  "deductions": [],                 // sales_ticket: every deduction as {"description": "...", "amount": 12.34, "category": "Levies & checkoff"} with POSITIVE amounts; categories from CATEGORIES (Levies & checkoff, Trucking & freight, Grading, drying & dockage, Commission & yardage…)
  "confidence": "high",             // high / medium / low
  "notes": ""                       // anything a person should know (smudged total, two receipts in one photo…)
}
If the photo isn't any of these, return {"is_receipt": false, "notes": "what it is"}.
For a sales_ticket, "category" is the INCOME category (e.g. "Canola sales", "Calf sales") and gross minus deductions must equal total; "party" is the buyer. GST collected on a sale goes in "gst".
Use the most specific category (a subcategory when one fits). Farm inputs like fuel, parts, vet supplies, seed, fertilizer and chemical are farm; groceries, clothing and household goods are household (owner jake).

CATEGORIES:
${categories.join('\n')}

KNOWN BUSINESSES:
${payees.join(', ') || '(none yet)'}`;

/** Sends the image to Claude and returns the parsed fields. */
async function extract(receipt) {
  const [{ rows: cats }, { rows: payees }] = await Promise.all([
    pool.query(`SELECT CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' › ' || c.name END AS full, c.kind
                FROM expense_categories c LEFT JOIN expense_categories p ON p.id = c.parent_id ORDER BY 1`),
    pool.query('SELECT name FROM payees ORDER BY name LIMIT 300'),
  ]);
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: receipt.mime, data: Buffer.from(receipt.image).toString('base64') } },
          { type: 'text', text: PROMPT(cats.map((c) => `${c.full} (${c.kind})`), payees.map((p) => p.name)) },
        ],
      }],
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message || `Claude API ${res.status}`);
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const out = JSON.parse(json);
  // The category must be one that exists — match on the subcategory name.
  if (out.category) {
    const name = String(out.category).split('›').pop().trim().toLowerCase();
    const { rows } = await pool.query('SELECT id, name FROM expense_categories WHERE lower(name) = $1', [name]);
    out.category_id = rows[0]?.id || null;
    if (!rows[0]) out.category = null;
  }
  if (out.owner && !OWNERS.includes(out.owner)) out.owner = null;
  if (!['receipt', 'invoice', 'sales_ticket'].includes(out.doc_type)) out.doc_type = 'receipt';
  return out;
}

/** Reads one receipt (if a reader is configured), then tries to match it. */
export async function processReceipt(id) {
  const { rows: [rc] } = await pool.query('SELECT * FROM receipts WHERE id = $1', [id]);
  if (!rc) return;
  if (!readerEnabled()) {
    await pool.query(`UPDATE receipts SET status = 'unread', error = NULL WHERE id = $1`, [id]);
    return;
  }
  try {
    const ex = await extract(rc);
    if (!ex.is_receipt) {
      await pool.query(`UPDATE receipts SET status = 'not_receipt', extracted = $2, error = NULL WHERE id = $1`, [id, ex]);
      return;
    }
    await pool.query(`UPDATE receipts SET status = 'unmatched', extracted = $2, error = NULL WHERE id = $1`, [id, ex]);
    await matchReceipt(id);
  } catch (e) {
    await pool.query(`UPDATE receipts SET status = 'failed', error = $2 WHERE id = $1`, [id, String(e.message).slice(0, 500)]);
  }
}

const docType = (ex) => (ex && ['invoice', 'sales_ticket'].includes(ex.doc_type) ? ex.doc_type : 'receipt');

/** Transactions with this exact amount in a date window, not yet carrying a document. */
async function candidates(client, ex, amount, fromDays, toDays) {
  const { rows } = await client.query(
    `SELECT t.id, t.date, t.amount, t.description, t.account_id, t.credit_card_id, t.payee_id,
            cc.last4 AS card_last4, a.last4 AS account_last4, p.name AS payee
     FROM transactions t
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN payees p ON p.id = t.payee_id
     WHERE abs(t.amount - $1) < 0.005 AND t.date BETWEEN $2::date - $3::int AND $2::date + $4::int
       AND NOT t.is_transfer
       AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)
     ORDER BY abs(t.date - $2::date)`,
    [amount, ex.date, fromDays, toDays]
  );
  let list = rows;
  if (list.length > 1 && ex.card_last4) {
    const byCard = list.filter((t) => t.card_last4 === String(ex.card_last4) || t.account_last4 === String(ex.card_last4));
    if (byCard.length) list = byCard;
  }
  if (list.length > 1 && ex.party) {
    const words = String(ex.party).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const byName = list.filter((t) => words.some((w) => `${t.description || ''} ${t.payee || ''}`.toLowerCase().includes(w)));
    if (byName.length) list = byName;
  }
  return list;
}

const toReview = (client, id, list) => client.query(`UPDATE receipts SET status = 'review', candidates = $2 WHERE id = $1`, [
  id, JSON.stringify(list.slice(0, 6).map((t) => ({ id: t.id, date: toISODate(t.date), amount: Number(t.amount), description: t.description }))),
]);

/**
 * Matches a read document to its money.
 *  receipt:      the payment of the same total, 3 days before to 10 after.
 *  invoice:      a payment of the total from the invoice date to 30 days past
 *                due; if there's none, the invoice becomes an unpaid Bill.
 *  sales_ticket: the deposit of the net, 3 days before to 45 after
 *                (settlement cheques and EFTs lag the ticket).
 * One match → attached; several → Review; none → waits.
 */
export async function matchReceipt(id, client = pool) {
  const { rows: [rc] } = await client.query('SELECT id, status, extracted, bill_id FROM receipts WHERE id = $1', [id]);
  const ex = rc?.extracted;
  if (!rc || !ex || ex.total == null || !ex.date || !['unmatched', 'unread', 'billed'].includes(rc.status)) return null;
  const type = docType(ex);

  if (type === 'sales_ticket') {
    const list = await candidates(client, ex, r2(ex.total), 3, 45);
    if (list.length === 1) { await attachReceipt(id, list[0].id, client); return list[0].id; }
    if (list.length > 1) await toReview(client, id, list);
    return null;
  }

  if (type === 'invoice') {
    // Already a bill: done once the bill is paid — attach to its payment.
    if (rc.bill_id) {
      const { rows: [bill] } = await client.query('SELECT * FROM bills WHERE id = $1', [rc.bill_id]);
      if (bill?.status === 'paid' && bill.linked_transaction_id) {
        await attachReceipt(id, bill.linked_transaction_id, client);
        return bill.linked_transaction_id;
      }
      if (!bill) await client.query(`UPDATE receipts SET bill_id = NULL, status = 'unmatched' WHERE id = $1`, [id]);
    }
    const due = ex.due_date || ex.date;
    const window = Math.max(10, Math.round((new Date(due) - new Date(ex.date)) / 86400000) + 30);
    const list = await candidates(client, ex, -r2(ex.total), 3, window);
    // A payment not already tied to some other bill or loan.
    const free = [];
    for (const t of list) {
      const { rows } = await client.query(
        `SELECT 1 FROM bills WHERE linked_transaction_id = $1 AND id <> COALESCE($2, -1)
         UNION ALL SELECT 1 FROM loan_payments WHERE linked_transaction_id = $1`, [t.id, rc.bill_id]);
      if (!rows.length) free.push(t);
    }
    if (free.length === 1) {
      if (rc.bill_id) {
        try { await linkBillToTransaction(client, rc.bill_id, free[0].id); } catch (e) { if (!(e instanceof PostingError)) throw e; }
      }
      await attachReceipt(id, free[0].id, client);
      return free[0].id;
    }
    if (free.length > 1) { await toReview(client, id, free); return null; }
    if (!rc.bill_id) await billFromInvoice(id, ex, client);
    return null;
  }

  const list = await candidates(client, ex, -r2(ex.total), 3, 10); // a purchase is money out
  if (list.length === 1) { await attachReceipt(id, list[0].id, client); return list[0].id; }
  if (list.length > 1) await toReview(client, id, list);
  return null;
}

/**
 * An unpaid invoice becomes a Bill, so it's in the cash-flow forecast from
 * the day it's photographed. An unpaid bill already on file for the same
 * amount from the same business is used instead of making a second one.
 */
async function billFromInvoice(id, ex, client) {
  const total = r2(ex.total);
  if (total <= 0) return;
  const words = String(ex.party || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const { rows: existing } = await client.query(`SELECT id, name FROM bills WHERE status = 'unpaid' AND abs(amount - $1) < 0.005`, [total]);
  const same = existing.filter((b) => !words.length || words.some((w) => b.name.toLowerCase().includes(w)));
  let billId = same.length === 1 ? same[0].id : null;
  if (!billId) {
    const gst = ex.gst != null ? Math.abs(r2(ex.gst)) : 0;
    const due = ex.due_date || toISODate(new Date(new Date(ex.date).getTime() + 30 * 86400000));
    const owner = ownerOf({ segment: ex.owner || 'grain' });
    const name = `${ex.party || 'Invoice'}${ex.invoice_number ? ` #${ex.invoice_number}` : ''}`;
    const category = ex.category ? String(ex.category).split('›').pop().trim() : null;
    const { rows: [b] } = await client.query(
      `INSERT INTO bills (name, ledger, category, amount, frequency, received_date, due_date, notes,
                          has_gst, gst_pct, gst_amount, subtotal_amount, ${SEGMENT_COLUMNS.join(', ')})
       VALUES ($1, $2, $3, $4, 'one_time', $5, $6, $7, $8, $9, $10, $11, ${SEGMENT_COLUMNS.map((_, i) => `$${12 + i}`).join(', ')})
       RETURNING id`,
      [name, ['jake', 'ashley'].includes(ex.owner) ? 'personal' : 'business', category, total, ex.date, due,
       'Created from a photographed invoice (Receipts).',
       gst > 0, gst > 0 && total - gst > 0 ? r2((gst / (total - gst)) * 100) : 5, gst, r2(total - gst),
       ...SEGMENT_COLUMNS.map((c) => owner[c])]
    );
    billId = b.id;
  }
  await client.query(`UPDATE receipts SET status = 'billed', bill_id = $2 WHERE id = $1`, [id, billId]);
}

/**
 * Attaches a document and fills in what the transaction is missing: exact
 * GST, the business, the category. Nothing already on the transaction is
 * overwritten, and nothing changes in a closed month (the document still
 * attaches). A receipt that looks part farm, part household flags the
 * transaction instead of guessing a split. A sales ticket also settles its
 * contract and splits the deposit into gross sale and deductions.
 */
export async function attachReceipt(receiptId, txId, client = pool) {
  const { rows: [rc] } = await client.query('SELECT * FROM receipts WHERE id = $1', [receiptId]);
  const { rows: [tx] } = await client.query('SELECT * FROM transactions WHERE id = $1', [txId]);
  if (!rc || !tx) throw Object.assign(new Error('Receipt or transaction not found.'), { status: 404 });
  const { rows: other } = await client.query('SELECT id FROM receipts WHERE transaction_id = $1 AND id <> $2', [txId, receiptId]);
  if (other.length) throw Object.assign(new Error('That transaction already has a receipt.'), { status: 409 });
  await client.query(
    `UPDATE receipts SET status = 'matched', transaction_id = $2, candidates = NULL, matched_at = now() WHERE id = $1`,
    [receiptId, txId]
  );
  const ex = rc.extracted || {};
  if (await closedMonth(client, tx.date)) return;
  if (docType(ex) === 'sales_ticket') { await applySalesTicket(ex, tx, client); return; }
  const sets = [];
  const vals = [];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (tx.gst_amount == null && ex.gst != null && Math.abs(Number(ex.gst)) <= Math.abs(Number(tx.amount))) set('gst_amount', Math.abs(r2(ex.gst)));
  if (!tx.payee_id && ex.party) set('payee_id', await payeeId(client, ex.party));
  if (!tx.category_id && !tx.is_split && ex.category_id) set('category_id', ex.category_id);
  const pct = Number(ex.farm_share_pct);
  if (!tx.is_split && !tx.is_segment_split && Number.isFinite(pct) && pct > 5 && pct < 95) {
    set('needs_review', true);
    set('review_note', `Receipt looks about ${Math.round(pct)}% farm / ${100 - Math.round(pct)}% household — split it if so.`);
  }
  if (sets.length) {
    vals.push(txId);
    await client.query(`UPDATE transactions SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }
}

async function categoryByName(client, name, kind) {
  if (!name) return null;
  const leaf = String(name).split('›').pop().trim().toLowerCase();
  const { rows } = await client.query('SELECT id FROM expense_categories WHERE lower(name) = $1 AND kind = $2', [leaf, kind]);
  return rows[0]?.id || null;
}

/**
 * A sales ticket on its deposit: settle the open contract it belongs to,
 * record the buyer, and split the deposit into the gross sale (income) and
 * each deduction (expense) — CRA wants farm sales gross. Skipped, with a
 * review flag, when the ticket's numbers don't add up to the deposit.
 */
async function applySalesTicket(ex, tx, client) {
  // Contract: same commodity, value between the net and a little over gross.
  const { rows: linked } = await client.query('SELECT 1 FROM sale_contracts WHERE linked_transaction_id = $1', [tx.id]);
  if (!linked.length && ex.commodity) {
    const gross = Number(ex.gross) || Number(ex.total);
    const { rows: cs } = await client.query(
      `SELECT * FROM sale_contracts
       WHERE status IN ('open', 'delivered') AND (commodity ILIKE '%' || $1 || '%' OR $1 ILIKE '%' || commodity || '%')
         AND total_value BETWEEN $2 * 0.8 AND $3 * 1.05`,
      [String(ex.commodity).trim(), Number(ex.total), gross]
    );
    let pick = cs;
    if (pick.length > 1 && ex.party) {
      const w = String(ex.party).toLowerCase().split(/\W+/).filter((x) => x.length > 2);
      const byBuyer = pick.filter((c) => w.some((x) => String(c.counterparty || '').toLowerCase().includes(x)));
      if (byBuyer.length) pick = byBuyer;
    }
    if (pick.length > 1) pick = pick.filter((c) => Math.abs(Number(c.total_value) - gross) < 0.01);
    if (pick.length === 1) {
      try { await linkContractToTransaction(client, pick[0].id, tx.id); } catch (e) { if (!(e instanceof PostingError)) throw e; }
    }
  }
  const { rows: [fresh] } = await client.query('SELECT * FROM transactions WHERE id = $1', [tx.id]);
  const sets = [];
  const vals = [];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (!fresh.payee_id && ex.party) set('payee_id', await payeeId(client, ex.party));
  if (fresh.gst_amount == null && ex.gst != null) set('gst_amount', Math.abs(r2(ex.gst)));

  const deductions = (Array.isArray(ex.deductions) ? ex.deductions : []).filter((d) => Number(d.amount));
  const incomeCat = fresh.category_id || ex.category_id || await categoryByName(client, ex.category, 'income')
    || await incomeCategoryFor(client, ex.commodity);
  if (!fresh.is_split && deductions.length && ex.gross != null) {
    const pieces = [{ amount: r2(ex.gross), category_id: incomeCat, memo: `Gross sale${ex.quantity ? ` — ${ex.quantity} ${ex.unit || ''}`.trimEnd() : ''}` }];
    const fallback = await categoryByName(client, 'Levies & checkoff', 'expense');
    for (const d of deductions) {
      pieces.push({ amount: -Math.abs(r2(d.amount)), category_id: (await categoryByName(client, d.category, 'expense')) || fallback, memo: d.description || 'Deduction' });
    }
    const off = r2(pieces.reduce((a, p) => a + p.amount, 0) - Number(fresh.amount));
    if (Math.abs(off) <= 0.05) pieces[0].amount = r2(pieces[0].amount - off); // rounding on the ticket
    const { splits, error } = normalizeSplits(pieces, Number(fresh.amount), ownerOf(fresh), fresh.ledger);
    if (!error) {
      await client.query('DELETE FROM transaction_splits WHERE transaction_id = $1', [fresh.id]);
      for (const sp of splits) {
        await client.query(
          `INSERT INTO transaction_splits (transaction_id, amount, category_id, memo, ledger, is_capex, ${SEGMENT_COLUMNS.join(', ')})
           VALUES ($1,$2,$3,$4,$5,$6,${SEGMENT_COLUMNS.map((_, i) => `$${7 + i}`).join(',')})`,
          [fresh.id, sp.amount, sp.category_id, sp.memo, sp.ledger, sp.is_capex, ...SEGMENT_COLUMNS.map((c) => sp.owner[c])]
        );
      }
      set('is_split', true);
      set('category_id', null);
      if (fresh.review_note && fresh.review_note.startsWith('Income with no category')) { set('needs_review', false); set('review_note', null); }
    } else {
      set('needs_review', true);
      set('review_note', `Sales ticket: gross ${ex.gross} less deductions doesn't match this deposit (${error}) — check the ticket.`);
    }
  } else if (!fresh.is_split && !fresh.category_id && incomeCat) {
    set('category_id', incomeCat);
    if (fresh.review_note && fresh.review_note.startsWith('Income with no category')) { set('needs_review', false); set('review_note', null); }
  }
  if (sets.length) {
    vals.push(fresh.id);
    await client.query(`UPDATE transactions SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  }
}

/** Tries every receipt still waiting for its transaction — run after statements and entries arrive. */
export async function matchPending() {
  const { rows } = await pool.query(`SELECT id FROM receipts WHERE status IN ('unmatched', 'unread', 'billed') AND extracted IS NOT NULL`);
  for (const r of rows) {
    try { await matchReceipt(r.id); } catch (e) { console.error('Receipt match failed', r.id, e.message); }
  }
}

/** Reads any receipts that arrived before the API key was set, or failed. */
export async function readPending() {
  if (!readerEnabled()) return;
  const { rows } = await pool.query(`SELECT id FROM receipts WHERE status IN ('reading', 'unread') AND extracted IS NULL ORDER BY id LIMIT 20`);
  for (const r of rows) await processReceipt(r.id);
}

