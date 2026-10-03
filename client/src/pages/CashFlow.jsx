import { useEffect, useState } from 'react';
import CashFlowTerminal from '../components/CashFlowTerminal.jsx';
import { money } from '../format.js';
import { OwnerFields, ownerPayload, ownerSummary, emptyOwnerFields } from '../owners.jsx';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (t, i) =>
  i === 0 || t.month === 1 ? `${MONTH_NAMES[t.month - 1]} ’${String(t.year).slice(2)}` : MONTH_NAMES[t.month - 1];
const monthLabelFull = (t) => `${MONTH_NAMES[t.month - 1]} ${t.year}`;
const FREQ_LABELS = { one_time: 'One-time', monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual' };

const emptyEstimate = {
  name: '', direction: 'outflow', amount: '', frequency: 'one_time',
  start_date: '', end_date: '', category: '', notes: '', ...emptyOwnerFields,
};

function Estimates({ onChange }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(emptyEstimate);
  const [showRetired, setShowRetired] = useState(false);
  const [error, setError] = useState(null);

  const [fromInv, setFromInv] = useState(null);
  const load = () => {
    fetch('/api/estimates').then((r) => r.json()).then((d) => setRows(Array.isArray(d) ? d : []));
    fetch('/api/estimates/from-inventory').then((r) => r.json()).then(setFromInv).catch(() => setFromInv(null));
  };
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
            <tr><th>Name</th><th>Owner</th><th>Amount</th><th>Timing</th><th>Next 12 mo</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {visible.map((e) => (
              <tr key={e.id} style={e.status === 'retired' ? { opacity: 0.5 } : undefined}>
                <td>
                  {e.name}{e.category ? <span style={{ color: 'var(--text-faint)' }}> · {e.category}</span> : null}
                  {e.source !== 'manual' && <div className="split-lines">via {e.source}</div>}
                </td>
                <td>{ownerSummary(e)}</td>
                <td style={{ color: e.direction === 'inflow' ? 'var(--positive)' : 'var(--negative)' }}>
                  {e.direction === 'inflow' ? '+' : '−'}{money(Number(e.amount))}
                </td>
                <td>
                  {FREQ_LABELS[e.frequency]} · {String(e.start_date).slice(0, 10)}
                  {e.end_date && e.frequency !== 'one_time' ? ` → ${String(e.end_date).slice(0, 10)}` : ''}
                </td>
                <td>{e.direction === 'inflow' ? '+' : '−'}{money(e.next12_total)}</td>
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

      {fromInv && (fromInv.items.length > 0 || fromInv.undated.length > 0) && (
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, padding: '12px 20px 0' }}>
            <strong style={{ color: 'var(--text)' }}>From inventory — automatic.</strong> Uncontracted grain in the bins and
            market cattle on hand, at the managers' prices, forecast to sell on the date shown. Contracted grain isn't
            here — it's in the forecast as its contract. Change these in the managers or on the Assets tab, not here.
          </p>
          {fromInv.items.length > 0 && (
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Item</th><th>Owner</th><th>Amount</th><th>Sells</th><th>Date from</th></tr></thead>
              <tbody>
                {fromInv.items.map((e) => (
                  <tr key={e.id}>
                    <td>{e.name}</td>
                    <td>{ownerSummary(e)}</td>
                    <td style={{ color: 'var(--positive)' }}>+{money(Number(e.amount))}</td>
                    <td>{e.start_date}</td>
                    <td style={{ color: 'var(--text-muted)' }}>
                      {e.basis === 'item' ? `${e.source} date` : e.basis === 'crop estimate' ? "the crop's estimate" : 'fallback sell-by date'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {fromInv.undated.length > 0 && (
            <p style={{ fontSize: 12, color: 'var(--negative)', margin: 0, padding: '10px 20px 0' }}>
              {fromInv.undated.length} item{fromInv.undated.length > 1 ? 's' : ''} ({money(fromInv.undated.reduce((t, u) => t + u.amount, 0))})
              {' '}left out of the forecast — no sale date. Set a fallback sell-by date on the Assets tab.
            </p>
          )}
        </div>
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

  const { trajectory, floorMonth, requiredFloor, startingBalance, passes, accounts = [] } = data.liquidity;
  const end = trajectory[trajectory.length - 1];

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Cash Flow</h1>
        <span className="page-meta">All accounts, farm and personal · rolling 12 months, {monthLabelFull(trajectory[0])} – {monthLabelFull(end)}</span>
      </div>

      <CashFlowTerminal liquidity={data.liquidity} />

      <div className="panel">
        <div className="panel-header">Month by month</div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Month</th><th>Contracts</th><th>Est. in</th><th>Bills</th><th>Debt service</th><th>Cards</th><th>Fees</th><th>Tax</th><th>Est. out</th>
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
                    <td>{v(t.creditCardDue, '−')}</td>
                    <td>{v(t.accountFees, '−')}</td>
                    <td>{v(t.taxInstalment, '−')}</td>
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

      <div className="panel">
        <div className="panel-header">Accounts in the starting balance</div>
        <table>
          <thead><tr><th>Account</th><th>Ledger</th><th>Type</th><th>Balance today</th></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>{a.ledger}</td>
                <td>{a.type}</td>
                <td className="nowrap" style={a.balance < 0 ? { color: 'var(--negative)' } : undefined}>{money(a.balance)}</td>
              </tr>
            ))}
            <tr><td colSpan={3} style={{ fontWeight: 600 }}>Total</td><td className="nowrap" style={{ fontWeight: 600 }}>{money(startingBalance)}</td></tr>
          </tbody>
        </table>
      </div>

      <Estimates onChange={() => setRefresh((n) => n + 1)} />
    </>
  );
}
