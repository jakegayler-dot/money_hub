import { useEffect, useState } from 'react';
import MetricCard from '../components/MetricCard.jsx';
import { money, pct } from '../format.js';
import { OwnerFields, ownerPayload, ownerSummary, emptyOwnerFields } from '../owners.jsx';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (t, i) =>
  i === 0 || t.month === 1 ? `${MONTH_NAMES[t.month - 1]} ’${String(t.year).slice(2)}` : MONTH_NAMES[t.month - 1];
const monthLabelFull = (t) => `${MONTH_NAMES[t.month - 1]} ${t.year}`;
const FREQ_LABELS = { one_time: 'One-time', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual' };

// Two-series line chart: projected business cash WITH estimates (solid,
// the default basis) and COMMITTED ONLY (dashed), plus the required floor
// as a labeled reference line. Series are told apart by colour AND dash
// AND a direct end label, never colour alone. Each month has a full-height
// hover target whose tooltip carries both values.
function ForecastChart({ trajectory, requiredFloor }) {
  const W = 760, H = 280;
  const pad = { top: 18, right: 118, bottom: 28, left: 78 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const all = trajectory.flatMap((t) => [t.balance, t.committedBalance]).concat([requiredFloor, 0]);
  // Round gridlines to a clean step (1, 2 or 5 × a power of ten) so the
  // axis reads $100k / $200k / $300k rather than $122,267.
  const rough = (Math.max(...all) - Math.min(...all) || 1) / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough);
  const yMin = Math.floor(Math.min(...all) / step) * step;
  const yMax = Math.ceil(Math.max(...all) / step) * step;
  const n = trajectory.length;
  const x = (i) => pad.left + (i / (n - 1 || 1)) * innerW;
  const y = (v) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;
  const line = (key) => trajectory.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(t[key]).toFixed(1)}`).join(' ');
  const grid = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) grid.push(v);
  const last = trajectory[n - 1];
  // Keep the two end labels from colliding.
  let yEst = y(last.balance) + 4;
  let yCom = y(last.committedBalance) + 4;
  if (Math.abs(yEst - yCom) < 14) { if (yEst <= yCom) yCom = yEst + 14; else yEst = yCom + 14; }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
      aria-label="Projected business cash over 12 months, with estimates and committed only, against the required floor">
      {grid.map((v, i) => (
        <g key={i}>
          <line x1={pad.left} x2={pad.left + innerW} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
          <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)" fontFamily="var(--font-mono)">
            {money(Math.round(v))}
          </text>
        </g>
      ))}

      <line x1={pad.left} x2={pad.left + innerW} y1={y(requiredFloor)} y2={y(requiredFloor)}
        stroke="var(--negative)" strokeWidth="1.5" strokeDasharray="2 4" />
      <text x={pad.left + 4} y={y(requiredFloor) - 6} fontSize="11" fill="var(--negative)">
        Required floor {money(Math.round(requiredFloor))}
      </text>

      <path d={line('committedBalance')} fill="none" stroke="var(--series-committed)" strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round" />
      <path d={line('balance')} fill="none" stroke="var(--series-estimate)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {trajectory.map((t, i) => (
        <circle key={i} cx={x(i)} cy={y(t.balance)} r="4" fill="var(--series-estimate)" stroke="var(--panel)" strokeWidth="2" />
      ))}

      <text x={pad.left + innerW + 8} y={yEst} fontSize="11" fill="var(--text)">With estimates</text>
      <text x={pad.left + innerW + 8} y={yCom} fontSize="11" fill="var(--text-muted)">Committed only</text>

      {trajectory.map((t, i) => (
        <g key={`m${i}`}>
          <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--text-muted)">{monthLabel(t, i)}</text>
          <rect x={x(i) - innerW / (2 * (n - 1 || 1))} y={pad.top} width={innerW / (n - 1 || 1)} height={innerH} fill="transparent">
            <title>
              {`${monthLabelFull(t)}
With estimates: ${money(Math.round(t.balance))}
Committed only: ${money(Math.round(t.committedBalance))}
Contracts +${money(Math.round(t.contractInflows))} · est. in +${money(Math.round(t.estimatedInflows))}
Bills −${money(Math.round(t.unpaidBillsDue))} · debt −${money(Math.round(t.debtServiceDue))} · fees −${money(Math.round(t.accountFees))} · est. out −${money(Math.round(t.estimatedOutflows))}`}
            </title>
          </rect>
        </g>
      ))}
    </svg>
  );
}

const emptyEstimate = {
  name: '', direction: 'outflow', amount: '', frequency: 'one_time',
  start_date: '', end_date: '', category: '', notes: '', ...emptyOwnerFields,
};

function Estimates({ onChange }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(emptyEstimate);
  const [showRetired, setShowRetired] = useState(false);
  const [error, setError] = useState(null);

  const load = () => { fetch('/api/estimates').then((r) => r.json()).then((d) => setRows(Array.isArray(d) ? d : [])); };
  useEffect(load, []);

  const act = async (url, method = 'POST') => {
    setError(null);
    const res = await fetch(url, { method });
    if (!res.ok) { const b = await res.json().catch(() => ({})); setError(b.error || `HTTP ${res.status}`); return; }
    load(); onChange();
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/estimates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        amount: Number(form.amount),
        end_date: form.frequency === 'one_time' ? null : form.end_date || null,
        ...ownerPayload(form),
      }),
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); setError(b.error || `HTTP ${res.status}`); return; }
    setForm(emptyEstimate);
    load(); onChange();
  };

  const visible = rows.filter((r) => showRetired || r.status === 'active');
  const staleCount = rows.filter((r) => r.stale).length;

  return (
    <div className="panel">
      <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span>Estimates — your own forecast inputs</span>
        <label style={{ fontSize: 11, textTransform: 'none', letterSpacing: 0, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired
        </label>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, padding: '12px 20px 0' }}>
        Estimated money in and out that isn't yet backed by a contract, bill or loan schedule. They count in
        every "with estimates" figure and never in "committed only". When a real contract or bill arrives for
        something you estimated, retire the estimate so it isn't counted twice. Dates that have passed stop
        counting automatically{staleCount ? ` — ${staleCount} estimate${staleCount > 1 ? 's are' : ' is'} stale and can be retired or re-dated` : ''}.
      </p>
      {error && <p style={{ color: 'var(--negative)', padding: '8px 20px 0', margin: 0 }}>{error}</p>}
      {visible.length === 0 ? (
        <div className="empty-state">No estimates yet.</div>
      ) : (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr><th>Name</th><th>Owner</th><th>Amount</th><th>Timing</th><th>Next 12 mo</th><th>Source</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {visible.map((e) => (
              <tr key={e.id} style={e.status === 'retired' ? { opacity: 0.5 } : undefined}>
                <td>{e.name}{e.category ? <span style={{ color: 'var(--text-faint)' }}> · {e.category}</span> : null}</td>
                <td>{ownerSummary(e)}</td>
                <td style={{ color: e.direction === 'inflow' ? 'var(--positive)' : 'var(--negative)' }}>
                  {e.direction === 'inflow' ? '+' : '−'}{money(Number(e.amount))}
                </td>
                <td>
                  {FREQ_LABELS[e.frequency]} · {String(e.start_date).slice(0, 10)}
                  {e.end_date && e.frequency !== 'one_time' ? ` → ${String(e.end_date).slice(0, 10)}` : ''}
                </td>
                <td>{e.direction === 'inflow' ? '+' : '−'}{money(e.next12_total)}</td>
                <td>{e.source === 'manual' ? '—' : e.source}</td>
                <td>
                  {e.status === 'retired'
                    ? <span className="badge">RETIRED</span>
                    : e.stale ? <span className="badge warn">STALE</span> : <span className="badge pass">ACTIVE</span>}
                </td>
                <td>
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    {e.status === 'active'
                      ? <button className="small secondary" onClick={() => act(`/api/estimates/${e.id}/retire`)}>Retire</button>
                      : <button className="small secondary" onClick={() => act(`/api/estimates/${e.id}/reactivate`)}>Reactivate</button>}
                    <button className="small secondary" onClick={() => act(`/api/estimates/${e.id}`, 'DELETE')}>Delete</button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="form-panel" onSubmit={submit} style={{ borderTop: '1px solid var(--border)', maxWidth: 'none', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        <div className="field"><label>Name</label>
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Calf sale, Hired labour" /></div>
        <div className="field"><label>Direction</label>
          <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
            <option value="outflow">Money out</option><option value="inflow">Money in</option>
          </select></div>
        <div className="field"><label>Amount (each occurrence)</label>
          <input type="number" step="0.01" min="0" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
        <div className="field"><label>Frequency</label>
          <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
            {Object.entries(FREQ_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>
        <div className="field"><label>{form.frequency === 'one_time' ? 'Date' : 'First occurrence'}</label>
          <input type="date" required value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></div>
        {form.frequency !== 'one_time' && (
          <div className="field"><label>Last occurrence (optional)</label>
            <input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></div>
        )}
        <div className="field"><label>Category (optional)</label>
          <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. Feed, Fuel, Wages" /></div>
        <OwnerFields state={form} setState={setForm} />
        <div className="field" style={{ alignSelf: 'end' }}><button type="submit">Add estimate</button></div>
      </form>
    </div>
  );
}

export default function CashFlow() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    fetch('/api/dashboard')
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok || !body || !body.liquidity) throw new Error((body && body.error) || `Server returned ${r.status}`);
        return body;
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [refresh]);

  if (error) return <div className="empty-state">Could not load forecast: {error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  const { trajectory, floorMonth, committedFloorMonth, requiredFloor, bufferPct, startingBalance, passes } = data.liquidity;
  const end = trajectory[trajectory.length - 1];
  const estGap = end.balance - end.committedBalance;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Cash Flow</h1>
        <span className="page-meta">Business accounts · rolling 12 months, {monthLabelFull(trajectory[0])} – {monthLabelFull(end)}</span>
      </div>

      <div className="grid">
        <MetricCard
          label="Lowest point — with estimates"
          value={money(floorMonth.balance)}
          sub={`${monthLabelFull(floorMonth)} · this is what gates purchases`}
          tone={passes ? 'positive' : 'negative'}
        />
        <MetricCard
          label="Lowest point — committed only"
          value={money(committedFloorMonth.balance)}
          sub={`${monthLabelFull(committedFloorMonth)} · documented flows alone`}
          tone={committedFloorMonth.balance >= requiredFloor ? undefined : 'negative'}
        />
        <MetricCard label="Required floor" value={money(requiredFloor)} sub={`${pct(bufferPct)} buffer on trailing-12-month avg expenses`} />
        <MetricCard label="Balance today" value={money(startingBalance)} sub="Business operating accounts, live" />
        <MetricCard
          label="Riding on estimates"
          value={`${estGap >= 0 ? '+' : '−'}${money(Math.abs(Math.round(estGap)))}`}
          sub={`By ${monthLabelFull(end)}: the gap between the two lines`}
        />
      </div>

      <div className="panel">
        <div className="panel-header">Projected business cash — next 12 months</div>
        <div style={{ padding: '14px 20px 0', display: 'flex', gap: 18, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" stroke="var(--series-estimate)" strokeWidth="2" /></svg>
            With estimates (default)
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <svg width="22" height="8" aria-hidden="true"><line x1="0" x2="22" y1="4" y2="4" stroke="var(--series-committed)" strokeWidth="2" strokeDasharray="6 4" /></svg>
            Committed only
          </span>
        </div>
        <div style={{ padding: '4px 12px 0' }}><ForecastChart trajectory={trajectory} requiredFloor={requiredFloor} /></div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, padding: '10px 20px 16px' }}>
          Both lines start from today's live balance. Committed only: contracts, unpaid bills, scheduled loan
          payments and fees. With estimates: the same plus your estimated money in and out. A large balance
          before a long stretch of estimated costs with no committed income isn't spendable — the lowest point
          of the estimates line is what the Purchase Evaluator gates on.
        </p>
      </div>

      <div className="panel">
        <div className="panel-header">Month by month</div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Month</th><th>Contracts</th><th>Est. in</th><th>Bills</th><th>Debt service</th><th>Fees</th><th>Est. out</th>
                <th>Committed bal.</th><th>With estimates</th>
              </tr>
            </thead>
            <tbody>
              {trajectory.map((t) => {
                const isFloor = t.month === floorMonth.month && t.year === floorMonth.year;
                const v = (n, sign) => (n ? `${sign}${money(Math.round(n))}` : '—');
                return (
                  <tr key={`${t.year}-${t.month}`} style={isFloor ? { background: 'var(--panel-hover)' } : undefined}>
                    <td>{monthLabelFull(t)}{isFloor && <> <span className={`badge ${passes ? 'warn' : 'fail'}`}>FLOOR</span></>}</td>
                    <td>{v(t.contractInflows, '+')}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{v(t.estimatedInflows, '+')}</td>
                    <td>{v(t.unpaidBillsDue, '−')}</td>
                    <td>{v(t.debtServiceDue, '−')}</td>
                    <td>{v(t.accountFees, '−')}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{v(t.estimatedOutflows, '−')}</td>
                    <td style={t.committedBalance < requiredFloor ? { color: 'var(--negative)' } : undefined}>{money(Math.round(t.committedBalance))}</td>
                    <td style={t.balance < requiredFloor ? { color: 'var(--negative)' } : { fontWeight: 500 }}>{money(Math.round(t.balance))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Estimates onChange={() => setRefresh((n) => n + 1)} />
    </>
  );
}
