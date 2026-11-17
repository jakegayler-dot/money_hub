// The covered-call desk's arithmetic (Jake, Nov 17: "buy that stock and start writing call options to generate cash ... a
// calculator of the positions that show max gain and loss at certain calls and puts ... the puts will help protect huge
// swings. It should recommend call and puts and position sizing"). All pure, so it's tested without the market.
//
// A position is shares at a cost plus option legs. It's valued on the day the nearest leg expires (the short call, usually):
// legs expiring then are worth what they're in the money; a longer leg (a put bought for a month) is priced by Black-Scholes
// at its own IV for the time it has left. Max gain and loss come from that curve over every price from 0 to three times today's.
//
// "Recommend" is Jake's own rules applied, not a call on the market: the call nearest his target delta in the nearest
// expiry, the put about his chosen % below at the cheapest cost a day, and the lots his limits allow (share of his capital in
// one name, the most he'll lose on one position). Each pick says which rule chose it.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const RATE = 0.04; // risk-free rate for pricing a longer leg (roughly the US T-bill)

// ---------- time ----------
function nyOffsetMinutes(date) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(part);
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : -300;
}
/** When an option expiring on `expiry` stops trading: 4 p.m. in New York, as a Date. */
export function expiryClose(expiry) {
  const off = nyOffsetMinutes(new Date(`${expiry}T12:00:00Z`));
  return new Date(Date.parse(`${expiry}T16:00:00Z`) - off * 60e3);
}
/** Days from `now` to the close on `expiry` (fractional; negative once it has expired). */
export const daysTo = (expiry, now = new Date()) => (expiryClose(expiry) - now) / 86400e3;
/** Calendar days the premium is earned over: a 0DTE call is one day's income. */
export const incomeDays = (expiry, now = new Date()) => Math.max(1, Math.ceil(daysTo(expiry, now) - 1e-9));
/**
 * The days a leg's premium is spread over (Nov 17: his long puts "average about $17/day"): from the day it was opened
 * (leg.since, YYYY-MM-DD) to its expiry, or from now when it's being planned. A 0DTE leg is one day.
 */
export const legDays = (l, now = new Date()) => (/^\d{4}-\d{2}-\d{2}$/.test(String(l.since || ''))
  ? Math.max(1, Math.round((Date.parse(`${l.expiry}T12:00:00Z`) - Date.parse(`${l.since}T12:00:00Z`)) / 86400e3))
  : incomeDays(l.expiry, now));

// ---------- pricing ----------
function erf(x) {
  const s = Math.sign(x); const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}
export const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
const intrinsic = (type, S, K) => Math.max(0, type === 'call' ? S - K : K - S);
/** Black-Scholes value of one share's worth of option. T in years, sigma as a fraction (0.6 = 60%). */
export function bsPrice(type, S, K, T, sigma, r = RATE) {
  if (!(T > 0) || !(sigma > 0) || !(S > 0)) return intrinsic(type, S, K);
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / v;
  const d2 = d1 - v;
  const disc = K * Math.exp(-r * T);
  return type === 'call' ? S * normCdf(d1) - disc * normCdf(d2) : disc * normCdf(-d2) - S * normCdf(-d1);
}

// ---------- a position ----------
const legSign = (l) => (l.side === 'long' ? 1 : -1);
/**
 * position: { price (today's), shares, cost (per share; default today's price), legs: [{ type call|put, side short|long,
 * strike, expiry, premium (per share), contracts, iv?, delta? }] }. Returns the figures and a curve for the chart.
 */
