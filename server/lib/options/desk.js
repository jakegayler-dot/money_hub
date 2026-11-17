// The covered-call desk (Jake, Nov 17): his rules, the watchlist scan for drops, the watcher that notes a drop once a day
// during US market hours, and his positions. Money Hub only reads the market and keeps his records; it never places a trade.
import { pool, getSetting } from '../../db.js';
import { quote, history, chain } from './market.js';
import { cleanRules, dropCheck, soonExpiries, pick, evaluate, daysTo } from './strategy.js';
import { toISODate } from '../dates.js';

const RULES_KEY = 'covered_call_rules';
const ALERTS_KEY = 'covered_call_alerts';
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export async function getRules() { return cleanRules(await getSetting(RULES_KEY, {})); }
export async function saveRules(input) {
  const rules = cleanRules({ ...(await getRules()), ...input });
  await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [RULES_KEY, JSON.stringify(rules)]);
  return rules;
}

const expiryCache = new Map(); // symbol → { at, expiries } (the expiry list barely changes in a day)
async function expiriesOf(symbol) {
  const hit = expiryCache.get(symbol);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.expiries;
  const ch = await chain(symbol);
  expiryCache.set(symbol, { at: Date.now(), expiries: ch.expiries });
  return ch.expiries;
}

async function inTurn(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => ({ error: e.message })); }
  }));
  return out;
}

/** Every stock on his watchlist: today's move, how far below its recent high, the expiries in the next week, and his drop rule. */
export async function scan(rulesIn = null, now = new Date()) {
  const rules = rulesIn || await getRules();
  const rows = await inTurn(rules.watchlist, 4, async (symbol) => {
    const [q, hist, expiries] = await Promise.all([quote(symbol), history(symbol, rules.high_days + 10), expiriesOf(symbol).catch(() => [])]);
    const soon = soonExpiries(expiries, 7, now);
    return { symbol, price: r2(q.price), iv30: q.iv30 == null ? null : r2(q.iv30 * 100), as_of: q.as_of, ...dropCheck(hist, q, rules),
      expiries_this_week: soon, next_expiry: soon[0] || expiries.find((e) => daysTo(e, now) > 0) || null };
  });
  return { rules, as_of: now.toISOString(), stocks: rows.map((r, i) => (r.error ? { symbol: rules.watchlist[i], error: r.error } : r)) };
}

/** What his rules pick on one stock today: the call, the put, the lots, with the figures for one lot. */
export async function plan(symbol, overrides = {}, now = new Date()) {
  const rules = cleanRules({ ...(await getRules()), ...overrides });
  const ch = await chain(symbol);
  const [hist] = await Promise.all([history(symbol, rules.high_days + 10)]);
  const p = pick(ch, rules, { now });
  return { symbol, as_of: ch.as_of, quote: ch.quote, drop: dropCheck(hist, ch.quote, rules), ...p };
}

/** One expiry's strikes for the calculator's pickers (nearest `n` each side of the price). */
export async function strikes(symbol, expiry, n = 20) {
  const ch = await chain(symbol);
  const exp = expiry && ch.expiries.includes(expiry) ? expiry : ch.expiries.find((e) => daysTo(e) > 0) || ch.expiries[0];
  const price = ch.quote.price;
  const near = (type) => ch.contracts.filter((c) => c.expiry === exp && c.type === type)
    .sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price)).slice(0, n * 2).sort((a, b) => a.strike - b.strike);
  return { symbol, as_of: ch.as_of, quote: ch.quote, expiries: ch.expiries.filter((e) => daysTo(e) > 0), expiry: exp, calls: near('call'), puts: near('put') };
}

// ---------- the watcher ----------
/** Is the US market open now (9:30 to 4 in New York, weekdays; holidays aren't known, a quiet scan does no harm)? */
export function marketOpen(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  if (['Sat', 'Sun'].includes(parts.weekday)) return false;
  const m = Number(parts.hour) * 60 + Number(parts.minute);
  return m >= 9 * 60 + 30 && m < 16 * 60;
}
export async function alerts() { const a = await getSetting(ALERTS_KEY, []); return Array.isArray(a) ? a : []; }

