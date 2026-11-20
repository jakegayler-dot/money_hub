// The options desk's live pieces (Jake, Nov 20: "significantly improve the covered call strategy page ... really sleek and
// advanced looking with dynamic graphs and notifications on stocks, gamma, theta, etc. any big moves"): numbers that move,
// the day's price against his strikes, the payoff today and at expiry, the greeks, each option's decay, put spreads, the
// notes the watcher raises, and where the prices come from. Drawn in SVG and CSS; nothing here trades.
import { useEffect, useMemo, useRef, useState } from 'react';
import { send, usd, cad, pctS, short, day, asOf, when, sign, signed, getFx, pricesWords } from './ccFormat.js';
import './coveredLive.css';

const still = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- numbers that move
export function useTween(value, ms = 650) {
  const [v, setV] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const a = from.current;
    if (!Number.isFinite(value) || !Number.isFinite(a) || a === value || still()) { setV(value); from.current = value; return undefined; }
    const t0 = performance.now(); let raf;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms); const e = 1 - (1 - k) ** 3;
      setV(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(step); else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value]);
  return v;
}
/** A figure that counts to its new value and flashes green or red when it changes. */
export function Num({ v, f = (x) => x, className = '' }) {
  const shown = useTween(Number.isFinite(v) ? v : NaN);
  const prev = useRef(v); const [flash, setFlash] = useState('');
  useEffect(() => {
    const was = prev.current; prev.current = v;
    if (!Number.isFinite(was) || !Number.isFinite(v) || was === v) return undefined;
    setFlash(v > was ? 'up' : 'down');
    const t = setTimeout(() => setFlash(''), 1100);
    return () => clearTimeout(t);
  }, [v]);
  return <span className={`cl-num${flash ? ` cl-flash-${flash}` : ''} ${className}`}>{Number.isFinite(v) ? f(shown) : '—'}</span>;
}

// ---------------------------------------------------------------- small charts
export function Spark({ data, base = null, w = 96, h = 28 }) {
  const pts = (data || []).filter((x) => Number.isFinite(x));
  if (pts.length < 2) return <svg width={w} height={h} className="cl-spark" aria-hidden="true" />;
  const all = base != null ? [...pts, base] : pts;
  const lo = Math.min(...all); const hi = Math.max(...all); const span = hi - lo || 1;
  const x = (i) => 1 + (i / (pts.length - 1)) * (w - 2); const y = (v) => h - 2 - ((v - lo) / span) * (h - 4);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const up = pts.at(-1) >= (base ?? pts[0]);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={`cl-spark ${up ? 'up' : 'down'}`} aria-hidden="true">
      <path d={`${d}L${x(pts.length - 1).toFixed(1)},${h}L1,${h}Z`} className="cl-spark-fill" />
      {base != null && <line x1="1" x2={w - 1} y1={y(base)} y2={y(base)} className="cl-spark-base" />}
      <path d={d} className="cl-spark-line" />
      <circle cx={x(pts.length - 1)} cy={y(pts.at(-1))} r="2" className="cl-spark-dot" />
    </svg>
  );
}

const LINE_WORD = { call: 'call sold', put: 'put held', sold_put: 'put sold', cost: 'your cost', even: 'breakeven' };
/**
 * The day's price in five-minute steps against his strikes. lines: [{ price, kind call|put|sold_put|cost|even, label }].
 * A line more than a few percent off the day's range is named beside the chart, not drawn (it would flatten the day).
 */
export function PriceChart({ bars, prev, lines = [], symbol }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const pts = (bars || []).filter((b) => Number.isFinite(b.price));
  if (pts.length < 2) return <div className="cl-chart cl-empty">The day’s price chart draws once the market has traded for a few minutes.</div>;
  const W = 720; const H = 270; const L = 8; const R = 86; const T = 14; const B = 22;
  const last = pts.at(-1);
  const prices = pts.map((p) => p.price);
  const lo0 = Math.min(...prices, prev ?? Infinity); const hi0 = Math.max(...prices, prev ?? -Infinity);
  const reach = Math.max((hi0 - lo0) * 0.9, last.price * 0.035);
  const shown = lines.filter((l) => l.price >= lo0 - reach && l.price <= hi0 + reach);
  const off = lines.filter((l) => !shown.includes(l));
  const lo = Math.min(lo0, ...shown.map((l) => l.price)); const hi = Math.max(hi0, ...shown.map((l) => l.price));
  const pad = (hi - lo) * 0.08 || 1;
  const t0 = pts[0].t; const t1 = Math.max(last.t, t0 + 390 * 60e3);
  const sx = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const sy = (v) => T + ((hi + pad - v) / (hi - lo + 2 * pad)) * (H - T - B);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.price).toFixed(1)}`).join('');
  const up = prev == null || last.price >= prev;
  // Labels on the right, kept from sitting on each other.
  const tags = [...shown.map((l) => ({ ...l, y: sy(l.price) })), { kind: 'now', price: last.price, label: usd(last.price, 2), y: sy(last.price) }].sort((a, b) => a.y - b.y);
  for (let i = 1; i < tags.length; i++) if (tags[i].y - tags[i - 1].y < 13) tags[i].y = tags[i - 1].y + 13;
  const move = (e) => {
    const box = ref.current.getBoundingClientRect();
    const t = t0 + (((e.clientX - box.left) / box.width) * W - L) / (W - L - R) * (t1 - t0);
    setHover(pts.reduce((a, c) => (Math.abs(c.t - t) < Math.abs(a.t - t) ? c : a)));
  };
  const hours = [0, 1, 2, 3, 4, 5, 6].map((h) => t0 + (30 + h * 60) * 60e3).filter((t) => t < t1);
  return (
    <div className="cl-chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onMouseMove={move} onMouseLeave={() => setHover(null)} role="img"
        aria-label={`${symbol} today in five-minute steps, with your strikes`}>
        <defs>
          <linearGradient id={`cl-g-${symbol}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" className={up ? 'cl-stop-up' : 'cl-stop-down'} stopOpacity="0.28" /><stop offset="1" className={up ? 'cl-stop-up' : 'cl-stop-down'} stopOpacity="0" />
          </linearGradient>
        </defs>
        {hours.map((t) => <line key={t} x1={sx(t)} x2={sx(t)} y1={T} y2={H - B} className="cl-grid" />)}
        {hours.map((t) => <text key={`h${t}`} x={sx(t)} y={H - 6} textAnchor="middle" className="cl-axis">{new Date(t).toLocaleTimeString('en-CA', { hour: 'numeric', timeZone: 'America/Regina' })}</text>)}
        {prev != null && <line x1={L} x2={W - R} y1={sy(prev)} y2={sy(prev)} className="cl-prev" />}
        {prev != null && <text x={L + 4} y={sy(prev) - 4} className="cl-axis">yesterday {usd(prev, 2)}</text>}
        {shown.map((l, i) => <line key={i} x1={L} x2={W - R} y1={sy(l.price)} y2={sy(l.price)} className={`cl-k cl-k-${l.kind}`} />)}
        <path d={`${d}L${sx(last.t).toFixed(1)},${H - B}L${sx(t0)},${H - B}Z`} fill={`url(#cl-g-${symbol})`} />
        <path d={d} className={`cl-price ${up ? 'up' : 'down'}`} />
        <circle cx={sx(last.t)} cy={sy(last.price)} r="7" className={`cl-pulse ${up ? 'up' : 'down'}`} />
        <circle cx={sx(last.t)} cy={sy(last.price)} r="3.2" className={`cl-last ${up ? 'up' : 'down'}`} />
        {tags.map((t, i) => (
          <text key={i} x={W - R + 6} y={t.y + 3.5} className={`cl-tag cl-tag-${t.kind}`}>{t.kind === 'now' ? t.label : `${t.label}`}</text>
        ))}
        {hover && (
          <g>
            <line x1={sx(hover.t)} x2={sx(hover.t)} y1={T} y2={H - B} className="cl-cross" />
            <circle cx={sx(hover.t)} cy={sy(hover.price)} r="3.5" className="cl-dot" />
          </g>
        )}
      </svg>
      <div className="cl-chart-foot">
        <span className="cl-tip">{hover
          ? <>{new Date(hover.t).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Regina' })}: <b>{usd(hover.price, 2)}</b>{prev ? <span className={sign(hover.price - prev)}> {pctS(((hover.price - prev) / prev) * 100, 2)}</span> : null}</>
          : <span className="cc-faint">five-minute prices, your time · the lines are your strikes</span>}</span>
        {off.length > 0 && <span className="cl-off">{off.map((l, i) => <span key={i} className={`cl-off-chip cl-tag-${l.kind}`}>{l.price > last.price ? '▲' : '▼'} {l.label}</span>)}</span>}
      </div>
    </div>
  );
}

