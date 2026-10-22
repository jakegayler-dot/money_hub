import { useEffect, useState } from 'react';
import { money, unitPrice } from '../format.js';
import { cents } from '../components/SplitEditor.jsx';

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
          {tab === 'spending' && <Spending s={s} types={data.food_types} />}
          {tab === 'prices' && <Prices prices={data.prices} />}
          {tab === 'ideas' && <Ideas advice={data.advice} busy={busy} onAsk={() => post('/api/groceries/advice')} reader={data.reader} />}
        </>
      )}
      {tab === 'receipts' && <Receipts receipts={data.receipts} types={data.food_types} onChanged={load} />}
    </>
  );
}

function Spending({ s, types }) {
  const tm = s.this_month;
  const vs = s.typical.total && tm.pace ? Math.round((tm.pace / s.typical.total - 1) * 100) : null;
  const rows = types.map((t) => ({ t, now: tm.by_type?.[t] || 0, typical: s.typical.by_type[t] || 0 })).filter((r) => r.now || r.typical)
    .sort((a, b) => b.typical - a.typical || b.now - a.now);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.now, r.typical)));
  const coverage = s.typical.ledger_groceries && s.typical.total ? Math.round((s.typical.total / s.typical.ledger_groceries) * 100) : null;
  return (
    <>
      <div className="grid">
        <div className="metric-card">
          <div className="metric-label">This month so far</div>
          <div className="metric-value">{money(tm.total)}</div>
          <div className="metric-sub">{tm.pace ? `On pace for ${money(tm.pace)}${vs != null ? ` (${vs > 0 ? '+' : ''}${vs}% vs typical)` : ''}` : `${tm.receipts} receipt${tm.receipts === 1 ? '' : 's'}`}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Typical month</div>
          <div className="metric-value">{money(s.typical.total)}</div>
          <div className="metric-sub">{coverage != null ? `Receipts cover ~${coverage}% of ${money(s.typical.ledger_groceries)} in the books` : 'From catalogued receipts'}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Store brands</div>
          <div className="metric-value">{s.store_brand_share != null ? `${s.store_brand_share}%` : '—'}</div>
          <div className="metric-sub">of food spending, last 6 months</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Where</div>
          <div className="metric-value" style={{ fontSize: 16 }}>{s.stores[0]?.store || '—'}</div>
          <div className="metric-sub">{s.stores.slice(0, 3).map((x) => `${x.store} ${money(x.amount)}`).join(' · ')}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">By food type: this month (bar) against a typical month (line)</div>
        <div className="spend-chart">
          {rows.map((r) => (
            <div key={r.t} className="spend-row">
              <span className="spend-label" style={{ textTransform: 'capitalize' }}>{r.t}</span>
              <span className="spend-track" style={{ position: 'relative' }}>
                <span className={`spend-bar${['household', 'personal care', 'other'].includes(r.t) ? ' muted' : ''}`} style={{ width: `${(r.now / max) * 100}%` }} />
                {r.typical > 0 && <span title={`Typical ${money(r.typical)}`} style={{ position: 'absolute', left: `${(r.typical / max) * 100}%`, top: -2, bottom: -2, width: 2, background: 'var(--text-muted)' }} />}
              </span>
              <span className="spend-value">{money(r.now)}<span style={{ color: 'var(--text-faint)' }}> / {money(r.typical)}</span></span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">Month by month</div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Month</th><th>Receipts</th><th>Catalogued</th><th>Saved</th><th>Groceries in the books</th><th>Biggest</th></tr></thead>
            <tbody>
              {s.months.slice().reverse().map((m) => {
                const top = Object.entries(m.by_type).sort((a, b) => b[1] - a[1])[0];
                return (
                  <tr key={m.month}>
                    <td>{monthName(m.month)}</td>
                    <td>{m.receipts || '—'}</td>
                    <td>{m.receipts ? money(m.total) : '—'}</td>
                    <td>{m.discount ? money(m.discount) : '—'}</td>
                    <td>{money(m.ledger_groceries)}</td>
                    <td style={{ textTransform: 'capitalize' }}>{top ? `${top[0]} ${money(top[1])}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
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

function Receipts({ receipts, types, onChanged }) {
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
      <div className="panel-header">Catalogued receipts — tap one to check its lines</div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Date</th><th>Store</th><th>Lines</th><th>Total</th></tr></thead>
          <tbody>
            {receipts.map((r) => [
              <tr key={r.id} onClick={() => show(r.id)} style={{ cursor: 'pointer' }}>
                <td>{r.date}</td><td>{r.store}</td><td>{r.lines}</td>
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
