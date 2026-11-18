// The covered-call desk's arithmetic (Jake, Nov 17: "a calculator of the positions that show max gain and loss at certain
// calls and puts ... recommend call and puts and position sizing"). Pure: no market, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOcc, chainFrom } from '../lib/options/market.js';
import { evaluate, bsPrice, dropCheck, cleanRules, pick, expiryClose, incomeDays, soonExpiries, calendarDays, daysTo, expiryCadence, tradingDaysBetween, sessionDate, isTradingDay, playValue } from '../lib/options/strategy.js';
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
  // Nov 17: "options expiring at most every 3 days, not an option expiring within 3 days": how often they come.
  const mwf = ['2026-11-18', '2026-11-20', '2026-11-23', '2026-11-25', '2026-11-27', '2026-12-18'];
  assert.deepEqual(expiryCadence(mwf, NOW), { min: 2, max: 3 });
  assert.deepEqual(expiryCadence(['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23'], NOW), { min: 1, max: 1 });
  assert.deepEqual(expiryCadence(['2026-11-20', '2026-11-27', '2026-12-04', '2026-12-11'], NOW), { min: 7, max: 7 });
  assert.equal(expiryCadence(['2026-11-20', '2026-12-18'], NOW), null);
  // Nov 17: "avg put daily cost (on trading days)": weekdays the market is open (NYSE's 2026 calendar: Thanksgiving Nov 26,
  // Christmas Dec 25). Tuesday morning to Friday is four sessions; after Tuesday's close, three.
  assert.equal(incomeDays('2026-11-20', NOW), 4);
  assert.equal(incomeDays('2026-11-20', new Date('2026-11-17T22:00:00Z')), 3);
  assert.equal(incomeDays('2026-12-31', NOW), 31);
  assert.equal(tradingDaysBetween('2026-10-01', '2026-12-31'), 64);
  assert.equal(isTradingDay('2026-11-26'), false);
  assert.equal(incomeDays('2026-11-23', new Date('2026-11-21T15:00:00Z')), 1, 'Saturday to Monday: one session');
  assert.equal(sessionDate(1, NOW), '2026-11-17');
  assert.equal(sessionDate(8, NOW), '2026-11-27', 'the eighth session skips the weekend and Thanksgiving');
  // A call "within 3 days" goes by the calendar: Tuesday afternoon to Friday is 3, though Friday's close is 3.02 days off.
  const tueAfternoon = new Date('2026-11-17T20:30:00Z');
  assert.equal(calendarDays('2026-11-20', tueAfternoon), 3);
  assert.ok(daysTo('2026-11-20', tueAfternoon) > 3);
  assert.equal(calendarDays('2026-11-17', tueAfternoon), 0);
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
  // A put bought Oct 1 that expires Dec 31: 64 trading days; two contracts. A call sold today.
  const legs = [
    { type: 'call', side: 'short', strike: 170, expiry: '2026-11-18', premium: 1.44, contracts: 2 },
    { type: 'put', side: 'long', strike: 140, expiry: '2026-12-31', premium: 15.47, contracts: 2, since: '2026-10-01', iv: 0.6 },
  ];
  const r = evaluate({ price: 153.6, shares: 200, cost: 150, legs }, { now: NOW });
  assert.equal(r.income_per_day, 144); // $288 over the two days to Wednesday's close
  near(r.protection_per_day, (15.47 * 200) / 64, 0.01);
  near(r.net_per_day, 144 - (15.47 * 200) / 64, 0.01);
  // A call sold Monday for Wednesday is spread over its three sessions (Monday, Tuesday, Wednesday), whenever it's looked at.
  const sold = evaluate({ price: 153.6, shares: 100, legs: [{ ...legs[0], contracts: 1, since: '2026-11-16' }] }, { now: NOW });
  assert.equal(sold.income_per_day, 48);
  assert.equal(sold.net_per_day, 48);
});