/** Profit or loss by the stock's price: at the nearest expiry (solid), and today by model (dashed). */
export function PayoffChart({ curve, price, breakevens, strikes, horizon, compact = false }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const id = useMemo(() => `cl-p-${Math.random().toString(36).slice(2, 8)}`, []);
  if (!curve?.length) return null;
  const W = 720; const H = compact ? 190 : 240; const L = 62; const R = 12; const T = 12; const B = 26;
  const xs = curve.map((p) => p.price);
  const hasNow = curve.some((p) => Number.isFinite(p.now));
  const ys = curve.flatMap((p) => (hasNow ? [p.pnl, p.now] : [p.pnl]));
  const x0 = Math.min(...xs); const x1 = Math.max(...xs);
  const yMin = Math.min(0, ...ys); const yMax = Math.max(0, ...ys); const pad = (yMax - yMin) * 0.08 || 1;
  const sx = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const sy = (v) => T + ((yMax + pad - v) / (yMax - yMin + 2 * pad)) * (H - T - B);
  const line = (k) => curve.map((p, i) => `${i ? 'L' : 'M'}${sx(p.price).toFixed(1)},${sy(p[k]).toFixed(1)}`).join('');
  const area = `${line('pnl')}L${sx(x1).toFixed(1)},${sy(0).toFixed(1)}L${sx(x0).toFixed(1)},${sy(0).toFixed(1)}Z`;
  const ticks = [yMin, 0, yMax].filter((v, i, a) => a.indexOf(v) === i);
  const at = (v) => curve.reduce((a, c) => (Math.abs(c.price - v) < Math.abs(a.price - v) ? c : a));
  const move = (e) => {
    const box = ref.current.getBoundingClientRect();
    setHover(at(x0 + (((e.clientX - box.left) / box.width) * W - L) / (W - L - R) * (x1 - x0)));
  };
  const here = at(price);
  return (
    <div className="cl-chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onMouseMove={move} onMouseLeave={() => setHover(null)} role="img"
        aria-label="Profit or loss by the stock's price: at the nearest expiry and today">
        <defs>
          <clipPath id={`${id}-up`}><rect x={L} y={T} width={W - L - R} height={Math.max(0, sy(0) - T)} /></clipPath>
          <clipPath id={`${id}-dn`}><rect x={L} y={sy(0)} width={W - L - R} height={Math.max(0, H - B - sy(0))} /></clipPath>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} className={v === 0 ? 'cl-zero' : 'cl-grid'} />
            <text x={L - 6} y={sy(v) + 4} textAnchor="end" className="cl-axis">{cad(v)}</text>
          </g>
        ))}
        <path d={area} className="cl-area-up" clipPath={`url(#${id}-up)`} />
        <path d={area} className="cl-area-dn" clipPath={`url(#${id}-dn)`} />
        {(strikes || []).map((k, i) => k > x0 && k < x1 && <line key={`k${i}`} x1={sx(k)} x2={sx(k)} y1={T} y2={H - B} className="cl-strike" />)}
        {[...new Set((strikes || []).filter((k) => k > x0 && k < x1))].sort((a, b) => a - b).reduce((acc, k) => { const prev = acc.at(-1); const row = prev && sx(k) - sx(prev.k) < 26 ? (prev.row + 1) % 3 : 0; acc.push({ k, row }); return acc; }, [])
          .map(({ k, row }) => <text key={`t${k}`} x={sx(k)} y={T + 9 + row * 11} textAnchor="middle" className="cl-axis">{k}</text>)}
        <text x={L} y={H - 8} className="cl-axis">{usd(x0)}</text>
        <text x={W - R} y={H - 8} textAnchor="end" className="cl-axis">{usd(x1)}</text>
        {hasNow && <path d={line('now')} className="cl-line-now" />}
        <path d={line('pnl')} className="cl-line-exp" pathLength="1" />
        {(breakevens || []).filter((b) => b > x0 && b < x1).map((b) => <circle key={b} cx={sx(b)} cy={sy(0)} r="4" className="cl-be" />)}
        <g className="cl-here" style={{ transform: `translateX(${sx(price)}px)` }}>
          <line x1="0" x2="0" y1={T} y2={H - B} className="cl-now-line" />
          <text x="0" y={H - 8} textAnchor="middle" className="cl-axis cl-axis-now">now {usd(price, 2)}</text>
        </g>
        <circle cx={sx(price)} cy={sy(hasNow ? here.now : here.pnl)} r="4.5" className="cl-here-dot" />
        {hover && (
          <g>
            <line x1={sx(hover.price)} x2={sx(hover.price)} y1={T} y2={H - B} className="cl-cross" />
            <circle cx={sx(hover.price)} cy={sy(hover.pnl)} r="4" className="cl-dot" />
            {hasNow && <circle cx={sx(hover.price)} cy={sy(hover.now)} r="3" className="cl-dot cl-dot-now" />}
          </g>
        )}
      </svg>
      <div className="cl-chart-foot">
        <span className="cl-tip">{hover
          ? <>At {usd(hover.price, 2)}: <b className={sign(hover.pnl)}>{cad(hover.pnl)}</b> {horizon ? `on ${short(horizon)}` : 'at expiry'}{hasNow ? <> · <b className={sign(hover.now)}>{cad(hover.now)}</b> today</> : null}</>
          : <span className="cc-faint"><i className="cl-key cl-key-exp" /> {horizon ? `on ${short(horizon)}, the nearest expiry` : 'at the nearest expiry'}{hasNow ? <> · <i className="cl-key cl-key-now" /> today, by model</> : null} · dots are breakevens</span>}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- where the price sits among his strikes