export function evaluate(position, { now = new Date(), testPcts = [] } = {}) {
  const price = Number(position.price);
  const shares = Math.max(0, Math.round(Number(position.shares) || 0));
  const cost = Number(position.cost) > 0 ? Number(position.cost) : price;
  const legs = (position.legs || []).filter((l) => l && Number(l.strike) > 0 && Number(l.contracts) > 0).map((l) => ({
    ...l, strike: Number(l.strike), premium: Number(l.premium) || 0, contracts: Math.round(Number(l.contracts)), iv: Number(l.iv) || null,
  }));
  const horizon = legs.length ? legs.map((l) => l.expiry).sort()[0] : null;
  const valueAt = (l, S) => {
    if (!horizon || l.expiry <= horizon) return intrinsic(l.type, S, l.strike);
    const T = Math.max(0, (expiryClose(l.expiry) - expiryClose(horizon)) / (365 * 86400e3));
    return bsPrice(l.type, S, l.strike, T, l.iv || 0.5);
  };
  const pnl = (S) => (S - cost) * shares + legs.reduce((a, l) => a + legSign(l) * (valueAt(l, S) - l.premium) * l.contracts * 100, 0);

  const top = Math.max(price, cost, ...legs.map((l) => l.strike)) * 3;
  const points = new Set([0, cost, price, top, ...legs.map((l) => l.strike)]);
  for (let i = 0; i <= 900; i++) points.add((top * i) / 900);
  const grid = [...points].sort((a, b) => a - b);
  const vals = grid.map((S) => [S, pnl(S)]);
  let best = vals[0]; let worst = vals[0];
  for (const v of vals) { if (v[1] > best[1] + 1e-6) best = v; if (v[1] < worst[1] - 1e-6) worst = v; }
  const breakevens = [];
  for (let i = 1; i < vals.length; i++) {
    const [s0, p0] = vals[i - 1]; const [s1, p1] = vals[i];
    if ((p0 < 0 && p1 >= 0) || (p0 >= 0 && p1 < 0)) breakevens.push(r2(s0 + ((0 - p0) * (s1 - s0)) / (p1 - p0)));
  }
  const shortCalls = legs.filter((l) => l.type === 'call' && l.side === 'short').reduce((a, l) => a + l.contracts * 100, 0);
  const longCalls = legs.filter((l) => l.type === 'call' && l.side === 'long').reduce((a, l) => a + l.contracts * 100, 0);
  const uncovered = shortCalls > shares + longCalls;
  const rising = vals[vals.length - 1][1] - vals[vals.length - 2][1] > 1e-6;
  const credit = legs.reduce((a, l) => a - legSign(l) * l.premium * l.contracts * 100, 0);
  const premiumIn = legs.filter((l) => l.side === 'short').reduce((a, l) => a + l.premium * l.contracts * 100, 0);
  const perDay = legs.filter((l) => l.side === 'short').reduce((a, l) => a + (l.premium * l.contracts * 100) / legDays(l, now), 0);
  const costPerDay = legs.filter((l) => l.side === 'long').reduce((a, l) => a + (l.premium * l.contracts * 100) / legDays(l, now), 0);
  const stockIn = cost * shares;
  const paidOut = legs.filter((l) => l.side === 'long').reduce((a, l) => a + l.premium * l.contracts * 100, 0);
  const call = legs.find((l) => l.type === 'call' && l.side === 'short');
  const put = legs.find((l) => l.type === 'put' && l.side === 'long');
  const scenarios = [...new Set([-30, -20, -10, -5, 0, 5, 10, 20, ...testPcts])].sort((x, y) => x - y).map((pct) => ({ pct, price: r2(price * (1 + pct / 100)), pnl: r2(pnl(price * (1 + pct / 100))) }));
  const curve = [];
  for (let i = 0; i <= 80; i++) { const S = price * (0.55 + (0.9 * i) / 80); curve.push({ price: r2(S), pnl: r2(pnl(S)) }); }
  return {
    horizon, shares, cost: r2(cost), price: r2(price),
    money_in: r2(stockIn + paidOut), stock_in: r2(stockIn), premium_in: r2(premiumIn), put_cost: r2(paidOut), net_credit: r2(credit),
    income_per_day: r2(perDay), protection_per_day: r2(costPerDay), net_per_day: r2(perDay - costPerDay),
    max_gain: uncovered || rising ? null : r2(best[1]), max_gain_at: uncovered || rising ? null : r2(best[0]),
    max_loss: uncovered ? null : r2(worst[1]), max_loss_at: uncovered ? null : r2(worst[0]),
    unlimited_gain: !uncovered && rising, uncovered,
    breakevens,
    called_away_chance: call?.delta != null ? r2(Math.abs(call.delta) * 100) : null,
    put_pays_chance: put?.delta != null ? r2(Math.abs(put.delta) * 100) : null,
    call_yield_pct: call && stockIn ? r2(((call.premium * call.contracts * 100) / stockIn) * 100) : null,
    call_yield_annual_pct: call && stockIn ? r2(((call.premium * call.contracts * 100) / stockIn) * (365 / incomeDays(call.expiry, now)) * 100) : null,
    scenarios, curve,
  };
}

