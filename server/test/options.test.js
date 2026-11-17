// The covered-call desk's arithmetic (Jake, Nov 17: "a calculator of the positions that show max gain and loss at certain
// calls and puts ... recommend call and puts and position sizing"). Pure: no market, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOcc, chainFrom } from '../lib/options/market.js';
import { evaluate, bsPrice, dropCheck, cleanRules, pick, expiryClose, incomeDays, soonExpiries } from '../lib/options/strategy.js';
import { positionFields } from '../lib/options/desk.js';

const NOW = new Date('2026-11-17T15:30:00Z'); // a Tuesday, 10:30 in New York
const near = (a, b, d = 0.01) => assert.ok(Math.abs(a - b) <= d, `${a} ≈ ${b}`);

test('OCC symbols and the chain: the stock’s own contracts only, near the price', () => {
  assert.deepEqual(parseOcc('NVDA261118C00170000'), { root: 'NVDA', expiry: '2026-11-18', type: 'call', strike: 170 });
  assert.deepEqual(parseOcc('NVDA261218P00142500'), { root: 'NVDA', expiry: '2026-12-18', type: 'put', strike: 142.5 });
  const j = { timestamp: '2026-11-17 15:27:18', data: { symbol: 'NVDA', current_price: 150, prev_day_close: 155, price_change_percent: -3.2, iv30: 60,
    options: [
      { option: 'NVDA261118C00160000', bid: 1, ask: 1.1, delta: 0.2, iv: 0.6 },
      { option: 'B1VDA261118C00160000', bid: 1, ask: 1.1, delta: 0.2 }, // an adjusted contract
      { option: 'NVDA261118C00400000', bid: 0, ask: 0.01, delta: 0 },  // far away
    ] } };
  const ch = chainFrom(j, 'NVDA');
  assert.equal(ch.contracts.length, 1);
  assert.equal(ch.quote.iv30, 0.6);
  assert.equal(ch.as_of, '2026-11-17T15:27:18Z');
  assert.equal(ch.contracts[0].mid, 1.05);
});

test('expiry is 4 p.m. in New York; a 0DTE call earns over one day', () => {
  assert.equal(expiryClose('2026-11-18').toISOString(), '2026-11-18T21:00:00.000Z'); // EST
  assert.equal(expiryClose('2026-07-17').toISOString(), '2026-07-17T20:00:00.000Z'); // EDT
  assert.equal(incomeDays('2026-11-17', NOW), 1);
  assert.equal(incomeDays('2026-11-18', NOW), 2);
  assert.deepEqual(soonExpiries(['2026-11-16', '2026-11-18', '2026-11-20', '2026-12-18'], 7, NOW), ['2026-11-18', '2026-11-20']);
});

test('a covered call: gain capped at the strike plus premium, loss is the stock less the premium', () => {
  const r = evaluate({ price: 150, shares: 100, cost: 150, legs: [{ type: 'call', side: 'short', strike: 160, expiry: '2026-11-18', premium: 1.5, contracts: 1, delta: 0.2 }] }, { now: NOW });
  near(r.max_gain, (160 - 150 + 1.5) * 100);
  assert.equal(r.max_gain_at, 160);
  near(r.max_loss, -(150 - 1.5) * 100);
  assert.deepEqual(r.breakevens, [148.5]);
  assert.equal(r.premium_in, 150);
  assert.equal(r.income_per_day, 75); // two days to Wednesday's close
  assert.equal(r.called_away_chance, 20);
  assert.equal(r.unlimited_gain, false);
  assert.equal(r.uncovered, false);
});

test('a collar on one expiry: the put floors the loss', () => {
  const legs = [
    { type: 'call', side: 'short', strike: 160, expiry: '2026-11-20', premium: 2, contracts: 1 },
    { type: 'put', side: 'long', strike: 135, expiry: '2026-11-20', premium: 1, contracts: 1 },
  ];
  const r = evaluate({ price: 150, shares: 100, cost: 150, legs }, { now: NOW });
  near(r.max_loss, -(150 - 135 - 2 + 1) * 100);
  near(r.max_gain, (160 - 150 + 2 - 1) * 100);
  assert.equal(r.net_credit, 100);
});

