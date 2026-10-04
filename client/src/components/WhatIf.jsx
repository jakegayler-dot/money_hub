import { useEffect, useRef, useState } from 'react';
import { money } from '../format.js';

// ---------------------------------------------------------------------------
// What-if analysis: a window over the Cash Flow page.
//
//   left   the levers, one section open at a time
//   right  what they do — headline figures against the plan, plan vs
//          what-if cash, and where each change moves the money
//
// Every change re-runs on the server (the same engine as the forecast), so
// tax is re-worked per year as sales, costs and interest move between years.
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dLabel = (d) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}` : '');
const kfmt = (v) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : `${Math.round(a)}`;
  return `${v < 0 ? '−' : ''}$${s}`;
};
const unitPrice = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${Number(v).toFixed(2)}`);
const signedMoney = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${money(Math.abs(Math.round(v)))}`;
const n = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));

const SECTIONS = [
  { id: 'prices', label: 'Prices & quantities', hint: 'Inventory and crop estimates' },
  { id: 'contracts', label: 'New contracts', hint: 'Price bins or next year’s crop and calves' },
  { id: 'revenue', label: 'Revenue timing', hint: 'When inventory sells and contracts pay' },
  { id: 'costs', label: 'Costs & bills', hint: 'Cost changes, deferring bills, prepaying' },
  { id: 'loans', label: 'Loans & financing', hint: 'New loan, rates, operating line' },
  { id: 'tax', label: 'Tax', hint: 'Instalment, inventory adjustment' },
  { id: 'other', label: 'Other', hint: 'One-off items, GST timing' },
];

function sectionCount(sc, id) {
  const com = Object.values(sc.commodities || {});
  switch (id) {
    case 'prices': return com.filter((c) => n(c.price) != null || n(c.pct) || n(c.qty) != null).length;
    case 'contracts': return (sc.contracts_new || []).length;
    case 'revenue': return com.filter((c) => c.sell_month).length + Object.keys(sc.contract_moves || {}).length;
    case 'costs': return (n(sc.costs_pct) ? 1 : 0) + Object.keys(sc.bill_moves || {}).length + (sc.prepay || []).length;
    case 'loans': return (sc.loans_new || []).length + (n(sc.rate_pts) ? 1 : 0) + (sc.op_line?.on ? 1 : 0);
    case 'tax': return (sc.tax?.instalment === 'skip' ? 1 : 0) + (n(sc.tax?.oia) ? 1 : 0) + (n(sc.tax?.next_year_net) != null ? 1 : 0);
    case 'other': return (sc.oneoffs || []).length + (n(sc.gst_delay) ? 1 : 0);
    default: return 0;
  }
}
const isEmpty = (sc) => SECTIONS.every((s) => !sectionCount(sc, s.id));

const CCA_CLASSES = [
  { rate: 20, label: 'Class 8 — machinery, equipment (20%)' },
  { rate: 30, label: 'Class 10 — trucks, vehicles (30%)' },
  { rate: 4, label: 'Class 1 — buildings (4%)' },
  { rate: 10, label: 'Class 6 — frame buildings, grain bins (10%)' },
  { rate: 0, label: 'Land — no CCA' },
];

export default function WhatIf({ options, initial, onClose, onShow }) {
  const [ctx, setCtx] = useState(null);
  const [sc, setSc] = useState(initial?.scenario || {});
  const [name, setName] = useState(initial?.name || '');
  const [savedId, setSavedId] = useState(initial?.id || null);
  const [saved, setSaved] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(() => SECTIONS.find((s) => sectionCount(initial?.scenario || {}, s.id))?.id || 'prices');
  const [note, setNote] = useState(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    fetch(`/api/forecast/context?months=${options.months}`).then((r) => r.json()).then(setCtx).catch(() => setErr('Could not load the forecast.'));
    fetch('/api/forecast/scenarios').then((r) => r.json()).then((d) => setSaved(Array.isArray(d) ? d : [])).catch(() => {});
  }, [options.months]);

  // Re-run on every change, a moment after the last keystroke.
  useEffect(() => {
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      fetch('/api/forecast/scenario', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: sc, months: options.months, scope: options.scope, accounts: options.accounts, tax: options.includeTax ? 1 : 0 }),
      }).then((r) => r.json()).then((d) => { if (live) { if (d.error) setErr(d.error); else { setErr(null); setResult(d); } setBusy(false); } })
        .catch(() => { if (live) { setErr('Could not run the what-if.'); setBusy(false); } });
    }, 320);
    return () => { live = false; clearTimeout(t); };
  }, [sc, options.months, options.scope, options.includeTax, (options.accounts || []).join(',')]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  const update = (fn) => setSc((s) => { const c = JSON.parse(JSON.stringify(s)); fn(c); return c; });
  const flash = (m) => { setNote(m); setTimeout(() => setNote(null), 2200); };

  const save = async () => {
    const nm = name.trim();
    if (!nm) { setErr('Name the what-if to save it.'); return; }
    const r = await fetch(savedId ? `/api/forecast/scenarios/${savedId}` : '/api/forecast/scenarios', {
      method: savedId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm, data: sc }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.error || 'Could not save.'); return; }
    setSavedId(d.id);
    setSaved((list) => [...list.filter((x) => x.id !== d.id), d].sort((a, b) => a.name.localeCompare(b.name)));
    flash('Saved');
  };
  const load = (id) => {
    const s = saved.find((x) => x.id === Number(id));
    if (!s) return;
    setSc(s.data || {}); setName(s.name); setSavedId(s.id);
  };
  const remove = async () => {
    if (!savedId || !window.confirm(`Delete “${name}”?`)) return;
    await fetch(`/api/forecast/scenarios/${savedId}`, { method: 'DELETE' });
    setSaved((list) => list.filter((x) => x.id !== savedId));
    setSavedId(null);
  };

  const presets = ctx ? makePresets(ctx) : [];

  return (
    <div className="wi-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wi" role="dialog" aria-modal="true" aria-label="What-if analysis" tabIndex={-1} ref={dialogRef}>
        <header className="wi-head">
          <h2 className="wi-title">What if</h2>
          <input className="wi-name" aria-label="Name this what-if" placeholder="Untitled" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="wi-head-actions">
            {saved.length > 0 && (
              <select aria-label="Open a saved what-if" value={savedId || ''} onChange={(e) => load(e.target.value)}>
                <option value="">Saved what-ifs…</option>
                {saved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
            {note && <span className="wi-note" role="status">{note}</span>}
            {savedId && <button type="button" className="small-link" onClick={remove}>Delete</button>}
            <button type="button" className="small secondary" onClick={save}>Save</button>
            <button type="button" className="small" disabled={isEmpty(sc)} onClick={() => onShow({ scenario: sc, name: name.trim() || 'What-if', id: savedId })}>Show on Cash Flow</button>
            <button type="button" className="wi-close" aria-label="Close" onClick={onClose}>×</button>
          </div>
        </header>

        <div className="wi-body">
          <section className="wi-levers" aria-label="Levers">
            {!ctx ? <p className="wi-muted">Loading…</p> : SECTIONS.map((s) => {
              const count = sectionCount(sc, s.id);
              const isOpen = open === s.id;
              return (
                <div key={s.id} className={`wi-sec${isOpen ? ' open' : ''}`}>
                  <button type="button" className="wi-sec-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : s.id)}>
                    <span className="wi-sec-label">{s.label}</span>
                    {count > 0 ? <span className="wi-count">{count}</span> : <span className="wi-sec-hint">{s.hint}</span>}
                  </button>
                  {isOpen && (
                    <div className="wi-sec-body">
                      <Section id={s.id} sc={sc} ctx={ctx} update={update} result={result} options={options} />
                    </div>
                  )}
                </div>
              );
            })}
            {!isEmpty(sc) && <button type="button" className="small-link wi-reset" onClick={() => setSc({})}>Clear every change</button>}
          </section>

          <section className="wi-results" aria-label="Results" aria-busy={busy}>
            {err && <p className="review-error">{err}</p>}
            {!result ? <p className="wi-muted">Running the forecast…</p> : (
              <Results r={result} busy={busy} empty={isEmpty(sc)} presets={presets} apply={(p) => { setSc(p.sc); setOpen(p.open); }} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ---- Presets --------------------------------------------------------------------

function makePresets(ctx) {
  const y0 = ctx.window.y0;
  const out = [];
  const priced = ctx.commodities.filter((c) => c.price || c.estimate_only);
  if (priced.length) {
    out.push({ label: 'Prices fall 20%', open: 'prices', sc: { commodities: Object.fromEntries(priced.map((c) => [c.key, c.price ? { price: +(c.price * 0.8).toFixed(2) } : { pct: -20 }])) } });
  }
  const thisYear = ctx.contracts.filter((c) => c.pays.startsWith(String(y0)));
  if (thisYear.length) {
    out.push({ label: `Defer ${y0} contract payments to January`, open: 'revenue', sc: { contract_moves: Object.fromEntries(thisYear.map((c) => [c.id, `${y0 + 1}-01`])) } });
  }
  const m = ctx.months[Math.min(3, ctx.months.length - 1)].value;
  out.push({ label: 'Buy a $400k machine with a $250k loan', open: 'loans', sc: { loans_new: [{ label: 'Machine', amount: 250000, rate: 6.5, years: 5, per_year: 1, start_month: m, owner: 'farm', buy_cost: 400000, cca_rate: 20 }] } });
  const fin = ctx.bills.filter((b) => b.financed && b.free_until && b.free_until > b.due);
  if (fin.length) out.push({ label: 'Pay financed bills on their interest-free date', open: 'costs', sc: { bill_moves: Object.fromEntries(fin.map((b) => [b.id, b.free_until])) } });
  if (ctx.tax.available && !ctx.tax.instalment_paid) out.push({ label: `Skip the Dec 31 instalment`, open: 'tax', sc: { tax: { instalment: 'skip', prescribed_rate: 7 } } });
  return out;
}

// ---- Lever sections ---------------------------------------------------------------

function MonthSelect({ months, value, onChange, planned, label, allowNone = true }) {
  return (
    <select aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">{planned ? `As planned · ${planned}` : 'Pick a month'}</option>}
      {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
    </select>
  );
}

function Field({ label, children, wide }) {
  return <label className={`wi-field${wide ? ' wide' : ''}`}><span>{label}</span>{children}</label>;
}

function NumIn({ value, onChange, placeholder, step = 'any', label, min }) {
  return <input type="number" inputMode="decimal" step={step} min={min} aria-label={label} placeholder={placeholder} value={value ?? ''}
    onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
}

function Section({ id, sc, ctx, update, result, options }) {
  const months = ctx.months;
  const y0 = ctx.window.y0;

  if (id === 'prices') {
    const rows = ctx.commodities;
    if (!rows.length) return <p className="wi-muted">No uncontracted grain or market cattle on hand, and no crop estimates — add inventory on the Assets tab.</p>;
    const setC = (key, patch) => update((s) => {
      s.commodities = s.commodities || {};
      const next = clean({ ...(s.commodities[key] || {}), ...patch });
      if (Object.keys(next).length) s.commodities[key] = next; else delete s.commodities[key];
    });
    const all = (k) => update((s) => {
      s.commodities = s.commodities || {};
      for (const c of rows) {
        const cur = clean({ ...(s.commodities[c.key] || {}), price: undefined, pct: undefined });
        if (k !== 0) Object.assign(cur, c.price ? { price: +(c.price * (1 + k / 100)).toFixed(2) } : { pct: k });
        if (Object.keys(cur).length) s.commodities[c.key] = cur; else delete s.commodities[c.key];
      }
    });
    return (
      <>
        <div className="wi-chips">
          {[-20, -10, 10].map((k) => <button key={k} type="button" className="wi-chip" onClick={() => all(k)}>All prices {k > 0 ? '+' : '−'}{Math.abs(k)}%</button>)}
          <button type="button" className="wi-chip" onClick={() => all(0)}>Reset prices</button>
        </div>
        {rows.map((c) => {
          const v = sc.commodities?.[c.key] || {};
          return (
            <div key={c.key} className="wi-row">
              <div className="wi-row-title">
                <strong>{c.commodity}</strong>
                <span>{c.estimate_only
                  ? `estimate · ${money(c.value)} · ${dLabel(c.sells)}`
                  : `${Math.round(c.uncontracted).toLocaleString()} ${c.unit} uncontracted${c.price ? ` · ${unitPrice(c.price)}/${c.unit}` : ''}${c.sells ? ` · sells ${dLabel(c.sells)}` : ''}`}</span>
              </div>
              <div className="wi-grid2">
                {c.estimate_only || !c.price ? (
                  <Field label="Price change %"><NumIn label={`${c.commodity} price change %`} value={v.pct} placeholder="0" onChange={(x) => setC(c.key, { pct: x })} /></Field>
                ) : (
                  <Field label={`Price $/${c.unit}`}><NumIn label={`${c.commodity} price`} value={v.price} placeholder={String(c.price)} step="0.01" onChange={(x) => setC(c.key, { price: x })} /></Field>
                )}
                {!c.estimate_only && (
                  <Field label={`Uncontracted ${c.unit}`}><NumIn label={`${c.commodity} quantity`} value={v.qty} placeholder={String(Math.round(c.uncontracted))} min="0" onChange={(x) => setC(c.key, { qty: x })} /></Field>
                )}
              </div>
            </div>
          );
        })}
        <p className="wi-help">Contracts already signed keep their price. A crop estimate for the same commodity moves with its price.</p>
      </>
    );
  }

  if (id === 'contracts') {
    const list = sc.contracts_new || [];
    const set = (i, patch) => update((s) => { s.contracts_new[i] = clean({ ...s.contracts_new[i], ...patch }); });
    const add = () => update((s) => {
      const g = ctx.commodities.find((c) => !c.estimate_only);
      s.contracts_new = [...(s.contracts_new || []), clean({
        commodity: g?.commodity || '', crop: g ? 'bins' : 'next', group: g?.key, unit: g?.unit || 'bu',
        price: g?.price || null, pay_month: months[Math.min(1, months.length - 1)].value,
      })];
    });
    return (
      <>
        {list.length === 0 && <p className="wi-muted">Price part of what’s in the bins, or contract next year’s crop or calves ahead.</p>}
        {list.map((c, i) => {
          const groups = ctx.commodities.filter((x) => !x.estimate_only);
          const g = groups.find((x) => x.key === c.group);
          const value = n(c.quantity) && n(c.price) ? n(c.quantity) * n(c.price) : null;
          return (
            <div key={i} className="wi-card">
              <div className="wi-card-head">
                <div className="wi-seg" role="group" aria-label="Contract from">
                  <button type="button" className={c.crop === 'bins' ? 'on' : ''} disabled={!groups.length}
                    onClick={() => set(i, { crop: 'bins', group: c.group || groups[0]?.key, commodity: (g || groups[0])?.commodity, unit: (g || groups[0])?.unit })}>In the bins / on hand</button>
                  <button type="button" className={c.crop !== 'bins' ? 'on' : ''} onClick={() => set(i, { crop: 'next', group: null })}>Next crop or calves</button>
                </div>
                <button type="button" className="wi-x" aria-label="Remove contract" onClick={() => update((s) => { s.contracts_new.splice(i, 1); })}>×</button>
              </div>
              <div className="wi-grid2">
                {c.crop === 'bins' ? (
                  <Field label="Commodity" wide>
                    <select value={c.group || ''} onChange={(e) => { const x = groups.find((k) => k.key === e.target.value); set(i, { group: x.key, commodity: x.commodity, unit: x.unit, price: c.price ?? x.price }); }}>
                      {groups.map((x) => <option key={x.key} value={x.key}>{x.commodity} — {Math.round(x.uncontracted).toLocaleString()} {x.unit} uncontracted</option>)}
                    </select>
                  </Field>
                ) : (
                  <Field label="Commodity" wide>
                    <input list="wi-commodities" value={c.commodity || ''} placeholder="e.g. Canola, Steer calves" onChange={(e) => set(i, { commodity: e.target.value })} />
                  </Field>
                )}
                <Field label={`Quantity${c.unit ? ` (${c.unit})` : ''}`}><NumIn label="Quantity" value={c.quantity} min="0" onChange={(x) => set(i, { quantity: x })} /></Field>
                {c.crop !== 'bins'
                  ? <Field label="Unit"><input value={c.unit || ''} placeholder="bu, tonnes, head, cwt" onChange={(e) => set(i, { unit: e.target.value })} /></Field>
                  : null}
                <Field label={`Price $/${c.unit || 'unit'}`}><NumIn label="Price" value={c.price} step="0.01" onChange={(x) => set(i, { price: x })} /></Field>
                <Field label="Paid in"><MonthSelect months={months} value={c.pay_month} allowNone={false} label="Paid in" onChange={(x) => set(i, { pay_month: x })} /></Field>
                {c.crop !== 'bins' && ctx.estimates.length > 0 && (
                  <Field label="Replaces part of an estimate" wide>
                    <select value={c.estimate_id || ''} onChange={(e) => set(i, { estimate_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">No — it’s new money</option>
                      {ctx.estimates.map((e) => <option key={e.id} value={e.id}>{e.name} · {money(e.amount)} · {dLabel(e.date)}</option>)}
                    </select>
                  </Field>
                )}
                {c.crop !== 'bins' && c.estimate_id && (
                  <Field label={`Price the estimate assumes $/${c.unit || 'unit'}`}><NumIn label="Estimate price" value={c.estimate_price} step="0.01" placeholder={c.price != null ? String(c.price) : ''} onChange={(x) => set(i, { estimate_price: x })} /></Field>
                )}
              </div>
              {value != null && <p className="wi-card-foot">{money(value)}{c.crop === 'bins' && g && n(c.quantity) > g.uncontracted ? ' · more than is uncontracted' : ''}</p>}
            </div>
          );
        })}
        <datalist id="wi-commodities">{ctx.known_commodities.map((k) => <option key={k} value={k} />)}</datalist>
        <button type="button" className="small secondary" onClick={add}>Add a contract</button>
        <p className="wi-help">From the bins, the contract replaces that much of the uncontracted grain at its forecast price and date.</p>
      </>
    );
  }

  if (id === 'revenue') {
    const inv = ctx.commodities.filter((c) => !c.estimate_only && c.sells);
    const setSell = (key, v) => update((s) => {
      s.commodities = s.commodities || {};
      const next = clean({ ...(s.commodities[key] || {}), sell_month: v });
      if (Object.keys(next).length) s.commodities[key] = next; else delete s.commodities[key];
    });
    const setMove = (id2, v) => update((s) => { s.contract_moves = s.contract_moves || {}; if (v) s.contract_moves[id2] = v; else delete s.contract_moves[id2]; });
    const thisYear = ctx.contracts.filter((c) => c.pays.startsWith(String(y0)));
    return (
      <>
        <h4 className="wi-h">Sell uncontracted inventory in</h4>
        {!inv.length && <p className="wi-muted">No inventory forecast to sell.</p>}
        {inv.map((c) => (
          <div key={c.key} className="wi-line">
            <span>{c.commodity}<em>{money(c.value)}</em></span>
            <MonthSelect months={months} value={sc.commodities?.[c.key]?.sell_month} planned={dLabel(c.sells)} label={`${c.commodity} sells in`} onChange={(v) => setSell(c.key, v)} />
          </div>
        ))}
        <h4 className="wi-h">Contract payments</h4>
        {thisYear.length > 0 && (
          <div className="wi-chips">
            <button type="button" className="wi-chip" onClick={() => update((s) => { s.contract_moves = { ...(s.contract_moves || {}), ...Object.fromEntries(thisYear.map((c) => [c.id, `${y0 + 1}-01`])) }; })}>
              Defer all {y0} payments to January (deferred cash tickets)
            </button>
          </div>
        )}
        {!ctx.contracts.length && <p className="wi-muted">No open contracts.</p>}
        {ctx.contracts.map((c) => (
          <div key={c.id} className="wi-line">
            <span>{c.label}<em>{money(c.remaining)}</em></span>
            <MonthSelect months={months} value={sc.contract_moves?.[c.id]} planned={dLabel(c.pays)} label={`${c.label} paid in`} onChange={(v) => setMove(c.id, v)} />
          </div>
        ))}
        <p className="wi-help">Income counts in the year it’s paid, so moving a payment past Dec 31 moves its tax to next year too.</p>
      </>
    );
  }

  if (id === 'costs') {
    const fin = ctx.bills.filter((b) => b.financed && b.free_until && b.free_until > b.due);
    return (
      <>
        <h4 className="wi-h">All costs</h4>
        <RangeIn label="Bills and estimated costs" value={n(sc.costs_pct) || 0} min={-25} max={50} unit="%" onChange={(v) => update((s) => { if (v) s.costs_pct = v; else delete s.costs_pct; })} />
        <h4 className="wi-h">Pay bills later</h4>
        {fin.length > 0 && (
          <div className="wi-chips">
            <button type="button" className="wi-chip" onClick={() => update((s) => { s.bill_moves = { ...(s.bill_moves || {}), ...Object.fromEntries(fin.map((b) => [b.id, b.free_until])) }; })}>
              Financed bills on their interest-free date
            </button>
          </div>
        )}
        <BillMoves ctx={ctx} sc={sc} update={update} />
        <h4 className="wi-h">Prepay next season’s inputs</h4>
        {(sc.prepay || []).map((p, i) => (
          <div key={i} className="wi-card">
            <div className="wi-card-head"><span className="wi-card-title">Prepaid inputs</span>
              <button type="button" className="wi-x" aria-label="Remove" onClick={() => update((s) => { s.prepay.splice(i, 1); })}>×</button></div>
            <div className="wi-grid2">
              <Field label="Amount"><NumIn label="Prepay amount" value={p.amount} min="0" onChange={(x) => update((s) => { s.prepay[i] = clean({ ...s.prepay[i], amount: x }); })} /></Field>
              <Field label="Paid in"><MonthSelect months={months} value={p.month} allowNone={false} label="Prepaid in" onChange={(x) => update((s) => { s.prepay[i].month = x; })} /></Field>
              <Field label="Instead of paying in" wide><MonthSelect months={months} value={p.instead_month} planned="" label="Instead of" onChange={(x) => update((s) => { s.prepay[i] = clean({ ...s.prepay[i], instead_month: x }); })} /></Field>
            </div>
          </div>
        ))}
        <button type="button" className="small secondary" onClick={() => update((s) => {
          const dec = months.find((m) => m.value === `${y0}-12`)?.value || months[0].value;
          const apr = months.find((m) => m.value === `${y0 + 1}-04`)?.value || null;
          s.prepay = [...(s.prepay || []), clean({ amount: 50000, month: dec, instead_month: apr })];
        })}>Add a prepayment</button>
        <p className="wi-help">Prepaid before Dec 31, inputs are deductible this year — the cash goes out earlier and the tax comes off this year’s bill.</p>
      </>
    );
  }

  if (id === 'loans') {
    const list = sc.loans_new || [];
    const set = (i, patch) => update((s) => { s.loans_new[i] = clean({ ...s.loans_new[i], ...patch }); });
    const op = sc.op_line || {};
    const setOp = (patch) => update((s) => { s.op_line = clean({ ...(s.op_line || {}), ...patch }); if (!s.op_line.on) delete s.op_line; });
    return (
      <>
        <h4 className="wi-h">New loans</h4>
        {list.map((l, i) => {
          const pay = loanPayment(l);
          return (
            <div key={i} className="wi-card">
              <div className="wi-card-head">
                <input className="wi-card-name" aria-label="Loan name" value={l.label || ''} placeholder="What it's for" onChange={(e) => set(i, { label: e.target.value })} />
                <button type="button" className="wi-x" aria-label="Remove loan" onClick={() => update((s) => { s.loans_new.splice(i, 1); })}>×</button>
              </div>
              <div className="wi-grid2">
                <Field label="Amount borrowed"><NumIn label="Amount" value={l.amount} min="0" step="1000" onChange={(x) => set(i, { amount: x })} /></Field>
                <Field label="Rate %"><NumIn label="Rate" value={l.rate} step="0.05" onChange={(x) => set(i, { rate: x })} /></Field>
                <Field label="Years"><NumIn label="Years" value={l.years} min="1" step="1" onChange={(x) => set(i, { years: x })} /></Field>
                <Field label="Payments">
                  <select value={String(l.per_year || 12)} onChange={(e) => set(i, { per_year: Number(e.target.value), first_month: null })}>
                    <option value="12">Monthly</option><option value="1">Annual</option>
                  </select>
                </Field>
                <Field label="Advanced in"><MonthSelect months={months} value={l.start_month} allowNone={false} label="Advanced in" onChange={(x) => set(i, { start_month: x, first_month: null })} /></Field>
                <Field label="First payment"><MonthSelect months={months} value={l.first_month} planned={l.per_year === 1 ? 'a year after' : 'a month after'} label="First payment" onChange={(x) => set(i, { first_month: x })} /></Field>
                <Field label="Owner">
                  <select value={l.owner || 'farm'} onChange={(e) => set(i, { owner: e.target.value })}><option value="farm">Farm</option><option value="personal">Personal</option></select>
                </Field>
                <Field label="Buys an asset costing"><NumIn label="Asset cost" value={l.buy_cost} min="0" step="1000" placeholder="nothing" onChange={(x) => set(i, { buy_cost: x })} /></Field>
                {n(l.buy_cost) > 0 && (
                  <Field label="CCA class" wide>
                    <select value={String(l.cca_rate ?? 20)} onChange={(e) => set(i, { cca_rate: Number(e.target.value) })}>
                      {CCA_CLASSES.map((c) => <option key={c.rate} value={c.rate}>{c.label}</option>)}
                    </select>
                  </Field>
                )}
              </div>
              {pay && <p className="wi-card-foot">{money(pay)} {l.per_year === 1 ? 'a year' : 'a month'}{n(l.buy_cost) > 0 ? ` · ${money(n(l.buy_cost) - n(l.amount))} down` : ''}</p>}
            </div>
          );
        })}
        <button type="button" className="small secondary" onClick={() => update((s) => {
          s.loans_new = [...(s.loans_new || []), { label: '', amount: 250000, rate: 6.5, years: 5, per_year: 1, start_month: months[Math.min(2, months.length - 1)].value, owner: 'farm' }];
        })}>Add a loan</button>

        <h4 className="wi-h">Interest rates</h4>
        <RangeIn label="Change on existing loans" value={n(sc.rate_pts) || 0} min={-2} max={4} step={0.25} unit=" pts" onChange={(v) => update((s) => { if (v) s.rate_pts = v; else delete s.rate_pts; })} />
        <div className="wi-seg small" role="group" aria-label="Which loans">
          <button type="button" className={sc.rate_scope !== 'all' ? 'on' : ''} onClick={() => update((s) => { delete s.rate_scope; })}>Variable-rate loans</button>
          <button type="button" className={sc.rate_scope === 'all' ? 'on' : ''} onClick={() => update((s) => { s.rate_scope = 'all'; })}>All loans</button>
        </div>

        <h4 className="wi-h">Operating line</h4>
        <label className="wi-toggle">
          <input type="checkbox" checked={!!op.on} onChange={(e) => setOp({ on: e.target.checked, limit: op.limit ?? 250000, rate: op.rate ?? 7.2, keep: op.keep ?? Math.round(result?.floor || 0) })} />
          Draw on it to keep cash above a minimum
        </label>
        {op.on && (
          <div className="wi-grid2">
            <Field label="Limit"><NumIn label="Limit" value={op.limit} min="0" step="5000" onChange={(x) => setOp({ limit: x })} /></Field>
            <Field label="Rate %"><NumIn label="Operating line rate" value={op.rate} step="0.05" onChange={(x) => setOp({ rate: x })} /></Field>
            <Field label="Keep cash at least" wide><NumIn label="Keep at least" value={op.keep} min="0" step="1000" onChange={(x) => setOp({ keep: x })} /></Field>
          </div>
        )}
      </>
    );
  }

  if (id === 'tax') {
    const t = sc.tax || {};
    const setT = (patch) => update((s) => { s.tax = clean({ ...(s.tax || {}), ...patch }); if (!Object.keys(s.tax).length) delete s.tax; });
    if (!ctx.tax.available) return <p className="wi-muted">The tax estimate isn’t available, so tax effects can’t be worked out.</p>;
    return (
      <>
        {!options.includeTax && <p className="wi-help">Income tax is switched off on Cash Flow: tax changes show in the figures but not in the cash line.</p>}
        <h4 className="wi-h">Dec 31, {y0} instalment</h4>
        {ctx.tax.instalment_paid ? <p className="wi-muted">Already marked paid on the Tax tab.</p> : (
          <>
            <div className="wi-seg" role="group" aria-label="Instalment">
              <button type="button" className={t.instalment !== 'skip' ? 'on' : ''} onClick={() => setT({ instalment: null })}>Pay it Dec 31</button>
              <button type="button" className={t.instalment === 'skip' ? 'on' : ''} onClick={() => setT({ instalment: 'skip', prescribed_rate: t.prescribed_rate ?? 7 })}>Skip — pay it all Apr 30</button>
            </div>
            {t.instalment === 'skip' && (
              <div className="wi-grid2">
                <Field label="CRA prescribed rate %" wide><NumIn label="Prescribed rate" value={t.prescribed_rate} step="0.5" onChange={(x) => setT({ prescribed_rate: x })} /></Field>
              </div>
            )}
          </>
        )}
        <h4 className="wi-h">Optional inventory adjustment</h4>
        <Field label={`Added to ${y0} income, back off ${y0 + 1}`} wide><NumIn label="Optional inventory adjustment" value={t.oia} min="0" step="1000" placeholder="0" onChange={(x) => setT({ oia: x })} /></Field>
        <h4 className="wi-h">{y0 + 1} farm income</h4>
        <Field label={`Before these changes (${y0}'s is ${money(ctx.tax.net_y0)})`} wide>
          <NumIn label="Next year's farm income" value={t.next_year_net} step="1000" placeholder={String(Math.round(ctx.tax.net_y0 || 0))} onChange={(x) => setT({ next_year_net: x })} />
        </Field>
        <p className="wi-help">Next year’s crop isn’t forecast yet, so its tax is measured from this figure — it sets how much a sale moved into {y0 + 1} costs.</p>
      </>
    );
  }

  if (id === 'other') {
    const list = sc.oneoffs || [];
    const set = (i, patch) => update((s) => { s.oneoffs[i] = clean({ ...s.oneoffs[i], ...patch }); });
    return (
      <>
        <h4 className="wi-h">One-off items</h4>
        {list.map((o, i) => (
          <div key={i} className="wi-card">
            <div className="wi-card-head">
              <input className="wi-card-name" aria-label="Item" value={o.label || ''} placeholder="e.g. Sell the old swather" onChange={(e) => set(i, { label: e.target.value })} />
              <button type="button" className="wi-x" aria-label="Remove" onClick={() => update((s) => { s.oneoffs.splice(i, 1); })}>×</button>
            </div>
            <div className="wi-grid2">
              <Field label="Amount (− for money out)"><NumIn label="Amount" value={o.amount} step="100" onChange={(x) => set(i, { amount: x })} /></Field>
              <Field label="Month"><MonthSelect months={months} value={o.month} allowNone={false} label="Month" onChange={(x) => set(i, { month: x })} /></Field>
              <Field label="Counts as" wide>
                <select value={o.treatment || 'farm'} onChange={(e) => set(i, { treatment: e.target.value })}>
                  <option value="farm">Farm income or expense (taxable)</option>
                  <option value="capital">Capital purchase (CCA)</option>
                  <option value="personal">Personal — not farm</option>
                </select>
              </Field>
              {o.treatment === 'capital' && (
                <Field label="CCA class" wide>
                  <select value={String(o.cca_rate ?? 20)} onChange={(e) => set(i, { cca_rate: Number(e.target.value) })}>
                    {CCA_CLASSES.map((c) => <option key={c.rate} value={c.rate}>{c.label}</option>)}
                  </select>
                </Field>
              )}
            </div>
          </div>
        ))}
        <button type="button" className="small secondary" onClick={() => update((s) => { s.oneoffs = [...(s.oneoffs || []), { label: '', amount: -25000, month: months[Math.min(2, months.length - 1)].value, treatment: 'farm' }]; })}>Add an item</button>
        <h4 className="wi-h">GST refunds</h4>
        <div className="wi-line">
          <span>Arrive later than expected</span>
          <select aria-label="GST refunds arrive" value={String(n(sc.gst_delay) || 0)} onChange={(e) => update((s) => { const v = Number(e.target.value); if (v) s.gst_delay = v; else delete s.gst_delay; })}>
            {[0, 1, 2, 3, 6].map((v) => <option key={v} value={v}>{v ? `${v} month${v > 1 ? 's' : ''} late` : 'On time'}</option>)}
          </select>
        </div>
      </>
    );
  }
  return null;
}

