// What the desk tells him about (Jake, Nov 20: "notifications on stocks, gamma, theta, etc. any big moves and what not").
// Pure: a stock's day or one of his positions in, the notes it earns out. Each note has an id that says when it may be said
// again (once a day, once an hour, once ever), so the watcher (desk.js tick) keeps only the new ones. `level` high goes on to
// Mike Burry's chat in Andrew, and from there to his phone; info stays on the page. His levels are in his rules (alert_*);
// a kind in alerts_off is never raised. Every note states what happened and what it does to the position, never what to do.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const us = (n, d = 2) => `US$${Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const short = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Money in CAD at the desk's rate (US$ when there's none), signed. */
export const moneyWith = (fx) => (usd, { sign = false } = {}) => {
  const v = Number(usd) * (fx || 1);
  return `${sign ? (v > 0 ? '+' : v < 0 ? '−' : '') : v < 0 ? '−' : ''}${fx ? '$' : 'US$'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
};
const on = (rules, kind) => !(rules.alerts_off || []).includes(kind);

/** A stock's move today, for one he holds or watches. row: { symbol, price, day_pct, change }; held: { shares, delta } or null. */
export function moveAlerts(row, rules, { date, held = null, fx = null } = {}) {
  if (!on(rules, 'move') || row.day_pct == null || !(rules.alert_move_pct > 0)) return [];
  const n = Math.min(3, Math.floor(Math.abs(row.day_pct) / rules.alert_move_pct));
  if (n < 1) return [];
  const up = row.day_pct > 0; const money = moneyWith(fx);
  const text = `${row.symbol} is ${up ? 'up' : 'down'} ${Math.abs(row.day_pct).toFixed(1)}% today at ${us(row.price)}.`
    + (held ? ` Your ${held.shares} shares are ${money((row.change ?? 0) * held.shares, { sign: true })} on the day${held.delta != null ? `; with the options, the position moves about ${money(Math.abs(held.delta))} for each US$1 from here` : ''}.` : '');
  return [{ id: `${row.symbol}:move:${up ? 'up' : 'down'}${n}:${date}`, kind: 'move', level: held ? 'high' : 'info', symbol: row.symbol,
    title: `${row.symbol} ${up ? '▲' : '▼'} ${Math.abs(row.day_pct).toFixed(1)}% today`, text, data: { day_pct: row.day_pct, price: row.price, step: n } }];
}

/** A fast move on a stock he holds: this much inside half an hour, from the day's five-minute bars. */
export function swingAlerts(symbol, bars, rules, { date, now = new Date() } = {}) {
  if (!on(rules, 'swing') || !Array.isArray(bars) || bars.length < 3) return [];
  const last = bars.at(-1);
  if (now - last.t > 20 * 60e3) return []; // the bars have stopped: the market's shut
  const from = [...bars].reverse().find((b) => last.t - b.t >= 28 * 60e3) || bars[0];
  if (!from || last.t - from.t < 10 * 60e3) return [];
  const pct = ((last.price - from.price) / from.price) * 100;
  if (Math.abs(pct) < rules.alert_swing_pct) return [];
  const up = pct > 0;
  const mins = Math.round((last.t - from.t) / 60e3);
  const hour = new Date(last.t).toISOString().slice(11, 13);
  return [{ id: `${symbol}:swing:${up ? 'up' : 'down'}:${hour}:${date}`, kind: 'swing', level: 'high', symbol,
    title: `${symbol} ${up ? 'jumped' : 'fell'} ${Math.abs(pct).toFixed(1)}% in ${mins} minutes`,
    text: `${symbol} ${up ? 'jumped' : 'fell'} ${Math.abs(pct).toFixed(1)}% in the last ${mins} minutes, from ${us(from.price)} to ${us(last.price)}.`, data: { pct: r2(pct), minutes: mins } }];
}

/**
 * One of his positions. p: { symbol, shares, price, greeks (strategy.positionGreeks), figures: { put_spreads, plain_puts,
 * sold_puts }, earnings }. The strikes he's sold, the puts he holds, the spread's far strike, gamma, time decay, expiry day.
 */
export function positionAlerts(p, rules, { date, fx = null } = {}) {
  const out = [];
  const g = p.greeks; const S = Number(p.price);
  if (!g || !(S > 0)) return out;
  const money = moneyWith(fx);
  const near = rules.alert_near_strike_pct;
  const legs = g.legs || [];
  const sessions = (l) => (l.sessions <= 1 ? (l.expiry === date ? 'it expires today' : 'it expires next session') : `${l.sessions} sessions left`);

  if (on(rules, 'call')) {
    for (const l of legs.filter((x) => x.type === 'call' && x.side !== 'long')) {
      const off = ((l.strike - S) / S) * 100;
      if (S >= l.strike) {
        out.push({ id: `${p.symbol}:call:over:${l.strike}:${l.expiry}:${date}`, kind: 'call', level: 'high', symbol: p.symbol,
          title: `${p.symbol} is above your ${l.strike} call`,
          text: `${p.symbol} is at ${us(S)}, ${us(S - l.strike)} above the ${l.strike} call you sold (${short(l.expiry)}; ${sessions(l)}). Held there to expiry, ${plural(l.contracts * 100, 'share')} would be called away at ${l.strike}.`,
          data: { strike: l.strike, expiry: l.expiry, over: r2(S - l.strike) } });
      } else if (off <= near) {
        out.push({ id: `${p.symbol}:call:near:${l.strike}:${l.expiry}:${date}`, kind: 'call', level: l.sessions <= 2 ? 'high' : 'info', symbol: p.symbol,
          title: `${p.symbol} is ${off.toFixed(1)}% under your ${l.strike} call`,
          text: `${p.symbol} is at ${us(S)}, ${us(l.strike - S)} (${off.toFixed(1)}%) under the ${l.strike} call you sold (${short(l.expiry)}; ${sessions(l)}). Its delta is about ${Math.abs(l.delta_one).toFixed(2)}.`,
          data: { strike: l.strike, expiry: l.expiry, under: r2(l.strike - S) } });
      }
    }
  }

  const spreads = p.figures?.put_spreads || [];
  if (on(rules, 'spread')) {
    for (const s of spreads.filter((x) => x.kind === 'insurance')) {
      const off = ((S - s.short_strike) / s.short_strike) * 100;
      if (S < s.short_strike) {
        out.push({ id: `${p.symbol}:spread:ended:${s.short_strike}:${date}`, kind: 'spread', level: 'high', symbol: p.symbol,
          title: `${p.symbol} is below your put spread`,
          text: `${p.symbol} is at ${us(S)}, under the ${s.short_strike} put you sold against your ${s.long_strike} put. The spread has paid all it can (${money(s.most_it_pays)}); below ${s.short_strike} the shares fall unprotected.`,
          data: { long: s.long_strike, short: s.short_strike } });
      } else if (off <= near) {
        out.push({ id: `${p.symbol}:spread:near:${s.short_strike}:${date}`, kind: 'spread', level: 'high', symbol: p.symbol,
          title: `${p.symbol} is near the end of your put spread`,
          text: `${p.symbol} is at ${us(S)}, ${us(S - s.short_strike)} above ${s.short_strike}, where your ${s.long_strike}/${s.short_strike} put spread stops paying. Below ${s.short_strike} the shares fall unprotected.`,
          data: { long: s.long_strike, short: s.short_strike } });
      }
    }
    const sold = [...spreads.filter((x) => x.kind === 'income').map((s) => ({ strike: s.short_strike, expiry: s.short_expiry, spread: s })),
      ...(p.figures?.sold_puts || []).map((s) => ({ strike: s.strike, expiry: s.expiry, naked: s }))];
    for (const s of sold) {
      const off = ((S - s.strike) / s.strike) * 100;
      const what = s.spread ? `the ${s.spread.short_strike}/${s.spread.long_strike} put spread you sold` : `the ${s.strike} put you sold`;
      const worst = s.spread ? ` The most the spread can lose is ${money(Math.abs(s.spread.max_loss))}, below ${s.spread.long_strike}.` : ` At expiry below ${s.strike} you'd buy ${s.naked.buys_shares} shares at ${s.strike}.`;
      if (S < s.strike) {
        out.push({ id: `${p.symbol}:spread:under:${s.strike}:${s.expiry}:${date}`, kind: 'spread', level: 'high', symbol: p.symbol,
          title: `${p.symbol} is below the ${s.strike} put you sold`,
          text: `${p.symbol} is at ${us(S)}, ${us(s.strike - S)} under ${what} (${short(s.expiry)}).${worst}`, data: { strike: s.strike, expiry: s.expiry } });
      } else if (off <= near) {
        out.push({ id: `${p.symbol}:spread:close:${s.strike}:${s.expiry}:${date}`, kind: 'spread', level: 'high', symbol: p.symbol,
          title: `${p.symbol} is ${off.toFixed(1)}% above the ${s.strike} put you sold`,
          text: `${p.symbol} is at ${us(S)}, ${us(S - s.strike)} (${off.toFixed(1)}%) above ${what} (${short(s.expiry)}).${worst}`, data: { strike: s.strike, expiry: s.expiry } });
      }
    }
  }

  if (on(rules, 'put')) {
    const owned = [...(p.figures?.plain_puts || []).map((x) => ({ strike: x.strike, expiry: x.expiry })), ...spreads.filter((x) => x.kind === 'insurance').map((s) => ({ strike: s.long_strike, expiry: s.long_expiry, to: s.short_strike }))];
    for (const o of owned) {
      if (S > o.strike || (o.to && S < o.to)) continue;
      out.push({ id: `${p.symbol}:put:under:${o.strike}:${date}`, kind: 'put', level: 'high', symbol: p.symbol,
        title: `${p.symbol} is below your ${o.strike} put`,
        text: `${p.symbol} is at ${us(S)}, ${us(o.strike - S)} under the ${o.strike} put you hold (${short(o.expiry)}): the insurance is paying. ${o.to ? `It covers the fall down to ${o.to}.` : 'It covers the fall from here down.'}`,
        data: { strike: o.strike, expiry: o.expiry } });
    }
  }

  if (on(rules, 'gamma') && Math.abs(g.gamma) >= rules.alert_gamma) {
    const hot = [...legs].sort((a, b) => Math.abs(b.gamma) - Math.abs(a.gamma))[0];
    out.push({ id: `${p.symbol}:gamma:${date}`, kind: 'gamma', level: 'high', symbol: p.symbol,
      title: `${p.symbol}: gamma ${g.gamma > 0 ? '+' : '−'}${Math.abs(g.gamma).toFixed(0)}`,
      text: `${p.symbol}: each US$1 on the stock now shifts your exposure by about ${Math.abs(g.gamma).toFixed(0)} shares (gamma ${g.gamma.toFixed(0)}; delta ${g.delta.toFixed(0)}).`
        + (hot ? ` Most of it is the ${hot.strike} ${hot.type} you ${hot.side === 'long' ? 'hold' : 'sold'}: ${us(Math.abs(S - hot.strike))} from its strike, ${sessions(hot)}.` : ''),
      data: { gamma: g.gamma, delta: g.delta } });
  }

  if (on(rules, 'theta')) {
    for (const l of legs.filter((x) => x.side !== 'long' && x.earned_pct != null && x.earned_pct >= rules.alert_earned_pct)) {
      out.push({ id: `${p.symbol}:theta:${l.type}:${l.strike}:${l.expiry}`, kind: 'theta', level: 'info', symbol: p.symbol,
        title: `${p.symbol} ${l.strike} ${l.type}: ${Math.round(l.earned_pct)}% earned`,
        text: `The ${p.symbol} ${l.strike} ${l.type} you sold for ${l.premium.toFixed(2)} is worth about ${l.value.toFixed(2)} now: ${Math.round(l.earned_pct)}% of its premium is earned, ${money(l.value * l.contracts * 100)} left (${short(l.expiry)}; ${sessions(l)}).`,
        data: { strike: l.strike, expiry: l.expiry, earned_pct: l.earned_pct } });
    }
  }

  if (on(rules, 'expiry')) {
    const today = legs.filter((l) => l.expiry === date);
    if (today.length) {
      const say = (l) => {
        const away = l.type === 'call' ? l.strike - S : S - l.strike; // + = out of the money
        return `the ${l.strike} ${l.type} you ${l.side === 'long' ? 'hold' : 'sold'} is ${us(Math.abs(away))} ${away >= 0 ? 'out of' : 'in'} the money`;
      };
      out.push({ id: `${p.symbol}:expiry:${date}`, kind: 'expiry', level: 'high', symbol: p.symbol,
        title: `${p.symbol}: ${plural(today.length, 'option')} expire${today.length === 1 ? 's' : ''} today`,
        text: `${p.symbol} at ${us(S)}: ${today.map(say).join('; ')}. ${today.length === 1 ? 'It expires' : 'They expire'} at the close today.`, data: { legs: today.map((l) => ({ type: l.type, side: l.side, strike: l.strike })) } });
    }
  }

  if (on(rules, 'earnings') && p.earnings?.date) {
    const call = legs.filter((l) => l.type === 'call' && l.side !== 'long' && l.expiry >= p.earnings.date).sort((a, b) => (a.expiry < b.expiry ? -1 : 1))[0];
    if (call && p.earnings.date >= date) {
      out.push({ id: `${p.symbol}:earnings:${p.earnings.date}:${call.expiry}`, kind: 'earnings', level: 'info', symbol: p.symbol,
        title: `${p.symbol} reports ${short(p.earnings.date)}`,
        text: `${p.symbol} reports earnings ${short(p.earnings.date)} (${p.earnings.time || 'time not given'}), before your ${call.strike} call expires ${short(call.expiry)}.`, data: { date: p.earnings.date } });
    }
  }
  return out;
}

