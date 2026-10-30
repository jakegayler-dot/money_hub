import { Fragment, useEffect, useRef, useState } from 'react';
import CashFlowTerminal from '../components/CashFlowTerminal.jsx';
import WhatIf from '../components/WhatIf.jsx';
import MonthBreakdown from '../components/MonthBreakdown.jsx';
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

// Whose money (Jake, 2026-10-24: one owner at a time too). Household spending in Jake's and Ashley's views is
// split by who actually spends it; what the farm pays for them (a card paid from a farm account) stays out.
const SCOPES = [['everything', 'Everything'], ['farm', 'Farm'], ['grain', 'Grain'], ['livestock', 'Cattle'], ['personal', 'Personal'], ['jake', 'Jake'], ['ashley', 'Ashley']];
const SCOPE_META = {
  everything: 'All money, farm and personal', farm: 'Farm money — Grain and Cattle', personal: 'Personal money — Jake and Ashley',
  grain: 'Grain — its accounts and flows, plus its share of farm-wide GST and tax',
  livestock: 'Cattle — its accounts and flows, plus its share of farm-wide GST and tax',
  jake: 'Jake — his accounts, what\'s tagged to him and his share of household spending',
  ashley: 'Ashley — her accounts, her pay, what\'s tagged to her and her share of household spending',
};
const readPref = (k, d) => { try { const v = window.localStorage.getItem(`moneyhub.cf.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
const writePref = (k, v) => { try { window.localStorage.setItem(`moneyhub.cf.${k}`, JSON.stringify(v)); } catch { /* private mode */ } };

/** The most the cash floor can be (Jake, Oct 27): payments are already taken off month by month, so the floor is a cushion. */
function FloorCap({ value, onSaved }) {
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState(null);
  if (value == null) return null;
  const save = async () => {
    const r = await fetch('/api/forecast/floor-cap', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cap: Number(edit) }) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); setErr(d.error || 'Not saved'); return; }
    setEdit(null); setErr(null); onSaved();
  };
  return edit == null ? (
    <button type="button" className="cf-floorcap" title="The cash floor is what falls due in the next 60 days, never more than this" onClick={() => setEdit(String(value))}>
      Floor up to {money(value)}
    </button>
  ) : (
    <span className="cf-floorcap-edit">
      <label>Floor up to $<input type="number" min="0" step="1000" value={edit} aria-label="Most the cash floor can be" onChange={(e) => setEdit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} /></label>
      <button type="button" className="small" onClick={save}>Save</button>
      <button type="button" className="small-link" onClick={() => setEdit(null)}>Cancel</button>
      {err && <span className="review-error">{err}</span>}
    </span>
  );
}

/** Which accounts count toward the starting cash. */
function AccountPicker({ accounts, chosen, setChosen }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const all = accounts.map((a) => a.id);
  const on = chosen || all;
  const toggle = (id) => {
    const next = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
    setChosen(next.length === all.length ? null : next);
  };
  return (
    <div className="cf-accounts" ref={ref}>
      <button type="button" className="small secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        Accounts · {on.length === all.length ? 'all' : `${on.length} of ${all.length}`}
      </button>
      {open && (
        <div className="cf-accounts-pop" role="dialog" aria-label="Accounts in the starting cash">
          {accounts.map((a) => (
            <label key={a.id} className="cf-acct">
              <input type="checkbox" checked={on.includes(a.id)} onChange={() => toggle(a.id)} />
              <span>{a.name}<em>{a.farm >= 0.995 ? 'Farm' : a.farm <= 0.005 ? 'Personal' : `${Math.round(a.farm * 100)}% farm`}</em></span>
              <b>{money(a.balance)}</b>
            </label>
          ))}
          {chosen && <button type="button" className="small-link" onClick={() => setChosen(null)}>Use every account</button>}
        </div>
      )}
    </div>
  );
}

// The crop year being marketed ends next calendar year's August: from September
// that's this crop's end; before September it's the crop still to be harvested.
const CROP_END = new Date().getFullYear() + 1;

export default function CashFlow() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [scope, setScope] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('scope');
    return SCOPES.some(([k]) => k === q) ? q : readPref('scope', 'everything');
  });
  const [months, setMonths] = useState(() => readPref('months', 12));
  // Off by default; the old saved choice ('tax') is ignored so everyone starts without tax predictions.
  const [includeTax, setIncludeTax] = useState(() => readPref('taxOn', false));
  const [chosen, setChosen] = useState(() => readPref('accounts', null));
  const [whatIf, setWhatIf] = useState(() => readPref('whatif', null)); // { scenario, name, id } shown on the chart
  const [whatIfResult, setWhatIfResult] = useState(null);
  const [openMonth, setOpenMonth] = useState(null); // "2026-11" while its breakdown is open
  const [editing, setEditing] = useState(false);

  // /cash-flow?whatif=<saved id> opens that what-if (Sentinel links here
  // after saving a purchase check); ?whatif=new opens a blank one.
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get('whatif');
    if (!want) return;
    window.history.replaceState(null, '', '/cash-flow');
    if (want === 'new') { setEditing(true); return; }
    fetch('/api/forecast/scenarios').then((r) => r.json()).then((list) => {
      const s = (Array.isArray(list) ? list : []).find((x) => String(x.id) === want);
      if (s) { setWhatIf({ scenario: s.data || {}, name: s.name, id: s.id }); setEditing(true); }
    }).catch(() => {});
  }, []);

  useEffect(() => { writePref('scope', scope); writePref('months', months); writePref('taxOn', includeTax); writePref('accounts', chosen); writePref('whatif', whatIf); },
    [scope, months, includeTax, chosen, whatIf]);

  const query = () => {
    const q = new URLSearchParams({ scope, months: String(months), tax: includeTax ? '1' : '0' });
    if (chosen) q.set('accounts', chosen.join(','));
    return q;
  };
  useEffect(() => {
    fetch(`/api/forecast?${query()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok || !body || !body.trajectory) throw new Error((body && body.error) || `Server returned ${r.status}`);
        return body;
      })
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message));
  }, [refresh, scope, months, includeTax, (chosen || []).join(',')]);

  // The what-if on the chart, re-run for the current view.
  useEffect(() => {
    if (!whatIf) { setWhatIfResult(null); return; }
    fetch('/api/forecast/scenario', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: whatIf.scenario, months, scope, accounts: chosen, tax: includeTax ? 1 : 0 }),
    }).then((r) => r.json()).then((d) => setWhatIfResult(d.error ? null : d)).catch(() => setWhatIfResult(null));
  }, [whatIf, refresh, scope, months, includeTax, (chosen || []).join(',')]);

  if (error) return <div className="empty-state">Could not load forecast: {error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  const { trajectory, floorMonth, requiredFloor, startingBalance, passes, accounts = [] } = data;
  const floorOf = (t) => t.floor ?? requiredFloor;
  const end = trajectory[trajectory.length - 1];
  const options = { months, scope, accounts: chosen, includeTax };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Cash Flow</h1>
        <span className="page-meta">{SCOPE_META[scope]} · {monthLabelFull(trajectory[0])} – {monthLabelFull(end)}</span>
      </div>

      <div className="cf-controls">
        <span className="seg-toggle" role="group" aria-label="Whose money">
          {SCOPES.map(([k, l]) => <button key={k} type="button" aria-pressed={scope === k} className={scope === k ? 'on' : ''} onClick={() => setScope(k)}>{l}</button>)}
        </span>
        <span className="seg-toggle" role="group" aria-label="Months ahead">
          {[12, 18, 24].map((m) => <button key={m} type="button" aria-pressed={months === m} className={months === m ? 'on' : ''} onClick={() => setMonths(m)}>{m} months</button>)}
          <button type="button" aria-pressed={months === 'crop'} className={months === 'crop' ? 'on' : ''} onClick={() => setMonths('crop')}
            title="Through the end of the crop year being marketed (Sep to Aug)">To Aug {CROP_END}</button>
        </span>
        <label className="cf-switch">
          <input type="checkbox" checked={includeTax} onChange={(e) => setIncludeTax(e.target.checked)} />
          <span>Income tax</span>
        </label>
        <AccountPicker accounts={accounts} chosen={chosen} setChosen={setChosen} />
        <FloorCap value={data.floorCap} onSaved={() => setRefresh((k) => k + 1)} />
        <button type="button" className="cf-whatif-btn" onClick={() => setEditing(true)}>What-if analysis</button>
      </div>

      {data.personal && scope !== 'farm' && (
        data.personal.shortfall ? (
          <p className="pace-warn" role="status">
            No room for household spending: even with none, cash falls {money(Math.round(data.personal.shortfall.amount))} below the floor. <a href="/personal">See Personal</a>
          </p>
        ) : (
          <p className="cf-budget-note">
            Household spending is one budget: {money(data.personal.per_month)} a month, {Math.round(data.personal.share * 100)}% of the room above the cash floor, on top of the bills. <a href="/personal">See the budget</a>
          </p>
        )
      )}
      <CashFlowTerminal liquidity={data} scenario={whatIfResult} scenarioName={whatIf?.name}
        onOpenWhatIf={() => setEditing(true)} onClearScenario={() => setWhatIf(null)} />

      {editing && (
        <WhatIf options={options} initial={whatIf} onClose={() => setEditing(false)}
          onShow={(w) => { setWhatIf(w); setEditing(false); }} />
      )}

      <div className="panel">
        <div className="panel-header spend-header"><span>Month by month</span><span className="split-lines">Click a month for everything behind it</span></div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Month</th><th>Contracts</th><th>Est. in</th><th>Bills</th><th>Debt service</th><th>Cards</th><th>Fees</th><th>GST</th><th>Tax</th><th>Personal</th><th>Est. out</th>
                <th>Committed bal.</th><th>With estimates</th><th title={`What must be paid in the ${data.floorDays || 60} days after the month-end${data.floorCap != null ? `, up to ${money(data.floorCap)}` : ''}`}>Floor</th>
              </tr>
            </thead>
            <tbody>
              {trajectory.map((t) => {
                const isFloor = t.month === floorMonth.month && t.year === floorMonth.year;
                const v = (num, sign) => (num ? `${sign}${money(Math.round(num))}` : '—');
                const key = `${t.year}-${t.month}`;
                const isOpen = openMonth === key;
                return (
                  <Fragment key={key}>
                  <tr className={`cf-month-row${isOpen ? ' open' : ''}`} style={isFloor ? { background: 'var(--panel-hover)' } : undefined}
                    onClick={() => setOpenMonth(isOpen ? null : key)} tabIndex={0} aria-expanded={isOpen}
                    onKeyDown={(e) => { if (e.key === 'Enter') setOpenMonth(isOpen ? null : key); }}>
                    <td><span className="cf-month-chev" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>{monthLabelFull(t)}{isFloor && <> <span className={`badge ${passes ? 'warn' : 'fail'}`} title="Least cash over the floor">TIGHTEST</span></>}</td>
                    <td>{v(t.contractInflows, '+')}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{v(t.estimatedInflows, '+')}</td>
                    <td>{v(t.unpaidBillsDue, '−')}</td>
                    <td>{v(t.debtServiceDue, '−')}</td>
                    <td>{v(t.creditCardDue, '−')}</td>
                    <td>{v(t.accountFees, '−')}</td>
                    <td>{t.gst ? `${t.gst > 0 ? '+' : '−'}${money(Math.abs(Math.round(t.gst)))}` : '—'}</td>
                    <td>{v(t.taxInstalment, '−')}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{v(t.personalSpending, '−')}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{v(t.estimatedOutflows, '−')}</td>
                    <td style={t.committedBalance < floorOf(t) ? { color: 'var(--negative)' } : undefined}>{money(Math.round(t.committedBalance))}</td>
                    <td style={t.balance < floorOf(t) ? { color: 'var(--negative)' } : { fontWeight: 500 }}>{money(Math.round(t.balance))}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{money(Math.round(floorOf(t)))}</td>
                  </tr>
                  {isOpen && (
                    <tr className="cf-month-detail"><td colSpan={14}><MonthBreakdown m={t} floor={floorOf(t)} floorDays={data.floorDays || 60} /></td></tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">Cash the forecast starts from</div>
        <table>
          <thead><tr><th>Account</th><th>Owner</th><th>Balance today</th><th>Counted</th></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} style={!a.included ? { opacity: 0.45 } : undefined}>
                <td>{a.name}<div className="split-lines">{a.type}</div></td>
                <td>{a.farm >= 0.995 ? 'Farm' : a.farm <= 0.005 ? 'Personal' : `${Math.round(a.farm * 100)}% farm`}</td>
                <td className="nowrap" style={a.balance < 0 ? { color: 'var(--negative)' } : undefined}>{money(a.balance)}</td>
                <td className="nowrap">{a.included ? money(a.counted) : 'left out'}</td>
              </tr>
            ))}
            <tr><td colSpan={3} style={{ fontWeight: 600 }}>Starting cash</td><td className="nowrap" style={{ fontWeight: 600 }}>{money(startingBalance)}</td></tr>
          </tbody>
        </table>
      </div>

      <Estimates onChange={() => setRefresh((x) => x + 1)} />
    </>
  );
}
