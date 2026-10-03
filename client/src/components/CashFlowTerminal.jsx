import { useEffect, useMemo, useRef, useState } from 'react';
import { money } from '../format.js';
import { cents } from './SplitEditor.jsx';

// ---------------------------------------------------------------------------
// Cash flow terminal: the 12-month forecast as an instrument.
//
//   ticker strip   — the numbers that matter, with the what-if delta beside each
//   balance chart  — with estimates (amber), committed only (blue, dashed),
//                    what-if (aqua) when a scenario is on; floor reference;
//                    price-tag flags on the right edge follow the crosshair
//   flow strip     — money in (up) and out (down) per month, same months,
//                    its own scale (never a second axis on the balance chart)
//   scenario desk  — what-ifs that re-run the forecast live
//   month ledger   — click any month: every flow behind it
//
// All what-if math runs here, from the server's itemized months, so moving a
// slider is instant and nothing is saved.
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (t, i) => (i === 0 || t.month === 1 ? `${MONTHS[t.month - 1]} ’${String(t.year).slice(2)}` : MONTHS[t.month - 1]);
const full = (t) => `${MONTHS[t.month - 1]} ${t.year}`;
const kfmt = (v) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : `${Math.round(a)}`;
  return `${v < 0 ? '−' : ''}$${s}`;
};
const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${money(Math.abs(Math.round(v)))}`;

const KIND_LABEL = {
  contract: 'Contract', estimate_in: 'Estimated sale', bill: 'Bill', loan: 'Loan payment',
  card: 'Card statement', fee: 'Account fees', tax: 'Income tax', estimate_out: 'Estimated cost', purchase: 'What-if purchase',
};
const KIND_LINK = { contract: '/contracts', bill: '/bills', loan: '/loans', card: '/credit-cards' };

const NO_SCENARIO = { price: 0, costs: 0, delay: 0, buyAmount: 0, buyMonth: 3 };
const PRESETS = [
  { label: 'Prices slump 20%', s: { price: -20 } },
  { label: 'Harvest money 2 months late', s: { delay: 2 } },
  { label: 'Costs up 15%', s: { costs: 15 } },
  { label: 'Buy a $250k machine in 3 months', s: { buyAmount: 250000, buyMonth: 3 } },
];

/** Re-runs the forecast under a scenario, item by item. */
function runScenario(liquidity, sc) {
  const n = liquidity.trajectory.length;
  const months = liquidity.trajectory.map(() => ({ items: [] }));
  const isCost = (k) => k === 'bill' || k === 'estimate_out';
  liquidity.trajectory.forEach((t, i) => {
    for (const it of t.items || []) {
      let amount = it.amount;
      let at = i;
      if (it.kind === 'estimate_in') amount *= 1 + sc.price / 100;
      if (isCost(it.kind)) amount *= 1 + sc.costs / 100;
      if (it.kind === 'contract') at = i + sc.delay; // later than the window: it falls out
      if (at < n) months[at].items.push({ ...it, amount, shifted: at !== i });
    }
  });
  if (sc.buyAmount > 0 && sc.buyMonth >= 0 && sc.buyMonth < n) {
    months[sc.buyMonth].items.push({ kind: 'purchase', label: 'One-off purchase', amount: -sc.buyAmount });
  }
  let bal = liquidity.startingBalance;
  let com = liquidity.startingBalance;
  return months.map((m, i) => {
    const inflow = m.items.filter((x) => x.amount > 0).reduce((s, x) => s + x.amount, 0);
    const outflow = m.items.filter((x) => x.amount < 0).reduce((s, x) => s + x.amount, 0);
    const committedNet = m.items.filter((x) => !x.estimate).reduce((s, x) => s + x.amount, 0);
    const open = bal;
    bal += inflow + outflow;
    com += committedNet;
    return { ...liquidity.trajectory[i], open, balance: bal, committedBalance: com, inflow, outflow, items: m.items };
  });
}

/** Eases displayed numbers toward their targets so lines glide when a scenario changes. */
function useGlide(targets, ms = 520) {
  const [shown, setShown] = useState(targets);
  const from = useRef(targets);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const key = targets.join(',');
  useEffect(() => {
    if (reduce || from.current.length !== targets.length) { from.current = targets; setShown(targets); return undefined; }
    const start = performance.now();
    const a = from.current;
    let raf;
    const tick = (now) => {
      const k = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      const v = targets.map((t, i) => a[i] + (t - a[i]) * e);
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick); else from.current = targets;
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); from.current = targets; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

export default function CashFlowTerminal({ liquidity }) {
  const [sc, setSc] = useState(NO_SCENARIO);
  const [hover, setHover] = useState(null);
  const [picked, setPicked] = useState(null);
  const active = sc.price !== 0 || sc.costs !== 0 || sc.delay !== 0 || sc.buyAmount > 0;

  const base = useMemo(() => runScenario(liquidity, NO_SCENARIO), [liquidity]);
  const what = useMemo(() => runScenario(liquidity, sc), [liquidity, sc]);
  const n = base.length;

  const glideWhat = useGlide(what.map((m) => m.balance));
  const glideFlows = useGlide(what.flatMap((m) => [m.inflow, m.outflow]));

  const floor = liquidity.requiredFloor;
  const low = (arr) => arr.reduce((m, x, i) => (x.balance < arr[m].balance ? i : m), 0);
  const baseLow = low(base);
  const whatLow = low(what);

  // ---- ticker ----
  const tick = [
    { label: 'Cash today', v: liquidity.startingBalance },
    { label: `Low point · ${full(base[baseLow])}`, v: base[baseLow].balance, w: active ? what[whatLow].balance : null, whatNote: active && whatLow !== baseLow ? full(what[whatLow]) : null },
    { label: 'Headroom over floor', v: base[baseLow].balance - floor, w: active ? what[whatLow].balance - floor : null, tone: true },
    { label: `End · ${full(base[n - 1])}`, v: base[n - 1].balance, w: active ? what[n - 1].balance : null },
    { label: 'Committed only, end', v: base[n - 1].committedBalance, w: active ? what[n - 1].committedBalance : null },
  ];

  // ---- balance chart geometry ----
  // Drawn at the container's real width, so text stays its true size; on a
  // phone the right-edge flags give way to the readout below the chart.
  const boxRef = useRef(null);
  const [W, setW] = useState(880);
  useEffect(() => {
    if (!boxRef.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, []);
  const narrow = W < 560;
  const H = narrow ? 240 : 330, FH = narrow ? 96 : 120;
  const pad = { top: 24, right: narrow ? 14 : 104, bottom: 8, left: narrow ? 46 : 70 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;
  const vals = [...base.map((m) => m.balance), ...base.map((m) => m.committedBalance), ...(active ? glideWhat : []), floor, 0, liquidity.startingBalance];
  const rough = (Math.max(...vals) - Math.min(...vals) || 1) / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough);
  const yMin = Math.floor(Math.min(...vals) / step) * step;
  const yMax = Math.ceil(Math.max(...vals) / step) * step;
  // Point 0 is today's cash; point i (1..n) is the end of month i-1.
  const x = (i) => pad.left + (i / n) * iw;
  const y = (v) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * ih;
  const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const start = liquidity.startingBalance;
  const estPts = [start, ...base.map((m) => m.balance)];
  const comPts = [start, ...base.map((m) => m.committedBalance)];
  const whatPts = [start, ...glideWhat];
  const area = `${path(estPts)} L${x(n)},${y(yMin)} L${x(0)},${y(yMin)} Z`;
  const grid = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) grid.push(v);

  // ---- flow strip geometry (own scale) ----
  const fpad = { top: 10, bottom: 22 };
  const fh = FH - fpad.top - fpad.bottom;
  const fmax = Math.max(1, ...what.map((m) => Math.max(m.inflow, -m.outflow)), ...base.map((m) => Math.max(m.inflow, -m.outflow)));
  const fy0 = fpad.top + fh / 2;
  const fyk = (fh / 2) / fmax;
  const bw = Math.min(22, (iw / n) * 0.34);
  const mx = (i) => x(i + 1) - iw / n / 2; // a month's bars sit between its start and end

  const at = hover ?? picked; // a month index (0..n-1); its point is at + 1
  const tagFor = (p) => {
    const t = [
      { key: 'est', v: estPts[p], cls: 'tag-est', label: 'Est.' },
      { key: 'com', v: comPts[p], cls: 'tag-com', label: 'Com.' },
    ];
    if (active) t.push({ key: 'what', v: whatPts[p], cls: 'tag-what', label: 'If' });
    // keep flags from overlapping
    const sorted = t.map((f) => ({ ...f, yy: y(f.v) })).sort((a, b) => a.yy - b.yy);
    for (let k = 1; k < sorted.length; k++) if (sorted[k].yy - sorted[k - 1].yy < 18) sorted[k].yy = sorted[k - 1].yy + 18;
    return sorted;
  };
  const tags = tagFor(at != null ? at + 1 : n);

  const svgRef = useRef(null);
  const onMove = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.floor(((px - pad.left) / iw) * n);
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const keyNav = (e) => {
    const cur = picked ?? hover ?? 0;
    if (e.key === 'ArrowRight') { e.preventDefault(); setPicked(Math.min(n - 1, cur + 1)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPicked(Math.max(0, cur - 1)); }
    if (e.key === 'Escape') setPicked(null);
  };

  const set = (patch) => setSc((s) => ({ ...s, ...patch }));

  return (
    <div className="cft">
      <div className="cft-ticker" role="list">
        {tick.map((t) => {
          const d = t.w != null ? t.w - t.v : null;
          return (
            <div className="cft-tick" role="listitem" key={t.label}>
              <span className="cft-tick-label">{t.label}</span>
              <span className={`cft-tick-value${t.tone && t.v < 0 ? ' neg' : ''}`}>{money(Math.round(t.v))}</span>
              {d != null && Math.abs(d) >= 1 && (
                <span className={`cft-tick-delta ${d >= 0 ? 'up' : 'down'}`}>
                  {d >= 0 ? '▲' : '▼'} {money(Math.abs(Math.round(d)))}{t.whatNote ? ` · moves to ${t.whatNote}` : ''}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="cft-body">
        <div className="cft-charts">
          <div className="cft-legend" aria-hidden="true">
            <span><i className="sw est" />With estimates</span>
            <span><i className="sw com" />Committed only</span>
            {active && <span><i className="sw what" />What-if</span>}
            <span><i className="sw floor" />Required floor {kfmt(floor)}</span>
          </div>
          <div ref={boxRef}>
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H + FH}`} width={W} height={H + FH} className="cft-svg" role="img" tabIndex={0}
            aria-label="Projected cash for the next 12 months with money in and out per month. Use left and right arrows to step through months."
            onPointerMove={onMove} onPointerLeave={() => setHover(null)} onClick={() => at != null && setPicked(at === picked ? null : at)}
            onKeyDown={keyNav}>
            <defs>
              <linearGradient id="cftArea" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--cft-est)" stopOpacity="0.22" />
                <stop offset="100%" stopColor="var(--cft-est)" stopOpacity="0" />
              </linearGradient>
              <filter id="cftGlow" x="-10%" y="-30%" width="120%" height="160%">
                <feGaussianBlur stdDeviation="3" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            {grid.map((v) => (
              <g key={v}>
                <line x1={pad.left} x2={pad.left + iw} y1={y(v)} y2={y(v)} className={v === 0 ? 'cft-zero' : 'cft-grid'} />
                <text x={pad.left - 10} y={y(v) + 4} textAnchor="end" className="cft-axis">{kfmt(v)}</text>
              </g>
            ))}
            {floor > 0 && (
              <>
                <rect x={pad.left} y={y(floor)} width={iw} height={Math.max(0, y(yMin) - y(floor))} className="cft-danger" />
                <line x1={pad.left} x2={pad.left + iw} y1={y(floor)} y2={y(floor)} className="cft-floor" />
              </>
            )}

            <path d={area} fill="url(#cftArea)" className="cft-fade" />
            <path d={path(comPts)} className="cft-line com cft-fade" />
            <path d={path(estPts)} className="cft-line est cft-draw" pathLength="1" filter="url(#cftGlow)" />
            {active && <path d={path(whatPts)} className="cft-line what" filter="url(#cftGlow)" />}
            <circle cx={x(0)} cy={y(start)} r="3.5" className="cft-now" />
            <text x={x(0) + 6} y={y(start) - 8} className="cft-low-label">Today {kfmt(start)}</text>

            <g className="cft-low">
              <circle cx={x(baseLow + 1)} cy={y(estPts[baseLow + 1])} r="5" className="cft-low-dot" />
              <circle cx={x(baseLow + 1)} cy={y(estPts[baseLow + 1])} r="5" className="cft-low-ring" />
              <text x={x(baseLow + 1)} y={y(estPts[baseLow + 1]) + 22}
                textAnchor={x(baseLow + 1) > pad.left + iw - 40 ? 'end' : x(baseLow + 1) < pad.left + 40 ? 'start' : 'middle'}
                className="cft-low-label">Low {kfmt(estPts[baseLow + 1])}</text>
            </g>

            {at != null && (
              <g className="cft-cross">
                <rect x={x(at)} y={pad.top} width={iw / n} height={H + FH - fpad.bottom - pad.top} className="cft-band" />
                <line x1={x(at + 1)} x2={x(at + 1)} y1={pad.top} y2={H} />
                <circle cx={x(at + 1)} cy={y(estPts[at + 1])} r="4.5" className="est" />
                <circle cx={x(at + 1)} cy={y(comPts[at + 1])} r="4" className="com" />
                {active && <circle cx={x(at + 1)} cy={y(whatPts[at + 1])} r="4.5" className="what" />}
              </g>
            )}

            {!narrow && tags.map((t) => (
              <g key={t.key} className={`cft-tag ${t.cls}`} transform={`translate(${pad.left + iw + 6},${t.yy})`}>
                <path d="M0,0 L7,-9 L92,-9 L92,9 L7,9 Z" />
                <text x="12" y="4">{t.label} {kfmt(t.v)}</text>
              </g>
            ))}

            {/* flow strip */}
            <g transform={`translate(0,${H})`}>
              <line x1={pad.left} x2={pad.left + iw} y1={fy0} y2={fy0} className="cft-zero" />
              <text x={pad.left - 10} y={fy0 - fh / 2 + 8} textAnchor="end" className="cft-axis">in</text>
              <text x={pad.left - 10} y={fy0 + fh / 2} textAnchor="end" className="cft-axis">out</text>
              {what.map((m, i) => {
                const inn = glideFlows[i * 2];
                const out = -glideFlows[i * 2 + 1];
                const sel = i === at;
                return (
                  <g key={i} className={sel ? 'cft-bar sel' : 'cft-bar'}>
                    <rect x={mx(i) - bw / 2} y={fy0 - inn * fyk} width={bw} height={Math.max(0, inn * fyk - 1)} rx="2" className="in" />
                    <rect x={mx(i) - bw / 2} y={fy0 + 1} width={bw} height={Math.max(0, out * fyk - 1)} rx="2" className="out" />
                    {(!narrow || i % 2 === 0 || i === at) && (
                      <text x={mx(i)} y={FH - 4} textAnchor="middle" className={`cft-axis${i === at ? ' on' : ''}`}>{short(m, i)}</text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          </div>

          {at != null && (
            <div className="cft-readout" aria-live="polite">
              <strong>{full(base[at])}</strong>
              <span>Month-end, with estimates <b>{money(Math.round(estPts[at + 1]))}</b></span>
              <span>Committed <b>{money(Math.round(comPts[at + 1]))}</b></span>
              {active && <span>What-if <b>{money(Math.round(what[at].balance))}</b></span>}
              <span>In <b className="pos">{signed(what[at].inflow)}</b></span>
              <span>Out <b className="neg">{signed(what[at].outflow)}</b></span>
              {picked == null && <em>Click to open the month</em>}
            </div>
          )}
        </div>

        <aside className="cft-desk" aria-label="What-if scenario">
          <div className="cft-desk-head">
            <span>What if…</span>
            {active && <button type="button" className="small-link" onClick={() => setSc(NO_SCENARIO)}>Reset</button>}
          </div>
          <div className="cft-presets">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" className="cft-chip" onClick={() => setSc({ ...NO_SCENARIO, ...p.s })}>{p.label}</button>
            ))}
          </div>
          <Slider label="Prices on uncontracted sales" value={sc.price} min={-40} max={40} unit="%" onChange={(v) => set({ price: v })}
            hint="Applies to estimated sales (grain in the bin, unpriced calves). Contracts are fixed." />
          <Slider label="Costs: bills and estimated spending" value={sc.costs} min={-25} max={50} unit="%" onChange={(v) => set({ costs: v })} />
          <Slider label="Contract payments arrive late" value={sc.delay} min={0} max={4} unit=" mo" onChange={(v) => set({ delay: v })}
            hint="Payments pushed past the window drop out." />
          <div className="cft-field">
            <label htmlFor="cft-buy">One-off purchase</label>
            <div className="cft-buy">
              <input id="cft-buy" type="number" min="0" step="1000" placeholder="0" value={sc.buyAmount || ''}
                onChange={(e) => set({ buyAmount: Math.max(0, Number(e.target.value) || 0) })} />
              <select aria-label="Purchase month" value={sc.buyMonth} onChange={(e) => set({ buyMonth: Number(e.target.value) })}>
                {base.map((m, i) => <option key={i} value={i}>{full(m)}</option>)}
              </select>
            </div>
          </div>
          <p className="cft-desk-note">
            {active
              ? `Low point ${money(Math.round(what[whatLow].balance))} in ${full(what[whatLow])} — ${what[whatLow].balance >= floor ? 'still above' : 'below'} the floor. Nothing here is saved.`
              : 'Move a lever to see the aqua line re-run the forecast. Nothing here is saved.'}
          </p>
        </aside>
      </div>

      {picked != null && <MonthLedger m={what[picked]} b={base[picked]} active={active} onClose={() => setPicked(null)} />}
    </div>
  );
}

function Slider({ label, value, min, max, unit, onChange, hint }) {
  const id = `cft-${label.replace(/\W+/g, '-')}`;
  return (
    <div className="cft-field">
      <label htmlFor={id}>{label} <b className={value > 0 ? 'up' : value < 0 ? 'down' : ''}>{value > 0 ? '+' : ''}{value}{unit}</b></label>
      <input id={id} type="range" min={min} max={max} step="1" value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <span className="cft-hint">{hint}</span>}
    </div>
  );
}

