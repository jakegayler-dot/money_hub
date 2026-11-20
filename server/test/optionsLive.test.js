// The options desk since Nov 20 (Jake: "it now uses put spreads ... notifications on stocks, gamma, theta, etc. any big moves"):
// the greeks, an old option price brought to now, put spreads of both kinds, and the notes the watcher raises. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bsPrice, bsGreeks, impliedVol, nowFrom, putStructure, positionGreeks, evaluate, spreadChoices, cleanRules } from '../lib/options/strategy.js';
import { moveAlerts, swingAlerts, positionAlerts, ivAlerts } from '../lib/options/alerts.js';

const NOW = new Date('2026-11-17T15:30:00Z'); // a Tuesday, 10:30 in New York
const near = (a, b, d = 0.01) => assert.ok(Math.abs(a - b) <= d, `${a} ≈ ${b}`);
const RULES = cleanRules({});

test('the greeks: delta is the price’s slope, gamma is delta’s, a put’s delta is the call’s less one, time takes value away', () => {
  const [S, K, T, v] = [150, 155, 30 / 365, 0.5];
  const c = bsGreeks('call', S, K, T, v); const p = bsGreeks('put', S, K, T, v);
  near(c.delta, (bsPrice('call', S + 0.01, K, T, v) - bsPrice('call', S - 0.01, K, T, v)) / 0.02, 0.001);
  near(c.gamma, (bsGreeks('call', S + 0.01, K, T, v).delta - bsGreeks('call', S - 0.01, K, T, v).delta) / 0.02, 0.0005);
  near(p.delta, c.delta - 1, 1e-9);
  near(c.gamma, p.gamma, 1e-9);
  assert.ok(c.theta < 0 && p.theta < 0);
  near(c.theta, bsPrice('call', S, K, T - 1 / 365, v) - bsPrice('call', S, K, T, v), 0.01); // a day's decay
  near(c.vega, bsPrice('call', S, K, T, v + 0.01) - bsPrice('call', S, K, T, v), 0.005);     // a volatility point
  // At expiry an option is what it's in the money: delta 0 or 1, nothing else.
  assert.deepEqual(bsGreeks('call', 160, 155, 0, v), { delta: 1, gamma: 0, theta: 0, vega: 0 });
  assert.deepEqual(bsGreeks('put', 160, 155, 0, v), { delta: 0, gamma: 0, theta: 0, vega: 0 });
  // The volatility a price implies comes back out.
  near(impliedVol('put', bsPrice('put', S, 140, T, 0.62), S, 140, T), 0.62, 0.001);
  assert.equal(impliedVol('call', 5, 160, 155, T), null); // at its intrinsic value: no time value to read
});

test('a day-old option price is brought to today’s stock price by its own volatility, and says so', () => {
  // Quoted at yesterday's close with the stock at 146; the stock is 135 now (Nov 20: NVDA down 7%).
  const call = { type: 'call', strike: 144, expiry: '2026-11-20', bid: 4.9, ask: 5.1, mid: 5, iv: 0.6, delta: 0.62, underlying_price: 146, as_of: '2026-11-16T21:00:00.000Z' };
  const n = nowFrom(call, 135, NOW);
  assert.equal(n.modelled, true);
  assert.ok(n.mid < 1, `far out of the money now: ${n.mid}`);
  assert.ok(n.delta < 0.2 && n.delta > 0);
  near(n.ask - n.bid, 0.2, 0.25); // the quote's spread, kept (narrowed when the price is small)
  assert.deepEqual([n.quoted.bid, n.quoted.ask, n.quoted.underlying_price], [4.9, 5.1, 146]);
  // A quote from a few minutes ago with the stock where it was stands as quoted.
  const fresh = nowFrom({ ...call, as_of: '2026-11-17T15:25:00.000Z' }, 146.1, NOW);
  assert.equal(fresh.modelled, false);
  assert.equal(fresh.bid, 4.9);
  // No volatility on the quote: read from its price.
  const noIv = nowFrom({ ...call, iv: null, delta: null }, 135, NOW);
  assert.ok(noIv.iv > 0.2 && noIv.modelled);
  // Past its expiry it's what it's in the money.
  assert.equal(nowFrom({ ...call, expiry: '2026-11-16' }, 150, NOW).mid, 6);
});

