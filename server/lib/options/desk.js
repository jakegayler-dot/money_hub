// The covered-call desk (Jake, Nov 17): his rules, the watchlist scan for drops, the watcher that notes a drop once a day
// during US market hours, and his positions. Money Hub only reads the market and keeps his records; it never places a trade.
import { pool, getSetting } from '../../db.js';
import { quote, history, chain, parseOcc, cboeBusy } from './market.js';
import { cleanRules, dropCheck, soonExpiries, pick, evaluate, daysTo, expiryCadence, legDays } from './strategy.js';
import { toISODate } from '../dates.js';
import { usdCad } from './fx.js';
import { nextEarnings, inside } from './earnings.js';

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
// The wider list (Nov 17, his pick: "the stock watcher needs to look for stocks that have 3 day options or less"): large US
// stocks and ETFs; only those whose options expire at least every expiry_every_days (Mon/Wed/Fri or daily), whose call pays more a day than the put costs, show.
export const WIDE = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'PLTR', 'COIN', 'MSTR', 'ORCL',
  'CRM', 'ADBE', 'INTC', 'MU', 'QCOM', 'SMCI', 'ARM', 'UBER', 'SHOP', 'JPM', 'BAC', 'WFC', 'GS', 'C', 'XOM', 'CVX', 'BA', 'DIS',
  'WMT', 'COST', 'HD', 'UNH', 'LLY', 'JNJ', 'PFE', 'MRK', 'KO', 'PEP', 'NKE', 'HOOD', 'SOFI', 'RIVN', 'BABA', 'PYPL', 'SPY', 'QQQ', 'IWM'];
const SCAN_CHAIN_TTL = 15 * 60e3; // ~1 MB a chain: his watchlist's read at most every 15 minutes
const WIDE_EVERY = 30 * 60e3;      // the wider list: one stock at a time, a pause between, at most every 30 minutes
const WIDE_PAUSE = 1500;

/** One stock: today's move, the drop rule, how often its options expire, and the gap between what his rules' call brings in a
 *  day and what the put costs a day (US$ a lot). qualifies = options at least every expiry_every_days, a gap above 0 and at
 *  least his min_carry (CAD). */
async function readStock(symbol, rules, fx, now, watched) {
  const [q, hist, ch] = await Promise.all([quote(symbol), history(symbol, rules.high_days + 10), chain(symbol, { ttl: SCAN_CHAIN_TTL })]);
  expiryCache.set(symbol, { at: Date.now(), expiries: ch.expiries });
  // How often its options expire (Nov 17: "options expiring at most every 3 days, not an option expiring within 3 days").
  const cadence = expiryCadence(ch.expiries, now);
  const often = !!cadence && cadence.max <= rules.expiry_every_days;
  const soon = soonExpiries(ch.expiries, 7, now);
  const p = watched || often ? pick(ch, rules, { now, fx: fx?.rate }) : null;
  const carry = p?.carry || null;
  return { symbol, watched, price: r2(q.price), iv30: q.iv30 == null ? null : r2(q.iv30 * 100), as_of: q.as_of, ...dropCheck(hist, q, rules),
    expiries_this_week: soon, cadence, often, next_expiry: soon[0] || ch.expiries.find((e) => daysTo(e, now) > 0) || null,
    carry, day_play: p?.day_play || null, qualifies: !!(often && carry && carry.gap != null && carry.gap > 0 && carry.gap * (fx?.rate || 1) >= rules.min_carry) };
}

// The wider list, swept in the background (Cboe's free feed refuses a burst of 50 chains: 429s, Nov 17).
const wideState = { at: 0, rows: [], unread: [], running: null, key: '' };
export async function sweepWide(rules, { now = new Date(), pause = WIDE_PAUSE } = {}) {
  if (wideState.running) return wideState.running;
  wideState.running = (async () => {
    const fx = await usdCad();
    const watch = new Set(rules.watchlist);
    const rows = []; const unread = [];
    for (const symbol of WIDE.filter((s) => !watch.has(s))) {
      if (cboeBusy()) await new Promise((r) => setTimeout(r, 125e3)); // wait out Cboe's pause, then go on
      try { rows.push(await readStock(symbol, rules, fx, now, false)); } catch (e) { unread.push({ symbol, error: e.message }); }
      if (pause) await new Promise((r) => setTimeout(r, pause));
    }
    Object.assign(wideState, { at: Date.now(), rows, unread, key: JSON.stringify(rules) });
  })().finally(() => { wideState.running = null; });
  return wideState.running;
}