function BillMoves({ ctx, sc, update }) {
  const [showAll, setShowAll] = useState(false);
  const setMove = (bid, v) => update((s) => { s.bill_moves = s.bill_moves || {}; if (v) s.bill_moves[bid] = v; else delete s.bill_moves[bid]; });
  const moved = new Set(Object.keys(sc.bill_moves || {}).map(Number));
  const bills = showAll ? ctx.bills : ctx.bills.filter((b, i) => i < 8 || moved.has(b.id));
  if (!ctx.bills.length) return <p className="wi-muted">No unpaid bills.</p>;
  return (
    <>
      {bills.map((b) => (
        <div key={b.id} className="wi-line">
          <span>{b.name}<em>{money(b.owing)} · due {dLabel(b.due)}{b.financed ? ` · ${b.rate}% after ${dLabel(b.free_until)}` : ''}</em></span>
          <input type="date" aria-label={`${b.name} paid on`} value={sc.bill_moves?.[b.id] || ''} onChange={(e) => setMove(b.id, e.target.value || null)} />
        </div>
      ))}
      {ctx.bills.length > 8 && <button type="button" className="small-link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${ctx.bills.length} bills`}</button>}
    </>
  );
}

function RangeIn({ label, value, min, max, step = 1, unit, onChange }) {
  return (
    <label className="wi-range">
      <span>{label}<b className={value > 0 ? 'up' : value < 0 ? 'down' : ''}>{value > 0 ? '+' : ''}{value}{unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function loanPayment(l) {
  const P = n(l.amount); const r = (n(l.rate) || 0) / 100; const per = Number(l.per_year) === 1 ? 1 : 12; const yrs = n(l.years) || 0;
  if (!(P > 0) || !(yrs > 0)) return null;
  const i = r / per; const k = Math.round(yrs * per);
  return i > 0 ? P * i / (1 - Math.pow(1 + i, -k)) : P / k;
}

// ---- Results ----------------------------------------------------------------------

function Results({ r, busy, empty, presets, apply }) {
  const p = r.plan; const s = r.scenario; const y0 = r.window.y0;
  const figs = [
    { label: `Low point`, sub: s.low_month, plan: p.low, val: s.low, good: 'up' },
    { label: `Cash at ${r.window.end}`, plan: p.end, val: s.end, good: 'up' },
    { label: `Tax + CPP ${y0}`, plan: p.tax_y0, val: s.tax_y0, good: 'down', hide: !r.tax_available },
  ];
  const minor = [
    { label: `Tax + CPP ${y0 + 1}`, plan: p.tax_y1, val: s.tax_y1, good: 'down', hide: !r.tax_available },
    { label: `Farm income ${y0}`, plan: p.net_y0, val: s.net_y0, good: 'none', hide: !r.tax_available },
    { label: 'Interest in the window', plan: p.interest, val: s.interest, good: 'down' },
    ...(s.op_peak > 0 ? [{ label: 'Operating line peak', plan: 0, val: s.op_peak, good: 'down', note: `${money(s.op_interest)} interest` }] : []),
  ];
  return (
    <div className={`wi-out${busy ? ' busy' : ''}`}>
      <div className="wi-figs">
        {figs.filter((f) => !f.hide).map((f) => <Fig key={f.label} f={f} big />)}
      </div>
      <div className="wi-figs minor">
        {minor.filter((f) => !f.hide).map((f) => <Fig key={f.label} f={f} />)}
      </div>
      <ScenarioChart r={r} />
      {empty ? (
        <div className="wi-start">
          <p>Change anything on the left and the what-if line re-runs, tax and all. Or start from one of these:</p>
          <div className="wi-chips">{presets.map((pr) => <button key={pr.label} type="button" className="wi-chip" onClick={() => apply(pr)}>{pr.label}</button>)}</div>
        </div>
      ) : (
        <Impact steps={r.steps} y0={y0} totals={{ end: s.end - p.end, low: s.low - p.low, tax_y0: s.tax_y0 - p.tax_y0, tax_y1: s.tax_y1 - p.tax_y1 }} taxOn={r.tax_available} />
      )}
      {r.warnings?.length > 0 && <ul className="wi-warn">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      <p className="wi-foot">
        {r.scope === 'farm' ? 'Farm money only' : r.scope === 'personal' ? 'Personal money only' : 'All money, farm and personal'} · {r.window.start} – {r.window.end}
        {r.include_tax ? ' · income tax in the cash line' : ' · income tax not in the cash line'}. Nothing here changes your books.
      </p>
    </div>
  );
}

function Fig({ f, big }) {
  const d = f.val != null && f.plan != null ? f.val - f.plan : null;
  const better = d == null || Math.abs(d) < 1 || f.good === 'none' ? null : (f.good === 'up' ? d > 0 : d < 0);
  return (
    <div className={`wi-fig${big ? ' big' : ''}`}>
      <span className="wi-fig-label">{f.label}{f.sub ? <em> · {f.sub}</em> : null}</span>
      <span className="wi-fig-val">{f.val == null ? '—' : money(Math.round(f.val))}</span>
      <span className="wi-fig-sub">
        {d != null && Math.abs(d) >= 1
          ? <><b className={better == null ? '' : better ? 'good' : 'bad'}>{signedMoney(d)}</b> vs plan {money(Math.round(f.plan))}</>
          : f.note || 'same as plan'}
      </span>
    </div>
  );
}

function Impact({ steps, y0, totals, taxOn }) {
  const max = Math.max(1, ...steps.map((x) => Math.abs(x.end)), Math.abs(totals.end));
  const bar = (v) => {
    const w = Math.min(50, (Math.abs(v) / max) * 50);
    return <span className="wi-bar"><i className={v >= 0 ? 'pos' : 'neg'} style={{ width: `${w}%`, [v >= 0 ? 'left' : 'right']: '50%' }} /></span>;
  };
  const cell = (v, good) => {
    if (v == null) return <td className="num">—</td>;
    if (Math.abs(v) < 1) return <td className="num wi-zero">—</td>;
    const ok = good === 'up' ? v > 0 : v < 0;
    return <td className={`num ${ok ? 'good' : 'bad'}`}>{signedMoney(v)}</td>;
  };
  return (
    <div className="wi-impact">
      <h3>Where the money moves</h3>
      <table>
        <thead>
          <tr><th>Change</th><th className="wi-bar-col" aria-label="Cash at the end, as a bar" /><th className="num">Cash at end</th><th className="num">Low point</th>
            {taxOn && <th className="num">Tax {y0}</th>}{taxOn && <th className="num">Tax {y0 + 1}</th>}</tr>
        </thead>
        <tbody>
          {steps.map((st) => (
            <tr key={st.id}>
              <td>{st.label}</td><td className="wi-bar-col">{bar(st.end)}</td>
              {cell(st.end, 'up')}{cell(st.low, 'up')}{taxOn && cell(st.tax_y0, 'down')}{taxOn && cell(st.tax_y1, 'down')}
            </tr>
          ))}
          <tr className="wi-total">
            <td>All together</td><td className="wi-bar-col">{bar(totals.end)}</td>
            {cell(totals.end, 'up')}{cell(totals.low, 'up')}{taxOn && cell(totals.tax_y0, 'down')}{taxOn && cell(totals.tax_y1, 'down')}
          </tr>
        </tbody>
      </table>
      <p className="wi-help">Each change is measured on top of the ones above it. Cash includes the tax each change adds or saves.</p>
    </div>
  );
}

function ScenarioChart({ r }) {
  const boxRef = useRef(null);
  const [W, setW] = useState(640);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    if (!boxRef.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, []);
  const plan = r.plan.trajectory; const scn = r.scenario.trajectory;
  const pp = [plan.opening, ...plan.months.map((m) => m.balance)];
  const sp = [scn.opening, ...scn.months.map((m) => m.balance)];
  const n2 = pp.length - 1;
  const narrow = W < 520;
  const H = narrow ? 200 : 240;
  const pad = { t: 16, r: 12, b: 26, l: narrow ? 44 : 60 };
  const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
  const vals = [...pp, ...sp, r.floor, 0];
  const lo = Math.min(...vals); const hi = Math.max(...vals);
  const rough = (hi - lo || 1) / 4; const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= rough);
  const yMin = Math.floor(lo / step) * step; const yMax = Math.ceil(hi / step) * step;
  const x = (i) => pad.l + (i / n2) * iw;
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ih;
  const path = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const grid = []; for (let v = yMin; v <= yMax + step / 2; v += step) grid.push(v);
  const labelEvery = n2 > 18 ? 3 : n2 > 12 ? 2 : narrow ? 2 : 1;
  const months = plan.months;
  const at = hover;
  const svgRef = useRef(null);
  const move = (e) => {
    const b = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - b.left) / b.width) * W;
    setHover(Math.max(1, Math.min(n2, Math.round(((px - pad.l) / iw) * n2))));
  };
  const lowS = r.scenario.low_index + 1; const lowP = r.plan.low_index + 1;
  const same = pp.every((v, i) => Math.abs(v - sp[i]) < 1);
  return (
    <div className="wi-chart" ref={boxRef}>
      <div className="wi-legend" aria-hidden="true">
        <span><i className="sw plan" />Plan</span>
        {!same && <span><i className="sw what" />What-if</span>}
        {r.floor > 0 && <span><i className="sw floor" />Floor {kfmt(r.floor)}</span>}
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" className="wi-svg"
        aria-label={`Cash by month, plan against the what-if. Plan low ${kfmt(r.plan.low)}, what-if low ${kfmt(r.scenario.low)}.`}
        onPointerMove={move} onPointerLeave={() => setHover(null)}>
        {grid.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} className={v === 0 ? 'wi-zero-line' : 'wi-grid'} />
            <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="wi-axis">{kfmt(v)}</text>
          </g>
        ))}
        {r.floor > 0 && <line x1={pad.l} x2={pad.l + iw} y1={y(r.floor)} y2={y(r.floor)} className="wi-floor" />}
        {months.map((m, i) => (i % labelEvery === 0 ? (
          <text key={i} x={x(i + 1)} y={H - 6} textAnchor="middle" className="wi-axis">{MONTHS[m.month - 1]}{m.month === 1 || i === 0 ? ` ’${String(m.year).slice(2)}` : ''}</text>
        ) : null))}
        <path d={path(pp)} className="wi-line plan" />
        {!same && <path d={path(sp)} className="wi-line what" />}
        <circle cx={x(lowP)} cy={y(pp[lowP])} r="3.5" className="wi-dot plan" />
        {!same && <circle cx={x(lowS)} cy={y(sp[lowS])} r="4" className="wi-dot what" />}
        {at != null && (
          <g className="wi-cross">
            <line x1={x(at)} x2={x(at)} y1={pad.t} y2={pad.t + ih} />
            <circle cx={x(at)} cy={y(pp[at])} r="3.5" className="wi-dot plan" />
            {!same && <circle cx={x(at)} cy={y(sp[at])} r="4" className="wi-dot what" />}
          </g>
        )}
      </svg>
      <div className="wi-readout" aria-live="polite">
        {at != null ? (
          <>
            <strong>End of {MONTHS[months[at - 1].month - 1]} {months[at - 1].year}</strong>
            <span>Plan <b>{money(Math.round(pp[at]))}</b></span>
            {!same && <span>What-if <b>{money(Math.round(sp[at]))}</b></span>}
            {!same && <span><b className={sp[at] - pp[at] >= 0 ? 'good' : 'bad'}>{signedMoney(sp[at] - pp[at])}</b></span>}
          </>
        ) : <span className="wi-muted">Point at a month to compare.</span>}
      </div>
    </div>
  );
}