test('put spreads, both kinds: insurance (bought above sold) and income (sold above bought)', () => {
  const legs = [
    { type: 'put', side: 'long', strike: 145, expiry: '2026-12-31', premium: 7.55, contracts: 1 },
    { type: 'put', side: 'short', strike: 135, expiry: '2026-12-31', premium: 3.2, contracts: 1 },
    { type: 'put', side: 'short', strike: 130, expiry: '2026-11-27', premium: 2, contracts: 2 },
    { type: 'put', side: 'long', strike: 120, expiry: '2026-11-27', premium: 0.8, contracts: 2 },
    { type: 'put', side: 'long', strike: 110, expiry: '2027-01-15', premium: 1, contracts: 1 },
    { type: 'call', side: 'short', strike: 160, expiry: '2026-11-20', premium: 2, contracts: 1 },
  ];
  const s = putStructure(legs);
  const ins = s.spreads.find((x) => x.kind === 'insurance');
  assert.deepEqual([ins.long_strike, ins.short_strike, ins.width, ins.cost, ins.most_it_pays, ins.covers_to], [145, 135, 10, 435, 565, 135]);
  const inc = s.spreads.find((x) => x.kind === 'income');
  assert.deepEqual([inc.short_strike, inc.long_strike, inc.contracts, inc.credit, inc.max_loss, inc.breakeven], [130, 120, 2, 240, -1760, 128.8]);
  assert.deepEqual(s.plain_puts.map((p) => p.strike), [110]);
  assert.deepEqual(s.sold_puts, []);
  // A sold put with nothing under it is a promise to buy.
  assert.deepEqual(putStructure([{ type: 'put', side: 'short', strike: 130, expiry: '2026-11-27', premium: 2, contracts: 1 }]).sold_puts[0].buys_shares, 100);
});

test('a position with an insurance spread: protection ends at the sold strike, and the loss below it is counted', () => {
  const base = { price: 150, shares: 100, cost: 150 };
  const long = { type: 'put', side: 'long', strike: 145, expiry: '2026-12-31', premium: 7, contracts: 1, iv: 0.5 };
  const plain = evaluate({ ...base, legs: [long] }, { now: NOW });
  assert.equal(plain.falls_to_zero, false);
  assert.equal(plain.protection_ends, null);
  near(plain.max_loss, -1200); // 5 down to the strike, 7 for the put
  const spread = evaluate({ ...base, legs: [long, { type: 'put', side: 'short', strike: 135, expiry: '2026-12-31', premium: 3, contracts: 1, iv: 0.55 }] }, { now: NOW });
  assert.equal(spread.protection_ends, 135);
  assert.equal(spread.falls_to_zero, true);
  near(spread.loss_at_protection_end, -900);  // −1,500 on the shares, +1,000 from the spread, −400 it cost
  near(spread.loss_at_zero, -14400);
  near(spread.max_loss, -14400);
  assert.equal(spread.floor_from, null);       // no floor: it keeps falling under 135
  assert.equal(spread.put_spreads[0].kind, 'insurance');
  assert.ok(spread.per_day_by_role.insurance < 0 && spread.per_day_by_role.insurance > plain.per_day_by_role.insurance); // cheaper a day than the single put
  // An income spread by itself: the credit, and a loss capped at the gap less the credit.
  const income = evaluate({ price: 150, shares: 0, cost: 150, legs: [
    { type: 'put', side: 'short', strike: 130, expiry: '2026-11-27', premium: 2, contracts: 1, iv: 0.5 },
    { type: 'put', side: 'long', strike: 120, expiry: '2026-11-27', premium: 0.8, contracts: 1, iv: 0.55 }] }, { now: NOW });
  near(income.max_loss, -880);
  near(income.max_gain, 120);
  assert.ok(income.per_day_by_role.income_spreads > 0 && income.per_day_by_role.insurance === 0);
  assert.deepEqual(income.breakevens, [128.8]);
  // The chart carries today's line beside the expiry's.
  assert.ok(spread.curve.every((p) => Number.isFinite(p.now) && Number.isFinite(p.held)));
});

