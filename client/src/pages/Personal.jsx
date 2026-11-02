import { Fragment, useEffect, useState } from 'react';
import { money } from '../format.js';
import './personalBudget.css';

// Spending & budget (Jake, Nov 1): the household budget month by month against what was spent, where it went by
// category, and the transactions behind each category, editable in place. Jake, Ashley or both.
// Budget lines and their totals come from lib/householdBudget.js.

const WHO = [['both', 'Both'], ['jake', 'Jake'], ['ashley', 'Ashley']];
const WHOSE = [['jake', 'Jake'], ['ashley', 'Ashley'], ['both', 'Jake & Ashley']];
const OWNER = {
  jake: { segment: 'jake', is_segment_split: false },
  ashley: { segment: 'ashley', is_segment_split: false },
  both: { is_segment_split: true, segment_grain_pct: 0, segment_livestock_pct: 0, segment_jake_pct: 50, segment_ashley_pct: 50 },
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longMonth = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
const shift = (k, n) => { const d = new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const over = (budget, spent) => spent - budget;

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

function Bar({ budget, spent }) {
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : spent > 0 ? 100 : 0;
  return <span className="pb-bar"><span className={spent > budget ? 'over' : ''} style={{ width: `${pct}%` }} /></span>;
}

/** A budget amount typed in place; saved on Enter or leaving the box. */
function BudgetCell({ line, month, onSaved, onError }) {
  const [v, setV] = useState(String(line.budget));
  useEffect(() => setV(String(line.budget)), [line.budget]);
  const save = async (amount) => {
    if (amount !== null && Number(amount) === line.budget) return;
    try { await call('PUT', '/api/personal/budget-lines', { key: line.key, amount, from_month: month }); onSaved(); }
    catch (e) { onError(e.message); setV(String(line.budget)); }
  };
  return (
    <span className="pb-budget" onClick={(e) => e.stopPropagation()}>
      $<input type="number" min="0" step="10" value={v} aria-label={`${line.label} budget`}
        onChange={(e) => setV(e.target.value)} onBlur={() => v !== '' && save(Number(v))}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setV(String(line.budget)); e.currentTarget.blur(); } }} />
      {line.set && <button type="button" className="pb-reset" title="Back to the standard share of Cash Flow's total" onClick={() => save(null)}>↺</button>}
    </span>
  );
}

