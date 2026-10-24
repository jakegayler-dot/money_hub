// Groceries: every grocery receipt catalogued line by line, so the family's
// food spending can be seen by food type against a typical month, each item's
// price compared across stores, and cost cutting suggested from the numbers
// (Jake, 2026-10-22: "read, analyze and catalogue grocery purchases").
//
// Once a receipt has been read (lib/receipts.js) and looks like groceries, the
// photo is read again for EVERY line (the first reading keeps 15): the item as
// a plain shopping-list name ("2% milk"), brand, store brand or not, food type,
// count and size, what was paid and any discount. A unit price per kg, per
// litre or each makes stores comparable. A fresh receipt is sent on to
// Sentinel, which ticks the items off the shopping list.
import { pool } from '../db.js';
import { toISODate, addMonths } from './dates.js';
import { reginaToday } from './sentinelSnapshot.js';

const MODEL = process.env.GROCERY_MODEL || process.env.RECEIPT_MODEL || 'claude-sonnet-5-5';
const ADVICE_MODEL = process.env.GROCERY_ADVICE_MODEL || 'claude-sonnet-5-5';
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const r4 = (n) => Math.round(Number(n) * 10000) / 10000;

export const FOOD_TYPES = ['produce', 'meat & seafood', 'dairy & eggs', 'bakery', 'pantry', 'frozen', 'snacks & sweets', 'drinks',
  'deli & prepared', 'baby', 'household', 'personal care', 'other'];
export const NON_FOOD = new Set(['household', 'personal care', 'other']);

// Store names as they're spoken: "SOBEYS #4471 MELFORT" → Sobeys. Grocery-only
// chains are groceries whatever was filed; the Co-op, Walmart and Costco also
// sell fuel, parts and clothes, so their receipts are checked line by line.
const CHAINS = [
  [/real canadian|superstore|rcss/i, 'Superstore', true], [/no ?frills/i, 'No Frills', true], [/safeway/i, 'Safeway', true],
  [/sobeys/i, 'Sobeys', true], [/save[- ]?on/i, 'Save-On-Foods', true], [/freshco/i, 'FreshCo', true], [/extra foods/i, 'Extra Foods', true],
  [/independent grocer|your independent/i, 'Independent Grocer', true], [/co-?op|cooperative/i, 'Co-op', false],
  [/wal-?mart/i, 'Walmart', false], [/costco/i, 'Costco', false], [/giant tiger/i, 'Giant Tiger', false],
  [/shoppers drug/i, 'Shoppers Drug Mart', false], [/london drugs/i, 'London Drugs', false], [/dollarama/i, 'Dollarama', false],
];

