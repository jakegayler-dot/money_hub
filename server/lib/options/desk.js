// The options desk (Jake, Nov 17; rebuilt Nov 20 for put spreads, live greeks and alerts): his rules, his positions valued
// live, the stocks he watches, what his rules pick on one, and the watcher that notes what he'd want to know. Money Hub only
// reads the market and keeps his records; it never places a trade.
//
// Prices (market.js): stocks live from Yahoo's chart feed; options from MarketData.app on his token, which bills each option
// price. His Free plan is 100 a day, a day old. So: a leg he holds is read by itself; a stock's plan is about PLAN_COST prices
// (the few calls and puts his rules could pick) and is kept (in settings too, so a restart doesn't pay twice); a day-old
// option price is brought to now by model (strategy.nowFrom) and marked. On a paid plan the watcher prices his list itself.
import { pool, getSetting } from '../../db.js';
import { quote, day, days, history, parseOcc, optionQuotes, optionSlice, expirations, strikeList, chainOf, room, creditLimit, planOf, optionsStatus, hasToken, tryToken, forgetToken } from './market.js';
import { cleanRules, dropCheck, soonExpiries, pick, evaluate, daysTo, expiryCadence, legDays, nowFrom, spreadChoices, incomeDays } from './strategy.js';
import { moveAlerts, swingAlerts, positionAlerts, ivAlerts } from './alerts.js';
import { toISODate } from '../dates.js';
import { usdCad } from './fx.js';
import { nextEarnings, inside } from './earnings.js';

const RULES_KEY = 'covered_call_rules';
const ALERTS_KEY = 'covered_call_alerts';
const PRICED_KEY = 'covered_call_priced';
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const put = (key, value) => pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, JSON.stringify(value)]);
const nyDay = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

export async function getRules() { return cleanRules(await getSetting(RULES_KEY, {})); }
export async function saveRules(input) {
  const rules = cleanRules({ ...(await getRules()), ...input });
  await put(RULES_KEY, rules);
  return rules;
}

async function inTurn(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => ({ error: e.message })); }
  }));
  return out;
}

// ---------- where the prices come from ----------
/** About what pricing one stock's plan takes: three calls an expiry in his call days, one put an expiry in his put window, the spread's sold put, the expiry list. */
export const PLAN_COST = 16;
export async function dataStatus() { return { ...(await optionsStatus()), plan_cost: PLAN_COST }; }
/** Keep his MarketData.app token after one real request with it (never sent back to the page); '' forgets it. */
export async function saveToken(tk) {
  const t = String(tk || '').trim();
  if (!t) { await put('market_data', {}); forgetToken(); return dataStatus(); }
  if (!/^[A-Za-z0-9_.\-]{16,300}$/.test(t)) throw Object.assign(new Error('That doesn’t look like a MarketData.app token: copy the whole token from your MarketData.app dashboard.'), { status: 422 });
  await tryToken(t);
  await put('market_data', { token: t, saved_at: new Date().toISOString() });
  forgetToken();
  return dataStatus();
}

// ---------- a stock's options, priced ----------
// symbol → { at (ms), key, rows (as quoted), expiries, price_then }. In settings too (PRICED_KEY).
const priced = new Map();
let pricedLoaded = false;
async function loadPriced() {
  if (pricedLoaded) return;
  pricedLoaded = true;
  const kept = await getSetting(PRICED_KEY, {}).catch(() => ({}));
  for (const [s, c] of Object.entries(kept || {})) if (c?.rows?.length && !priced.has(s)) priced.set(s, c);
}
const savePriced = () => {
  const recent = [...priced.entries()].filter(([, c]) => Date.now() - c.at < 3 * 86400e3).sort((a, b) => b[1].at - a[1].at).slice(0, 80);
  return put(PRICED_KEY, Object.fromEntries(recent)).catch((e) => console.error(`  !! Options desk, keeping the priced plans: ${e.message}`));
};
export const _priced = priced; // tests
const ruleKey = (r, floor) => [r.call_otm, r.call_max_days, r.put_otm, r.put_days_min, r.put_days_max, r.spread_width, floor || ''].join('|');
const strikeNum = (n) => Math.max(0.5, Math.round(n * 100) / 100);

