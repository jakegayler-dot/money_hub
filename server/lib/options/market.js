// Market data for the options desk. Two sources since Nov 20 (Cboe's free feed, the only source until then, has refused Money
// Hub's requests since Nov 19: its Cloudflare block):
//
//   STOCKS: Yahoo's free chart feed, the one Andrew's market board reads (no key; live in market hours): the price and the
//   day's move, the day's five-minute bars for the charts, the daily closes.
//
//   OPTIONS: MarketData.app (Jake, Nov 20: "add some integration from the market data site"), with his token (the page's
//   Data box, kept in settings market_data; or MARKETDATA_TOKEN). It bills a credit for every option price it returns, and
//   his Free plan allows 100 a day, 24 hours delayed. So nothing here reads a whole chain: a leg he holds is one price, a plan
//   is a dozen (the few calls and puts his rules could pick), and every answer is kept (hours on the Free plan, minutes on a
//   paid one). The plan is read from the reply's own headers (credits a day), never assumed.
//
// An option price that's hours old is brought to now by model (strategy.js nowFrom): its own implied volatility, today's
// stock price. Those figures are marked modelled; the quoted ones are kept beside them with their time.
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance';
const MD = 'https://api.marketdata.app/v1';
const UA = { 'user-agent': 'MoneyHub/1.0 (a private household finance app)', accept: 'application/json' };
export const SYMBOL = /^[A-Z]{1,6}$/;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cache = new Map(); // key → { at, data }
const hit = (key, ttl) => { const h = cache.get(key); return h && Date.now() - h.at < ttl ? h.data : undefined; };
const keep = (key, data) => { cache.set(key, { at: Date.now(), data }); return data; };
const nyDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));

