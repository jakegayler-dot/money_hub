import { useEffect, useState } from 'react';
import { money } from '../format.js';
import { Pie } from './MonthBreakdown.jsx';

// A household budget that keeps the forecast's cash above its floor for the
// next 12 months (server/lib/budgetPlan.js): the most a month for
// discretionary spending, shared by category and by person the way the
// household actually spends, with a button to adopt it.
const PALETTE = ['#c9a227', '#5b8def', '#2bb0a1', '#e0835a', '#9b85ee', '#6fbf73', '#d46a9a', '#e8b04a', '#5fd3e6', '#b0896a', '#8fa3b8', '#7f8ce0'];
const PEOPLE = [['jake', 'Jake', '#5b8def'], ['ashley', 'Ashley', '#d46a9a'], ['untagged', 'Not tagged', '#6b7480']];

/** Cash above the floor at each month-end, as bars from zero; the tightest one marked. */
function HeadroomBars({ path, tightest }) {
  const w = 640; const h = 150; const pad = 4; const n = path.length;
  const vals = path.map((p) => p.headroom);
  const max = Math.max(0, ...vals); const min = Math.min(0, ...vals);
  const span = max - min || 1;
  const y = (v) => pad + ((max - v) / span) * (h - 2 * pad);
  const bw = (w / n) * 0.62;
  return (
    <div className="bf-bars">
      <svg viewBox={`0 0 ${w} ${h + 18}`} role="img" aria-label="Cash above the floor at each month-end with this budget">
        <line x1="0" x2={w} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth="1" />
        {path.map((p, i) => {
          const x = (i + 0.5) * (w / n) - bw / 2;
          const top = Math.min(y(p.headroom), y(0)); const ht = Math.max(1, Math.abs(y(p.headroom) - y(0)));
          const tight = p.month === tightest;
          return (
            <g key={p.month}>
              <rect x={x} y={top} width={bw} height={ht} rx="3" fill={p.headroom < 0 ? 'var(--negative)' : tight ? 'var(--gold)' : '#5b8def'} opacity={tight || p.headroom < 0 ? 1 : 0.75}>
                <title>{`${p.month}: ${money(p.headroom)} above the floor (now: ${money(p.now)})`}</title>
              </rect>
              <text x={x + bw / 2} y={h + 14} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{p.month.slice(0, 3)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function BudgetFit({ onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showHolds, setShowHolds] = useState(false);
  const load = () => fetch('/api/personal/budget').then((r) => r.json()).then((x) => (x.error ? setErr(x.error) : setD(x))).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const send = async (method) => {
    setBusy(true); setErr(null);
    const r = await fetch('/api/personal/budget/adopt', { method });
    const x = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(x.error || `HTTP ${r.status}`); return; }
    setD(x); onChanged?.();
  };
  if (!d) return err ? <div className="panel"><p className="review-error">{err}</p></div> : null;

  const slices = d.categories.map((c, i) => ({ key: c.category, label: c.category, amount: c.amount, color: PALETTE[i % PALETTE.length], c }));
  const cur = slices.find((s) => s.key === sel);
  const adopted = d.adopted;
  const inUse = adopted && adopted.monthly === d.monthly;
  const end = d.path.length ? d.path[d.path.length - 1].month : '';
  const peopleTotal = PEOPLE.reduce((a, [k]) => a + (d.people[k] || 0), 0);

  return (
    <div className="panel bf">
      <div className="panel-header spend-header">
        <span>A budget that fits the forecast</span>
        <span className="split-lines">Next {d.months} months · cash kept above the floor</span>
      </div>

      {d.shortfall ? (
        <div className="bf-head">
          <div className="bf-big neg">{money(0)}<span> a month</span></div>
          <p>
            There's no room for discretionary spending: even with none, the forecast's cash falls {money(d.shortfall.amount)} below the floor in {d.shortfall.month}.
            That gap has to close first — more income or a sale in the forecast, a bill or capital purchase moved, or essentials cut.
          </p>
        </div>
      ) : (
        <div className="bf-head">
          <div className="bf-big">{money(d.monthly)}<span> a month</span></div>
          <p>
            {d.fits
              ? `What you typically spend on discretionary (${money(d.typical)} a month) fits: cash stays above the floor at every month-end through ${end}, and the room left over stays as cash.`
              : d.typical > 0
                ? `What you typically spend (${money(d.typical)} a month) doesn't fit — this is ${d.cut_pct}% less, every category cut alike, so cash stays above the floor through ${end}.`
                : `No discretionary spending on file yet, so this is the most that fits through ${end}.`}
            {' '}Room up to {money(d.ceiling)} a month{d.binding ? `, set by ${d.binding.month}` : ''}. The forecast uses {money(d.current_monthly)} now.
          </p>
        </div>
      )}

      <HeadroomBars path={d.path} tightest={d.tightest.month} />
      <p className="split-lines bf-caption">Cash above the floor at each month-end with this budget. The tightest, {d.tightest.month}, is marked{d.tightest.headroom < 0 ? ' — below the floor' : ''}.</p>

      {slices.length > 0 && (
        <div className="ps-pie-wrap">
          <Pie slices={slices} selected={sel} onSelect={setSel} size={200} label="Budget by category" />
          <div className="ps-pie-side">
            {cur ? (
              <div>
                <button type="button" className="small-link" onClick={() => setSel(null)}>All categories</button>
                <div className="pt-cat-title">{cur.label}: {money(cur.c.amount)} a month</div>
                <p className="split-lines">Typically {money(Math.round(cur.c.typical))} a month over the last {d.history_months} months{inUse && d.spent_this_month[cur.label] != null ? `; ${money(d.spent_this_month[cur.label])} so far this month` : ''}.</p>
                <table className="ps-legend" data-nostack="">
                  <tbody>
                    {PEOPLE.filter(([k]) => cur.c[k]).map(([k, l, color]) => (
                      <tr key={k}><td><span className="ps-swatch" style={{ background: color }} />{l}</td><td className="num">{money(cur.c[k])}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <>
                <div className="split-lines" style={{ marginBottom: 6 }}>By category, in proportion to what you actually spend — click one</div>
                <table className="ps-legend" data-nostack="">
                  <tbody>
                    {slices.map((s) => {
                      const spent = d.spent_this_month[s.key] || 0;
                      return (
                        <tr key={s.key} className="ps-legend-row" tabIndex={0} onClick={() => setSel(s.key)} onKeyDown={(e) => { if (e.key === 'Enter') setSel(s.key); }}>
                          <td><span className="ps-swatch" style={{ background: s.color }} />{s.label}
                            {inUse && (
                              <span className="bf-progress" title={`${money(spent)} of ${money(s.amount)} this month`}>
                                <span style={{ width: `${Math.min(100, s.amount ? (spent / s.amount) * 100 : 0)}%`, background: spent > s.amount ? 'var(--negative)' : s.color }} />
                              </span>
                            )}
                          </td>
                          <td className="num">{inUse ? `${money(spent)} / ` : ''}{money(s.amount)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
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
          {showHolds ? 'Hide' : 'Show'} what the forecast already holds — about {money(d.holds.essentials + d.holds.scheduled)} a month, not part of this budget
        </button>
        {showHolds && (
          <table className="ps-legend" data-nostack="">
            <tbody>
              <tr className="ps-legend-total"><td>Essentials (groceries, fuel, utilities…)</td><td className="num">{money(d.holds.essentials)}</td></tr>
              <tr><td className="bf-indent" colSpan={2}>From what you typically spend on essentials, less what reaches the forecast as card statements and fees (counted below):</td></tr>
              {d.holds.essential_categories.slice(0, 8).map((c) => <tr key={c.category}><td className="bf-indent">{c.category}</td><td className="num">typically {money(c.monthly)}</td></tr>)}
              <tr className="ps-legend-total"><td>Bills, loan payments and card statements</td><td className="num">{money(d.holds.scheduled)}</td></tr>
              {d.holds.scheduled_items.slice(0, 10).map((x) => <tr key={x.name}><td className="bf-indent">{x.name}</td><td className="num">{money(x.monthly)}</td></tr>)}
            </tbody>
          </table>
        )}
      </div>

      {err && <p className="review-error" style={{ margin: '0 16px 8px' }}>{err}</p>}
      <div className="bf-actions">
        {inUse ? (
          <>
            <span className="tag tag-link">In use since {adopted.adopted_on}</span>
            <button type="button" className="small-link" disabled={busy} onClick={() => send('DELETE')}>Stop using it</button>
          </>
        ) : (
          <>
            {!d.shortfall && <button type="button" className="small" disabled={busy} onClick={() => send('POST')}>Adopt {money(d.monthly)} a month</button>}
            {adopted && <span className="split-lines">You adopted {money(adopted.monthly)} a month on {adopted.adopted_on}; the forecast has changed since.</span>}
            {adopted && <button type="button" className="small-link" disabled={busy} onClick={() => send('DELETE')}>Stop using it</button>}
          </>
        )}
      </div>
    </div>
  );
}