/** Ask MarketData.app for the options his rules could pick on a stock at this price (see PLAN_COST). */
async function priceStock(symbol, rules, price, floor, now, purpose = 'plans') {
  const today = nyDay(now);
  const pad = Math.max(6, price * 0.04);
  const lo = price + rules.call_otm;
  const window = { side: 'call', from: today, to: addDays(today, rules.call_max_days) };
  const rows = [];
  rows.push(...await optionSlice(symbol, { ...window, strike: `${strikeNum(lo)}-${strikeNum(lo + pad)}`, strikeLimit: 3 }, { purpose }));
  // With a put held, his call can be any strike at or above it (Nov 19): those too.
  if (floor && floor < lo) rows.push(...await optionSlice(symbol, { ...window, strike: `${strikeNum(floor)}-${strikeNum(lo)}`, strikeLimit: 4 }, { purpose }));
  const top = price - rules.put_otm;
  const puts = await optionSlice(symbol, { side: 'put', dte: `${rules.put_days_min}-${rules.put_days_max}`, strike: `${strikeNum(top - Math.max(10, price * 0.08))}-${strikeNum(top)}`, strikeLimit: 1 }, { purpose });
  rows.push(...puts);
  // The put spread's sold strike (Nov 20), under the put his rule would pick: the cheapest a trading day.
  // (the same choice strategy.pick makes: the least a trading day, each put brought to today's stock price first)
  const cheapest = puts.map((p) => nowFrom(p, price, now)).filter((p) => p.ask > 0 && p.strike <= top + 1e-9).map((p) => ({ p, per: p.ask / incomeDays(p.expiry, now) })).sort((a, b) => a.per - b.per)[0]?.p;
  if (cheapest) {
    const under = cheapest.strike - rules.spread_width;
    rows.push(...await optionSlice(symbol, { side: 'put', expiration: cheapest.expiry, strike: `${strikeNum(under - Math.max(8, price * 0.06))}-${strikeNum(under)}`, strikeLimit: 1 }, { purpose }).catch(() => []));
  }
  const expiries = await expirations(symbol, { purpose }).catch(() => []);
  const seen = new Set();
  const c = { at: Date.now(), key: ruleKey(rules, floor), rows: rows.filter((r) => !seen.has(r.occ) && seen.add(r.occ)), expiries, price_then: price };
  priced.set(symbol, c);
  savePriced();
  return c;
}

/** How old the option prices behind a figure are, and whether they were brought to now by model. */
function pricesNote(contracts, at = null) {
  const times = contracts.map((c) => c.quoted?.as_of || c.as_of).filter(Boolean).sort();
  return { quoted_at: times[0] || null, read_at: at ? new Date(at).toISOString() : null, modelled: contracts.some((c) => c.modelled), delay: planOf(creditLimit()).delay };
}

/** What his rules pick from a priced stock at today's price (no request): the plan, and the same lot with a put spread. */
function pickFrom(symbol, q, c, rules, { now, fx, floor }) {
  const contracts = c.rows.map((r) => nowFrom(r, q.price, now));
  const ch = chainOf(symbol, q, contracts);
  ch.expiries = [...new Set([...(c.expiries || []), ...ch.expiries])].sort();
  const p = pick(ch, rules, { now, fx: fx?.rate, putStrike: floor });
  let spread = null;
  if (p.put) {
    const row = spreadChoices(contracts.filter((x) => x.type === 'put' && x.expiry === p.put.expiry), { price: q.price, kind: 'insurance', width: rules.spread_width, otm: rules.put_otm, expiry: p.put.expiry, now })
      .find((s) => s.high_strike === p.put.strike);
    if (row) {
      const low = contracts.find((x) => x.type === 'put' && x.expiry === p.put.expiry && x.strike === row.low_strike);
      const legs = [
        p.call && { type: 'call', side: 'short', strike: p.call.strike, expiry: p.call.expiry, premium: p.call.bid, contracts: 1, iv: p.call.iv, delta: p.call.delta },
        { type: 'put', side: 'long', strike: p.put.strike, expiry: p.put.expiry, premium: p.put.ask, contracts: 1, iv: p.put.iv, delta: p.put.delta },
        { type: 'put', side: 'short', strike: row.low_strike, expiry: p.put.expiry, premium: row.sell.bid, contracts: 1, iv: low?.iv, delta: low?.delta },
      ].filter(Boolean);
      const lot = evaluate({ price: q.price, shares: 100, cost: q.price, legs }, { now, margin: { pct: rules.margin_pct, rate: rules.margin_rate } });
      spread = { ...row, legs, lot: { net_per_day: lot.net_after_interest_per_day, protection_per_day: lot.protection_per_day, max_loss: lot.max_loss, loss_at_zero: lot.loss_at_zero,
        loss_at_protection_end: lot.loss_at_protection_end, protection_ends: lot.protection_ends, capital_needed: lot.capital_needed, breakevens: lot.breakevens },
        single_put: { cost: r2(p.put.ask * 100), per_day: p.put.cost_per_day, max_loss: p.lot.max_loss, net_per_day: p.lot.net_after_interest_per_day } };
    }
  }
  const cadence = expiryCadence(ch.expiries, now);
  return { ...p, put_spread: spread, as_of: ch.as_of, expiries: ch.expiries, cadence, often: !!cadence && cadence.max <= rules.expiry_every_days,
    priced_at: new Date(c.at).toISOString(), option_prices: pricesNote(contracts, c.at) };
}

