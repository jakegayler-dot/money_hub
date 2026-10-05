import { Fragment, useEffect, useState } from 'react';
import MetricCard from '../components/MetricCard.jsx';
import { money, unitPrice, localToday } from '../format.js';
import { OwnerFields, ownerPayload, ownerFieldsFrom, ownerSummary, emptyOwnerFields } from '../owners.jsx';

const CATEGORY_LABELS = {
  land: 'Land', buildings: 'Buildings', machinery: 'Machinery & equipment', vehicles: 'Vehicles & trucks',
  breeding_livestock: 'Breeding livestock', investments: 'Investments', other: 'Other',
};
const CLASS_LABELS = { crop: 'Grain in storage', forage: 'Forage (bales)', market_livestock: 'Market livestock', breeding_livestock: 'Breeding livestock', other: 'Other' };
const CLASS_DEFAULTS = {
  crop: { unit: 'bu', segment: 'grain' }, forage: { unit: 'bales', segment: 'livestock' },
  market_livestock: { unit: 'head', segment: 'livestock' }, breeding_livestock: { unit: 'head', segment: 'livestock' },
  other: { unit: 'units', segment: 'grain' },
};

// Typical CCA declining-balance rates, as a starting point. The CCA class
// that applies to a specific asset is a tax question — confirm with your
// accountant. Land isn't depreciable; give it an appreciation rate instead.
const RATE_PRESETS = [
  { key: 'custom', label: 'Custom rate', rate: null, cca: null },
  { key: 'land', label: 'Land — not depreciable (set appreciation)', rate: 0, cca: null },
  { key: 'c1', label: 'CCA Class 1 · 4% — buildings', rate: -4, cca: '1' },
  { key: 'c6', label: 'CCA Class 6 · 10% — frame buildings, fences', rate: -10, cca: '6' },
  { key: 'c8', label: 'CCA Class 8 · 20% — machinery & equipment', rate: -20, cca: '8' },
  { key: 'c10', label: 'CCA Class 10 · 30% — vehicles & trucks', rate: -30, cca: '10' },
  { key: 'c50', label: 'CCA Class 50 · 55% — computers', rate: -55, cca: '50' },
];

const today = () => localToday();
const emptyAsset = {
  name: '', category: 'machinery', value: '', value_date: today(), preset: 'c8',
  annual_change_pct: '-20', cca_class: '8', notes: '', loan_ids: [], ...emptyOwnerFields,
};
const emptyItem = { item_class: 'crop', commodity: '', quantity: '', unit: 'bu', quantity_contracted: '', price_per_unit: '', location: '', segment: 'grain' };