/** Scan, and note each stock that drops by his rule (once a stock a day), with what his rules would pick on it. */
export async function watch(now = new Date()) {
  if (!marketOpen(now)) return [];
  const rules = await getRules();
  if (!rules.watchlist.length) return [];
  const s = await scan(rules, now);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const list = await alerts();
  const fresh = [];
  for (const st of s.stocks) {
    if (!st.triggered || list.some((a) => a.symbol === st.symbol && a.date === today)) continue;
    let picked = null;
    try {
      const p = await plan(st.symbol, {}, now);
      picked = {
        call: p.call && { strike: p.call.strike, expiry: p.call.expiry, bid: p.call.bid, delta: r2(p.call.delta) },
        put: p.put && { strike: p.put.strike, expiry: p.put.expiry, ask: p.put.ask },
        lots: p.sizing.lots, income_per_day: p.lot.income_per_day, max_loss_per_lot: p.lot.max_loss,
      };
    } catch { /* the alert stands without the picks */ }
    fresh.push({ symbol: st.symbol, date: today, at: now.toISOString(), price: st.price, day_pct: st.day_pct, from_high_pct: st.from_high_pct,
      why: st.why, expiries_this_week: st.expiries_this_week.length, picked });
  }
  if (fresh.length) {
    await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [ALERTS_KEY, JSON.stringify([...fresh, ...list].slice(0, 60))]);
  }
  return fresh;
}

// ---------- his positions ----------
const cleanLegs = (legs) => (Array.isArray(legs) ? legs : []).map((l) => ({
  type: l.type === 'put' ? 'put' : 'call', side: l.side === 'long' ? 'long' : 'short', strike: Number(l.strike), expiry: String(l.expiry || '').slice(0, 10),
  premium: Number(l.premium) || 0, contracts: Math.max(1, Math.round(Number(l.contracts) || 1)),
  ...(Number(l.iv) > 0 ? { iv: Number(l.iv) } : {}), ...(Number.isFinite(Number(l.delta)) && l.delta !== null && l.delta !== '' ? { delta: Number(l.delta) } : {}),
})).filter((l) => l.strike > 0 && /^\d{4}-\d{2}-\d{2}$/.test(l.expiry)).slice(0, 8);

export function positionFields(b = {}, current = {}) {
  const symbol = String(b.symbol ?? current.symbol ?? '').trim().toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(symbol)) throw Object.assign(new Error('A stock symbol, like NVDA.'), { status: 422 });
  const shares = Math.round(Number(b.shares ?? current.shares));
  if (!(shares >= 0)) throw Object.assign(new Error('How many shares?'), { status: 422 });
  const cost = Number(b.cost ?? current.cost);
  if (!(cost > 0)) throw Object.assign(new Error('What did the shares cost each?'), { status: 422 });
  const status = ['planned', 'open', 'closed'].includes(b.status) ? b.status : current.status || 'open';
  return {
    symbol, shares, cost, status, legs: cleanLegs(b.legs ?? current.legs),
    opened_on: b.opened_on || current.opened_on || null,
    premium_collected: Number(b.premium_collected ?? current.premium_collected ?? 0) || 0,
    closed_on: status === 'closed' ? (b.closed_on || current.closed_on || new Date().toISOString().slice(0, 10)) : null,
    closed_price: status === 'closed' ? (Number(b.closed_price ?? current.closed_price) || null) : null,
    notes: b.notes !== undefined ? (String(b.notes || '').trim().slice(0, 2000) || null) : current.notes || null,
  };
}

/** His positions, each valued at today's price: the stock's gain or loss, premium in, and the figures for the legs it holds now. */
export async function positions(now = new Date()) {
  const { rows } = await pool.query(`SELECT * FROM options_positions ORDER BY (status = 'closed'), opened_on DESC, id DESC`);
  const prices = new Map();
  await inTurn([...new Set(rows.filter((r) => r.status !== 'closed').map((r) => r.symbol))], 4, async (s) => prices.set(s, (await quote(s)).price));
  return rows.map((r) => {
    const cost = Number(r.cost); const shares = Number(r.shares);
    const price = r.status === 'closed' ? Number(r.closed_price) || null : prices.get(r.symbol) ?? null;
    const legs = (r.legs || []).filter((l) => r.status === 'closed' || daysTo(l.expiry, now) > -1);
    const figures = price ? evaluate({ price, shares, cost, legs }, { now }) : null;
    const stockPnl = price ? r2((price - cost) * shares) : null;
    return {
      id: r.id, symbol: r.symbol, shares, cost, status: r.status, opened_on: toISODate(r.opened_on), closed_on: toISODate(r.closed_on), notes: r.notes,
      legs: r.legs || [], premium_collected: Number(r.premium_collected), price: price == null ? null : r2(price),
      stock_pnl: stockPnl, total_pnl: stockPnl == null ? null : r2(stockPnl + Number(r.premium_collected)),
      days_held: Math.max(1, Math.round((now - new Date(`${toISODate(r.opened_on)}T12:00:00Z`)) / 86400e3)),
      figures: figures && { max_gain: figures.max_gain, max_loss: figures.max_loss, breakevens: figures.breakevens, horizon: figures.horizon, income_per_day: figures.income_per_day },
    };
  });
}
