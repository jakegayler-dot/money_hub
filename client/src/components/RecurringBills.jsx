import { useEffect, useState } from 'react';
import { money } from '../format.js';
import { ownerSummary } from '../owners.jsx';

// Every recurring bill the cash flow forecast repeats (Jake, 2026-10-24:
// "a viewer that shows all the recurring bills used in the cash flow
// forecast and a way to edit them"). The forecast takes each unpaid bill
// with a cycle and repeats it from its next due date (lib/billDates.js);
// this shows exactly those, what each adds up to over the next 12 months,
// and lets the amount, cycle and next date be changed in place.
const CYCLES = { monthly: ['Monthly', 1], quarterly: ['Quarterly', 3], annual: ['Yearly', 12] };
const iso = (d) => d.toISOString().slice(0, 10);
const addMonths = (s, n) => { const [y, m, d] = s.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(d, last)); return iso(t); };

/** How many times the forecast counts it in the next 12 months (same rule as the server's billDates). */
function timesAhead(b, today) {
  const end = addMonths(`${today.slice(0, 7)}-01`, 12); // Cash Flow's window: this month and the 11 after it
  const first = String(b.due_date).slice(0, 10);
  if (first >= end) return 0;
  const step = CYCLES[b.frequency]?.[1];
  let n = 1;
  for (let k = 1; step && k < 600; k++) {
    const d = addMonths(first, k * step);
    if (d >= end) break;
    if (d > today) n++;
  }
  return n;
}

function Row({ b, today, onSaved, max }) {
  const [status, setStatus] = useState(null);
  const save = async (patch) => {
    setStatus('saving');
    const r = await fetch(`/api/bills/${b.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setStatus(d.error || 'Not saved'); return; }
    setStatus('saved'); onSaved();
    setTimeout(() => setStatus((s) => (s === 'saved' ? null : s)), 1500);
  };
  const step = CYCLES[b.frequency]?.[1] || 1;
  const amt = Number(b.amount);
  const year = amt * timesAhead(b, today);
  const overdue = String(b.due_date).slice(0, 10) < today;
  return (
    <tr className={overdue ? 'rb-overdue' : ''}>
      <td>
        <div className="rb-name">{b.name}</div>
        <div className="split-lines">{[b.vendor && !b.name.includes(b.vendor) ? b.vendor : null, b.category_full || b.category, ownerSummary(b)].filter(Boolean).join(' · ')}</div>
      </td>
      <td>
        <input className="rb-amt" type="number" step="0.01" min="0" defaultValue={amt.toFixed(2)} aria-label={`Amount for ${b.name}`}
          onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && Math.abs(v - amt) > 0.004) save({ amount: v }); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      </td>
      <td>
        <select value={b.frequency} aria-label={`How often ${b.name} repeats`}
          onChange={(e) => {
            if (e.target.value === 'one_time' && !window.confirm(`Stop repeating "${b.name}"? It stays as one bill on ${String(b.due_date).slice(0, 10)}.`)) { e.target.value = b.frequency; return; }
            save({ frequency: e.target.value });
          }}>
          {Object.entries(CYCLES).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
          <option value="one_time">Stop repeating</option>
        </select>
      </td>
      <td>
        <input type="date" defaultValue={String(b.due_date).slice(0, 10)} aria-label={`Next due date for ${b.name}`}
          onBlur={(e) => { if (e.target.value && e.target.value !== String(b.due_date).slice(0, 10)) save({ due_date: e.target.value }); }} />
        {overdue && <div className="rb-flag">Overdue — counted now</div>}
      </td>
      <td className="num">{money(amt / step)}</td>
      <td className="num rb-year">
        <span>{money(year)}</span>
        <span className="rb-bar" aria-hidden="true"><span style={{ width: `${max ? Math.max(2, (year / max) * 100) : 0}%` }} /></span>
      </td>
      <td className="rb-status">
        {status === 'saving' ? <span className="split-lines">Saving…</span>
          : status === 'saved' ? <span className="rb-saved">Saved</span>
          : status ? <span className="review-error">{status}</span> : null}
      </td>
    </tr>
  );
}

export default function RecurringBills({ refreshKey, onChanged }) {
  const [bills, setBills] = useState(null);
  const [open, setOpen] = useState(true);
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const load = () => fetch('/api/bills?status=unpaid').then((r) => r.json()).then((d) => setBills(Array.isArray(d) ? d : [])).catch(() => setBills([]));
  useEffect(() => { load(); }, [refreshKey]);
  if (!bills) return null;
  const list = bills.filter((b) => CYCLES[b.frequency])
    .sort((a, b) => Number(b.amount) / CYCLES[b.frequency][1] - Number(a.amount) / CYCLES[a.frequency][1]);
  const monthly = list.reduce((a, b) => a + Number(b.amount) / CYCLES[b.frequency][1], 0);
  const years = list.map((b) => Number(b.amount) * timesAhead(b, today));
  const year = years.reduce((a, v) => a + v, 0);
  const max = Math.max(0, ...years);

  return (
    <div className="panel rb">
      <div className="panel-header spend-header">
        <span>Recurring bills in the cash flow forecast</span>
        <button type="button" className="small-link" onClick={() => setOpen(!open)}>{open ? 'Hide' : `Show ${list.length}`}</button>
      </div>
      {open && (list.length === 0 ? (
        <div className="empty-state">No recurring bills. Add one below with a cycle, or add one the Calendar found in your ledger.</div>
      ) : (
        <>
          <div className="rb-totals">
            <div><span className="split-lines">Recurring bills</span><strong>{list.length}</strong></div>
            <div><span className="split-lines">About a month</span><strong>{money(monthly)}</strong></div>
            <div><span className="split-lines">In Cash Flow's 12 months</span><strong>{money(year)}</strong></div>
          </div>
          <p>Each is repeated on its cycle from its next due date. Change the amount, the cycle or the next date here and Cash Flow follows; "Stop repeating" leaves it as a single bill. Everything else about a bill is under Edit in the list below.</p>
          <div className="rb-wrap">
            <table className="rb-table">
              <thead><tr><th>Bill</th><th>Amount</th><th>Every</th><th>Next due</th><th className="num">A month</th><th className="num">In Cash Flow's 12 months</th><th /></tr></thead>
              <tbody>{list.map((b) => <Row key={`${b.id}-${b.amount}-${b.due_date}-${b.frequency}`} b={b} today={today} max={max} onSaved={() => { load(); onChanged?.(); }} />)}</tbody>
              <tfoot><tr><td>Total</td><td /><td /><td /><td className="num">{money(monthly)}</td><td className="num">{money(year)}</td><td /></tr></tfoot>
            </table>
          </div>
        </>
      ))}
    </div>
  );
}