test('his 105 NVDA with one call and one put: 5 shares neither covers, said (Nov 17: "Max gain is unlimited? And max loss seems too much?")', () => {
  const legs = [
    { type: 'call', side: 'short', strike: 165, expiry: '2026-11-20', premium: 5.3, contracts: 1, iv: 0.6 },
    { type: 'put', side: 'long', strike: 150, expiry: '2026-12-31', premium: 10.55, contracts: 1, iv: 0.6 },
  ];
  const now = new Date('2026-11-17T20:00:00Z');
  const r = evaluate({ price: 152.86, shares: 105, cost: 159.84, legs }, { now });
  assert.equal(r.unlimited_gain, true);
  assert.equal(r.shares_not_called, 5);
  assert.equal(r.call_strike, 165);
  near(r.gain_at_call, 643.14, 1);
  assert.equal(r.shares_without_put, 5);
  // 100 shares from US$159.84 to the put's 150 (984), the put (1,055) less the call (530), 5 bare shares to zero (799), and the
  // put's time left on Nov 20 (worth a little under its full payoff then).
  near(r.max_loss, -2372.7, 1);
  assert.ok(r.max_loss < -(984 + 1055 - 530 + 799) && r.max_loss > -(984 + 1055 - 530 + 799) - 100);
  const round = evaluate({ price: 152.86, shares: 100, cost: 159.84, legs }, { now });
  assert.equal(round.shares_not_called, 0);
  assert.equal(round.shares_without_put, 0);
  near(round.max_gain, 617.34, 1);
  assert.equal(round.max_gain_at, 165);
  assert.ok(round.floor_from > 90 && round.floor_from < 150, `floor from ${round.floor_from}`);
});

test('on margin (Nov 17: "required capital at 30% margin, factor in interest costs"): capital, interest a day, interest in the figures', () => {
  const legs = [
    { type: 'call', side: 'short', strike: 160, expiry: '2026-11-18', premium: 1.5, contracts: 1 },
    { type: 'put', side: 'long', strike: 135, expiry: '2026-11-18', premium: 1, contracts: 1 },
  ];
  const cash = evaluate({ price: 150, shares: 100, cost: 150, legs }, { now: NOW });
  const r = evaluate({ price: 150, shares: 100, cost: 150, legs }, { now: NOW, margin: { pct: 30, rate: 5.85 } });
  assert.equal(r.capital_needed, 4500 + 100); // 30% of the shares, the put in full
  assert.equal(r.borrowed, 10500);
  // Interest a trading day is the year's over 252 trading days, the same every day (Nov 18); it runs on calendar days to the expiry.
  near(r.interest_per_day, (10500 * 0.0585) / 252);
  near(r.interest_per_calendar_day, (10500 * 0.0585) / 365);
  near(r.interest_to_horizon, r.interest_per_calendar_day * 2, 0.02); // two days to Wednesday's close
  near(r.max_gain, cash.max_gain - r.interest_to_horizon, 0.02);
  near(r.max_loss, cash.max_loss - r.interest_to_horizon, 0.02);
  near(r.net_after_interest_per_day, r.net_per_day - r.interest_per_day, 0.02);
  assert.equal(cash.interest_per_day, 0);
  assert.equal(cash.capital_needed, 15100);
});

