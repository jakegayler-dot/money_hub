import { useEffect, useState } from 'react';
import { money, unitPrice } from '../format.js';
import { cents } from '../components/SplitEditor.jsx';
import MetricCard from '../components/MetricCard.jsx';
import { Pie } from '../components/Pie.jsx';
import { SERIES, OTHER } from '../chartColors.js';

// Groceries: every grocery receipt catalogued line by line (server/lib/groceries.js).
// Spending by food type against a typical month, the price of each item at
// each store, cost-cutting ideas from the numbers, and the receipts' lines.

const TABS = [['spending', 'Spending'], ['prices', 'Prices by store'], ['ideas', 'Ways to save'], ['receipts', 'Receipts']];
const PER = { kg: '/kg', l: '/L', each: ' each' };
const monthName = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString('en-CA', { month: 'short', year: '2-digit' });

export default function Groceries() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('spending');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => fetch('/api/groceries').then((r) => r.json()).then(setData).catch(() => setMsg({ error: true, text: "Couldn't load groceries." }));
  useEffect(() => { load(); }, []);
  // While past receipts are being catalogued, check back.
  useEffect(() => {
    if (!data?.backfill?.running) return undefined;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [data]);

  const post = async (url, body) => {
    setMsg(null); setBusy(true);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) setMsg({ error: true, text: b.error || `HTTP ${r.status}` });
      await load();
    } finally { setBusy(false); }
  };

  if (!data) return <div className="empty-state">{msg ? msg.text : 'Loading…'}</div>;
  const { summary: s, backfill: bf } = data;
  const any = s.months.some((m) => m.receipts);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Groceries</h1>
        <span className="page-meta">{s.typical.months_used.length ? `Typical = median of ${s.typical.months_used.length} month${s.typical.months_used.length > 1 ? 's' : ''}` : ''}</span>
      </div>
      {msg && <div className="notice" style={msg.error ? { borderColor: 'var(--negative)', color: 'var(--negative)' } : undefined}>{msg.text}</div>}
      {(bf.running || bf.unchecked > 0 || bf.failed > 0) && (
        <div className="notice">
          {bf.running ? `Cataloguing past receipts… ${bf.done} of ${bf.todo}` : (
            <>
              {bf.unchecked > 0 && `${bf.unchecked} past receipt${bf.unchecked > 1 ? 's' : ''} not checked for groceries yet. `}
              {bf.failed > 0 && `${bf.failed} couldn't be read line by line. `}
              <button type="button" disabled={busy || !data.reader} onClick={() => post('/api/groceries/backfill', { retry_failed: bf.failed > 0 })}>Catalogue them</button>
            </>
          )}
        </div>
      )}

      <div className="seg-toggle" role="group" aria-label="Show" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {TABS.map(([k, l]) => <button key={k} type="button" aria-pressed={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {!any && tab !== 'receipts' ? (
        <div className="empty-state">No grocery receipts catalogued yet. Photograph a grocery till slip on the Receipts page and it shows up here.</div>
      ) : (
        <>
          {tab === 'spending' && <Spending s={s} types={data.food_types} budget={data.budget} topItems={data.top_items || {}}
            onBudget={async (v) => { await fetch('/api/groceries/budget', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ budget: v }) }); await load(); }} />}
          {tab === 'prices' && <Prices prices={data.prices} />}
          {tab === 'ideas' && <Ideas advice={data.advice} busy={busy} onAsk={() => post('/api/groceries/advice')} reader={data.reader} />}
        </>
      )}
      {tab === 'receipts' && <Receipts receipts={data.receipts} types={data.food_types} onChanged={load}
        onRecheck={async () => {
          setMsg(null); setBusy(true);
          const r = await fetch('/api/groceries/recheck-dates', { method: 'POST' }).then((x) => x.json()).catch(() => ({ changed: [] }));
          setBusy(false);
          setMsg({ text: r.changed?.length ? `Fixed ${r.changed.length} date${r.changed.length === 1 ? '' : 's'}: ${r.changed.map((c) => `${c.party || 'receipt'} ${c.from} → ${c.to}`).join('; ')}.` : 'No dates needed fixing: every receipt\'s date agrees with its bank entry, or there isn\'t one to check against.' });
          await load();
        }} busy={busy} />}
    </>
  );
}