// ---------- stocks: Yahoo ----------
const TTL = { quote: 60e3, history: 3 * 3600e3 };
let yahooCool = 0;
const SLOW = 'The stock price feed asked us to slow down; trying again in a minute.';
async function yahoo(path, ttl, fetchImpl = fetch) {
  const key = `y:${path}`;
  const got = hit(key, ttl);
  if (got !== undefined) return got;
  const old = cache.get(key)?.data;
  if (Date.now() < yahooCool) { if (old) return old; throw Object.assign(new Error(SLOW), { status: 503 }); }
  const res = await fetchImpl(`${YAHOO}/${path}`, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (res.status === 429) { yahooCool = Date.now() + 90e3; if (old) return old; throw Object.assign(new Error(SLOW), { status: 503 }); }
  if (res.status === 404) throw Object.assign(new Error('No stock by that symbol on the price feed.'), { status: 404 });
  if (!res.ok) { if (old) return old; throw Object.assign(new Error(`The stock price feed answered ${res.status}.`), { status: 502 }); }
  return keep(key, await res.json());
}

/** One chart result → { quote, bars }. Pure. bars: the day's five-minute closes, [{ t (ms), price }]. */
export function dayFrom(result, symbol) {
  const m = result?.meta || {};
  const ts = result?.timestamp || [];
  const q = result?.indicators?.quote?.[0] || {};
  const closes = q.close || result?.close || [];
  const bars = ts.map((t, i) => ({ t: t * 1000, price: closes[i] == null ? null : r2(closes[i]) })).filter((b) => b.price != null);
  const price = Number(m.regularMarketPrice ?? bars.at(-1)?.price);
  const prev = Number(m.chartPreviousClose ?? m.previousClose);
  const highs = (q.high || []).filter((x) => x != null); const lows = (q.low || []).filter((x) => x != null);
  const span = bars.map((b) => b.price);
  const at = m.regularMarketTime ? m.regularMarketTime * 1000 : bars.at(-1)?.t || null;
  const open = (q.open || []).find((x) => x != null);
  return {
    quote: {
      symbol, price: r2(price), prev_close: Number.isFinite(prev) && prev > 0 ? r2(prev) : null,
      change: Number.isFinite(prev) && prev > 0 ? r2(price - prev) : null, change_pct: Number.isFinite(prev) && prev > 0 ? r2(((price - prev) / prev) * 100) : null,
      open: open != null ? r2(open) : bars[0]?.price ?? null,
      high: r2(m.regularMarketDayHigh ?? (highs.length ? Math.max(...highs) : Math.max(price, ...span))),
      low: r2(m.regularMarketDayLow ?? (lows.length ? Math.min(...lows) : Math.min(price, ...span))),
      volume: m.regularMarketVolume ?? null, iv30: null, as_of: at ? new Date(at).toISOString() : null, source: 'yahoo',
    },
    bars,
  };
}

/** Today's price, move and five-minute bars for one stock. */
export async function day(symbol, opts = {}) {
  const j = await yahoo(`chart/${symbol}?range=1d&interval=5m`, opts.ttl || TTL.quote, opts.fetchImpl);
  const r = j?.chart?.result?.[0];
  if (!r?.meta || !(Number(r.meta.regularMarketPrice) > 0)) throw Object.assign(new Error(`No price for ${symbol} on the stock feed.`), { status: 404 });
  return dayFrom(r, symbol);
}
export async function quote(symbol, opts = {}) { return (await day(symbol, opts)).quote; }

/** Many stocks at once (the watch list): symbol → { quote, bars }; a symbol the feed doesn't know is left out. */
export async function days(symbols, opts = {}) {
  const out = new Map();
  const list = [...new Set(symbols)].filter((s) => SYMBOL.test(s));
  for (let i = 0; i < list.length; i += 15) {
    const part = list.slice(i, i + 15);
    try {
      const j = await yahoo(`spark?symbols=${part.join(',')}&range=1d&interval=5m`, opts.ttl || TTL.quote, opts.fetchImpl);
      for (const s of part) {
        const r = j?.[s];
        if (!r || !(r.close || []).some((x) => x != null)) continue;
        const last = [...r.close].reverse().find((x) => x != null);
        out.set(s, dayFrom({ meta: { regularMarketPrice: last, chartPreviousClose: r.chartPreviousClose ?? r.previousClose, regularMarketTime: r.timestamp?.at(-1) }, timestamp: r.timestamp, close: r.close }, s));
      }
    } catch {
      // The batch didn't come: one at a time, so a bad symbol doesn't cost the rest.
      for (const s of part) { try { out.set(s, await day(s, opts)); } catch { /* left out */ } }
    }
  }
  return out;
}

/** Daily closes, oldest first; the last `days` of them (today's bar, still forming, is last in market hours). */
export async function history(symbol, daysBack = 260, opts = {}) {
  const range = daysBack <= 20 ? '1mo' : daysBack <= 60 ? '3mo' : daysBack <= 125 ? '6mo' : daysBack <= 250 ? '1y' : '2y';
  const j = await yahoo(`chart/${symbol}?range=${range}&interval=1d`, TTL.history, opts.fetchImpl);
  const r = j?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0] || {};
  return (r?.timestamp || []).map((t, i) => ({ date: nyDate(t * 1000), close: Number(q.close?.[i]), high: Number(q.high?.[i]), low: Number(q.low?.[i]) }))
    .filter((x) => Number.isFinite(x.close) && x.close > 0).slice(-daysBack);
}

// ---------- options: MarketData.app ----------
const OCC = /^([A-Z0-9]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
/** An OCC option symbol → { root, expiry, type, strike }. */
export function parseOcc(s) {
  const m = OCC.exec(String(s || ''));
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === 'C' ? 'call' : 'put', strike: Number(m[6]) / 1000 };
}
/** { symbol, expiry, type, strike } → its OCC symbol (NVDA261120C00144000). */
export const occSymbol = (root, expiry, type, strike) =>
  `${root}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${type === 'put' ? 'P' : 'C'}${String(Math.round(Number(strike) * 1000)).padStart(8, '0')}`;

// What the token allows, as the service's own headers last said (X-Api-Ratelimit-*), and what was spent on what today.
const credits = { limit: null, remaining: null, reset: null, at: null, error: null, spent: {}, spent_day: null };
let tokenHeld; // undefined = not looked up yet
let tokenLoader = async () => {
  if (process.env.MARKETDATA_TOKEN) return process.env.MARKETDATA_TOKEN;
  try { const { getSetting } = await import('../../db.js'); return (await getSetting('market_data', {}))?.token || null; } catch { return null; }
};
export const _setTokenLoader = (fn) => { tokenLoader = fn; tokenHeld = undefined; }; // tests
export const forgetToken = () => { tokenHeld = undefined; credits.error = null; };
async function token() { if (tokenHeld === undefined) tokenHeld = (await tokenLoader()) || null; return tokenHeld; }
export const hasToken = async () => !!(await token());