test('the gap: the call a day less the put a day, and sizing on margin', () => {
  const c = (expiry, type, strike, bid, ask, delta) => ({ expiry, type, strike, bid, ask, mid: (bid + ask) / 2, delta, iv: 0.6 });
  const ch = { quote: { price: 150 }, expiries: [], contracts: [c('2026-11-18', 'call', 160, 1.5, 1.6, 0.21), c('2026-12-18', 'put', 135, 3.9, 4, -0.2)] };
  const p = pick(ch, { capital: 100000, capital_currency: 'USD', max_position_pct: 50, max_loss_pct: 50, margin_pct: 30, margin_rate: 5.85 }, { now: NOW });
  assert.equal(p.carry.call_per_day, 75); // $150 over two days
  near(p.carry.put_per_day, 400 / 23); // 23 trading days to Dec 18
  near(p.carry.gap, 75 - 400 / 23);
  near(p.carry.after_interest, p.carry.gap - (15000 * 0.7 * 0.0585) / 252, 0.02);
  // What a lot is worth for what it ties up and risks (Nov 18).
  near(p.carry.on_capital_pct_year, (p.carry.after_interest / p.lot.capital_needed) * 252 * 100, 0.05);
  assert.equal(p.carry.days_to_earn_max_loss, Math.ceil(Math.abs(p.lot.max_loss) / p.carry.after_interest));
  assert.equal(p.lot.capital_needed, 4500 + 400);
  assert.equal(p.sizing.lots, Math.floor(50000 / 4900)); // 10 lots of US$4,900 at 30% margin
  assert.match(p.sizing.limits[0], /30% of the shares on margin, the put in full/);
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

test('his rules (Nov 17: "avg put daily cost (on trading days) on long horizon puts that are $10 otm, and avg short term daily calls $5 otm ... the next call that maximizes my daily return")', () => {
  const c = (expiry, type, strike, bid, ask, delta, iv = 0.6) => ({ expiry, type, strike, bid, ask, mid: (bid + ask) / 2, delta, iv });
  const ch = { quote: { price: 150 }, expiries: [], contracts: [
    c('2026-11-16', 'call', 160, 1, 1.1, 0.2),           // expired yesterday
    c('2026-11-18', 'call', 152.5, 4, 4.1, 0.45),        // under $5 out
    c('2026-11-18', 'call', 155, 3, 3.1, 0.4),           // Wednesday's $5-out call: $300 over 2 trading days
    c('2026-11-18', 'call', 160, 1.5, 1.6, 0.21),
    c('2026-11-20', 'call', 165, 1.4, 1.5, 0.19),        // Friday's first strike $5 out: $140 over 4
    c('2026-12-18', 'call', 170, 3, 3.2, 0.2),           // beyond 3 days: not short term
    c('2026-11-27', 'put', 135, 1.5, 1.6, -0.15),        // 10 days out: $160 over 8 trading days
    c('2026-12-18', 'put', 135, 3.9, 4, -0.2),
    c('2026-12-18', 'put', 140, 5, 5.2, -0.27),          // Dec 18's first strike $10 below: $520 over 23
    c('2026-12-18', 'put', 145, 7, 7.2, -0.35),          // under $10 below
    c('2027-03-19', 'put', 135, 9, 9.5, -0.25),          // beyond 45 days: not in his window
  ] };
  const p = pick(ch, { capital: 100000, capital_currency: 'USD', max_position_pct: 50, max_loss_pct: 3, margin_pct: 100 }, { now: NOW });
  // The next call: of the short expiries' $5-out calls, the one that pays the most a trading day.
  assert.equal(p.call.strike, 155);
  assert.equal(p.call.expiry, '2026-11-18');
  assert.equal(p.call.per_day, 150);
  assert.deepEqual(p.call_choices.map((x) => [x.expiry, x.strike, x.days, x.per_day]), [['2026-11-18', 155, 2, 150], ['2026-11-20', 165, 4, 35]]);
  // The put: $10 below, the cheapest a trading day of the long expiries.
  assert.equal(p.put.expiry, '2026-11-27');
  assert.equal(p.put.strike, 135);
  assert.equal(p.put.cost_per_day, 20);
  assert.deepEqual(p.put_choices.map((x) => [x.expiry, x.strike, x.days]), [['2026-11-27', 135, 8], ['2026-12-18', 140, 23]]);
  // The difference he sorts by: the calls' average a trading day less the puts' average.
  near(p.carry.call_per_day, (150 + 35) / 2);
  near(p.carry.put_per_day, (20 + 520 / 23) / 2, 0.01);
  near(p.carry.gap, (150 + 35) / 2 - (20 + 520 / 23) / 2, 0.02);
  assert.equal(p.carry.calls, 2);
  assert.equal(p.carry.puts, 2);
  // The contracts behind the averages, with their prices, for the scanner's list (Nov 18).
  assert.deepEqual([p.carry.call.strike, p.carry.call.expiry, p.carry.call.bid, p.carry.call.per_day], [155, '2026-11-18', p.call.bid, 150]);
  assert.deepEqual([p.carry.put.strike, p.carry.put.expiry, p.carry.put.ask, p.carry.put.cost_per_day], [135, '2026-11-27', p.put.ask, 20]);
  // One lot: 100 × $150 + the $160 put. 50% of $100k → 3 lots; the loss limit decides the rest.
  assert.match(p.sizing.limits[0], /allows 3 lots/);
  assert.equal(p.sizing.lots, Number(/allows (\d+):/.exec(p.sizing.limits[1])[1]));
  assert.ok(p.sizing.lots >= 1 && p.sizing.lots <= 3);
  assert.ok(p.reasons.some((r) => /at least US\$5 above the price/.test(r) && /pays the most a trading day/.test(r)));
  assert.ok(p.reasons.some((r) => /at least US\$10 below the price/.test(r)));
  const bare = pick(ch, { capital: 100000, capital_currency: 'USD', protect: false, max_loss_pct: 3, drop_test_pct: 20, margin_pct: 100 }, { now: NOW });
  assert.equal(bare.put, null);
  assert.ok(bare.carry.put_per_day > 0, 'the comparison still prices the puts');
  assert.match(bare.sizing.limits[1], /a 20% fall with no put/);
  assert.match(pick(ch, {}, { now: NOW }).sizing.limits[0], /Set the money/);
  // His own distances: $2 out for the call, $15 for the put.
  const own = pick(ch, { call_otm: 2, put_otm: 15 }, { now: NOW });
  assert.equal(own.call.strike, 152.5);
  assert.equal(own.put.strike, 135);
});

test('in CAD (Nov 17: "I want to see outputs in cad"): capital in CAD is sized in US dollars, the words give CAD', async () => {
  const { rateFrom } = await import('../lib/options/fx.js');
  assert.deepEqual(rateFrom({ observations: [{ d: '2026-11-16', FXUSDCAD: { v: '1.4298' } }] }), { rate: 1.4298, date: '2026-11-16' });
  assert.equal(rateFrom({ observations: [] }), null);
  const ch = { quote: { price: 150 }, expiries: [], contracts: [
    { expiry: '2026-11-18', type: 'call', strike: 160, bid: 1.5, ask: 1.6, mid: 1.55, delta: 0.21, iv: 0.6 },
  ] };
  // C$43,000 at 1.43 is about US$30,070: 50% is US$15,035, one lot of US$15,000.
  const p = pick(ch, { capital: 43000, capital_currency: 'CAD', max_position_pct: 50, max_loss_pct: 50, protect: false, margin_pct: 100 }, { now: NOW, fx: 1.43 });
  assert.equal(p.sizing.lots, 1);
  assert.match(p.sizing.limits[0], /50% of \$43,000 in one name allows 1 lot at \$21,450 each/);
  assert.equal(p.usd_cad, 1.43);
  const inUsd = pick(ch, { capital: 43000, capital_currency: 'USD', max_position_pct: 50, max_loss_pct: 50, protect: false, margin_pct: 100 }, { now: NOW, fx: 1.43 });
  assert.equal(inUsd.sizing.lots, 1, 'US$21,500: still one lot');
  assert.equal(pick(ch, { capital: 31000, capital_currency: 'USD', max_position_pct: 100, max_loss_pct: 100, protect: false, margin_pct: 100 }, { now: NOW }).sizing.lots, 2);
  // A capital saved before CAD came in was US$; new rules start in CAD.
  assert.equal(cleanRules({ capital: 50000 }).capital_currency, 'USD');
  assert.equal(cleanRules({}).capital_currency, 'CAD');
});

test('rules are cleaned: symbols upper-cased and checked, numbers kept in range', () => {
  const r = cleanRules({ watchlist: ['nvda', ' tsla ', 'bad symbol!', 'NVDA'], call_otm: -3, put_otm: '12.5', protect: false });
  assert.deepEqual(r.watchlist, ['NVDA', 'TSLA']);
  assert.equal(r.call_otm, 0);
  assert.equal(r.put_otm, 12.5);
  assert.equal(cleanRules({}).call_otm, 5);
  assert.equal(cleanRules({}).put_otm, 10);
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

test('option revenue a trading day (Nov 18): each open option over the days from when it was opened to its expiry, interest off, then against capital and max loss', () => {
  const legs = [
    { type: 'call', side: 'short', strike: 160, expiry: '2026-11-20', premium: 2, contracts: 1, since: '2026-11-16' },  // 5 sessions Mon-Fri
    { type: 'put', side: 'long', strike: 135, expiry: '2026-12-18', premium: 4.6, contracts: 1, since: '2026-11-16' },   // Nov 16 to Dec 18
    { type: 'call', side: 'short', strike: 155, expiry: '2026-11-13', premium: 3, contracts: 1, since: '2026-11-09' },   // expired: not counted
  ];
  const r = evaluate({ price: 150, shares: 100, cost: 150, legs }, { now: NOW, margin: { pct: 30, rate: 5.85 } });
  const callDays = tradingDaysBetween('2026-11-16', '2026-11-20'); const putDays = tradingDaysBetween('2026-11-16', '2026-12-18');
  assert.equal(callDays, 5);
  near(r.income_per_day, 200 / callDays, 0.01);
  near(r.protection_per_day, 460 / putDays, 0.01);
  near(r.revenue_per_day, 200 / callDays - 460 / putDays - (10500 * 0.0585) / 252, 0.02);
  assert.equal(r.revenue_per_day, r.net_after_interest_per_day);
  assert.deepEqual(r.legs_counted.map((l) => [l.type, l.opened, l.days]), [['call', '2026-11-16', 5], ['put', '2026-11-16', putDays]]);
  near(r.on_capital_pct_year, (r.revenue_per_day / r.capital_needed) * 252 * 100, 0.05);
  assert.equal(r.days_to_earn_max_loss, Math.ceil(Math.abs(r.max_loss) / r.revenue_per_day));
  assert.deepEqual(playValue(10, 1000, -500), { revenue_per_day: 10, on_capital_pct_day: 1, on_capital_pct_year: 252, vs_max_loss_pct_day: 2, days_to_earn_max_loss: 50 });
  assert.equal(playValue(-5, 1000, -500).days_to_earn_max_loss, null);
});
