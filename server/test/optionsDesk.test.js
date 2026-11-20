// The options desk end to end on stand-in feeds (Nov 20): his positions valued live with a put spread, what's billed against
// the Free plan's 100 option prices a day, a plan and its spread, the spread table, the token box, and the watcher's notes.
// The stock feed and MarketData.app are both stood in for (the paths, columns and headers MarketData's AAPL demo returned).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { bsPrice, bsGreeks } from '../lib/options/strategy.js';
import { clearMarketCache, _setTokenLoader, _credits } from '../lib/options/market.js';
import { positions, plan, spreads, legPrice, strikes, scan, tick, alerts, alertFeed, alertsSeen, dataStatus, saveToken, saveRules, _priced, PLAN_COST } from '../lib/options/desk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-11-20T17:00:00Z'); // a Friday, noon in New York
const QUOTED = Date.parse('2026-11-19T21:00:00Z'); // the option prices are yesterday's close: the Free plan
const PRICE = { NVDA: 135.5, TSLA: 352, AAPL: 345 };       // now
const PREV = { NVDA: 146, TSLA: 375, AAPL: 349 };          // yesterday's close
const EXPIRIES = ['2026-11-20', '2026-11-23', '2026-11-25', '2026-11-27', '2026-12-04', '2026-12-18', '2026-12-31', '2027-01-15'];
let db; let asked = []; let left = 100; let tokenOk = true;
const realFetch = globalThis.fetch;

const bars = (sym) => { const t0 = Date.parse('2026-11-20T14:30:00Z') / 1000; const n = 30; return { timestamp: Array.from({ length: n }, (_, i) => t0 + i * 300), close: Array.from({ length: n }, (_, i) => PREV[sym] + ((PRICE[sym] - PREV[sym]) * (i + 1)) / n) }; };
const optionRow = (sym, type, K, expiry) => {
  const S = PREV[sym]; const T = Math.max(0, (Date.parse(`${expiry}T21:00:00Z`) - QUOTED) / (365 * 86400e3)); const iv = 0.55;
  const px = bsPrice(type, S, K, T, iv); const g = bsGreeks(type, S, K, T, iv); const r = (n) => Math.round(n * 100) / 100;
  return { optionSymbol: `${sym}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${type === 'put' ? 'P' : 'C'}${String(Math.round(K * 1000)).padStart(8, '0')}`, underlying: sym, side: type, strike: K,
    updated: QUOTED / 1000, bid: Math.max(0, r(px - 0.05)), ask: r(px + 0.05), mid: r(px), underlyingPrice: S, iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega };
};
const columns = (rows) => { const o = { s: rows.length ? 'ok' : 'no_data' }; for (const r of rows) for (const [k, v] of Object.entries(r)) (o[k] ||= []).push(v); return o; };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const billed = (body, used) => { left -= used; return json(body, 203, { 'x-api-ratelimit-limit': '100', 'x-api-ratelimit-remaining': String(left), 'x-api-ratelimit-reset': String(Date.parse('2099-01-01T14:30:00Z') / 1000), 'x-api-ratelimit-consumed': String(used) }); };