// ---------- Jake's rules ----------
export const DEFAULT_RULES = {
  watchlist: ['NVDA', 'TSLA', 'AAPL', 'AMZN', 'META', 'MSFT', 'GOOGL', 'AMD', 'AVGO', 'PLTR', 'NFLX', 'SPY', 'QQQ'],
  drop_day_pct: 3,          // a fall of this much in a day flags it
  drop_from_high_pct: 8,    // or this far below its highest close of the last high_days
  high_days: 20,
  capital: 0,               // the money set aside for this; 0 until he sets it
  capital_currency: 'CAD',  // what capital is in (Nov 17: "I want to see outputs in cad"); a capital saved before then was US$
  max_position_pct: 25,     // most of it in one name
  max_loss_pct: 5,          // most he'll lose on one position, as % of the capital
  target_delta: 0.2,        // the call: about a 1-in-5 chance of being called away
  delta_min: 0.1, delta_max: 0.35,
  call_max_days: 3,         // 0DTE to 3 days
  protect: true,            // buy a put
  put_below_pct: 10,        // about this far below today's price
  put_days_min: 7, put_days_max: 45,
  drop_test_pct: 20,        // without a put, the fall the loss limit is checked against
};
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export function cleanRules(r = {}) {
  const d = DEFAULT_RULES;
  const list = Array.isArray(r.watchlist) ? r.watchlist : d.watchlist;
  return {
    watchlist: [...new Set(list.map((s) => String(s || '').trim().toUpperCase()).filter((s) => /^[A-Z]{1,6}$/.test(s)))].slice(0, 30),
    drop_day_pct: num(r.drop_day_pct, 0.5, 50, d.drop_day_pct),
    drop_from_high_pct: num(r.drop_from_high_pct, 1, 80, d.drop_from_high_pct),
    high_days: Math.round(num(r.high_days, 5, 120, d.high_days)),
    capital: num(r.capital, 0, 1e9, d.capital),
    capital_currency: ['CAD', 'USD'].includes(r.capital_currency) ? r.capital_currency : (Number(r.capital) > 0 ? 'USD' : d.capital_currency),
    max_position_pct: num(r.max_position_pct, 1, 100, d.max_position_pct),
    max_loss_pct: num(r.max_loss_pct, 0.1, 100, d.max_loss_pct),
    target_delta: num(r.target_delta, 0.02, 0.6, d.target_delta),
    delta_min: num(r.delta_min, 0.01, 0.6, d.delta_min),
    delta_max: num(r.delta_max, 0.02, 0.9, d.delta_max),
    call_max_days: Math.round(num(r.call_max_days, 0, 60, d.call_max_days)),
    protect: r.protect == null ? d.protect : !!r.protect,
    put_below_pct: num(r.put_below_pct, 0, 50, d.put_below_pct),
    put_days_min: Math.round(num(r.put_days_min, 0, 365, d.put_days_min)),
    put_days_max: Math.round(num(r.put_days_max, 1, 730, d.put_days_max)),
    drop_test_pct: num(r.drop_test_pct, 1, 90, d.drop_test_pct),
  };
}

