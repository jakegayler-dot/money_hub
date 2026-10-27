import { useEffect, useMemo, useState } from 'react';
import { money } from '../format.js';
import { SERIES } from '../chartColors.js';

// Long-term goals (Jake, 2026-10-26): a tractor, a diesel truck, a piece of
// land — and when each can be bought, judged the way a farm lender would:
// the cash floor holds for two years after, the reserve is kept, debt
// coverage is 1.25× or more, and 15% or more is your own money down.
// Pick one goal, several (bought in the order shown) or all of them.

const blank = { name: '', kind: 'tractor', price: '', trade_in: '', fees: '', funding: 'financed', down_pct: '25', rate: '7', years: '7', per_year: '1',
  gst_pct: '', pst_pct: '', cca_rate: '', owner: 'farm', want_by: '', notes: '' };
const send = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => { const d = r.status === 204 ? {} : await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; });
const PER = { 1: 'yearly', 2: 'twice a year', 4: 'quarterly', 12: 'monthly' };

function GoalForm({ initial, kinds, onSaved, onCancel }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState(null);
  const d = kinds[f.kind] || kinds.other;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    const body = { ...f };
    for (const k of ['gst_pct', 'pst_pct', 'cca_rate', 'trade_in', 'fees']) if (body[k] === '') body[k] = null;
    (f.id ? send('PATCH', `/api/goals/${f.id}`, body) : send('POST', '/api/goals', body)).then(onSaved).catch((e) => setErr(e.message));
  };
  return (
    <div className="panel">
      <div className="panel-header">{f.id ? `Edit ${f.name}` : 'New goal'}</div>
      <div className="fd-grid" style={{ padding: 16 }}>
        <div className="field"><label>What</label><input value={f.name} onChange={set('name')} placeholder="e.g. JD 8R 410, 2024 F-350 diesel, NE 14 quarter" /></div>
        <div className="field"><label>Kind</label>
          <select value={f.kind} onChange={set('kind')}>{Object.entries(kinds).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
        <div className="field"><label>Price (before taxes)</label><input type="number" min="0" step="100" value={f.price} onChange={set('price')} /></div>
        <div className="field"><label>Trade-in (optional)</label><input type="number" min="0" step="100" value={f.trade_in ?? ''} onChange={set('trade_in')} /></div>
        <div className="field"><label>Paid for with</label>
          <span className="seg-toggle" role="group" aria-label="Funding">
            {[['financed', 'Down payment + loan'], ['cash', 'Cash']].map(([k, l]) => <button key={k} type="button" aria-pressed={f.funding === k} className={f.funding === k ? 'on' : ''} onClick={() => setF({ ...f, funding: k })}>{l}</button>)}
          </span></div>
        {f.funding === 'financed' && (
          <>
            <div className="field"><label>Down payment %</label><input type="number" min="0" max="100" step="1" value={f.down_pct} onChange={set('down_pct')} /></div>
            <div className="field"><label>Interest rate %</label><input type="number" min="0" step="0.05" value={f.rate} onChange={set('rate')} /></div>
            <div className="field"><label>Term (years)</label><input type="number" min="0.5" step="0.5" value={f.years} onChange={set('years')} /></div>
            <div className="field"><label>Payments</label>
              <select value={f.per_year} onChange={set('per_year')}>{Object.entries(PER).map(([k, l]) => <option key={k} value={k}>{l[0].toUpperCase() + l.slice(1)}</option>)}</select></div>
          </>
        )}
        <div className="field"><label>Whose</label>
          <select value={f.owner} onChange={set('owner')}><option value="farm">Farm</option><option value="personal">Personal</option></select></div>
        <div className="field"><label>Want it by (optional)</label><input type="date" value={f.want_by || ''} onChange={set('want_by')} /></div>
        <div className="field"><label>GST %</label><input type="number" min="0" step="0.5" placeholder={String(d.gst_pct)} value={f.gst_pct ?? ''} onChange={set('gst_pct')} /></div>
        <div className="field"><label>PST %</label><input type="number" min="0" step="0.5" placeholder={String(d.pst_pct)} value={f.pst_pct ?? ''} onChange={set('pst_pct')} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Notes (optional)</label><input value={f.notes || ''} onChange={set('notes')} /></div>
      </div>
      <p className="field-hint" style={{ margin: '-6px 16px 10px' }}>GST and PST blank: the usual for a {d.label.toLowerCase()} ({d.gst_pct}% GST, {d.pst_pct}% PST). A farm purchase gets its GST back about three months later.</p>
      {err && <p className="review-error" style={{ margin: '0 16px 8px' }}>{err}</p>}
      <div style={{ padding: '0 16px 16px', display: 'flex', gap: 8 }}>
        <button type="button" className="small" onClick={save}>{f.id ? 'Save changes' : 'Add goal'}</button>
        <button type="button" className="small secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Cash above the floor at each month-end for ten years, with the goals bought where planned; the reserve as a line. */
function PathChart({ months, reserve, marks }) {
  const [hover, setHover] = useState(null);
  const W = 900; const H = 230; const P = { l: 64, r: 12, t: 14, b: 26 };
  const vals = months.map((m) => m.headroom);
  const max = Math.max(reserve, ...vals, 1); const min = Math.min(0, ...vals);
  const x = (i) => P.l + (i / (months.length - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + ((max - v) / (max - min || 1)) * (H - P.t - P.b);
  const path = months.map((m, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(m.headroom).toFixed(1)}`).join(' ');
  const years = months.map((m, i) => [m, i]).filter(([m]) => m.month.startsWith('Jan'));
  const h = hover != null ? months[hover] : null;
  return (
    <div className="gl-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cash above the floor at each month-end over ten years, with the goals bought"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; setHover(Math.max(0, Math.min(months.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (months.length - 1))))); }}>
        {[min, 0, max].filter((v, i, a) => a.indexOf(v) === i).map((v) => (
          <g key={v}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--border-strong)' : 'var(--border)'} />
            <text x={P.l - 6} y={y(v) + 4} textAnchor="end" className="pp-axis">{money(v)}</text></g>
        ))}
        {reserve > 0 && <><line x1={P.l} x2={W - P.r} y1={y(reserve)} y2={y(reserve)} stroke="var(--gold)" strokeDasharray="6 4" strokeWidth="1.5" />
          <text x={W - P.r} y={y(reserve) - 5} textAnchor="end" className="pp-axis">reserve {money(reserve)}</text></>}
        {years.map(([m, i]) => <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className="pp-axis">{m.month.slice(-4)}</text>)}
        {marks.map((g, k) => (
          <g key={g.id}>
            <line x1={x(g.i)} x2={x(g.i)} y1={P.t} y2={H - P.b} stroke={SERIES[(k + 1) % SERIES.length]} strokeWidth="1.5" />
            <text x={x(g.i) > W - 160 ? x(g.i) - 4 : x(g.i) + 4} textAnchor={x(g.i) > W - 160 ? 'end' : 'start'} y={P.t + 12 + k * 13} className="gl-mark" fill={SERIES[(k + 1) % SERIES.length]}>{g.name}</text>
          </g>
        ))}
        <path d={path} fill="none" stroke={SERIES[0]} strokeWidth="2" />
        {h && <><line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} stroke="var(--text-faint)" />
          <circle cx={x(hover)} cy={y(h.headroom)} r="4" fill={SERIES[0]} stroke="var(--panel)" strokeWidth="2" /></>}
      </svg>
      <div className="gl-tip">{h ? `${h.month}: cash ${money(h.balance)}, floor ${money(h.floor)} — ${money(h.headroom)} above it` : 'Point at the line for any month.'}</div>
    </div>
  );
}

export default function Goals() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [picked, setPicked] = useState(null); // ids in order
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const load = () => fetch('/api/goals').then((r) => r.json()).then((d) => {
    setData(d);
    const active = d.goals.filter((g) => g.status === 'active').map((g) => g.id);
    setPicked((p) => (p == null ? active : p.filter((id) => active.includes(id))));
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const key = (picked || []).join(',');
  useEffect(() => {
    if (picked == null) return;
    if (!picked.length) { setPlan(null); return; }
    setBusy(true);
    fetch(`/api/goals/plan?ids=${key}`).then((r) => r.json()).then((d) => { if (d.error) setErr(d.error); else setPlan(d); }).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  }, [key, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const goals = data?.goals || [];
  const active = goals.filter((g) => g.status === 'active');
  const byId = useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals]);
  if (!data) return err ? <div className="empty-state">{err}</div> : <div className="empty-state">Loading…</div>;

  const move = async (id, dir) => {
    const order = active.map((g) => g.id);
    const i = order.indexOf(id); const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await send('PUT', '/api/goals/order', { ids: order });
    setPicked((p) => order.filter((x) => p.includes(x)));
    load();
  };
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : active.map((g) => g.id).filter((x) => x === id || p.includes(x))));
  const marks = (plan?.goals || []).filter((g) => g.months != null).map((g) => ({ id: g.id, name: g.name, i: g.months }));

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Goals</h1>
        <button type="button" className="small" style={{ marginLeft: 'auto' }} onClick={() => setForm({ ...blank })}>New goal</button>
      </div>
      {err && <p className="review-error" style={{ margin: '0 0 12px' }}>{err}</p>}
      {form && <GoalForm key={form.id || 'new'} initial={form} kinds={data.kinds} onCancel={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}

      <div className="panel">
        <div className="panel-header spend-header">
          <span>Your goals</span>
          {active.length > 1 && (
            <span className="seg-toggle" role="group" aria-label="Which to plan">
              <button type="button" className={picked?.length === active.length ? 'on' : ''} onClick={() => setPicked(active.map((g) => g.id))}>All together</button>
              <button type="button" className={picked?.length === 0 ? 'on' : ''} onClick={() => setPicked([])}>None</button>
            </span>
          )}
        </div>
        {goals.length === 0 ? (
          <div className="empty-state">Add what you're working toward — a tractor, a diesel truck, a piece of land — and it works out when each can be bought, and what has to happen first.</div>
        ) : (
          <table className="gl-list">
            <thead><tr><th>Plan</th><th>Order</th><th>Goal</th><th className="num">Price</th><th>Paid for with</th><th>Want by</th><th /></tr></thead>
            <tbody>
              {goals.map((g) => {
                const on = g.status === 'active';
                return (
                  <tr key={g.id} className={on ? '' : 'fd-void'}>
                    <td>{on && <input type="checkbox" aria-label={`Plan ${g.name}`} checked={picked?.includes(g.id) || false} onChange={() => toggle(g.id)} />}</td>
                    <td>{on && <span className="gl-order"><button type="button" className="small-link" aria-label="Earlier" onClick={() => move(g.id, -1)}>↑</button><button type="button" className="small-link" aria-label="Later" onClick={() => move(g.id, 1)}>↓</button></span>}</td>
                    <td><b>{g.name}</b><div className="split-lines">{data.kinds[g.kind]?.label}{g.owner === 'personal' ? ' · personal' : ''}{g.status !== 'active' ? ` · ${g.status}` : ''}</div></td>
                    <td className="num">{money(g.price)}{g.trade_in > 0 && <div className="split-lines">less {money(g.trade_in)} trade</div>}</td>
                    <td>{g.funding === 'cash' ? 'Cash' : `${g.down_pct}% down, ${g.rate}% over ${g.years} yrs, ${PER[g.per_year]}`}</td>
                    <td>{g.want_by || '—'}</td>
                    <td className="fd-acts">
                      <button type="button" className="small-link" onClick={() => setForm({ ...blank, ...Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v == null ? '' : String(v)])), id: g.id })}>Edit</button>
                      {on && <button type="button" className="small-link" onClick={() => send('PATCH', `/api/goals/${g.id}`, { status: 'bought' }).then(load)}>Bought</button>}
                      {on ? <button type="button" className="small-link" onClick={() => send('PATCH', `/api/goals/${g.id}`, { status: 'dropped' }).then(load)}>Shelve</button>
                        : <button type="button" className="small-link" onClick={() => send('PATCH', `/api/goals/${g.id}`, { status: 'active' }).then(load)}>Back on</button>}
                      <button type="button" className="small-link" onClick={() => { if (window.confirm(`Delete ${g.name}?`)) send('DELETE', `/api/goals/${g.id}`).then(load); }}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {picked?.length > 1 && <p className="field-hint" style={{ margin: '8px 16px 12px' }}>Planned in the order shown: each is bought no earlier than the one above it, with that one's down payment and payments counted.</p>}
      </div>

      {busy && !plan && <div className="empty-state">Working it out…</div>}
      {plan && plan.goals.length > 0 && (
        <>
          {plan.short_without_goals && (
            <p className="pace-warn">Even with no goals bought, cash falls {money(-plan.short_without_goals.amount)} below the floor around {plan.short_without_goals.month} — a loan payment or bill that the years ahead can't cover as they stand. Goals are judged on not making that worse; sort that one out on Cash Flow or Loans.</p>
          )}
          {plan.goals.map((g) => {
            const goal = byId.get(g.id);
            return (
              <div className="panel gl-goal" key={g.id}>
                <div className="gl-head">
                  <div>
                    <div className="gl-name">{g.name}</div>
                    <div className="split-lines">{money(g.terms.total_cost)} with taxes{g.terms.financed > 0 ? ` · ${money(g.terms.cash_up_front)} down, ${money(g.terms.financed)} borrowed at ${money(g.terms.payment)} ${PER[g.terms.per_year]}` : ' · paid in cash'}</div>
                  </div>
                  <div className={`gl-when${g.months == null ? ' neg' : ''}`}>
                    <span>{g.when || 'Not in 10 years'}</span>
                    <small>{g.months == null ? 'as things stand' : g.months === 0 ? 'now' : `in ${g.wait}`}</small>
                  </div>
                </div>
                <p className="gl-headline">{g.headline}</p>
                {g.late && <p className="pace-warn">That's later than {goal?.want_by}, when you want it by.</p>}
                <ul className="gl-conds">
                  {g.conditions.map((c) => (
                    <li key={c.id} className={c.na ? 'na' : c.ok ? 'ok' : 'no'}>
                      <span className="gl-mark-icon" aria-hidden="true">{c.na ? '–' : c.ok ? '✓' : '✗'}</span>
                      <span><b>{c.label}</b> {c.detail}</span>
                    </li>
                  ))}
                </ul>
                {g.holding.length > 0 && (
                  <div className="gl-holding">
                    <div className="split-lines">What has to change from today</div>
                    <ul>{g.holding.map((h) => <li key={h.id}>{h.text[0].toUpperCase() + h.text.slice(1)}.</li>)}</ul>
                  </div>
                )}
                {plan.alternatives.length > 0 && (
                  <div className="gl-alt">
                    <span className="split-lines">If the household spent less than {money(plan.budget.per_month)} a month:</span>
                    {plan.alternatives.map((a) => {
                      const x = a.goals.find((y) => y.id === g.id);
                      return <span key={a.share} className="gl-alt-item">{money(a.per_month)}/mo → <b>{x?.when || 'not in 10 yrs'}</b></span>;
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <div className="panel">
            <div className="panel-header">Cash above the floor, next ten years{plan.goals.length > 1 ? ', with these bought' : ', with it bought'}</div>
            <PathChart months={plan.months} reserve={plan.reserve} marks={marks} />
            <p style={{ padding: '0 16px 14px', margin: 0 }} className="split-lines">
              The next 12 months are Cash Flow's forecast; after that each year repeats it — same income, costs and bills — while loan payments follow their
              schedules as loans pay down. A one-off this year (a big sale, a lump payment) repeats too, so check the first year looks typical.
              Household spending is held at {money(plan.budget.per_month)} a month: {Math.round(plan.budget.share * 100)}% of what a normal year leaves after bills,
              loans and the farm{plan.budget.cash_flow_budget > plan.budget.per_month + 5 ? ` (Cash Flow's budget is ${money(plan.budget.cash_flow_budget)} this year because it also spends the cash on hand — here that cash goes to the goals)` : ''}.
            </p>
          </div>
        </>
      )}
    </>
  );
}
