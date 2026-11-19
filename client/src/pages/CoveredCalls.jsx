// The covered-call desk (Jake, Nov 17: "watches for drops on large stocks that offer 0dte or close to call options. When the
// stock drops a certain amount, the goal is to buy that stock and start writing call options to generate cash ... a calculator
// of the positions that show max gain and loss at certain calls and puts ... recommend call and puts and position sizing ...
// have Andrew or Mike offer guidance"). Server: lib/options (Cboe's delayed quotes), /api/options. Money Hub never trades.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { localToday } from '../format.js';
import './coveredCalls.css';
import MarketClock from './MarketClock.jsx';

const send = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; });
const fmt = (pre, n, d) => (n == null || !Number.isFinite(Number(n)) ? '—'
  : `${Number(n) < 0 ? '−' : ''}${pre}${Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
// Money in CAD (Nov 17: "I want to see outputs in cad"): the desk's figures are the market's US dollars, turned into CAD at the
// Bank of Canada's daily rate (FX, set by the page). Share prices, strikes and per-share premiums stay US$, as the broker shows them.
let FX = null;
const usd = (n, d = 0) => fmt('US$', n, d);
const cad = (n, d = 0) => (n == null || !Number.isFinite(Number(n)) ? '—' : FX ? fmt('$', Number(n) * FX, d) : fmt('US$', n, d));
const plain = (n, d = 0) => fmt('$', n, d);
const pctS = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`);
const short = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' }) : '—');
const asOf = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Regina' }) : '');