/** Has the stock dropped by his rule? history: daily closes oldest first (may include today); q: today's quote. */
export function dropCheck(hist, q, rules) {
  const before = hist.filter((h) => !q.as_of || h.date < q.as_of.slice(0, 10)).slice(-rules.high_days);
  const high = before.length ? Math.max(...before.map((h) => h.close)) : null;
  const fiveAgo = before.length >= 5 ? before[before.length - 5].close : null;
  const fromHigh = high ? ((q.price - high) / high) * 100 : null;
  const day = Number.isFinite(q.change_pct) ? q.change_pct : null;
  const why = [];
  if (day != null && day <= -rules.drop_day_pct) why.push(`down ${r2(-day)}% today`);
  if (fromHigh != null && fromHigh <= -rules.drop_from_high_pct) why.push(`${r2(-fromHigh)}% below its ${rules.high_days}-day high of US$${r2(high)}`);
  return {
    day_pct: day == null ? null : r2(day), high: high == null ? null : r2(high), from_high_pct: fromHigh == null ? null : r2(fromHigh),
    five_day_pct: fiveAgo ? r2(((q.price - fiveAgo) / fiveAgo) * 100) : null, triggered: why.length > 0, why,
  };
}

/** Expiries in the next `days` calendar days (still open). */
export const soonExpiries = (expiries, days = 7, now = new Date()) => expiries.filter((e) => daysTo(e, now) > 0 && daysTo(e, now) <= days);

