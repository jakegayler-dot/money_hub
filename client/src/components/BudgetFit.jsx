import { useEffect, useState } from 'react';
import { money } from '../format.js';
import { Pie } from './Pie.jsx';
import { SERIES, OTHER, foldSlices } from '../chartColors.js';

// The household budget (Jake, 2026-10-24: "use a simple budget based on the
// amount above the floor in cash floor"). Cash Flow works it out with every
// bill, loan, card statement, fee, tax payment and the farm already in: the
// room above the floor each month, the most a month that keeps every
// month-end above it, and 90% of that (a tenth kept spare). It covers
// everything the household spends that isn't a bill, and the forecast spends
// it every month (server/lib/budgetPlan.js, forecast.js).
const PEOPLE = [['jake', 'Jake', SERIES[0]], ['ashley', 'Ashley', SERIES[4]], ['untagged', 'Not tagged', OTHER]];
const SHARES = [0.8, 0.9, 1];

/** Cash above the floor at each month-end with the budget spent; the tightest marked. */
function HeadroomBars({ path, tightest }) {
  const w = 640; const h = 150; const pad = 4; const n = path.length;
  const vals = path.map((p) => p.headroom);
  const max = Math.max(0, ...vals); const min = Math.min(0, ...vals);
  const span = max - min || 1;
  const y = (v) => pad + ((max - v) / span) * (h - 2 * pad);
  const bw = (w / n) * 0.62;
  return (
    <div className="bf-bars">
      <svg viewBox={`0 0 ${w} ${h + 18}`} role="img" aria-label="Cash above the floor at each month-end with the budget spent">
        <line x1="0" x2={w} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth="1" />
        {path.map((p, i) => {
          const x = (i + 0.5) * (w / n) - bw / 2;
          const top = Math.min(y(p.headroom), y(0)); const ht = Math.max(1, Math.abs(y(p.headroom) - y(0)));
          const tight = p.month === tightest;
          return (
            <g key={p.month}>
              <rect x={x} y={top} width={bw} height={ht} rx="3" fill={p.headroom < 0 ? 'var(--negative)' : tight ? 'var(--gold)' : SERIES[0]} opacity={tight || p.headroom < 0 ? 1 : 0.75}>
                <title>{`${p.month}: ${money(p.headroom)} above the floor`}</title>
              </rect>
              <text x={x + bw / 2} y={h + 14} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{p.month.slice(0, 3)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function BudgetFit({ onLoaded }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showHolds, setShowHolds] = useState(false);
  const got = (x) => { setD(x); onLoaded?.(x); };
  const load = () => fetch('/api/personal/budget').then((r) => r.json()).then((x) => (x.error ? setErr(x.error) : got(x))).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const setShare = async (share) => {
    setBusy(true); setErr(null);
    const r = await fetch('/api/personal/budget/share', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ share }) });
    const x = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(x.error || `HTTP ${r.status}`); return; }
    got(x);
  };
  if (!d) return err ? <div className="panel"><p className="review-error">{err}</p></div> : null;

  const spentBy = d.spent_by_category || {};
  const slices = foldSlices(d.categories.map((c) => ({ key: c.category, label: c.category, amount: c.amount, c })), { max: 8 });
  const cur = slices.find((s) => s.key === sel);
  const end = d.path.length ? d.path[d.path.length - 1].month : '';
  const peopleTotal = PEOPLE.reduce((a, [k]) => a + (d.people[k] || 0), 0);
  const pctSpent = d.monthly ? Math.min(100, (d.spent_this_month / d.monthly) * 100) : 0;
  const over = d.spent_this_month > d.monthly;
  const rows = cur?.rest ? cur.rest.map((s) => ({ ...s, color: OTHER })) : cur ? [cur] : slices.flatMap((s) => (s.rest ? s.rest.map((x) => ({ ...x, color: OTHER })) : [s]));

  return (
    <div className="panel bf">
      <div className="panel-header spend-header">
        <span>Household budget</span>
        <span className="seg-toggle" role="group" aria-label="Share of the room above the floor">
          {SHARES.map((v) => (
            <button key={v} type="button" disabled={busy} aria-pressed={Math.abs(d.share - v) < 0.001} className={Math.abs(d.share - v) < 0.001 ? 'on' : ''}
              onClick={() => Math.abs(d.share - v) >= 0.001 && setShare(v)}>{Math.round(v * 100)}%</button>
          ))}
        </span>
      </div>

      {d.shortfall ? (
        <div className="bf-head">
          <div className="bf-big neg">{money(0)}<span> a month</span></div>
          <p>
            There's no room above the floor: even with no household spending, Cash Flow's cash falls {money(d.shortfall.amount)} below the floor in {d.shortfall.month}.
            That gap has to close first — more income or a sale in the forecast, or a bill or purchase moved.
          </p>
        </div>
      ) : (
        <div className="bf-head">
          <div className="bf-big">{money(d.monthly)}<span> a month</span></div>
          <p>
            For everything the household spends that isn't a bill, a loan payment or a card balance already owed — groceries, fuel, eating out, kids, the lot.
            With those and the farm already in Cash Flow, the most a month that keeps every month-end above the floor through {end} is {money(d.room)}
            {d.binding ? `, set by ${d.binding.month}` : ''}; this is {Math.round(d.share * 100)}% of it{d.share < 1 ? `, so ${money(Math.max(0, d.room - d.monthly))} a month stays spare` : ''}.
            Cash Flow spends it every month.
          </p>
        </div>
      )}

      {!d.shortfall && d.monthly > 0 && (
        <div className="bf-month">
          <div className="bf-month-row">
            <span>This month: <b className={over ? 'neg' : ''}>{money(d.spent_this_month)}</b> spent of {money(d.monthly)}</span>
            <span className={over ? 'neg' : 'split-lines'}>{over ? `${money(d.spent_this_month - d.monthly)} over` : `${money(d.left_this_month)} left`}</span>
          </div>
          <span className="bf-progress bf-progress-wide" role="img" aria-label={`${money(d.spent_this_month)} of ${money(d.monthly)} spent this month`}>
            <span style={{ width: `${pctSpent}%`, background: over ? 'var(--negative)' : SERIES[0] }} />
          </span>
          <p className="split-lines">Cash Flow counts only what's left of it this month: {money(d.left_this_month)}.</p>
        </div>
      )}

      <HeadroomBars path={d.path} tightest={d.tightest.month} />
      <p className="split-lines bf-caption">Cash above the floor at each month-end with the budget spent. The tightest, {d.tightest.month}, is marked{d.tightest.headroom < 0 ? ' — below the floor' : ''}.</p>

      {slices.length > 0 && (
        <div className="ps-pie-wrap">
          <Pie slices={slices} selected={sel} onSelect={setSel} size={220} label="Budget by category" centerTitle="A month" />
          <div className="ps-pie-side">
            {cur && <button type="button" className="small-link" onClick={() => setSel(null)}>All categories</button>}
            <div className="split-lines" style={{ margin: '4px 0 6px' }}>
              A guide, not separate limits: the budget shared the way you've spent over the last {d.history_months} months, with this month so far
            </div>
            <table className="ps-legend" data-nostack="">
              <tbody>
                {rows.map((s) => {
                  const spent = spentBy[s.key] || 0;
                  return (
                    <tr key={s.key} className="ps-legend-row" tabIndex={0} onClick={() => setSel(slices.some((x) => x.key === s.key) ? s.key : '__rest')}
                      onKeyDown={(e) => { if (e.key === 'Enter') setSel(slices.some((x) => x.key === s.key) ? s.key : '__rest'); }}>
                      <td><span className="ps-swatch" style={{ background: s.color }} />{s.label}
                        <span className="bf-progress" title={`${money(spent)} of ${money(s.amount)} this month`}>
                          <span style={{ width: `${Math.min(100, s.amount ? (spent / s.amount) * 100 : 0)}%`, background: spent > s.amount ? 'var(--negative)' : s.color }} />
                        </span>
                      </td>
                      <td className="num">{money(spent)} / {money(s.amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {cur && !cur.rest && (
              <table className="ps-legend" data-nostack="" style={{ marginTop: 8 }}>
                <tbody>
                  <tr><td className="split-lines" colSpan={2}>Typically {money(Math.round(cur.c.typical))} a month. By person:</td></tr>
                  {PEOPLE.filter(([k]) => cur.c[k]).map(([k, l, color]) => (
                    <tr key={k}><td><span className="ps-swatch" style={{ background: color }} />{l}</td><td className="num">{money(cur.c[k])}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {peopleTotal > 0 && (
        <div className="bf-people">
          <div className="split-lines">By person</div>
          <div className="bf-stack" role="img" aria-label="Budget by person">
            {PEOPLE.filter(([k]) => d.people[k] > 0).map(([k, l, color]) => (
              <span key={k} style={{ width: `${(d.people[k] / peopleTotal) * 100}%`, background: color }} title={`${l}: ${money(d.people[k])}`} />
            ))}
          </div>
          <div className="bf-people-key">
            {PEOPLE.filter(([k]) => d.people[k] > 0).map(([k, l, color]) => (
              <span key={k}><span className="ps-swatch" style={{ background: color }} />{l} {money(d.people[k])}</span>
            ))}
          </div>
        </div>
      )}

      <div className="bf-holds">
        <button type="button" className="small-link" onClick={() => setShowHolds(!showHolds)}>
          {showHolds ? 'Hide' : 'Show'} the household's bills, loans and card statements already in Cash Flow — about {money(d.holds.scheduled)} a month, not part of this budget
        </button>
        {showHolds && (
          <table className="ps-legend" data-nostack="">
            <tbody>
              {d.holds.scheduled_items.map((x) => <tr key={x.name}><td className="bf-indent">{x.name}</td><td className="num">{money(x.monthly)}</td></tr>)}
              <tr className="ps-legend-total"><td>A month, on average</td><td className="num">{money(d.holds.scheduled)}</td></tr>
            </tbody>
          </table>
        )}
      </div>

      {err && <p className="review-error" style={{ margin: '0 16px 8px' }}>{err}</p>}
    </div>
  );
}
