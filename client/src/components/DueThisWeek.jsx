import { useEffect, useState } from 'react';
import { cents } from './SplitEditor.jsx';

// Due in the next 7 days (Jake, 2026-10-30): every bill, loan payment, card
// statement and tax or GST payment due today through six days out, plus
// anything overdue — on the Dashboard and the Calendar. Each payment has a
// check: "Paid?" books it from an account now (balances and Cash Flow move
// straight away) as unconfirmed, and the bank statement the agent sends in
// confirms it. What's been ticked off and is still waiting shows below.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KIND = { bill: 'Bill', loan: 'Loan', card: 'Card', tax: 'Tax', gst: 'GST' };
const fmt = (d) => { const [, m, dd] = d.split('-').map(Number); return `${MONTHS[m - 1]} ${dd}`; };
const dow = (d) => { const [y, m, dd] = d.split('-').map(Number); return DAYS[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]; };
const plus = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

function PaidForm({ item, accounts, today, onDone, onCancel }) {
  const [account, setAccount] = useState(item.pay.account_id ? String(item.pay.account_id) : '');
  const [amount, setAmount] = useState(Math.abs(item.amount).toFixed(2));
  const [date, setDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true); setErr(null);
    const r = await fetch('/api/calendar/week/pay', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...item.pay, account_id: Number(account), amount: Number(amount), date }) });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(d.error || `HTTP ${r.status}`); return; }
    onDone();
  };
  return (
    <div className="dw-form">
      <span className="split-lines">Paid from</span>
      <select value={account} aria-label="Paid from" onChange={(e) => setAccount(e.target.value)}>
        <option value="">Choose the account</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <input type="number" step="0.01" min="0" aria-label="Amount paid" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <input type="date" aria-label="Paid on" value={date} onChange={(e) => setDate(e.target.value)} />
      <button type="button" className="small" disabled={!account || busy} onClick={save}>Yes, it's paid</button>
      <button type="button" className="small-link" onClick={onCancel}>Cancel</button>
      {err && <span className="review-error">{err}</span>}
    </div>
  );
}

export default function DueThisWeek({ compact = false, onChanged }) {
  const [d, setD] = useState(null);
  const [asking, setAsking] = useState(null);
  const [err, setErr] = useState(null);
  const [all, setAll] = useState(false);
  const load = () => fetch('/api/calendar/week').then((r) => r.json()).then((x) => (x.error ? setErr(x.error) : setD(x))).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const changed = () => { setAsking(null); load(); onChanged?.(); };
  const undo = async (w) => {
    const url = w.bill_id ? `/api/bills/${w.bill_id}/unpay` : w.loan_payment_id ? `/api/loans/payments/${w.loan_payment_id}/unrecord` : null;
    if (!url || !window.confirm(`Undo "${w.description}"? The payment comes back off the account.`)) return;
    const r = await fetch(url, { method: 'POST' });
    if (!r.ok) { const x = await r.json().catch(() => ({})); setErr(x.error || `HTTP ${r.status}`); return; }
    changed();
  };
  if (!d) return err ? <div className="panel"><p className="review-error" style={{ margin: 16 }}>{err}</p></div> : null;
  // On the dashboard (compact): the first six, the rest one tap away (Oct 30: the full list swamped the page).
  const shown = compact && !all ? d.items.slice(0, 6) : d.items;
  const label = (day) => (day < d.today ? `was due ${fmt(day)}` : day === d.today ? 'Today' : day === plus(d.today, 1) ? 'Tomorrow' : `${dow(day)} ${fmt(day)}`);

  return (
    <section className="panel dw">
      <div className="panel-header cal-month-head">
        <span>Due in the next 7 days</span>
        <span className={`cal-month-net ${d.items.length ? 'out' : ''}`}>{d.items.length ? `−${cents(Math.abs(d.total))}` : 'nothing due'}</span>
      </div>
      {err && <p className="review-error" style={{ margin: '8px 16px' }}>{err}</p>}
      {d.items.length === 0 ? (
        <p className="split-lines" style={{ margin: '10px 16px 14px' }}>No bills, loan payments, card statements or tax due today through {fmt(d.end)}.</p>
      ) : (
        <ol className="cal-list">
          {shown.map((i) => {
            const day = i.due || i.date;
            return (
              <li key={i.id} className={`cal-item dw-item kind-${i.kind}${i.overdue ? ' overdue' : ''}`}>
                {i.pay ? (
                  <button type="button" className={`dw-check${asking === i.id ? ' on' : ''}`} aria-label={`Was ${i.title} paid?`} title="Paid? Tick it off"
                    onClick={() => setAsking(asking === i.id ? null : i.id)}>
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </button>
                ) : <span className="dw-check-none" />}
                <span className={`cal-week-day${i.overdue ? ' late' : day === d.today ? ' today' : ''}`}>{label(day)}</span>
                <span className="cal-body">
                  <span className="cal-title">{i.link ? <a href={i.link}>{i.title}</a> : i.title}</span>
                  <span className="cal-meta"><span className="cal-kind">{KIND[i.kind] || i.kind}</span>{i.recurring && <span className="cal-kind">Recurring</span>}
                    {i.overdue && <span className="badge fail">OVERDUE</span>}{!i.pay && !compact && <span className="split-lines">pay on the Tax page</span>}</span>
                  {asking === i.id && <PaidForm item={i} accounts={d.accounts} today={d.today} onCancel={() => setAsking(null)} onDone={changed} />}
                </span>
                <span className="cal-amt out">−{cents(Math.abs(i.amount))}</span>
              </li>
            );
          })}
        </ol>
      )}
      {shown.length < d.items.length && (
        <button type="button" className="small-link dw-more" onClick={() => setAll(true)}>Show all {d.items.length}</button>
      )}
      {d.waiting.length > 0 && (
        <div className="dw-waiting">
          <div className="split-lines">Ticked off — in the balances, waiting for the bank statement to confirm</div>
          <ul>
            {d.waiting.slice(0, compact ? 5 : 20).map((w) => (
              <li key={w.id}>
                <span className="dw-pending" aria-hidden="true" />
                <span>{fmt(w.date)} · {w.description} · {w.account}</span>
                <span className="num">{cents(w.amount)}</span>
                {(w.bill_id || w.loan_payment_id) && <button type="button" className="small-link" onClick={() => undo(w)}>Undo</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