test('a longer put is valued at its time left when the call expires', () => {
  const legs = [
    { type: 'call', side: 'short', strike: 160, expiry: '2026-11-18', premium: 1.5, contracts: 1 },
    { type: 'put', side: 'long', strike: 135, expiry: '2026-12-31', premium: 4, contracts: 1, iv: 0.5 },
  ];
  const r = evaluate({ price: 150, shares: 100, cost: 150, legs }, { now: NOW });
  const floor = -(150 - 135 - 1.5 + 4) * 100; // what it would be at the put's own expiry
  assert.ok(r.max_loss < floor + 1 && r.max_loss > floor - 150, `${r.max_loss} near ${floor} (the put's interest)`);
  const at150 = r.scenarios.find((s) => s.pct === 0).pnl;
  const putLeft = bsPrice('put', 150, 135, (expiryClose('2026-12-31') - expiryClose('2026-11-18')) / (365 * 86400e3), 0.5);
  near(at150, (1.5 - 4 + putLeft) * 100, 0.05);
});

test('net a day: the calls written, less the puts spread from when each was opened (Nov 17: puts "average about $17/day")', () => {
  // A put bought Oct 1 for $26.35 that expires Dec 31: 91 days, about $29 a day a contract; two contracts. A call sold today.
  const legs = [
    { type: 'call', side: 'short', strike: 170, expiry: '2026-11-18', premium: 1.44, contracts: 2 },
    { type: 'put', side: 'long', strike: 140, expiry: '2026-12-31', premium: 15.47, contracts: 2, since: '2026-10-01', iv: 0.6 },
  ];
  const r = evaluate({ price: 153.6, shares: 200, cost: 150, legs }, { now: NOW });
  assert.equal(r.income_per_day, 144); // $288 over the two days to Wednesday's close
  near(r.protection_per_day, (15.47 * 200) / 91, 0.01);
  near(r.net_per_day, 144 - (15.47 * 200) / 91, 0.01);
  // A call sold Monday for Wednesday is spread over its two days, whenever it's looked at.
  const sold = evaluate({ price: 153.6, shares: 100, legs: [{ ...legs[0], contracts: 1, since: '2026-11-16' }] }, { now: NOW });
  assert.equal(sold.income_per_day, 72);
  assert.equal(sold.net_per_day, 72);
});

test('no calls: gain unlimited; more calls than shares: uncovered, no max loss', () => {
  assert.equal(evaluate({ price: 100, shares: 100, legs: [] }).unlimited_gain, true);
  const r = evaluate({ price: 100, shares: 100, legs: [{ type: 'call', side: 'short', strike: 110, expiry: '2026-11-20', premium: 1, contracts: 2 }] }, { now: NOW });
  assert.equal(r.uncovered, true);
  assert.equal(r.max_loss, null);
});

test('Black-Scholes matches a textbook value', () => {
  near(bsPrice('call', 100, 100, 1, 0.2, 0.05), 10.45, 0.01);
  near(bsPrice('put', 100, 100, 1, 0.2, 0.05), 5.57, 0.01);
});

test('the drop rule: a day’s fall or far enough below the recent high', () => {
  const rules = cleanRules({ drop_day_pct: 3, drop_from_high_pct: 8, high_days: 5 });
  const hist = [100, 104, 110, 108, 105, 103].map((c, i) => ({ date: `2026-11-${String(10 + i).padStart(2, '0')}`, close: c }));
  const q = { price: 100, change_pct: -2.9, as_of: '2026-11-17T15:00:00Z' };
  const d = dropCheck(hist, q, rules);
  assert.equal(d.high, 110);
  near(d.from_high_pct, -9.09);
  assert.equal(d.triggered, true);
  assert.match(d.why[0], /below its 5-day high of US\$110/);
  assert.equal(dropCheck(hist, { ...q, price: 106, change_pct: -1 }, rules).triggered, false);
  assert.equal(dropCheck(hist, { ...q, price: 106, change_pct: -3.5 }, rules).why[0], 'down 3.5% today');
});