/** What his rules pick on one stock today: the call, the put, the lots, the put spread, with the figures for one lot. */
// onlyCached: answer from what was priced before (however old, at today's stock price) or say it needs pricing; never spends.
// force: price it again now.
export async function plan(symbol, overrides = {}, now = new Date(), { force = false, onlyCached = false } = {}) {
  await loadPriced();
  const rules = cleanRules({ ...(await getRules()), ...overrides });
  const [d, hist, fx, held] = await Promise.all([day(symbol), history(symbol, rules.high_days + 10).catch(() => []), usdCad(), heldPutStrike(symbol, now)]);
  const q = d.quote;
  const base = { symbol, quote: q, bars: d.bars, drop: dropCheck(hist, q, rules), fx, plan_cost: PLAN_COST };
  let c = priced.get(symbol);
  const same = c && c.key === ruleKey(rules, held);
  const fresh = same && Date.now() - c.at < planOf(creditLimit()).keep_ms;
  if (onlyCached && !same) return { ...base, rules, price: q.price, needs_pricing: true, data: await dataStatus() };
  if (!onlyCached && (force || !fresh)) c = await priceStock(symbol, rules, q.price, held, now);
  let p = pickFrom(symbol, q, c, rules, { now, fx, floor: held });
  // Priced before the stock moved off those strikes: once more, when there's room for it.
  if (!p.call && !onlyCached && !force && Math.abs(q.price - c.price_then) / c.price_then > 0.01 && Date.now() - c.at > 60e3 && room(PLAN_COST, 10)) {
    c = await priceStock(symbol, rules, q.price, held, now);
    p = pickFrom(symbol, q, c, rules, { now, fx, floor: held });
  }
  return { ...base, ...p, fx };
}

/** The highest strike of the puts he holds on a stock (open, not expired), or null: his calls go at or above it (Nov 19). */
async function heldPutStrike(symbol, now = new Date()) {
  const { rows } = await pool.query(`SELECT legs FROM options_positions WHERE symbol = $1 AND status = 'open'`, [symbol]).catch(() => ({ rows: [] }));
  const strikes = rows.flatMap((r) => r.legs || []).filter((l) => l.type === 'put' && l.side === 'long' && daysTo(l.expiry, now) > 0).map((l) => Number(l.strike));
  return strikes.length ? Math.max(...strikes) : null;
}

/** The calculator's pickers: the stock's expiries and one expiry's strikes near the price. No prices (each would be billed):
 *  a strike's price comes when it's chosen (legPrice). */