/** The plan, by its credits a day: how old its option prices are and how long an answer is worth keeping. */
export function planOf(limit) {
  if (limit == null) return { name: null, delay: null, delay_minutes: null, keep_ms: 6 * 3600e3 };
  if (limit <= 100) return { name: 'Free', delay: '24 hours', delay_minutes: 1440, keep_ms: 6 * 3600e3 };
  if (limit <= 10000) return { name: 'Starter', delay: '15 minutes', delay_minutes: 15, keep_ms: 10 * 60e3 };
  return { name: limit <= 100000 ? 'Trader' : 'Quant or above', delay: 'real time', delay_minutes: 0, keep_ms: 3 * 60e3 };
}
const NO_TOKEN = 'No option prices: MarketData.app needs your token (the Data box on this page).';
const spend = (purpose, n) => {
  const d = nyDate(Date.now());
  if (credits.spent_day !== d) { credits.spent = {}; credits.spent_day = d; }
  credits.spent[purpose] = (credits.spent[purpose] || 0) + n;
};
/** Is there room to spend `n` option prices, leaving `reserve`? Unknown (nothing asked yet today) counts as room. */
export const room = (n = 1, reserve = 0) => credits.remaining == null || (credits.reset && Date.now() > credits.reset) || credits.remaining - reserve >= n;
export const creditLimit = () => credits.limit;
const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Regina', hour: 'numeric', minute: '2-digit' });

