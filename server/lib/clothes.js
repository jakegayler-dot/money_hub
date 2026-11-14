// Clothes from a receipt into Self Hub's wardrobe (Jake, 2026-11-14: "when I scan a receipt for moneyhub, if it's clothes or
// groceries, it automatically updates self hubs wardrobe library and grocery inventory").
//
// A clothing store's receipt, a receipt filed as clothing, or a grocery slip with clothing lines (Walmart, Costco) is read
// again item by item: what it is, brand, colour, size, the price, and who it's for. Everything goes to Sentinel
// (POST /v1/wardrobe/receipt), which adds Jake's own to his wardrobe in Self Hub: the wardrobe is his, so Ashley's and the
// boys' clothes, and anything the slip doesn't make clear, stay out. Once a receipt (Sentinel keeps which it has had).
import { pool } from '../db.js';
import { toISODate } from './dates.js';
import { reginaToday } from './sentinelSnapshot.js';
import { storeName } from './groceries.js';

const MODEL = process.env.CLOTHES_MODEL || process.env.GROCERY_MODEL || process.env.RECEIPT_MODEL || 'claude-sonnet-5-5';
// Self Hub's wardrobe lists (lib/wardrobe.js); Sentinel drops anything else.
export const CATEGORIES = ['Top', 'Bottom', 'Outerwear', 'Footwear', 'Accessory', 'Sleepwear'];
export const STYLES = ['Casual', 'Smart Casual', 'Dress', 'Athletic', 'Farm', 'Loungewear', 'Formal'];
export const SEASONS = ['Summer', 'Fall/Winter', 'Winter', 'All-Season'];
const MAX_AGE_DAYS = 45; // a receipt scanned a few weeks late still counts; an old backfill doesn't

const CLOTHING_STORE = /mark'?s|work ?wearhouse|sport ?chek|atmosphere|winners|old navy|\bgap\b|\bh ?& ?m\b|simons|lululemon|hudson'?s bay|\bthe bay\b|sporting life|levi|\broots\b|under armour|nike|adidas|american eagle|banana republic|uniqlo|zara|moores|harry rosen|indochino|boot barn|columbia|patagonia|arc'?teryx|carhartt|kodiak|cabela|bass pro|red wing|sorel|ssense|mec\b/i;
export const CLOTHES_WORDS = /\b(shirts?|t-?shirts?|tees?|polos?|jeans?|pants?|trousers?|chinos?|shorts|socks?|jackets?|coats?|parkas?|vests?|hoodies?|sweaters?|cardigans?|fleeces?|boots?|shoes?|sneakers?|runners?|sandals?|toques?|beanies?|gloves?|mitts?|mittens?|scarf|scarves|underwear|boxers?|briefs|pyjamas?|pajamas?|blazers?|suits?|coveralls?|overalls?|apparel)\b/i;

/** A read receipt that may hold clothes (the reader then decides line by line). */
export function looksLikeClothes(ex) {
  if (!ex?.is_receipt || (ex.doc_type && ex.doc_type !== 'receipt') || !(Number(ex.total) > 0)) return false;
  if (/cloth|apparel|footwear/i.test(String(ex.category || ''))) return true;
  if (CLOTHING_STORE.test(String(ex.party || ''))) return true;
  return (ex.items || []).some((i) => CLOTHES_WORDS.test(String(i?.description || '')));
}