// ---------------------------------------------------------------- the payoff chart
function Payoff({ curve, price, breakevens, strikes }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  if (!curve?.length) return null;
  const W = 640; const H = 220; const L = 56; const R = 12; const T = 12; const B = 26;
  const xs = curve.map((p) => p.price); const ys = curve.map((p) => p.pnl);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs);
  const yMin = Math.min(0, ...ys); const yMax = Math.max(0, ...ys); const pad = (yMax - yMin) * 0.08 || 1;
  const sx = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const sy = (v) => T + ((yMax + pad - v) / (yMax - yMin + 2 * pad)) * (H - T - B);
  const path = curve.map((p, i) => `${i ? 'L' : 'M'}${sx(p.price).toFixed(1)},${sy(p.pnl).toFixed(1)}`).join('');
  const ticks = [yMin, 0, yMax].filter((v, i, a) => a.indexOf(v) === i);
  const move = (e) => {
    const box = ref.current.getBoundingClientRect();
    const v = x0 + (((e.clientX - box.left) / box.width) * W - L) / (W - L - R) * (x1 - x0);
    const p = curve.reduce((a, c) => (Math.abs(c.price - v) < Math.abs(a.price - v) ? c : a));
    setHover(p);
  };
  return (
    <div className="cc-chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onMouseMove={move} onMouseLeave={() => setHover(null)} role="img"
        aria-label="Profit or loss at the call's expiry, by the stock's price">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} className={v === 0 ? 'cc-zero' : 'cc-grid'} />
            <text x={L - 6} y={sy(v) + 4} textAnchor="end" className="cc-axis">{cad(v)}</text>
          </g>
        ))}
        {(strikes || []).map((k, i) => k > x0 && k < x1 && (
          <line key={`k${i}`} x1={sx(k)} x2={sx(k)} y1={T} y2={H - B} className="cc-strike" />
        ))}
        <line x1={sx(price)} x2={sx(price)} y1={T} y2={H - B} className="cc-now" />
        <text x={sx(price)} y={H - 8} textAnchor="middle" className="cc-axis">now {usd(price, 2)}</text>
        <text x={L} y={H - 8} className="cc-axis">{usd(x0)}</text>
        <text x={W - R} y={H - 8} textAnchor="end" className="cc-axis">{usd(x1)}</text>
        {(breakevens || []).filter((b) => b > x0 && b < x1).map((b) => (
          <circle key={b} cx={sx(b)} cy={sy(0)} r="4" className="cc-be" />
        ))}
        <path d={path} className="cc-line" />
        {hover && (
          <g>
            <line x1={sx(hover.price)} x2={sx(hover.price)} y1={T} y2={H - B} className="cc-cross" />
            <circle cx={sx(hover.price)} cy={sy(hover.pnl)} r="4" className="cc-dot" />
          </g>
        )}
      </svg>
      <div className="cc-tip" style={{ visibility: hover ? 'visible' : 'hidden' }}>
        {hover ? <>At {usd(hover.price, 2)}: <b>{cad(hover.pnl)}</b></> : '.'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- stocks to write calls on
// How often a stock's options expire (Nov 17: "options expiring at most every 3 days, not an option expiring within 3 days").
const cadenceLabel = (c) => (!c ? 'too few listed' : c.max <= 3 && c.min === 1 ? 'every day' : c.min === 7 && c.max === 7 ? 'weekly'
  : c.min === c.max ? `every ${c.max} days` : `every ${c.min}–${c.max} days`);

// One list, sorted by the difference (Jake, Nov 17: "the difference between avg put daily cost (on trading days) on long horizon
// puts that are $10 otm, and avg short term daily calls $5 otm. then sort the stocks by the difference"): what the short-term
// calls pay a trading day on average, less what the long-horizon puts cost, for 100 shares. His watchlist and the wider list
// together; a stock whose options don't expire often enough sits at the bottom, greyed.
// The contract behind a column's average (Nov 18: "doesn't seem to have any data on option prices"): strike, expiry, the
// price it was taken at (a call's bid, a put's ask, per share, US$ as the broker shows it) and its delta.
const optDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
function OptLine({ o, kind }) {
  if (!o) return null;
  const px = kind === 'call' ? o.bid : o.ask;
  return (
    <span className="cc-opt">
      <span>{o.strike} {kind === 'call' ? 'C' : 'P'} {optDay(o.expiry)}</span>
      <span>US${Number(px).toFixed(2)} {kind === 'call' ? 'bid' : 'ask'}{o.delta != null ? ` · Δ ${Number(o.delta).toFixed(2)}` : ''}</span>
    </span>
  );
}

function Watchlist({ scan, err, selected, onPick, rules, saveRules }) {
  const [add, setAdd] = useState('');
  const addOne = () => {
    const s = add.trim().toUpperCase();
    if (!s) return;
    saveRules({ watchlist: [...rules.watchlist, s] }); setAdd('');
  };
  const gap = (s) => (s.error || !s.carry || s.carry.gap == null ? -Infinity : s.carry.gap);
  const rows = scan ? [...scan.stocks, ...(scan.wide || [])].sort((a, b) => (b.qualifies ? 1 : 0) - (a.qualifies ? 1 : 0) || gap(b) - gap(a)) : [];
  const unread = scan?.wide_unread?.length || 0;
  return (
    <div className="panel cc-panel">
      <div className="panel-header spend-header">
        <span>Stocks to write calls on</span>
        <span className="cc-faint">sorted by what the calls pay less what the puts cost, a trading day, for 100 shares</span>
      </div>
      {err && <p className="review-error">{err}</p>}
      {!scan && !err && <p className="cc-faint cc-pad">Reading the market…</p>}
      {scan && (
        <div className="table-scroll">
          <table className="cc-table">
            <thead><tr><th>Stock</th><th className="num">Price</th>
              <th className="num" title={`The average, over the expiries within ${rules.call_max_days} days, of the first call at least US$${rules.call_otm} above the price, at the bid, for each trading day to its expiry. Under it: the call that pays the most a trading day, its bid and delta.`}>Calls US${rules.call_otm} out</th>
              <th className="num" title={`The average, over the expiries ${rules.put_days_min} to ${rules.put_days_max} days out, of the first put at least US$${rules.put_otm} below the price, at the ask, for each trading day to its expiry. Under it: the cheapest put a trading day, its ask and delta.`}>Puts US${rules.put_otm} out</th>
              <th className="num" title="Calls less puts, a trading day, for 100 shares">Difference</th>
              <th>Options expire</th><th className="num cc-wide-only">Today</th><th className="num cc-wide-only">From high</th><th /><th /></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.symbol} className={`${selected === s.symbol ? 'on' : ''} ${s.triggered && s.qualifies ? 'dropped' : ''} ${!s.error && !s.qualifies ? 'cc-dim' : ''}`} onClick={() => !s.error && onPick(s.symbol)}>
                  <td><b>{s.symbol}</b></td>
                  {s.error ? <td colSpan={7} className="cc-faint">{s.error}</td> : <>
                    <td className="num">{usd(s.price, 2)}</td>
                    <td className="num" title={s.carry ? `average of ${s.carry.calls} expir${s.carry.calls === 1 ? 'y' : 'ies'}, a trading day` : ''}>
                      {s.carry ? cad(s.carry.call_per_day) : '—'}<OptLine o={s.carry?.call} kind="call" /></td>
                    <td className="num" title={s.carry?.puts ? `average of ${s.carry.puts} expir${s.carry.puts === 1 ? 'y' : 'ies'}, a trading day` : ''}>
                      {s.carry?.put_per_day != null ? cad(s.carry.put_per_day) : '—'}<OptLine o={s.carry?.put} kind="put" /></td>
                    <td className={`num cc-diff ${s.carry?.gap != null ? sign(s.carry.gap) : ''}`} title={s.carry?.after_interest != null ? `${cad(s.carry.after_interest)} after ${cad(s.carry.interest_per_day, 2)} of margin interest` : ''}>{s.carry?.gap != null ? signed(s.carry.gap) : '—'}
                      {s.carry?.on_capital_pct_year != null && <span className="cc-opt"><span>{s.carry.on_capital_pct_year.toFixed(0)}% a year on capital</span>
                        <span>{s.carry.days_to_earn_max_loss != null ? `max loss back in ${s.carry.days_to_earn_max_loss} days` : 'not earning after interest'}</span></span>}</td>
                    <td>{cadenceLabel(s.cadence)}{!s.often && <span className="cc-faint"> · not often enough</span>}</td>
                    <td className="num cc-wide-only">{pctS(s.day_pct)}</td>
                    <td className="num cc-wide-only">{pctS(s.from_high_pct)}</td>
                  </>}
                  <td>{s.triggered && s.qualifies && <span className="badge warn" title={s.why.join('; ')}>DROPPED</span>}</td>
                  <td>{s.watched
                    ? <button type="button" className="small-link" title="Stop watching" onClick={(e) => { e.stopPropagation(); saveRules({ watchlist: rules.watchlist.filter((x) => x !== s.symbol) }); }}>×</button>
                    : <button type="button" className="small-link" title="Add to your watchlist" onClick={(e) => { e.stopPropagation(); saveRules({ watchlist: [...rules.watchlist, s.symbol] }); }}>+</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="cc-row cc-pad">
        <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Add a stock (e.g. TSLA)" onKeyDown={(e) => e.key === 'Enter' && addOne()} />
        <button type="button" className="small secondary" onClick={addOne}>Watch</button>
        {scan && <span className="cc-faint">
          Tap a stock to work out a trade · a stock counts with options at least every {rules.expiry_every_days} days{rules.min_carry > 0 ? ` and a difference of ${plain(rules.min_carry)}` : ''} ·
          {rules.wide ? (scan.wide_as_of ? ` about 50 large stocks searched ${asOf(scan.wide_as_of)}${scan.wide_running ? ', searching again' : ''}${unread ? `, ${unread} couldn’t be read` : ''} ·` : ' searching about 50 large stocks, a minute or two ·') : ''}
          {' '}Cboe, 15 minutes delayed · {asOf(scan.stocks.find((s) => s.as_of)?.as_of)}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one leg in the calculator
function LegRow({ leg, symbol, expiries, onChange, onRemove }) {
  const [strikes, setStrikes] = useState(null);
  useEffect(() => {
    if (!leg.expiry) return;
    let live = true;
    send('GET', `/api/options/strikes/${symbol}?expiry=${leg.expiry}`).then((d) => live && setStrikes(d)).catch(() => live && setStrikes(null));
    return () => { live = false; };
  }, [symbol, leg.expiry]);
  const list = strikes ? (leg.type === 'call' ? strikes.calls : strikes.puts) : [];
  const setStrike = (k) => {
    const c = list.find((x) => x.strike === Number(k));
    onChange({ ...leg, strike: Number(k), premium: c ? (leg.side === 'short' ? c.bid : c.ask) : leg.premium, iv: c?.iv, delta: c?.delta });
  };
  const cur = list.find((x) => x.strike === Number(leg.strike));
  // A leg loaded from his positions has his own price but often no IV: take the market's, so a longer put is valued right.
  useEffect(() => { if (cur && leg.iv == null && cur.iv != null) onChange({ ...leg, iv: cur.iv, delta: leg.delta ?? cur.delta }); }, [cur?.iv]);
  return (
    <div className="cc-leg">
      <select value={`${leg.side}-${leg.type}`} onChange={(e) => { const [side, type] = e.target.value.split('-'); onChange({ ...leg, side, type }); }}>
        <option value="short-call">Sell call</option><option value="long-put">Buy put</option>
        <option value="long-call">Buy call</option><option value="short-put">Sell put</option>
      </select>
      <select value={leg.expiry} onChange={(e) => onChange({ ...leg, expiry: e.target.value })}>
        {expiries.map((e) => <option key={e} value={e}>{short(e)}</option>)}
      </select>
      <select value={leg.strike || ''} onChange={(e) => setStrike(e.target.value)}>
        <option value="">Strike</option>
        {leg.strike && !cur ? <option value={leg.strike}>{leg.strike}</option> : null}
        {list.map((c) => <option key={c.strike} value={c.strike}>{c.strike} · {c.bid.toFixed(2)}/{c.ask.toFixed(2)} · Δ{c.delta == null ? '—' : Math.abs(c.delta).toFixed(2)}</option>)}
      </select>
      <label className="cc-mini">Price<input type="number" step="0.01" min="0" value={leg.premium} onChange={(e) => onChange({ ...leg, premium: e.target.value })} /></label>
      <label className="cc-mini">Contracts<input type="number" step="1" min="1" value={leg.contracts} onChange={(e) => onChange({ ...leg, contracts: e.target.value })} /></label>
      <span className="cc-faint">{cur ? `bid ${cur.bid.toFixed(2)} · ask ${cur.ask.toFixed(2)}` : ''}</span>
      <button type="button" className="small-link" onClick={onRemove} title="Remove">×</button>
    </div>
  );
}

// ---------------------------------------------------------------- the rules' pick, the calculator, Mike
// loaded: one of his positions to put in the calculator (Nov 17: "Make it so I can load my positions into the calculator").
const nyToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const fromPosition = (p) => ({
  shares: p.shares, cost: p.cost,
  // Each leg keeps the day it was opened (or the position's, as the desk takes it), so the calculator's figures a trading day are
  // the position's own (Nov 18).
  legs: (p.legs || []).filter((l) => l.expiry >= nyToday()).map((l) => {
    const seen = (p.open_legs || []).find((o) => o.type === l.type && o.side === l.side && Number(o.strike) === Number(l.strike) && o.expiry === l.expiry);
    return { ...l, premium: Number(l.premium), contracts: Number(l.contracts) || 1, ...(!l.since && seen?.since ? { since: seen.since } : {}) };
  }),
});
function Desk({ symbol, rules, onSaved, loaded, onClose }) {
  const [from, setFrom] = useState(null); // the position in the calculator, or null for the rules' pick
  const calcRef = useRef(null);
  const rootRef = useRef(null);
  const showCalc = () => setTimeout(() => calcRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState(null);
  const [pos, setPos] = useState(null); // { shares, cost, legs }
  const [figs, setFigs] = useState(null);
  const [mike, setMike] = useState({ busy: false, reply: null, err: null, q: '' });
  const [saved, setSaved] = useState(null);

  const fromPlan = (p) => ({
    shares: Math.max(100, p.sizing.shares || 100), cost: p.price,
    legs: [
      p.call && { type: 'call', side: 'short', strike: p.call.strike, expiry: p.call.expiry, premium: p.call.bid, contracts: Math.max(1, p.sizing.lots || 1), iv: p.call.iv, delta: p.call.delta },
      p.put && { type: 'put', side: 'long', strike: p.put.strike, expiry: p.put.expiry, premium: p.put.ask, contracts: Math.max(1, p.sizing.lots || 1), iv: p.put.iv, delta: p.put.delta },
    ].filter(Boolean),
  });
  useEffect(() => {
    setPlan(null); setErr(null); setFigs(null); setMike({ busy: false, reply: null, err: null, q: '' }); setSaved(null);
    send('GET', `/api/options/plan/${symbol}`).then((p) => {
      setPlan(p);
      if (loaded?.symbol === symbol) { setPos(fromPosition(loaded)); setFrom(loaded); showCalc(); }
      else { setPos(fromPlan(p)); setFrom(null); setTimeout(() => rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }
    }).catch((e) => setErr(e.message));
  }, [symbol, rules]);
  useEffect(() => { // a position loaded on the stock already open
    if (!loaded || loaded.symbol !== symbol || plan?.symbol !== symbol) return;
    setPos(fromPosition(loaded)); setFrom(loaded); setSaved(null); showCalc();
  }, [loaded]);
  useEffect(() => {
    if (!plan || !pos) return;
    const t = setTimeout(() => send('POST', '/api/options/evaluate', { position: { price: plan.price, ...pos } }).then(setFigs).catch((e) => setErr(e.message)), 150);
    return () => clearTimeout(t);
  }, [plan, pos]);

  const [expiries, setExpiries] = useState([]);
  useEffect(() => { send('GET', `/api/options/strikes/${symbol}`).then((d) => setExpiries(d.expiries)).catch(() => {}); }, [symbol]);

  if (err) return <div className="panel cc-panel"><p className="review-error cc-pad">{err}</p></div>;
  if (!plan || !pos) return <div className="panel cc-panel"><p className="cc-faint cc-pad">Reading {symbol}’s options…</p></div>;

  const setLeg = (i, l) => setPos({ ...pos, legs: pos.legs.map((x, j) => (j === i ? l : x)) });
  const describe = () => {
    const legs = pos.legs.map((l) => `${l.side === 'short' ? 'sell' : 'buy'} ${l.contracts} ${symbol} ${l.expiry} ${l.strike} ${l.type}${Number(l.contracts) > 1 ? 's' : ''} at US$${Number(l.premium).toFixed(2)}`).join('; ');
    return `${pos.shares} shares of ${symbol} at US$${Number(pos.cost).toFixed(2)} (price now US$${plan.price.toFixed(2)})${legs ? `; ${legs}` : ''}.`;
  };
  const askMike = () => {
    const q = mike.q.trim() || 'What does this position earn and risk, and where do my rules look loose or tight?';
    setMike({ ...mike, busy: true, err: null, reply: null });
    send('POST', '/api/advisor/ask', { text: `Covered-call desk: ${describe()} ${q}` })
      .then((d) => setMike((m) => ({ ...m, busy: false, reply: d.reply })))
      .catch((e) => setMike((m) => ({ ...m, busy: false, err: e.message })));
  };
  const save = (status) => send('POST', '/api/options/positions', {
    symbol, shares: pos.shares, cost: pos.cost, status, opened_on: localToday(),
    legs: pos.legs, premium_collected: status === 'open' ? pos.legs.reduce((a, l) => a + (l.side === 'short' ? 1 : -1) * Number(l.premium) * Number(l.contracts) * 100, 0) : 0,
  }).then(() => { setSaved(status); onSaved(); }).catch((e) => setErr(e.message));
  // His own entry, changed in the calculator: shares, cost and the legs; options cash is left as it is.
  const update = () => send('PATCH', `/api/options/positions/${from.id}`, { shares: Number(pos.shares), cost: Number(pos.cost), legs: pos.legs })
    .then(() => { setSaved('updated'); onSaved(); }).catch((e) => setErr(e.message));

  const q = plan.quote;
  return (
    <div className="panel cc-panel cc-desk" ref={rootRef}>
      <div className="panel-header spend-header">
        <span>Work out a trade: {symbol} · {usd(q.price, 2)} <span className="cc-faint">{pctS(q.change_pct)} today{q.iv30 ? ` · IV ${Math.round(q.iv30 * 100)}%` : ''}</span></span>
        <span className="cc-actions">{plan.drop?.triggered && <span className="badge warn">{plan.drop.why.join('; ')}</span>}
          <button type="button" className="small-link" onClick={onClose} title="Close the calculator">close ×</button></span>
      </div>

      <div className="cc-pick cc-pad">
        <div className="cc-pick-head">What your rules pick</div>
        <div className="cc-pick-grid">
          <div><span className="cc-k">Call to sell</span>{plan.call ? <b>{plan.call.strike} · {short(plan.call.expiry)}</b> : <b>none fits</b>}
            {plan.call && <span className="cc-faint">bid {plan.call.bid.toFixed(2)} · delta {plan.call.delta.toFixed(2)} · {cad(plan.call.per_day)} a trading day a contract</span>}</div>
          <div><span className="cc-k">Put to buy</span>{plan.rules.protect ? (plan.put ? <b>{plan.put.strike} · {short(plan.put.expiry)}</b> : <b>none fits</b>) : <b>off</b>}
            {plan.put && <span className="cc-faint">ask {plan.put.ask.toFixed(2)} · {cad(plan.put.cost_per_day)} a trading day a contract</span>}</div>
          <div><span className="cc-k">Size</span><b>{plan.sizing.lots} lot{plan.sizing.lots === 1 ? '' : 's'} ({plan.sizing.shares} shares)</b>
            <span className="cc-faint">{plan.sizing.money_in ? `${cad(plan.sizing.money_in)} of your capital${plan.rules.margin_pct < 100 ? ` at ${plan.rules.margin_pct}% margin` : ''}` : ''}</span></div>
        </div>
        <ul className="cc-why">{[...plan.reasons, ...plan.sizing.limits].map((r) => <li key={r}>{r}</li>)}</ul>
        {plan.call_choices.length > 1 && (
          <div className="cc-alts">The short expiries, most a trading day first: {plan.call_choices.map((c) => (
            <button key={c.expiry} type="button" className="small secondary" onClick={() => setPos({ ...pos, legs: [
              ...pos.legs.filter((l) => !(l.type === 'call' && l.side === 'short')),
              { type: 'call', side: 'short', strike: c.strike, expiry: c.expiry, premium: c.bid, contracts: pos.legs.find((l) => l.type === 'call')?.contracts || 1, iv: c.iv, delta: c.delta },
            ] })}>{short(c.expiry)}: {c.strike} for {c.bid.toFixed(2)} ({cad(c.per_day)}/day)</button>
          ))}</div>
        )}
      </div>

      <div className="cc-calc cc-pad" ref={calcRef}>
        <div className="cc-pick-head">Calculator{from ? <>: your position <span className="cc-faint">({from.shares} shares at {usd(from.cost, 2)}{from.source === 'broker' ? ', from your broker' : ''})</span></> : ''}{' '}
          {from && <button type="button" className="small-link" onClick={() => setPos(fromPosition(from))}>start over from it</button>}{' '}
          <button type="button" className="small-link" onClick={() => { setPos(fromPlan(plan)); setFrom(null); setSaved(null); }}>{from ? 'your rules’ pick instead' : 'back to your rules’ pick'}</button></div>
        <div className="cc-row">
          <label className="cc-mini">Shares<input type="number" step="100" min="0" value={pos.shares} onChange={(e) => setPos({ ...pos, shares: e.target.value })} /></label>
          <label className="cc-mini">Cost a share<input type="number" step="0.01" min="0" value={pos.cost} onChange={(e) => setPos({ ...pos, cost: e.target.value })} /></label>
        </div>
        {pos.legs.map((l, i) => (
          <LegRow key={i} leg={l} symbol={symbol} expiries={expiries.length ? expiries : [l.expiry]} onChange={(x) => setLeg(i, x)}
            onRemove={() => setPos({ ...pos, legs: pos.legs.filter((_, j) => j !== i) })} />
        ))}
        <div className="cc-row">
          <button type="button" className="small secondary" onClick={() => setPos({ ...pos, legs: [...pos.legs, { type: 'call', side: 'short', strike: 0, expiry: expiries[0], premium: 0, contracts: 1 }] })}>+ Call</button>
          <button type="button" className="small secondary" onClick={() => setPos({ ...pos, legs: [...pos.legs, { type: 'put', side: 'long', strike: 0, expiry: expiries.find((e) => e >= (plan.put?.expiry || '')) || expiries[0], premium: 0, contracts: 1 }] })}>+ Put</button>
        </div>

        {figs && (
          <>
            {figs.uncovered && <p className="review-error">More calls sold than shares cover: the loss has no limit if the stock runs.</p>}
            <div className="cc-figs">
              <div><span className="cc-k">Option revenue a trading day</span><b className={figs.revenue_per_day < 0 ? 'cc-neg' : ''}>{cad(figs.revenue_per_day)}</b>
                <span className="cc-faint">calls {cad(figs.income_per_day)}{figs.protection_per_day ? ` − puts ${cad(figs.protection_per_day)}` : ''}{figs.interest_per_day ? ` − interest ${cad(figs.interest_per_day, 2)}` : ''}</span></div>
              <div><span className="cc-k">On the capital</span><b className={figs.on_capital_pct_year < 0 ? 'cc-neg' : ''}>{figs.on_capital_pct_year == null ? '—' : `${figs.on_capital_pct_year.toFixed(1)}% a year`}</b>
                <span className="cc-faint">{figs.on_capital_pct_day == null ? '' : `${figs.on_capital_pct_day.toFixed(3)}% a trading day of ${cad(figs.capital_needed)} tied up`}</span></div>
              <div><span className="cc-k">Against the max loss</span><b>{figs.days_to_earn_max_loss == null ? '—' : `${figs.days_to_earn_max_loss} trading days`}</b>
                <span className="cc-faint">{figs.days_to_earn_max_loss == null ? (figs.max_loss == null ? 'no limit on the loss' : 'it isn’t earning') : `of revenue to earn back a max loss of ${cad(Math.abs(figs.max_loss))} (${figs.vs_max_loss_pct_day.toFixed(2)}% of it a day)`}</span></div>
              <div><span className="cc-k">Premium in</span><b>{cad(figs.premium_in)}</b><span className="cc-faint">the calls, in full</span></div>
              {figs.unlimited_gain && figs.gain_at_call != null
                ? <div><span className="cc-k">Gain at the call</span><b>{cad(figs.gain_at_call)}</b>
                    <span className="cc-faint">at {usd(figs.call_strike, 2)}; then {cad(figs.shares_not_called, 2)} for each US$1 higher on the {figs.shares_not_called} share{figs.shares_not_called === 1 ? '' : 's'} the call doesn’t cover</span></div>
                : <div><span className="cc-k">Max gain</span><b>{figs.unlimited_gain ? 'no cap' : cad(figs.max_gain)}</b><span className="cc-faint">{figs.max_gain_at != null ? `at ${usd(figs.max_gain_at, 2)} or above` : figs.unlimited_gain ? 'no call written' : ''}</span></div>}
              <div><span className="cc-k">Max loss</span><b>{figs.max_loss == null ? 'no limit' : cad(figs.max_loss)}</b>
                <span className="cc-faint">{figs.max_loss == null ? '' : figs.shares_without_put
                  ? `if it went to zero; ${cad(figs.shares_without_put * figs.cost)} of it is the ${figs.shares_without_put} share${figs.shares_without_put === 1 ? '' : 's'} the put doesn’t cover`
                  : figs.put_strike && figs.loss_at_put != null && figs.max_loss_at < 1 ? `if it went to zero; ${cad(figs.loss_at_put)} at the put’s ${usd(figs.put_strike, 2)}`
                  : figs.floor_from ? `about this from ${usd(figs.floor_from, 2)} down` : figs.max_loss_at != null ? (figs.max_loss_at < 1 ? 'if it went to zero' : `at ${usd(figs.max_loss_at, 2)} or below`) : ''}</span></div>
              <div><span className="cc-k">Breakeven</span><b>{figs.breakevens.length ? figs.breakevens.map((b) => usd(b, 2)).join(', ') : '—'}</b><span className="cc-faint">{figs.risk_horizon ? `held to ${short(figs.risk_horizon)}` : ''}</span></div>
              <div><span className="cc-k">Called away</span><b>{figs.called_away_chance == null ? '—' : `≈${Math.round(figs.called_away_chance)}%`}</b><span className="cc-faint">the call’s delta</span></div>
              {figs.margin_pct < 100
                ? <div><span className="cc-k">Capital needed</span><b>{cad(figs.capital_needed)}</b>
                    <span className="cc-faint">{figs.margin_pct}% of the shares{figs.put_cost ? ' and the put' : ''}; {cad(figs.borrowed)} borrowed at {figs.margin_rate}%{figs.interest_to_horizon ? `, ${cad(figs.interest_to_horizon)} interest to ${short(figs.horizon)}` : ''}</span></div>
                : <div><span className="cc-k">Money in</span><b>{cad(figs.money_in)}</b><span className="cc-faint">{figs.put_cost ? `${cad(figs.put_cost)} of it the put` : 'the shares'}</span></div>}
            </div>
            <Payoff curve={figs.curve} price={plan.price} breakevens={figs.breakevens} strikes={pos.legs.map((l) => Number(l.strike))} />
            <p className="cc-faint">The chart: profit or loss on {short(figs.horizon)} (the nearest expiry), a longer put at what it would still be worth then. Max loss, break-even and the loss at the put are held to {short(figs.risk_horizon || figs.horizon)}, with nothing left in the put and the interest to then.</p>
            <div className="table-scroll">
              <table className="cc-table cc-scen">
                <thead><tr><th>If {symbol} is</th>{figs.scenarios.map((s) => <th key={s.pct} className="num">{pctS(s.pct)}</th>)}</tr></thead>
                <tbody>
                  <tr><td className="cc-faint">price</td>{figs.scenarios.map((s) => <td key={s.pct} className="num">{usd(s.price, 2)}</td>)}</tr>
                  <tr><td className="cc-faint">you make</td>{figs.scenarios.map((s) => <td key={s.pct} className={`num ${s.pnl < 0 ? 'neg' : 'pos'}`}>{cad(s.pnl)}</td>)}</tr>
                </tbody>
              </table>
            </div>
            {from ? (
              <div className="cc-row">
                {from.source !== 'broker' && <button type="button" className="small" onClick={update}>Save changes to this position</button>}
                <button type="button" className="small secondary" onClick={() => save('planned')}>Save as a plan</button>
                {from.source === 'broker' && <span className="cc-faint">From your broker: changes here are a what-if; the bot’s next sync keeps the record.</span>}
                {saved && <span className="cc-faint">{saved === 'updated' ? 'Position updated.' : 'Saved to your positions as a plan.'}</span>}
              </div>
            ) : (
              <div className="cc-row">
                <button type="button" className="small" onClick={() => save('open')}>I’ve put this on</button>
                <button type="button" className="small secondary" onClick={() => save('planned')}>Save as a plan</button>
                {saved && <span className="cc-faint">Saved to your positions{saved === 'planned' ? ' as a plan' : ''}.</span>}
              </div>
            )}
          </>
        )}
      </div>

      <div className="cc-mike cc-pad">
        <div className="cc-pick-head">Ask Mike</div>
        <div className="cc-row">
          <input value={mike.q} onChange={(e) => setMike({ ...mike, q: e.target.value })} placeholder="What does this earn and risk? Is the put worth it? Tax in a TFSA?"
            onKeyDown={(e) => e.key === 'Enter' && !mike.busy && askMike()} />
          <button type="button" className="small" disabled={mike.busy} onClick={askMike}>{mike.busy ? 'Mike is looking…' : 'Ask'}</button>
        </div>
        {mike.err && <p className="review-error">{mike.err}</p>}
        {mike.reply && <div className="cc-reply">{mike.reply}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- his rules
const RULE_GROUPS = [
  ['Your money', [['capital', 'Capital for this', 1000], ['margin_pct', 'Your share of the stock on margin (%; 100 = cash)', 5], ['margin_rate', 'Margin interest (% a year)', 0.05],
    ['max_position_pct', 'Most in one stock (% of capital)', 1], ['max_loss_pct', 'Most to lose on one position (% of capital)', 0.5]]],
  ['Which stocks count', [['expiry_every_days', 'Options expire at least every (days)', 1], ['min_carry', 'Calls beat puts by at least ($ a trading day, 100 shares)', 5],
    ['drop_day_pct', 'A drop: down in a day (%)', 0.5], ['drop_from_high_pct', 'or under the recent high (%)', 1], ['high_days', 'Recent high: last N days', 1]]],
  ['The short-term call', [['call_otm', 'At least this far above the price (US$)', 0.5], ['call_max_days', 'Expiring within (days)', 1]]],
  ['The long-horizon put', [['put_otm', 'At least this far below the price (US$)', 0.5], ['put_days_min', 'At least (days out)', 1], ['put_days_max', 'At most (days out)', 1], ['drop_test_pct', 'With no put, size against a fall of (%)', 1]]],
];
function Rules({ rules, saveRules }) {
  const [f, setF] = useState(rules);
  useEffect(() => setF(rules), [rules]);
  const dirty = JSON.stringify(f) !== JSON.stringify(rules);
  return (
    <details className="panel cc-panel cc-rules">
      <summary className="panel-header spend-header"><span>Your rules</span><span className="cc-faint">{rules.capital ? `${rules.capital_currency === 'USD' ? usd(rules.capital) : plain(rules.capital)} capital` : 'no capital set'} · {rules.margin_pct < 100 ? `${rules.margin_pct}% margin at ${rules.margin_rate}%` : 'cash'} · calls US${rules.call_otm} out within {rules.call_max_days} days · {rules.protect ? `puts US$${rules.put_otm} out, ${rules.put_days_min} to ${rules.put_days_max} days` : 'no put'} · change</span></summary>
      {RULE_GROUPS.map(([title, fields]) => (
        <div key={title} className="cc-pad cc-rule-group">
          <div className="cc-pick-head">{title}</div>
          <div className="cc-rule-grid">
            {fields.map(([k, label, step]) => (
              <label key={k} className="cc-mini">{label}<input type="number" step={step} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
            ))}
            {title === 'Your money' && <label className="cc-mini">Capital is in<select value={f.capital_currency || 'CAD'} onChange={(e) => setF({ ...f, capital_currency: e.target.value })}>
              <option value="CAD">Canadian dollars</option><option value="USD">US dollars</option></select></label>}
            {title === 'Which stocks count' && <label className="cc-check"><input type="checkbox" checked={!!f.wide} onChange={(e) => setF({ ...f, wide: e.target.checked })} /> Also search about 50 large stocks</label>}
            {title === 'The long-horizon put' && <label className="cc-check"><input type="checkbox" checked={!!f.protect} onChange={(e) => setF({ ...f, protect: e.target.checked })} /> Buy a put for protection</label>}
          </div>
        </div>
      ))}
      <div className="cc-row cc-pad">
        <button type="button" className="small" disabled={!dirty} onClick={() => saveRules(f)}>Save rules</button>
        {dirty && <button type="button" className="small secondary" onClick={() => setF(rules)}>Undo</button>}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- what it has earned
// Nov 17 (Jake): "it doesnt show my option profit and loss. it should look like any asset that produces cash." The cash is his
// brokerage entries in Money Hub, sorted into calls, puts and shares by stock (server lib/options/cash.js).
const sign = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const signed = (n, f = cad) => (n == null ? '—' : `${n > 0 ? '+' : ''}${f(n)}`);
const day = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');
function Tile({ k, v, cls = '', sub }) {
  return <div className="cc-tile"><span className="cc-k">{k}</span><b className={cls}>{v}</b>{sub && <span className="cc-faint">{sub}</span>}</div>;
}

function Earnings({ positions, cash, ins }) {
  const open = (positions || []).filter((p) => p.status === 'open');
  const toUsd = (n) => (cash?.currency === 'CAD' && FX ? n / FX : n); // the entries' amounts, in US$ like the desk's figures
  const hasCash = !!cash?.stocks.some((s) => s.call_entries || s.put_entries);
  const calls = hasCash ? toUsd(cash.totals.calls) : null;
  const puts = hasCash ? toUsd(cash.totals.puts) : null;
  const optNet = hasCash ? calls + puts : open.reduce((a, p) => a + p.premium_collected, 0);
  const sum = (f) => open.reduce((a, p) => a + (f(p) || 0), 0);
  const sharesValue = sum((p) => (p.price || 0) * p.shares);
  const sharesPnl = sum((p) => p.stock_pnl);
  const callsDay = sum((p) => p.figures?.income_per_day); const putsDay = sum((p) => p.figures?.protection_per_day);
  const interestDay = sum((p) => p.figures?.interest_per_day); const netDay = sum((p) => p.figures?.net_after_interest_per_day ?? p.figures?.net_per_day);
  const putTo = open.flatMap((p) => p.legs.filter((l) => l.type === 'put' && l.side === 'long').map((l) => l.expiry)).sort().at(-1);
  const sales = hasCash ? cash.stocks.reduce((a, s) => a + s.call_entries, 0) : 0;
  const t = ins?.total || null;
  const paidBack = t && t.puts_paid > 0 ? Math.min(1, Math.max(0, t.calls_collected / t.puts_paid)) : null;
  if (!positions || (!open.length && !hasCash)) return null;
  return (
    <div className="panel cc-panel cc-earn">
      <div className="panel-header spend-header"><span>What it has earned</span>
        <span className="cc-faint">{hasCash && cash.totals.first ? `since ${day(cash.totals.first)}` : ''}</span></div>
      <div className="cc-tiles cc-pad">
        {hasCash
          ? <>
              <Tile k="Call premium collected" v={signed(calls)} cls={sign(calls)} sub={`from ${sales} trade${sales === 1 ? '' : 's'}`} />
              <Tile k="Puts, net of what you sold back" v={signed(puts)} cls={sign(puts)} sub={putTo ? `cover you to ${day(putTo)}` : 'none held now'} />
              <Tile k="Options so far" v={signed(optNet)} cls={sign(optNet)} sub="calls less puts" />
            </>
          : <Tile k="Options cash so far" v={signed(optNet)} cls={sign(optNet)} sub="your broker sync’s figure: no option trades in your Money Hub entries yet" />}
        <Tile k="Coming in now" v={`${cad(netDay)} a trading day`} cls={sign(netDay)}
          sub={`calls ${cad(callsDay)}${putsDay ? ` − puts ${cad(putsDay)}` : ''}${interestDay ? ` − interest ${cad(interestDay, 2)}` : ''}`} />
        <Tile k="Shares" v={cad(sharesValue)} sub={<span className={sign(sharesPnl)}>{signed(sharesPnl)} since you bought</span>} />
      </div>
      {paidBack != null && (
        <div className="cc-pad cc-meter-wrap">
          <div className="cc-pick-head">The puts are the insurance: a fixed cost the calls pay off</div>
          <div className="cc-meter" role="img" aria-label={`Calls have paid back ${Math.round(paidBack * 100)}% of the puts`}><span style={{ width: `${paidBack * 100}%` }} /></div>
          <Insurance x={t} />
        </div>
      )}
      <div className="cc-pad cc-allin">All in: shares <b className={sign(sharesPnl)}>{signed(sharesPnl)}</b> and options <b className={sign(optNet)}>{signed(optNet)}</b> make <b className={sign(sharesPnl + optNet)}>{signed(sharesPnl + optNet)}</b></div>
    </div>
  );
}

// One entry's sorting, changed by him: call, put, the shares or other, and which stock.
function EntryRow({ e, money, onSaved, withWord }) {
  const [kind, setKind] = useState(e.kind || '');
  const [symbol, setSymbol] = useState(e.symbol || '');
  const [word, setWord] = useState('');
  const [err, setErr] = useState(null);
  const dirty = kind !== (e.kind || '') || symbol.toUpperCase() !== (e.symbol || '') || word;
  const save = () => send('PUT', `/api/options/cash/${e.id}`, { kind, symbol, word }).then(() => { setErr(null); onSaved(); }).catch((x) => setErr(x.message));
  return (
    <tr>
      <td className="cc-nowrap">{day(e.date)}</td>
      <td className="cc-words">{e.words}{err && <span className="review-error"> {err}</span>}</td>
      <td><select value={kind} onChange={(x) => setKind(x.target.value)} aria-label="What it is">
        <option value="">What is it?</option><option value="call">Call</option><option value="put">Put</option><option value="stock">Shares</option><option value="other">Other</option></select></td>
      <td><input className="cc-sym-in" value={symbol} onChange={(x) => setSymbol(x.target.value.toUpperCase())} placeholder="Symbol" aria-label="Stock symbol" disabled={kind === 'other'} /></td>
      {withWord && <td><input className="cc-word-in" value={word} onChange={(x) => setWord(x.target.value)} placeholder="every entry that says…" title="A word in these entries, like a company's name: every entry that mentions it is filed under this stock" /></td>}
      <td className={`num ${sign(e.amount)}`}>{signed(e.amount, money)}</td>
      <td>{dirty && kind ? <button type="button" className="small" onClick={save}>Save</button> : null}</td>
    </tr>
  );
}

// The puts as insurance (Jake, Nov 17: "show me my breakeven on the puts which are essentially an insurnace policy of this
// system and therefore a fixed cost that needs to be extracted over the remaining trading days"). x: one stock's row, or the
// total, from /api/options/insurance (US$).
function Insurance({ x }) {
  if (!x) return null;
  const known = x.calls_collected != null && !(x.calls_unknown?.length);
  const even = known && x.left <= 0;
  const n = (k, word) => `${k} ${word} entr${k === 1 ? 'y' : 'ies'}`;
  return (
    <div className="cc-meter-text">
      {/* Nov 19: days of floor left, the open call against the puts, and the call premium a day to break even. */}
      <div className="cc-tiles cc-tiles-sm">
        <Tile k="Price floor left" v={x.trading_days_left == null ? '—' : `${x.trading_days_left} trading day${x.trading_days_left === 1 ? '' : 's'}`}
          sub={x.put_expiry ? `${x.calendar_days_left} calendar days, to ${day(x.put_expiry)}` : 'no put held'} />
        <Tile k="Calls − puts" v={signed(x.call_less_put)} cls={sign(x.call_less_put)}
          sub={`calls collected ${cad(x.calls_total ?? x.call_premium_now)} − puts ${cad(x.puts_paid)}`} />
        <Tile k="Call premium to break even" v={even ? 'covered' : x.needed_per_day == null ? '—' : `${cad(x.needed_per_day, 2)} a day`}
          cls={!even && x.needed_per_day != null && x.call_now_per_day < x.needed_per_day ? 'neg' : ''}
          sub={even ? 'the calls have paid for the puts' : `a trading day to the put’s expiry; the open call pays ${cad(x.call_now_per_day, 2)}`} />
      </div>
      <span>
        {x.from === 'entries' ? `The puts cost ${cad(x.puts_paid)} net (${n(x.put_entries, 'put')})` : `The puts you hold cost ${cad(x.puts_paid)}`}{x.put_expiry ? ` and cover you to ${day(x.put_expiry)}` : ''}.
        {x.calls_collected == null ? ' What the calls have paid back isn’t known: none of this stock’s trades are in your Money Hub entries, so the whole cost is still counted.'
          : ` The calls have paid back ${cad(x.calls_collected)} (${n(x.call_entries, 'call')})${even ? `: that covers the puts, with ${cad(x.calls_collected - x.puts_paid)} over.` : `, leaving ${cad(x.left)}.`}`}
        {!even && x.trading_days_left ? ` Over the ${x.trading_days_left} trading day${x.trading_days_left === 1 ? '' : 's'} left that is ${cad(x.needed_per_day, 2)} a trading day to break even by then.` : ''}
      </span>
      {x.from === 'held' && <span className="review-error">Your Money Hub entries show only {cad(x.puts_in_entries)} of puts, less than the puts you hold cost: some put trades aren’t sorted yet (see the entries below), so the cost of the puts you hold is used.</span>}
      {x.puts_from_held?.length > 0 && <span className="review-error">For {x.puts_from_held.join(', ')} the entries show less in puts than the puts you hold cost, so the held cost is used: some put trades aren’t sorted yet.</span>}
      {x.calls_unknown?.length > 0 && <span className="cc-faint">Calls aren’t known for {x.calls_unknown.join(', ')} (no trade entries), so their puts count in full.</span>}
      {!even && x.call_now_per_day > 0 && x.days_to_even ? (
        <span className="cc-faint">If the next calls pay what the one open now does ({cad(x.call_now_per_day)} a trading day), the rest is covered in {x.days_to_even} trading day{x.days_to_even === 1 ? '' : 's'}, by {day(x.even_on)}{x.in_time === false ? ', after the puts expire' : ''}. The open call’s own premium is already counted above.</span>
      ) : null}
      {!even && !(x.call_now_per_day > 0) && <span className="cc-faint">No call is open now.</span>}
    </div>
  );
}

// The next call (Jake, Nov 17: "advise me on the next call that maximizes my daily return"): his own rule applied to today's
// chain. Of the expiries within his call days, the first strike at least his dollars above the price; most a trading day first.
function NextCall({ p, onLoad }) {
  const [plan, setPlan] = useState(null);
  useEffect(() => {
    let live = true;
    send('GET', `/api/options/plan/${p.symbol}`).then((x) => live && setPlan(x)).catch(() => live && setPlan(false));
    return () => { live = false; };
  }, [p.symbol]);
  if (plan === false) return null;
  if (!plan) return <div className="cc-next"><span className="cc-k">Next call</span><span className="cc-faint">reading {p.symbol}’s options…</span></div>;
  const lots = Math.floor(p.shares / 100);
  const r = plan.rules;
  const use = (c) => onLoad(p, [...(p.open_legs || []).filter((l) => !(l.type === 'call' && l.side === 'short')),
    { type: 'call', side: 'short', strike: c.strike, expiry: c.expiry, premium: c.bid, contracts: Math.max(1, lots), iv: c.iv, delta: c.delta }]);
  return (
    <div className="cc-next">
      <span className="cc-k">Next call <span className="cc-faint">{plan.call_floor
        ? `by your rule: any strike at or above your ${plan.call_floor} put, expiring within ${r.call_max_days} days; most time value a trading day first (the bid less what the shares give up below ${usd(plan.price, 2)} if called)`
        : `by your rule: at least US$${r.call_otm} above ${usd(plan.price, 2)}, expiring within ${r.call_max_days} days, most a trading day first`}{lots > 1 ? `; for your ${lots} contracts` : ''}</span></span>
      {!lots ? <span className="cc-faint">Under 100 shares: no call can be covered.</span>
        : !plan.call_choices.length ? <span className="cc-faint">{plan.call_floor ? `No call within ${r.call_max_days} days at or above the ${plan.call_floor} put has time value left.` : `No call within ${r.call_max_days} days at least US$${r.call_otm} above the price has a bid.`}</span> : (
          <div className="table-scroll">
            <table className="cc-table cc-nexttable">
              <thead><tr><th>Expires</th><th className="num">Strike</th><th className="num">Bid</th><th className="num" title="The bid less what the shares give up below today's price if called there">Time value</th><th className="num">Trading days</th><th className="num">A trading day</th><th className="num">Premium</th>
                <th className="num" title="The call's delta: roughly the chance the stock ends above the strike">Chance called</th>
                <th className="num" title="What the shares make or lose against your cost if they're called away at the strike">Shares if called</th><th /></tr></thead>
              <tbody>
                {plan.call_choices.map((c, i) => {
                  const called = (c.strike - p.cost) * lots * 100;
                  return (
                    <tr key={`${c.expiry}-${c.strike}`} className={i === 0 ? 'cc-best' : ''}>
                      <td>{short(c.expiry)}{i === 0 && <span className="badge"> MOST A DAY</span>}</td>
                      <td className="num">{c.strike}</td><td className="num">{c.bid.toFixed(2)}</td><td className="num">{(c.time_value ?? c.bid).toFixed(2)}</td><td className="num">{c.days}</td>
                      <td className="num pos">{cad(c.per_day * lots)}</td><td className="num">{cad(c.bid * 100 * lots)}</td>
                      <td className="num">{c.delta == null ? '—' : `≈${Math.round(Math.abs(c.delta) * 100)}%`}</td>
                      <td className={`num ${sign(called)}`}>{signed(called)}</td>
                      <td><button type="button" className="small secondary" onClick={() => use(c)}>Calculator</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      <span className="cc-faint">This is your rule applied to today’s quotes, not a recommendation: which call to write is your decision.</span>
    </div>
  );
}

// One stock he holds (or has traded options on): what the shares have done, what the calls and puts have paid, what is open now.
function Holding({ symbol, p, c, entries, money, toUsd, onLoad, reload, reloadCash, ins }) {
  const [err, setErr] = useState(null);
  const patch = (body) => send('PATCH', `/api/options/positions/${p.id}`, body).then(reload).catch((e) => setErr(e.message));
  const hasCash = !!c && (c.call_entries > 0 || c.put_entries > 0);
  const calls = hasCash ? toUsd(c.calls) : null; const puts = hasCash ? toUsd(c.puts) : null;
  const optNet = hasCash ? calls + puts : p ? p.premium_collected : 0;
  const legs = p ? p.open_legs || [] : [];
  const netDay = p?.figures ? p.figures.net_after_interest_per_day ?? p.figures.net_per_day : null;
  return (
    <div className="cc-hold">
      <div className="cc-hold-head">
        <div>
          <span className="cc-sym">{symbol}</span>
          {p ? <span className="cc-faint">{p.shares} shares · {usd(p.price, 2)} now · cost {usd(p.cost, 2)}{p.source === 'broker' ? ' · from your broker' : ''}{p.status === 'planned' ? ' · a plan, not opened' : ''}</span>
            : <span className="cc-faint">no shares on record: option cash only</span>}
        </div>
        <div className="cc-actions">
          {p && <button type="button" className="small" onClick={() => onLoad(p)}>Work out the next call</button>}
          {p && (
            <details className="cc-more"><summary title="More">⋯</summary>
              <div>
                {p.status === 'planned' && <button type="button" className="small-link" onClick={() => patch({ status: 'open' })}>I’ve opened it</button>}
                <button type="button" className="small-link" onClick={() => { const v = window.prompt(`Sold ${p.symbol} at (US$ a share)?`, p.price ?? ''); if (v) patch({ status: 'closed', closed_price: Number(v), legs: [] }); }}>Sold the shares</button>
                <button type="button" className="small-link" onClick={() => window.confirm(`Delete the ${p.symbol} record? Your Money Hub entries stay.`) && send('DELETE', `/api/options/positions/${p.id}`).then(reload)}>Delete this record</button>
              </div>
            </details>
          )}
        </div>
      </div>
      {err && <p className="review-error">{err}</p>}
      <div className="cc-tiles cc-tiles-sm">
        {p && <Tile k="Shares" v={signed(p.stock_pnl)} cls={sign(p.stock_pnl)} sub={`worth ${cad((p.price || 0) * p.shares)}`} />}
        {hasCash
          ? <>
              <Tile k="Calls collected" v={signed(calls)} cls={sign(calls)} sub={`${c.call_entries} entr${c.call_entries === 1 ? 'y' : 'ies'}`} />
              <Tile k="Puts, net" v={signed(puts)} cls={sign(puts)} sub={`${c.put_entries} entr${c.put_entries === 1 ? 'y' : 'ies'}`} />
              <Tile k="Options" v={signed(optNet)} cls={sign(optNet)} sub="calls less puts" />
            </>
          : <Tile k="Options cash" v={signed(optNet)} cls={sign(optNet)} sub="from your positions record" />}
        {p && <Tile k="All in" v={signed((p.stock_pnl || 0) + optNet)} cls={sign((p.stock_pnl || 0) + optNet)} sub="shares and options" />}
        {netDay != null && <Tile k="Option revenue" v={`${cad(netDay)} a trading day`} cls={sign(netDay)}
          sub={`calls ${cad(p.figures.income_per_day)}${p.figures.protection_per_day ? ` − puts ${cad(p.figures.protection_per_day)}` : ''}${p.figures.interest_per_day ? ` − interest ${cad(p.figures.interest_per_day, 2)}` : ''}`} />}
        {p?.figures?.on_capital_pct_year != null && <Tile k="On the capital" v={`${p.figures.on_capital_pct_year.toFixed(1)}% a year`} cls={sign(p.figures.on_capital_pct_year)} sub={`${cad(p.figures.capital_needed)} tied up`} />}
        {p?.figures && (p.figures.days_to_earn_max_loss != null || p.figures.max_loss != null) && <Tile k="Against the max loss" v={p.figures.days_to_earn_max_loss == null ? '—' : `${p.figures.days_to_earn_max_loss} trading days`}
          sub={p.figures.max_loss == null ? 'no limit on the loss' : `to earn back ${cad(Math.abs(p.figures.max_loss))}`} />}
      </div>
      {p && (
        <div className="cc-open">
          <span className="cc-k">Open now</span>
          {legs.length ? legs.map((l, i) => (
            <span key={i} className={`cc-chip ${l.side === 'short' ? 'sold' : 'own'}`}>
              <b>{l.side === 'short' ? 'Sold' : 'Own'} {l.contracts} × {l.strike} {l.type}</b> {l.since ? `${day(l.since)}${l.since_from_position ? ' (the position’s date)' : ''} → ` : ''}{short(l.expiry)} · {l.side === 'short' ? 'for' : 'paid'} {Number(l.premium).toFixed(2)} · {l.side === 'short' ? '+' : '−'}{cad(l.per_day)} a trading day over {l.days}
            </span>
          )) : <span className="cc-faint">no options on it: nothing coming in</span>}
        </div>
      )}
      {ins && <div className="cc-ins"><span className="cc-k">Put insurance</span><Insurance x={ins} /></div>}
      {p && p.status === 'open' && <NextCall p={p} onLoad={onLoad} />}
      {entries.length > 0 && (
        <details className="cc-trades">
          <summary>Trades in Money Hub ({entries.length})</summary>
          <div className="table-scroll">
            <table className="cc-table cc-entries"><tbody>
              {entries.map((e) => <EntryRow key={e.id} e={e} money={money} onSaved={reloadCash} />)}
            </tbody></table>
          </div>
        </details>
      )}
    </div>
  );
}

function Holdings({ positions, cash, ins, onLoad, reload, reloadCash }) {
  const [sync, setSync] = useState(null);
  const [showSource, setShowSource] = useState(false);
  useEffect(() => { send('GET', '/api/options/sync').then(setSync).catch(() => {}); }, [positions]);
  if (!positions) return null;
  const toUsd = (n) => (cash?.currency === 'CAD' && FX ? n / FX : n);
  const money = (n, d = 0) => (cash?.currency === 'CAD' ? plain(n, d) : cad(n, d));
  const live = positions.filter((p) => p.status !== 'closed');
  const closed = positions.filter((p) => p.status === 'closed');
  const cashOf = (s) => cash?.stocks.find((x) => x.symbol === s) || null;
  const entriesOf = (s) => (cash?.entries || []).filter((e) => e.symbol === s && e.kind && e.kind !== 'other');
  const seen = new Set();
  const cards = live.map((p) => { const first = !seen.has(p.symbol); seen.add(p.symbol); return { symbol: p.symbol, p, c: first ? cashOf(p.symbol) : null, entries: first ? entriesOf(p.symbol) : [] }; });
  for (const s of cash?.stocks || []) if (!seen.has(s.symbol) && (s.call_entries || s.put_entries)) cards.push({ symbol: s.symbol, p: null, c: s, entries: entriesOf(s.symbol) });
  const setSource = (body) => send('PUT', '/api/options/cash/source', body).then(reloadCash);
  return (
    <div className="panel cc-panel cc-stocks">
      <div className="panel-header spend-header"><span>Your stocks</span>
        <span className="cc-faint">{sync ? `positions from your broker${sync.account ? ` (${sync.account})` : ''}${sync.by ? ` by ${sync.by}` : ''}: ${new Date(sync.at).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Regina' })}` : 'no positions from your broker yet'}</span></div>
      {!cards.length && <p className="cc-faint cc-pad">Nothing here yet. Your Grok bot sends your broker’s positions with submit_positions, or work out a trade below and save it.</p>}
      <div className="cc-holds">
        {cards.map((x) => <Holding key={x.p ? x.p.id : x.symbol} {...x} money={money} toUsd={toUsd} onLoad={onLoad} reload={reload} reloadCash={reloadCash}
          ins={x.c || (x.p && !cards.some((y) => y !== x && y.symbol === x.symbol && y.c)) ? ins?.stocks.find((i) => i.symbol === x.symbol) || null : null} />)}
      </div>
      {cash?.unsorted.length > 0 && (
        <div className="cc-pad cc-unsorted">
          <div className="cc-pick-head">{cash.unsorted.length} entr{cash.unsorted.length === 1 ? 'y' : 'ies'} I couldn’t sort: say what {cash.unsorted.length === 1 ? 'it is' : 'they are'}, once</div>
          <div className="table-scroll">
            <table className="cc-table cc-entries"><tbody>
              {cash.unsorted.map((e) => <EntryRow key={e.id} e={e} money={money} onSaved={reloadCash} withWord />)}
            </tbody></table>
          </div>
        </div>
      )}
      {cash && (
        <div className="cc-pad cc-source">
          <span className="cc-faint">
            {cash.read.entries
              ? `Option cash is read from ${cash.read.entries} Money Hub entr${cash.read.entries === 1 ? 'y' : 'ies'}${cash.read.categories.length ? ` under ${cash.read.categories.join(', ')}` : ''}${cash.read.accounts.length ? ` (${cash.read.accounts.join(', ')})` : ''}, in ${cash.currency === 'CAD' ? 'Canadian dollars' : 'US$'}.`
              : 'No brokerage entries found in Money Hub: none are under a category named “Investment”. Pick the account your trades are in.'}
          </span>{' '}
          <button type="button" className="small-link" onClick={() => setShowSource(!showSource)}>{showSource ? 'done' : 'change'}</button>
          {(showSource || !cash.read.entries) && (
            <div className="cc-row">
              <label className="cc-mini">Also read every entry in<select value={cash.account_ids[0] || ''} onChange={(e) => setSource({ account_ids: e.target.value ? [Number(e.target.value)] : [] })}>
                <option value="">no other account</option>{cash.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label className="cc-mini">The amounts are in<select value={cash.currency} onChange={(e) => setSource({ currency: e.target.value })}>
                <option value="USD">US dollars</option><option value="CAD">Canadian dollars</option></select></label>
            </div>
          )}
        </div>
      )}
      {closed.length > 0 && (
        <details className="cc-pad cc-closedlist">
          <summary className="cc-faint">Sold ({closed.length})</summary>
          {closed.map((p) => (
            <div key={p.id} className="cc-row cc-faint">
              <b>{p.symbol}</b> {p.shares} shares, cost {usd(p.cost, 2)}, sold {usd(p.price, 2)}{p.closed_on ? ` on ${day(p.closed_on)}` : ''}: shares <span className={sign(p.stock_pnl)}>{signed(p.stock_pnl)}</span>, options cash {signed(p.premium_collected)}
              <button type="button" className="small-link" onClick={() => window.confirm(`Delete the ${p.symbol} record?`) && send('DELETE', `/api/options/positions/${p.id}`).then(reload)}>×</button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the page
export default function CoveredCalls() {
  const [rules, setRules] = useState(null);
  const [scan, setScan] = useState(null);
  const [scanErr, setScanErr] = useState(null);
  const [selected, setSelected] = useState(null);
  const [positions, setPositions] = useState(null);
  const [cash, setCash] = useState(null);
  const [ins, setIns] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [fx, setFx] = useState(null);
  const [loaded, setLoaded] = useState(null); // a position sent to the calculator (a fresh object each time, so a second tap reloads it)
  // The options he holds at what his fills say they cost (Nov 19), not the broker's lumped average.
  const loadPosition = (p, legs) => { setSelected(p.symbol); setLoaded({ ...p, legs: legs || (p.open_legs?.length ? p.open_legs : p.legs) }); };
  const pickStock = (s) => { setLoaded(null); setSelected(s); }; // a stock from the list or an alert: the rules' pick
  FX = fx?.rate || null;
  const loadScan = () => send('GET', '/api/options/scan').then((s) => { setScan(s); setScanErr(null); }).catch((e) => setScanErr(e.message));
  const loadPositions = () => send('GET', '/api/options/positions').then(setPositions).catch(() => setPositions([]));
  const loadCash = () => { send('GET', '/api/options/cash').then(setCash).catch(() => setCash(null)); send('GET', '/api/options/insurance').then(setIns).catch(() => setIns(null)); };
  useEffect(() => {
    send('GET', '/api/options/rules').then(setRules);
    send('GET', '/api/options/fx').then(setFx).catch(() => {});
    send('GET', '/api/options/alerts').then(setAlerts).catch(() => {});
    loadScan(); loadPositions(); loadCash();
    const t = setInterval(loadScan, 5 * 60e3);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { // while the wider list is being searched, look again every 30 s
    if (!scan?.wide_running) return undefined;
    const t = setTimeout(loadScan, 30e3);
    return () => clearTimeout(t);
  }, [scan]);
  const saveRules = (r) => send('PUT', '/api/options/rules', r).then((x) => { setRules(x); loadScan(); loadPositions(); });
  const today = useMemo(() => alerts.filter((a) => a.date === nyToday()), [alerts]);

  return (
    <div className="cc-page">
      <div className="page-header">
        <div><h1 className="page-title">Covered calls</h1>
          <div className="page-meta">{fx?.rate
            ? `Money in Canadian dollars at the Bank of Canada’s ${fx.rate.toFixed(4)} (${short(fx.date)}). Share prices, strikes and premiums a share in US$, as your broker shows them.`
            : 'Exchange rate unavailable: money shown in US$.'} Money Hub never places a trade.</div></div>
      </div>
      <MarketClock />
      <Earnings positions={positions} cash={cash} ins={ins} />
      <Holdings positions={positions} cash={cash} ins={ins} onLoad={loadPosition} reload={() => { loadPositions(); loadCash(); }} reloadCash={loadCash} />
      {today.length > 0 && (
        <div className="cc-alerts">{today.map((a) => (
          <button key={a.symbol} type="button" className="cc-alert" onClick={() => pickStock(a.symbol)}>
            <b>{a.symbol}</b> {a.why.join('; ')}{a.picked?.call ? ` · your rules: sell the ${a.picked.call.strike} call ${short(a.picked.call.expiry).split(',')[0]} for ${a.picked.call.bid.toFixed(2)}` : ''}
          </button>
        ))}</div>
      )}
      {rules && <Watchlist scan={scan} err={scanErr} selected={selected} onPick={pickStock} rules={rules} saveRules={saveRules} />}
      {rules && selected && <Desk symbol={selected} rules={rules} onSaved={loadPositions} loaded={loaded} onClose={() => { setSelected(null); setLoaded(null); }} />}
      {rules && <Rules rules={rules} saveRules={saveRules} />}
    </div>
  );
}
