// Receipts: read a photo with Claude, then attach it to the transaction it
// paid for.
//
// Reading needs ANTHROPIC_API_KEY (Railway → Variables). Without it,
// receipts wait as 'unread' and the date and total can be typed in on the
// Receipts page — matching works the same either way.
import { pool } from '../db.js';
import { toISODate } from './dates.js';
import { payeeId } from './postings.js';
import { closedMonth } from './periods.js';
import { OWNERS } from './segments.js';

const MODEL = process.env.RECEIPT_MODEL || 'claude-haiku-4-5-20251001';
const r2 = (n) => Math.round(Number(n) * 100) / 100;

export const readerEnabled = () => !!process.env.ANTHROPIC_API_KEY;

const PROMPT = (categories, payees) => `You are reading a photo of a purchase receipt or invoice for a Saskatchewan farm (grain and cattle) and its household.

Return ONLY a JSON object, no other text:
{
  "is_receipt": true,
  "date": "YYYY-MM-DD",            // purchase date printed on it
  "total": 123.45,                  // the amount actually paid, as a positive number (negative only for a refund slip)
  "gst": 5.50,                      // GST (or the GST part of HST) printed on it; null if none is printed. Never calculate it.
  "pst": 0,                         // Saskatchewan PST printed on it, or null
  "party": "Federated Co-op",       // the business — reuse a name from KNOWN BUSINESSES when it's the same one
  "card_last4": "1234",             // last 4 digits of the card used, if printed; else null
  "items": [{"description": "...", "amount": 0.00}],   // main lines, at most 15
  "category": "Diesel — dyed",      // the single best category from CATEGORIES, exact spelling, or null
  "farm_share_pct": 100,            // your judgement: % of the total that's farm (grain/cattle) vs household
  "owner": "grain",                 // grain, livestock, jake or ashley — who it's mainly for; null if unclear
  "confidence": "high",             // high / medium / low
  "notes": ""                       // anything a person should know (smudged total, two receipts in one photo…)
}
If the photo isn't a receipt or invoice, return {"is_receipt": false, "notes": "what it is"}.
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

/**
 * Finds the transaction a read receipt paid for: the same total (to the
 * cent) within 3 days before to 10 days after the receipt date — card and
 * bank postings lag the purchase — that has no receipt yet. Narrowed by
 * card last 4 and business name when there are several. One → attached;
 * several → Review; none → waits for the statement.
 */
export async function matchReceipt(id, client = pool) {
  const { rows: [rc] } = await client.query('SELECT id, status, extracted FROM receipts WHERE id = $1', [id]);
  const ex = rc?.extracted;
  if (!rc || !ex || ex.total == null || !ex.date || !['unmatched', 'unread'].includes(rc.status)) return null;
  const amount = -r2(ex.total); // a purchase is money out
  const { rows } = await client.query(
    `SELECT t.id, t.date, t.amount, t.description, t.account_id, t.credit_card_id, t.payee_id,
            cc.last4 AS card_last4, a.last4 AS account_last4, p.name AS payee
     FROM transactions t
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN payees p ON p.id = t.payee_id
     WHERE abs(t.amount - $1) < 0.005 AND t.date BETWEEN $2::date - 3 AND $2::date + 10
       AND NOT t.is_transfer
       AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.transaction_id = t.id)
     ORDER BY abs(t.date - $2::date)`,
    [amount, ex.date]
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
  if (list.length === 1) {
    await attachReceipt(id, list[0].id, client);
    return list[0].id;
  }
  if (list.length > 1) {
    await client.query(`UPDATE receipts SET status = 'review', candidates = $2 WHERE id = $1`, [
      id, JSON.stringify(list.slice(0, 6).map((t) => ({ id: t.id, date: toISODate(t.date), amount: Number(t.amount), description: t.description }))),
    ]);
  }
  return null;
}

/**
 * Attaches a receipt and fills in what the transaction is missing: exact
 * GST, the business, the category. Nothing already on the transaction is
 * overwritten, and nothing changes in a closed month (the receipt still
 * attaches). A receipt that looks part farm, part household flags the
 * transaction for review instead of guessing a split.
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

/** Tries every receipt still waiting for its transaction — run after statements and entries arrive. */
export async function matchPending() {
  const { rows } = await pool.query(`SELECT id FROM receipts WHERE status IN ('unmatched', 'unread') AND extracted IS NOT NULL`);
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

