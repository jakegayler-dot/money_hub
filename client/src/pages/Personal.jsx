import { Fragment, useEffect, useState } from 'react';
import { money } from '../format.js';
import './personalBudget.css';

// Spending & budget (Jake, Nov 1): the budget month by month against what was spent, where it went by category, and the
// transactions behind each category, editable in place. Jake, Ashley or both. Everything the cash flow forecast doesn't already plan (Nov 16): farm and home, capital buys included.
// Laid out as an infographic (Nov 15: "You have the most important information at the bottom of the page and no
// infographics"): the month's figures first, then where it went on one scale, then the year as columns.
// Budget lines and their totals come from lib/householdBudget.js.

const WHO = [['both', 'Both'], ['jake', 'Jake'], ['ashley', 'Ashley']];
const WHOSE = [['jake', 'Jake'], ['ashley', 'Ashley'], ['both', 'Jake & Ashley'], ['grain', 'Farm: grain'], ['livestock', 'Farm: cattle']];
const WHOSE_KEYS = WHOSE.map(([k]) => k);
const OWNER = {
  grain: { segment: 'grain', is_segment_split: false },
  livestock: { segment: 'livestock', is_segment_split: false },
  jake: { segment: 'jake', is_segment_split: false },
  ashley: { segment: 'ashley', is_segment_split: false },
  both: { is_segment_split: true, segment_grain_pct: 0, segment_livestock_pct: 0, segment_jake_pct: 50, segment_ashley_pct: 50 },
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longMonth = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;
const shift = (k, n) => { const d = new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };

async function call(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return {};
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
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
        <select value={WHOSE_KEYS.includes(e.whose) ? e.whose : ''} disabled={locked} onChange={(x) => x.target.value && patch(OWNER[x.target.value])}>
          {!WHOSE_KEYS.includes(e.whose) && <option value="">{e.whose === 'mixed' ? 'Split farm / household' : 'Not tagged'}</option>}
          {WHOSE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </td>
      <td className="num"><input type="number" step="0.01" min="0" className="num" value={f.amount} disabled={locked} onChange={(x) => setF({ ...f, amount: x.target.value })}
        onBlur={() => { const n = Number(f.amount); if (n > 0 && Math.abs(n - Math.abs(e.tx_amount)) > 0.001) patch({ amount: e.tx_amount < 0 ? -n : n }); }} /></td>
      <td><button type="button" className="pb-del" aria-label="Delete" title={locked ? 'Split entry: change it on the Transactions page' : 'Delete'} disabled={locked} onClick={del}>×</button></td>
    </tr>
  );
}

const DAY_MS = 86400000;
const pctOf = (v, max) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);
const overText = (budget, spent) => (spent > budget ? `${money(spent - budget)} over` : `${money(budget - spent)} left`);

/** A line's bar on the page's common scale: what's spent, and a tick where its budget is. */
function ScaleBar({ budget, spent, max, showBudget }) {
  return (
    <span className="pb-track" aria-hidden="true">
      <span className={`pb-fill${showBudget && spent > budget ? ' over' : ''}`} style={{ width: `${pctOf(spent, max)}%` }} />
      {showBudget && budget > 0 && <span className="pb-tick" style={{ left: `${pctOf(budget, max)}%` }} />}
    </span>
  );
}

/** The year's months as columns: home and farm stacked, a tick at each month's budget. A tap picks the month. */
function YearChart({ months, sel, showBudget, onPick }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(1, ...months.map((m) => Math.max(m.spent, showBudget ? m.budget : 0)));
  const hasFarm = months.some((m) => m.farm > 0.005);
  const tip = hover && months.find((m) => m.month === hover);
  return (
    <div className="pb-year">
      {hasFarm && (
        <div className="pb-legend">
          <span><i className="sw home" />Home</span><span><i className="sw farm" />Farm</span>
          {showBudget && <span><i className="sw tick" />Budget</span>}
        </div>
      )}
      <div className="pb-cols" onMouseLeave={() => setHover(null)}>
        {months.map((m) => {
          const home = Math.max(0, m.spent - m.farm);
          return (
            <button key={m.month} type="button" className={`pb-col${m.month === sel ? ' on' : ''}`}
              aria-label={`${m.label}: ${money(m.spent)} spent${showBudget ? `, budget ${money(m.budget)}` : ''}`}
              onMouseEnter={() => setHover(m.month)} onFocus={() => setHover(m.month)} onClick={() => onPick(m.month)}>
              <span className="pb-colplot">
                {m.month === sel && m.spent > 0 && <span className="pb-colval" style={{ bottom: `${pctOf(m.spent, max)}%` }}>{money(m.spent)}</span>}
                <span className="pb-stack" style={{ height: `${pctOf(m.spent, max)}%` }}>
                  {m.farm > 0.005 && <span className="seg farm" style={{ flexGrow: m.farm }} />}
                  {home > 0.005 && <span className="seg home" style={{ flexGrow: home }} />}
                </span>
                {showBudget && m.budget > 0 && <span className="pb-coltick" style={{ bottom: `${pctOf(m.budget, max)}%` }} />}
              </span>
              <span className="pb-collabel">{m.label.slice(0, 3)}</span>
            </button>
          );
        })}
      </div>
      {tip && (
        <div className="pb-tip">
          <b>{tip.label}{tip.current ? ' (so far)' : ''}</b>
          <span>Spent {money(tip.spent)}{tip.farm > 0.005 ? ` · farm ${money(tip.farm)} · home ${money(tip.spent - tip.farm)}` : ''}</span>
          {showBudget && <span>Budget {money(tip.budget)} · <span className={tip.spent > tip.budget ? 'neg' : ''}>{overText(tip.budget, tip.spent)}</span></span>}
        </div>
      )}
    </div>
  );
}