test('spread choices: each bought at the ask and sold at the bid, the strikes his width apart', () => {
  const puts = [150, 145, 140, 135, 130, 125].map((strike, i) => ({ type: 'put', strike, bid: [9, 6.4, 4.4, 3, 2, 1.3][i], ask: [9.4, 6.8, 4.7, 3.2, 2.2, 1.5][i], delta: -[0.5, 0.4, 0.31, 0.23, 0.16, 0.11][i], iv: 0.5 }));
  const ins = spreadChoices(puts, { price: 152, kind: 'insurance', width: 10, otm: 5, expiry: '2026-12-31', now: NOW });
  assert.deepEqual(ins.map((r) => [r.high_strike, r.low_strike]), [[145, 135], [140, 130], [135, 125]]);
  assert.deepEqual([ins[0].debit, ins[0].cost, ins[0].most_it_pays, ins[0].plain_put_cost, ins[0].saves, ins[0].protection_ends], [3.8, 380, 620, 680, 300, 135]);
  const inc = spreadChoices(puts, { price: 152, kind: 'income', width: 10, otm: 10, expiry: '2026-12-31', now: NOW });
  assert.deepEqual([inc[0].high_strike, inc[0].low_strike, inc[0].credit, inc[0].income, inc[0].max_loss, inc[0].breakeven, inc[0].chance_tested], [140, 130, 2.2, 220, -780, 137.8, 31]);
  near(inc[0].return_on_risk_pct, 28.21);
  assert.deepEqual(spreadChoices(puts, { price: 152, kind: 'income', width: 60, expiry: '2026-12-31', now: NOW }), []);
});

test('a position’s greeks, in shares and dollars', () => {
  const g = positionGreeks({ price: 150, shares: 100, legs: [
    { type: 'call', side: 'short', strike: 152, expiry: '2026-11-18', premium: 2.5, contracts: 1, iv: 0.6 },
    { type: 'put', side: 'long', strike: 140, expiry: '2026-12-31', premium: 6, contracts: 1, iv: 0.55 }] }, NOW);
  assert.ok(g.delta < 100 && g.delta > 20, `the sold call and the put both take delta off: ${g.delta}`);
  assert.ok(g.gamma < 0, 'a sold call a day from expiry is the gamma');
  assert.ok(g.theta > 0, 'time is paying him');
  near(g.per_1pct, g.delta * 1.5, 0.01);
  const call = g.legs[0];
  assert.equal(call.side, 'short');
  assert.ok(call.earned_pct != null && call.left_to_earn >= 0);
  assert.equal(g.iv_assumed, false);
  assert.equal(positionGreeks({ price: 150, shares: 100, legs: [{ type: 'call', side: 'short', strike: 152, expiry: '2026-11-18', premium: 2.5, contracts: 1 }] }, NOW).iv_assumed, true);
});

