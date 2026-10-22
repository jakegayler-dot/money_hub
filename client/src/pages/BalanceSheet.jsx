import { Fragment, useEffect, useState } from 'react';
import { money } from '../format.js';
import { OWNER_KEYS, OWNER_LABELS } from '../owners.jsx';

// The balance sheet as an accountant lays it out: assets on the left,
// liabilities and equity on the right, current before long-term, a rule
// above each subtotal and a double rule under the totals. Click a line to
// see what's in it.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}` : '');
const ENTITIES = [['all', 'Combined'], ...OWNER_KEYS.map((k) => [k, OWNER_LABELS[k]])];

// What lenders read off it, and where a farm lender starts to worry.
const RATIOS = [
  { key: 'working_capital', label: 'Working capital', fmt: (v) => money(Math.round(v)), note: 'Current assets − current liabilities' },
  { key: 'current_ratio', label: 'Current ratio', fmt: (v) => (v == null ? '—' : `${v.toFixed(2)}`), note: 'Lenders like 1.5 or better', ok: (v) => v == null || v >= 1.5, warn: (v) => v != null && v < 1 },
  { key: 'debt_to_asset', label: 'Debt to assets', fmt: (v) => (v == null ? '—' : `${Math.round(v * 100)}%`), note: 'Under 40% is strong', ok: (v) => v == null || v < 0.4, warn: (v) => v != null && v > 0.6 },
  { key: 'debt_to_equity', label: 'Debt to equity', fmt: (v) => (v == null ? '—' : `${v.toFixed(2)}`), note: 'Under 0.67 is strong', ok: (v) => v == null || v < 0.67, warn: (v) => v == null || v > 1.5 },
];

export default function BalanceSheet({ embedded = false }) {
  const [entity, setEntity] = useState(() => {
    const e = new URLSearchParams(window.location.search).get('entity');
    return ENTITIES.some(([k]) => k === e) ? e : 'all';
  });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState({});

  useEffect(() => {
    setData(null);
    fetch(`/api/balance-sheet?entity=${entity}`)
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message));
    const base = embedded ? '/financials?tab=balance' : '/balance-sheet';
    window.history.replaceState(null, '', entity === 'all' ? base : `${base}${embedded ? '&' : '?'}entity=${entity}`);
  }, [entity]);

  const sec = (k) => data?.sections.find((s) => s.key === k);
  const toggle = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const t = data?.totals;

  return (
    <>
      <div className={embedded ? 'fs-bar' : 'page-header'}>
        {!embedded && <h1 className="page-title">Balance Sheet</h1>}
        <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="seg-toggle" role="group" aria-label="Whose balance sheet">
            {ENTITIES.map(([k, l]) => <button key={k} type="button" aria-pressed={entity === k} className={entity === k ? 'on' : ''} onClick={() => setEntity(k)}>{l}</button>)}
          </span>
          <button type="button" className="small secondary bs-print" onClick={() => window.print()}>Print</button>
        </span>
      </div>

      {error && <div className="empty-state">Could not load the balance sheet: {error}</div>}
      {!data && !error && <div className="empty-state">Loading…</div>}

      {data && (
        <div className="panel bs">
          <header className="bs-head">
            <div className="bs-entity">{entity === 'all' ? 'Farm and household, combined' : OWNER_LABELS[entity]}</div>
            <div className="bs-title">Balance sheet</div>
            <div className="bs-date">As at {longDate(data.as_of)} · market value · Canadian dollars</div>
          </header>

          <div className="bs-cols">
            <section className="bs-col" aria-label="Assets">
              <h2 className="bs-side">Assets</h2>
              <Section s={sec('current_assets')} open={open} toggle={toggle} />
              <Section s={sec('longterm_assets')} open={open} toggle={toggle} />
              <Total label="Total assets" value={t.total_assets} />
            </section>

            <section className="bs-col" aria-label="Liabilities and equity">
              <h2 className="bs-side">Liabilities and equity</h2>
              <Section s={sec('current_liabilities')} open={open} toggle={toggle} empty="No current liabilities" />
              <Section s={sec('longterm_liabilities')} open={open} toggle={toggle} empty="No long-term debt" />
              <div className="bs-row bs-subtotal"><span>Total liabilities</span><span className="bs-num">{money(Math.round(t.total_liabilities))}</span></div>
              <div className="bs-group">
                <div className="bs-group-label">Equity</div>
                <div className="bs-row"><span>Owner’s equity</span><span className={`bs-num${t.equity < 0 ? ' neg' : ''}`}>{money(Math.round(t.equity))}</span></div>
              </div>
              <Total label="Total liabilities and equity" value={t.total_liabilities + t.equity} />
            </section>
          </div>

          <div className="bs-ratios">
            {RATIOS.map((r) => {
              const v = data.ratios[r.key];
              const tone = r.warn?.(v) ? 'warn' : r.ok && !r.ok(v) ? 'tight' : '';
              return (
                <div key={r.key} className={`bs-ratio ${tone}`}>
                  <span className="bs-ratio-label">{r.label}</span>
                  <span className="bs-ratio-val">{r.fmt(v)}</span>
                  <span className="bs-ratio-note">{r.note}</span>
                </div>
              );
            })}
          </div>

          {data.notes.length > 0 && (
            <ul className="bs-notes">{data.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          )}
          <p className="bs-basis">
            Accrual basis: delivered grain not yet paid is a receivable; grain under an open contract stays in inventory at the contract price;
            bills count once received; loans are owed until a payment is recorded as paid, with interest accrued to today. Capital assets at
            today’s value from each asset’s yearly change. Income tax is not included.
          </p>
        </div>
      )}
    </>
  );
}

function Section({ s, open, toggle, empty }) {
  if (!s) return null;
  return (
    <div className="bs-group">
      <div className="bs-group-label">{s.label}</div>
      {s.lines.length === 0 && <div className="bs-row bs-none"><span>{empty || 'None'}</span><span className="bs-num">—</span></div>}
      {s.lines.map((l) => {
        const isOpen = !!open[l.key];
        return (
          <Fragment key={l.key}>
            <button type="button" className="bs-row bs-line" aria-expanded={isOpen} onClick={() => toggle(l.key)}>
              <span><span className="bs-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>{l.label}</span>
              <span className="bs-num">{money(Math.round(l.amount))}</span>
            </button>
            {isOpen && (
              <ul className="bs-items">
                {l.items.map((it, i) => <li key={i}><span>{it.name}</span><span className="bs-num">{money(Math.round(it.amount))}</span></li>)}
              </ul>
            )}
          </Fragment>
        );
      })}
      {s.lines.length > 0 && <div className="bs-row bs-subtotal"><span>Total {s.label.toLowerCase()}</span><span className="bs-num">{money(Math.round(s.total))}</span></div>}
    </div>
  );
}

function Total({ label, value }) {
  return <div className="bs-row bs-total"><span>{label}</span><span className="bs-num">{money(Math.round(value))}</span></div>;
}
