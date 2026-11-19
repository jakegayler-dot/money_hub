// The covered-call desk's arithmetic (Jake, Nov 17: "buy that stock and start writing call options to generate cash ... a
// calculator of the positions that show max gain and loss at certain calls and puts ... the puts will help protect huge
// swings. It should recommend call and puts and position sizing"). All pure, so it's tested without the market.
//
// A position is shares at a cost plus option legs. It's valued on the day the nearest leg expires (the short call, usually):
// legs expiring then are worth what they're in the money; a longer leg (a put bought for a month) is priced by Black-Scholes
// at its own IV for the time it has left. Max gain and loss come from that curve over every price from 0 to three times today's.
//
// "Recommend" is Jake's own rules applied, not a call on the market (Nov 17: "avg put daily cost (on trading days) on long
// horizon puts that are $10 otm, and avg short term daily calls $5 otm ... advise me on the next call that maximizes my daily
// return"): the call at least his dollars above the price that pays the most a trading day among the short expiries, the put
// at least his dollars below at the least cost a trading day among the long ones, and the lots his limits allow (share of his
// capital in one name, the most he'll lose on one position). Each pick says which rule chose it. Every "a day" is a trading day.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const RATE = 0.04; // risk-free rate for pricing a longer leg (roughly the US T-bill)

// ---------- time ----------
function nyOffsetMinutes(date) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(part);
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : -300;
}
/** When an option expiring on `expiry` stops trading: 4 p.m. in New York (1 p.m. on an early close), as a Date. */
export function expiryClose(expiry) {
  const off = nyOffsetMinutes(new Date(`${expiry}T12:00:00Z`));
  return new Date(Date.parse(`${expiry}T${EARLY_CLOSES[expiry] ? '13' : '16'}:00:00Z`) - off * 60e3);
}
/** Days from `now` to the close on `expiry` (fractional; negative once it has expired). */
export const daysTo = (expiry, now = new Date()) => (expiryClose(expiry) - now) / 86400e3;
/**
 * How often a stock's options expire (Jake, Nov 17: "i said options expiring at most every 3 days, not an option expiring
 * within 3 days"): the shortest and longest gap, in calendar days, between its next four expiries. Monday/Wednesday/Friday
 * is 2 to 3, daily is 1 to 3 (over the weekend), weekly is 7. Null with fewer than three expiries ahead.
 */