export const PROMPT = ({ party, date, owner }) => `This is a receipt${party ? ` from ${party}` : ''}${date ? ` dated ${date}` : ''}, bought by a farm family in Saskatchewan: Jake (an adult man, the farmer), Ashley (an adult woman) and their boys Alex (5) and Ollie (3).${owner ? ` It was filed under "${owner}".` : ''}

Record every CLOTHING, FOOTWEAR or wearable ACCESSORY line (hats, toques, gloves, scarves, belts) by calling record_clothes. Leave out everything else: food, household, tools, parts, fees, gift cards. Angle brackets describe the value; never copy them.
{
  "is_clothing": <false when nothing on it is clothing>,
  "items": [{
    "printed": <the line as printed>,
    "for": <"jake" for a men's item, or a plainly adult unisex item in a man's size, with nothing pointing to Ashley; "ashley" for women's or ladies'; "kids" for boys', youth, toddler or kids' sizes (2T to 6X, youth XS to XL, kids' shoe sizes); "unsure" when the slip doesn't say. On a receipt filed under jake, an adult item with nothing pointing to Ashley or the boys (a toque, gloves, a belt) is "jake">,
    "category": <one of ${CATEGORIES.join(', ')}>,
    "type": <a short plain name: "Jeans", "Work pants", "T-shirt", "Hoodie", "Winter parka", "Work boots", "Toque", "Socks">,
    "brand": <the brand if shown, else null>,
    "colour": <only if the slip shows it, else null>,
    "size": <as printed ("34x32", "L", "10.5"), else null>,
    "style": <one of ${STYLES.join(', ')}, or null>,
    "season": <one of ${SEASONS.join(', ')}, or null>,
    "qty": <how many of it>,
    "price": <what one cost after its own discounts, positive>
  }]
}
Read till abbreviations into words ("MNS DH WRK PNT 34X32" is men's Dakota work pants 34x32). Never guess a colour, size or brand the slip doesn't show.`;

async function claude(body) {
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(out?.error?.message || `Claude API ${res.status}`);
  if (out.stop_reason === 'refusal') throw new Error('The reader declined this request.');
  return out;
}

/** Reads the clothes on a receipt. */
export async function readClothes(rc, ex) {
  const { documentBlocks } = await import('./receipts.js');
  const tools = [{
    name: 'record_clothes', description: 'Record every clothing line on the receipt.',
    input_schema: { type: 'object', properties: { is_clothing: { type: 'boolean' }, items: { type: 'array', items: { type: 'object' } } }, required: ['is_clothing', 'items'] },
  }];
  // No tool_choice: Sonnet 5.5 refuses a forced tool (tried live, Nov 14), so it's asked once more if it answers in words.
  const userTurn = { role: 'user', content: [...(await documentBlocks(rc)), { type: 'text', text: PROMPT({ party: ex.party, date: ex.date, owner: ex.owner }) }] };
  let body = await claude({ model: MODEL, max_tokens: 8000, tools, messages: [userTurn] });
  let tool = (body.content || []).find((c) => c.type === 'tool_use');
  if (!tool) {
    body = await claude({ model: MODEL, max_tokens: 8000, tools, messages: [userTurn,
      { role: 'assistant', content: body.content?.length ? body.content : [{ type: 'text', text: '(no answer)' }] },
      { role: 'user', content: 'Call record_clothes now (is_clothing false and no items if there are none).' }] });
    tool = (body.content || []).find((c) => c.type === 'tool_use');
  }
  if (!tool?.input) throw new Error("The clothes couldn't be read.");
  const input = tool.input;
  if (typeof input.items === 'string') { try { input.items = JSON.parse(input.items); } catch { input.items = []; } }
  return input;
}

const s = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
/** One item from the reader, in the wardrobe's words; null for nothing usable. */
export function cleanItem(i) {
  if (!i || typeof i !== 'object') return null;
  const category = CATEGORIES.find((c) => c.toLowerCase() === String(i.category || '').toLowerCase());
  const type = s(i.type, 80);
  if (!category || !type) return null;
  const pick = (v, list) => list.find((x) => x.toLowerCase() === String(v || '').toLowerCase()) || null;
  const price = Number(i.price);
  const qty = Math.max(1, Math.min(10, Math.round(Number(i.qty) || 1)));
  return { printed: s(i.printed, 120), for: ['jake', 'ashley', 'kids'].includes(i.for) ? i.for : 'unsure', category, type,
    brand: s(i.brand, 60), colour: s(i.colour, 60), size: s(i.size, 60), style: pick(i.style, STYLES), season: pick(i.season, SEASONS),
    qty, price: Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null };
}