/** His watchlist, read now, and the wider list as last swept (a new sweep starts behind it when that's over 30 minutes old
 *  or his rules changed). */
export async function scan(rulesIn = null, now = new Date()) {
  const rules = rulesIn || await getRules();
  const fx = await usdCad();
  const rows = await inTurn(rules.watchlist, 2, (symbol) => readStock(symbol, rules, fx, now, true));
  const stocks = rows.map((r, i) => (r.error ? { symbol: rules.watchlist[i], watched: true, error: r.error } : r));
  if (rules.wide && !wideState.running && (Date.now() - wideState.at > WIDE_EVERY || wideState.key !== JSON.stringify(rules))) {
    sweepWide(rules).catch((e) => console.error(`  !! Covered calls, the wider list: ${e.message}`));
  }
  const watch = new Set(rules.watchlist);
  // Earnings (Nov 19, Jake: "factor in earnings for the stocks in the list ... ie. earnings report calendar"): each row says its
  // next report, and whether it falls before the call it was priced on expires, or while the put is held.
  const cal = await nextEarnings({ now }).catch((e) => ({ map: new Map(), error: e.message }));
  const withEarnings = (r) => {
    if (r.error) return r;
    const e = cal.map.get(r.symbol) || null;
    const callExp = r.day_play?.call?.expiry || r.carry?.call?.expiry || null;
    const putExp = r.day_play?.put?.expiry || r.carry?.put?.expiry || null;
    return { ...r, earnings: e && { ...e, before_call: inside(e, callExp), before_put: inside(e, putExp), call_expiry: callExp } };
  };
  const all = stocks.map(withEarnings);
  const wide = (rules.wide ? wideState.rows.filter((r) => !watch.has(r.symbol)) : []).map(withEarnings);
  const ahead = [...all, ...wide].filter((r) => !r.error && r.day_play && r.day_play.net_per_day > 0);
  const reportsFirst = (r) => inside(r.earnings, r.day_play.call.expiry);
  return {
    rules, as_of: now.toISOString(), fx,
    stocks: all,
    earnings: { through: cal.through || null, days_read: cal.days_read || 0, running: !!cal.running, error: cal.error || null },
    wide: wide.filter((r) => r.qualifies).sort((a, b) => b.carry.gap - a.carry.gap),
    // The day's five (Nov 19): every stock read, watchlist and wider list, by what its call expiring today or the next trading
    // day pays a trading day less its long-horizon put and the margin interest, for one lot; only ones that come out ahead.
    // A stock reporting before its call expires is left out (its premium is the market pricing the report), and said.
    today_five: ahead.filter((r) => !reportsFirst(r))
      .sort((a, b) => b.day_play.net_per_day - a.day_play.net_per_day).slice(0, 5)
      .map((r) => ({ symbol: r.symbol, watched: !!r.watched, iv30: r.iv30, day_pct: r.day_pct ?? null, earnings: r.earnings, ...r.day_play })),
    left_out_earnings: ahead.filter(reportsFirst).sort((a, b) => b.day_play.net_per_day - a.day_play.net_per_day)
      .map((r) => ({ symbol: r.symbol, earnings: r.earnings, call: r.day_play.call, net_per_day: r.day_play.net_per_day })),
    call_otm: rules.call_otm, put_otm: rules.put_otm,
    wide_checked: wide.length + (rules.wide ? wideState.unread.length : 0),
    wide_unread: rules.wide ? wideState.unread : [],
    wide_as_of: rules.wide && wideState.at ? new Date(wideState.at).toISOString() : null,
    wide_running: !!wideState.running,
  };
}

/** What his rules pick on one stock today: the call, the put, the lots, with the figures for one lot. */
export async function plan(symbol, overrides = {}, now = new Date()) {
  const rules = cleanRules({ ...(await getRules()), ...overrides });
  const ch = await chain(symbol);
  const [hist, fx, held] = await Promise.all([history(symbol, rules.high_days + 10), usdCad(), heldPutStrike(symbol, now)]);
  const p = pick(ch, rules, { now, fx: fx?.rate, putStrike: held });
  return { symbol, as_of: ch.as_of, quote: ch.quote, drop: dropCheck(hist, ch.quote, rules), ...p, fx };
}

