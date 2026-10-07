import { useEffect, useState } from 'react';
import { cents } from '../components/SplitEditor.jsx';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FREQ = { monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Yearly' };
const KIND = { bill: 'Bill', loan: 'Loan', card: 'Card', contract: 'Sale', tax: 'Tax', gst: 'GST', program: 'Program', year_end: 'Year-end', custom: 'Reminder' };
const FILTERS = [
  ['all', 'Everything'],
  ['money', 'Payments', (i) => ['bill', 'loan', 'card', 'contract'].includes(i.kind)],
  ['tax', 'Tax & GST', (i) => ['tax', 'gst'].includes(i.kind)],
  ['program', 'Programs & deadlines', (i) => ['program', 'year_end', 'custom'].includes(i.kind)],
];
const dayOf = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); };

/**
 * Everything with a date: bills (and recurring ones going forward), loan
 * and card payments, expected sale payments, CRA tax and GST dates, and
 * farm program deadlines — the same list Sentinel's calendar gets.
 */
export default function Calendar() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [showDeadlines, setShowDeadlines] = useState(false);
  const [editing, setEditing] = useState(null); // deadline form
  const [busy, setBusy] = useState(null);
  const [showOverdue, setShowOverdue] = useState(false);

  const load = () => fetch('/api/calendar').then((r) => r.json()).then((d) => (d.error ? setError(d.error) : setData(d))).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const send = async (method, url, body) => {
    setError(null);
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) { setError(d.error || `HTTP ${r.status}`); return false; }
    await load();
    return true;
  };

  if (error && !data) return <div className="empty-state">Could not load the calendar: {error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  const pick = FILTERS.find(([k]) => k === filter)?.[2];
  const shownItems = pick ? data.items.filter(pick) : data.items;
  // Overdue things sit together at the top, folded, instead of crowding today.
  const overdue = shownItems.filter((i) => i.overdue);
  const items = shownItems.filter((i) => !i.overdue);
  const byMonth = new Map();
  for (const i of items) {
    const k = i.date.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(i);
  }
  const soon = data.items.filter((i) => i.date <= addDaysISO(data.today, 30) && !i.done);
  const out30 = soon.filter((i) => i.amount < 0).reduce((s, i) => s + i.amount, 0);
  const in30 = soon.filter((i) => i.amount > 0).reduce((s, i) => s + i.amount, 0);
  const deadlines30 = soon.filter((i) => ['tax', 'gst', 'program', 'year_end', 'custom'].includes(i.kind)).length;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Calendar</h1>
        <span className="page-meta">Next 30 days: {cents(-out30)} out · {cents(in30)} in · {deadlines30} deadline{deadlines30 === 1 ? '' : 's'}</span>
      </div>
      {error && <p className="review-error" style={{ margin: '0 0 12px' }}>{error}</p>}

      {data.suggestions.length > 0 && (
        <div className="panel cal-suggest">
          <div className="panel-header">Recurring payments found in your ledger</div>
          <p className="split-lines" style={{ margin: '8px 16px 4px' }}>
            Paid on a steady cycle. Add one and it becomes a recurring bill: on this calendar, in Cash Flow, and matched to the payment when it comes in.
          </p>
          {data.suggestions.map((s) => (
            <div key={s.key} className="cal-suggest-row">
              <span className="cal-suggest-name"><b>{s.name}</b> <span className="split-lines">{FREQ[s.frequency]} · {s.count} payments, last {fmtDate(s.last_date)}</span></span>
              <span className="cal-suggest-amt">
                about {cents(s.amount)}
                {s.high - s.low > 1 && <span className="split-lines"> ({cents(s.low)}–{cents(s.high)})</span>}
              </span>
              <span className="split-lines">next {fmtDate(s.next_date)}</span>
              <span className="cal-suggest-actions">
                <button type="button" className="small" disabled={busy === s.key}
                  onClick={async () => { setBusy(s.key); await send('POST', '/api/calendar/recurring', s); setBusy(null); }}>Add as recurring bill</button>
                <button type="button" className="small-link" onClick={() => send('POST', '/api/calendar/recurring/dismiss', { payee_id: s.payee_id })}>Not recurring</button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="cal-filters seg-toggle" role="group" aria-label="Show">
        {FILTERS.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>

      {overdue.length > 0 && (
        <section className="panel cal-month cal-overdue">
          <button type="button" className="panel-header cal-deadlines-toggle" aria-expanded={showOverdue} onClick={() => setShowOverdue(!showOverdue)}>
            <span>Overdue — {overdue.length} item{overdue.length === 1 ? '' : 's'}</span>
            <span className="cal-month-net out">−{cents(Math.abs(overdue.reduce((t, i) => t + (i.amount || 0), 0)))} · {showOverdue ? 'Hide' : 'Show'}</span>
          </button>
          {showOverdue && (
            <ol className="cal-list">
              {overdue.map((i) => (
                <li key={i.id} className={`cal-item kind-${i.kind}`}>
                  <span className="cal-date"><em>was due</em><b>{fmtDate(i.due || i.date)}</b></span>
                  <span className="cal-body">
                    <span className="cal-title">{i.link ? <a href={i.link}>{i.title}</a> : i.title}</span>
                    <span className="cal-meta"><span className="cal-kind">{KIND[i.kind] || i.kind}</span></span>
                  </span>
                  <span className="cal-amt out">{i.amount == null ? '' : `−${cents(Math.abs(i.amount))}`}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {[...byMonth].map(([month, list]) => {
        const [y, m] = month.split('-').map(Number);
        const net = list.filter((i) => !i.done && i.amount != null).reduce((s, i) => s + i.amount, 0);
        return (
          <section key={month} className="panel cal-month">
            <div className="panel-header cal-month-head">
              <span>{MONTHS[m - 1]} {y}</span>
              {Math.abs(net) >= 0.5 && <span className={`cal-month-net ${net < 0 ? 'out' : 'in'}`}>{net < 0 ? '−' : '+'}{cents(Math.abs(net))}</span>}
            </div>
            <ol className="cal-list">
              {list.map((i) => {
                const past = i.date < data.today;
                return (
                  <li key={i.id} className={`cal-item kind-${i.kind}${i.done ? ' done' : ''}${past ? ' past' : ''}${i.overdue ? ' overdue' : ''}`}>
                    <span className="cal-date"><b>{Number(i.date.slice(8, 10))}</b><em>{DOW[dayOf(i.date)]}</em></span>
                    <span className="cal-body">
                      <span className="cal-title">
                        {i.link ? <a href={i.link}>{i.title}</a> : i.url ? <a href={i.url} target="_blank" rel="noreferrer">{i.title}</a> : i.title}
                      </span>
                      <span className="cal-meta">
                        <span className="cal-kind">{KIND[i.kind] || i.kind}</span>
                        {i.recurring && <span className="cal-flag">recurring</span>}
                        {i.overdue && <span className="cal-flag bad">overdue</span>}
                        {i.done && <span className="cal-flag ok">done</span>}
                        {i.notes && <span className="cal-notes">{i.notes}</span>}
                      </span>
                    </span>
                    <span className={`cal-amt ${i.amount < 0 ? 'out' : i.amount > 0 ? 'in' : ''}`}>
                      {i.amount == null ? '' : `${i.amount < 0 ? '−' : '+'}${cents(Math.abs(i.amount))}`}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
      {byMonth.size === 0 && <div className="empty-state">Nothing on the calendar for the next 12 months.</div>}

      <div className="panel">
        <button type="button" className="panel-header cal-deadlines-toggle" aria-expanded={showDeadlines} onClick={() => setShowDeadlines(!showDeadlines)}>
          <span>Yearly deadlines</span>
          <span className="split-lines">{showDeadlines ? 'Hide' : `${data.deadlines.filter((d) => d.enabled).length} on — change dates or add your own`}</span>
        </button>
        {showDeadlines && (
          <>
            <p className="split-lines" style={{ margin: '8px 16px' }}>
              Each repeats every year. If a program moves a date, change it here once. Tax and GST dates come from the Tax tab and aren't listed here.
            </p>
            <table className="cal-deadlines">
              <tbody>
                {data.deadlines.map((d) => (
                  editing?.id === d.id ? (
                    <tr key={d.id}><td colSpan={3}><DeadlineForm initial={editing} onCancel={() => setEditing(null)}
                      onSave={(f) => send('PUT', `/api/calendar/deadlines/${d.id}`, f).then((ok) => ok && setEditing(null))} /></td></tr>
                  ) : (
                    <tr key={d.id} className={d.enabled ? '' : 'off'}>
                      <td className="nowrap">{d.rule}</td>
                      <td>{d.title.replaceAll('{year}', 'this year').replaceAll('{prev}', 'last year').replaceAll('{next}', 'next year')}</td>
                      <td className="nowrap cal-deadline-actions">
                        <button type="button" className="small-link" onClick={() => setEditing({ ...d })}>Change</button>
                        <button type="button" className="small-link" onClick={() => send('PUT', `/api/calendar/deadlines/${d.id}`, { enabled: !d.enabled })}>{d.enabled ? 'Turn off' : 'Turn on'}</button>
                        {d.custom && <button type="button" className="small-link" onClick={() => window.confirm(`Delete "${d.title}"?`) && send('DELETE', `/api/calendar/deadlines/${d.id}`)}>Delete</button>}
                      </td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
            <div style={{ padding: '10px 16px 14px' }}>
              {editing?.id === 'new' ? (
                <DeadlineForm initial={editing} onCancel={() => setEditing(null)}
                  onSave={(f) => send('POST', '/api/calendar/deadlines', f).then((ok) => ok && setEditing(null))} />
              ) : (
                <button type="button" className="small secondary" onClick={() => setEditing({ id: 'new', title: '', month: 1, day: 1, notes: '' })}>Add a yearly deadline</button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** A deadline's title and date: a day of the month, or the nth weekday. */
function DeadlineForm({ initial, onSave, onCancel }) {
  const [f, setF] = useState({
    title: initial.title || '', notes: initial.notes || '', month: initial.month || 1,
    mode: initial.nth != null ? 'weekday' : 'day', day: initial.day || 1, nth: initial.nth || 1, weekday: initial.weekday ?? 4,
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="stmt-form cal-deadline-form" onSubmit={(e) => {
      e.preventDefault();
      onSave({ title: f.title, notes: f.notes, month: Number(f.month), ...(f.mode === 'day' ? { day: Number(f.day), nth: null, weekday: null } : { nth: Number(f.nth), weekday: Number(f.weekday) }) });
    }}>
      <label style={{ flex: '1 1 260px' }}>What<input value={f.title} onChange={set('title')} placeholder="e.g. Renew the truck insurance" autoFocus /></label>
      <label>Month<select value={f.month} onChange={set('month')}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>
      <label>On<select value={f.mode} onChange={set('mode')}><option value="day">a day</option><option value="weekday">a weekday</option></select></label>
      {f.mode === 'day' ? (
        <label>Day<input type="number" min="1" max="31" value={f.day} onChange={set('day')} style={{ width: 70 }} /></label>
      ) : (
        <>
          <label>Which<select value={f.nth} onChange={set('nth')}>{['1st', '2nd', '3rd', '4th', 'Last'].map((l, i) => <option key={l} value={i + 1}>{l}</option>)}</select></label>
          <label>Day<select value={f.weekday} onChange={set('weekday')}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
        </>
      )}
      <label style={{ flex: '1 1 100%' }}>Note<input value={f.notes} onChange={set('notes')} placeholder="Optional" /></label>
      <div className="stmt-form-actions">
        <button type="submit" className="small" disabled={!f.title.trim()}>Save</button>
        <button type="button" className="small-link" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function fmtDate(d) {
  const [, m, dd] = d.split('-').map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${dd}`;
}
function addDaysISO(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