/** Sends a receipt's clothes to Sentinel, which adds Jake's to his wardrobe. Never throws. */
export async function pushClothes({ receipt_id, store, date, items }) {
  const url = process.env.SENTINEL_URL;
  const key = process.env.SENTINEL_API_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/v1/wardrobe/receipt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt_id, store, date, items }),
      signal: AbortSignal.timeout(30000),
    });
    const out = await res.json().catch(() => null);
    if (!res.ok) { console.error(`Sentinel wardrobe receipt: HTTP ${res.status}`); return null; }
    if (out?.added?.length) console.log(`Sentinel added to the wardrobe: ${out.added.map((a) => a.type).join(', ')}`);
    return out;
  } catch (e) {
    console.error(`Sentinel wardrobe receipt: ${e.message}`);
    return null;
  }
}

/**
 * After a receipt is read (and catalogued, if groceries): the clothes on it, if any, to Sentinel.
 * grocery: catalogueIfGrocery's answer ({ lines }) or null.
 */
export async function clothesIfAny(id, grocery = null) {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SENTINEL_URL) return null;
  const { rows: [rc] } = await pool.query('SELECT * FROM receipts WHERE id = $1', [id]);
  const ex = rc?.extracted;
  if (!rc || !ex) return null;
  // receipts.clothes says where it stands: sent, none, or failed (tried again by clothesSweep, up to MAX_TRIES).
  const mark = (v) => pool.query(`UPDATE receipts SET clothes = $2, clothes_tries = COALESCE(clothes_tries, 0) + (CASE WHEN $2 = 'failed' THEN 1 ELSE 0 END)
    WHERE id = $1`, [id, v]).catch((e) => console.error('Clothes mark failed', id, e.message));
  const maybe = grocery ? (grocery.lines || []).some((l) => l.food_type === 'clothing') : looksLikeClothes(ex);
  if (!maybe) { await mark('none'); return null; }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(ex.date)) ? ex.date : toISODate(rc.uploaded_at);
  const age = (new Date(`${reginaToday()}T12:00:00Z`) - new Date(`${date}T12:00:00Z`)) / 86400000;
  if (age > MAX_AGE_DAYS) { await mark('none'); return null; }
  let read;
  try { read = await readClothes(rc, ex); } catch (e) {
    console.error('Clothes read failed', id, e.message);
    await mark('failed');
    return null;
  }
  const items = (Array.isArray(read.items) ? read.items : []).map(cleanItem).filter(Boolean);
  if (read.is_clothing === false || !items.length) { await mark('none'); return null; }
  const out = await pushClothes({ receipt_id: id, store: storeName(ex.party), date, items });
  await mark(out ? 'sent' : 'failed');
  return out;
}

const MAX_TRIES = 3;
/** What clothesIfAny is told about a receipt in the sweep: a catalogued grocery slip by its clothing lines, else nothing. */
export const sweepGrocery = (r) => (r.grocery === 'catalogued' ? { lines: r.clothing_lines ? [{ food_type: 'clothing' }] : [] } : null);

/**
 * Clothes not yet sent (Nov 14: an H&M receipt read while the reader was broken never reached the wardrobe): every receipt of
 * the last 45 days not looked at, or failed fewer than MAX_TRIES times, goes through clothesIfAny again. Sentinel takes a
 * receipt once, so one sent twice adds nothing.
 */
export async function clothesSweep({ limit = 60 } = {}) {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SENTINEL_URL) return 0;
  const { rows } = await pool.query(`SELECT r.id, r.grocery,
      EXISTS (SELECT 1 FROM grocery_items g WHERE g.receipt_id = r.id AND g.food_type = 'clothing') AS clothing_lines
    FROM receipts r WHERE r.extracted IS NOT NULL AND r.status NOT IN ('failed', 'not_receipt', 'reading') AND r.grocery IS NOT NULL
      AND r.uploaded_at > now() - interval '${MAX_AGE_DAYS} days'
      AND (r.clothes IS NULL OR (r.clothes = 'failed' AND COALESCE(r.clothes_tries, 0) < ${MAX_TRIES}))
    ORDER BY r.id DESC LIMIT $1`, [limit]); // newest first: the receipt he just scanned matters most
  for (const r of rows) {
    try { await clothesIfAny(r.id, sweepGrocery(r)); } catch (e) { console.error('Clothes sweep', r.id, e.message); }
  }
  return rows.length;
}