/** The legs his rules pick from a chain, and the lots his limits allow. ch from market.chainFrom. */
// fx: CAD per US dollar. The contracts are in US dollars; capital in CAD is turned into US dollars to size, and the sizing's
// words give money in CAD when fx is known.
export function pick(ch, rulesIn, { now = new Date(), fx = null } = {}) {
  const rules = cleanRules(rulesIn);
  const rate = Number(fx) > 0 ? Number(fx) : null;
  const capCad = rules.capital_currency === 'CAD';
  const capital = capCad && rate ? rules.capital / rate : rules.capital; // US$ (CAD capital without a rate: taken at par, said below)
  const money = (usdAmt) => (rate ? `$${Math.round(usdAmt * rate).toLocaleString('en-US')}` : `US$${Math.round(usdAmt).toLocaleString('en-US')}`);
  const price = ch.quote.price;
  const open = ch.contracts.filter((c) => daysTo(c.expiry, now) > 0);
  // The call: out of the money, a bid, delta in his band; per expiry the one nearest his target.
  const calls = open.filter((c) => c.type === 'call' && c.strike > price && c.bid >= 0.05 && c.delta != null
    && c.delta >= rules.delta_min && c.delta <= rules.delta_max && daysTo(c.expiry, now) <= rules.call_max_days + 1);
  const byExp = new Map();
  for (const c of calls) {
    const cur = byExp.get(c.expiry);
    if (!cur || Math.abs(c.delta - rules.target_delta) < Math.abs(cur.delta - rules.target_delta)) byExp.set(c.expiry, c);
  }
  const callChoices = [...byExp.values()].sort((a, b) => (a.expiry < b.expiry ? -1 : 1)).slice(0, 4)
    .map((c) => ({ ...c, days: incomeDays(c.expiry, now), per_day: r2((c.bid * 100) / incomeDays(c.expiry, now)) }));
  const call = callChoices[0] || null;

  // The put: about put_below_pct under today's price, cheapest a day among the expiries in his window.
  let put = null; let putChoices = [];
  if (rules.protect) {
    const want = price * (1 - rules.put_below_pct / 100);
    const puts = open.filter((c) => c.type === 'put' && c.ask > 0 && c.strike <= price
      && daysTo(c.expiry, now) >= rules.put_days_min && daysTo(c.expiry, now) <= rules.put_days_max + 1);
    const best = new Map();
    for (const p of puts) {
      const cur = best.get(p.expiry);
      if (!cur || Math.abs(p.strike - want) < Math.abs(cur.strike - want)) best.set(p.expiry, p);
    }
    putChoices = [...best.values()].map((p) => ({ ...p, days: incomeDays(p.expiry, now), cost_per_day: r2((p.ask * 100) / incomeDays(p.expiry, now)) }))
      .sort((a, b) => a.cost_per_day - b.cost_per_day).slice(0, 4);
    put = putChoices[0] || null;
  }

  // One lot (100 shares) bought today with these legs, at the prices you'd likely trade: sell the call at the bid, buy the put at the ask.
  const legs = [];
  if (call) legs.push({ type: 'call', side: 'short', strike: call.strike, expiry: call.expiry, premium: call.bid, contracts: 1, iv: call.iv, delta: call.delta });
  if (put) legs.push({ type: 'put', side: 'long', strike: put.strike, expiry: put.expiry, premium: put.ask, contracts: 1, iv: put.iv, delta: put.delta });
  const lot = evaluate({ price, shares: 100, cost: price, legs }, { now, testPcts: [-rules.drop_test_pct] });
  const lossPerLot = Math.max(0.01, -Math.min(0, put ? lot.max_loss : lot.scenarios.find((s) => s.pct === -rules.drop_test_pct).pnl));
  const perLotMoney = price * 100 + (put ? put.ask * 100 : 0);
  const sizing = { lots: 0, shares: 0, limits: [], money_in: 0 };
  if (!(capital > 0)) {
    sizing.limits.push('Set the money you’d put into this (Capital) to size it.');
  } else {
    const byPosition = Math.floor((capital * rules.max_position_pct / 100) / perLotMoney);
    const lossLabel = put ? 'its worst case with the put' : `a ${rules.drop_test_pct}% fall with no put`;
    const byLoss = Math.floor((capital * rules.max_loss_pct / 100) / lossPerLot);
    sizing.lots = Math.max(0, Math.min(byPosition, byLoss));
    sizing.shares = sizing.lots * 100;
    sizing.money_in = r2(sizing.lots * perLotMoney);
    sizing.limits.push(`${rules.max_position_pct}% of ${money(capital)} in one name allows ${byPosition} lot${byPosition === 1 ? '' : 's'} at ${money(perLotMoney)} each.`);
    sizing.limits.push(`Losing at most ${rules.max_loss_pct}% (${money(capital * rules.max_loss_pct / 100)}) allows ${byLoss}: ${lossLabel} is ${money(lossPerLot)} a lot.`);
    if (capCad && !rate) sizing.limits.push('The exchange rate couldn’t be had, so your CAD capital was taken as US dollars.');
    if (!sizing.lots) sizing.limits.push('Not one lot fits these limits.');
  }
  const reasons = [];
  if (call) reasons.push(`Call: the ${call.expiry} expiry, nearest your ${rules.target_delta} delta target (delta ${r2(call.delta)}: about a ${Math.round(call.delta * 100)}% chance it ends in the money).`);
  else reasons.push(`No call fits: none within ${rules.call_max_days} days with a delta of ${rules.delta_min} to ${rules.delta_max} and a bid.`);
  if (rules.protect) {
    if (put) reasons.push(`Put: about ${rules.put_below_pct}% below today’s price, the cheapest a day of the expiries ${rules.put_days_min} to ${rules.put_days_max} days out.`);
    else reasons.push(`No put fits: none ${rules.put_days_min} to ${rules.put_days_max} days out near ${rules.put_below_pct}% below.`);
  }
  return { rules, price, call, put, call_choices: callChoices, put_choices: putChoices, lot, sizing, reasons, usd_cad: rate };
}