// Each food type keeps its colour on every chart and period: the eight biggest types take the validated
// palette (chartColors.js); the small ones share a neutral.
const TYPE_COLORS = {
  pantry: SERIES[0], 'meat & seafood': SERIES[1], drinks: SERIES[2], 'dairy & eggs': SERIES[3],
  'snacks & sweets': SERIES[4], produce: SERIES[5], 'deli & prepared': SERIES[6], frozen: SERIES[7],
};
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/** Months as bars: what the receipts show, against the budget (line) and the typical month (dashed). */
function GroceryBars({ months, budget, typical }) {
  const W = 760; const H = 200; const P = { l: 54, r: 8, t: 10, b: 26 };
  const max = Math.max(1, budget || 0, typical || 0, ...months.map((m) => m.total));
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / nice) * nice;
  const bw = (W - P.l - P.r) / months.length;
  const y = (v) => P.t + (1 - v / top) * (H - P.t - P.b);
  return (
    <svg className="pp-bars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Grocery spending by month against the budget">
      {[0, top / 2, top].map((t) => (
        <g key={t}><line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--border)" /><text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="pp-axis">{money(t)}</text></g>
      ))}
      {months.map((m, i) => {
        const x = P.l + i * bw + bw * 0.2; const w = bw * 0.6;
        const over = budget && m.total > budget;
        return (
          <g key={m.month}>
            <title>{`${monthName(m.month)}: ${money(m.total)} on ${m.receipts} receipt${m.receipts === 1 ? '' : 's'}${m.ledger_groceries != null ? `; ${money(m.ledger_groceries)} filed as groceries in the books` : ''}`}</title>
            <rect x={x} y={y(m.total)} width={w} height={Math.max(0, y(0) - y(m.total))} rx="2" fill={over ? 'var(--negative)' : '#6fbf73'} opacity={m.receipts ? 1 : 0.25} />
            <text x={x + w / 2} y={H - 8} textAnchor="middle" className="pp-axis">{monthName(m.month).split(' ')[0]}</text>
          </g>
        );
      })}
      {budget > 0 && <line x1={P.l} x2={W - P.r} y1={y(budget)} y2={y(budget)} stroke="var(--gold)" strokeWidth="2" />}
      {typical > 0 && <line x1={P.l} x2={W - P.r} y1={y(typical)} y2={y(typical)} stroke="var(--text-muted)" strokeWidth="1.5" strokeDasharray="5 4" />}
    </svg>
  );
}