/** The highest strike of the puts he holds on a stock (open, not expired), or null: his calls go at or above it (Nov 19). */
async function heldPutStrike(symbol, now = new Date()) {
  const { rows } = await pool.query(`SELECT legs FROM options_positions WHERE symbol = $1 AND status = 'open'`, [symbol]).catch(() => ({ rows: [] }));
  const strikes = rows.flatMap((r) => r.legs || []).filter((l) => l.type === 'put' && l.side === 'long' && daysTo(l.expiry, now) > 0).map((l) => Number(l.strike));
  return strikes.length ? Math.max(...strikes) : null;
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
  if (!rules.watchlist.length && !rules.wide) return [];
  const s = await scan(rules, now);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const list = await alerts();
  const fresh = [];
  // A drop counts only on a stock whose options expire often enough and whose call pays more than the put costs (Nov 17).
  for (const st of [...s.stocks, ...s.wide]) {
    if (!st.triggered || !st.qualifies || list.some((a) => a.symbol === st.symbol && a.date === today)) continue;
    let picked = null;
    try {
      const p = await plan(st.symbol, {}, now);
      picked = {
        call: p.call && { strike: p.call.strike, expiry: p.call.expiry, bid: p.call.bid, delta: r2(p.call.delta) },
        put: p.put && { strike: p.put.strike, expiry: p.put.expiry, ask: p.put.ask },
        lots: p.sizing.lots, income_per_day: p.lot.income_per_day, net_per_day: p.lot.net_per_day, max_loss_per_lot: p.lot.max_loss,
        gap_per_day: p.carry?.gap ?? null, interest_per_day: p.lot.interest_per_day, capital_per_lot: p.lot.capital_needed,
        usd_cad: p.usd_cad,
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
  ...(/^\d{4}-\d{2}-\d{2}$/.test(String(l.since || '')) ? { since: String(l.since) } : {}),
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
  // His fills (Nov 19): the options he holds at what his Money Hub entries say they cost, not the broker's lumped average.
  const { optionCash, legsAtFills, bankedCalls } = await import('./cash.js');
  const cash = await optionCash({ symbols: rows.map((r) => r.symbol) }).catch(() => null);
  const fxRate = cash?.currency === 'CAD' ? (await usdCad().catch(() => null))?.rate : null;
  const entries = (cash?.entries || []).filter((e) => e.kind && e.symbol)
    .map((e) => ({ ...e, usd: cash.currency === 'CAD' && fxRate ? e.amount / fxRate : e.amount }));
  const todayNy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const prices = new Map();
  const rules = await getRules();
  const margin = { pct: rules.margin_pct, rate: rules.margin_rate }; // his margin rule, on what each position cost
  await inTurn([...new Set(rows.filter((r) => r.status !== 'closed').map((r) => r.symbol))], 4, async (s) => prices.set(s, (await quote(s)).price));
  return rows.map((r) => {
    const cost = Number(r.cost); const shares = Number(r.shares);
    const price = r.status === 'closed' ? Number(r.closed_price) || null : prices.get(r.symbol) ?? null;
    // An option without the day it was opened is taken from the day the position was (Nov 18): spread over the days left, a
    // premium grew to the whole of it on its last day.
    const opened = toISODate(r.opened_on);
    const rawLegs = (r.legs || []).filter((l) => r.status === 'closed' || daysTo(l.expiry, now) > -1);
    const legs = (r.status === 'closed' ? rawLegs : legsAtFills(rawLegs.filter((l) => daysTo(l.expiry, now) > 0), entries, r.symbol, { today: todayNy }))
      .map((l) => (l.since || !opened || opened > l.expiry || opened > todayNy ? l : { ...l, since: opened }));
    // Everything the calls have brought in counts, not only the open call's own sale (Nov 19).
    const banked = r.status === 'closed' ? null : bankedCalls(legs, entries, r.symbol, { today: todayNy });
    const figures = price ? evaluate({ price, shares, cost, legs, banked }, { now, margin: r.status === 'closed' ? null : margin }) : null;
    const stockPnl = price ? r2((price - cost) * shares) : null;
    return {
      id: r.id, symbol: r.symbol, shares, cost, status: r.status, source: r.source || 'manual', synced_at: r.synced_at || null, opened_on: toISODate(r.opened_on), closed_on: toISODate(r.closed_on), notes: r.notes,
      legs: r.legs || [], premium_collected: Number(r.premium_collected), price: price == null ? null : r2(price),
      open_legs: r.status === 'closed' ? [] : legs.filter((l) => daysTo(l.expiry, now) > 0).map((l) => ({ ...l, days: legDays(l, now), per_day: r2((Number(l.premium) * Number(l.contracts) * 100) / legDays(l, now)), ...(l.since && !(r.legs || []).find((o) => o.strike === l.strike && o.expiry === l.expiry && o.type === l.type)?.since ? { since_from_position: true } : {}) })),
      stock_pnl: stockPnl, total_pnl: stockPnl == null ? null : r2(stockPnl + Number(r.premium_collected)),
      days_held: Math.max(1, Math.round((now - new Date(`${toISODate(r.opened_on)}T12:00:00Z`)) / 86400e3)),
      figures: figures && { banked: figures.banked, premium_in: figures.premium_in, put_cost: figures.put_cost, max_gain: figures.max_gain, max_loss: figures.max_loss, breakevens: figures.breakevens, horizon: figures.horizon, income_per_day: figures.income_per_day,
        protection_per_day: figures.protection_per_day, net_per_day: figures.net_per_day,
        interest_per_day: figures.interest_per_day, net_after_interest_per_day: figures.net_after_interest_per_day, capital_needed: figures.capital_needed,
        revenue_per_day: figures.revenue_per_day, on_capital_pct_day: figures.on_capital_pct_day, on_capital_pct_year: figures.on_capital_pct_year,
        vs_max_loss_pct_day: figures.vs_max_loss_pct_day, days_to_earn_max_loss: figures.days_to_earn_max_loss },
    };
  });
}

// ---------- from his broker ----------
// A bot sends his brokerage account as it stands now (Nov 17: "build a way to enter my position ... and I'll have grok bot
// enter them properly"): every stock and option line. Each stock becomes one position with the options on it; a stock no
// longer held is closed. Option cash runs on by itself: an option that wasn't there last time was opened, so a sold one's
// premium is added and a bought one's cost taken off, unless the bot sends the total itself (premium_collected). Positions
// he entered on the page are left alone.
const SYNC_KEY = 'covered_call_sync';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const legKey = (l) => `${l.type}|${l.side}|${Number(l.strike)}|${l.expiry}`;
const lower = (v) => String(v || '').trim().toLowerCase();

/** Check and shape a snapshot (pure): { as_of, account, groups: Map symbol → { shares, cost, legs }, collected, errors }. */
export function readSnapshot(body = {}) {
  const errors = [];
  const rows = Array.isArray(body.positions) ? body.positions : null;
  if (!rows) return { errors: ['positions: a list of every stock and option line in the account'] };
  const groups = new Map();
  const group = (sym) => { if (!groups.has(sym)) groups.set(sym, { shares: 0, costTotal: 0, legs: [] }); return groups.get(sym); };
  rows.forEach((r, i) => {
    const at = `positions[${i}]`;
    const occ = parseOcc(String(r.occ || r.option_symbol || '').replace(/\s+/g, '')) || parseOcc(String(r.symbol || '').replace(/\s+/g, ''));
    const t = lower(r.type || r.right);
    const kind = lower(r.kind) === 'option' || occ || t.startsWith('c') || t.startsWith('p') ? 'option' : 'stock';
    const qty = Number(r.quantity);
    if (!Number.isFinite(qty) || qty === 0) { errors.push(`${at}: quantity (shares; or contracts, negative = sold)`); return; }
    if (kind === 'stock') {
      const sym = String(r.symbol || '').trim().toUpperCase();
      const cost = Number(r.avg_cost);
      if (!/^[A-Z]{1,6}$/.test(sym)) { errors.push(`${at}: symbol, like NVDA`); return; }
      if (!(cost > 0)) { errors.push(`${at}: avg_cost, the average price paid a share`); return; }
      if (qty < 0) { errors.push(`${at}: a short stock position isn't a covered call`); return; }
      const g = group(sym); g.shares += qty; g.costTotal += qty * cost;
      return;
    }
    const sym = String(r.underlying || occ?.root || r.symbol || '').trim().toUpperCase();
    const type = occ?.type || (t.startsWith('p') ? 'put' : t.startsWith('c') ? 'call' : null);
    const strike = occ?.strike ?? Number(r.strike);
    const expiry = occ?.expiry ?? String(r.expiry || '').slice(0, 10);
    const price = Number(r.avg_price ?? r.avg_cost);
    if (!/^[A-Z]{1,6}$/.test(sym)) { errors.push(`${at}: underlying, the stock the option is on`); return; }
    if (!type) { errors.push(`${at}: type, call or put`); return; }
    if (!(strike > 0)) { errors.push(`${at}: strike`); return; }
    if (!ISO.test(expiry)) { errors.push(`${at}: expiry, YYYY-MM-DD`); return; }
    if (!(price >= 0)) { errors.push(`${at}: avg_price, the premium a share (e.g. 1.82)`); return; }
    const opened = String(r.opened || r.opened_on || '').slice(0, 10);
    group(sym).legs.push({ type, side: qty < 0 ? 'short' : 'long', strike, expiry, premium: price, contracts: Math.abs(Math.round(qty)), ...(ISO.test(opened) ? { since: opened } : {}) });
  });
  for (const g of groups.values()) g.cost = g.shares ? g.costTotal / g.shares : 0;
  const collected = body.premium_collected && typeof body.premium_collected === 'object' ? body.premium_collected : {};
  return { as_of: ISO.test(String(body.as_of || '')) ? body.as_of : null, account: body.account ? String(body.account).slice(0, 80) : null, groups, collected, errors };
}

/** The cash from options opened since the last snapshot on one stock: + premium for ones sold, − for ones bought. Pure. */
export function newOptionCash(oldLegs = [], newLegs = []) {
  const before = new Map();
  for (const l of oldLegs) before.set(legKey(l), (before.get(legKey(l)) || 0) + Number(l.contracts || 0));
  let cash = 0;
  for (const l of newLegs) {
    const had = before.get(legKey(l)) || 0;
    const added = Math.max(0, l.contracts - had);
    before.set(legKey(l), Math.max(0, had - l.contracts));
    if (added) cash += (l.side === 'short' ? 1 : -1) * l.premium * added * 100;
  }
  return r2(cash);
}

export async function syncPositions(body = {}, { by = null, now = new Date(), priceOf = (s) => quote(s).then((q) => q.price) } = {}) {
  const snap = readSnapshot(body);
  if (snap.errors.length) throw Object.assign(new Error(`Nothing saved. Fix these and send the whole account again: ${snap.errors.join('; ')}`), { status: 422 });
  if (!snap.groups.size && body.confirm_empty !== true) {
    throw Object.assign(new Error('An empty account would close every position. Send confirm_empty: true if he really holds nothing.'), { status: 422 });
  }
  const today = snap.as_of || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const { rows: open } = await pool.query(`SELECT * FROM options_positions WHERE source = 'broker' AND status <> 'closed'`);
  const out = { added: [], updated: [], closed: [] };
  const cost4 = (v) => Math.round(v * 10000) / 10000;
  for (const [symbol, g] of snap.groups) {
    const cur = open.find((r) => r.symbol === symbol);
    // When each option was opened: the bot's date, else the day it was first seen here (kept from sync to sync).
    for (const l of g.legs) if (!l.since) l.since = (cur?.legs || []).find((o) => legKey(o) === legKey(l))?.since || today;
    const given = snap.collected[symbol];
    const told = given != null && given !== '' && Number.isFinite(Number(given));
    if (cur) {
      const collected = told ? Number(given) : Number(cur.premium_collected) + newOptionCash(cur.legs || [], g.legs);
      await pool.query(`UPDATE options_positions SET shares = $2, cost = $3, legs = $4, premium_collected = $5, synced_at = $6 WHERE id = $1`,
        [cur.id, g.shares, cost4(g.cost), JSON.stringify(g.legs), r2(collected), now]);
      out.updated.push(symbol);
    } else {
      const collected = told ? Number(given) : newOptionCash([], g.legs);
      await pool.query(`INSERT INTO options_positions (symbol, shares, cost, opened_on, legs, premium_collected, status, source, synced_at, notes)
        VALUES ($1, $2, $3, $4, $5, $6, 'open', 'broker', $7, $8)`,
        [symbol, g.shares, cost4(g.cost), today, JSON.stringify(g.legs), r2(collected), now, snap.account ? `From ${snap.account}` : null]);
      out.added.push(symbol);
    }
  }
  for (const r of open.filter((x) => !snap.groups.has(x.symbol))) {
    const price = await Promise.resolve().then(() => priceOf(r.symbol)).catch(() => null);
    await pool.query(`UPDATE options_positions SET status = 'closed', closed_on = $2, closed_price = $3, legs = '[]', synced_at = $4 WHERE id = $1`, [r.id, today, price, now]);
    out.closed.push(r.symbol);
  }
  const info = { at: now.toISOString(), as_of: today, account: snap.account, by, holdings: snap.groups.size, ...out };
  await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [SYNC_KEY, JSON.stringify(info)]);
  return info;
}
export async function lastSync() { return getSetting(SYNC_KEY, null); }
