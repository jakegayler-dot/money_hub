import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { money } from '../format.js';
import { OWNER_KEYS, OWNER_LABELS } from '../owners.jsx';

const VIEWS = [{ key: 'all', label: 'Combined' }, ...OWNER_KEYS.map((k) => ({ key: k, label: OWNER_LABELS[k] }))];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STORAGE_KEY = 'moneyhub.entity';
const BASIS_KEY = 'moneyhub.forecastBasis';

function readSaved(key, allowed, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable — selection just won't persist */ }
}

const signed = (n) => `${n >= 0 ? '+' : '−'}${money(Math.abs(Math.round(n)))}`;

// 12-month projected cash as a tiny single-series sparkline: gold line,
// zero line when the range crosses it, low point marked. No axes — the
// card's numbers carry the values; this carries the shape.
function Spark({ points }) {
  if (!points || points.length < 2) return null;
  const W = 140, H = 36, P = 3;
  const vals = points.map((p) => p.balance);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i) => P + (i / (points.length - 1)) * (W - 2 * P);
  const y = (v) => P + (1 - (v - min) / span) * (H - 2 * P);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join(' ');
  const lowIdx = vals.indexOf(Math.min(...vals));
  const crossesZero = min < 0 && max > 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" style={{ display: 'block' }}>
      {crossesZero && <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeDasharray="3 3" />}
      <path d={d} fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(lowIdx)} cy={y(vals[lowIdx])} r="3.5"
        fill={vals[lowIdx] < 0 ? 'var(--negative)' : 'var(--gold)'} stroke="var(--panel)" strokeWidth="2" />
    </svg>
  );
}

export default function EntityBar() {
  const [entity, setEntity] = useState(() => readSaved(STORAGE_KEY, VIEWS.map((v) => v.key), 'all'));
  // Estimates are the default basis: cash here arrives in big lumps between
  // long dry stretches, so a committed-only view makes a large balance look
  // spendable when months of estimated costs follow it.
  const [basis, setBasis] = useState(() => readSaved(BASIS_KEY, ['estimates', 'committed'], 'estimates'));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const location = useLocation();

  useEffect(() => {
    save(STORAGE_KEY, entity);
    let cancelled = false;
    setError(null);
    fetch(`/api/entity-summary?entity=${entity}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok || !body || !body.cashFlow) throw new Error((body && body.error) || `HTTP ${r.status}`);
        return body;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
    // Refetch on page change too, so numbers reflect whatever was just
    // recorded on the page you came from.
  }, [entity, location.pathname]);

  useEffect(() => save(BASIS_KEY, basis), [basis]);

  const cf = data?.cashFlow;
  const proj = cf ? (basis === 'estimates' ? cf.withEstimates : cf.committed) : null;
  const low = proj?.lowPoint;
  const lowLabel = low ? `${MONTHS[low.month - 1]} ’${String(low.year).slice(2)}` : '';

  return (
    <section className="entity-bar" aria-label="Owner view and headline metrics">
      <div className="entity-controls">
        <div className="seg-control" role="tablist" aria-label="Whose financials">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              role="tab"
              aria-selected={entity === v.key}
              className={`seg-option${entity === v.key ? ' active' : ''}`}
              onClick={() => setEntity(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="seg-control seg-control-sm" role="radiogroup" aria-label="Forecast basis">
          {[['estimates', 'With estimates'], ['committed', 'Committed only']].map(([k, l]) => (
            <button key={k} role="radio" aria-checked={basis === k}
              className={`seg-option${basis === k ? ' active' : ''}`} onClick={() => setBasis(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="entity-error">Couldn't load metrics: {error}</div>
      ) : (
        <div className="entity-metrics">
          <div className="entity-card">
            <div className="metric-label">Cash flow — {basis === 'estimates' ? 'with estimates' : 'committed only'}</div>
            <div className="entity-card-row">
              <div>
                <div className={`metric-value${proj && low.balance < 0 ? ' negative' : ''}`}>{cf ? money(cf.cashNow) : '—'}</div>
                <div className="metric-sub">
                  {proj ? <>Next 12 mo {signed(proj.projectedNet12)} · low {money(low.balance)} in {lowLabel}</> : 'Loading…'}
                </div>
              </div>
              {proj && <Spark points={proj.trajectory} />}
            </div>
          </div>

          <div className="entity-card">
            <div className="metric-label">Earnings — {new Date().getFullYear()} to date</div>
            <div className={`metric-value${data ? (data.earningsYTD.total >= 0 ? ' positive' : ' negative') : ''}`}>
              {data ? signed(data.earningsYTD.total) : '—'}
            </div>
            <div className="metric-sub">
              {data ? <>In {money(data.earningsYTD.revenue)} − out {money(data.earningsYTD.costs)}</> : 'Loading…'}
            </div>
          </div>

          <div className="entity-card">
            <div className="metric-label">Equity</div>
            <div className={`metric-value${data && data.equity.total < 0 ? ' negative' : ''}`}>
              {data ? money(data.equity.total) : '—'}
            </div>
            <div className="metric-sub">
              {data ? <>Cash {money(data.equity.cash)} + assets {money(data.equity.assets)} + inventory {money(data.equity.inventory)} − loans {money(data.equity.loans)}{data.equity.creditCards ? <> − cards {money(data.equity.creditCards)}</> : null}</> : 'Loading…'}
            </div>
          </div>
        </div>
      )}

      {data?.entity === 'all' && Math.abs(data.unassignedCash || 0) >= 1 && (
        <div className="entity-note">
          {money(data.unassignedCash)} of cash isn't tagged to an owner yet — set owners on Accounts (starting balances)
          and retag any old "Personal" items, and it will flow into the right view.
        </div>
      )}
    </section>
  );
}