function Spending({ s, types, budget, topItems, onBudget }) {
  const [period, setPeriod] = useState('month');
  const [sel, setSel] = useState(null);
  const [editing, setEditing] = useState(null);
  const tm = s.this_month;
  const target = budget ?? s.typical.total ?? null;
  const used = target ? Math.min(100, (tm.total / target) * 100) : 0;
  const paceAt = target && tm.pace ? Math.min(100, (tm.pace / target) * 100) : null;
  const left = target != null ? target - tm.total : null;
  const daysLeft = tm.days_in_month - tm.day;
  const coverage = s.typical.ledger_groceries && s.typical.total ? Math.round((s.typical.total / s.typical.ledger_groceries) * 100) : null;
  // The pie: this month, the last 3 months or the last 6, by food type.
  const span = { month: 1, '3m': 3, '6m': 6 }[period];
  const ms = s.months.slice(-span);
  const byType = {};
  for (const m of ms) for (const [t, v] of Object.entries(m.by_type)) byType[t] = (byType[t] || 0) + v;
  const slices = types.filter((t) => byType[t] > 0.5).map((t) => ({ key: t, label: cap(t), amount: byType[t], color: TYPE_COLORS[t] || OTHER }))
    .sort((a, b) => b.amount - a.amount);
  const total = slices.reduce((a, x) => a + x.amount, 0);
  const cur = slices.find((x) => x.key === sel);
  const stores = s.stores.map((x, i) => ({ key: x.store, label: x.store, amount: x.amount, color: i < SERIES.length ? SERIES[i] : OTHER }));
  return (
    <>
      <div className="grid personal-cards">
        <MetricCard label="This month so far" value={money(tm.total)}
          sub={tm.pace ? `on pace for ${money(tm.pace)}` : `${tm.receipts} receipt${tm.receipts === 1 ? '' : 's'}`} tone={target && tm.pace > target ? 'negative' : undefined} />
        <MetricCard label={budget != null ? 'Monthly budget' : 'Budget (a typical month)'} value={target != null ? money(target) : '—'}
          sub={left != null ? (left >= 0 ? `${money(left)} left · ${daysLeft} days to go` : `${money(-left)} over`) : 'set a budget below'} tone={left != null && left < 0 ? 'negative' : 'positive'} />
        <MetricCard label="Typical month" value={money(s.typical.total)} sub={coverage != null ? `receipts cover ~${coverage}% of ${money(s.typical.ledger_groceries)} filed as groceries` : 'median of months with receipts'} />
        <MetricCard label="Store brands" value={s.store_brand_share != null ? `${s.store_brand_share}%` : '—'} sub="of food spending, last 6 months" />
      </div>

      <div className="panel">
        <div className="panel-header spend-header">
          <span>Budget — {monthName(tm.month)}</span>
          {editing == null ? (
            <button type="button" className="small secondary" onClick={() => setEditing(budget ?? '')}>{budget != null ? 'Change budget' : 'Set a budget'}</button>
          ) : (
            <span className="pp-budget-set">
              <input type="number" min="0" step="25" aria-label="Monthly grocery budget" value={editing} onChange={(e) => setEditing(e.target.value)} />
              <button type="button" className="small" onClick={async () => { await onBudget(editing === '' ? null : Number(editing)); setEditing(null); }}>Save</button>
              {budget != null && <button type="button" className="small-link" onClick={async () => { await onBudget(null); setEditing(null); }}>Use a typical month</button>}
              <button type="button" className="small-link" onClick={() => setEditing(null)}>Cancel</button>
            </span>
          )}
        </div>
        <div className="gb-wrap">
          <div className="gb-bar" role="img" aria-label={`${money(tm.total)} of ${money(target)} spent`}>
            <span className="gb-fill" style={{ width: `${used}%`, background: tm.total > (target || Infinity) ? 'var(--negative)' : '#6fbf73' }} />
            {paceAt != null && <span className="gb-pace" style={{ left: `${paceAt}%` }} title={`On pace for ${money(tm.pace)}`} />}
          </div>
          <div className="gb-scale"><span>{money(tm.total)} spent</span>{tm.pace && <span>on pace for {money(tm.pace)}</span>}<span>{target != null ? money(target) : ''}</span></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header spend-header">
          <span>What it's spent on</span>
          <span className="seg-toggle" role="group" aria-label="Period">
            {[['month', 'This month'], ['3m', '3 months'], ['6m', '6 months']].map(([k, l]) => (
              <button key={k} type="button" aria-pressed={period === k} className={period === k ? 'on' : ''} onClick={() => { setPeriod(k); setSel(null); }}>{l}</button>
            ))}
          </span>
        </div>
        {!slices.length ? <div className="empty-state">No grocery receipts in this period.</div> : (
          <div className="ps-pie-wrap">
            <Pie slices={slices} selected={sel} onSelect={setSel} size={230} label="Grocery spending by food type" />
            <div className="ps-pie-side">
              {cur ? (
                <div className="ps-detail">
                  <div className="ps-detail-head"><span className="ps-swatch" style={{ background: cur.color }} />{cur.label}</div>
                  <div className="ps-detail-big">{cents(cur.amount)} <span>{Math.round((cur.amount / total) * 1000) / 10}% · typical month {money(s.typical.by_type[cur.key] || 0)}</span></div>
                  <ul className="pp-subs">
                    {(topItems[cur.key] || []).map((it) => (
                      <li key={it.item}>
                        <div className="pp-sub-head"><span>{it.item} <span className="split-lines">· {it.times}×</span></span><b>{cents(it.spent)}</b></div>
                        <div className="pp-sub-bar"><span style={{ width: `${Math.max(2, (it.spent / (topItems[cur.key][0]?.spent || 1)) * 100)}%`, background: cur.color }} /></div>
                      </li>
                    ))}
                  </ul>
                  <div className="split-lines">Items over the last 6 months. Wrong food type? Fix the line under Receipts and it's fixed everywhere.</div>
                  <button type="button" className="small-link" onClick={() => setSel(null)}>Back to all</button>
                </div>
              ) : (
                <table className="ps-legend" data-nostack="">
                  <tbody>
                    {slices.map((x) => (
                      <tr key={x.key} className="ps-legend-row" tabIndex={0} onClick={() => setSel(x.key)} onKeyDown={(e) => { if (e.key === 'Enter') setSel(x.key); }}>
                        <td><span className="ps-swatch" style={{ background: x.color }} />{x.label}</td>
                        <td className="num">{money(x.amount)}</td>
                        <td className="num ps-pct">{Math.round((x.amount / total) * 100)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-header spend-header">
          <span>Month by month</span>
          <span className="pp-key"><span className="ps-swatch" style={{ background: '#6fbf73' }} />Receipts{budget != null && <><span className="gb-key-line" style={{ marginLeft: 12 }} />Budget</>}<span className="gb-key-dash" style={{ marginLeft: 12 }} />Typical</span>
        </div>
        <div className="pp-bars-wrap"><GroceryBars months={s.months.slice(Math.max(0, s.months.findIndex((m) => m.receipts > 0)))} budget={budget} typical={s.typical.total} /></div>
        <p>Faded bars are months with no receipts photographed. Hover a bar for what was filed as groceries in the books that month.</p>
      </div>

      {stores.length > 0 && (
        <div className="panel">
          <div className="panel-header">Where you shop — last 6 months</div>
          <div className="ps-pie-wrap">
            <Pie slices={stores} size={170} label="Grocery spending by store" centerTitle="All stores" />
            <div className="ps-pie-side">
              <table className="ps-legend" data-nostack="">
                <tbody>
                  {s.stores.map((x, i) => (
                    <tr key={x.store}><td><span className="ps-swatch" style={{ background: stores[i].color }} />{x.store}<span className="split-lines"> · {x.trips} trip{x.trips === 1 ? '' : 's'}</span></td>
                      <td className="num">{money(x.amount)}</td><td className="num ps-pct">{money(x.amount / Math.max(1, x.trips))}/trip</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Prices({ prices }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const shown = prices.filter((p) => !q || p.item.includes(q.toLowerCase()));
  const compared = prices.filter((p) => p.stores.length > 1);
  const yearly = compared.reduce((a, p) => a + p.yearly_saving, 0);
  return (
    <div className="panel">
      <div className="panel-header">Price per kg, litre or each, at every store it was bought (last 12 months)</div>
      <p className="spend-note">
        {compared.length ? `${compared.length} item${compared.length > 1 ? 's' : ''} bought at more than one store. Buying each where it's cheapest would have saved about ${money(yearly)} this year.`
          : 'Nothing bought at two stores yet — comparisons show up once an item has been bought in more than one place.'}
      </p>
      <input type="search" placeholder="Find an item (milk, beef…)" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10, maxWidth: 320, width: '100%' }} />
      <div className="table-scroll">
        <table>
          <thead><tr><th>Item</th><th>Cheapest</th><th>Usually bought</th><th>Cheaper by</th><th>Year's saving</th></tr></thead>
          <tbody>
            {shown.map((p) => {
              const key = `${p.item}|${p.unit}`;
              const cheap = p.stores[0];
              const usual = p.stores.find((x) => x.store === p.usual_store);
              return [
                <tr key={key} onClick={() => setOpen(open === key ? null : key)} style={{ cursor: 'pointer' }}>
                  <td>{p.item}<div className="split-lines">{p.bought}× · {money(p.spent)}</div></td>
                  <td>{cheap.store}<div className="split-lines">{unitPrice(cheap.latest)}{PER[p.unit]}</div></td>
                  <td>{p.stores.length > 1 ? <>{usual.store}<div className="split-lines">{unitPrice(usual.latest)}{PER[p.unit]}</div></> : '—'}</td>
                  <td>{p.saving_pct > 0 ? `${p.saving_pct}%` : '—'}</td>
                  <td>{p.yearly_saving > 0 ? cents(p.yearly_saving) : '—'}</td>
                </tr>,
                open === key && (
                  <tr key={`${key}-all`}>
                    <td colSpan={5}>
                      {p.stores.map((x) => (
                        <div key={x.store} className="split-lines">{x.store}: {unitPrice(x.latest)}{PER[p.unit]} last ({x.last_date}), lowest {unitPrice(x.lowest)}, bought {x.times}×</div>
                      ))}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Ideas({ advice, busy, onAsk, reader }) {
  return (
    <div className="panel">
      <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>Ways to spend less, from your own receipts</span>
        <button type="button" disabled={busy || !reader} onClick={onAsk}>{busy ? 'Working it out…' : advice ? 'Look again' : 'Suggest'}</button>
      </div>
      {!advice ? <div className="empty-state">Press Suggest: Claude looks over the receipts, the price book and the typical month.</div> : (
        <>
          <p style={{ marginTop: 0 }}>{advice.headline}</p>
          {advice.suggestions.map((x, i) => (
            <div key={i} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong>{x.title}</strong>
                {x.monthly_saving > 0 && <span className="badge pass">~{money(x.monthly_saving)}/mo</span>}
              </div>
              <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>{x.detail}</div>
            </div>
          ))}
          <div className="page-meta" style={{ marginTop: 8 }}>
            From {advice.based_on?.receipts} receipts over {advice.based_on?.months} months · {new Date(advice.created_at).toLocaleDateString('en-CA')}
          </div>
        </>
      )}
    </div>
  );
}

function Receipts({ receipts, types, onChanged, onRecheck, busy }) {
  const [open, setOpen] = useState(null);
  const [lines, setLines] = useState([]);
  const show = async (id) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    setLines(await fetch(`/api/groceries/receipts/${id}`).then((r) => r.json()));
  };
  const fix = async (line, patch) => {
    await fetch(`/api/groceries/items/${line.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    setLines(await fetch(`/api/groceries/receipts/${open}`).then((r) => r.json()));
    onChanged();
  };
  if (!receipts.length) return <div className="empty-state">No grocery receipts catalogued yet.</div>;
  return (
    <div className="panel">
      <div className="panel-header spend-header">
        <span>Catalogued receipts — tap one to check its lines</span>
        <button type="button" className="small secondary" disabled={busy} onClick={onRecheck}>Check dates against the bank</button>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Date</th><th>Store</th><th>Lines</th><th>Total</th></tr></thead>
          <tbody>
            {receipts.map((r) => [
              <tr key={r.id} onClick={() => show(r.id)} style={{ cursor: 'pointer' }}>
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="date" defaultValue={r.date} aria-label={`Date of the ${r.store} receipt`} className="gr-date"
                    onChange={async (e) => {
                      const v = e.target.value;
                      if (!v || v === r.date) return;
                      await fetch(`/api/receipts/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: v }) });
                      onChanged();
                    }} />
                </td><td>{r.store}</td><td>{r.lines}</td>
                <td>{cents(r.total)}{r.saved > 0 && <div className="split-lines">saved {cents(r.saved)}</div>}</td>
              </tr>,
              open === r.id && (
                <tr key={`${r.id}-lines`}>
                  <td colSpan={4} style={{ padding: 0 }}>
                    <table>
                      <tbody>
                        {lines.map((l) => (
                          <tr key={l.id}>
                            <td>
                              <input defaultValue={l.item} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== l.item && fix(l, { item: e.target.value })} style={{ width: '100%', minWidth: 120 }} />
                              <div className="split-lines">{l.printed}{l.brand ? ` · ${l.brand}` : ''}{l.store_brand ? ' · store brand' : ''}</div>
                            </td>
                            <td>
                              <select value={l.food_type} onChange={(e) => fix(l, { food_type: e.target.value })}>
                                {types.map((t) => <option key={t} value={t}>{t}</option>)}
                              </select>
                            </td>
                            <td>{cents(l.amount)}{l.unit_price != null && <div className="split-lines">{unitPrice(Number(l.unit_price))}{PER[l.unit]}</div>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              ),
            ])}
          </tbody>
        </table>
      </div>
    </div>
  );
}
