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
import { payeeId, refreshContract, linkBillToTransaction, linkContractToTransaction, incomeCategoryFor, normalizeSplits, ownerOf, PostingError } from './postings.js';
import { SEGMENT_COLUMNS } from './segments.js';
import { closedMonth } from './periods.js';
import { OWNERS } from './segments.js';

const MODEL = process.env.RECEIPT_MODEL || 'claude-haiku-4-5-20251001';
const r2 = (n) => Math.round(Number(n) * 100) / 100;

export const readerEnabled = () => !!process.env.ANTHROPIC_API_KEY;

// The reply format uses placeholders, never sample values: a model unsure
// of a field copies an example ("Diesel — dyed") instead of reading the
// photo. Categories come from the printed line items first, then from what
// this business has been filed under before.
const PROMPT = (categories, payees, history) => `You are reading a photo or PDF of a document for a Saskatchewan farm (grain and cattle) and its household. It is one of:
- "receipt": a purchase that's already paid (till slip, card receipt, paid-in-full invoice)
- "invoice": a bill the farm still has to pay (shows a due date or terms, amount owing)
- "sales_ticket": money the farm RECEIVED for something it sold — grain settlement or cash ticket (Cargill, Viterra, Richardson, Bunge, Parrish & Heimbecker, a crusher), livestock auction or order-buyer statement

Return ONLY a JSON object, no other text, with these fields (angle brackets describe the value — never copy them):
{
  "is_receipt": true,
  "doc_type": <"receipt" | "invoice" | "sales_ticket">,
  "date": <document date as "YYYY-MM-DD">,
  "due_date": <invoice only: due date "YYYY-MM-DD", else null>,
  "invoice_number": <invoice only, else null>,
  "interest_free_until": <invoice on a financing program ("interest free until", "0% until", "deferred to"): that date "YYYY-MM-DD", else null>,
  "finance_rate_pct": <invoice on a financing program: the annual interest rate charged after that date, as printed, else null>,
  "total": <receipt/invoice: amount paid or owed, positive (negative only for a refund). sales_ticket: the NET paid to the farm>,
  "gst": <GST (or the GST part of HST) exactly as printed, else null. Never calculate it>,
  "pst": <Saskatchewan PST as printed, else null>,
  "party": <the business as printed — reuse the spelling from KNOWN BUSINESSES when it's the same one>,
  "card_last4": <last 4 digits of the card or account used, if printed, else null>,
  "items": [<main lines as {"description": <text as printed>, "amount": <number>}, at most 15>],
  "category": <exact name from CATEGORIES, chosen by the rules below, or null>,
  "category_reason": <a few words: the printed words the category is based on>,
  "farm_share_pct": <0–100: share that's farm (grain/cattle) rather than household, or null if you can't tell>,
  "owner": <"grain" | "livestock" | "jake" | "ashley" | null>,
  "commodity": <sales_ticket: the crop or livestock sold, else null>,
  "quantity": <sales_ticket quantity, else null>, "unit": <"bu" | "t" | "head" | other, else null>,
  "gross": <sales_ticket gross value before deductions, else null>,
  "deductions": [<sales_ticket only: {"description", "amount" (positive), "category" (exact name from CATEGORIES)}>],
  "confidence": <"high" | "medium" | "low">,
  "notes": <anything a person should know (smudged total, two receipts in one photo…), else "">
}
If it isn't any of these, return {"is_receipt": false, "notes": <what it is>}.
For a sales_ticket, "category" is the INCOME category for the commodity sold, gross minus deductions must equal total, "party" is the buyer, and GST collected on the sale goes in "gst".

CHOOSING THE CATEGORY
1. Read what was bought from the printed line items and product names. That decides the category — not the store, and not what a farm usually buys.
2. Fuel: "Regular", "Unleaded", "Premium", "Mid-grade", "Gas", "Plus" are GASOLINE. "Diesel" or "Clear diesel" with no dye wording is CLEAR (road) diesel. Only "Dyed", "Marked", "Coloured", "Farm diesel" or a bulk farm-fuel delivery is DYED diesel. Never call gasoline or pump diesel dyed.
3. Use PAST CHOICES below: when this business has usually been filed under one category and the items fit it, use that category and owner.
4. If no category clearly fits the items, return null. A wrong category is worse than none.
5. Use the most specific category (a subcategory when one fits).

OWNER
Dyed diesel, seed, fertilizer, chemical, parts, vet supplies and feed are farm. Groceries, clothing and household goods are household (jake). Gasoline at a pump could be a farm truck or a family vehicle: follow PAST CHOICES for this business; with no history, set owner null and farm_share_pct null.

CATEGORIES:
${categories.join('\n')}

KNOWN BUSINESSES:
${payees.join(', ') || '(none yet)'}

PAST CHOICES (business → categories it has been filed under, most used first, with owner):
${history.join('\n') || '(none yet)'}`;

