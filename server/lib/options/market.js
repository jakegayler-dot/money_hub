// Market data for the covered-call desk (Jake, Nov 17: "a covered call strategist ... watches for drops on large stocks that
// offer 0dte or close to call options"). Cboe's public delayed-quote feed: no key, 15 minutes behind, the whole option chain
// with bid, ask, IV and the greeks, the stock's quote and its daily history. Kept a few minutes so a page or a scan doesn't
// ask Cboe again for the same thing.
const BASE = 'https://cdn.cboe.com/api/global/delayed_quotes';
const cache = new Map(); // path → { at, data }
const TTL = { quote: 60e3, chain: 5 * 60e3, history: 6 * 3600e3 };
export const SYMBOL = /^[A-Z]{1,6}$/;

// Cboe's free feed answers 429 when asked too much (Nov 17, a 50-stock scan): then nothing is asked for two minutes and what
// was last read is used, however old.
let coolUntil = 0;
const BUSY = 'Cboe asked us to slow down; trying again in a couple of minutes.';
export const cboeBusy = () => Date.now() < coolUntil;
async function getJson(path, ttl, fetchImpl = fetch) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  if (cboeBusy()) { if (hit) return hit.data; throw Object.assign(new Error(BUSY), { status: 503 }); }
  const res = await fetchImpl(`${BASE}/${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (res.status === 429) {
    coolUntil = Date.now() + 120e3;
    if (hit) return hit.data;
    throw Object.assign(new Error(BUSY), { status: 503 });
  }
  if (res.status === 403 || res.status === 404) throw Object.assign(new Error(`Cboe has no options data for that symbol.`), { status: 404 });
  if (!res.ok) throw Object.assign(new Error(`Cboe's quote feed answered ${res.status}.`), { status: 502 });
  const data = await res.json();
  cache.set(path, { at: Date.now(), data });
  return data;
}
export const clearMarketCache = () => { cache.clear(); coolUntil = 0; };

/** Cboe's timestamp ("2026-11-17 15:27:18", UTC) as ISO. */
const isoUtc = (s) => (s ? `${String(s).replace(' ', 'T')}Z` : null);

export function quoteFrom(j) {
  const d = j?.data || {};
  return {
    symbol: d.symbol, price: Number(d.current_price), prev_close: Number(d.prev_day_close), change: Number(d.price_change),
    change_pct: Number(d.price_change_percent), open: Number(d.open), high: Number(d.high), low: Number(d.low),
    iv30: d.iv30 == null ? null : Number(d.iv30) / 100, as_of: isoUtc(j?.timestamp),
  };
}

export async function quote(symbol, opts = {}) {
  return quoteFrom(await getJson(`quotes/${symbol}.json`, TTL.quote, opts.fetchImpl));
}

/** Daily closes, oldest first; the last `days` of them. */
export async function history(symbol, days = 260, opts = {}) {
  const j = await getJson(`charts/historical/${symbol}.json`, TTL.history, opts.fetchImpl);
  return (j?.data || []).slice(-days).map((r) => ({ date: r.date, close: Number(r.close), high: Number(r.high), low: Number(r.low) }));
}

const OCC = /^([A-Z0-9]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
/** An OCC option symbol → { root, expiry, type, strike }. */
export function parseOcc(s) {
  const m = OCC.exec(String(s || ''));
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] === 'C' ? 'call' : 'put', strike: Number(m[6]) / 1000 };
}

/** The chain from Cboe's payload, the stock's own standard contracts only, strikes within `band` of the price. Pure. */
export function chainFrom(j, symbol, band = 0.4) {
  const d = j?.data || {};
  const q = quoteFrom(j);
  const lo = q.price * (1 - band); const hi = q.price * (1 + band);
  const contracts = [];
  for (const o of d.options || []) {
    const p = parseOcc(o.option);
    if (!p || p.root !== symbol || p.strike < lo || p.strike > hi) continue;
    const bid = Number(o.bid) || 0; const ask = Number(o.ask) || 0;
    contracts.push({
      ...p, bid, ask, mid: bid && ask ? Math.round(((bid + ask) / 2) * 100) / 100 : bid || ask,
      iv: Number(o.iv) || null, delta: o.delta == null ? null : Number(o.delta), gamma: Number(o.gamma) || 0,
      theta: Number(o.theta) || 0, open_interest: Number(o.open_interest) || 0, volume: Number(o.volume) || 0,
      last: Number(o.last_trade_price) || null,
    });
  }
  const expiries = [...new Set(contracts.map((c) => c.expiry))].sort();
  return { symbol, quote: q, as_of: q.as_of, expiries, contracts };
}

export async function chain(symbol, opts = {}) {
  return chainFrom(await getJson(`options/${symbol}.json`, opts.ttl || TTL.chain, opts.fetchImpl), symbol);
}