/** One transaction, editable in place. */
function Entry({ e, categories, onChanged, onError }) {
  const [f, setF] = useState({ date: e.date, description: e.description, amount: String(Math.abs(e.tx_amount)) });
  useEffect(() => setF({ date: e.date, description: e.description, amount: String(Math.abs(e.tx_amount)) }), [e]);
  const patch = async (body) => {
    try { await call('PATCH', `/api/transactions/${e.id}`, body); onChanged(); }
    catch (err) { onError(err.message); setF({ date: e.date, description: e.description, amount: String(Math.abs(e.tx_amount)) }); }
  };
  const del = async () => {
    if (!window.confirm(`Delete "${e.description || e.payee || 'this entry'}"? It comes off its account too.`)) return;
    try { await call('DELETE', `/api/transactions/${e.id}`); onChanged(); } catch (err) { onError(err.message); }
  };
  const locked = e.split;
  return (
    <tr className="pb-entry">
      <td><input type="date" value={f.date} disabled={locked} onChange={(x) => setF({ ...f, date: x.target.value })} onBlur={() => f.date && f.date !== e.date && patch({ date: f.date })} /></td>
      <td><input type="text" value={f.description} disabled={locked} placeholder={e.payee || ''} onChange={(x) => setF({ ...f, description: x.target.value })}
        onBlur={() => f.description !== e.description && patch({ description: f.description })} /></td>
      <td>
        <select value={e.category_id || ''} disabled={locked} onChange={(x) => patch({ category_id: x.target.value ? Number(x.target.value) : null })}>
          {!e.category_id && <option value="">Uncategorized</option>}
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </td>
      <td>
        <select value={['jake', 'ashley', 'both'].includes(e.whose) ? e.whose : ''} disabled={locked} onChange={(x) => x.target.value && patch(OWNER[x.target.value])}>
          {!['jake', 'ashley', 'both'].includes(e.whose) && <option value="">{e.whose === 'mixed' ? 'Shared with the farm' : 'Not tagged'}</option>}
          {WHOSE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </td>
      <td className="num"><input type="number" step="0.01" min="0" className="num" value={f.amount} disabled={locked} onChange={(x) => setF({ ...f, amount: x.target.value })}
        onBlur={() => { const n = Number(f.amount); if (n > 0 && Math.abs(n - Math.abs(e.tx_amount)) > 0.001) patch({ amount: e.tx_amount < 0 ? -n : n }); }} /></td>
      <td><button type="button" className="pb-del" aria-label="Delete" title={locked ? 'Split entry: change it on the Transactions page' : 'Delete'} disabled={locked} onClick={del}>×</button></td>
    </tr>
  );
}

export default function Personal() {
  const [who, setWho] = useState('both');
  const [month, setMonth] = useState(null);
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(null);
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState(null);

  const load = () => fetch(`/api/personal/budget-view?who=${who}${month ? `&month=${month}` : ''}`).then((r) => r.json())
    .then((x) => (x.error ? setErr(x.error) : setD(x))).catch((e) => setErr(e.message));
  const loadEntries = (line = open) => {
    if (!line || !d) return;
    fetch(`/api/personal/budget-view/entries?month=${d.month}&line=${line}&who=${who}`).then((r) => r.json())
      .then((x) => setEntries(Array.isArray(x) ? x : [])).catch(() => setEntries([]));
  };
  useEffect(() => { load(); }, [who, month]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setEntries(null); if (open) loadEntries(open); }, [open, d?.month, who]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = () => { setErr(null); load(); loadEntries(); };

  if (!d) return err ? <div className="empty-state">{err}</div> : <div className="empty-state">Loading…</div>;
  const both = who === 'both';
  const t = d.total;
  const isLatest = d.month === d.today.slice(0, 7);

  return (
    <div className="pb">
      <div className="page-header">
        <h1 className="page-title">Spending & budget</h1>
        <span className="seg-toggle" role="group" aria-label="Whose spending" style={{ marginLeft: 'auto' }}>
          {WHO.map(([k, l]) => <button key={k} type="button" aria-pressed={who === k} className={who === k ? 'on' : ''} onClick={() => setWho(k)}>{l}</button>)}
        </span>
      </div>
      {err && <p className="review-error" style={{ margin: '0 0 12px' }}>{err}</p>}

      <section className="panel">
        <div className="panel-header">{d.month.slice(0, 4)}, month by month</div>
        <table className="pb-table" data-nostack="">
          <thead><tr><th>Month</th>{both && <th className="num">Budget</th>}<th className="num">Spent</th>{both && <th className="num">Over / under</th>}{both && <th className="pb-barcol" />}</tr></thead>
          <tbody>
            {d.months.map((m) => {
              const o = over(m.budget, m.spent);
              return (
                <tr key={m.month} className={`pb-row${m.month === d.month ? ' on' : ''}`} onClick={() => { setOpen(null); setMonth(m.month); }}>
                  <td>{m.label}{m.current ? ' (so far)' : ''}</td>
                  {both && <td className="num">{money(m.budget)}</td>}
                  <td className="num">{money(m.spent)}</td>
                  {both && <td className={`num${o > 0 ? ' neg' : ''}`}>{o > 0 ? `${money(o)} over` : `${money(-o)} under`}</td>}
                  {both && <td className="pb-barcol"><Bar budget={m.budget} spent={m.spent} /></td>}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {(() => { const b = d.months.reduce((a, m) => a + m.budget, 0); const s = d.months.reduce((a, m) => a + m.spent, 0); const o = s - b; return (
              <tr><td>Year so far</td>{both && <td className="num">{money(b)}</td>}<td className="num">{money(s)}</td>{both && <td className={`num${o > 0 ? ' neg' : ''}`}>{o > 0 ? `${money(o)} over` : `${money(-o)} under`}</td>}{both && <td />}</tr>
            ); })()}
          </tfoot>
        </table>
      </section>

      <section className="panel">
        <div className="panel-header pb-month-head">
          <button type="button" className="pb-arrow" aria-label="Previous month" onClick={() => { setOpen(null); setMonth(shift(d.month, -1)); }}>‹</button>
          <span>{longMonth(d.month)}</span>
          <button type="button" className="pb-arrow" aria-label="Next month" disabled={isLatest} onClick={() => { setOpen(null); setMonth(shift(d.month, 1)); }}>›</button>
          <span className="pb-sum">{both ? `${money(t.spent)} of ${money(t.budget)} · ${t.spent > t.budget ? `${money(t.spent - t.budget)} over` : `${money(t.budget - t.spent)} left`}` : `${money(t.spent)} spent`}</span>
        </div>
        <table className="pb-table" data-nostack="">
          <thead><tr><th>Category</th>{both && <th className="num">Budget</th>}<th className="num">Spent</th>{both && <th className="num">Left</th>}{both && <th className="pb-barcol" />}</tr></thead>
          <tbody>
            {d.lines.filter((l) => both || l.spent > 0.005).map((l) => {
              const left = l.budget - l.spent;
              const isOpen = open === l.key;
              return (
                <Fragment key={l.key}>
                  <tr className={`pb-row${isOpen ? ' on' : ''}`} onClick={() => setOpen(isOpen ? null : l.key)}>
                    <td><span className="pb-caret">{isOpen ? '▾' : '▸'}</span>{l.label}</td>
                    {both && <td className="num"><BudgetCell line={l} month={d.month} onSaved={changed} onError={setErr} /></td>}
                    <td className="num">{money(l.spent)}</td>
                    {both && <td className={`num${left < 0 ? ' neg' : ''}`}>{money(left)}</td>}
                    {both && <td className="pb-barcol"><Bar budget={l.budget} spent={l.spent} /></td>}
                  </tr>
                  {isOpen && (
                    <tr className="pb-detail"><td colSpan={both ? 5 : 2}>
                      {entries == null ? <p className="pb-empty">Loading…</p> : entries.length === 0 ? <p className="pb-empty">Nothing spent here in {longMonth(d.month)}.</p> : (
                        <table className="pb-entries" data-nostack="">
                          <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Whose</th><th className="num">Amount</th><th /></tr></thead>
                          <tbody>{entries.map((e) => <Entry key={e.id} e={e} categories={d.categories} onChanged={changed} onError={setErr} />)}</tbody>
                        </table>
                      )}
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot><tr><td>Total</td>{both && <td className="num">{money(t.budget)}</td>}<td className="num">{money(t.spent)}</td>{both && <td className={`num${t.spent > t.budget ? ' neg' : ''}`}>{money(t.budget - t.spent)}</td>}{both && <td />}</tr></tfoot>
        </table>
      </section>
    </div>
  );
}