/** Everything behind one month: money in and out, item by item. */
function MonthLedger({ m, b, active, onClose }) {
  const ins = m.items.filter((x) => x.amount > 0);
  const outs = m.items.filter((x) => x.amount < 0);
  const row = (it, i) => (
    <tr key={i}>
      <td>
        {KIND_LINK[it.kind] ? <a href={KIND_LINK[it.kind]}>{it.label}</a> : it.label}
        <div className="split-lines">
          {KIND_LABEL[it.kind] !== it.label ? KIND_LABEL[it.kind] : ''}{it.date ? `${KIND_LABEL[it.kind] !== it.label ? ' · ' : ''}${it.date}` : ''}
          {it.estimate && <span className="tag">Estimate</span>}
          {it.overdue && <span className="tag">Overdue — counted now</span>}
          {it.shifted && <span className="tag">Moved by what-if</span>}
          {it.kind === 'loan' && it.interest > 0 && <span className="tag">incl. {cents(it.interest)} interest</span>}
        </div>
      </td>
      <td className="num nowrap">{cents(it.amount)}</td>
    </tr>
  );
  return (
    <section className="panel cft-ledger" aria-label={`Cash flow detail for ${full(m)}`}>
      <div className="panel-header cft-ledger-head">
        <span>{full(m)}</span>
        <button type="button" className="small secondary" onClick={onClose}>Close</button>
      </div>
      <div className="cft-ledger-sum">
        <span>Opening <b>{money(Math.round(m.open))}</b></span>
        <span>In <b className="pos">{signed(m.inflow)}</b></span>
        <span>Out <b className="neg">{signed(m.outflow)}</b></span>
        <span>Closing <b>{money(Math.round(m.balance))}</b></span>
        {active && <span>Without the what-if <b>{money(Math.round(b.balance))}</b></span>}
      </div>
      <div className="cft-ledger-cols">
        <div>
          <h3>Money in</h3>
          {ins.length ? <table><tbody>{ins.map(row)}</tbody></table> : <p className="split-lines">Nothing expected.</p>}
        </div>
        <div>
          <h3>Money out</h3>
          {outs.length ? <table><tbody>{outs.map(row)}</tbody></table> : <p className="split-lines">Nothing scheduled.</p>}
        </div>
      </div>
    </section>
  );
}