before(async () => {
  db = new PGlite({ parsers: { 1082: (s) => s, 1700: (s) => s } });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  _setTokenLoader(async () => 'test-token-0123456789');
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('finance.yahoo.com')) {
      const { pathname, searchParams } = new URL(u);
      if (pathname.endsWith('/spark')) return json(Object.fromEntries(searchParams.get('symbols').split(',').filter((s) => PRICE[s]).map((s) => [s, { ...bars(s), chartPreviousClose: PREV[s] }])));
      const sym = pathname.split('/').pop();
      if (!PRICE[sym]) return json({}, 404);
      if (searchParams.get('interval') === '1d') {
        const t0 = Date.parse('2026-10-20T14:30:00Z') / 1000;
        return json({ chart: { result: [{ timestamp: Array.from({ length: 22 }, (_, i) => t0 + i * 86400), indicators: { quote: [{ close: Array.from({ length: 22 }, () => PREV[sym] * 1.1), high: [], low: [] }] } }] } });
      }
      const b = bars(sym);
      return json({ chart: { result: [{ meta: { regularMarketPrice: PRICE[sym], chartPreviousClose: PREV[sym], regularMarketTime: b.timestamp.at(-1) }, timestamp: b.timestamp, indicators: { quote: [{ close: b.close, open: b.close, high: b.close, low: b.close }] } }] } });
    }
    // Nothing in these tests reaches the network: the Bank of Canada's rate is a fixed one, anything else is refused.
    if (u.includes('bankofcanada.ca')) return json({ observations: [{ d: '2026-11-19', FXUSDCAD: { v: '1.4000' } }] });
    if (!u.startsWith('https://api.marketdata.app/')) return json({}, 503);
    asked.push(u.replace('https://api.marketdata.app/v1/', ''));
    if (!tokenOk || opts.headers.authorization !== 'Bearer test-token-0123456789') return json({ s: 'error', errmsg: 'Invalid token.' }, 401);
    if (left <= 0) return json({ s: 'error' }, 429);
    const { pathname, searchParams: p } = new URL(u);
    const [, , kind, sym] = pathname.split('/').filter(Boolean);
    if (kind === 'quotes') { const m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym); return billed(columns([optionRow(m[1], m[5] === 'P' ? 'put' : 'call', Number(m[6]) / 1000, `20${m[2]}-${m[3]}-${m[4]}`)]), 1); }
    if (kind === 'expirations') return billed({ s: 'ok', expirations: EXPIRIES }, 1);
    const S = PREV[sym];
    const all = []; for (let k = Math.round(S * 0.7); k <= S * 1.3; k += 1) all.push(k);
    if (kind === 'strikes') return billed({ s: 'ok', [p.get('expiration')]: all }, 1);
    let exps = EXPIRIES;
    const dte = (e) => Math.round((Date.parse(`${e}T12:00:00Z`) - Date.parse('2026-11-20T12:00:00Z')) / 86400e3);
    if (p.get('expiration')) exps = exps.filter((e) => e === p.get('expiration'));
    if (p.get('from')) exps = exps.filter((e) => e >= p.get('from') && e <= p.get('to'));
    if (p.get('dte')) { const [a, b] = p.get('dte').split('-').map(Number); exps = exps.filter((e) => dte(e) >= a && dte(e) <= b); }
    let ks = all;
    if (p.get('strike')) { const [a, b] = p.get('strike').split('-').map(Number); ks = ks.filter((k) => k >= a && k <= b); }
    ks = ks.sort((a, b) => Math.abs(a - S) - Math.abs(b - S)).slice(0, Number(p.get('strikeLimit')) || 99);
    const rows = exps.flatMap((e) => ks.map((k) => optionRow(sym, p.get('side'), k, e)));
    return billed(columns(rows), rows.length);
  };
  // His NVDA: 100 shares, a call sold for today, a 145/135 put spread to Dec 31.
  await db.query(`INSERT INTO options_positions (symbol, shares, cost, opened_on, legs, premium_collected, status, source) VALUES ('NVDA', 100, 159.84, '2026-11-03', $1, 0, 'open', 'broker')`,
    [JSON.stringify([{ type: 'call', side: 'short', strike: 144, expiry: '2026-11-20', premium: 5.36, contracts: 1, since: '2026-11-18' }, { type: 'put', side: 'long', strike: 145, expiry: '2026-12-31', premium: 7.55, contracts: 1, since: '2026-11-05' },
      { type: 'put', side: 'short', strike: 135, expiry: '2026-12-31', premium: 3.2, contracts: 1, since: '2026-11-18' }])]);
  await saveRules({ watchlist: ['NVDA', 'TSLA', 'AAPL'], wide: false, capital: 60000 });
});
after(async () => { globalThis.fetch = realFetch; await db?.close(); });
const fresh = () => { clearMarketCache(); _priced.clear(); asked = []; left = 100; tokenOk = true; _setTokenLoader(async () => 'test-token-0123456789'); };

test('his position, live: one option price a leg, each brought to today’s stock price, the spread and the greeks', async () => {
  fresh();
  const [p] = await positions(NOW);
  assert.equal(p.price, 135.5);
  assert.equal(p.day.change_pct, -7.19);
  assert.equal(p.bars.length, 30);
  assert.deepEqual(asked, ['options/quotes/NVDA261120C00144000/', 'options/quotes/NVDA261231P00145000/', 'options/quotes/NVDA261231P00135000/']);
  assert.equal(left, 97); // three legs, three prices
  const put = p.open_legs.find((l) => l.type === 'put' && l.side === 'long');
  assert.equal(put.modelled, true);
  assert.ok(put.now > put.quoted.mid, `the put is worth more with the stock down 7%: ${put.now} > ${put.quoted.mid}`);
  assert.equal(put.quoted.underlying_price, 146);
  assert.deepEqual([p.figures.put_spreads[0].kind, p.figures.protection_ends, p.figures.falls_to_zero], ['insurance', 135, true]);
  assert.ok(p.greeks.delta > 0 && p.greeks.delta < 100 && !p.greeks.iv_assumed);
  assert.equal(p.option_prices.modelled, true);
  assert.equal(p.option_prices.quoted_at, '2026-11-19T21:00:00.000Z');
  const titles = p.signals.map((s) => s.id);
  assert.ok(titles.includes('NVDA:spread:near:135:2026-11-20') && titles.includes('NVDA:put:under:145:2026-11-20') && titles.includes('NVDA:expiry:2026-11-20') && titles.includes('NVDA:move:down2:2026-11-20'), titles.join(' '));
  // Asked again a minute later: nothing more is billed (the answers are kept).
  await positions(NOW);
  assert.equal(left, 97);
  const d = await dataStatus();
  assert.deepEqual([d.options.plan, d.options.delay, d.options.limit, d.options.remaining, d.options.spent_today['your positions']], ['Free', '24 hours', 100, 97, 3]);
});