async function md(path, { ttl, purpose = 'other', fetchImpl = fetch, test = null } = {}) {
  const key = `md:${path}`;
  const keepFor = ttl ?? planOf(credits.limit).keep_ms;
  const got = test ? undefined : hit(key, keepFor);
  if (got !== undefined) return got;
  const old = cache.get(key)?.data;
  const tk = test || await token();
  if (!tk) throw Object.assign(new Error(NO_TOKEN), { status: 503, code: 'no_token' });
  if (!test && credits.remaining === 0 && credits.reset && Date.now() < credits.reset) {
    if (old) return old;
    throw Object.assign(new Error(`Today's ${credits.limit} option prices from MarketData.app are used up; more at ${clock(credits.reset)}.`), { status: 503, code: 'out_of_credits' });
  }
  const res = await fetchImpl(`${MD}/${path}`, { headers: { authorization: `Bearer ${tk}`, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const h = (n) => res.headers?.get?.(n);
  if (h('x-api-ratelimit-limit') != null && Number(h('x-api-ratelimit-limit')) > 0) {
    Object.assign(credits, { limit: Number(h('x-api-ratelimit-limit')), remaining: Number(h('x-api-ratelimit-remaining')), reset: Number(h('x-api-ratelimit-reset')) * 1000, at: Date.now() });
    const used = Number(h('x-api-ratelimit-consumed'));
    if (used > 0) spend(purpose, used);
  }
  if (res.status === 401) { credits.error = 'MarketData.app refused the token.'; throw Object.assign(new Error('MarketData.app refused the token. Paste it again in the Data box.'), { status: 503, code: 'bad_token' }); }
  if (res.status === 402) throw Object.assign(new Error('Your MarketData.app plan doesn’t include that.'), { status: 503, code: 'plan' });
  if (res.status === 429) {
    if (credits.limit) credits.remaining = 0;
    if (old) return old;
    throw Object.assign(new Error('Today’s option prices from MarketData.app are used up.'), { status: 503, code: 'out_of_credits' });
  }
  if (res.status === 204 || res.status === 404) return test ? { s: 'no_data' } : keep(key, { s: 'no_data' });
  if (!res.ok) { if (old) return old; throw Object.assign(new Error(`MarketData.app answered ${res.status}.`), { status: 502 }); }
  const j = await res.json();
  credits.error = null;
  return test ? j : keep(key, j);
}

/** MarketData's columns → option rows. Pure. */
export function rowsFrom(j) {
  if (!j || j.s !== 'ok' || !Array.isArray(j.optionSymbol)) return [];
  const n = (k, i) => (j[k]?.[i] == null ? null : Number(j[k][i]));
  return j.optionSymbol.map((sym, i) => {
    const p = parseOcc(sym) || {};
    const bid = n('bid', i) || 0; const ask = n('ask', i) || 0;
    return {
      occ: sym, root: j.underlying?.[i] || p.root, type: j.side?.[i] || p.type, strike: n('strike', i) ?? p.strike, expiry: p.expiry,
      bid, ask, mid: bid && ask ? r2((bid + ask) / 2) : bid || ask || n('mid', i) || 0, last: n('last', i),
      iv: n('iv', i) || null, delta: n('delta', i), gamma: n('gamma', i) || 0, theta: n('theta', i) || 0, vega: n('vega', i) || 0,
      open_interest: n('openInterest', i) || 0, volume: n('volume', i) || 0,
      underlying_price: n('underlyingPrice', i), as_of: j.updated?.[i] ? new Date(j.updated[i] * 1000).toISOString() : null,
    };
  }).filter((c) => c.expiry && c.strike > 0);
}

const STOP = ['no_token', 'bad_token', 'out_of_credits', 'plan'];
/** The prices of the exact options named (legs he holds): [{ type, strike, expiry }] → rows, one credit each. */
export async function optionQuotes(symbol, legs, opts = {}) {
  const want = [...new Set(legs.map((l) => occSymbol(symbol, l.expiry, l.type, l.strike)))];
  const out = [];
  for (const occ of want) {
    try { out.push(...rowsFrom(await md(`options/quotes/${occ}/`, { purpose: 'your positions', ...opts }))); } catch (e) { if (STOP.includes(e.code)) throw e; }
  }
  return out;
}
/** A slice of the chain: MarketData's own filters (side, from/to or dte, strike "a-b", strikeLimit, expiration). */
export async function optionSlice(symbol, params, opts = {}) {
  const qs = Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return rowsFrom(await md(`options/chain/${symbol}/?${qs}`, { purpose: 'plans', ...opts }));
}
/** The expiry dates a stock's options have (kept half a day). */
export async function expirations(symbol, opts = {}) {
  const j = await md(`options/expirations/${symbol}/`, { ttl: 12 * 3600e3, purpose: 'expiry lists', ...opts });
  return Array.isArray(j?.expirations) ? j.expirations : [];
}
/** One expiry's strikes (no prices: a strike list is one request). */
export async function strikeList(symbol, expiry, opts = {}) {
  const j = await md(`options/strikes/${symbol}/?expiration=${expiry}`, { ttl: 12 * 3600e3, purpose: 'strike lists', ...opts });
  const list = j && Object.entries(j).find(([k, v]) => /^\d{4}-\d{2}-\d{2}$/.test(k) && Array.isArray(v));
  return list ? list[1].map(Number) : [];
}

/** Where the prices come from, what today's allowance is and where it went. */
export async function optionsStatus() {
  const has = await hasToken();
  const p = planOf(credits.limit);
  const fresh = !!credits.reset && Date.now() > credits.reset; // a new day's allowance since we last asked
  return {
    stocks: { source: 'Yahoo chart feed', delay: 'live in market hours' },
    options: {
      source: 'MarketData.app', has_token: has, plan: p.name, delay: p.delay, delay_minutes: p.delay_minutes,
      limit: credits.limit, remaining: fresh ? credits.limit : credits.remaining, resets_at: credits.reset && !fresh ? new Date(credits.reset).toISOString() : null,
      checked_at: credits.at ? new Date(credits.at).toISOString() : null, spent_today: credits.spent_day === nyDate(Date.now()) ? credits.spent : {},
      error: has ? credits.error : null,
    },
  };
}
/** Try a token before it's kept: one request for an expiry list. Returns the plan it shows. */
export async function tryToken(tk, opts = {}) {
  const j = await md('options/expirations/AAPL/', { test: String(tk || '').trim(), purpose: 'checking the token', ...opts });
  if (!Array.isArray(j?.expirations)) throw Object.assign(new Error('MarketData.app didn’t answer the test as expected.'), { status: 502 });
  return planOf(credits.limit);
}
export const clearMarketCache = () => { cache.clear(); yahooCool = 0; Object.assign(credits, { limit: null, remaining: null, reset: null, at: null, error: null, spent: {}, spent_day: null }); };
export const _credits = credits; // tests

/** A chain in the shape strategy.pick reads: { symbol, quote, as_of, expiries, contracts }. Pure. */
export function chainOf(symbol, quoteNow, contracts) {
  const expiries = [...new Set(contracts.map((c) => c.expiry))].sort();
  const asOf = contracts.map((c) => c.as_of).filter(Boolean).sort()[0] || null;
  return { symbol, quote: quoteNow, as_of: asOf, expiries, contracts };
}