export async function strikes(symbol, expiry, now = new Date()) {
  const [d, exps] = await Promise.all([day(symbol), expirations(symbol).catch(() => [])]);
  const open = exps.filter((e) => daysTo(e, now) > 0);
  const exp = expiry && open.includes(expiry) ? expiry : open[0] || null;
  const list = exp ? (await strikeList(symbol, exp).catch(() => [])).filter((k) => Math.abs(k - d.quote.price) / d.quote.price <= 0.35) : [];
  const blank = (type) => list.map((strike) => ({ strike, type, expiry: exp, bid: null, ask: null, delta: null, iv: null }));
  return { symbol, quote: d.quote, expiries: open, expiry: exp, calls: blank('call'), puts: blank('put'), priced: false };
}
/** One option's price now (one price billed; kept): as quoted, and brought to today's stock price. */
export async function legPrice(symbol, leg, now = new Date()) {
  const type = leg.type === 'put' ? 'put' : 'call';
  const strike = Number(leg.strike); const expiry = String(leg.expiry || '').slice(0, 10);
  if (!(strike > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw Object.assign(new Error('Which strike and expiry?'), { status: 422 });
  const [d, rows] = await Promise.all([day(symbol), optionQuotes(symbol, [{ type, strike, expiry }], { purpose: 'the calculator' })]);
  if (!rows.length) throw Object.assign(new Error(`MarketData.app has no price for the ${symbol} ${strike} ${type} of ${expiry}.`), { status: 404 });
  return { ...nowFrom(rows[0], d.quote.price, now), price: d.quote.price };
}

/** Put spreads on one stock (Nov 20): one expiry's puts under the price, paired `width` apart; kind insurance or income. */
export async function spreads(symbol, { kind = 'insurance', expiry = null, width = null, otm = null } = {}, now = new Date()) {
  const rules = await getRules();
  const [d, exps] = await Promise.all([day(symbol), expirations(symbol, { purpose: 'put spreads' }).catch(() => [])]);
  const price = d.quote.price;
  const open = exps.filter((e) => daysTo(e, now) > 0);
  const inWindow = open.filter((e) => daysTo(e, now) >= rules.put_days_min && daysTo(e, now) <= rules.put_days_max + 1);
  const exp = expiry && open.includes(expiry) ? expiry : (kind === 'income' ? open.find((e) => daysTo(e, now) >= 5) : inWindow.at(-1)) || open[0];
  if (!exp) throw Object.assign(new Error(`No expiry dates for ${symbol}.`), { status: 404 });
  const w = Number(width) > 0 ? Number(width) : rules.spread_width;
  const below = Number.isFinite(Number(otm)) && otm !== null && otm !== '' ? Math.max(0, Number(otm)) : rules.put_otm;
  const top = price - below;
  // Two bands of strikes, six prices each: the higher strikes from his distance under the price, and the ones his width
  // below them (one band wide enough for both would spend the dozen on the strikes in between).
  const band = Math.max(5, price * 0.04);
  const upper = await optionSlice(symbol, { side: 'put', expiration: exp, strike: `${strikeNum(top - band)}-${strikeNum(top)}`, strikeLimit: 6 }, { purpose: 'put spreads' });
  const lower = await optionSlice(symbol, { side: 'put', expiration: exp, strike: `${strikeNum(top - w - band)}-${strikeNum(top - w)}`, strikeLimit: 6 }, { purpose: 'put spreads' });
  const had = new Set();
  const rows = [...upper, ...lower].filter((r) => !had.has(r.occ) && had.add(r.occ));
  const contracts = rows.map((r) => nowFrom(r, price, now));
  return { symbol, quote: d.quote, kind: kind === 'income' ? 'income' : 'insurance', expiry: exp, expiries: open.map((e) => ({ date: e, days: Math.round(daysTo(e, now)) })).filter((e) => e.days <= 400),
    width: w, otm: below, rows: spreadChoices(contracts, { price, kind, width: w, otm: below, expiry: exp, now }), prices_read: rows.length, option_prices: pricesNote(contracts, Date.now()) };
}

// ---------- the stocks he watches ----------
// The wider list (Nov 17, his pick: "the stock watcher needs to look for stocks that have 3 day options or less"): large US
// stocks and ETFs. Their prices and moves are read with his watchlist; their options are priced when he taps one, or by the
// watcher on a paid MarketData.app plan.
export const WIDE = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'PLTR', 'COIN', 'MSTR', 'ORCL',
  'CRM', 'ADBE', 'INTC', 'MU', 'QCOM', 'SMCI', 'ARM', 'UBER', 'SHOP', 'JPM', 'BAC', 'WFC', 'GS', 'C', 'XOM', 'CVX', 'BA', 'DIS',
  'WMT', 'COST', 'HD', 'UNH', 'LLY', 'JNJ', 'PFE', 'MRK', 'KO', 'PEP', 'NKE', 'HOOD', 'SOFI', 'RIVN', 'BABA', 'PYPL', 'SPY', 'QQQ', 'IWM'];
// Daily closes for the drop rule's recent high: the watchlist's are read with the page; the wider list's one at a time behind it.
const closes = new Map(); // symbol → { at, hist }
const closesOf = (s) => { const h = closes.get(s); return h && Date.now() - h.at < 6 * 3600e3 ? h.hist : null; };
async function readCloses(symbol, n) { const hist = await history(symbol, n); closes.set(symbol, { at: Date.now(), hist }); return hist; }
const wideState = { running: null };
function fillCloses(symbols, n) {
  if (wideState.running) return;
  const need = symbols.filter((s) => !closesOf(s));
  if (!need.length) return;
  wideState.running = (async () => { for (const s of need) { await readCloses(s, n).catch(() => {}); await new Promise((r) => setTimeout(r, 400)); } })().finally(() => { wideState.running = null; });
}

/** One stock's row: today's move and bars, his drop rule, and, when its options have been priced, what his rules make of them. */
function stockRow(symbol, d, hist, rules, fx, now, watched, floor) {
  const q = d.quote;
  const c = priced.get(symbol);
  const p = c && c.key === ruleKey(rules, floor) ? pickFrom(symbol, q, c, rules, { now, fx, floor }) : null;
  const carry = p?.carry || null;
  const soon = p ? soonExpiries(p.expiries, 7, now) : [];
  return { symbol, watched, price: r2(q.price), change: q.change, as_of: q.as_of, spark: d.bars.map((b) => b.price), prev_close: q.prev_close,
    ...dropCheck(hist || [], q, rules), from_high_known: !!hist,
    priced: !!p, priced_at: p?.priced_at || null, option_prices: p?.option_prices || null,
    expiries_this_week: soon, cadence: p?.cadence || null, often: p ? p.often : null, next_expiry: p ? soon[0] || p.expiries.find((e) => daysTo(e, now) > 0) || null : null,
    carry, day_play: p?.day_play || null, put_spread: p?.put_spread ? { high_strike: p.put_spread.high_strike, low_strike: p.put_spread.low_strike, expiry: p.put_spread.expiry, per_day: p.put_spread.per_day, cost: p.put_spread.cost } : null,
    qualifies: p ? !!(p.often && carry && carry.gap != null && carry.gap > 0 && carry.gap * (fx?.rate || 1) >= rules.min_carry) : null };
}

/** His watchlist and the wider list: every stock's move now; the options figures for the ones priced. */
export async function scan(rulesIn = null, now = new Date()) {
  await loadPriced();
  const rules = rulesIn || await getRules();
  const fx = await usdCad();
  const watch = new Set(rules.watchlist);
  const wideList = rules.wide ? WIDE.filter((s) => !watch.has(s)) : [];
  const dmap = await days([...rules.watchlist, ...wideList]);
  const { rows: heldRows } = await pool.query(`SELECT symbol, legs FROM options_positions WHERE status = 'open'`).catch(() => ({ rows: [] }));
  const floorOf = (s) => { const ks = heldRows.filter((r) => r.symbol === s).flatMap((r) => r.legs || []).filter((l) => l.type === 'put' && l.side === 'long' && daysTo(l.expiry, now) > 0).map((l) => Number(l.strike)); return ks.length ? Math.max(...ks) : null; };
  await inTurn(rules.watchlist.filter((s) => dmap.has(s) && !closesOf(s)), 3, (s) => readCloses(s, rules.high_days + 10));
  fillCloses(wideList.filter((s) => dmap.has(s)), rules.high_days + 10);
  const row = (s, watched) => (dmap.has(s) ? stockRow(s, dmap.get(s), closesOf(s), rules, fx, now, watched, floorOf(s)) : { symbol: s, watched, error: 'No price on the stock feed.' });
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
  const all = rules.watchlist.map((s) => withEarnings(row(s, true)));
  const wide = wideList.map((s) => withEarnings(row(s, false))).filter((r) => !r.error);
  const ahead = [...all, ...wide].filter((r) => !r.error && r.day_play && r.day_play.net_per_day > 0);
  const reportsFirst = (r) => inside(r.earnings, r.day_play.call.expiry);
  const everything = [...all, ...wide].filter((r) => !r.error);
  return {
    rules, as_of: now.toISOString(), fx, data: await dataStatus(),
    stocks: all,
    earnings: { through: cal.through || null, days_read: cal.days_read || 0, running: !!cal.running, error: cal.error || null },
    wide,
    priced_count: everything.filter((r) => r.priced).length, stock_count: everything.length,
    // The day's five (Nov 19): every stock priced, by what its call expiring today or the next trading day pays a trading
    // day less its long-horizon put and the margin interest, for one lot; only ones that come out ahead. A stock reporting
    // before its call expires is left out (its premium is the market pricing the report), and said.
    today_five: ahead.filter((r) => !reportsFirst(r))
      .sort((a, b) => b.day_play.net_per_day - a.day_play.net_per_day).slice(0, 5)
      .map((r) => ({ symbol: r.symbol, watched: !!r.watched, day_pct: r.day_pct ?? null, earnings: r.earnings, option_prices: r.option_prices, ...r.day_play })),
    left_out_earnings: ahead.filter(reportsFirst).sort((a, b) => b.day_play.net_per_day - a.day_play.net_per_day)
      .map((r) => ({ symbol: r.symbol, earnings: r.earnings, call: r.day_play.call, net_per_day: r.day_play.net_per_day })),
    call_otm: rules.call_otm, put_otm: rules.put_otm,
    movers: [...everything].filter((r) => r.day_pct != null).sort((a, b) => Math.abs(b.day_pct) - Math.abs(a.day_pct)).slice(0, 8).map((r) => ({ symbol: r.symbol, price: r.price, day_pct: r.day_pct, watched: r.watched })),
    wide_running: !!wideState.running,
  };
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
/** What the watcher has noted, newest first. An older drop (before Nov 20) had no id, kind or words: given here. */
export async function alerts() {
  const a = await getSetting(ALERTS_KEY, []);
  return (Array.isArray(a) ? a : []).map((x) => (x.id ? x : { ...x, id: `${x.symbol}:${x.date}`, kind: 'drop', level: 'high', title: `${x.symbol} dropped by your rule`, text: null }));
}
export async function alertsSeen() { await put('covered_call_alerts_seen', { at: new Date().toISOString() }); return { ok: true }; }
/** The page's feed: the notes, and which came since he last looked. */
export async function alertFeed() {
  const [list, seen] = await Promise.all([alerts(), getSetting('covered_call_alerts_seen', null)]);
  const since = seen?.at || null;
  return { alerts: list.slice(0, 120), seen_at: since, unseen: list.filter((a) => !since || a.at > since).length };
}

// On a small plan (the Free one: 100 option prices a day) the watcher prices at most two dropped stocks a day by itself, and
// only while 45 prices are left for his own positions and what he asks for: on Nov 20 ten of his stocks dropped at once.
const autoPriced = { day: null, n: 0 };
const mayAutoPrice = (date) => {
  if (creditLimit() >= 1000) return room(PLAN_COST, creditLimit() * 0.15);
  if (autoPriced.day !== date) { autoPriced.day = date; autoPriced.n = 0; }
  return autoPriced.n < 2 && room(PLAN_COST, 45);
};
/** A drop by his rule, with what his rules pick on it when its options can be priced. */
async function dropAlert(st, rules, now, date) {
  let picked = null; let note = null;
  if (await hasToken() && (st.priced || mayAutoPrice(date))) {
    if (!st.priced) autoPriced.n += 1;
    try {
      const p = await plan(st.symbol, {}, now);
      // His rule (Nov 17): a drop counts on a stock whose options expire often enough and whose call pays more than the put costs.
      const gap = p.carry?.gap;
      if (!(p.often && gap != null && gap > 0 && gap * (p.usd_cad || 1) >= rules.min_carry)) return null;
      picked = {
        call: p.call && { strike: p.call.strike, expiry: p.call.expiry, bid: p.call.bid, delta: r2(p.call.delta) },
        put: p.put && { strike: p.put.strike, expiry: p.put.expiry, ask: p.put.ask },
        spread: p.put_spread && { buy: p.put_spread.high_strike, sell: p.put_spread.low_strike, debit: p.put_spread.debit },
        lots: p.sizing.lots, income_per_day: p.lot.income_per_day, net_per_day: p.lot.net_per_day, max_loss_per_lot: p.lot.max_loss,
        gap_per_day: gap, interest_per_day: p.lot.interest_per_day, capital_per_lot: p.lot.capital_needed,
        usd_cad: p.usd_cad, modelled: !!p.option_prices?.modelled,
      };
    } catch (e) { note = e.message; }
  } else note = (await hasToken()) ? 'Its options aren’t priced yet: tap it on the Covered calls page to see what your rules pick.' : 'Its options aren’t priced: MarketData.app needs your token.';
  // A drop his rules could be worked through on goes to his phone; one whose options weren't priced stays on the page (his
  // rule counts a drop only where the options expire often enough and the call beats the put, which isn't known without them).
  return { id: `${st.symbol}:${date}`, kind: 'drop', level: picked ? 'high' : 'info', symbol: st.symbol, title: `${st.symbol} dropped by your rule`, text: null,
    price: st.price, day_pct: st.day_pct, from_high_pct: st.from_high_pct, why: st.why, expiries_this_week: st.expiries_this_week?.length || 0, picked, note };
}

/** On a paid MarketData.app plan (10,000 prices a day or more) the watcher prices his list itself, a few stocks a round. */
async function autoPrice(rules, now) {
  const limit = creditLimit();
  if (!(limit >= 10000) || !(await hasToken())) return 0;
  const keepMs = Math.max(planOf(limit).keep_ms, limit >= 100000 ? 10 * 60e3 : 60 * 60e3);
  const due = [...rules.watchlist, ...(rules.wide ? WIDE : [])].filter((s, i, a) => a.indexOf(s) === i).filter((s) => { const c = priced.get(s); return !c || Date.now() - c.at > keepMs; });
  let n = 0;
  for (const s of due.slice(0, 12)) {
    if (!room(PLAN_COST, limit * 0.15)) break;
    try { await plan(s, {}, now, { force: true }); n += 1; } catch { /* next round */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return n;
}

/**
 * The watcher's round (every five minutes in US market hours): his positions and the stocks he watches against his alert
 * levels (lib/options/alerts.js) and his drop rule; each new note is kept once (by its id) and returned.
 */
export async function tick(now = new Date(), { force = false } = {}) {
  if (!force && !marketOpen(now)) return [];
  const rules = await getRules();
  const date = nyDay(now);
  const fx = (await usdCad().catch(() => null))?.rate || null;
  const list = await alerts();
  const have = new Set(list.map((a) => a.id));
  const fresh = [];
  const note = (a) => { if (a && !have.has(a.id)) { have.add(a.id); fresh.push({ ...a, date, at: now.toISOString() }); } };

  const open = (await positions(now).catch((e) => { console.error(`  !! Options desk, positions: ${e.message}`); return []; })).filter((p) => p.status === 'open');
  const held = new Set(open.map((p) => p.symbol));
  let ivSeen = await getSetting('covered_call_iv', {}).catch(() => ({}));
  let ivChanged = false;
  for (const p of open) {
    if (!(p.price > 0)) continue;
    positionAlerts(p, rules, { date, fx }).forEach(note);
    moveAlerts({ symbol: p.symbol, price: p.price, day_pct: p.day?.change_pct, change: p.day?.change }, rules, { date, held: { shares: p.shares, delta: p.greeks?.delta ?? null }, fx }).forEach(note);
    swingAlerts(p.symbol, p.bars, rules, { date, now }).forEach(note);
    if (p.option_prices?.quoted_at) {
      const iv = ivAlerts(p.symbol, p.greeks?.legs, ivSeen, rules, { date });
      iv.alerts.forEach(note);
      if (JSON.stringify(iv.seen) !== JSON.stringify(ivSeen)) { ivSeen = iv.seen; ivChanged = true; }
    }
  }
  if (ivChanged) await put('covered_call_iv', Object.fromEntries(Object.entries(ivSeen).slice(-200)));

  if (rules.watchlist.length || rules.wide) {
    await autoPrice(rules, now).catch(() => 0);
    const s = await scan(rules, now);
    for (const st of s.stocks) {
      if (st.error) continue;
      const dropOn = st.triggered && !(rules.alerts_off || []).includes('drop');
      if (dropOn && !have.has(`${st.symbol}:${date}`)) note(await dropAlert(st, rules, now, date));
      // A stock that dropped by his rule has its note already: the day's move isn't said again.
      if (!held.has(st.symbol) && !(dropOn && have.has(`${st.symbol}:${date}`))) moveAlerts(st, rules, { date, fx }).forEach(note);
    }
    // The wider list: a drop counts when its options are already priced and it qualifies by his rule.
    for (const st of s.wide) if (st.triggered && st.qualifies && !(rules.alerts_off || []).includes('drop') && !have.has(`${st.symbol}:${date}`)) note(await dropAlert(st, rules, now, date));
  }
  if (fresh.length) await put(ALERTS_KEY, [...fresh.reverse(), ...list].slice(0, 250));
  return fresh;
}
export const watch = tick; // the name it had (index.js)

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

const sameLeg = (a, b) => a.type === b.type && Number(a.strike) === Number(b.strike) && a.expiry === b.expiry;
/**
 * His positions, each valued at the price now: the stock's gain or loss and today's move, the options he holds at what
 * they're worth now (quoted by MarketData.app, brought to today's stock price), the greeks, put spreads and what's worth
 * knowing right now (signals), with the figures for the legs it holds.
 */
export async function positions(now = new Date()) {
  const { rows } = await pool.query(`SELECT * FROM options_positions ORDER BY (status = 'closed'), opened_on DESC, id DESC`);
  // His fills (Nov 19): the options he holds at what his Money Hub entries say they cost, not the broker's lumped average.
  const { optionCash, legsAtFills, bankedCalls } = await import('./cash.js');
  const cash = await optionCash({ symbols: rows.map((r) => r.symbol) }).catch(() => null);
  const fxNow = (await usdCad().catch(() => null))?.rate || null;
  const fxRate = cash?.currency === 'CAD' ? fxNow : null;
  const entries = (cash?.entries || []).filter((e) => e.kind && e.symbol)
    .map((e) => ({ ...e, usd: cash.currency === 'CAD' && fxRate ? e.amount / fxRate : e.amount }));
  const todayNy = nyDay(now);
  const rules = await getRules();
  const margin = { pct: rules.margin_pct, rate: rules.margin_rate }; // his margin rule, on what each position cost
  const live = rows.filter((r) => r.status !== 'closed');
  const dmap = await days([...new Set(live.map((r) => r.symbol))]).catch(() => new Map());
  const tokened = await hasToken();
  const cal = await nextEarnings({ now }).catch(() => ({ map: new Map() }));
  // The options he holds, priced: one price a leg, kept (market.js).
  const quotes = new Map(); const quoteErr = new Map();
  if (tokened) {
    await inTurn([...new Set(live.map((r) => r.symbol))], 2, async (s) => {
      const legs = live.filter((r) => r.symbol === s).flatMap((r) => r.legs || []).filter((l) => daysTo(l.expiry, now) > 0);
      if (!legs.length) return;
      try { quotes.set(s, await optionQuotes(s, legs)); } catch (e) { quoteErr.set(s, e.message); }
    });
  }
  return rows.map((r) => {
    const cost = Number(r.cost); const shares = Number(r.shares);
    const d = r.status === 'closed' ? null : dmap.get(r.symbol) || null;
    const price = r.status === 'closed' ? Number(r.closed_price) || null : d?.quote.price ?? null;
    // An option without the day it was opened is taken from the day the position was (Nov 18): spread over the days left, a
    // premium grew to the whole of it on its last day.
    const opened = toISODate(r.opened_on);
    const rawLegs = (r.legs || []).filter((l) => r.status === 'closed' || daysTo(l.expiry, now) > -1);
    const qs = (quotes.get(r.symbol) || []).map((q) => (price ? nowFrom(q, price, now) : q));
    const legs = (r.status === 'closed' ? rawLegs : legsAtFills(rawLegs.filter((l) => daysTo(l.expiry, now) > 0), entries, r.symbol, { today: todayNy }))
      .map((l) => (l.since || !opened || opened > l.expiry || opened > todayNy ? l : { ...l, since: opened }))
      .map((l) => { const q = qs.find((x) => sameLeg(x, l)); return q ? { ...l, iv: q.iv || l.iv, now: q.mid, bid_now: q.bid, ask_now: q.ask, quoted: q.quoted, modelled: q.modelled } : l; });
    // Everything the calls have brought in counts, not only the open call's own sale (Nov 19).
    const banked = r.status === 'closed' ? null : bankedCalls(legs, entries, r.symbol, { today: todayNy });
    const figures = price ? evaluate({ price, shares, cost, legs, banked }, { now, margin: r.status === 'closed' ? null : margin }) : null;
    const stockPnl = price ? r2((price - cost) * shares) : null;
    const openLegs = r.status === 'closed' ? [] : legs.filter((l) => daysTo(l.expiry, now) > 0);
    const base = {
      id: r.id, symbol: r.symbol, shares, cost, status: r.status, source: r.source || 'manual', synced_at: r.synced_at || null, opened_on: toISODate(r.opened_on), closed_on: toISODate(r.closed_on), notes: r.notes,
      legs: r.legs || [], premium_collected: Number(r.premium_collected), price: price == null ? null : r2(price),
      open_legs: openLegs.map((l) => ({ ...l, days: legDays(l, now), per_day: r2((Number(l.premium) * Number(l.contracts) * 100) / legDays(l, now)), ...(l.since && !(r.legs || []).find((o) => o.strike === l.strike && o.expiry === l.expiry && o.type === l.type)?.since ? { since_from_position: true } : {}) })),
      stock_pnl: stockPnl, total_pnl: stockPnl == null ? null : r2(stockPnl + Number(r.premium_collected)),
      days_held: Math.max(1, Math.round((now - new Date(`${toISODate(r.opened_on)}T12:00:00Z`)) / 86400e3)),
      figures: figures && { banked: figures.banked, premium_in: figures.premium_in, put_cost: figures.put_cost, max_gain: figures.max_gain, max_gain_at: figures.max_gain_at, max_loss: figures.max_loss, max_loss_at: figures.max_loss_at,
        unlimited_gain: figures.unlimited_gain, uncovered: figures.uncovered, breakevens: figures.breakevens, horizon: figures.horizon, risk_horizon: figures.risk_horizon, income_per_day: figures.income_per_day,
        protection_per_day: figures.protection_per_day, net_per_day: figures.net_per_day, per_day_by_role: figures.per_day_by_role,
        interest_per_day: figures.interest_per_day, net_after_interest_per_day: figures.net_after_interest_per_day, capital_needed: figures.capital_needed,
        revenue_per_day: figures.revenue_per_day, on_capital_pct_day: figures.on_capital_pct_day, on_capital_pct_year: figures.on_capital_pct_year,
        vs_max_loss_pct_day: figures.vs_max_loss_pct_day, days_to_earn_max_loss: figures.days_to_earn_max_loss,
        put_spreads: figures.put_spreads, plain_puts: figures.plain_puts, sold_puts: figures.sold_puts, protection_ends: figures.protection_ends,
        loss_at_protection_end: figures.loss_at_protection_end, falls_to_zero: figures.falls_to_zero, loss_at_zero: figures.loss_at_zero,
        put_strike: figures.put_strike, loss_at_put: figures.loss_at_put, call_strike: figures.call_strike, floor_from: figures.floor_from, pnl_now: figures.pnl_now, curve: figures.curve },
    };
    if (r.status !== 'open' || !price) return base;
    const p = { ...base, day: d ? { change: d.quote.change, change_pct: d.quote.change_pct, prev_close: d.quote.prev_close, high: d.quote.high, low: d.quote.low, as_of: d.quote.as_of } : null, bars: d?.bars || [],
      greeks: figures.greeks, earnings: cal.map.get(r.symbol) || null,
      option_prices: openLegs.length ? (qs.length ? pricesNote(qs) : { quoted_at: null, modelled: false, delay: null, error: quoteErr.get(r.symbol) || (tokened ? 'No option prices came back.' : 'No option prices: MarketData.app needs your token.') }) : null };
    // What's worth knowing right now, by his alert levels: the same notes the watcher raises, whether or not they've been said.
    p.signals = [...positionAlerts(p, rules, { date: todayNy, fx: fxNow }),
      ...moveAlerts({ symbol: p.symbol, price: p.price, day_pct: p.day?.change_pct, change: p.day?.change }, rules, { date: todayNy, held: { shares, delta: p.greeks?.delta ?? null }, fx: fxNow })]
      .map(({ id, kind, level, title, text }) => ({ id, kind, level, title, text }));
    return p;
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