test('the watcher’s notes: big moves, strikes reached, the spread’s end, gamma, theta, expiry day; each said once', () => {
  const date = '2026-11-17';
  // A move: at his level, twice it and three times it are three notes; under it, none.
  assert.deepEqual(moveAlerts({ symbol: 'NVDA', price: 140, day_pct: -2.9, change: -4 }, RULES, { date }), []);
  const m = moveAlerts({ symbol: 'NVDA', price: 135.2, day_pct: -7.4, change: -10.8 }, RULES, { date, held: { shares: 100, delta: 62 }, fx: 1.4 });
  assert.equal(m[0].id, 'NVDA:move:down2:2026-11-17');
  assert.equal(m[0].level, 'high');
  assert.match(m[0].text, /down 7\.4% today at US\$135\.20\. Your 100 shares are −\$1,512 on the day; with the options, the position moves about \$87 for each US\$1/);
  assert.equal(moveAlerts({ symbol: 'TSLA', price: 300, day_pct: 3.2, change: 9 }, RULES, { date })[0].level, 'info'); // watched, not held
  assert.deepEqual(moveAlerts({ symbol: 'NVDA', price: 135, day_pct: -7.4 }, cleanRules({ alerts_off: ['move'] }), { date }), []);

  // His position: 100 shares, a call sold at 144 expiring today, a 145/135 put spread, the stock at 135.60.
  const legs = [
    { type: 'call', side: 'short', strike: 144, expiry: date, premium: 5.36, contracts: 1, iv: 0.7 },
    { type: 'put', side: 'long', strike: 145, expiry: '2026-12-31', premium: 7.55, contracts: 1, iv: 0.6 },
    { type: 'put', side: 'short', strike: 135, expiry: '2026-12-31', premium: 3.2, contracts: 1, iv: 0.62 }];
  const fig = evaluate({ price: 135.6, shares: 100, cost: 159.84, legs }, { now: NOW });
  const p = { symbol: 'NVDA', shares: 100, price: 135.6, greeks: fig.greeks, figures: fig };
  const notes = positionAlerts(p, RULES, { date, fx: 1.4 });
  const kinds = notes.map((n) => n.id);
  assert.ok(kinds.includes('NVDA:spread:near:135:2026-11-17'), kinds.join(' '));
  assert.ok(kinds.includes('NVDA:put:under:145:2026-11-17'));
  assert.ok(kinds.includes('NVDA:expiry:2026-11-17'));
  assert.ok(kinds.some((k) => k.startsWith('NVDA:theta:call:144')), 'the 144 call is nearly all earned');
  assert.ok(!kinds.some((k) => k.startsWith('NVDA:call:')), 'the call is far from its strike');
  assert.match(notes.find((n) => n.kind === 'spread').text, /above 135, where your 145\/135 put spread stops paying\. Below 135 the shares fall unprotected/);
  assert.match(notes.find((n) => n.kind === 'expiry').text, /the 144 call you sold is US\$8\.40 out of the money/);
  // Under the sold strike the spread has paid all it can.
  const under = evaluate({ price: 131, shares: 100, cost: 159.84, legs }, { now: NOW });
  const ended = positionAlerts({ symbol: 'NVDA', shares: 100, price: 131, greeks: under.greeks, figures: under }, RULES, { date });
  assert.ok(ended.some((n) => n.id === 'NVDA:spread:ended:135:2026-11-17' && /has paid all it can/.test(n.text)));
  assert.ok(!ended.some((n) => n.kind === 'put'), 'under the spread the put note gives way to the spread’s');
  // Through the call's strike on its last day: the call and the gamma.
  const over = evaluate({ price: 144.6, shares: 100, cost: 159.84, legs }, { now: NOW });
  const hot = positionAlerts({ symbol: 'NVDA', shares: 100, price: 144.6, greeks: over.greeks, figures: over }, RULES, { date });
  assert.ok(hot.some((n) => n.id === 'NVDA:call:over:144:2026-11-17:2026-11-17' && n.level === 'high'));
  assert.ok(Math.abs(over.greeks.gamma) >= RULES.alert_gamma && hot.some((n) => n.kind === 'gamma'), `gamma ${over.greeks.gamma}`);
  // A kind he's turned off isn't raised.
  assert.ok(!positionAlerts({ symbol: 'NVDA', shares: 100, price: 144.6, greeks: over.greeks, figures: over }, cleanRules({ alerts_off: ['gamma', 'call'] }), { date }).some((n) => ['gamma', 'call'].includes(n.kind)));
  // A put spread sold for income, the stock at its sold strike.
  const inc = evaluate({ price: 130.5, shares: 0, cost: 130.5, legs: [
    { type: 'put', side: 'short', strike: 130, expiry: '2026-11-27', premium: 2, contracts: 1, iv: 0.5 },
    { type: 'put', side: 'long', strike: 120, expiry: '2026-11-27', premium: 0.8, contracts: 1, iv: 0.55 }] }, { now: NOW });
  const t = positionAlerts({ symbol: 'AMD', shares: 0, price: 130.5, greeks: inc.greeks, figures: inc }, RULES, { date, fx: 1.4 });
  assert.match(t.find((n) => n.kind === 'spread').text, /above the 130\/120 put spread you sold .* The most the spread can lose is \$1,232, below 120/);
});

test('a fast move inside half an hour, and a jump in implied volatility', () => {
  const t0 = Date.parse('2026-11-17T15:00:00Z');
  const bars = [140, 140.2, 139.8, 139, 138.4, 137.9, 137.4].map((price, i) => ({ t: t0 + i * 5 * 60e3, price }));
  const s = swingAlerts('NVDA', bars, RULES, { date: '2026-11-17', now: new Date(t0 + 32 * 60e3) });
  assert.equal(s.length, 1);
  assert.match(s[0].title, /NVDA fell 1\.9% in 30 minutes/);
  assert.deepEqual(swingAlerts('NVDA', bars, RULES, { date: '2026-11-17', now: new Date(t0 + 3 * 3600e3) }), []); // the bars stopped: shut
  assert.deepEqual(swingAlerts('NVDA', bars.map((b) => ({ ...b, price: 140 })), RULES, { date: '2026-11-17', now: new Date(t0 + 32 * 60e3) }), []);
  const leg = { type: 'call', strike: 144, expiry: '2026-11-20', iv: 68, iv_assumed: false };
  const first = ivAlerts('NVDA', [leg], {}, RULES, { date: '2026-11-17' });
  assert.deepEqual(first.alerts, []);
  const jump = ivAlerts('NVDA', [{ ...leg, iv: 75 }], first.seen, RULES, { date: '2026-11-17' });
  assert.match(jump.alerts[0].text, /went from 68% to 75%/);
  assert.equal(ivAlerts('NVDA', [{ ...leg, iv: 70 }], first.seen, RULES, { date: '2026-11-17' }).alerts.length, 0);
});