/** Sends the image to Claude and returns the parsed fields. */
async function extract(receipt) {
  const [{ rows: cats }, { rows: payees }, { rows: past }] = await Promise.all([
    pool.query(`SELECT CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' › ' || c.name END AS full, c.kind
                FROM expense_categories c LEFT JOIN expense_categories p ON p.id = c.parent_id ORDER BY 1`),
    pool.query('SELECT name FROM payees ORDER BY name LIMIT 300'),
    // How each business's spending has actually been filed (split pieces
    // included), so the reader follows the user's own choices.
    pool.query(`
      SELECT py.name AS payee, CASE WHEN pc.id IS NULL THEN c.name ELSE pc.name || ' › ' || c.name END AS cat,
             CASE WHEN l.is_segment_split THEN 'split' ELSE COALESCE(l.segment::text, 'unassigned') END AS owner, COUNT(*) AS n
      FROM transaction_lines l
      JOIN transactions t ON t.id = l.transaction_id
      JOIN payees py ON py.id = t.payee_id
      JOIN expense_categories c ON c.id = l.category_id
      LEFT JOIN expense_categories pc ON pc.id = c.parent_id
      WHERE l.amount < 0 AND t.date > CURRENT_DATE - 730
      GROUP BY 1, 2, 3 ORDER BY 1, n DESC`),
  ]);
  const byPayee = new Map();
  for (const r of past) {
    const list = byPayee.get(r.payee) || [];
    if (list.length < 3) list.push(`${r.cat} [${r.owner}] ×${r.n}`);
    byPayee.set(r.payee, list);
  }
  const history = [...byPayee].slice(0, 200).map(([name, list]) => `${name} → ${list.join('; ')}`);
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
          // A PDF (emailed invoice, e-statement settlement) goes as a document; Claude reads every page.
          receipt.mime === 'application/pdf'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(receipt.image).toString('base64') } }
            : { type: 'image', source: { type: 'base64', media_type: receipt.mime, data: Buffer.from(receipt.image).toString('base64') } },
          { type: 'text', text: PROMPT(cats.map((c) => `${c.full} (${c.kind})`), payees.map((p) => p.name), history) },
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

/**
 * A document attached by hand to one ledger entry: it belongs there, so
 * it's attached straight away; when a reader is set up it's read first so
 * the entry gets the exact GST, the business, and — for a settlement
 * ticket on a deposit — the gross sale and deductions.
 */