/** An option's implied volatility against the last reading kept. legs: greeks.legs; seen: { key: iv% }. Returns { alerts, seen }. */
export function ivAlerts(symbol, legs, seen = {}, rules, { date } = {}) {
  const out = []; const next = { ...seen };
  for (const l of legs || []) {
    if (l.iv_assumed || !(l.iv > 0)) continue;
    const key = `${symbol}|${l.type}|${l.strike}|${l.expiry}`;
    const was = Number(seen[key]);
    if (was > 0 && on(rules, 'iv') && Math.abs(l.iv - was) >= rules.alert_iv_points) {
      out.push({ id: `${symbol}:iv:${l.type}:${l.strike}:${l.expiry}:${date}`, kind: 'iv', level: 'info', symbol,
        title: `${symbol} ${l.strike} ${l.type}: volatility ${l.iv > was ? 'up' : 'down'} ${Math.abs(l.iv - was).toFixed(0)} points`,
        text: `Implied volatility on the ${symbol} ${l.strike} ${l.type} (${short(l.expiry)}) went from ${was.toFixed(0)}% to ${l.iv.toFixed(0)}%. Higher volatility makes every option on it dearer: more for a call you sell, more for a put you buy.`,
        data: { from: was, to: l.iv } });
      next[key] = l.iv;
    } else if (!(was > 0)) next[key] = l.iv;
  }
  return { alerts: out, seen: next };
}