export function expiryCadence(expiries, now = new Date()) {
  const up = [...expiries].filter((e) => daysTo(e, now) > 0).sort().slice(0, 4);
  if (up.length < 3) return null;
  const gaps = up.slice(1).map((e, i) => Math.round((Date.parse(`${e}T12:00:00Z`) - Date.parse(`${up[i]}T12:00:00Z`)) / 86400e3));
  return { min: Math.min(...gaps), max: Math.max(...gaps) };
}
/** Calendar days to the expiry in New York (Tuesday to Friday is 3). */
export const calendarDays = (expiry, now = new Date()) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  return Math.round((Date.parse(`${expiry}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400e3);
};
// Trading days (Jake, Nov 17: "avg put daily cost (on trading days)"; the puts are "a fixed cost that needs to be extracted
// over the remaining trading days"): weekdays the US market is open. Full-day closures from the NYSE's published calendar
// for 2026 and 2027 (its December 2025 release); beyond that, weekdays.
const HOLIDAYS = new Set(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);
// Early closes (1 p.m. New York) from the same NYSE calendar: the day after Thanksgiving and Christmas Eve 2026, the day
// after Thanksgiving 2027 (Christmas Eve 2027 is the Christmas holiday itself).
export const EARLY_CLOSES = { '2026-11-27': '13:00', '2026-12-24': '13:00', '2027-11-26': '13:00' };
const HOLIDAY_NAMES = {
  '2026-01-01': "New Year's Day", '2026-01-19': 'Martin Luther King Jr. Day', '2026-02-16': "Washington's Birthday", '2026-04-03': 'Good Friday',
  '2026-05-25': 'Memorial Day', '2026-06-19': 'Juneteenth', '2026-07-03': 'Independence Day (observed)', '2026-09-07': 'Labor Day',
  '2026-11-26': 'Thanksgiving', '2026-12-25': 'Christmas', '2027-01-01': "New Year's Day", '2027-01-18': 'Martin Luther King Jr. Day',
  '2027-02-15': "Washington's Birthday", '2027-03-26': 'Good Friday', '2027-05-31': 'Memorial Day', '2027-06-18': 'Juneteenth (observed)',
  '2027-07-05': 'Independence Day (observed)', '2027-09-06': 'Labor Day', '2027-11-25': 'Thanksgiving', '2027-12-24': 'Christmas (observed)',
};
/**
 * The US market's calendar for a page's clock (Jake, Nov 18: "add trading hours ... with live time, and time till open time
 * till close"): regular session 9:30 to 4 p.m. New York (options trade only then), pre-market from 4 a.m., after hours to
 * 8 p.m.; full closures and early closes as published. The page works out open/closed and the countdowns itself.
 */
export function marketCalendar() {
  return {
    zone: 'America/New_York', regular: { open: '09:30', close: '16:00' }, pre: { open: '04:00' }, after: { close: '20:00' },
    holidays: [...HOLIDAYS].sort().map((d) => ({ date: d, name: HOLIDAY_NAMES[d] || null })),
    early_closes: Object.entries(EARLY_CLOSES).map(([date, close]) => ({ date, close })),
    known_to: [...HOLIDAYS].sort().at(-1).slice(0, 4) + '-12-31',
    source: "NYSE's published holiday and early-closing calendar (2026 and 2027)",
  };
}
const nyDate = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
const nextDate = (iso) => new Date(Date.parse(`${iso}T12:00:00Z`) + 86400e3).toISOString().slice(0, 10);
export const isTradingDay = (iso) => { const d = new Date(`${iso}T12:00:00Z`).getUTCDay(); return d !== 0 && d !== 6 && !HOLIDAYS.has(iso); };
/** Trading days from one date to another, both counted. */
export function tradingDaysBetween(from, to) {
  let n = 0;
  for (let d = from, i = 0; d <= to && i < 4000; d = nextDate(d), i++) if (isTradingDay(d)) n += 1;
  return n;
}
/** The first session still to come: today while it's open, else the next trading day. */
const firstSession = (now) => {
  let d = nyDate(now);
  if (!(isTradingDay(d) && now < expiryClose(d))) d = nextDate(d);
  for (let i = 0; i < 10 && !isTradingDay(d); i++) d = nextDate(d);
  return d;
};
/** Trading days the premium is earned over, from now to the expiry (today counts while its session is open): a 0DTE call is one. */
export const incomeDays = (expiry, now = new Date()) => Math.max(1, tradingDaysBetween(firstSession(now), expiry));
/** The date `n` trading days from now (1 = the first session still to come). */
export function sessionDate(n, now = new Date()) {
  let d = firstSession(now);
  for (let k = 1; k < n; k++) { d = nextDate(d); for (let i = 0; i < 10 && !isTradingDay(d); i++) d = nextDate(d); }
  return d;
}
/** Calendar days to the expiry, rounded up (what margin interest runs over). */
export const calendarSpan = (expiry, now = new Date()) => Math.max(1, Math.ceil(daysTo(expiry, now) - 1e-9));
/**
 * The trading days a leg's premium is spread over (Nov 17: his long puts "average about $17/day"): from the day it was
 * opened (leg.since, YYYY-MM-DD) to its expiry, or from now when it's being planned. A 0DTE leg is one day.
 */
export const legDays = (l, now = new Date()) => (/^\d{4}-\d{2}-\d{2}$/.test(String(l.since || ''))
  ? Math.max(1, tradingDaysBetween(l.since, l.expiry))
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
// margin { pct, rate } (Nov 17: "determine required capital at 30% margin, factor in interest costs"): he puts up pct% of the
// shares and borrows the rest at rate% a year; options are paid in full. The interest to the nearest expiry is in every
// profit-or-loss figure; pct 100 is a cash account.
export const marginOf = (r = {}) => ({ pct: num(r.margin_pct, 25, 100, 100), rate: num(r.margin_rate, 0, 30, 0) });
export const TRADING_DAYS_A_YEAR = 252;
/** Option revenue a trading day against the capital it ties up and the most it can lose (pure). */
export function playValue(revenuePerDay, capital, maxLoss) {
  const rev = Number(revenuePerDay); const cap = Number(capital); const loss = maxLoss == null ? null : Math.abs(Math.min(0, Number(maxLoss)));
  return {
    revenue_per_day: r2(rev),
    on_capital_pct_day: cap > 0 ? Math.round((rev / cap) * 1e6) / 1e4 : null,
    on_capital_pct_year: cap > 0 ? r2((rev / cap) * TRADING_DAYS_A_YEAR * 100) : null,
    vs_max_loss_pct_day: loss ? Math.round((rev / loss) * 1e6) / 1e4 : null,
    days_to_earn_max_loss: loss && rev > 0 ? Math.ceil(loss / rev) : null,
  };
}

export function evaluate(position, { now = new Date(), testPcts = [], margin = null } = {}) {
  const price = Number(position.price);
  const shares = Math.max(0, Math.round(Number(position.shares) || 0));
  const cost = Number(position.cost) > 0 ? Number(position.cost) : price;
  const m = marginOf(margin ? { margin_pct: margin.pct, margin_rate: margin.rate } : {});
  const borrowed = cost * shares * (1 - m.pct / 100);
  const interestPerDay = (borrowed * m.rate) / 100 / 365;
  // Only options still open count (Nov 18): one that expired is gone from the payoff and the income alike.
  const legs = (position.legs || []).filter((l) => l && Number(l.strike) > 0 && Number(l.contracts) > 0 && !(daysTo(l.expiry, now) <= 0)).map((l) => ({
    ...l, strike: Number(l.strike), premium: Number(l.premium) || 0, contracts: Math.round(Number(l.contracts)), iv: Number(l.iv) || null,
  }));
  const horizon = legs.length ? legs.map((l) => l.expiry).sort()[0] : null;
  const valueAt = (l, S) => {
    if (!horizon || l.expiry <= horizon) return intrinsic(l.type, S, l.strike);
    const T = Math.max(0, (expiryClose(l.expiry) - expiryClose(horizon)) / (365 * 86400e3));
    return bsPrice(l.type, S, l.strike, T, l.iv || 0.5);
  };
  const interestToHorizon = horizon ? interestPerDay * calendarSpan(horizon, now) : 0;
  // The worst case (Jake, Nov 19: max loss, break-even and the loss at the put's strike "are calculated at the call's expiry,
  // and they still count some leftover put value ... the real worst case of holding to Dec 31"): held to the last option's
  // expiry, every leg at what it's worth then (no time value left), the interest to that day.
  const riskHorizon = legs.length ? legs.map((l) => l.expiry).sort().at(-1) : null;
  const interestToRisk = riskHorizon ? interestPerDay * calendarSpan(riskHorizon, now) : 0;
  // Call premium already banked from calls closed, rolled or expired (Nov 19, Jake: daily income and max loss "only count your
  // last roll's credit, not everything you've collected ... These need to use total premium against total puts"): a fixed credit
  // in every figure, whatever the price does. position.banked = { usd, since } (desk.js, from his fills).
  const banked = Number(position.banked?.usd) || 0;
  const bankedSince = /^\d{4}-\d{2}-\d{2}$/.test(String(position.banked?.since || '')) ? position.banked.since : null;
  const pnlHeld = (S) => banked + (S - cost) * shares - interestToRisk + legs.reduce((a, l) => a + legSign(l) * (intrinsic(l.type, S, l.strike) - l.premium) * l.contracts * 100, 0);
  // A trading day's share of the interest (Nov 18: "then interest comes off after that"): the year's interest over the year's
  // 252 trading days, the same every day (it had been the interest to the nearest expiry over its sessions, so a Friday took
  // a weekend's worth).
  const interestPerSession = interestPerDay * 365 / TRADING_DAYS_A_YEAR;
  const pnl = (S) => banked + (S - cost) * shares - interestToHorizon + legs.reduce((a, l) => a + legSign(l) * (valueAt(l, S) - l.premium) * l.contracts * 100, 0);

  const top = Math.max(price, cost, ...legs.map((l) => l.strike)) * 3;
  const points = new Set([0, cost, price, top, ...legs.map((l) => l.strike)]);
  for (let i = 0; i <= 900; i++) points.add((top * i) / 900);
  const grid = [...points].sort((a, b) => a - b);
  const vals = grid.map((S) => [S, pnl(S)]);
  let best = vals[0]; let worst = vals[0];
  for (const v of vals) { if (v[1] > best[1] + 1e-6) best = v; if (v[1] < worst[1] - 1e-6) worst = v; }
  const held = grid.map((S) => [S, pnlHeld(S)]);
  let worstHeld = held[0];
  for (const v of held) if (v[1] < worstHeld[1] - 1e-6) worstHeld = v;
  const breakevens = [];
  for (let i = 1; i < held.length; i++) {
    const [s0, p0] = held[i - 1]; const [s1, p1] = held[i];
    if ((p0 < 0 && p1 >= 0) || (p0 >= 0 && p1 < 0)) breakevens.push(r2(s0 + ((0 - p0) * (s1 - s0)) / (p1 - p0)));
  }
  worst = worstHeld;
  const shortCalls = legs.filter((l) => l.type === 'call' && l.side === 'short').reduce((a, l) => a + l.contracts * 100, 0);
  const longCalls = legs.filter((l) => l.type === 'call' && l.side === 'long').reduce((a, l) => a + l.contracts * 100, 0);
  const uncovered = shortCalls > shares + longCalls;
  const rising = vals[vals.length - 1][1] - vals[vals.length - 2][1] > 1e-6;
  const credit = banked + legs.reduce((a, l) => a - legSign(l) * l.premium * l.contracts * 100, 0);
  const premiumIn = banked + legs.filter((l) => l.side === 'short').reduce((a, l) => a + l.premium * l.contracts * 100, 0);
  // Option revenue a trading day (Nov 18: "look at call premium currently on the trades, the date they expire and the date they
  // were made, that is the call premium/day, then the same for the put options to determine the put cost, and then interest
  // comes off"): each option still open, its premium over the trading days from when it was opened to its expiry.
  const live = legs;
  // With premium banked, the calls' income is everything collected (banked plus the open calls) over the trading days from the
  // first call to the open call's expiry (today, with none open): what the calls have actually been earning a day.
  const shortsOpen = live.filter((l) => l.side === 'short');
  const callsEnd = [nyDate(now), ...shortsOpen.map((l) => l.expiry)].sort().at(-1);
  const callDays = bankedSince ? Math.max(1, tradingDaysBetween(bankedSince, callsEnd)) : null;
  const perDay = banked && callDays
    ? (banked + shortsOpen.reduce((a, l) => a + l.premium * l.contracts * 100, 0)) / callDays
    : shortsOpen.reduce((a, l) => a + (l.premium * l.contracts * 100) / legDays(l, now), 0);
  const costPerDay = live.filter((l) => l.side === 'long').reduce((a, l) => a + (l.premium * l.contracts * 100) / legDays(l, now), 0);
  const stockIn = cost * shares;
  const paidOut = legs.filter((l) => l.side === 'long').reduce((a, l) => a + l.premium * l.contracts * 100, 0);
  const call = legs.find((l) => l.type === 'call' && l.side === 'short');
  const put = legs.find((l) => l.type === 'put' && l.side === 'long');
  // What the headline figures hide (Nov 17, his 105 NVDA with one call and one put: "Max gain is unlimited? And max loss seems
  // too much?"): shares the calls don't cover keep the gain open, shares the puts don't cover fall all the way.
  const longPuts = legs.filter((l) => l.type === 'put' && l.side === 'long').reduce((a, l) => a + l.contracts * 100, 0);
  const extraShares = shortCalls > 0 && shares + longCalls > shortCalls ? shares + longCalls - shortCalls : 0;
  const callTop = shortCalls ? Math.max(...legs.filter((l) => l.type === 'call' && l.side === 'short').map((l) => l.strike)) : null;
  const unhedged = longPuts > 0 && shares > longPuts ? shares - longPuts : 0;
  const putTop = longPuts ? Math.max(...legs.filter((l) => l.type === 'put' && l.side === 'long').map((l) => l.strike)) : null;
  // Where the floor starts: below this, the loss grows by less than 2% more all the way down.
  const floorAt = !uncovered && worst[1] < 0 ? held.filter(([S, v]) => S <= price && v <= worst[1] * 0.98).at(-1)?.[0] ?? null : null;
  const scenarios = [...new Set([-30, -20, -10, -5, 0, 5, 10, 20, ...testPcts])].sort((x, y) => x - y).map((pct) => ({ pct, price: r2(price * (1 + pct / 100)), pnl: r2(pnl(price * (1 + pct / 100))) }));
  const curve = [];
  for (let i = 0; i <= 80; i++) { const S = price * (0.55 + (0.9 * i) / 80); curve.push({ price: r2(S), pnl: r2(pnl(S)) }); }
  return {
    horizon, risk_horizon: riskHorizon, interest_to_risk: r2(interestToRisk), shares, cost: r2(cost), price: r2(price),
    banked: banked ? { usd: r2(banked), since: bankedSince, call_days: callDays } : null,
    money_in: r2(stockIn + paidOut), stock_in: r2(stockIn), premium_in: r2(premiumIn), put_cost: r2(paidOut), net_credit: r2(credit),
    income_per_day: r2(perDay), protection_per_day: r2(costPerDay), net_per_day: r2(perDay - costPerDay),
    margin_pct: m.pct, margin_rate: m.rate, capital_needed: r2(stockIn * m.pct / 100 + paidOut), borrowed: r2(borrowed),
    interest_per_day: r2(interestPerSession), interest_per_calendar_day: r2(interestPerDay), interest_to_horizon: r2(interestToHorizon),
    net_after_interest_per_day: r2(perDay - costPerDay - interestPerSession),
    // What the play is worth for what it ties up and what it risks (Nov 18: "the option play value should also consider the
    // return vs capital requirement, and return vs max loss").
    ...playValue(perDay - costPerDay - interestPerSession, stockIn * m.pct / 100 + paidOut, uncovered ? null : worst[1]),
    legs_counted: live.map((l) => ({ type: l.type, side: l.side, strike: l.strike, expiry: l.expiry, contracts: l.contracts, premium: l.premium,
      opened: /^\d{4}-\d{2}-\d{2}$/.test(String(l.since || '')) ? l.since : null, days: legDays(l, now), per_day: r2((l.premium * l.contracts * 100) / legDays(l, now)) })),
    max_gain: uncovered || rising ? null : r2(best[1]), max_gain_at: uncovered || rising ? null : r2(best[0]),
    max_loss: uncovered ? null : r2(worst[1]), max_loss_at: uncovered ? null : r2(worst[0]),
    unlimited_gain: !uncovered && rising, uncovered,
    floor_from: floorAt != null && floorAt > 1 ? r2(floorAt) : null,
    shares_not_called: extraShares, gain_at_call: extraShares && callTop ? r2(pnl(callTop)) : null, call_strike: callTop,
    shares_without_put: unhedged, put_strike: putTop, loss_at_put: putTop ? r2(pnlHeld(putTop)) : null,
    breakevens,
    called_away_chance: call?.delta != null ? r2(Math.abs(call.delta) * 100) : null,
    put_pays_chance: put?.delta != null ? r2(Math.abs(put.delta) * 100) : null,
    call_yield_pct: call && stockIn ? r2(((call.premium * call.contracts * 100) / stockIn) * 100) : null,
    call_yield_annual_pct: call && stockIn ? r2(((call.premium * call.contracts * 100) / stockIn) * (252 / incomeDays(call.expiry, now)) * 100) : null,
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
  call_otm: 5,              // the call: at least this many US dollars above the price (Nov 17: "short term daily calls $5 otm")
  call_max_days: 3,         // short term: expiring within this many days
  protect: true,            // buy a put
  put_otm: 10,              // the put: at least this many US dollars below the price ("long horizon puts that are $10 otm")
  put_days_min: 7, put_days_max: 45, // long horizon: this many days out
  drop_test_pct: 20,        // without a put, the fall the loss limit is checked against
  margin_pct: 30,           // his share of the stock on margin (Nov 17: "required capital at 30% margin"); 100 = cash
  margin_rate: 5.85,        // his broker's yearly rate on what's borrowed (his answer, Nov 17)
  wide: true,               // also look through about 50 large stocks, not only the watchlist (his pick, Nov 17)
  min_carry: 0,             // a stock counts only when its calls pay more a trading day than the puts cost, by at least this (CAD, 100 shares)
  expiry_every_days: 3,     // and only when its options expire at least this often (Mon/Wed/Fri or daily), not weekly
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
    call_otm: num(r.call_otm, 0, 1000, d.call_otm),
    call_max_days: Math.round(num(r.call_max_days, 0, 60, d.call_max_days)),
    protect: r.protect == null ? d.protect : !!r.protect,
    put_otm: num(r.put_otm, 0, 1000, d.put_otm),
    put_days_min: Math.round(num(r.put_days_min, 0, 365, d.put_days_min)),
    put_days_max: Math.round(num(r.put_days_max, 1, 730, d.put_days_max)),
    drop_test_pct: num(r.drop_test_pct, 1, 90, d.drop_test_pct),
    margin_pct: num(r.margin_pct, 25, 100, d.margin_pct),
    margin_rate: num(r.margin_rate, 0, 30, d.margin_rate),
    wide: r.wide == null ? d.wide : !!r.wide,
    min_carry: num(r.min_carry, -1e5, 1e5, d.min_carry),
    expiry_every_days: Math.round(num(r.expiry_every_days, 1, 31, d.expiry_every_days)),
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
// putStrike (Jake, Nov 19: "your new rule of any strike at or above the put"): with a put held, the call can be any strike at
// or above the put's, within his call days; each is valued by its time value a trading day — the bid less what the shares
// give up below today's price if called there — so a strike under the price isn't credited with money it hands back.
export function pick(ch, rulesIn, { now = new Date(), fx = null, putStrike = null } = {}) {
  const rules = cleanRules(rulesIn);
  const rate = Number(fx) > 0 ? Number(fx) : null;
  const capCad = rules.capital_currency === 'CAD';
  const capital = capCad && rate ? rules.capital / rate : rules.capital; // US$ (CAD capital without a rate: taken at par, said below)
  const money = (usdAmt) => (rate ? `$${Math.round(usdAmt * rate).toLocaleString('en-US')}` : `US$${Math.round(usdAmt).toLocaleString('en-US')}`);
  const price = ch.quote.price;
  const open = ch.contracts.filter((c) => daysTo(c.expiry, now) > 0);
  const avg = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
  // Short-term calls: in each expiry within his call days, the first strike at least call_otm dollars above the price, at the
  // bid, a trading day. Their average is what the stock's calls pay; the one that pays the most a trading day is the pick.
  const shortExp = [...new Set(open.filter((c) => c.type === 'call' && calendarDays(c.expiry, now) <= rules.call_max_days).map((c) => c.expiry))].sort();
  const floor = Number(putStrike) > 0 ? Number(putStrike) : null;
  const timeValue = (c) => c.bid + Math.min(0, c.strike - price);
  const callRows = floor
    ? shortExp.flatMap((e) => open.filter((x) => x.type === 'call' && x.expiry === e && x.strike >= floor - 1e-9 && x.bid >= 0.01)
      .map((c) => ({ ...c, days: incomeDays(e, now), time_value: r2(timeValue(c)), per_day: r2((timeValue(c) * 100) / incomeDays(e, now)) })))
      .filter((c) => c.per_day > 0)
    : shortExp.map((e) => {
      const c = open.filter((x) => x.type === 'call' && x.expiry === e && x.strike >= price + rules.call_otm - 1e-9 && x.bid >= 0.01).sort((x, y) => x.strike - y.strike)[0];
      return c ? { ...c, days: incomeDays(e, now), time_value: r2(timeValue(c)), per_day: r2((c.bid * 100) / incomeDays(e, now)) } : null;
    }).filter(Boolean);
  const callChoices = [...callRows].sort((x, y) => y.per_day - x.per_day || (x.expiry < y.expiry ? -1 : 1) || x.strike - y.strike).slice(0, 8);
  const call = callChoices[0] || null;

  // Long-horizon puts: in each expiry in his put window, the first strike at least put_otm dollars below the price, at the
  // ask, a trading day. Their average is what the stock's insurance costs; the cheapest a trading day is the pick.
  const longExp = [...new Set(open.filter((c) => c.type === 'put' && daysTo(c.expiry, now) >= rules.put_days_min && daysTo(c.expiry, now) <= rules.put_days_max + 1).map((c) => c.expiry))].sort();
  const putRows = longExp.map((e) => {
    const p = open.filter((x) => x.type === 'put' && x.expiry === e && x.strike <= price - rules.put_otm + 1e-9 && x.ask > 0).sort((x, y) => y.strike - x.strike)[0];
    return p ? { ...p, days: incomeDays(e, now), cost_per_day: r2((p.ask * 100) / incomeDays(e, now)) } : null;
  }).filter(Boolean);
  const putChoices = [...putRows].sort((x, y) => x.cost_per_day - y.cost_per_day).slice(0, 6);
  const put = rules.protect ? putChoices[0] || null : null;

  // One lot (100 shares) bought today with these legs, at the prices you'd likely trade: sell the call at the bid, buy the put at the ask.
  const legs = [];
  if (call) legs.push({ type: 'call', side: 'short', strike: call.strike, expiry: call.expiry, premium: call.bid, contracts: 1, iv: call.iv, delta: call.delta });
  if (put) legs.push({ type: 'put', side: 'long', strike: put.strike, expiry: put.expiry, premium: put.ask, contracts: 1, iv: put.iv, delta: put.delta });
  const margin = { pct: rules.margin_pct, rate: rules.margin_rate };
  const lot = evaluate({ price, shares: 100, cost: price, legs }, { now, testPcts: [-rules.drop_test_pct], margin });
  const lossPerLot = Math.max(0.01, -Math.min(0, put ? lot.max_loss : lot.scenarios.find((s) => s.pct === -rules.drop_test_pct).pnl));
  const perLotMoney = lot.capital_needed; // his share of the shares on margin, and the put in full
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
    sizing.limits.push(`${rules.max_position_pct}% of ${money(capital)} in one name allows ${byPosition} lot${byPosition === 1 ? '' : 's'} at ${money(perLotMoney)} each${rules.margin_pct < 100 ? ` (${rules.margin_pct}% of the shares on margin${put ? ', the put in full' : ''})` : ''}.`);
    sizing.limits.push(`Losing at most ${rules.max_loss_pct}% (${money(capital * rules.max_loss_pct / 100)}) allows ${byLoss}: ${lossLabel} is ${money(lossPerLot)} a lot.`);
    if (capCad && !rate) sizing.limits.push('The exchange rate couldn’t be had, so your CAD capital was taken as US dollars.');
    if (!sizing.lots) sizing.limits.push('Not one lot fits these limits.');
  }
  const reasons = [];
  if (call && floor) reasons.push(`Call: the ${call.strike} for ${call.expiry}. Of every strike at or above your put's ${floor} within ${rules.call_max_days} days, it keeps the most time value a trading day (US$${call.per_day} over ${call.days}).${call.delta != null ? ` Delta ${r2(call.delta)}: about a ${Math.round(call.delta * 100)}% chance it ends in the money.` : ''}`);
  else if (call) reasons.push(`Call: the ${call.strike} for ${call.expiry}, the first strike at least US$${rules.call_otm} above the price. Of the ${callRows.length} expir${callRows.length === 1 ? 'y' : 'ies'} within ${rules.call_max_days} days it pays the most a trading day (US$${call.per_day} over ${call.days}).${call.delta != null ? ` Delta ${r2(call.delta)}: about a ${Math.round(call.delta * 100)}% chance it ends in the money.` : ''}`);
  else reasons.push(floor ? `No call fits: none within ${rules.call_max_days} days at or above the put's ${floor} has time value left.` : `No call fits: none within ${rules.call_max_days} days at least US$${rules.call_otm} above the price with a bid.`);
  if (rules.protect) {
    if (put) reasons.push(`Put: the ${put.strike} for ${put.expiry}, the first strike at least US$${rules.put_otm} below the price; the cheapest a trading day (US$${put.cost_per_day} over ${put.days}) of the ${putRows.length} expir${putRows.length === 1 ? 'y' : 'ies'} ${rules.put_days_min} to ${rules.put_days_max} days out.`);
    else reasons.push(`No put fits: none ${rules.put_days_min} to ${rules.put_days_max} days out at least US$${rules.put_otm} below the price.`);
  }
  // The difference (Nov 17: "the difference between avg put daily cost (on trading days) on long horizon puts that are $10
  // otm, and avg short term daily calls $5 otm"), for 100 shares a trading day in US$: the average of the short-term calls
  // less the average of the long-horizon puts; and after the margin interest on one lot.
  const callAvg = avg(callRows.map((c) => c.per_day)); const putAvg = avg(putRows.map((p) => p.cost_per_day));
  const carry = callAvg != null ? {
    call_per_day: r2(callAvg), calls: callRows.length, put_per_day: putAvg == null ? null : r2(putAvg), puts: putRows.length,
    interest_per_day: lot.interest_per_day,
    gap: putAvg == null ? null : r2(callAvg - putAvg), after_interest: putAvg == null ? null : r2(callAvg - putAvg - lot.interest_per_day),
    capital_per_lot: lot.capital_needed, max_loss_per_lot: lot.max_loss,
    ...(putAvg == null ? {} : (({ on_capital_pct_year, days_to_earn_max_loss }) => ({ on_capital_pct_year, days_to_earn_max_loss }))(playValue(callAvg - putAvg - lot.interest_per_day, lot.capital_needed, lot.max_loss))),
    // The contracts behind the averages (Nov 18: "doesn't seem to have any data on option prices"): the call that pays the
    // most a trading day and the cheapest put a trading day, with their prices and deltas, so the list shows what it priced.
    call: call && { strike: call.strike, expiry: call.expiry, bid: call.bid, ask: call.ask, delta: call.delta == null ? null : r2(call.delta), per_day: call.per_day, days: call.days },
    put: putChoices[0] ? { strike: putChoices[0].strike, expiry: putChoices[0].expiry, bid: putChoices[0].bid, ask: putChoices[0].ask, delta: putChoices[0].delta == null ? null : r2(putChoices[0].delta), cost_per_day: putChoices[0].cost_per_day, days: putChoices[0].days } : null,
  } : null;
  // The day's position (Nov 19, Jake: "5 recommended positions for the day based on call option value today/tomorrow vs put
  // option cost long term"): 100 shares bought now, the call expiring today or the next trading day by his rule (the first
  // strike at least call_otm above the price, at the bid) that pays the most a trading day, and the cheapest long-horizon put a
  // trading day by his rule (putChoices[0], at the ask). Valued as one lot on his margin, sized by his limits.
  const nearExp = [...new Set(open.filter((c) => c.type === 'call').map((c) => c.expiry))].filter((e) => incomeDays(e, now) <= 2).sort();
  const dayCalls = nearExp.map((e) => {
    const c = open.filter((x) => x.type === 'call' && x.expiry === e && x.strike >= price + rules.call_otm - 1e-9 && x.bid >= 0.01).sort((x, y) => x.strike - y.strike)[0];
    return c ? { ...c, days: incomeDays(e, now), per_day: r2((c.bid * 100) / incomeDays(e, now)) } : null;
  }).filter(Boolean).sort((x, y) => y.per_day - x.per_day);
  const dc = dayCalls[0]; const dp = putChoices[0];
  let dayPlay = null;
  if (dc && dp) {
    const legsDay = [
      { type: 'call', side: 'short', strike: dc.strike, expiry: dc.expiry, premium: dc.bid, contracts: 1, iv: dc.iv, delta: dc.delta },
      { type: 'put', side: 'long', strike: dp.strike, expiry: dp.expiry, premium: dp.ask, contracts: 1, iv: dp.iv, delta: dp.delta },
    ];
    const v = evaluate({ price, shares: 100, cost: price, legs: legsDay }, { now, margin });
    const net = r2(dc.per_day - dp.cost_per_day - v.interest_per_day);
    const loss = Math.max(0.01, -Math.min(0, v.max_loss ?? 0));
    const lots = capital > 0 ? Math.max(0, Math.min(Math.floor((capital * rules.max_position_pct / 100) / v.capital_needed), Math.floor((capital * rules.max_loss_pct / 100) / loss))) : null;
    dayPlay = {
      price, legs: legsDay,
      call: { strike: dc.strike, expiry: dc.expiry, bid: dc.bid, delta: dc.delta == null ? null : r2(dc.delta), days: dc.days, per_day: dc.per_day },
      put: { strike: dp.strike, expiry: dp.expiry, ask: dp.ask, delta: dp.delta == null ? null : r2(dp.delta), days: dp.days, per_day: dp.cost_per_day },
      interest_per_day: v.interest_per_day, net_per_day: net, max_loss: v.max_loss, capital: v.capital_needed, breakevens: v.breakevens,
      on_capital_pct_year: v.capital_needed > 0 ? r2((net * TRADING_DAYS_A_YEAR / v.capital_needed) * 100) : null,
      days_to_earn_max_loss: net > 0 && v.max_loss < 0 ? Math.ceil(-v.max_loss / net) : null,
      called_away_chance: dc.delta != null ? Math.round(Math.abs(dc.delta) * 100) : null, lots,
    };
  }
  return { rules, price, call, put, call_choices: callChoices, put_choices: putChoices, lot, sizing, reasons, carry, usd_cad: rate, call_floor: floor, day_play: dayPlay };
}