test('a plan prices only what his rules could pick, keeps it, and offers the put as a spread', async () => {
  fresh();
  const cached = await plan('TSLA', {}, NOW, { onlyCached: true });
  assert.equal(cached.needs_pricing, true);
  assert.equal(left, 100, 'asking for what was priced before spends nothing');
  const p = await plan('TSLA', {}, NOW);
  const spent = 100 - left;
  assert.ok(spent > 0 && spent <= PLAN_COST + 4, `a plan took ${spent} option prices`);
  assert.equal(p.quote.price, 352);
  assert.ok(p.call && p.call.strike >= 357 && p.call.expiry <= '2026-11-23', JSON.stringify(p.call));
  assert.ok(p.put && p.put.strike <= 342, JSON.stringify(p.put));
  assert.equal(p.option_prices.modelled, true);
  assert.ok(p.put_spread, 'the put his rule picks, as a spread');
  assert.equal(p.put_spread.high_strike, p.put.strike);
  assert.ok(p.put_spread.low_strike <= p.put.strike - 10);
  assert.ok(p.put_spread.cost < p.put_spread.plain_put_cost && p.put_spread.lot.protection_ends === p.put_spread.low_strike);
  assert.ok(p.cadence && p.often);
  // Again, and from the list: no more is billed, and the list carries its figures.
  await plan('TSLA', {}, NOW);
  assert.equal(100 - left, spent);
  const s = await scan(null, NOW);
  const row = s.stocks.find((x) => x.symbol === 'TSLA');
  assert.deepEqual([row.priced, row.price, row.day_pct], [true, 352, -6.13]);
  assert.ok(row.carry && row.put_spread && row.spark.length === 30);
  assert.deepEqual([s.stocks.find((x) => x.symbol === 'AAPL').priced, s.priced_count, s.stock_count], [false, 1, 3]);
  assert.equal(100 - left, spent);
  // It's in settings too, so a restart doesn't pay again.
  await new Promise((r) => setTimeout(r, 20));
  const { rows: [kept] } = await db.query(`SELECT value FROM settings WHERE key = 'covered_call_priced'`);
  assert.ok(kept.value.TSLA.rows.length > 0);
});

test('a spread table is a dozen prices; one leg is one; the strike list carries none', async () => {
  fresh();
  const t = await spreads('NVDA', { kind: 'insurance', expiry: '2026-12-31', width: 10, otm: 0 }, NOW);
  assert.ok(100 - left <= 13, `spreads took ${100 - left}`);
  assert.ok(t.prices_read >= 8 && t.prices_read <= 12, `two bands of strikes: ${t.prices_read}`);
  assert.ok(t.rows.length >= 4 && t.rows.every((r) => r.high_strike - r.low_strike === 10 && r.cost > 0 && r.most_it_pays > 0), JSON.stringify(t.rows.map((r) => [r.high_strike, r.low_strike])));
  const inc = await spreads('NVDA', { kind: 'income', expiry: '2026-11-27', width: 10, otm: 10 }, NOW);
  assert.ok(inc.rows.length > 0 && inc.rows.every((r) => r.credit > 0 && r.max_loss < 0 && r.sell.strike > r.buy.strike));
  const before = left;
  const leg = await legPrice('NVDA', { type: 'put', strike: 130, expiry: '2026-12-31' }, NOW);
  assert.equal(before - left, 1);
  assert.ok(leg.modelled && leg.bid > 0 && leg.ask > leg.bid && leg.quoted.bid > 0);
  const st = await strikes('NVDA', '2026-12-31', NOW);
  assert.ok(st.puts.length > 20 && st.puts.every((x) => x.bid === null) && st.expiries.includes('2026-12-31'));
  await assert.rejects(legPrice('NVDA', { type: 'put', strike: 0, expiry: '2026-12-31' }), /Which strike and expiry/);
});