export default function Personal() {
  const [who, setWho] = useState('both');
  const [month, setMonth] = useState(null);
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(null);
  const [entries, setEntries] = useState(null);
  const [openCat, setOpenCat] = useState(null);
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
  const pick = (m) => { setOpen(null); setMonth(m); };
  const sel = d.months.find((m) => m.month === d.month) || { current: false };
  const isOver = both && t.spent > t.budget;
  const gaugeMax = Math.max(t.spent, both ? t.budget : 0, 1);
  const [yy, mm] = d.month.split('-').map(Number);
  const daysLeft = sel.current ? Math.round((Date.UTC(yy, mm, 1) - Date.UTC(yy, mm - 1, Number(d.today.slice(8, 10)))) / DAY_MS) - 1 : null;
  const ytd = { budget: d.months.reduce((a, m) => a + m.budget, 0), spent: d.months.reduce((a, m) => a + m.spent, 0), farm: d.months.reduce((a, m) => a + m.farm, 0) };
  const withSpend = d.months.filter((m) => m.spent > 0.005 && !m.current);
  const home = Math.max(0, t.spent - (t.farm || 0));
  const lines = d.lines.filter((l) => l.spent > 0.005 || (both && l.budget > 0)).sort((a, b) => b.spent - a.spent || b.budget - a.budget);
  const lineMax = Math.max(1, ...lines.map((l) => Math.max(l.spent, both ? l.budget : 0)));
  const cols = both ? 5 : 3;

  return (
    <div className="pb">
      <div className="page-header pb-head">
        <h1 className="page-title">Spending & budget</h1>
        <span className="pb-monthnav">
          <button type="button" className="pb-arrow" aria-label="Previous month" onClick={() => pick(shift(d.month, -1))}>‹</button>
          <span>{longMonth(d.month)}</span>
          <button type="button" className="pb-arrow" aria-label="Next month" disabled={isLatest} onClick={() => pick(shift(d.month, 1))}>›</button>
        </span>
        <span className="seg-toggle" role="group" aria-label="Whose spending">
          {WHO.map(([k, l]) => <button key={k} type="button" aria-pressed={who === k} className={who === k ? 'on' : ''} onClick={() => setWho(k)}>{l}</button>)}
        </span>
      </div>
      {err && <p className="review-error" style={{ margin: '0 0 12px' }}>{err}</p>}

      <div className="pb-tiles">
        <section className="panel pb-tile pb-hero">
          <div className="pb-tlabel">{MONTHS[mm - 1]}{sel.current ? ' so far' : ''}</div>
          <div className="pb-big">{money(t.spent)}</div>
          <div className="pb-tsub">{both ? <>spent of <b>{money(t.budget)}</b> budget</> : 'spent'}</div>
          {both && (
            <>
              <span className="pb-gauge" aria-hidden="true">
                <span className={`pb-fill${isOver ? ' over' : ''}`} style={{ width: `${pctOf(t.spent, gaugeMax)}%` }} />
                {t.budget > 0 && <span className="pb-tick" style={{ left: `${pctOf(t.budget, gaugeMax)}%` }} />}
              </span>
              <div className="pb-status">
                <span className={isOver ? 'neg' : 'pos'}>{isOver ? '▲' : '▼'} {overText(t.budget, t.spent)}</span>
                {daysLeft != null && <span className="pb-muted">{daysLeft} {daysLeft === 1 ? 'day' : 'days'} to go</span>}
              </div>
            </>
          )}
        </section>

        {both && (
          <section className="panel pb-tile">
            <div className="pb-tlabel">Farm and home</div>
            {t.spent > 0.005 ? (
              <>
                <span className="pb-split" aria-hidden="true">
                  {t.farm > 0.005 && <span className="seg farm" style={{ flexGrow: t.farm }} />}
                  {home > 0.005 && <span className="seg home" style={{ flexGrow: home }} />}
                </span>
                <div className="pb-keys">
                  <div><i className="sw farm" /><span>Farm</span><b>{money(t.farm || 0)}</b><em>{Math.round(pctOf(t.farm || 0, t.spent))}%</em></div>
                  <div><i className="sw home" /><span>Home</span><b>{money(home)}</b><em>{Math.round(pctOf(home, t.spent))}%</em></div>
                </div>
                <div className="pb-muted pb-note">Bills, loans and rent are in the cash flow forecast; everything else is here.</div>
              </>
            ) : <div className="pb-muted">Nothing spent yet.</div>}
          </section>
        )}

        <section className="panel pb-tile">
          <div className="pb-tlabel">{yy} so far</div>
          <div className="pb-big sm">{money(ytd.spent)}</div>
          <div className="pb-tsub">{both ? <>of <b>{money(ytd.budget)}</b> · <span className={ytd.spent > ytd.budget ? 'neg' : 'pos'}>{overText(ytd.budget, ytd.spent)}</span></> : 'spent'}</div>
          {withSpend.length > 0 && (
            <div className="pb-muted pb-note">
              A full month averages {money(withSpend.reduce((a, m) => a + m.spent, 0) / withSpend.length)}
              {both && ytd.farm > 0.005 ? ` · farm ${money(ytd.farm)} of the year` : ''}
            </div>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-header pb-ph">
          <span>Where it went</span>
          <span className="pb-sum">{both ? 'Tap a line for its entries · type a budget to change it' : 'Tap a line for its entries'}</span>
        </div>
        <table className="pb-table" data-nostack="">
          <thead><tr><th>Line</th><th className="pb-barcol" /><th className="num">Spent</th>{both && <th className="num">Budget</th>}{both && <th className="num pb-left">Left</th>}</tr></thead>
          <tbody>
            {lines.map((l) => {
              const left = l.budget - l.spent;
              const isOpen = open === l.key;
              return (
                <Fragment key={l.key}>
                  <tr className={`pb-row${isOpen ? ' on' : ''}`} onClick={() => { setOpenCat(null); setOpen(isOpen ? null : l.key); }}>
                    <td><span className="pb-caret">{isOpen ? '▾' : '▸'}</span>{l.label}
                      {both && l.farm > 0.005 && <div className="pb-subl">farm {money(l.farm)}</div>}</td>
                    <td className="pb-barcol"><ScaleBar budget={l.budget} spent={l.spent} max={lineMax} showBudget={both} /></td>
                    <td className="num">{money(l.spent)}</td>
                    {both && <td className="num"><BudgetCell line={l} month={d.month} onSaved={changed} onError={setErr} /></td>}
                    {both && <td className={`num pb-left${left < 0 ? ' neg' : ''}`}>{money(left)}</td>}
                  </tr>
                  {isOpen && l.categories.length === 0 && (
                    <tr className="pb-detail"><td colSpan={cols}><p className="pb-empty">Nothing spent here in {longMonth(d.month)}.</p></td></tr>
                  )}
                  {isOpen && l.categories.map((c) => {
                    const catOpen = openCat === c.name;
                    const mine = (entries || []).filter((e) => e.category === c.name);
                    return (
                      <Fragment key={c.name}>
                        <tr className={`pb-row pb-cat${catOpen ? ' on' : ''}`} onClick={() => setOpenCat(catOpen ? null : c.name)}>
                          <td><span className="pb-caret">{catOpen ? '▾' : '▸'}</span>{c.name}</td>
                          <td className="pb-barcol" />
                          <td className="num">{money(c.spent)}</td>
                          {both && <td />}{both && <td className="pb-left" />}
                        </tr>
                        {catOpen && (
                          <tr className="pb-detail"><td colSpan={cols}>
                            {entries == null ? <p className="pb-empty">Loading…</p> : (
                              <table className="pb-entries" data-nostack="">
                                <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Whose</th><th className="num">Amount</th><th /></tr></thead>
                                <tbody>{mine.map((e) => <Entry key={e.id} e={e} categories={d.categories} onChanged={changed} onError={setErr} />)}</tbody>
                              </table>
                            )}
                          </td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
            {lines.length === 0 && <tr><td colSpan={cols}><p className="pb-empty">Nothing spent in {longMonth(d.month)}.</p></td></tr>}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="panel-header pb-ph">
          <span>{yy}, month by month</span>
          <span className="pb-sum">Tap a month to see it</span>
        </div>
        <YearChart months={d.months} sel={d.month} showBudget={both} onPick={pick} />
      </section>
    </div>
  );
}
