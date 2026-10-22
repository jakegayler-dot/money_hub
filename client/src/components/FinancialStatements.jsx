import { Fragment, useEffect, useState } from 'react';
import { money } from '../format.js';

// The income statement (by enterprise) and the statement of cash flows,
// laid out the way an accountant prints them: a heading block, lines,
// a rule above each subtotal and a double rule under the bottom line.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}` : '');
const thisYear = new Date().getFullYear();
const YEARS = Array.from({ length: 6 }, (_, i) => thisYear - i);
const fmt = (v) => (v == null ? '—' : Math.abs(v) < 0.5 ? '—' : v < 0 ? `(${money(Math.round(-v))})` : money(Math.round(v)));

/** Calendar year (with last year beside it) or a custom range. */
export function usePeriod() {
  const [mode, setMode] = useState('year');
  const [year, setYear] = useState(thisYear);
  const [from, setFrom] = useState(`${thisYear}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const query = mode === 'year' ? `year=${year}` : `from=${from}&to=${to}`;
  const control = (
    <span className="fs-period">
      <span className="seg-toggle" role="group" aria-label="Period">
        <button type="button" className={mode === 'year' ? 'on' : ''} aria-pressed={mode === 'year'} onClick={() => setMode('year')}>Calendar year</button>
        <button type="button" className={mode === 'range' ? 'on' : ''} aria-pressed={mode === 'range'} onClick={() => setMode('range')}>Custom dates</button>
      </span>
      {mode === 'year' ? (
        <select aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      ) : (
        <>
          <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="fs-to">to</span>
          <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        </>
      )}
      <button type="button" className="small secondary fs-print" onClick={() => window.print()}>Print</button>
    </span>
  );
  return { query, control, valid: mode === 'year' || (from && to && from <= to) };
}

function useStatement(url, valid) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!valid) return;
    let live = true;
    setData(null);
    fetch(url).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; })
      .then((d) => { if (live) { setData(d); setError(null); } })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [url, valid, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

const periodLabel = (d) => (d.year
  ? `For the year ended December 31, ${d.year}${d.through < d.to ? ` · to ${longDate(d.through)} so far` : ''}`
  : `${longDate(d.from)} to ${longDate(d.through)}`);

// ---- Income statement ------------------------------------------------------------

const COLS = [['grain', 'Grain'], ['livestock', 'Cattle'], ['shared', 'Shared'], ['total', 'Farm']];

export function IncomeStatement() {
  const period = usePeriod();
  const { data, error, reload } = useStatement(`/api/financials/income-statement?${period.query}`, period.valid);
  const prior = data?.prior;
  const priorOf = (section, label, key) => {
    if (!prior) return null;
    const list = key ? prior[section].adjustments : prior[section].lines;
    const hit = list.find((x) => (key ? x.key === key : x.label === label));
    return hit ? hit.total : 0;
  };
  const Row = ({ r, cls = '', priorVal }) => (
    <tr className={cls}>
      <td title={r.detail || (r.items ? r.items.map((i) => `${i.name} ${money(Math.round(i.amount))}`).join('\n') : undefined)}>{r.label}</td>
      {COLS.map(([k]) => <td key={k} className={`num${k === 'total' ? ' fs-total-col' : ''}`}>{fmt(r[k])}</td>)}
      {prior && <td className="num fs-prior">{fmt(priorVal)}</td>}
    </tr>
  );
  const nil = (r, pv) => Math.abs(r.total) < 0.5 && Math.abs(r.grain) < 0.5 && Math.abs(r.livestock) < 0.5 && Math.abs(r.shared) < 0.5 && !(pv && Math.abs(pv) >= 0.5);
  const adjRows = (section) => data[section].adjustments
    .map((r) => [r, priorOf(section, null, r.key)])
    .filter(([r, pv]) => !nil(r, pv))
    .map(([r, pv]) => <Row key={r.key} r={r} cls="fs-adj" priorVal={pv} />);
  const sub = (label, v, pv, cls = 'fs-sub') => <Row r={{ label, ...v }} cls={cls} priorVal={pv} />;
  return (
    <>
      <div className="fs-bar">{period.control}</div>
      {error && <div className="empty-state">Could not build the income statement: {error}</div>}
      {!data && !error && <div className="empty-state">Loading…</div>}
      {data && (
        <div className="panel fs">
          <header className="bs-head">
            <div className="bs-entity">The farm — Grain and Cattle</div>
            <div className="bs-title">Income statement</div>
            <div className="bs-date">{periodLabel(data)} · accrual-adjusted · Canadian dollars</div>
          </header>
          {data.notes.map((n) => n.key === 'no_opening_inventory'
            ? <OpeningCount key={n.key} date={n.date} text={n.text} onSaved={reload} />
            : <p key={n.key} className="pace-warn">{n.text}</p>)}
          <div className="fs-scroll">
            <table className="fs-table" data-nostack="">
              <thead>
                <tr><th />{COLS.map(([k, l]) => <th key={k} className={`num${k === 'total' ? ' fs-total-col' : ''}`}>{l}</th>)}{prior && <th className="num fs-prior">{data.year - 1}</th>}</tr>
              </thead>
              <tbody>
                <tr className="fs-head"><td colSpan={5 + (prior ? 1 : 0)}>Revenue</td></tr>
                {data.revenue.lines.map((r) => <Row key={r.label} r={r} priorVal={priorOf('revenue', r.label)} />)}
                {sub('Cash revenue', data.revenue.cash_total, prior?.revenue.cash_total.total, 'fs-sub fs-quiet')}
                {adjRows('revenue')}
                {sub('Total revenue', data.revenue.total, prior?.revenue.total.total)}

                <tr className="fs-head"><td colSpan={5 + (prior ? 1 : 0)}>Expenses</td></tr>
                {data.expenses.lines.map((r) => <Row key={r.label} r={r} priorVal={priorOf('expenses', r.label)} />)}
                {sub('Cash expenses', data.expenses.cash_total, prior?.expenses.cash_total.total, 'fs-sub fs-quiet')}
                {adjRows('expenses')}
                {sub('Total expenses', data.expenses.total, prior?.expenses.total.total)}

                {sub(data.complete ? 'Net income' : 'Net income before the change in inventory', data.net_income, prior?.net_income.total, 'fs-net')}
                {sub('Cash basis, for comparison', data.cash_net_income, prior?.cash_net_income.total, 'fs-quiet')}
              </tbody>
            </table>
          </div>
          <p className="bs-basis">
            Cash income and expenses follow Income &amp; Expenses: the farm’s share of each entry without its GST; capital purchases and loan principal
            left out; loan interest in. Then adjusted to accrual: inventory on hand (grain and feed, market cattle — breeding stock is a capital asset),
            grain hauled but not paid for, bills received but not paid, interest owed, and depreciation of machinery, buildings and vehicles.
            <b> Shared</b> is the farm’s spending tagged to neither Grain nor Cattle. Household spending isn’t in it. Negative amounts are in brackets.
          </p>
        </div>
      )}
    </>
  );
}

function OpeningCount({ date, text, onSaved }) {
  const [form, setForm] = useState({ grain: '', feed: '', market_cattle: '' });
  const [err, setErr] = useState(null);
  const save = async () => {
    setErr(null);
    const r = await fetch('/api/financials/inventory-count', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, ...form }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setErr(d.error || 'Not saved'); else onSaved();
  };
  return (
    <div className="fs-count">
      <p>{text}</p>
      <div className="fs-count-fields">
        <label>Grain in the bins<input type="number" min="0" step="100" value={form.grain} onChange={(e) => setForm({ ...form, grain: e.target.value })} /></label>
        <label>Feed — hay, straw, silage<input type="number" min="0" step="100" value={form.feed} onChange={(e) => setForm({ ...form, feed: e.target.value })} /></label>
        <label>Market cattle<input type="number" min="0" step="100" value={form.market_cattle} onChange={(e) => setForm({ ...form, market_cattle: e.target.value })} /></label>
        <button type="button" className="small" onClick={save}>Save the {longDate(date)} count</button>
      </div>
      {err && <p className="review-error">{err}</p>}
    </div>
  );
}

// ---- Cash flows ------------------------------------------------------------------

export function CashFlowStatement() {
  const period = usePeriod();
  const { data, error } = useStatement(`/api/financials/cash-flow?${period.query}`, period.valid);
  return (
    <>
      <div className="fs-bar">{period.control}</div>
      {error && <div className="empty-state">Could not build the cash flow statement: {error}</div>}
      {!data && !error && <div className="empty-state">Loading…</div>}
      {data && (
        <div className="panel fs fs-narrow">
          <header className="bs-head">
            <div className="bs-entity">Farm and household, combined — every bank account</div>
            <div className="bs-title">Statement of cash flows</div>
            <div className="bs-date">{periodLabel(data)} · Canadian dollars</div>
          </header>
          <table className="fs-table" data-nostack="">
            <tbody>
              {data.sections.map((s) => (
                <Fragment key={s.key}>
                  <tr className="fs-head"><td colSpan={2}>{s.label}</td></tr>
                  {s.lines.length === 0 && <tr className="fs-quiet"><td>None</td><td className="num">—</td></tr>}
                  {s.lines.map((l) => <tr key={l.key}><td>{l.label}</td><td className="num">{fmt(l.amount)}</td></tr>)}
                  <tr className="fs-sub"><td>Net cash from {s.label.toLowerCase()}</td><td className="num">{fmt(s.total)}</td></tr>
                </Fragment>
              ))}
              <tr className="fs-sub fs-gap"><td>Change in cash</td><td className="num">{fmt(data.net_change)}</td></tr>
              <tr><td>Cash at the start</td><td className="num">{fmt(data.opening_cash)}</td></tr>
              <tr className="fs-net"><td>Cash at the end</td><td className="num">{fmt(data.closing_cash)}</td></tr>
            </tbody>
          </table>
          <p className="bs-basis">
            Every dollar in or out of a bank account in the period is in one line, so the start plus the change is the end
            {data.reconciles ? '' : ' (off by a transfer whose other side falls outside the period)'}. Transfers between your own accounts are left out;
            card purchases show when the card is paid. Loan payments are split into interest (operating) and principal (financing).
          </p>
        </div>
      )}
    </>
  );
}