/**
 * A ruler of the stock's price with his strikes on it: what each stretch means for the shares. Under a bought put the fall is
 * insured; under a put sold against it (a spread) it isn't any more; above a sold call the shares are called away.
 */
export function StrikeMap({ p }) {
  const f = p.figures || {}; const g = p.greeks || {};
  const S = p.price;
  const legs = g.legs || [];
  const calls = legs.filter((l) => l.type === 'call' && l.side !== 'long').map((l) => l.strike);
  const ins = (f.put_spreads || []).filter((s) => s.kind === 'insurance');
  const inc = (f.put_spreads || []).filter((s) => s.kind === 'income');
  const plainPuts = (f.plain_puts || []).map((x) => x.strike);
  const top = calls.length ? Math.min(...calls) : null;
  const putTop = [...plainPuts, ...ins.map((s) => s.long_strike)].length ? Math.max(...plainPuts, ...ins.map((s) => s.long_strike)) : null;
  const ends = f.protection_ends || null;
  const marks = [S, p.cost, top, putTop, ends, ...inc.flatMap((s) => [s.short_strike, s.long_strike]), ...(f.sold_puts || []).map((x) => x.strike), ...(f.breakevens || [])].filter((x) => x > 0);
  if (marks.length < 2) return null;
  const lo = Math.min(...marks) * 0.965; const hi = Math.max(...marks) * 1.035;
  const pos = (v) => `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100)).toFixed(2)}%`;
  const zones = [];
  let edge = lo;
  const zone = (to, cls, word) => { if (to > edge) { zones.push({ from: edge, to, cls, word }); edge = to; } };
  if (putTop != null) {
    if (ends != null) { zone(ends, 'bare', 'unprotected'); zone(putTop, 'insured', 'insured by the spread'); } else zone(putTop, 'insured', 'insured by the put');
  }
  zone(top ?? hi, 'open', putTop != null || top != null ? 'the shares move dollar for dollar' : '');
  if (top != null) zone(hi, 'capped', 'called away');
  const ticks = [
    ...(top != null ? [{ v: top, k: 'call', word: `${top} call sold` }] : []),
    ...(putTop != null ? [{ v: putTop, k: 'put', word: `${putTop} put held` }] : []),
    ...(ends != null ? [{ v: ends, k: 'sold_put', word: `${ends} put sold` }] : []),
    ...inc.flatMap((s) => [{ v: s.short_strike, k: 'sold_put', word: `${s.short_strike} put sold (income)` }, { v: s.long_strike, k: 'put', word: `${s.long_strike} put held under it` }]),
    ...(f.sold_puts || []).map((x) => ({ v: x.strike, k: 'sold_put', word: `${x.strike} put sold` })),
    { v: p.cost, k: 'cost', word: `cost ${usd(p.cost, 2)}` },
    ...(f.breakevens || []).map((b) => ({ v: b, k: 'even', word: `breakeven ${usd(b, 2)}` })),
  ].filter((t) => t.v > lo && t.v < hi);
  return (
    <div className="cl-map" role="img" aria-label={`${p.symbol} at ${usd(S, 2)} among your strikes`}>
      <div className="cl-map-bar">
        {zones.map((z, i) => <span key={i} className={`cl-zone cl-zone-${z.cls}`} style={{ left: pos(z.from), width: `calc(${pos(z.to)} - ${pos(z.from)})` }} title={z.word}><em>{z.word}</em></span>)}
        {ticks.map((t, i) => <i key={i} className={`cl-tick cl-tick-${t.k}`} style={{ left: pos(t.v) }} title={t.word} />)}
        <span className="cl-pointer" style={{ left: pos(S) }}><b>{usd(S, 2)}</b></span>
      </div>
      <div className="cl-map-keys">{ticks.map((t, i) => <span key={i} className={`cl-mapkey cl-tag-${t.k}`}>{t.word}</span>)}</div>
    </div>
  );
}

