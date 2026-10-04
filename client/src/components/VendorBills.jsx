import { Fragment, useEffect, useState } from 'react';
import { money } from '../format.js';
import { cents } from './SplitEditor.jsx';
import CategorySelect from './CategorySelect.jsx';
import MetricCard from './MetricCard.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const KIND = { prepayment: 'Prepayment (applied to bills)', refundable: 'Refundable deposit' };
const CREDIT_STATUS = { open: 'Held', used: 'All applied', refunded: 'Refunded', kept: 'Kept by vendor' };

/**
 * Bills by vendor, each vendor as an account. At the top: what's owed
 * across every vendor (or the picked one). Find a vendor by typing or from
 * the list; its account shows every bill, interest charge, payment and
 * deposit with a running balance, and can be reconciled to the vendor's
 * own statement.
 */
export default function VendorBills({ accounts, categories, onChanged }) {
  const [vendors, setVendors] = useState(null); // vendors with open bills or deposits
  const [all, setAll] = useState(null); // summary + every vendor on file
  const [picked, setPicked] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('vendor');
    if (q) return Number(q);
    try { return Number(window.localStorage.getItem('moneyhub.vendor')) || null; } catch { return null; }
  });
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0); // bumps the open account to reload

  const load = () => Promise.all([
    fetch('/api/bills/vendors').then((r) => r.json()).then((d) => setVendors(Array.isArray(d) ? d : [])),
    fetch('/api/bills/summary').then((r) => r.json()).then((d) => setAll(d && d.summary ? d : { summary: null, vendors: [] })),
  ]);
  useEffect(() => { load(); }, []);
  useEffect(() => { try { window.localStorage.setItem('moneyhub.vendor', picked ? String(picked) : ''); } catch { /* private mode */ } }, [picked]);

  const call = async (method, url, body, what) => {
    setError(null);
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      setError(b.error || `Could not ${what} (HTTP ${r.status}).`);
      return false;
    }
    await load();
    setTick((t) => t + 1);
    onChanged?.();
    return true;
  };

  if (!vendors || !all) return <div className="empty-state">Loading…</div>;
  const known = all.vendors || [];
  const pickedVendor = picked ? known.find((v) => v.payee_id === picked) : null;
  if (picked && !pickedVendor && known.length) setTimeout(() => setPicked(null), 0);
  const q = query.trim().toLowerCase();
  const openById = new Map(vendors.map((v) => [v.payee_id ?? 0, v]));
  const rows = q
    ? known.filter((v) => v.name.toLowerCase().includes(q)).map((v) => openById.get(v.payee_id) || { ...v, bills: [], credits: [], owing: 0, held: 0, net: 0, oldest_due: null })
    : vendors;
  const pick = (id) => { setPicked(id); setQuery(''); };

  return (
    <>
      {error && <p className="review-error" style={{ margin: '0 16px 8px' }}>{error}</p>}
      <div className="vendor-find">
        <div className="vendor-search">
          <input type="search" aria-label="Find a vendor" placeholder="Find a vendor…" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const hit = known.filter((v) => v.name.toLowerCase().includes(q));
                if (hit.length) pick(hit[0].payee_id);
              }
              if (e.key === 'Escape') setQuery('');
            }} />
          {q && picked && (
            <ul className="vendor-suggest" role="listbox" aria-label="Matching vendors">
              {known.filter((v) => v.name.toLowerCase().includes(q)).slice(0, 8).map((v) => (
                <li key={v.payee_id}><button type="button" onClick={() => pick(v.payee_id)}>{v.name}</button></li>
              ))}
              {!known.some((v) => v.name.toLowerCase().includes(q)) && <li className="split-lines">No vendor matches.</li>}
            </ul>
          )}
        </div>
        <select aria-label="Pick a vendor" value={picked || ''} onChange={(e) => pick(e.target.value ? Number(e.target.value) : null)}>
          <option value="">All vendors</option>
          {known.map((v) => <option key={v.payee_id} value={v.payee_id}>{v.name}</option>)}
        </select>
        {picked && <button type="button" className="small secondary" onClick={() => pick(null)}>All vendors</button>}
      </div>

      {picked && pickedVendor ? (
        <VendorAccount key={picked} payeeId={picked} reload={tick} open={openById.get(picked)} name={pickedVendor.name}
          accounts={accounts} categories={categories} call={call} />
      ) : (
        <>
          {all.summary && <BillSummaryCards s={all.summary} />}
          {all.no_vendor > 0 && <p className="split-lines" style={{ margin: '0 16px 8px' }}>{all.no_vendor} unpaid bill{all.no_vendor === 1 ? ' has' : 's have'} no vendor set — edit {all.no_vendor === 1 ? 'it' : 'them'} under By bill to put {all.no_vendor === 1 ? 'it' : 'them'} on an account.</p>}
          {!rows.length ? <div className="empty-state">{q ? 'No vendor matches.' : 'No unpaid bills or deposits.'}</div> : (
            <table>
              <thead>
                <tr><th>Vendor</th><th>Open bills</th><th>Oldest due</th><th>Owing</th><th>Deposits held</th><th>Balance</th></tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const key = v.payee_id ?? 0;
                  return (
                    <tr key={key} className="vendor-row" tabIndex={v.payee_id ? 0 : -1}
                      onClick={() => v.payee_id && pick(v.payee_id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && v.payee_id) pick(v.payee_id); }}
                      style={{ cursor: v.payee_id ? 'pointer' : 'default' }}>
                      <td>{v.payee_id ? <span aria-hidden="true">▸ </span> : null}{v.name}</td>
                      <td>{v.bills.length}</td>
                      <td>{v.oldest_due || '—'}{v.oldest_due && v.oldest_due < today() && <span className="badge fail" style={{ marginLeft: 6 }}>OVERDUE</span>}</td>
                      <td className="nowrap">{money(v.owing)}</td>
                      <td className="nowrap">{v.held ? money(v.held) : '—'}</td>
                      <td className="nowrap" style={{ fontWeight: 600 }}>{money(v.net)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

const nice = (d) => {
  if (!d) return '';
  const [y, m, dd] = d.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${dd}${y !== new Date().getFullYear() ? `, ${y}` : ''}`;
};

/** Headline figures: one vendor's (with its account balance and reconciliation) or every vendor's. */
function BillSummaryCards({ s, account }) {
  return (
    <div className="grid vendor-summary">
      {account && (
        <MetricCard label="Account balance" value={money(account.balance)} tone={account.balance < -0.005 ? 'positive' : undefined}
          sub={account.balance < -0.005 ? 'They hold your money' : account.last ? `Reconciled to ${nice(account.last.statement_date)}` : 'Not reconciled yet'} />
      )}
      <MetricCard label="Owing on bills" value={money(s.owing)} sub={s.bills ? `${s.bills} bill${s.bills === 1 ? '' : 's'}${s.oldest_due ? ` · oldest due ${nice(s.oldest_due)}` : ''}` : 'Nothing owing'} />
      <MetricCard label="Overdue" value={money(s.overdue)} tone={s.overdue > 0 ? 'negative' : undefined} sub={s.overdue_count ? `${s.overdue_count} bill${s.overdue_count === 1 ? '' : 's'} past due` : 'None'} />
      <MetricCard label="Due in 30 days" value={money(s.due_30)} sub={s.due_30_count ? `${s.due_30_count} bill${s.due_30_count === 1 ? '' : 's'}` : 'None'} />
      <MetricCard label="Deposits held" value={money(s.held)} sub={s.held ? 'For later bills or refund' : 'None'} />
      {(s.financed > 0 || s.interest_month > 0) && (
        <MetricCard label="Interest running" value={`${money(s.interest_month)}/mo`} tone={s.interest_month > 0 ? 'negative' : undefined}
          sub={s.free_ending_count ? `${money(s.free_ending)} goes interest-bearing ${nice(s.free_ending_first)}` : `On ${money(s.financed)} financed`} />
      )}
      {s.scheduled_count > 0 && (
        <MetricCard label="Scheduled" value={money(s.scheduled)} sub={`${s.scheduled_count} recurring, not billed yet`} />
      )}
    </div>
  );
}

const KIND_LABEL = { bill: 'Bill', adjust: 'Adjustment', interest: 'Interest', deposit: 'Deposit', payment: 'Payment', diff: 'Difference', marked: 'Paid', refund: 'Refund', kept: 'Kept' };

/** One vendor's account: figures, pay/deposit actions, the running-balance statement, and reconciling it. */
function VendorAccount({ payeeId, reload, open, name, accounts, categories, call }) {
  const [st, setSt] = useState(null);
  const [range, setRange] = useState('year');
  const [form, setForm] = useState(null); // { statement_date, statement_balance } while starting one
  const [err, setErr] = useState(null);
  const [showActions, setShowActions] = useState(false);

  const load = () => fetch(`/api/bills/vendors/${payeeId}/statement`).then((r) => r.json()).then(setSt);
  useEffect(() => { load(); }, [payeeId, reload]);

  const post = async (method, path, body) => {
    setErr(null);
    const r = await fetch(`/api/bills/vendors/${payeeId}/reconcile${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.error || `HTTP ${r.status}`); return false; }
    setSt(d);
    return true;
  };

  if (!st) return <div className="empty-state">Loading…</div>;
  if (st.error) return <div className="empty-state">{st.error}</div>;
  const rec = st.reconciliation;
  const recOn = !!rec.open;
  const from = range === 'year' ? (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().slice(0, 10); })() : null;
  const earlier = from ? st.lines.filter((l) => l.date < from) : [];
  // While reconciling, show everything not yet reconciled even if older.
  const shown = st.lines.filter((l) => !from || l.date >= from || (recOn && !(l.cleared && l.cleared.done)));
  const hiddenBefore = earlier.filter((l) => !shown.includes(l));
  const forward = hiddenBefore.length ? hiddenBefore[hiddenBefore.length - 1].balance : null;
  const v = open || { payee_id: payeeId, name, bills: [], credits: [], owing: 0, held: 0, net: 0 };

  return (
    <div className="vendor-account">
      <div className="vendor-account-head">
        <h2>{st.name}</h2>
        <span className="split-lines">Positive balance is what you owe; negative is money they hold for you.</span>
      </div>
      <BillSummaryCards s={st.summary} account={{ balance: st.balance, last: rec.last }} />

      <div className="vendor-toolbar">
        <span className="seg-toggle" role="group" aria-label="Period">
          {[['year', 'Last 12 months'], ['all', 'All history']].map(([k, l]) => (
            <button key={k} type="button" aria-pressed={range === k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{l}</button>
          ))}
        </span>
        <button type="button" className="small secondary" aria-expanded={showActions} onClick={() => setShowActions(!showActions)}>
          {showActions ? 'Hide' : 'Pay bills or record a deposit'}
        </button>
        {!recOn && !form && (
          <button type="button" className="small" onClick={() => setForm({ statement_date: today(), statement_balance: '' })}>Reconcile to a statement</button>
        )}
        {!recOn && rec.last && (
          <span className="split-lines">
            Reconciled to {nice(rec.last.statement_date)} at {cents(rec.last.statement_balance)}{' '}
            <button type="button" className="small-link" onClick={() => window.confirm('Undo the last reconciliation? Its lines go back to unticked.') && post('POST', '/undo')}>Undo</button>
          </span>
        )}
      </div>

      {showActions && <VendorDetail v={v} accounts={accounts} categories={categories} call={call} />}

      {form && !recOn && (
        <div className="recon-bar">
          <span>From the vendor's statement:</span>
          <label className="split-lines">Date <input type="date" value={form.statement_date} onChange={(e) => setForm({ ...form, statement_date: e.target.value })} /></label>
          <label className="split-lines">Balance <input type="number" step="0.01" style={{ width: 120 }} placeholder="0.00" value={form.statement_balance}
            onChange={(e) => setForm({ ...form, statement_balance: e.target.value })} /></label>
          <button type="button" className="small" disabled={!form.statement_date || form.statement_balance === ''}
            onClick={() => post('POST', '', { statement_date: form.statement_date, statement_balance: Number(form.statement_balance) }).then((ok) => ok && setForm(null))}>
            Start
          </button>
          <button type="button" className="small-link" onClick={() => setForm(null)}>Cancel</button>
          <span className="split-lines">Enter it negative if the statement shows a credit in your favour.</span>
        </div>
      )}

      {recOn && (
        <div className="recon-bar on" role="status">
          <span>Statement {nice(rec.open.statement_date)}</span>
          <span>Statement balance <b>{cents(rec.open.statement_balance)}</b></span>
          <span>Ticked <b>{cents(rec.cleared_total)}</b></span>
          <span>Difference <b className={Math.abs(rec.difference) < 0.005 ? 'pos' : 'neg'}>{cents(rec.difference)}</b></span>
          <button type="button" className="small" disabled={Math.abs(rec.difference) >= 0.005} onClick={() => post('POST', '/finish')}>Finish</button>
          <button type="button" className="small secondary" onClick={() => post('DELETE', '')}>Cancel</button>
          <span className="split-lines">Tick each line that's on their statement. It finishes when the ticked lines come to their balance.</span>
        </div>
      )}
      {err && <p className="review-error" style={{ margin: '0 16px 8px' }}>{err}</p>}
      {rec.missing.length > 0 && (
        <p className="review-error" style={{ margin: '0 16px 8px' }}>
          Reconciled but no longer on the account: {rec.missing.map((m) => `${m.label} (${cents(m.amount)})`).join('; ')}. Undo that reconciliation or put the entry back.
        </p>
      )}

      <div className="table-scroll">
        <table className="vendor-statement">
          <thead>
            <tr>
              <th className="recon-col" aria-label="On the vendor's statement">✓</th>
              <th>Date</th><th>Item</th><th className="num">Charges</th><th className="num">Payments &amp; credits</th><th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {forward != null && (
              <tr className="entries-group"><td /><td className="nowrap">{nice(from)}</td><td>Balance forward</td><td /><td /><td className="num nowrap">{cents(forward)}</td></tr>
            )}
            {shown.length === 0 && <tr><td colSpan={6} className="split-lines">Nothing on the account{from ? ' in the last 12 months' : ''}.</td></tr>}
            {shown.map((l) => {
              const done = l.cleared?.done;
              const tickable = recOn && !done && l.date <= rec.open.statement_date;
              return (
                <tr key={l.key} className={`stmt-${l.kind}${l.cleared && !done ? ' ticked' : ''}`}>
                  <td className="recon-col">
                    {done ? <span title="Reconciled" aria-label="Reconciled" className="recon-done">✓</span>
                      : tickable ? <input type="checkbox" aria-label={`On the statement: ${l.label}`} checked={!!l.cleared}
                        onChange={(e) => post('POST', '/tick', { key: l.key, on: e.target.checked })} />
                        : null}
                  </td>
                  <td className="nowrap">{nice(l.date)}</td>
                  <td>
                    <span className="stmt-kind">{KIND_LABEL[l.kind]}</span>{' '}
                    {l.transaction_id && (l.kind === 'payment' || l.kind === 'refund' || l.kind === 'deposit')
                      ? <a href={`/ledgers?edit=${l.transaction_id}`}>{l.label}</a> : l.label}
                    {l.kind === 'bill' && l.due_date && <span className="tag">due {nice(l.due_date)}</span>}
                    {l.awaiting && <span className="tag">Unconfirmed until statement</span>}
                    {l.pays && l.pays.length > 1 && <div className="split-lines">Paid {l.pays.length} bills: {l.pays.join(', ')}</div>}
                    {l.account && <div className="split-lines">{l.account}</div>}
                    {l.cleared?.changed && <div className="review-error" style={{ margin: 0 }}>Changed since ticked (was {cents(l.cleared.amount)})</div>}
                  </td>
                  <td className="num nowrap">{l.amount > 0 ? cents(l.amount) : ''}</td>
                  <td className="num nowrap pos">{l.amount < 0 ? cents(-l.amount) : ''}</td>
                  <td className="num nowrap stmt-bal">{cents(l.balance)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {st.upcoming.length > 0 && (
        <div className="vendor-block" style={{ padding: '10px 16px' }}>
          <div className="split-lines" style={{ fontWeight: 600 }}>Scheduled — not on the balance until billed</div>
          {st.upcoming.map((u) => (
            <div key={u.bill_id} className="split-lines">{nice(u.date)} · {u.name} · <span className="nowrap">{cents(u.amount)}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

function VendorDetail({ v, accounts, categories, call }) {
  const [payAccount, setPayAccount] = useState('');
  const [payCheck, setPayCheck] = useState(false);
  const [picked, setPicked] = useState(() => new Set(v.bills.map((b) => b.id)));
  const [deposit, setDeposit] = useState(null); // form state when recording one
  const [refundFor, setRefundFor] = useState(null);
  const [keepFor, setKeepFor] = useState(null);
  const [payments, setPayments] = useState([]);
  const pickedTotal = v.bills.filter((b) => picked.has(b.id)).reduce((s, b) => s + b.owing, 0);
  const openCredits = v.credits.filter((c) => c.status === 'open');

  const loadPayments = (direction) => fetch(`/api/bills/vendors/${v.payee_id}/payments?direction=${direction}`)
    .then((r) => r.json()).then((d) => setPayments(Array.isArray(d) ? d : []));

  return (
    <div className="vendor-detail">
      {v.bills.length > 0 && (
        <div className="vendor-block">
          <div className="split-lines" style={{ fontWeight: 600 }}>Unpaid bills</div>
          {v.bills.map((b) => (
            <label key={b.id} className="split-lines vendor-bill">
              <input type="checkbox" checked={picked.has(b.id)} onChange={(e) => {
                const n = new Set(picked);
                if (e.target.checked) n.add(b.id); else n.delete(b.id);
                setPicked(n);
              }} />
              {' '}{b.due_date} · {b.name} · <span className="nowrap">{cents(b.owing)}</span>
              {b.applied > 0 && <span className="tag">deposit applied {cents(b.applied)}</span>}
              {openCredits.length > 0 && (
                <select aria-label="Apply a deposit" value="" onChange={(e) => e.target.value && call('POST', `/api/bills/credits/${e.target.value}/apply`, { bill_id: b.id }, 'apply the deposit')}>
                  <option value="">Apply a deposit…</option>
                  {openCredits.map((c) => <option key={c.id} value={c.id}>{cents(c.remaining)} held since {c.date}</option>)}
                </select>
              )}
            </label>
          ))}
          {v.payee_id && picked.size > 0 && (
            <div className="contract-actions">
              <span className="split-lines">Pay {picked.size === v.bills.length ? 'all' : `${picked.size} picked`} — {money(pickedTotal)} in one payment from</span>
              <select value={payAccount} onChange={(e) => setPayAccount(e.target.value)}>
                <option value="">Account…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <label className="split-lines"><input type="checkbox" checked={payCheck} onChange={(e) => setPayCheck(e.target.checked)} /> by cheque</label>
              <button type="button" className="small" disabled={!payAccount}
                onClick={() => call('POST', '/api/bills/pay-many', { bill_ids: [...picked], account_id: Number(payAccount), paid_date: today(), paid_by_check: payCheck }, 'pay them')}>
                Pay
              </button>
            </div>
          )}
        </div>
      )}

      {v.payee_id && (
        <div className="vendor-block">
          <div className="split-lines" style={{ fontWeight: 600 }}>Deposits with {v.name}</div>
          {v.credits.length === 0 && <div className="split-lines">None.</div>}
          {v.credits.map((c) => (
            <div key={c.id} className="split-lines">
              {c.date} · {KIND[c.kind]} · <span className="nowrap">{cents(c.amount)}</span>
              {c.status === 'open' && c.remaining < c.amount && <> · {cents(c.remaining)} left</>}
              <span className="tag">{CREDIT_STATUS[c.status]}</span>
              {(c.applications || []).map((a) => (
                <span key={a.id} className="tag">
                  {cents(a.amount)} → {a.bill}{' '}
                  <button type="button" className="small-link" onClick={() => call('POST', `/api/bills/credits/applications/${a.id}/remove`, null, 'take it off')}>×</button>
                </span>
              ))}
              {c.status === 'open' && c.kind === 'refundable' && (
                <button type="button" className="small-link" onClick={() => { setRefundFor(c.id); loadPayments('in'); }}>Refunded…</button>
              )}{' '}
              {c.status === 'open' && <button type="button" className="small-link" onClick={() => setKeepFor(c.id)}>Vendor kept it…</button>}{' '}
              <button type="button" className="small-link" onClick={() => window.confirm('Remove this deposit record? Its payment stays in the ledger.') && call('DELETE', `/api/bills/credits/${c.id}`, null, 'remove it')}>Remove</button>
              {refundFor === c.id && (
                <div className="contract-actions">
                  <span className="split-lines">Which deposit was the refund?</span>
                  {payments.length === 0 && <span className="split-lines">No money in from {v.name} on file yet — it matches on its own when it arrives.</span>}
                  {payments.map((t) => (
                    <button key={t.id} type="button" className="small secondary"
                      onClick={() => call('POST', `/api/bills/credits/${c.id}/refund`, { transaction_id: t.id }, 'mark it refunded').then(() => setRefundFor(null))}>
                      {t.date} · {cents(t.amount)}
                    </button>
                  ))}
                  <button type="button" className="small-link" onClick={() => setRefundFor(null)}>Cancel</button>
                </div>
              )}
              {keepFor === c.id && (
                <KeepForm categories={categories} onCancel={() => setKeepFor(null)}
                  onSave={(cat) => call('POST', `/api/bills/credits/${c.id}/keep`, { category_id: cat }, 'save').then(() => setKeepFor(null))} />
              )}
            </div>
          ))}
          {deposit ? (
            <div className="contract-actions">
              <select value={deposit.kind} onChange={(e) => setDeposit({ ...deposit, kind: e.target.value })}>
                <option value="prepayment">{KIND.prepayment}</option>
                <option value="refundable">{KIND.refundable}</option>
              </select>
              {payments.length > 0 && (
                <select value={deposit.transaction_id} onChange={(e) => setDeposit({ ...deposit, transaction_id: e.target.value })}>
                  <option value="">A payment already in the ledger…</option>
                  {payments.map((t) => <option key={t.id} value={t.id}>{t.date} · {cents(t.amount)} · {t.description}</option>)}
                </select>
              )}
              {!deposit.transaction_id && (
                <>
                  <select value={deposit.account_id} onChange={(e) => setDeposit({ ...deposit, account_id: e.target.value })}>
                    <option value="">…or paid now from</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <input type="number" step="0.01" placeholder="Amount" style={{ width: 100 }} value={deposit.amount}
                    onChange={(e) => setDeposit({ ...deposit, amount: e.target.value })} />
                  <input type="date" value={deposit.date} onChange={(e) => setDeposit({ ...deposit, date: e.target.value })} />
                </>
              )}
              <button type="button" className="small"
                disabled={!deposit.transaction_id && !(deposit.account_id && Number(deposit.amount) > 0)}
                onClick={() => call('POST', '/api/bills/credits', {
                  payee_id: v.payee_id, kind: deposit.kind,
                  transaction_id: deposit.transaction_id ? Number(deposit.transaction_id) : null,
                  account_id: deposit.account_id ? Number(deposit.account_id) : null,
                  amount: deposit.amount ? Number(deposit.amount) : null, date: deposit.date,
                }, 'record the deposit').then((ok) => ok && setDeposit(null))}>
                Save deposit
              </button>
              <button type="button" className="small secondary" onClick={() => setDeposit(null)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="small secondary" style={{ marginTop: 4 }}
              onClick={() => { setDeposit({ kind: 'prepayment', transaction_id: '', account_id: '', amount: '', date: today() }); loadPayments('out'); }}>
              Record a deposit
            </button>
          )}
        </div>
      )}
      {!v.payee_id && <div className="split-lines">Edit these bills and pick their vendor to group them.</div>}
    </div>
  );
}

function KeepForm({ categories, onSave, onCancel }) {
  const [cat, setCat] = useState('');
  return (
    <div className="contract-actions">
      <span className="split-lines">Book what's left as an expense under</span>
      <CategorySelect categories={categories} value={cat} onChange={setCat} />
      <button type="button" className="small" onClick={() => onSave(cat ? Number(cat) : null)}>Save</button>
      <button type="button" className="small-link" onClick={onCancel}>Cancel</button>
    </div>
  );
}