export function storeName(party) {
  const p = String(party || '').trim();
  const hit = CHAINS.find(([re]) => re.test(p));
  if (hit) return hit[1];
  return p.replace(/\s*#\s*\d+.*$/, '').replace(/\s+/g, ' ').slice(0, 60) || 'Unknown store';
}

const FARMISH = /fuel|diesel|gasoline|\bgas\b|parts|repair|feed|seed|fertil|chemical|vet|hardware|lumber|machinery|tire|clothing|cloth|restaurant|meal|dining|fast food/i;

/** A read receipt worth cataloguing as groceries. */
export function isGroceryReceipt(ex) {
  if (!ex || !ex.is_receipt || (ex.doc_type && ex.doc_type !== 'receipt') || !(Number(ex.total) > 0)) return false;
  const cat = String(ex.category || '');
  if (/grocer/i.test(cat)) return true;
  const chain = CHAINS.find(([re]) => re.test(String(ex.party || '')));
  if (!chain) return /food store|food centre|grocery|market/i.test(String(ex.party || ''));
  if (chain[2]) return true;
  // A mixed store: groceries unless it was filed as something else farm or not food.
  return !FARMISH.test(cat) && !['grain', 'livestock'].includes(ex.owner);
}

// Weights and volumes go to a price per kg or per litre; anything else is each.
const TO_BASE = { g: [0.001, 'kg'], kg: [1, 'kg'], lb: [0.453592, 'kg'], lbs: [0.453592, 'kg'], oz: [0.0283495, 'kg'], ml: [0.001, 'l'], l: [1, 'l'] };
export function unitPrice(line) {
  const amount = Number(line.amount);
  if (!(amount > 0)) return { unit: null, unit_price: null };
  const qty = Number(line.qty) > 0 ? Number(line.qty) : 1;
  const unit = String(line.size_unit || '').toLowerCase().trim();
  const size = Number(line.size_value);
  const base = TO_BASE[unit];
  if (base && size > 0) return { unit: base[1], unit_price: r4(amount / (qty * size * base[0])) };
  const count = unit === 'each' && size > 0 ? qty * size : qty;
  return { unit: 'each', unit_price: r4(amount / count) };
}

/** A printed line as a key for corrections: lowercase, no prices, codes or weights. */
export const printedKey = (p) => String(p || '').toLowerCase().replace(/[$\d.,@/%#*]+/g, ' ').replace(/\b(kg|lb|lbs|g|ea|each|x)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** Fixes made by hand, by printed line: { key → { item, food_type } }. */
export async function corrections(db = pool) {
  const { rows } = await db.query('SELECT printed, item, food_type FROM grocery_corrections ORDER BY updated_at DESC LIMIT 2000');
  return new Map(rows.map((r) => [r.printed, { item: r.item, food_type: r.food_type }]));
}

const PROMPT = ({ party, date, total, known, fixed = [] }) => `This is a grocery till slip${party ? ` from ${party}` : ''}${date ? ` dated ${date}` : ''}${total ? `, total $${total}` : ''}. It was bought by a farm family in Saskatchewan.

Record EVERY purchased line by calling record_grocery_lines (angle brackets describe the value — never copy them):
{
  "is_grocery": <false only if nothing on it is food, drink, household or personal-care shopping>,
  "lines": [{
    "printed": <the line as printed>,
    "item": <a plain lowercase name a person would write on a shopping list: no brand, no size, no store code — "2% milk", "bananas", "ground beef", "cheddar cheese", "paper towels". Reuse a name from KNOWN ITEMS when it's the same thing>,
    "brand": <the brand if the line shows one, else null>,
    "store_brand": <true for a store's own label: Compliments (Sobeys, Safeway), No Name and President's Choice (Superstore, No Frills, Independent), Great Value (Walmart), Kirkland Signature (Costco), Co-op and Co-op Gold (Co-op), Western Family (Save-On-Foods)>,
    "food_type": <one of: ${FOOD_TYPES.join(', ')}>,
    "qty": <how many packages; 1 for a weighed item>,
    "size_value": <package size or weighed weight as a number, null if not shown>,
    "size_unit": <"g" | "kg" | "lb" | "oz" | "ml" | "l" | "each" | null>,
    "amount": <what was paid for this line after its own discounts, positive>,
    "discount": <the saving shown for this line (sale, coupon, member price), positive, 0 if none>
  }]
}
Rules:
- Skip subtotal, tax, total, payment, change and points lines.
- A coupon or "you saved" line printed under an item belongs to that item: take it off that item's amount and put it in its discount. Never list it as its own line.
- Bottle deposits, environmental fees and bag charges are lines with food_type "other".
- Weighed produce and meat ("1.235 kg @ $3.99/kg"): qty 1, size_value 1.235, size_unit "kg".
- "2 @ 1.99": qty 2, amount 3.98.
- Read till abbreviations into words ("GRN ONION" → "green onions", "BNLS SKNLS CHKN BRST" → "chicken breasts").
- Check the amounts add up to the subtotal before tax. If a line is unreadable, give your best reading of its amount and item "unreadable".

KNOWN ITEMS:
${known.join(', ') || '(none yet)'}

THE FAMILY'S OWN FIXES (printed line → what it is): follow these exactly when the same line appears.
${fixed.join('\n') || '(none yet)'}`;

async function claude(body) {
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(out?.error?.message || `Claude API ${res.status}`);
  if (out.stop_reason === 'max_tokens') throw new Error('The reply was cut off.');
  if (out.stop_reason === 'refusal') throw new Error('The reader declined this request.');
  return out;
}

/** Reads every line of a grocery receipt. */
async function readLines(rc, ex) {
  const { rows } = await pool.query(`SELECT item FROM grocery_items GROUP BY item ORDER BY COUNT(*) DESC LIMIT 400`);
  // Loaded when needed: receipts.js brings in the image library, which the read API doesn't need.
  const { documentBlocks } = await import('./receipts.js');
  const fixes = await corrections();
  const fixed = [...fixes].slice(0, 200).map(([k, v]) => `${k} → ${v.item} [${v.food_type}]`);
  const userTurn = { role: 'user', content: [...(await documentBlocks(rc)),
    { type: 'text', text: PROMPT({ party: ex.party, date: ex.date, total: ex.total, known: rows.map((r) => r.item), fixed }) }] };
  const tools = [{
    name: 'record_grocery_lines', description: 'Record every purchased line of the till slip.',
    input_schema: { type: 'object', properties: { is_grocery: { type: 'boolean' }, lines: { type: 'array', items: { type: 'object' } } }, required: ['is_grocery', 'lines'] },
  }];
  let body = await claude({ model: MODEL, max_tokens: 16000, tools, messages: [userTurn] });
  let tool = (body.content || []).find((c) => c.type === 'tool_use');
  if (!tool) {
    body = await claude({ model: MODEL, max_tokens: 16000, tools, messages: [userTurn,
      { role: 'assistant', content: body.content?.length ? body.content : [{ type: 'text', text: '(no answer)' }] },
      { role: 'user', content: 'Call record_grocery_lines now with every line you can read.' }] });
    tool = (body.content || []).find((c) => c.type === 'tool_use');
  }
  if (!tool?.input) throw new Error("The lines couldn't be read.");
  return tool.input;
}

/** Cleans one line from the reader; null for nothing usable. */
export function cleanLine(l) {
  const amount = r2(l?.amount);
  if (!l || !Number.isFinite(amount) || amount === 0) return null;
  const item = String(l.item || l.printed || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!item) return null;
  const food_type = FOOD_TYPES.includes(String(l.food_type || '').toLowerCase()) ? String(l.food_type).toLowerCase() : 'other';
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const out = {
    printed: l.printed ? String(l.printed).slice(0, 120) : null, item, brand: l.brand ? String(l.brand).slice(0, 60) : null,
    store_brand: l.store_brand === true, food_type, qty: num(l.qty), size_value: num(l.size_value),
    size_unit: l.size_unit ? String(l.size_unit).toLowerCase().slice(0, 10) : null, amount, discount: Math.abs(r2(num(l.discount) || 0)),
  };
  return { ...out, ...unitPrice(out) };
}

/** Replaces a receipt's catalogued lines. */
export async function saveLines(client, receiptId, { date, store }, lines) {
  await client.query('DELETE FROM grocery_items WHERE receipt_id = $1', [receiptId]);
  const fixes = await corrections(client);
  for (const raw of lines) {
    // A line fixed by hand before is that thing again, whatever the reader said.
    const fix = raw.printed ? fixes.get(printedKey(raw.printed)) : null;
    const l = fix ? { ...raw, item: fix.item, food_type: fix.food_type } : raw;
    await client.query(
      `INSERT INTO grocery_items (receipt_id, date, store, printed, item, brand, store_brand, food_type, qty, size_value, size_unit, unit, unit_price, amount, discount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [receiptId, date, store, l.printed, l.item, l.brand, l.store_brand, l.food_type, l.qty, l.size_value, l.size_unit, l.unit, l.unit_price, l.amount, l.discount]);
  }
}

/**
 * Catalogues a read receipt if it's groceries. A receipt from the last few
 * days is sent to Sentinel to tick the shopping list (an old one from a
 * backfill isn't: those items were bought long ago).
 */
export async function catalogueIfGrocery(id, { push = true } = {}) {
  const { rows: [rc] } = await pool.query('SELECT * FROM receipts WHERE id = $1', [id]);
  const ex = rc?.extracted;
  if (!rc || !ex) return null;
  if (!isGroceryReceipt(ex)) {
    await pool.query(`UPDATE receipts SET grocery = 'not_grocery' WHERE id = $1`, [id]);
    await pool.query('DELETE FROM grocery_items WHERE receipt_id = $1', [id]);
    return null;
  }
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const read = await readLines(rc, ex);
    const lines = (Array.isArray(read.lines) ? read.lines : []).map(cleanLine).filter(Boolean);
    if (read.is_grocery === false || !lines.length) {
      await pool.query(`UPDATE receipts SET grocery = 'not_grocery' WHERE id = $1`, [id]);
      return null;
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(ex.date)) ? ex.date : toISODate(rc.uploaded_at);
    const store = storeName(ex.party);
    await saveLines(pool, id, { date, store }, lines);
    await pool.query(`UPDATE receipts SET grocery = 'catalogued' WHERE id = $1`, [id]);
    const age = (new Date(`${reginaToday()}T12:00:00Z`) - new Date(`${date}T12:00:00Z`)) / 86400000;
    if (push && age <= 3) await pushToSentinel({ receipt_id: id, store, date, lines });
    return { store, date, lines };
  } catch (e) {
    console.error('Grocery catalogue failed', id, e.message);
    await pool.query(`UPDATE receipts SET grocery = 'failed' WHERE id = $1`, [id]);
    return null;
  }
}

/** Sends a fresh receipt's lines to Sentinel, which ticks them off the shopping list. Never throws. */
export async function pushToSentinel({ receipt_id, store, date, lines }) {
  const url = process.env.SENTINEL_URL;
  const key = process.env.SENTINEL_API_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/v1/groceries/receipt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt_id, store, date, lines: lines.map((l) => ({ item: l.item, printed: l.printed })) }),
      signal: AbortSignal.timeout(30000),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) { console.error(`Sentinel grocery receipt: HTTP ${res.status}`); return null; }
    if (out?.ticked?.length) console.log(`Sentinel ticked off ${out.ticked.map((t) => t.title).join(', ')}`);
    return out;
  } catch (e) {
    console.error(`Sentinel grocery receipt: ${e.message}`);
    return null;
  }
}

const state = { running: false, done: 0, todo: 0 };
export const backfillState = () => ({ ...state });

/** Catalogues past grocery receipts not looked at yet (runs in the background). */
export async function backfillGroceries({ limit = 200, retryFailed = false } = {}) {
  if (state.running) return backfillState();
  const { rows } = await pool.query(
    `SELECT id FROM receipts WHERE extracted IS NOT NULL AND status NOT IN ('failed', 'not_receipt', 'reading')
       AND (grocery IS NULL ${retryFailed ? "OR grocery = 'failed'" : ''}) ORDER BY id DESC LIMIT $1`, [limit]);
  Object.assign(state, { running: true, done: 0, todo: rows.length });
  (async () => {
    for (const r of rows) {
      try { await catalogueIfGrocery(r.id, { push: false }); } catch (e) { console.error('Grocery backfill', r.id, e.message); }
      state.done += 1;
    }
    state.running = false;
  })();
  return backfillState();
}

// ---------- analysis ----------

export function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return r2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

/**
 * Spending by food type per month, and a typical month: the median of the
 * last six full months that have catalogued receipts (a month with none is
 * missing data, not a month of eating nothing). The ledger's Groceries total
 * shows how much of the real spending the photographed receipts cover.
 */
export async function grocerySummary({ months = 12, now = new Date() } = {}) {
  const today = reginaToday(now);
  const thisMonth = today.slice(0, 7);
  const from = `${addMonths(`${thisMonth}-01`, -(months - 1))}`;
  const [{ rows }, { rows: ledger }, { rows: stores }, { rows: brands }] = await Promise.all([
    pool.query(`SELECT to_char(date, 'YYYY-MM') AS month, food_type, SUM(amount) AS amount, SUM(discount) AS discount, COUNT(DISTINCT receipt_id) AS receipts
                FROM grocery_items WHERE date >= $1 GROUP BY 1, 2`, [from]),
    pool.query(`SELECT to_char(l.date, 'YYYY-MM') AS month, -SUM(l.amount) AS amount FROM transaction_lines l
                JOIN expense_categories c ON c.id = l.category_id WHERE c.name ILIKE '%grocer%' AND l.date >= $1 AND NOT l.is_transfer GROUP BY 1`, [from]),
    pool.query(`SELECT store, SUM(amount) AS amount, COUNT(DISTINCT receipt_id) AS trips FROM grocery_items
                WHERE date >= $1 GROUP BY 1 ORDER BY 2 DESC`, [addMonths(`${thisMonth}-01`, -6)]),
    pool.query(`SELECT store_brand, SUM(amount) AS amount FROM grocery_items WHERE date >= $1 AND food_type <> ALL($2) GROUP BY 1`,
      [addMonths(`${thisMonth}-01`, -6), [...NON_FOOD]]),
  ]);
  const list = [];
  for (let i = months - 1; i >= 0; i--) list.push(addMonths(`${thisMonth}-01`, -i).slice(0, 7));
  const byMonth = new Map(list.map((m) => [m, { month: m, total: 0, discount: 0, receipts: 0, by_type: {}, ledger_groceries: null }]));
  for (const r of rows) {
    const m = byMonth.get(r.month);
    if (!m) continue;
    m.by_type[r.food_type] = r2(r.amount);
    m.total = r2(m.total + Number(r.amount));
    m.discount = r2(m.discount + Number(r.discount));
    m.receipts = Math.max(m.receipts, Number(r.receipts));
  }
  for (const r of ledger) if (byMonth.has(r.month)) byMonth.get(r.month).ledger_groceries = r2(r.amount);
  // Receipts per month properly (the per-type count above undercounts).
  const { rows: rc } = await pool.query(`SELECT to_char(date, 'YYYY-MM') AS month, COUNT(DISTINCT receipt_id) AS n FROM grocery_items WHERE date >= $1 GROUP BY 1`, [from]);
  for (const r of rc) if (byMonth.has(r.month)) byMonth.get(r.month).receipts = Number(r.n);

  const full = list.filter((m) => m < thisMonth && byMonth.get(m).receipts > 0).slice(-6).map((m) => byMonth.get(m));
  const typical = { total: median(full.map((m) => m.total)), by_type: {}, months_used: full.map((m) => m.month) };
  for (const t of FOOD_TYPES) {
    const v = median(full.map((m) => m.by_type[t] || 0));
    if (v) typical.by_type[t] = v;
  }
  typical.ledger_groceries = median(full.map((m) => m.ledger_groceries).filter((v) => v != null));
  const current = byMonth.get(thisMonth);
  const day = Number(today.slice(8, 10));
  const daysIn = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)), 0)).getUTCDate();
  const sb = Object.fromEntries(brands.map((b) => [b.store_brand ? 'store' : 'name', Number(b.amount)]));
  const foodSpend = (sb.store || 0) + (sb.name || 0);
  return {
    today, months: [...byMonth.values()], typical,
    this_month: { ...current, pace: day >= 5 && current.total ? r2((current.total / day) * daysIn) : null, day, days_in_month: daysIn },
    stores: stores.map((s) => ({ store: s.store, amount: r2(s.amount), trips: Number(s.trips) })),
    store_brand_share: foodSpend ? Math.round(((sb.store || 0) / foodSpend) * 100) : null,
  };
}

/**
 * The price book: every item bought in the last year, its price per kg,
 * litre or each at each store (latest and lowest), and where it's cheapest.
 * Items bought at two or more stores come first, by what buying them at the
 * cheapest store would have saved over the year.
 */
export async function priceBook({ now = new Date(), limit = 150 } = {}) {
  const since = addMonths(reginaToday(now), -12);
  const { rows } = await pool.query(
    `SELECT item, unit, store, date, unit_price, amount, store_brand, brand FROM grocery_items
     WHERE date >= $1 AND unit_price > 0 AND item <> 'unreadable' AND food_type <> 'other' ORDER BY date`, [since]);
  const items = new Map();
  for (const r of rows) {
    const key = `${r.item}|${r.unit}`;
    const it = items.get(key) || { item: r.item, unit: r.unit, spent: 0, bought: 0, stores: new Map() };
    it.spent += Number(r.amount); it.bought += 1;
    const s = it.stores.get(r.store) || { store: r.store, latest: null, lowest: Infinity, times: 0, last_date: null };
    s.latest = Number(r.unit_price); s.last_date = toISODate(r.date); s.times += 1;
    s.lowest = Math.min(s.lowest, Number(r.unit_price));
    it.stores.set(r.store, s);
    items.set(key, it);
  }
  const out = [...items.values()].map((it) => {
    const stores = [...it.stores.values()].map((s) => ({ ...s, latest: r4(s.latest), lowest: r4(s.lowest) })).sort((a, b) => a.latest - b.latest);
    const usual = [...stores].sort((a, b) => b.times - a.times)[0];
    const cheapest = stores[0];
    const savingPct = stores.length > 1 && usual.latest > 0 ? Math.round((1 - cheapest.latest / usual.latest) * 100) : 0;
    return {
      item: it.item, unit: it.unit, bought: it.bought, spent: r2(it.spent), stores,
      usual_store: usual.store, cheapest_store: cheapest.store, saving_pct: savingPct,
      yearly_saving: savingPct > 0 && usual.store !== cheapest.store ? r2(it.spent * (savingPct / 100)) : 0,
    };
  });
  out.sort((a, b) => (b.stores.length > 1) - (a.stores.length > 1) || b.yearly_saving - a.yearly_saving || b.spent - a.spent);
  return out.slice(0, limit);
}

// ---------- cost cutting ----------

export async function latestAdvice() {
  const { rows: [a] } = await pool.query('SELECT created_at, advice FROM grocery_advice ORDER BY id DESC LIMIT 1');
  return a ? { ...a.advice, created_at: a.created_at } : null;
}

/** Cost-cutting suggestions from the family's own numbers (Sonnet), kept until asked again. */
export async function makeAdvice({ now = new Date() } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Set ANTHROPIC_API_KEY to get suggestions.'), { status: 503 });
  const [summary, prices] = await Promise.all([grocerySummary({ months: 6, now }), priceBook({ now, limit: 80 })]);
  if (!summary.months.some((m) => m.receipts)) throw Object.assign(new Error('No grocery receipts catalogued yet.'), { status: 409 });
  const since = addMonths(reginaToday(now), -6);
  const { rows: top } = await pool.query(
    `SELECT item, food_type, COUNT(*) AS times, SUM(amount) AS spent, SUM(discount) AS saved, bool_or(store_brand) AS some_store_brand,
            string_agg(DISTINCT brand, ', ') AS brands, string_agg(DISTINCT store, ', ') AS stores
     FROM grocery_items WHERE date >= $1 AND item <> 'unreadable' GROUP BY 1, 2 ORDER BY spent DESC LIMIT 60`, [since]);
  const data = {
    months: summary.months.map((m) => ({ month: m.month, receipts: m.receipts, total: m.total, by_type: m.by_type, discounts: m.discount, ledger_groceries: m.ledger_groceries })),
    typical_month: summary.typical, stores_last_6_months: summary.stores, store_brand_share_pct: summary.store_brand_share,
    top_items_last_6_months: top.map((t) => ({ ...t, spent: r2(t.spent), saved: r2(t.saved), times: Number(t.times) })),
    price_comparisons: prices.filter((p) => p.stores.length > 1).slice(0, 40)
      .map((p) => ({ item: p.item, per: p.unit, usual: p.usual_store, cheapest: p.cheapest_store, saving_pct: p.saving_pct, yearly_saving: p.yearly_saving, stores: p.stores.map((s) => `${s.store} $${s.latest}`) })),
  };
  const prompt = `You are helping a farm family near Melfort, Saskatchewan spend less on groceries. Below is what their catalogued grocery receipts show (amounts CAD; only photographed receipts are counted, ledger_groceries is everything filed as groceries in their books).

Give 4 to 8 cost-cutting suggestions that come from THESE numbers: name the items, stores and dollar amounts. Good kinds: an item that's cheaper at a store they already shop at; a food type running above their typical month; a branded staple where a store brand would do; buying in bulk at Costco for things they buy often; sales and discounts they're not catching; spending that has crept up. Estimate each one's monthly saving honestly (0 if you can't). Don't judge their choices or diet and don't give generic tips (meal planning, lists, coupons) unless the data points at it. If the data is thin (few receipts), say so in the headline.

Call record_advice.

DATA:
${JSON.stringify(data)}`;
  const body = await claude({
    model: ADVICE_MODEL, max_tokens: 4000,
    tools: [{
      name: 'record_advice', description: 'Record the grocery cost-cutting suggestions.',
      input_schema: {
        type: 'object', required: ['headline', 'suggestions'],
        properties: {
          headline: { type: 'string', description: 'One sentence: where the money goes and the biggest lever.' },
          suggestions: { type: 'array', items: { type: 'object', required: ['title', 'detail', 'monthly_saving'],
            properties: { title: { type: 'string' }, detail: { type: 'string' }, monthly_saving: { type: 'number' } } } },
        },
      },
    }],
    messages: [{ role: 'user', content: prompt }],
  });
  const tool = (body.content || []).find((c) => c.type === 'tool_use');
  if (!tool?.input?.suggestions) throw new Error("Suggestions couldn't be worked out — try again.");
  const advice = {
    headline: String(tool.input.headline || ''),
    suggestions: tool.input.suggestions.slice(0, 8).map((s) => ({ title: String(s.title), detail: String(s.detail), monthly_saving: Math.max(0, r2(s.monthly_saving || 0)) })),
    based_on: { receipts: summary.months.reduce((a, m) => a + m.receipts, 0), months: summary.months.filter((m) => m.receipts).length },
  };
  const { rows: [a] } = await pool.query('INSERT INTO grocery_advice (advice) VALUES ($1) RETURNING created_at', [advice]);
  return { ...advice, created_at: a.created_at };
}