// ---------------------------------------------------------------- the greeks
function Meter({ part, cls = '' }) {
  return <span className={`cl-meter ${cls}`}><i style={{ width: `${Math.min(100, Math.max(0, part * 100)).toFixed(1)}%` }} /></span>;
}
/** Delta, gamma, theta and vega in the units he trades in, each with what it means in a line. */
export function Greeks({ g, rules, shares }) {
  if (!g) return null;
  const hot = rules && Math.abs(g.gamma) >= rules.alert_gamma;
  return (
    <div className="cl-greeks">
      <div className="cl-greek">
        <span className="cc-k">Delta</span>
        <b><Num v={g.delta} f={(x) => x.toFixed(0)} /> <small>shares’ worth</small></b>
        <Meter part={Math.abs(g.delta) / Math.max(1, shares || Math.abs(g.delta))} cls={g.delta < 0 ? 'neg' : ''} />
        <span className="cc-faint">{cad(Math.abs(g.per_dollar))} for each US$1 on the stock · {cad(Math.abs(g.per_1pct))} for 1%</span>
      </div>
      <div className={`cl-greek${hot ? ' hot' : ''}`}>
        <span className="cc-k">Gamma</span>
        <b><Num v={g.gamma} f={(x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}`} /> <small>shares per US$1</small></b>
        <Meter part={rules ? Math.abs(g.gamma) / rules.alert_gamma : 0} cls={hot ? 'warn' : ''} />
        <span className="cc-faint">{g.gamma < 0 ? 'a rise takes exposure away, a fall adds it back' : g.gamma > 0 ? 'a rise adds exposure, a fall takes it away' : 'delta holds steady'}{rules ? ` · you’re told at ${rules.alert_gamma}` : ''}</span>
      </div>
      <div className="cl-greek">
        <span className="cc-k">Theta</span>
        <b className={sign(g.theta)}><Num v={g.theta} f={(x) => signed(x)} /> <small>a day</small></b>
        <Meter part={Math.min(1, Math.abs(g.theta) / 150)} cls={g.theta < 0 ? 'neg' : 'pos'} />
        <span className="cc-faint">{g.theta >= 0 ? 'time is paying you: what a day’s decay hands over' : 'time is costing you: the options you hold lose this a day'}</span>
      </div>
      <div className="cl-greek">
        <span className="cc-k">Vega</span>
        <b className={sign(g.vega)}><Num v={g.vega} f={(x) => signed(x)} /> <small>a volatility point</small></b>
        <Meter part={Math.min(1, Math.abs(g.vega) / 150)} cls={g.vega < 0 ? 'neg' : 'pos'} />
        <span className="cc-faint">{g.vega >= 0 ? 'calmer markets cost you, jumpier ones pay' : 'calmer markets pay you, jumpier ones cost'}</span>
      </div>
    </div>
  );
}

/** Each option he holds: what he got or paid, what it's worth now, how much time has handed over, how far from its strike. */
export function LegLadder({ p }) {
  const legs = p.greeks?.legs || [];
  if (!legs.length) return <p className="cc-faint">No options on it: nothing coming in.</p>;
  const mine = (l) => (p.open_legs || []).find((o) => o.type === l.type && o.side === l.side && Number(o.strike) === l.strike && o.expiry === l.expiry) || {};
  return (
    <div className="table-scroll">
      <table className="cc-table cl-legs">
        <thead><tr><th>Option</th><th>Expires</th><th className="num">For / paid</th><th className="num">Worth now</th><th className="num">Its gain or loss</th>
          <th title="Of a sold option's premium, how much time has handed over; for one you hold, how much of what you paid is left">Decay</th>
          <th className="num" title="How far the stock is from the strike">From strike</th><th className="num" title="Delta: roughly the chance it ends in the money">Δ</th></tr></thead>
        <tbody>
          {legs.map((l, i) => {
            const o = mine(l);
            const sold = l.side !== 'long';
            const part = sold ? (l.earned_pct ?? 0) / 100 : l.premium > 0 ? l.value / l.premium : 0;
            return (
              <tr key={i} className="cl-leg">
                <td><span className={`cl-chip ${sold ? 'sold' : 'own'} ${l.type}`}>{sold ? 'Sold' : 'Own'} {l.contracts} × {l.strike} {l.type}</span>{l.itm && <span className="badge warn"> IN THE MONEY</span>}</td>
                <td>{short(l.expiry)}<span className="cc-opt"><span>{l.sessions <= 1 ? (l.days < 1 ? 'today' : 'next session') : `${l.sessions} sessions`}{o.since ? ` · opened ${day(o.since)}` : ''}</span></span></td>
                <td className="num">{l.premium.toFixed(2)}<span className="cc-opt"><span>{sold ? '+' : '−'}{cad(o.per_day ?? 0)} a trading day</span></span></td>
                <td className="num"><Num v={o.now ?? l.value} f={(x) => x.toFixed(2)} /><span className="cc-opt"><span>{o.modelled ? 'est.' : o.quoted ? 'quoted' : 'by model'}{o.quoted?.bid != null && o.modelled ? ` · was ${Number(o.quoted.mid).toFixed(2)}` : ''}</span></span></td>
                <td className={`num ${sign(l.pnl)}`}><Num v={l.pnl} f={(x) => signed(x)} /></td>
                <td className="cl-decay"><Meter part={part} cls={sold ? 'pos' : 'own'} />
                  <span className="cc-opt"><span>{sold ? ((l.earned_pct ?? 0) >= 0 ? `${Math.round(l.earned_pct ?? 0)}% earned · ${cad(l.left_to_earn ?? 0)} of time value left` : `worth ${Math.round(100 - l.earned_pct)}% of what you sold it for`) : `worth ${Math.round(part * 100)}% of what you paid`}</span></span></td>
                <td className="num">{pctS(l.from_strike_pct)}<span className="cc-opt"><span>{usd(Math.abs(p.price - l.strike), 2)} {p.price >= l.strike ? 'above' : 'below'}</span></span></td>
                <td className="num">{Math.abs(l.delta_one).toFixed(2)}<span className="cc-opt"><span>IV {l.iv.toFixed(0)}%{l.iv_assumed ? ' assumed' : ''}</span></span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** What the puts on a position are doing, in a sentence each. */
export function PutStructure({ f }) {
  const s = f?.put_spreads || []; const plainPuts = f?.plain_puts || []; const sold = f?.sold_puts || [];
  if (!s.length && !plainPuts.length && !sold.length) return null;
  return (
    <div className="cl-puts">
      {s.filter((x) => x.kind === 'insurance').map((x, i) => (
        <div key={`i${i}`} className="cl-put-line insured">
          <span className="cl-badge put">Insurance spread</span>
          <span>Own the <b>{x.long_strike}</b> put, sold the <b>{x.short_strike}</b> under it{x.diagonal ? ` (${day(x.long_expiry)} and ${day(x.short_expiry)})` : ` to ${day(x.long_expiry)}`}: it cost <b>{cad(x.cost)}</b> and pays for a fall from {x.long_strike} to {x.short_strike}, up to <b>{cad(x.most_it_pays)}</b>.
            {f.protection_ends ? <> Below <b>{f.protection_ends}</b> the shares fall unprotected: at {f.protection_ends} you’re <b className="neg">{cad(f.loss_at_protection_end)}</b>.</> : null}</span>
        </div>
      ))}
      {plainPuts.map((x, i) => (
        <div key={`p${i}`} className="cl-put-line insured">
          <span className="cl-badge put">Put</span>
          <span>Own {x.contracts} × the <b>{x.strike}</b> put to {day(x.expiry)} for <b>{cad(x.cost)}</b>: it insures the fall from {x.strike} all the way down{f.loss_at_put != null && f.put_strike === x.strike ? <>; at {x.strike} you’re <b className="neg">{cad(f.loss_at_put)}</b></> : null}.</span>
        </div>
      ))}
      {s.filter((x) => x.kind === 'income').map((x, i) => (
        <div key={`c${i}`} className="cl-put-line income">
          <span className="cl-badge income">Income spread</span>
          <span>Sold {x.contracts} × the <b>{x.short_strike}</b> put, own the <b>{x.long_strike}</b> under it to {day(x.short_expiry)}: <b className="pos">{cad(x.credit)}</b> in. You keep it all above {x.short_strike}, break even at {usd(x.breakeven, 2)}, and can lose at most <b className="neg">{cad(Math.abs(x.max_loss))}</b> below {x.long_strike}.</span>
        </div>
      ))}
      {sold.map((x, i) => (
        <div key={`s${i}`} className="cl-put-line income">
          <span className="cl-badge income">Put sold</span>
          <span>Sold {x.contracts} × the <b>{x.strike}</b> put to {day(x.expiry)} for <b className="pos">{cad(x.credit)}</b>, with no put under it: below {x.strike} at expiry you’d buy {x.buys_shares} shares at {x.strike}.</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- what's worth knowing
const KIND_WORD = { drop: 'Drop', move: 'Move', swing: 'Fast move', call: 'Call', put: 'Put', spread: 'Spread', gamma: 'Gamma', theta: 'Theta', expiry: 'Expiry', iv: 'Volatility', earnings: 'Earnings' };
export function Signals({ list }) {
  const [open, setOpen] = useState(null);
  if (!list?.length) return null;
  return (
    <div className="cl-signals">
      {list.map((s) => (
        <button key={s.id} type="button" className={`cl-signal ${s.level} k-${s.kind}${open === s.id ? ' on' : ''}`} onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
          <span className="cl-signal-k">{KIND_WORD[s.kind] || s.kind}</span>{s.title}
        </button>
      ))}
      {open && <p className="cl-signal-text">{list.find((s) => s.id === open)?.text}</p>}
    </div>
  );
}

const dropWords = (a) => `${(a.why || []).join('; ')} (${usd(a.price, 2)}).${a.picked?.call ? ` Your rules: sell the ${a.picked.call.strike} call ${short(a.picked.call.expiry)} for ${Number(a.picked.call.bid).toFixed(2)}${a.picked.put ? `, buy the ${a.picked.put.strike} put` : ''}${a.picked.spread ? ` (or the ${a.picked.spread.buy}/${a.picked.spread.sell} spread for ${Number(a.picked.spread.debit).toFixed(2)})` : ''}.` : a.note ? ` ${a.note}` : ''}`;
const Bell = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v3.6L4.3 16a1 1 0 0 0 .9 1.5h13.6a1 1 0 0 0 .9-1.5L18 12.6V9a6 6 0 0 0-6-6Zm-2.2 16.5a2.3 2.3 0 0 0 4.4 0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
/**
 * The watcher's notes: a bell with what's new, the list, a pop-up for each one that arrives while the page is open, and (once
 * he allows it) the computer's own notifications. High ones also go to Mike Burry's chat in Andrew.
 */
export function AlertCenter({ onPick }) {
  const [feed, setFeed] = useState(null);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const known = useRef(null);
  const load = () => send('GET', '/api/options/alerts').then((f) => {
    setFeed(f);
    const ids = new Set(f.alerts.map((a) => a.id));
    if (known.current) {
      const fresh = f.alerts.filter((a) => !known.current.has(a.id)).slice(0, 4);
      if (fresh.length) {
        setToasts((t) => [...fresh, ...t].slice(0, 5));
        setTimeout(() => setToasts((t) => t.filter((x) => !fresh.includes(x))), 15000);
        if (perm === 'granted') for (const a of fresh) { try { new Notification(a.title || `${a.symbol} dropped by your rule`, { body: a.text || dropWords(a), tag: a.id }); } catch { /* the pop-up on the page stands */ } }
      }
    }
    known.current = ids;
  }).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 60e3); return () => clearInterval(t); }, [perm]);
  // Opening it reads the list again first, so what's marked seen is what's on the screen. The new ones keep their mark
  // (fresh) until it's opened the next time.
  const show = () => {
    const next = !open; setOpen(next);
    if (next) load().then(() => send('POST', '/api/options/alerts/seen')).then(() => setFeed((f) => f && { ...f, unseen: 0 })).catch(() => {});
  };
  const allow = () => Notification.requestPermission().then(setPerm).catch(() => {});
  const byDay = useMemo(() => {
    const m = new Map();
    for (const a of feed?.alerts || []) { if (!m.has(a.date)) m.set(a.date, []); m.get(a.date).push(a); }
    return [...m.entries()];
  }, [feed]);
  return (
    <>
      <div className="cl-bell-wrap">
        <button type="button" className={`cl-bell${feed?.unseen ? ' new' : ''}`} onClick={show} aria-expanded={open} title="What the watcher has noted">
          <Bell /> <span>Notes</span>{feed?.unseen ? <b>{feed.unseen}</b> : null}
        </button>
        {open && (
          <div className="cl-feed" role="dialog" aria-label="What the watcher has noted">
            <div className="cl-feed-head">
              <span>What the watcher has noted</span>
              {perm === 'default' && <button type="button" className="small secondary" onClick={allow}>Notify me on this computer</button>}
              {perm === 'granted' && <span className="cc-faint">this computer notifies you while the page is open</span>}
              {perm === 'denied' && <span className="cc-faint">this browser has notifications blocked for Money Hub</span>}
            </div>
            <p className="cc-faint cl-feed-note">Checked every five minutes while the US market is open, by the levels under Your rules → What you’re told about. The ones marked high also go to Mike Burry’s chat in Andrew, and from there to your phone.</p>
            {!byDay.length && <p className="cc-faint cl-feed-note">Nothing noted yet.</p>}
            <div className="cl-feed-list">
              {byDay.map(([d, list]) => (
                <div key={d}>
                  <div className="cl-feed-day">{short(d)}</div>
                  {list.map((a) => (
                    <button key={a.id} type="button" className={`cl-note ${a.level || 'high'} k-${a.kind}${feed.seen_at && a.at <= feed.seen_at ? '' : ' fresh'}`} onClick={() => { onPick?.(a.symbol); setOpen(false); }}>
                      <span className="cl-note-top"><span className="cl-signal-k">{KIND_WORD[a.kind] || 'Drop'}</span><b>{a.title || `${a.symbol} dropped by your rule`}</b><time>{asOf(a.at)}</time></span>
                      <span className="cl-note-text">{a.text || dropWords(a)}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="cl-toasts" aria-live="polite">
        {toasts.map((a) => (
          <div key={a.id} className={`cl-toast ${a.level || 'high'} k-${a.kind}`}>
            <b>{a.title || `${a.symbol} dropped by your rule`}</b><span>{a.text || dropWords(a)}</span>
            <button type="button" className="small-link" onClick={() => setToasts((t) => t.filter((x) => x !== a))} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- where the prices come from
/** Stocks live; options from MarketData.app on his token: the plan, how old its prices are, today's allowance, the token box. */
export function DataBar({ data, onSaved }) {
  const [edit, setEdit] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!data) return null;
  const o = data.options;
  const save = (t) => {
    setBusy(true); setErr(null);
    send('PUT', '/api/options/data/token', { token: t }).then((d) => { setToken(''); setEdit(false); onSaved(d); }).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  const left = o.limit ? o.remaining / o.limit : null;
  const spent = Object.entries(o.spent_today || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className={`cl-data${!o.has_token || o.error ? ' need' : ''}`}>
      <div className="cl-data-row">
        <span className="cl-live"><i /> Stock prices live</span>
        {o.has_token ? (
          <>
            <span>Options: <b>MarketData.app{o.plan ? ` ${o.plan}` : ''}</b>{o.delay ? <> · prices {o.delay === 'real time' ? 'in real time' : `${o.delay} old`}{o.delay_minutes > 60 ? ', brought to today’s stock price by model' : ''}</> : ' · plan shown after the first price is read'}</span>
            {o.limit != null && (
              <span className="cl-credits" title={spent.length ? `Today: ${spent.map(([k, v]) => `${v} on ${k}`).join(', ')}` : 'None used yet today'}>
                <span className={`cl-meter ${left < 0.2 ? 'warn' : 'pos'}`}><i style={{ width: `${Math.max(0, left * 100).toFixed(0)}%` }} /></span>
                <b>{o.remaining}</b> of {o.limit.toLocaleString('en-US')} option prices left today{o.resets_at ? ` · more at ${asOf(o.resets_at)}` : ''}
              </span>
            )}
            <button type="button" className="small-link" onClick={() => setEdit(!edit)}>{edit ? 'close' : 'token'}</button>
          </>
        ) : (
          <span><b>No option prices yet.</b> Paste your MarketData.app token and the page prices your options, greeks and spreads.</span>
        )}
      </div>
      {o.error && <p className="review-error">{o.error}</p>}
      {(edit || !o.has_token) && (
        <div className="cl-data-token">
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="MarketData.app token (Dashboard → API tokens)" autoComplete="off" aria-label="MarketData.app token"
            onKeyDown={(e) => e.key === 'Enter' && token.trim() && !busy && save(token)} />
          <button type="button" className="small" disabled={busy || !token.trim()} onClick={() => save(token)}>{busy ? 'Checking it…' : 'Save token'}</button>
          {o.has_token && <button type="button" className="small secondary" disabled={busy} onClick={() => window.confirm('Forget the token? The page goes back to stock prices only.') && save('')}>Forget it</button>}
          <span className="cc-faint">Checked with one request, kept on the server, never shown again.</span>
        </div>
      )}
      {err && <p className="review-error">{err}</p>}
      {o.has_token && o.limit != null && o.limit <= 100 && (
        <p className="cc-faint cl-data-note">The Free plan bills each option price it returns, 100 a day, a day old. Your own options are read one price each; pricing a stock’s plan takes about {data.plan_cost}, a spread table about a dozen. So this page prices a stock when you ask, and keeps what it read. The Starter plan (10,000 a day, 15 minutes old) would let the watcher price your whole list by itself.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the tape
/** Prices running across the top: what he holds first, then the day's biggest movers on his lists. */
export function Tape({ items }) {
  if (!items?.length) return null;
  const row = (dup) => items.map((x) => (
    <span key={`${dup}${x.symbol}`} className={`cl-tape-item${x.held ? ' held' : ''}`} aria-hidden={dup ? 'true' : undefined}>
      <b>{x.symbol}</b> {usd(x.price, 2)} <span className={sign(x.day_pct)}>{x.day_pct > 0 ? '▲' : x.day_pct < 0 ? '▼' : ''} {pctS(x.day_pct, 2)}</span>
    </span>
  ));
  return <div className="cl-tape" aria-label="Prices now"><div className="cl-tape-run" style={{ animationDuration: `${Math.max(28, items.length * 5)}s` }}>{row('')}{row('b')}</div></div>;
}

// ---------------------------------------------------------------- the option income, over time
/** What the options have brought in and cost, added up day by day from his Money Hub entries: calls, puts, and the net. */
export function IncomeChart({ entries, toUsd }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const days = useMemo(() => {
    const m = new Map();
    for (const e of entries || []) {
      if (e.kind !== 'call' && e.kind !== 'put') continue;
      const d = m.get(e.date) || { date: e.date, call: 0, put: 0 };
      d[e.kind] += toUsd(e.amount);
      m.set(e.date, d);
    }
    let c = 0; let p = 0;
    return [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => { c += d.call; p += d.put; return { ...d, calls: c, puts: p, net: c + p }; });
  }, [entries]);
  if (days.length < 2) return null;
  const W = 720; const H = 190; const L = 62; const R = 12; const T = 12; const B = 24;
  const t = (iso) => Date.parse(`${iso}T12:00:00Z`);
  const t0 = t(days[0].date); const t1 = Math.max(t(days.at(-1).date), Date.now());
  const vals = days.flatMap((d) => [d.calls, d.puts, d.net]);
  const yMin = Math.min(0, ...vals); const yMax = Math.max(0, ...vals); const pad = (yMax - yMin) * 0.08 || 1;
  const sx = (ms) => L + ((ms - t0) / (t1 - t0 || 1)) * (W - L - R);
  const sy = (v) => T + ((yMax + pad - v) / (yMax - yMin + 2 * pad)) * (H - T - B);
  // Stepped: the total holds until the next trade.
  const step = (k) => days.map((d, i) => `${i ? `H${sx(t(d.date)).toFixed(1)}V` : `M${sx(t(d.date)).toFixed(1)},`}${sy(d[k]).toFixed(1)}`).join('') + `H${sx(t1).toFixed(1)}`;
  const fill = (k) => `${step(k)}V${sy(0).toFixed(1)}H${sx(t0).toFixed(1)}Z`;
  const move = (e) => {
    const box = ref.current.getBoundingClientRect();
    const ms = t0 + (((e.clientX - box.left) / box.width) * W - L) / (W - L - R) * (t1 - t0);
    setHover([...days].reverse().find((d) => t(d.date) <= ms) || days[0]);
  };
  const last = days.at(-1);
  return (
    <div className="cl-chart cl-income">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onMouseMove={move} onMouseLeave={() => setHover(null)} role="img" aria-label="Calls collected, puts paid and the net, added up over time">
        {[yMin, 0, yMax].filter((v, i, a) => a.indexOf(v) === i).map((v) => (
          <g key={v}><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} className={v === 0 ? 'cl-zero' : 'cl-grid'} /><text x={L - 6} y={sy(v) + 4} textAnchor="end" className="cl-axis">{cad(v)}</text></g>
        ))}
        <path d={fill('calls')} className="cl-inc-calls-fill" /><path d={fill('puts')} className="cl-inc-puts-fill" />
        <path d={step('calls')} className="cl-inc-calls" /><path d={step('puts')} className="cl-inc-puts" />
        <path d={step('net')} className="cl-inc-net" pathLength="1" />
        <text x={L} y={H - 7} className="cl-axis">{day(days[0].date)}</text><text x={W - R} y={H - 7} textAnchor="end" className="cl-axis">today</text>
        <circle cx={sx(t1)} cy={sy(last.net)} r="4" className="cl-inc-dot" />
        {hover && <line x1={sx(t(hover.date))} x2={sx(t(hover.date))} y1={T} y2={H - B} className="cl-cross" />}
      </svg>
      <div className="cl-chart-foot"><span className="cl-tip">{hover
        ? <>By {day(hover.date)}: calls <b className="pos">{signed(hover.calls)}</b> · puts <b className={sign(hover.puts)}>{signed(hover.puts)}</b> · net <b className={sign(hover.net)}>{signed(hover.net)}</b></>
        : <span className="cc-faint"><i className="cl-key cl-key-calls" /> calls collected · <i className="cl-key cl-key-puts" /> puts, net · <i className="cl-key cl-key-net" /> options so far</span>}</span></div>
    </div>
  );
}

// ---------------------------------------------------------------- put spreads
/**
 * Put spreads on one stock (Jake, Nov 20: "it now uses put spreads"; both kinds): pick the kind, the expiry, how far under
 * the price and how wide; each row is today's prices, bought at the ask and sold at the bid. With his shares it shows what
 * the position would be worth with that spread on.
 */
export function SpreadBuilder({ symbol, position, rules, onLoad, data }) {
  const [kind, setKind] = useState('insurance');
  // The put he holds on it sets the expiry to start from (an insurance spread sits beside the put it would replace).
  const heldPut = (position?.open_legs || []).filter((l) => l.type === 'put' && l.side === 'long').map((l) => l.expiry).sort().at(-1) || '';
  const [expiry, setExpiry] = useState(heldPut);
  const [width, setWidth] = useState(rules.spread_width);
  const [otm, setOtm] = useState(rules.put_otm);
  const [t, setT] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [pickRow, setPickRow] = useState(null);
  const [figs, setFigs] = useState(null);
  const price = () => {
    setBusy(true); setErr(null); setPickRow(null); setFigs(null);
    const q = new URLSearchParams({ kind, width: String(width), otm: String(otm), ...(expiry ? { expiry } : {}) });
    send('GET', `/api/options/spreads/${symbol}?${q}`).then((d) => { setT(d); setExpiry(d.expiry); }).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  // His position with this spread on: an insurance spread replaces the puts he holds; an income spread is added.
  const legsWith = (r) => {
    const mine = (position?.open_legs || []).map((l) => ({ ...l, premium: Number(l.premium), contracts: Number(l.contracts) || 1 }));
    const lots = Math.max(1, Math.floor((position?.shares || 100) / 100));
    const buy = { type: 'put', side: 'long', strike: r.buy.strike, expiry: r.expiry, premium: r.buy.ask, contracts: lots, iv: r.buy.iv, delta: r.buy.delta };
    const sell = { type: 'put', side: 'short', strike: r.sell.strike, expiry: r.expiry, premium: r.sell.bid, contracts: lots, iv: r.sell.iv, delta: r.sell.delta };
    return [...(r.kind === 'insurance' ? mine.filter((l) => l.type !== 'put') : mine), buy, sell];
  };
  const choose = (r) => {
    setPickRow(r); setFigs(null);
    if (!t) return;
    send('POST', '/api/options/evaluate', { position: { price: t.quote.price, shares: position?.shares ?? 0, cost: position?.cost ?? t.quote.price, legs: legsWith(r) } }).then(setFigs).catch((e) => setErr(e.message));
  };
  const o = data?.options;
  return (
    <div className="cl-spread">
      <div className="cl-spread-head">
        <div className="cl-seg" role="tablist" aria-label="Kind of spread">
          <button type="button" role="tab" aria-selected={kind === 'insurance'} className={kind === 'insurance' ? 'on' : ''} onClick={() => { setKind('insurance'); setT(null); setPickRow(null); }}>Insurance: buy a put, sell a lower one</button>
          <button type="button" role="tab" aria-selected={kind === 'income'} className={kind === 'income' ? 'on' : ''} onClick={() => { setKind('income'); setT(null); setPickRow(null); }}>Income: sell a put, buy a lower one</button>
        </div>
      </div>
      <div className="cc-row">
        <label className="cc-mini">Expiry<select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
          <option value="">{kind === 'insurance' ? 'the longest in your put window' : 'the first a week out'}</option>
          {expiry && !(t?.expiries || []).some((e) => e.date === expiry) && <option value={expiry}>{short(expiry)}</option>}
          {(t?.expiries || []).map((e) => <option key={e.date} value={e.date}>{short(e.date)} · {e.days} days</option>)}</select></label>
        <label className="cc-mini">{kind === 'insurance' ? 'Bought put at least this far under the price (US$)' : 'Sold put at least this far under the price (US$)'}<input type="number" step="1" min="0" value={otm} onChange={(e) => setOtm(e.target.value)} /></label>
        <label className="cc-mini">Strikes this far apart (US$)<input type="number" step="1" min="0.5" value={width} onChange={(e) => setWidth(e.target.value)} /></label>
        <button type="button" className="small" disabled={busy || !o?.has_token} onClick={price}>{busy ? 'Pricing…' : t ? 'Price again' : 'Price the spreads'}</button>
        <span className="cc-faint">{o?.has_token ? `about a dozen of today’s option prices${o.remaining != null ? ` (${o.remaining} left)` : ''}` : 'needs your MarketData.app token (the Data box at the top)'}</span>
      </div>
      {err && <p className="review-error">{err}</p>}
      {t && !t.rows.length && <p className="cc-faint">No spread fits: no pair of puts {width} apart at least US${otm} under {usd(t.quote.price, 2)} on {short(t.expiry)} has prices.</p>}
      {t && t.rows.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="cc-table cl-spreads">
              {kind === 'insurance' ? (
                <thead><tr><th>Buy</th><th>Sell</th><th className="num">Costs</th><th className="num" title="The spread's cost over the trading days to its expiry">A trading day</th><th className="num" title="The gap between the strikes less what it cost">Most it pays</th>
                  <th className="num" title="The same put bought by itself">The put alone</th><th className="num">Saves</th><th>Covers</th><th /></tr></thead>
              ) : (
                <thead><tr><th>Sell</th><th>Buy</th><th className="num">Brings in</th><th className="num">A trading day</th><th className="num" title="The gap between the strikes less the credit">Max loss</th>
                  <th className="num">Breakeven</th><th className="num" title="The credit against the most it can lose">On the risk</th><th className="num" title="The sold put's delta: roughly the chance the stock ends under it">Chance tested</th><th /></tr></thead>
              )}
              <tbody>
                {t.rows.map((r) => (
                  <tr key={`${r.high_strike}-${r.low_strike}`} className={pickRow === r ? 'on' : ''} onClick={() => choose(r)}>
                    {kind === 'insurance' ? (
                      <>
                        <td><b>{r.buy.strike} P</b><span className="cc-opt"><span>ask {r.buy.ask.toFixed(2)} · {pctS(r.below_price_pct)}</span></span></td>
                        <td><b>{r.sell.strike} P</b><span className="cc-opt"><span>bid {r.sell.bid.toFixed(2)} · {pctS(r.low_below_price_pct)}</span></span></td>
                        <td className="num neg">{cad(r.cost)}<span className="cc-opt"><span>{r.debit.toFixed(2)} a share</span></span></td>
                        <td className="num">{cad(r.per_day, 2)}<span className="cc-opt"><span>over {r.days}</span></span></td>
                        <td className="num pos">{cad(r.most_it_pays)}<span className="cc-opt"><span>{r.pays_per_dollar.toFixed(1)}× its cost</span></span></td>
                        <td className="num">{cad(r.plain_put_cost)}</td>
                        <td className="num pos">{cad(r.saves)}</td>
                        <td>{r.buy.strike} down to {r.sell.strike}<span className="cc-opt"><span>nothing under {r.protection_ends}</span></span></td>
                      </>
                    ) : (
                      <>
                        <td><b>{r.sell.strike} P</b><span className="cc-opt"><span>bid {r.sell.bid.toFixed(2)} · {pctS(r.below_price_pct)}</span></span></td>
                        <td><b>{r.buy.strike} P</b><span className="cc-opt"><span>ask {r.buy.ask.toFixed(2)} · {pctS(r.low_below_price_pct)}</span></span></td>
                        <td className="num pos">{cad(r.income)}<span className="cc-opt"><span>{r.credit.toFixed(2)} a share</span></span></td>
                        <td className="num">{cad(r.per_day, 2)}<span className="cc-opt"><span>over {r.days}</span></span></td>
                        <td className="num neg">{cad(r.max_loss)}</td>
                        <td className="num">{usd(r.breakeven, 2)}</td>
                        <td className="num">{r.return_on_risk_pct.toFixed(1)}%</td>
                        <td className="num">{r.chance_tested == null ? '—' : `≈${r.chance_tested}%`}</td>
                      </>
                    )}
                    <td><button type="button" className="small secondary" onClick={(e) => { e.stopPropagation(); onLoad?.(legsWith(r)); }}>Calculator</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="cc-faint">{symbol} at {usd(t.quote.price, 2)}, {short(t.expiry)}, {pricesWords(t.option_prices)}. Each is today’s prices worked through, not a recommendation: which spread, if any, is your decision. Tap a row to see {position?.shares ? 'your position with it on' : 'it by itself'}.</p>
          {pickRow && figs && (
            <div className="cl-spread-figs">
              <div className="cc-figs">
                <div><span className="cc-k">{position?.shares ? 'Your position with it' : 'The spread'}</span><b className={sign(figs.net_after_interest_per_day)}>{cad(figs.net_after_interest_per_day)} a trading day</b>
                  <span className="cc-faint">calls {cad(figs.per_day_by_role.calls)} · insurance {cad(figs.per_day_by_role.insurance)}{figs.per_day_by_role.income_spreads ? ` · income spreads ${signed(figs.per_day_by_role.income_spreads)}` : ''}</span></div>
                <div><span className="cc-k">Max loss</span><b className="neg">{figs.max_loss == null ? 'no limit' : cad(figs.max_loss)}</b>
                  <span className="cc-faint">{figs.protection_ends ? `${cad(figs.loss_at_protection_end)} at ${figs.protection_ends}, where the spread stops paying; the rest if it went to zero` : figs.max_loss_at != null && figs.max_loss_at > 1 ? `at ${usd(figs.max_loss_at, 2)} or below` : ''}</span></div>
                <div><span className="cc-k">Breakeven</span><b>{figs.breakevens.length ? figs.breakevens.map((b) => usd(b, 2)).join(', ') : '—'}</b><span className="cc-faint">held to {short(figs.risk_horizon)}</span></div>
              </div>
              <PayoffChart curve={figs.curve} price={t.quote.price} breakevens={figs.breakevens} strikes={legsWith(pickRow).map((l) => Number(l.strike))} horizon={figs.horizon} compact />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export { KIND_WORD, LINE_WORD, when, getFx };
