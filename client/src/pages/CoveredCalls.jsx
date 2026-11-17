// The covered-call desk (Jake, Nov 17: "watches for drops on large stocks that offer 0dte or close to call options. When the
// stock drops a certain amount, the goal is to buy that stock and start writing call options to generate cash ... a calculator
// of the positions that show max gain and loss at certain calls and puts ... recommend call and puts and position sizing ...
// have Andrew or Mike offer guidance"). Server: lib/options (Cboe's delayed quotes), /api/options. Money Hub never trades.
import { useEffect, useMemo, useRef, useState } from 'react';
import { localToday } from '../format.js';
import './coveredCalls.css';

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

// ---------------------------------------------------------------- the watchlist
function Watchlist({ scan, err, selected, onPick, rules, saveRules }) {
  const [add, setAdd] = useState('');
  const addOne = () => {
    const s = add.trim().toUpperCase();
    if (!s) return;
    saveRules({ watchlist: [...rules.watchlist, s] }); setAdd('');
  };
  return (
    <div className="panel cc-panel">
      <div className="panel-header spend-header">
        <span>Watching for drops</span>
        <span className="cc-faint">down {rules?.drop_day_pct}% in a day, or {rules?.drop_from_high_pct}% under the {rules?.high_days}-day high</span>
      </div>
      {err && <p className="review-error">{err}</p>}
      {!scan && !err && <p className="cc-faint cc-pad">Reading the market…</p>}
      {scan && (
        <div className="table-scroll">
          <table className="cc-table">
            <thead><tr><th>Stock</th><th className="num">Price</th><th className="num">Today</th><th className="num">From high</th><th className="num">5 days</th><th className="num">IV</th><th>Expiries this week</th><th /><th /></tr></thead>
            <tbody>
              {scan.stocks.map((s) => (
                <tr key={s.symbol} className={`${selected === s.symbol ? 'on' : ''} ${s.triggered ? 'dropped' : ''}`} onClick={() => !s.error && onPick(s.symbol)}>
                  <td><b>{s.symbol}</b></td>
                  {s.error ? <td colSpan={6} className="cc-faint">{s.error}</td> : <>
                    <td className="num">{usd(s.price, 2)}</td>
                    <td className="num">{pctS(s.day_pct)}</td>
                    <td className="num">{pctS(s.from_high_pct)}</td>
                    <td className="num">{pctS(s.five_day_pct)}</td>
                    <td className="num">{s.iv30 == null ? '—' : `${Math.round(s.iv30)}%`}</td>
                    <td>{s.expiries_this_week.length ? s.expiries_this_week.map((e) => short(e).split(',')[0]).join(' · ') : <span className="cc-faint">none</span>}</td>
                  </>}
                  <td>{s.triggered && <span className="badge warn" title={s.why.join('; ')}>DROPPED</span>}</td>
                  <td><button type="button" className="small-link" title="Stop watching"
                    onClick={(e) => { e.stopPropagation(); saveRules({ watchlist: rules.watchlist.filter((x) => x !== s.symbol) }); }}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="cc-row cc-pad">
        <input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Add a stock (e.g. TSLA)" onKeyDown={(e) => e.key === 'Enter' && addOne()} />
        <button type="button" className="small secondary" onClick={addOne}>Watch</button>
        {scan && <span className="cc-faint">Cboe, 15 minutes delayed · {asOf(scan.stocks.find((s) => s.as_of)?.as_of)}</span>}
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
  legs: (p.legs || []).filter((l) => l.expiry >= nyToday()).map((l) => ({ ...l, premium: Number(l.premium), contracts: Number(l.contracts) || 1 })),
});
function Desk({ symbol, rules, onSaved, loaded }) {
  const [from, setFrom] = useState(null); // the position in the calculator, or null for the rules' pick
  const calcRef = useRef(null);
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
      if (loaded?.symbol === symbol) { setPos(fromPosition(loaded)); setFrom(loaded); showCalc(); } else { setPos(fromPlan(p)); setFrom(null); }
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
    <div className="panel cc-panel">
      <div className="panel-header spend-header">
        <span>{symbol} · {usd(q.price, 2)} <span className="cc-faint">{pctS(q.change_pct)} today{q.iv30 ? ` · IV ${Math.round(q.iv30 * 100)}%` : ''}</span></span>
        {plan.drop?.triggered && <span className="badge warn">{plan.drop.why.join('; ')}</span>}
      </div>

      <div className="cc-pick cc-pad">
        <div className="cc-pick-head">What your rules pick</div>
        <div className="cc-pick-grid">
          <div><span className="cc-k">Call to sell</span>{plan.call ? <b>{plan.call.strike} · {short(plan.call.expiry)}</b> : <b>none fits</b>}
            {plan.call && <span className="cc-faint">bid {plan.call.bid.toFixed(2)} · delta {plan.call.delta.toFixed(2)} · {cad(plan.call.per_day)} a day a contract</span>}</div>
          <div><span className="cc-k">Put to buy</span>{plan.rules.protect ? (plan.put ? <b>{plan.put.strike} · {short(plan.put.expiry)}</b> : <b>none fits</b>) : <b>off</b>}
            {plan.put && <span className="cc-faint">ask {plan.put.ask.toFixed(2)} · {cad(plan.put.cost_per_day)} a day a contract</span>}</div>
          <div><span className="cc-k">Size</span><b>{plan.sizing.lots} lot{plan.sizing.lots === 1 ? '' : 's'} ({plan.sizing.shares} shares)</b>
            <span className="cc-faint">{plan.sizing.money_in ? `${cad(plan.sizing.money_in)} in` : ''}</span></div>
        </div>
        <ul className="cc-why">{[...plan.reasons, ...plan.sizing.limits].map((r) => <li key={r}>{r}</li>)}</ul>
        {plan.call_choices.length > 1 && (
          <div className="cc-alts">Other expiries at your delta: {plan.call_choices.map((c) => (
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
              <div><span className="cc-k">Premium in</span><b>{cad(figs.premium_in)}</b><span className="cc-faint">{cad(figs.income_per_day)} a day</span></div>
              <div><span className="cc-k">Net a day</span><b className={figs.net_per_day < 0 ? 'cc-neg' : ''}>{cad(figs.net_per_day)}</b>
                <span className="cc-faint">{figs.protection_per_day ? `after ${cad(figs.protection_per_day)} a day of puts` : 'no puts held'}</span></div>
              {figs.unlimited_gain && figs.gain_at_call != null
                ? <div><span className="cc-k">Gain at the call</span><b>{cad(figs.gain_at_call)}</b>
                    <span className="cc-faint">at {usd(figs.call_strike, 2)}; then {cad(figs.shares_not_called, 2)} for each US$1 higher on the {figs.shares_not_called} share{figs.shares_not_called === 1 ? '' : 's'} the call doesn’t cover</span></div>
                : <div><span className="cc-k">Max gain</span><b>{figs.unlimited_gain ? 'no cap' : cad(figs.max_gain)}</b><span className="cc-faint">{figs.max_gain_at != null ? `at ${usd(figs.max_gain_at, 2)} or above` : figs.unlimited_gain ? 'no call written' : ''}</span></div>}
              <div><span className="cc-k">Max loss</span><b>{figs.max_loss == null ? 'no limit' : cad(figs.max_loss)}</b>
                <span className="cc-faint">{figs.max_loss == null ? '' : figs.shares_without_put
                  ? `if it went to zero; ${cad(figs.shares_without_put * figs.cost)} of it is the ${figs.shares_without_put} share${figs.shares_without_put === 1 ? '' : 's'} the put doesn’t cover`
                  : figs.floor_from ? `about this from ${usd(figs.floor_from, 2)} down` : figs.max_loss_at != null ? (figs.max_loss_at < 1 ? 'if it went to zero' : `at ${usd(figs.max_loss_at, 2)} or below`) : ''}</span></div>
              <div><span className="cc-k">Breakeven</span><b>{figs.breakevens.length ? figs.breakevens.map((b) => usd(b, 2)).join(', ') : '—'}</b><span className="cc-faint">at the call’s expiry</span></div>
              <div><span className="cc-k">Called away</span><b>{figs.called_away_chance == null ? '—' : `≈${Math.round(figs.called_away_chance)}%`}</b><span className="cc-faint">the call’s delta</span></div>
              <div><span className="cc-k">Money in</span><b>{cad(figs.money_in)}</b><span className="cc-faint">{figs.put_cost ? `${cad(figs.put_cost)} of it the put` : 'the shares'}</span></div>
            </div>
            <Payoff curve={figs.curve} price={plan.price} breakevens={figs.breakevens} strikes={pos.legs.map((l) => Number(l.strike))} />
            <p className="cc-faint">Profit or loss on {short(figs.horizon)} (the nearest expiry); a longer put is valued at what it would still be worth then.</p>
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
const RULE_FIELDS = [
  ['capital', 'Capital for this', 1000], ['max_position_pct', 'Most in one stock (%)', 1], ['max_loss_pct', 'Most to lose on one position (% of capital)', 0.5],
  ['drop_day_pct', 'A drop: down in a day (%)', 0.5], ['drop_from_high_pct', 'or under the recent high (%)', 1], ['high_days', 'Recent high: last N days', 1],
  ['target_delta', 'Call: target delta', 0.01], ['delta_min', 'Call: delta at least', 0.01], ['delta_max', 'Call: delta at most', 0.01], ['call_max_days', 'Call: expiring within (days)', 1],
  ['put_below_pct', 'Put: below today’s price (%)', 1], ['put_days_min', 'Put: at least (days)', 1], ['put_days_max', 'Put: at most (days)', 1], ['drop_test_pct', 'No put: size against a fall of (%)', 1],
];
function Rules({ rules, saveRules }) {
  const [f, setF] = useState(rules);
  useEffect(() => setF(rules), [rules]);
  const dirty = JSON.stringify(f) !== JSON.stringify(rules);
  return (
    <details className="panel cc-panel cc-rules" open={!rules.capital}>
      <summary className="panel-header spend-header"><span>Your rules</span><span className="cc-faint">{rules.capital ? `${rules.capital_currency === 'USD' ? usd(rules.capital) : plain(rules.capital)} · call Δ${rules.target_delta} within ${rules.call_max_days} days · ${rules.protect ? `put ${rules.put_below_pct}% below` : 'no put'}` : 'set your capital to size positions'}</span></summary>
      <div className="cc-rule-grid cc-pad">
        {RULE_FIELDS.map(([k, label, step]) => (
          <label key={k} className="cc-mini">{label}<input type="number" step={step} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
        ))}
        <label className="cc-mini">Capital is in<select value={f.capital_currency || 'CAD'} onChange={(e) => setF({ ...f, capital_currency: e.target.value })}>
          <option value="CAD">Canadian dollars</option><option value="USD">US dollars</option></select></label>
        <label className="cc-check"><input type="checkbox" checked={!!f.protect} onChange={(e) => setF({ ...f, protect: e.target.checked })} /> Buy a put for protection</label>
      </div>
      <div className="cc-row cc-pad">
        <button type="button" className="small" disabled={!dirty} onClick={() => saveRules(f)}>Save rules</button>
        {dirty && <button type="button" className="small secondary" onClick={() => setF(rules)}>Undo</button>}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- his positions
function Positions({ list, reload, onLoad }) {
  const [log, setLog] = useState(null); // { id, amount }
  const [err, setErr] = useState(null);
  const [sync, setSync] = useState(null);
  useEffect(() => { send('GET', '/api/options/sync').then(setSync).catch(() => {}); }, [list]);
  if (!list) return null;
  const patch = (id, body) => send('PATCH', `/api/options/positions/${id}`, body).then(reload).catch((e) => setErr(e.message));
  const open = list.filter((p) => p.status !== 'closed');
  return (
    <div className="panel cc-panel">
      <div className="panel-header spend-header"><span>Your positions</span>
        <span className="cc-faint">{open.length ? `net ${cad(open.reduce((a, p) => a + (p.figures?.net_per_day || 0), 0))} a day · options cash so far ${cad(open.reduce((a, p) => a + p.premium_collected, 0))}` : 'none yet'}</span></div>
      <p className="cc-faint cc-pad" style={{ margin: 0 }}>
        {sync ? `From your broker${sync.account ? ` (${sync.account})` : ''}${sync.by ? ` by ${sync.by}` : ''}: ${new Date(sync.at).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Regina' })}`
          : 'Nothing from your broker yet: your Grok bot sends the account with submit_positions.'}
      </p>
      {err && <p className="review-error">{err}</p>}
      {list.length > 0 && (
        <div className="table-scroll">
          <table className="cc-table">
            <thead><tr><th>Stock</th><th className="num">Shares</th><th className="num">Cost</th><th className="num">Now</th><th className="num">Stock</th><th className="num" title="Premium from calls written, less what puts and buy-backs cost">Options cash</th><th className="num">Total</th><th>Legs now</th><th className="num" title="Calls written a day, less what the puts cost a day (each spread from when it was opened to its expiry)">Net a day</th><th className="num">Max loss</th><th /></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} className={p.status === 'closed' ? 'cc-closed' : ''}>
                  <td><button type="button" className="small-link" onClick={() => onLoad(p)} title="Load into the calculator"><b>{p.symbol}</b></button>{p.status !== 'open' && <span className="badge"> {p.status.toUpperCase()}</span>}{p.source === 'broker' && p.status !== 'closed' && <span className="cc-faint"> · broker</span>}</td>
                  <td className="num">{p.shares}</td><td className="num">{usd(p.cost, 2)}</td><td className="num">{usd(p.price, 2)}</td>
                  <td className={`num ${p.stock_pnl < 0 ? 'neg' : 'pos'}`}>{cad(p.stock_pnl)}</td>
                  <td className="num">{cad(p.premium_collected)}</td>
                  <td className={`num ${p.total_pnl < 0 ? 'neg' : 'pos'}`}>{cad(p.total_pnl)}</td>
                  <td>{p.legs.length ? p.legs.map((l) => `${l.side === 'short' ? '−' : '+'}${l.contracts} ${l.strike}${l.type === 'call' ? 'C' : 'P'} ${short(l.expiry).split(',')[0]}`).join(' · ') : <span className="cc-faint">none</span>}</td>
                  <td className={`num ${p.figures?.net_per_day < 0 ? 'neg' : ''}`} title={p.figures ? `${cad(p.figures.income_per_day)} calls − ${cad(p.figures.protection_per_day)} puts` : ''}>{cad(p.figures?.net_per_day)}</td>
                  <td className="num">{cad(p.figures?.max_loss)}</td>
                  <td className="cc-actions">
                    {p.status !== 'closed' && <button type="button" className="small" onClick={() => onLoad(p)}>Calculator</button>}
                    {p.status !== 'closed' && (log?.id === p.id ? (
                      <span className="cc-row">
                        <input type="number" step="1" placeholder="US$ in" value={log.amount} onChange={(e) => setLog({ ...log, amount: e.target.value })} style={{ width: 80 }} />
                        <button type="button" className="small" onClick={() => { patch(p.id, { premium_collected: p.premium_collected + Number(log.amount || 0) }); setLog(null); }}>Add</button>
                      </span>
                    ) : <button type="button" className="small secondary" onClick={() => setLog({ id: p.id, amount: '' })} title="Premium from a call written; negative for a call bought back or a put bought">+ Option cash</button>)}
                    {p.status === 'planned' && <button type="button" className="small secondary" onClick={() => patch(p.id, { status: 'open' })}>Opened</button>}
                    {p.status !== 'closed' && <button type="button" className="small secondary" onClick={() => { const v = window.prompt(`Sold ${p.symbol} at (per share)?`, p.price ?? ''); if (v) patch(p.id, { status: 'closed', closed_price: Number(v), legs: [] }); }}>Close</button>}
                    <button type="button" className="small-link" onClick={() => window.confirm(`Delete the ${p.symbol} record?`) && send('DELETE', `/api/options/positions/${p.id}`).then(reload)}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
  const [alerts, setAlerts] = useState([]);
  const [fx, setFx] = useState(null);
  const [loaded, setLoaded] = useState(null); // a position sent to the calculator (a fresh object each time, so a second tap reloads it)
  const loadPosition = (p) => { setSelected(p.symbol); setLoaded({ ...p }); };
  const pickStock = (s) => { setLoaded(null); setSelected(s); }; // a stock from the list or an alert: the rules' pick
  FX = fx?.rate || null;
  const loadScan = () => send('GET', '/api/options/scan').then((s) => {
    setScan(s); setScanErr(null);
    setSelected((cur) => cur || s.stocks.find((x) => x.triggered && !x.error)?.symbol || s.stocks.find((x) => !x.error)?.symbol || null);
  }).catch((e) => setScanErr(e.message));
  const loadPositions = () => send('GET', '/api/options/positions').then(setPositions).catch(() => setPositions([]));
  useEffect(() => {
    send('GET', '/api/options/rules').then(setRules);
    send('GET', '/api/options/fx').then(setFx).catch(() => {});
    send('GET', '/api/options/alerts').then(setAlerts).catch(() => {});
    loadScan(); loadPositions();
    const t = setInterval(loadScan, 5 * 60e3);
    return () => clearInterval(t);
  }, []);
  const saveRules = (r) => send('PUT', '/api/options/rules', r).then((x) => { setRules(x); loadScan(); });
  const today = useMemo(() => alerts.filter((a) => a.date === new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())), [alerts]);

  return (
    <div className="cc-page">
      <div className="page-header">
        <div><h1 className="page-title">Covered calls</h1>
          <div className="page-meta">Buy the drop, write short-dated calls for income, buy a put against a big fall. Money Hub reads the market and keeps your records; it never places a trade.</div>
          <div className="page-meta">{fx?.rate
            ? `Money in Canadian dollars at the Bank of Canada’s ${fx.rate.toFixed(4)} (${short(fx.date)}); share prices, strikes and premiums a share in US$, as your broker shows them.`
            : 'Exchange rate unavailable: money shown in US$.'}</div></div>
      </div>
      {today.length > 0 && (
        <div className="cc-alerts">{today.map((a) => (
          <button key={a.symbol} type="button" className="cc-alert" onClick={() => pickStock(a.symbol)}>
            <b>{a.symbol}</b> {a.why.join('; ')}{a.picked?.call ? ` · your rules: sell the ${a.picked.call.strike} call ${short(a.picked.call.expiry).split(',')[0]} for ${a.picked.call.bid.toFixed(2)}` : ''}
          </button>
        ))}</div>
      )}
      {rules && <Watchlist scan={scan} err={scanErr} selected={selected} onPick={pickStock} rules={rules} saveRules={saveRules} />}
      {rules && selected && <Desk symbol={selected} rules={rules} onSaved={loadPositions} loaded={loaded} />}
      {rules && <Rules rules={rules} saveRules={saveRules} />}
      <Positions list={positions} reload={loadPositions} onLoad={loadPosition} />
    </div>
  );
}