test('his rules pick the call nearest his delta, the cheapest put a day, and the lots his limits allow', () => {
  const c = (expiry, type, strike, bid, ask, delta, iv = 0.6) => ({ expiry, type, strike, bid, ask, mid: (bid + ask) / 2, delta, iv });
  const ch = { quote: { price: 150 }, expiries: [], contracts: [
    c('2026-11-16', 'call', 160, 1, 1.1, 0.2),           // expired yesterday
    c('2026-11-18', 'call', 155, 3, 3.1, 0.4),           // too much delta
    c('2026-11-18', 'call', 160, 1.5, 1.6, 0.21),
    c('2026-11-18', 'call', 165, 0.6, 0.7, 0.12),
    c('2026-11-20', 'call', 165, 1.4, 1.5, 0.19),
    c('2026-12-18', 'call', 170, 3, 3.2, 0.2),           // beyond 3 days
    c('2026-11-27', 'put', 135, 1.5, 1.6, -0.15),        // 10 days: $16 a day
    c('2026-12-18', 'put', 135, 3.9, 4, -0.2),           // 31 days: about $13 a day
    c('2026-12-18', 'put', 140, 5, 5.2, -0.27),
    c('2027-03-19', 'put', 135, 9, 9.5, -0.25),          // beyond 45 days
  ] };
  const p = pick(ch, { capital: 100000, max_position_pct: 50, max_loss_pct: 3 }, { now: NOW });
  assert.equal(p.call.strike, 160);
  assert.equal(p.call.expiry, '2026-11-18');
  assert.deepEqual(p.call_choices.map((x) => x.expiry), ['2026-11-18', '2026-11-20']);
  assert.equal(p.put.expiry, '2026-12-18');
  assert.equal(p.put.strike, 135);
  // One lot: 100 × $150 + $400 put. 50% of $100k → 3 lots. Worst case with the put about (150 − 135 − 1.5 + 4) × 100 = $1,750 → 3% ($3,000) allows 1.
  assert.equal(p.sizing.lots, 1);
  assert.match(p.sizing.limits[0], /allows 3 lots/);
  assert.match(p.sizing.limits[1], /allows 1:/);
  assert.ok(p.reasons.some((r) => /0\.2 delta target/.test(r)));
  const bare = pick(ch, { capital: 100000, protect: false, max_loss_pct: 3, drop_test_pct: 20 }, { now: NOW });
  assert.equal(bare.put, null);
  assert.match(bare.sizing.limits[1], /a 20% fall with no put/);
  assert.match(pick(ch, {}, { now: NOW }).sizing.limits[0], /Set the money/);
});

test('in CAD (Nov 17: "I want to see outputs in cad"): capital in CAD is sized in US dollars, the words give CAD', async () => {
  const { rateFrom } = await import('../lib/options/fx.js');
  assert.deepEqual(rateFrom({ observations: [{ d: '2026-11-16', FXUSDCAD: { v: '1.4298' } }] }), { rate: 1.4298, date: '2026-11-16' });
  assert.equal(rateFrom({ observations: [] }), null);
  const ch = { quote: { price: 150 }, expiries: [], contracts: [
    { expiry: '2026-11-18', type: 'call', strike: 160, bid: 1.5, ask: 1.6, mid: 1.55, delta: 0.21, iv: 0.6 },
  ] };
  // C$43,000 at 1.43 is about US$30,070: 50% is US$15,035, one lot of US$15,000.
  const p = pick(ch, { capital: 43000, capital_currency: 'CAD', max_position_pct: 50, max_loss_pct: 50, protect: false }, { now: NOW, fx: 1.43 });
  assert.equal(p.sizing.lots, 1);
  assert.match(p.sizing.limits[0], /50% of \$43,000 in one name allows 1 lot at \$21,450 each/);
  assert.equal(p.usd_cad, 1.43);
  const inUsd = pick(ch, { capital: 43000, capital_currency: 'USD', max_position_pct: 50, max_loss_pct: 50, protect: false }, { now: NOW, fx: 1.43 });
  assert.equal(inUsd.sizing.lots, 1, 'US$21,500: still one lot');
  assert.equal(pick(ch, { capital: 31000, capital_currency: 'USD', max_position_pct: 100, max_loss_pct: 100, protect: false }, { now: NOW }).sizing.lots, 2);
  // A capital saved before CAD came in was US$; new rules start in CAD.
  assert.equal(cleanRules({ capital: 50000 }).capital_currency, 'USD');
  assert.equal(cleanRules({}).capital_currency, 'CAD');
});

test('rules are cleaned: symbols upper-cased and checked, numbers kept in range', () => {
  const r = cleanRules({ watchlist: ['nvda', ' tsla ', 'bad symbol!', 'NVDA'], target_delta: 5, protect: false });
  assert.deepEqual(r.watchlist, ['NVDA', 'TSLA']);
  assert.equal(r.target_delta, 0.6);
  assert.equal(r.protect, false);
});

test('a position needs a symbol, shares and a cost; legs are cleaned', () => {
  assert.throws(() => positionFields({ symbol: 'nvda!', shares: 100, cost: 150 }), /stock symbol/);
  assert.throws(() => positionFields({ symbol: 'NVDA', shares: 100 }), /cost/);
  const f = positionFields({ symbol: 'nvda', shares: 100, cost: 150, legs: [{ type: 'call', side: 'short', strike: 160, expiry: '2026-11-18', premium: '1.5' }, { strike: 0 }] });
  assert.equal(f.symbol, 'NVDA');
  assert.deepEqual(f.legs, [{ type: 'call', side: 'short', strike: 160, expiry: '2026-11-18', premium: 1.5, contracts: 1 }]);
  assert.equal(f.status, 'open');
});