test('the token: checked with one request before it’s kept, never sent back; without it the page still has prices and greeks', async () => {
  fresh();
  _setTokenLoader(async () => { const { rows: [r] } = await db.query(`SELECT value FROM settings WHERE key = 'market_data'`); return r?.value?.token || null; });
  let d = await dataStatus();
  assert.equal(d.options.has_token, false);
  const [bare] = await positions(NOW);
  assert.equal(bare.price, 135.5);
  assert.equal(bare.greeks.iv_assumed, true);
  assert.match(bare.option_prices.error, /needs your token/);
  assert.equal(asked.length, 0, 'nothing is asked of MarketData.app without a token');
  await assert.rejects(saveToken('short'), /doesn’t look like a MarketData\.app token/);
  tokenOk = false;
  await assert.rejects(saveToken('test-token-that-is-wrong-000'), /refused the token/);
  d = await dataStatus();
  assert.equal(d.options.has_token, false, 'a refused token isn’t kept');
  tokenOk = true;
  await assert.rejects(saveToken('another-token-0000000000'), /refused the token/); // the stand-in only knows test-token
  d = await saveToken('test-token-0123456789');
  assert.equal(JSON.stringify(d).includes('test-token'), false);
  assert.deepEqual([d.options.has_token, d.options.plan], [true, 'Free']);
  const [p] = await positions(NOW);
  assert.equal(p.greeks.iv_assumed, false);
  d = await saveToken('');
  assert.equal(d.options.has_token, false);
});

test('the watcher: notes once each, his positions’ go to his phone, an unpriced drop stays on the page, and the Free plan’s prices are spared', async () => {
  fresh();
  await db.query(`DELETE FROM settings WHERE key IN ('covered_call_alerts', 'covered_call_priced', 'covered_call_alerts_seen', 'covered_call_iv')`);
  const first = await tick(NOW, { force: true });
  const ids = first.map((a) => a.id);
  for (const want of ['NVDA:spread:near:135:2026-11-20', 'NVDA:put:under:145:2026-11-20', 'NVDA:expiry:2026-11-20', 'NVDA:move:down2:2026-11-20']) assert.ok(ids.includes(want), `${want} in ${ids.join(' ')}`);
  assert.ok(first.filter((a) => a.symbol === 'NVDA' && a.kind !== 'theta' && a.kind !== 'drop').every((a) => a.level === 'high'));
  // TSLA is down 6% and 16% under its high: a drop by his rule. The watcher priced its options (one of the two it may price a
  // day on this plan). His rule counts the drop only if the calls then beat the puts: either the drop is noted with what his
  // rules pick, or it's the day's move that's noted; never both.
  const tsla = first.find((a) => a.id === 'TSLA:2026-11-20');
  const tslaMove = ids.includes('TSLA:move:down2:2026-11-20');
  assert.ok(!!tsla !== tslaMove, `one note for TSLA: ${ids.filter((i) => i.startsWith('TSLA')).join(' ')}`);
  if (tsla) { assert.equal(tsla.level, 'high'); assert.ok(tsla.picked.call && tsla.picked.put && tsla.picked.modelled && tsla.why.length === 2); }
  assert.ok(_priced.has('TSLA'), 'the watcher priced the dropped stock');
  assert.ok(left >= 45, `the watcher left ${left} of the day’s 100 option prices`);
  // The same round again: nothing new.
  assert.deepEqual(await tick(NOW, { force: true }), []);
  assert.equal((await alerts()).length, first.length);
  // The feed: all new until he's looked.
  let feed = await alertFeed();
  assert.equal(feed.unseen, first.length);
  await alertsSeen();
  feed = await alertFeed();
  assert.equal(feed.unseen, 0);
  // A kind he's turned off is no longer raised: tomorrow's move isn't noted.
  await saveRules({ alerts_off: ['move', 'drop', 'expiry', 'put', 'spread', 'theta', 'call', 'gamma', 'swing', 'iv', 'earnings'] });
  assert.deepEqual(await tick(new Date('2026-11-23T17:00:00Z'), { force: true }), []);
  await saveRules({ alerts_off: [] });
  // With few option prices left for the day the watcher prices nothing: the drop is noted for the page only, saying so.
  fresh(); left = 20;
  await db.query(`DELETE FROM settings WHERE key IN ('covered_call_alerts', 'covered_call_priced')`);
  const lean = await tick(NOW, { force: true });
  const bare = lean.find((a) => a.id === 'TSLA:2026-11-20');
  assert.ok(bare && bare.level === 'info' && bare.picked === null && /aren’t priced yet/.test(bare.note), JSON.stringify(bare));
  assert.equal(left, 17, 'only his own three options were read');
  // Out of market hours the watcher doesn't run.
  assert.deepEqual(await tick(new Date('2026-11-21T17:00:00Z')), []);
});