export async function readAndAttach(id, txId) {
  const { rows: [rc] } = await pool.query('SELECT * FROM receipts WHERE id = $1', [id]);
  if (!rc) return;
  if (readerEnabled()) {
    try {
      const ex = await extract(rc);
      if (ex.is_receipt) await pool.query('UPDATE receipts SET extracted = $2, error = NULL WHERE id = $1', [id, ex]);
    } catch (e) {
      await pool.query('UPDATE receipts SET error = $2 WHERE id = $1', [id, `Attached, but couldn't be read: ${String(e.message).slice(0, 300)}`]);
    }
  }
  await attachReceipt(id, txId, pool, { extra: true });
}

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
      `INSERT INTO bills (name, ledger, category, category_id, amount, frequency, received_date, due_date, notes,
                          has_gst, gst_pct, gst_amount, subtotal_amount, ${SEGMENT_COLUMNS.join(', ')})
       VALUES ($1, $2, $3, $12, $4, 'one_time', $5, $6, $7, $8, $9, $10, $11, ${SEGMENT_COLUMNS.map((_, i) => `$${13 + i}`).join(', ')})
       RETURNING id`,
      [name, ['jake', 'ashley'].includes(ex.owner) ? 'personal' : 'business', category, total, ex.date, due,
       'Created from a photographed invoice (Receipts).',
       gst > 0, gst > 0 && total - gst > 0 ? r2((gst / (total - gst)) * 100) : 5, gst, r2(total - gst),
       ex.category_id || null, ...SEGMENT_COLUMNS.map((c) => owner[c])]
    );
    billId = b.id;
    if (ex.party) await client.query('UPDATE bills SET payee_id = $2 WHERE id = $1', [billId, await payeeId(client, ex.party)]);
    // Input financing printed on the invoice: interest-free date and rate.
    const rate = Number(ex.finance_rate_pct);
    if (ex.interest_free_until || (Number.isFinite(rate) && rate > 0)) {
      await client.query(
        `UPDATE bills SET is_financed = true, finance_rate_pct = $2, interest_free_until = $3 WHERE id = $1`,
        [billId, Number.isFinite(rate) ? rate : 0, ex.interest_free_until || null]);
    }
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
export async function attachReceipt(receiptId, txId, client = pool, { extra = false } = {}) {
  const { rows: [rc] } = await client.query('SELECT * FROM receipts WHERE id = $1', [receiptId]);
  const { rows: [tx] } = await client.query('SELECT * FROM transactions WHERE id = $1', [txId]);
  if (!rc || !tx) throw Object.assign(new Error('Receipt or transaction not found.'), { status: 404 });
  // Matching gives a transaction one document; attaching by hand from the
  // ledger can add more (an invoice and its receipt, a ticket and a stub).
  const { rows: other } = await client.query('SELECT id FROM receipts WHERE transaction_id = $1 AND id <> $2', [txId, receiptId]);
  if (other.length && !extra) throw Object.assign(new Error('That transaction already has a receipt.'), { status: 409 });
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
  // Contract: same commodity, still expecting at least this ticket's gross.
  // Linked after the split above, so the contract counts the gross sale.
  const { rows: linked } = await client.query('SELECT contract_id FROM contract_payments WHERE transaction_id = $1', [tx.id]);
  if (linked.length) await refreshContract(client, linked[0].contract_id); // already counted: now at its gross
  if (!linked.length && ex.commodity) {
    const gross = Number(ex.gross) || Number(ex.total);
    const { rows: cs } = await client.query(
      `SELECT *, GREATEST(total_value - received_amount, 0) AS remaining FROM sale_contracts
       WHERE status IN ('open', 'delivered') AND (commodity ILIKE '%' || $1 || '%' OR $1 ILIKE '%' || commodity || '%')
         AND GREATEST(total_value - received_amount, 0) * 1.03 + 1 >= $2`,
      [String(ex.commodity).trim(), gross]
    );
    let pick = cs;
    if (pick.length > 1 && ex.party) {
      const w = String(ex.party).toLowerCase().split(/\W+/).filter((x) => x.length > 2);
      const byBuyer = pick.filter((c) => w.some((x) => String(c.counterparty || '').toLowerCase().includes(x)));
      if (byBuyer.length) pick = byBuyer;
    }
    if (pick.length > 1) pick = pick.filter((c) => Math.abs(Number(c.remaining) - gross) < 0.01);
    if (pick.length === 1) {
      try { await linkContractToTransaction(client, pick[0].id, tx.id); } catch (e) { if (!(e instanceof PostingError)) throw e; }
    }
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