const rateLabel = (a) => {
  const r = Number(a.annual_change_pct);
  if (!r) return 'Flat';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)}%/yr${a.cca_class ? ` · CCA ${a.cca_class}` : ''}`;
};

function AssetForm({ initial, loans, onSaved, onCancel, assetId }) {
  const [f, setF] = useState(initial);
  const [error, setError] = useState(null);

  const applyPreset = (key) => {
    const p = RATE_PRESETS.find((x) => x.key === key);
    setF({ ...f, preset: key, ...(p.rate != null ? { annual_change_pct: String(p.rate), cca_class: p.cca || '' } : {}) });
  };
  const toggleLoan = (id) => setF({ ...f, loan_ids: f.loan_ids.includes(id) ? f.loan_ids.filter((x) => x !== id) : [...f.loan_ids, id] });

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const res = await fetch(assetId ? `/api/assets/${assetId}` : '/api/assets', {
      method: assetId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: f.name, category: f.category, value: Number(f.value), value_date: f.value_date,
        annual_change_pct: Number(f.annual_change_pct) || 0, cca_class: f.cca_class || null, notes: f.notes || null,
        loan_ids: f.loan_ids, ...ownerPayload(f),
      }),
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); setError(b.error || `HTTP ${res.status}`); return; }
    onSaved();
  };

  const r = Number(f.annual_change_pct) || 0;
  const preview = Number(f.value) ? Number(f.value) * Math.pow(1 + r / 100, 5) : null;

  return (
    <form className="form-panel" onSubmit={submit} style={{ maxWidth: 'none', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
      <div className="field"><label>Name</label>
        <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Home quarter, 2019 Case 8250" /></div>
      <div className="field"><label>Category</label>
        <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></div>
      <div className="field"><label>Market value</label>
        <input type="number" step="0.01" required value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></div>
      <div className="field"><label>Valued as of</label>
        <input type="date" required value={f.value_date} onChange={(e) => setF({ ...f, value_date: e.target.value })} /></div>
      <div className="field"><label>Value change method</label>
        <select value={f.preset} onChange={(e) => applyPreset(e.target.value)}>
          {RATE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select></div>
      <div className="field"><label>Annual change % (− depreciates, + appreciates)</label>
        <input type="number" step="0.1" value={f.annual_change_pct}
          onChange={(e) => setF({ ...f, annual_change_pct: e.target.value, preset: 'custom' })} />
        {preview != null && (
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
            In 5 years: {money(Math.round(preview))} ({r < 0 ? 'declining balance, like CCA' : r > 0 ? 'compounding' : 'flat'})
          </p>
        )}</div>
      <OwnerFields state={f} setState={setF} label="Owner" />
      <div className="field"><label>Loans secured by this asset</label>
        {loans.length === 0 ? <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>No loans on file</span> : (
          <div style={{ display: 'grid', gap: 4 }}>
            {loans.map((l) => (
              <label key={l.id} style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={f.loan_ids.includes(l.id)} onChange={() => toggleLoan(l.id)} />
                {l.name || l.lender} <span style={{ color: 'var(--text-faint)' }}>{money(l.outstanding_balance)}</span>
              </label>
            ))}
          </div>
        )}</div>
      <div className="field"><label>Notes</label>
        <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
      {error && <p style={{ color: 'var(--negative)', margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, alignSelf: 'end' }}>
        <button type="submit">{assetId ? 'Save asset' : 'Add asset'}</button>
        {onCancel && <button type="button" className="secondary" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export default function Assets() {
  const [assets, setAssets] = useState([]);
  const [inventory, setInventory] = useState({ groups: [], items: [] });
  const [loans, setLoans] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [item, setItem] = useState(emptyItem);
  const [itemEdit, setItemEdit] = useState(null);
  const [sales, setSales] = useState({ items: [], undated: [] }); // forecast sales from inventory
  const [fallback, setFallback] = useState({ month: '', day: '' }); // { id, quantity, price_per_unit } for a hand-entered item
  const [error, setError] = useState(null);

  const load = () => {
    fetch('/api/assets').then((r) => r.json()).then((d) => setAssets(Array.isArray(d) ? d : []));
    fetch('/api/inventory').then((r) => r.json()).then((d) => setInventory(d && d.groups ? d : { groups: [], items: [] }));
    fetch('/api/loans').then((r) => r.json()).then((d) => setLoans(Array.isArray(d) ? d : []));
    fetch('/api/estimates/from-inventory').then((r) => r.json()).then((d) => {
      setSales(d && d.items ? d : { items: [], undated: [] });
      const [m, day] = (d && d.fallback ? d.fallback : '-').split('-');
      setFallback({ month: m || '', day: day ? String(Number(day)) : '' });
    });
  };

  const saveFallback = async (clear = false) => {
    setError(null);
    const value = clear ? null : `${String(fallback.month).padStart(2, '0')}-${String(fallback.day).padStart(2, '0')}`;
    const res = await fetch('/api/inventory/sale-fallback', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); setError(b.error || `HTTP ${res.status}`); return; }
    load();
  };

  const saveItemEdit = async () => {
    setError(null);
    const res = await fetch(`/api/inventory/${itemEdit.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: Number(itemEdit.quantity), price_per_unit: itemEdit.price_per_unit === '' ? null : Number(itemEdit.price_per_unit) }),
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); setError(b.error || `HTTP ${res.status}`); return; }
    setItemEdit(null);
    load();
  };
  useEffect(load, []);

  const remove = async (url, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) { setError(`Delete failed (HTTP ${res.status})`); return; }
    load();
  };

  const addItem = async (e) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/inventory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...item, quantity: Number(item.quantity), price_per_unit: item.price_per_unit === '' ? null : Number(item.price_per_unit),
        quantity_contracted: item.quantity_contracted === '' ? null : Number(item.quantity_contracted),
      }),
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); setError(b.error || `HTTP ${res.status}`); return; }
    setItem(emptyItem);
    load();
  };

  const totals = {
    value: assets.reduce((s, a) => s + a.value_now, 0),
    value12: assets.reduce((s, a) => s + a.value_12mo, 0),
    loans: assets.reduce((s, a) => s + a.loan_balance, 0),
    equity: assets.reduce((s, a) => s + a.equity_now, 0),
    equity12: assets.reduce((s, a) => s + a.equity_12mo, 0),
    inventory: inventory.groups.reduce((s, g) => s + g.counted_value, 0),
  };
  const byCategory = Object.keys(CATEGORY_LABELS)
    .map((c) => ({ c, rows: assets.filter((a) => a.category === c) }))
    .filter((g) => g.rows.length);
  const unsecuredLoans = loans.filter((l) => !l.asset_id);
  const unpricedGroups = inventory.groups.filter((g) => g.needs_price > 0);
  const saleById = new Map(sales.items.map((x) => [x.inventory_id, x]));
  const undatedIds = new Set(sales.undated.map((x) => x.id));
  const BASIS = { item: 'manager date', 'crop estimate': "crop's estimate", fallback: 'fallback date' };
  const forecastFor = (g) => {
    if (!['crop', 'market_livestock'].includes(g.item_class)) return { text: 'kept — not forecast' };
    const dated = g.items.map((i) => saleById.get(i.id)).filter(Boolean);
    const missing = g.items.filter((i) => undatedIds.has(i.id)).length;
    if (!dated.length) return missing ? { text: 'no sale date', bad: true } : { text: '— (all contracted)' };
    const dates = [...new Set(dated.map((x) => x.start_date))];
    const bases = [...new Set(dated.map((x) => BASIS[x.basis]))];
    return { text: dates.length === 1 ? dates[0] : `${dates.length} dates`, sub: bases.join(', ') + (missing ? ` · ${missing} undated` : ''), bad: missing > 0 };
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Assets</h1>
        <span className="page-meta">Capital assets + inventory · values rolled to today</span>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: 'var(--negative)' }}>
          <p style={{ margin: 0, padding: '12px 20px', color: 'var(--negative)' }}>{error}</p>
        </div>
      )}

      <div className="grid">
        <MetricCard label="Capital assets" value={money(totals.value)} sub={`${money(totals.value12)} in 12 months at their rates`} />
        <MetricCard
          label="Inventory (estimated)"
          value={money(totals.inventory)}
          sub={unpricedGroups.length ? `${unpricedGroups.length} item${unpricedGroups.length > 1 ? 's' : ''} missing a price — counted at $0` : "Uncontracted only, at the managers' estimates"}
        />
        <MetricCard label="Loans on assets" value={money(totals.loans)} sub={unsecuredLoans.length ? `+ ${unsecuredLoans.length} loan${unsecuredLoans.length > 1 ? 's' : ''} not tied to an asset` : 'Every loan is tied to an asset'} />
        <MetricCard
          label="Equity in assets"
          value={money(totals.equity)}
          sub={`${totals.equity12 >= totals.equity ? '+' : '−'}${money(Math.abs(Math.round(totals.equity12 - totals.equity)))} over 12 months`}
          tone={totals.equity12 >= totals.equity ? 'positive' : 'negative'}
        />
      </div>

      <div className="panel">
        <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Capital assets</span>
          {!adding && <button className="small" onClick={() => { setAdding(true); setEditingId(null); }}>Add asset</button>}
        </div>
        {adding && (
          <div style={{ borderBottom: '1px solid var(--border)' }}>
            <AssetForm initial={emptyAsset} loans={loans} onSaved={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />
          </div>
        )}
        {assets.length === 0 ? (
          <div className="empty-state">No assets yet — add land, buildings, equipment and vehicles.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>Asset</th><th>Owner</th><th>Value today</th><th>Rate</th><th>In 12 mo</th><th>Loans</th><th>Equity</th><th>Equity in 12 mo</th><th></th></tr>
              </thead>
              <tbody>
                {byCategory.map(({ c, rows }) => (
                  <Fragment key={c}>
                    <tr><td colSpan={9} style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-faint)', background: 'var(--panel-alt)', paddingTop: 8, paddingBottom: 8 }}>
                      {CATEGORY_LABELS[c]} — {money(rows.reduce((s, a) => s + a.value_now, 0))}
                    </td></tr>
                    {rows.map((a) => (
                      <Fragment key={a.id}>
                        <tr>
                          <td>
                            {a.name}
                            <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                              {money(Number(a.value))} as of {String(a.value_date).slice(0, 10)}
                            </div>
                          </td>
                          <td>{ownerSummary(a)}</td>
                          <td>{money(a.value_now)}</td>
                          <td>{rateLabel(a)}</td>
                          <td>{money(a.value_12mo)}</td>
                          <td>
                            {a.loans.length === 0 ? '—' : a.loans.map((l) => (
                              <div key={l.id} style={{ fontSize: 12 }}>{l.name} <span style={{ color: 'var(--text-faint)' }}>{money(l.outstanding)}</span></div>
                            ))}
                          </td>
                          <td style={a.equity_now < 0 ? { color: 'var(--negative)' } : undefined}>{money(a.equity_now)}</td>
                          <td style={a.equity_12mo < 0 ? { color: 'var(--negative)' } : undefined}>{money(a.equity_12mo)}</td>
                          <td>
                            <span style={{ display: 'inline-flex', gap: 4 }}>
                              <button className="small secondary" onClick={() => { setEditingId(editingId === a.id ? null : a.id); setAdding(false); }}>
                                {editingId === a.id ? 'Close' : 'Edit'}
                              </button>
                              <button className="small secondary" onClick={() => remove(`/api/assets/${a.id}`, `Delete "${a.name}"? Loans secured by it stay, just unlinked.`)}>Delete</button>
                            </span>
                          </td>
                        </tr>
                        {editingId === a.id && (
                          <tr><td colSpan={9} style={{ background: 'var(--panel-alt)', padding: 0 }}>
                            <AssetForm
                              assetId={a.id}
                              loans={loans}
                              initial={{
                                name: a.name, category: a.category, value: a.value, value_date: String(a.value_date).slice(0, 10),
                                preset: (RATE_PRESETS.find((p) => p.rate === Number(a.annual_change_pct) && (p.cca || null) === (a.cca_class || null)) || { key: 'custom' }).key,
                                annual_change_pct: String(Number(a.annual_change_pct)), cca_class: a.cca_class || '', notes: a.notes || '',
                                loan_ids: a.loans.map((l) => l.id), ...ownerFieldsFrom(a),
                              }}
                              onSaved={() => { setEditingId(null); load(); }}
                              onCancel={() => setEditingId(null)}
                            />
                          </td></tr>
                        )}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, padding: '12px 20px 16px' }}>
          Values roll forward from their valuation date: a negative rate is declining-balance depreciation
          (the CCA method — a 30% truck is worth 70% of the year before, every year), a positive rate
          compounds as appreciation. Update the value whenever you get an appraisal; the roll restarts from there.
        </p>
      </div>

      <div className="panel">
        <div className="panel-header">Inventory &amp; livestock — at the managers' estimates</div>
        {inventory.groups.length === 0 ? (
          <div className="empty-state">Nothing yet — Quarter Section and Livestock Manager fill this in once their exports are running.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>Item</th><th>Type</th><th>On hand</th><th>Contracted</th><th>Counted</th><th>Avg price</th><th>Value counted</th><th>Forecast sale</th><th></th></tr>
              </thead>
              <tbody>
                {inventory.groups.map((g) => (
                  <Fragment key={g.key}>
                    <tr>
                      <td>
                        {g.commodity}
                        <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{[...new Set(g.items.map((i) => (i.source === 'manual' ? 'entered by hand' : i.source)))].join(', ')}</div>
                      </td>
                      <td>{CLASS_LABELS[g.item_class]}</td>
                      <td>{Number(g.on_hand).toLocaleString()} {g.unit}</td>
                      <td>
                        {g.contracted ? `${Number(g.contracted).toLocaleString()} ${g.unit}` : '—'}
                        <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{g.contracted_basis}</div>
                      </td>
                      <td>{Number(g.uncontracted).toLocaleString()} {g.unit}</td>
                      <td>
                        {g.needs_price > 0 && g.needs_price === g.items.length ? (
                          <span className="badge fail">NO PRICE</span>
                        ) : <>{unitPrice(g.avg_price)}/{g.unit}</>}
                        <div style={{ fontSize: 11, color: g.needs_price > 0 ? 'var(--negative)' : 'var(--text-faint)' }}>
                          {g.needs_price > 0
                            ? `${g.needs_price} of ${g.items.length} without a price — counted at $0; set it in ${[...new Set(g.items.filter((i) => i.price_basis === 'missing').map((i) => (i.source === 'manual' ? 'Edit below' : i.source)))].join(', ')}`
                            : g.items.every((i) => i.price_basis === 'source') ? 'manager estimate' : g.items.every((i) => i.price_basis === 'entered by hand') ? 'entered by hand' : 'manager + hand-entered'}
                        </div>
                      </td>
                      <td>{money(g.counted_value)}</td>
                      <td>
                        {(() => { const f = forecastFor(g); return (
                          <>
                            <span style={f.bad ? { color: 'var(--negative)' } : undefined}>{f.text}</span>
                            {f.sub && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{f.sub}</div>}
                          </>
                        ); })()}
                      </td>
                      <td></td>
                    </tr>
                    {(g.items.length > 1 || g.items.some((i) => i.source === 'manual')) && g.items.map((i) => (
                      <tr key={i.id} style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        <td style={{ paddingLeft: 36 }}>{i.location || i.external_id || 'Lot'}</td>
                        <td></td>
                        <td>
                          {itemEdit?.id === i.id ? (
                            <input type="number" step="0.001" aria-label="Quantity" style={{ maxWidth: 110 }} value={itemEdit.quantity}
                              onChange={(e) => setItemEdit({ ...itemEdit, quantity: e.target.value })} />
                          ) : <>{Number(i.quantity).toLocaleString()} {i.unit}</>}
                        </td>
                        <td colSpan={2}>{i.quantity_contracted != null ? `${Number(i.quantity_contracted).toLocaleString()} contracted · ` : ''}as of {String(i.as_of).slice(0, 10)}</td>
                        <td>
                          {itemEdit?.id === i.id ? (
                            <input type="number" step="0.01" aria-label="Price per unit" placeholder="Price / unit" style={{ maxWidth: 110 }} value={itemEdit.price_per_unit}
                              onChange={(e) => setItemEdit({ ...itemEdit, price_per_unit: e.target.value })} />
                          ) : i.effective_price != null ? `${unitPrice(i.effective_price)}/${i.unit}` : <span style={{ color: 'var(--negative)' }}>no price</span>}
                        </td>
                        <td>{money(i.counted_value)}</td>
                        <td>{saleById.get(i.id)?.start_date || (undatedIds.has(i.id) ? <span style={{ color: 'var(--negative)' }}>no date</span> : '')}</td>
                        <td>
                          {i.source !== 'manual' ? null : itemEdit?.id === i.id ? (
                            <span style={{ display: 'inline-flex', gap: 4 }}>
                              <button className="small" onClick={saveItemEdit}>Save</button>
                              <button className="small secondary" onClick={() => setItemEdit(null)}>Cancel</button>
                            </span>
                          ) : (
                            <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                              <button className="small secondary" onClick={() => setItemEdit({ id: i.id, quantity: String(Number(i.quantity)), price_per_unit: i.price_per_unit != null ? String(Number(i.price_per_unit)) : '' })}>Edit</button>
                              <button className="small secondary" onClick={() => remove(`/api/inventory/${i.id}`, `Delete ${i.commodity}${i.location ? ` (${i.location})` : ''}?`)}>Delete</button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, padding: '12px 20px 0' }}>
          Only the uncontracted quantity counts toward equity — grain already under an open contract is counted
          once, as that contract's money in. If the source system reports how much of each bin is contracted,
          that's used; otherwise it's worked out from open contracts for the same commodity and unit.
          Breeding stock is never netted against contracts. Prices are the estimates Quarter Section and Livestock
          Manager send — change them there. Add items they don't track (fuel, seed, chemical on hand) by hand below.
        </p>
        <div className="fallback-row">
          <span>
            Uncontracted grain and market cattle sell on their manager's date, else their crop's estimate date. With
            neither, assume sold by
          </span>
          <select aria-label="Fallback month" value={fallback.month} onChange={(e) => setFallback({ ...fallback, month: e.target.value })}>
            <option value="">month</option>
            {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
          </select>
          <input aria-label="Fallback day" type="number" min="1" max="31" placeholder="day" style={{ width: 70 }}
            value={fallback.day} onChange={(e) => setFallback({ ...fallback, day: e.target.value })} />
          <button className="small" disabled={!fallback.month || !fallback.day} onClick={() => saveFallback()}>Save</button>
          {sales.fallback && <button className="small secondary" onClick={() => saveFallback(true)}>Clear</button>}
          <span style={{ color: sales.undated.length ? 'var(--negative)' : 'var(--text-faint)' }}>
            {sales.fallback_date ? `next: ${sales.fallback_date}` : 'not set'}
            {sales.undated.length ? ` · ${sales.undated.length} item${sales.undated.length > 1 ? 's' : ''} left out of the forecast for lack of a date` : ''}
          </span>
        </div>
        <form className="form-panel" onSubmit={addItem} style={{ maxWidth: 'none', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <div className="field"><label>Type</label>
            <select value={item.item_class} onChange={(e) => {
              const c = e.target.value;
              setItem({ ...item, item_class: c, ...CLASS_DEFAULTS[c] });
            }}>
              {Object.entries(CLASS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></div>
          <div className="field"><label>Item</label>
            <input required value={item.commodity} onChange={(e) => setItem({ ...item, commodity: e.target.value })} placeholder="Canola, Bred cows…" /></div>
          <div className="field"><label>Quantity</label>
            <input type="number" step="0.001" required value={item.quantity} onChange={(e) => setItem({ ...item, quantity: e.target.value })} /></div>
          <div className="field"><label>Unit</label>
            <input required value={item.unit} onChange={(e) => setItem({ ...item, unit: e.target.value })} /></div>
          <div className="field"><label>Contracted (optional)</label>
            <input type="number" step="0.001" value={item.quantity_contracted} onChange={(e) => setItem({ ...item, quantity_contracted: e.target.value })} placeholder="auto from contracts" /></div>
          <div className="field"><label>Your estimate / unit</label>
            <input type="number" step="0.01" min="0" value={item.price_per_unit} onChange={(e) => setItem({ ...item, price_per_unit: e.target.value })} placeholder="blank = $0" /></div>
          <div className="field"><label>Location</label>
            <input value={item.location} onChange={(e) => setItem({ ...item, location: e.target.value })} placeholder="Bin 4" /></div>
          <div className="field" style={{ alignSelf: 'end' }}><button type="submit">Add manually</button></div>
        </form>
      </div>

    </>
  );
}
