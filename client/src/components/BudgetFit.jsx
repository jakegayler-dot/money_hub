import { useEffect, useState } from 'react';
import { money } from '../format.js';
import { Pie } from './Pie.jsx';
import { SERIES, OTHER, foldSlices } from '../chartColors.js';
import './budgetNow.css';

// The household budget (Jake, 2026-10-30: "take my balance at end of August 2027 and divide it by the
// number of months till August"). Cash Flow works it out with every bill, loan, card statement, fee, tax
// payment and the farm already in: the balance at the end of next August ÷ the months to it (times the share
// picked here). It covers everything the household spends that isn't a bill, and the forecast spends it
// every month (server/lib/budgetPlan.js, forecast.js).
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

      {!d.shortfall && d.monthly > 0 && (() => {
        // This month first (Jake, Oct 31: "shown better"): what's left, a day's worth, the pace, and where it went.
        const now = new Date(); const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const daysLeft = dim - now.getDate() + 1; const left = d.monthly - d.spent_this_month;
        const pace = (d.spent_this_month / Math.max(1, now.getDate())) * dim;
        const cats = Object.entries(d.spent_by_category || {}).filter(([, v]) => v > 0.5).sort((x, y) => y[1] - x[1]);
        const top = cats.length ? cats[0][1] : 1;
        return (
          <div className="bf-now">
            <div className="bf-now-head">
              <div>
                <div className="bf-now-k">This month</div>
                <div className={`bf-now-v ${over ? 'neg' : ''}`}>{over ? `${money(-left)} over` : `${money(left)} left`}</div>
                <div className="bf-now-s">{money(d.spent_this_month)} spent of {money(d.monthly)} · {daysLeft} day{daysLeft === 1 ? '' : 's'} to go</div>
              </div>
              {!over && daysLeft > 0 && <div className="bf-now-day"><b>{money(left / daysLeft)}</b><span>a day from here</span></div>}
            </div>
            <span className="bf-progress bf-progress-wide" role="img" aria-label={`${money(d.spent_this_month)} of ${money(d.monthly)} spent this month`}>
              <span style={{ width: `${pctSpent}%`, background: over ? 'var(--negative)' : SERIES[0] }} />
            </span>
            <p className="split-lines">{pace > d.monthly && !over ? `At this pace the month ends near ${money(pace)}, ${money(pace - d.monthly)} over.` : over ? "Over for this month: next month's budget is worked out from the cash that's left." : `At this pace the month ends near ${money(pace)}.`}</p>
            {cats.length > 0 && (
              <div className="bf-now-cats">
                {cats.map(([c, v]) => (
                  <div key={c} className="bf-now-cat">
                    <span>{c}</span>
                    <span className="bf-now-catbar"><span style={{ width: `${(v / top) * 100}%` }} /></span>
                    <b>{money(v)}</b>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {d.shortfall ? (
        <div className="bf-head">
          <div className="bf-big neg">{money(0)}<span> a month</span></div>
          <p>
            There's no money for discretionary spending: even with none, Cash Flow's cash is {money(d.shortfall.amount)} short around {d.shortfall.month}.
            That gap has to close first — more income or a sale in the forecast, or a bill or purchase moved.
          </p>
        </div>
      ) : (
        <div className="bf-head">
          <div className="bf-big">{money(d.monthly)}<span> a month</span></div>
          <p>
            Discretionary spending: everything the household spends that isn't a bill or a loan payment already planned — groceries, fuel, eating out, kids, subscriptions, the lot.
            It's the cash Cash Flow expects at {d.binding?.until ? new Date(`${d.binding.until}T12:00:00`).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' }) : `the end of ${end}`} (with every bill, loan and the farm in, before this spending) ÷ the {d.binding ? d.binding.months_to_it : ''} months left to it{d.share < 1 ? `; ${Math.round(d.share * 100)}% of that, so ${money(Math.max(0, d.room - d.monthly))} a month stays spare` : ''}.
            It's worked out again as Cash Flow changes, so a big month now makes the months after it smaller.
          </p>
        </div>
      )}

      {d.tracker?.length > 0 && (
        <div className="bf-month">
          <div className="bf-month-row"><span><b>Month by month</b></span>
            <span className="split-lines">{(() => { const done = d.tracker.filter((t) => t.budget != null && !t.current); const o = done.filter((t) => t.over > 0).length; return done.length ? `Over in ${o} of ${done.length} month${done.length === 1 ? '' : 's'}` : 'Budgets kept from Oct 2026'; })()}</span>
          </div>
          <table>
            <thead><tr><th>Month</th><th style={{ textAlign: 'right' }}>Budget</th><th style={{ textAlign: 'right' }}>Spent</th><th style={{ textAlign: 'right' }}>Over / under</th><th style={{ width: '35%' }} /></tr></thead>
            <tbody>
              {[...d.tracker].reverse().map((t) => {
                const pct = t.budget ? Math.min(100, (t.spent / t.budget) * 100) : 0;
                const isOver = t.over != null && t.over > 0;
                return (
                  <tr key={t.month}>
                    <td className="nowrap">{t.label}{t.current ? ' (so far)' : ''}</td>
                    <td style={{ textAlign: 'right' }}>{t.budget != null ? money(t.budget) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{money(t.spent)}</td>
                    <td style={{ textAlign: 'right' }} className={isOver ? 'neg' : ''}>{t.over == null ? '—' : isOver ? `${money(t.over)} over` : `${money(-t.over)} under`}</td>
                    <td>{t.budget ? <span className="bf-progress" role="img" aria-label={`${money(t.spent)} of ${money(t.budget)}`}><span style={{ width: `${pct}%`, background: isOver ? 'var(--negative)' : SERIES[0] }} /></span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="split-lines">Each month's budget is the one that stood at its end (it moves as Cash Flow changes); earlier months have no budget kept.</p>
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
