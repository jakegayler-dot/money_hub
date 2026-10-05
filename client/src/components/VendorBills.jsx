import { Fragment, useEffect, useRef, useState } from 'react';
import { uploadBody } from '../pages/Receipts.jsx';
import { money, localToday } from '../format.js';
import { cents } from './SplitEditor.jsx';
import CategorySelect from './CategorySelect.jsx';
import MetricCard from './MetricCard.jsx';
import { OwnerFields, ownerPayload, ownerSummary, ownerFieldsFrom, emptyOwnerFields } from '../owners.jsx';

const today = () => localToday();
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
  const [picked, setPicked] = useState(null); // always opens on the vendor list
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0); // bumps the open account to reload

  const load = () => Promise.all([
    fetch('/api/bills/vendors').then((r) => r.json()).then((d) => setVendors(Array.isArray(d) ? d : [])),
    fetch('/api/bills/summary').then((r) => r.json()).then((d) => setAll(d && d.summary ? d : { summary: null, vendors: [] })),
  ]);
  useEffect(() => { load(); }, []);

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

  if (!vendors || !all) return <div className="empty-state vendor-loading">Loading vendors…</div>;
  const known = all.vendors || [];
  const pickedVendor = picked ? known.find((v) => v.payee_id === picked) : null;
  const q = query.trim().toLowerCase();
  const openById = new Map(vendors.map((v) => [v.payee_id ?? 0, v]));
  const rows = q
    ? known.filter((v) => v.name.toLowerCase().includes(q)).map((v) => openById.get(v.payee_id) || { ...v, bills: [], credits: [], owing: 0, held: 0, net: 0, oldest_due: null })
    : vendors;
  const pick = (id) => {
    setPicked(id);
    setQuery('');
    // Opening a vendor from far down the list: bring its account into view.
    setTimeout(() => document.querySelector('.vendor-find')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0);
  };

  return (
    <>
      {error && <p className="review-error" style={{ margin: '0 16px 8px' }}>{error}</p>}
      <div className="vendor-find">
        <div className="vendor-search">
          <input type="search" aria-label="Find a vendor" placeholder="Search vendors…" value={query}
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
          accounts={accounts} categories={categories} call={call}
          others={known.filter((v) => v.payee_id !== picked)}
          onChanged={() => { load(); onChanged?.(); }}
          onDeleted={() => { pick(null); load(); onChanged?.(); }} />
      ) : (
        <>
          {all.summary && <BillSummaryCards s={all.summary} onPickVendor={pick} />}
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

// 14px line icons for the statement rows: quiet until you point at them.
const ICON_PATHS = {
  clip: 'M10.5 4.5 5.4 9.6a1.9 1.9 0 0 0 2.7 2.7l5.4-5.4a3.2 3.2 0 0 0-4.5-4.5L3.4 8a4.4 4.4 0 0 0 6.3 6.3l4.1-4.1',
  pencil: 'M10.6 2.9a1.5 1.5 0 0 1 2.1 2.1L5.4 12.3 2.5 13l.7-2.9 7.4-7.2Z',
  doc: 'M4 1.8h5l3 3v9.4H4V1.8Zm5 0v3h3',
  image: 'M2.3 3h11.4v10H2.3V3Zm0 7.6 3.2-3.1 2.6 2.5 1.8-1.7 3.8 3.5M10.4 6.2h.01',
  close: 'm4 4 8 8m0-8-8 8',
  busy: 'M8 2a6 6 0 1 0 6 6',
};
function Icon({ name }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={name === 'busy' ? 'spin' : undefined}>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

const nice = (d) => {
  if (!d) return '';
  const [y, m, dd] = d.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${dd}${y !== new Date().getFullYear() ? `, ${y}` : ''}`;
};

const num = (v) => (v === '' || v == null ? null : Number(v));

/** A new charge (a bill on this vendor) or payment (a ledger entry paid to them), added from the account. */
function AddEntry({ kind, payeeId, accounts, categories, save, onCancel, onDone }) {
  const [f, setF] = useState({ name: '', date: today(), due_date: '', amount: '', has_gst: false, category_id: null, account_id: accounts[0]?.id || '', on_account: true });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const amount = num(f.amount);
  const ok = amount > 0 && f.date && (kind === 'charge' ? !!f.name.trim() : !!f.account_id);
  const submit = async (e) => {
    e.preventDefault();
    if (!ok) return;
    if (kind === 'charge') {
      const d = await save('POST', '/api/bills', {
        name: f.name.trim(), payee_id: payeeId, amount, received_date: f.date, due_date: f.due_date || f.date,
        has_gst: f.has_gst, gst_pct: 5, category_id: f.category_id || null,
      });
      if (d) onDone();
      return;
    }
    const t = await save('POST', '/api/transactions', {
      account_id: Number(f.account_id), date: f.date, amount: -amount, description: f.name.trim() || 'Payment', payee_id: payeeId,
    });
    if (!t) return;
    if (f.on_account) await save('POST', `/api/bills/vendors/${payeeId}/on-account`, { transaction_id: t.id, on: true });
    onDone();
  };
  return (
    <form className="stmt-form" onSubmit={submit}>
      <div className="stmt-form-title">{kind === 'charge' ? 'New charge' : 'New payment'}</div>
      <label>{kind === 'charge' ? 'Invoice' : 'Description'}
        <input value={f.name} onChange={set('name')} placeholder={kind === 'charge' ? 'e.g. Inv 4471' : 'Payment'} autoFocus /></label>
      <label>Date<input type="date" value={f.date} onChange={set('date')} /></label>
      {kind === 'charge' && <label>Due<input type="date" value={f.due_date} onChange={set('due_date')} /></label>}
      <label>Amount<input type="number" step="0.01" min="0" value={f.amount} onChange={set('amount')} placeholder="0.00" /></label>
      {kind === 'charge' ? (
        <>
          <label className="stmt-check"><input type="checkbox" checked={f.has_gst} onChange={set('has_gst')} /> Includes 5% GST</label>
          <label>Category<CategorySelect value={f.category_id || ''} onChange={(id) => setF({ ...f, category_id: id })} categories={categories} /></label>
        </>
      ) : (
        <>
          <label>Paid from
            <select value={f.account_id} onChange={set('account_id')}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="stmt-check"><input type="checkbox" checked={f.on_account} onChange={set('on_account')} /> Pays down the account</label>
        </>
      )}
      <div className="stmt-form-actions">
        <button type="submit" className="small" disabled={!ok}>{kind === 'charge' ? 'Add charge' : 'Add payment'}</button>
        <button type="button" className="small-link" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** One line changed or deleted in place: a bill, or the ledger entry behind a payment. */
function LineEditor({ line: l, save, onClose }) {
  const isBill = l.kind === 'bill';
  const txAmount = isBill ? null : l.kind === 'spot' ? l.spot : l.kind === 'received' ? l.received : l.amount;
  const start = isBill
    ? { name: l.label, date: l.date, due_date: l.due_date || '', amount: String(l.amount), has_gst: !!l.has_gst }
    : { name: l.label, date: l.date, amount: String(Math.abs(txAmount)) };
  const [f, setF] = useState(start);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const paid = isBill && l.paid;
  const submit = async (e) => {
    e.preventDefault();
    const body = {};
    const changed = (k) => String(f[k]) !== String(start[k]);
    if (isBill) {
      if (changed('name')) body.name = f.name.trim();
      if (changed('date')) body.received_date = f.date;
      if (changed('due_date') && f.due_date) body.due_date = f.due_date;
      if (changed('amount')) body.amount = Number(f.amount);
      if (changed('has_gst')) { body.has_gst = f.has_gst; body.gst_pct = 5; }
      if (!Object.keys(body).length) return onClose();
      if (await save('PATCH', `/api/bills/${l.bill_id}`, body)) onClose();
      return;
    }
    if (changed('name')) body.description = f.name.trim();
    if (changed('date')) body.date = f.date;
    if (changed('amount')) body.amount = Math.sign(txAmount || -1) * Math.abs(Number(f.amount));
    if (!Object.keys(body).length) return onClose();
    if (await save('PATCH', `/api/transactions/${l.transaction_id}`, body)) onClose();
  };
  const remove = async () => {
    const what = isBill ? `the charge "${f.name}"` : `the ledger entry "${l.label}" (it comes off the ledger too)`;
    if (!window.confirm(`Delete ${what}?`)) return;
    if (await save('DELETE', isBill ? `/api/bills/${l.bill_id}` : `/api/transactions/${l.transaction_id}`)) onClose();
  };
  return (
    <form className="stmt-form stmt-form-inline" onSubmit={submit}>
      <label>{isBill ? 'Invoice' : 'Description'}<input value={f.name} onChange={set('name')} /></label>
      <label>{isBill ? 'Invoice date' : 'Date'}<input type="date" value={f.date} onChange={set('date')} /></label>
      {isBill && <label>Due<input type="date" value={f.due_date} onChange={set('due_date')} disabled={paid} /></label>}
      <label>Amount<input type="number" step="0.01" min="0" value={f.amount} onChange={set('amount')} disabled={paid} /></label>
      {isBill && <label className="stmt-check"><input type="checkbox" checked={f.has_gst} onChange={set('has_gst')} disabled={paid} /> Includes 5% GST</label>}
      <div className="stmt-form-actions">
        <button type="submit" className="small">Save</button>
        <button type="button" className="small-link" onClick={onClose}>Cancel</button>
        {!isBill && <a className="small-link" href={`/ledgers?edit=${l.transaction_id}`}>More in the ledger</a>}
        <button type="button" className="small-link stmt-delete" onClick={remove}>Delete</button>
      </div>
      {paid && <p className="split-lines stmt-form-note">Paid — the amount and due date are locked to the payment. Delete the payment first to change them.</p>}
    </form>
  );
}

/** Headline figures: one vendor's (with its account balance and reconciliation) or every vendor's. Click one to list the bills behind it. */
function BillSummaryCards({ s, account, onPickVendor, onShowLine, onShowAccount }) {
  const [open, setOpen] = useState(null);
  const items = s.items || {};
  const toggle = (k) => () => setOpen(open === k ? null : k);
  const card = (k, props) => (
    <MetricCard {...props} onClick={toggle(k)} active={open === k} />
  );
  const TITLE = {
    owing: 'Owing on bills', overdue: 'Overdue', due_30: 'Due in the next 30 days', held: 'Deposits held',
    financed: 'Financed bills — running interest', scheduled: 'Scheduled — recurring, not billed yet', free_ending: 'Interest-free ending soon',
  };
  const list = open ? items[open] || [] : [];
  const total = list.reduce((a, i) => a + i.amount, 0);
  const go = (i) => {
    if (onShowLine && i.bill_id) onShowLine(`bill:${i.bill_id}`);
    else if (onShowLine && i.credit_id) onShowLine(`dep:${i.credit_id}`);
    else if (onPickVendor && i.payee_id) onPickVendor(i.payee_id);
  };
  const clickable = (i) => (onShowLine && (i.bill_id || i.credit_id)) || (onPickVendor && i.payee_id);
  return (
    <>
      <div className="grid vendor-summary">
        {account && (
          <MetricCard label="Account balance" value={money(account.balance)} tone={account.balance < -0.005 ? 'positive' : undefined}
            onClick={onShowAccount}
            sub={account.balance < -0.005 ? 'They hold your money' : account.last ? `Reconciled to ${nice(account.last.statement_date)}` : 'Not reconciled yet'} />
        )}
        {card('owing', { label: 'Owing on bills', value: money(s.owing), sub: s.bills ? `${s.bills} bill${s.bills === 1 ? '' : 's'}${s.oldest_due ? ` · oldest due ${nice(s.oldest_due)}` : ''}` : 'Nothing owing' })}
        {card('overdue', { label: 'Overdue', value: money(s.overdue), tone: s.overdue > 0 ? 'negative' : undefined, sub: s.overdue_count ? `${s.overdue_count} bill${s.overdue_count === 1 ? '' : 's'} past due` : 'None' })}
        {card('due_30', { label: 'Due in 30 days', value: money(s.due_30), sub: s.due_30_count ? `${s.due_30_count} bill${s.due_30_count === 1 ? '' : 's'}` : 'None' })}
        {card('held', { label: 'Deposits held', value: money(s.held), sub: s.held ? 'For later bills or refund' : 'None' })}
        {(s.financed > 0 || s.interest_month > 0) && card('financed', {
          label: 'Interest running', value: `${money(s.interest_month)}/mo`, tone: s.interest_month > 0 ? 'negative' : undefined,
          sub: s.free_ending_count ? `${money(s.free_ending)} goes interest-bearing ${nice(s.free_ending_first)}` : `On ${money(s.financed)} financed`,
        })}
        {s.scheduled_count > 0 && card('scheduled', { label: 'Scheduled', value: money(s.scheduled), sub: `${s.scheduled_count} recurring, not billed yet` })}
      </div>
      {open && (
        <div className="summary-list" role="region" aria-label={TITLE[open]}>
          <div className="summary-list-head">
            <b>{TITLE[open]}</b>
            <span className="split-lines">{list.length} · {cents(total)}</span>
            <button type="button" className="small-link" onClick={() => setOpen(null)}>Close</button>
          </div>
          {!s.items && <p className="split-lines summary-list-empty">The list behind this figure didn't load — refresh the page.</p>}
          {s.items && list.length === 0 && <p className="split-lines summary-list-empty">{open === 'held' ? 'No deposits held.' : 'No bills here.'}</p>}
          {list.length > 0 && <table>
            <thead>
              <tr>
                <th>{open === 'held' ? 'Paid' : 'Due'}</th>
                {!account && <th>Vendor</th>}
                <th>{open === 'held' ? 'Deposit' : 'Bill'}</th>
                {open === 'financed' && <th>Terms</th>}
                <th className="num">{open === 'held' ? 'Left' : 'Owing'}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((i) => {
                const overdue = i.due_date && i.due_date < today();
                return (
                  <tr key={i.bill_id ? `b${i.bill_id}` : `c${i.credit_id}`} className={clickable(i) ? 'summary-row' : ''}
                    tabIndex={clickable(i) ? 0 : undefined} onClick={() => clickable(i) && go(i)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && clickable(i)) go(i); }}>
                    <td className="nowrap">{nice(i.due_date || i.date)}{overdue && open !== 'held' && <span className="badge fail" style={{ marginLeft: 6 }}>OVERDUE</span>}</td>
                    {!account && <td>{i.vendor || <span className="split-lines">No vendor</span>}</td>}
                    <td>{i.name}</td>
                    {open === 'financed' && <td className="split-lines">{i.rate}%{i.interest_free_until ? ` · interest-free to ${nice(i.interest_free_until)}` : ''}</td>}
                    <td className="num nowrap">{cents(i.amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>}
        </div>
      )}
    </>
  );
}

const KIND_LABEL = { opening: 'Opening', spot: 'Paid at purchase', received: 'Paid to you', onaccount: 'On account', bill: 'Bill', adjust: 'Adjustment', interest: 'Interest', deposit: 'Deposit', payment: 'Payment', diff: 'Difference', marked: 'Paid', refund: 'Refund', kept: 'Kept' };

/**
 * The vendor's standing settings: an owner split every new bill and entry
 * takes, and the account's opening balance.
 */
function AccountSettings({ payeeId, st, onSaved }) {
  const [edit, setEdit] = useState(null); // 'owner' | 'opening'
  const [owner, setOwner] = useState(emptyOwnerFields);
  const [applyExisting, setApplyExisting] = useState(true);
  const [usage, setUsage] = useState(null);
  const [opening, setOpening] = useState({ amount: '', date: '' });
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const rule = st.owner_rule;

  const startOwner = () => {
    setErr(null); setNote(null);
    setOwner(rule ? ownerFieldsFrom(rule) : emptyOwnerFields);
    setEdit('owner');
    fetch(`/api/payees/${payeeId}/usage`).then((r) => r.json()).then(setUsage).catch(() => {});
  };
  const saveOwner = async (clear) => {
    setErr(null);
    const r = await fetch(`/api/payees/${payeeId}/owner`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clear ? { clear: true } : { ...ownerPayload(owner), apply_existing: applyExisting }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.error || `HTTP ${r.status}`); return; }
    setEdit(null);
    setNote(clear ? 'Owner split removed.' : applyExisting && (d.bills || d.entries) ? `Re-split ${d.bills} bill${d.bills === 1 ? '' : 's'} and ${d.entries} entr${d.entries === 1 ? 'y' : 'ies'}.` : 'Saved.');
    window.dispatchEvent(new Event('payees-changed'));
    onSaved(null);
  };
  const startOpening = () => {
    setErr(null); setNote(null);
    setOpening(st.opening ? { amount: String(st.opening.amount), date: st.opening.date } : { amount: '', date: `${new Date().getFullYear()}-01-01` });
    setEdit('opening');
  };
  const saveOpening = async (clear) => {
    setErr(null);
    const r = await fetch(`/api/bills/vendors/${payeeId}/opening`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clear ? { clear: true } : { amount: Number(opening.amount), date: opening.date }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.error || `HTTP ${r.status}`); return; }
    setEdit(null);
    onSaved(d);
  };

  return (
    <div className="vendor-settings">
      <div className="vendor-setting-line">
        <span>
          <b>Owner split</b>{' '}
          {rule ? <>{ownerSummary(rule)} <em>— every new bill and entry for {st.name}</em></> : <em>none — each bill and entry keeps its own owner</em>}
        </span>
        <button type="button" className="small-link" onClick={edit === 'owner' ? () => setEdit(null) : startOwner}>{rule ? 'Change' : 'Set a split'}</button>
      </div>
      <div className="vendor-setting-line">
        <span>
          <b>Opening balance</b>{' '}
          {st.opening
            ? <>{cents(Math.abs(st.opening.amount))} {st.opening.amount >= 0 ? 'owed to them' : 'credit with them'} <em>on {nice(st.opening.date)}</em></>
            : <em>none — the account starts from its first bill or entry</em>}
        </span>
        <button type="button" className="small-link" onClick={edit === 'opening' ? () => setEdit(null) : startOpening}>{st.opening ? 'Change' : 'Set one'}</button>
      </div>
      {note && <span className="split-lines vendor-setting-note">{note}</span>}

      {edit === 'owner' && (
        <div className="vendor-setting-edit">
          <div className="form-panel vendor-owner-form"><OwnerFields state={owner} setState={setOwner} label="Every bill and entry belongs to" /></div>
          <label className="split-lines">
            <input type="checkbox" checked={applyExisting} onChange={(e) => setApplyExisting(e.target.checked)} />
            {' '}Also re-split what’s already on file{usage ? ` — ${usage.unpaid_bills + usage.paid_bills} bill${usage.unpaid_bills + usage.paid_bills === 1 ? '' : 's'} and ${usage.open_entries} entr${usage.open_entries === 1 ? 'y' : 'ies'}` : ''} (closed months stay as they are)
          </label>
          <p className="split-lines" style={{ margin: 0 }}>Statement lines and invoices the agents bring in always take this split; when you enter one by hand it starts from it and you can change it.</p>
          {err && <p className="review-error" style={{ margin: 0 }}>{err}</p>}
          <div className="vendor-delete-actions">
            <button type="button" className="small" onClick={() => saveOwner(false)}>Save split</button>
            {rule && <button type="button" className="small secondary" onClick={() => saveOwner(true)}>Remove split</button>}
            <button type="button" className="small-link" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
      {edit === 'opening' && (
        <div className="vendor-setting-edit">
          <div className="vendor-opening-form">
            <label className="split-lines">Balance <input type="number" step="0.01" placeholder="0.00" value={opening.amount} onChange={(e) => setOpening({ ...opening, amount: e.target.value })} /></label>
            <label className="split-lines">As of <input type="date" value={opening.date} onChange={(e) => setOpening({ ...opening, date: e.target.value })} /></label>
          </div>
          <p className="split-lines" style={{ margin: 0 }}>What you owed them on that date (negative if they held a credit for you). Bills and entries before it are shown but not counted — the opening balance already includes them.</p>
          {err && <p className="review-error" style={{ margin: 0 }}>{err}</p>}
          <div className="vendor-delete-actions">
            <button type="button" className="small" disabled={opening.amount === '' || !opening.date} onClick={() => saveOpening(false)}>Save opening balance</button>
            {st.opening && <button type="button" className="small secondary" onClick={() => saveOpening(true)}>Remove it</button>}
            <button type="button" className="small-link" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One vendor's account: figures, pay/deposit actions, the running-balance statement, and reconciling it. */
function VendorAccount({ payeeId, reload, open, name, accounts, categories, call, others = [], onDeleted, onChanged }) {
  const [removing, setRemoving] = useState(false);
  const [st, setSt] = useState(null);
  const [range, setRange] = useState('year');
  const [form, setForm] = useState(null); // { statement_date, statement_balance } while starting one
  const [err, setErr] = useState(null);
  const [showActions, setShowActions] = useState(false);
  const fileRef = useRef(null);
  const [attachTo, setAttachTo] = useState(null); // the line a picked file goes on
  const [busy, setBusy] = useState(null);
  const [adding, setAdding] = useState(null); // 'charge' | 'payment'
  const [editKey, setEditKey] = useState(null); // the line being edited in place
  const [flash, setFlash] = useState(null); // a line picked from a summary card

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

  if (!st) return <div className="empty-state vendor-loading">Loading {name}…</div>;
  if (st.error) return <div className="empty-state">{st.error}</div>;
  const rec = st.reconciliation;
  const recOn = !!rec.open;
  const from = range === 'year' ? (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return localToday(d); })() : null;
  const earlier = from ? st.lines.filter((l) => l.date < from) : [];
  // While reconciling, show everything not yet reconciled even if older.
  const shown = st.lines.filter((l) => !from || l.date >= from || (recOn && !(l.cleared && l.cleared.done)));
  const hiddenBefore = earlier.filter((l) => !shown.includes(l));
  const counted = hiddenBefore.filter((l) => l.balance != null);
  const forward = counted.length ? counted[counted.length - 1].balance : null;
  const setOnAccount = async (txId, on) => {
    setErr(null);
    const r = await fetch(`/api/bills/vendors/${payeeId}/on-account`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction_id: txId, on }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setErr(d.error || `HTTP ${r.status}`); else setSt(d);
  };
  const pickFor = (l) => { setAttachTo(l); fileRef.current.value = ''; fileRef.current.click(); };
  const attach = async (file) => {
    const l = attachTo;
    if (!file || !l) return;
    setErr(null);
    setBusy(l.key);
    try {
      const { body, type } = await uploadBody(file);
      const q = l.kind === 'bill' ? `bill_id=${l.bill_id}` : `transaction_id=${l.transaction_id}`;
      const r = await fetch(`/api/receipts/upload?${q}&keep=1`, { method: 'POST', headers: { 'Content-Type': type }, body });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setErr(d.error || `HTTP ${r.status}`); else await load();
    } catch (e) { setErr(e.message); }
    setBusy(null);
    setAttachTo(null);
  };
  // Add, change or delete an entry, then refresh this account and the vendor list.
  const save = async (method, url, body) => {
    setErr(null);
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.error || `HTTP ${r.status}`); return null; }
    await load();
    onChanged?.();
    return d;
  };
  // A bill picked from a summary card: show its line on the account (all history if it's older) and flash it.
  const showLine = (key) => {
    const l = st.lines.find((x) => x.key === key);
    if (l && from && l.date < from) setRange('all');
    setFlash(key);
    if (!l) { document.getElementById('vendor-upcoming')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    setTimeout(() => document.getElementById(`line-${key}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
    setTimeout(() => setFlash(null), 2200);
  };
  const editable = (l) => !l.before_opening && (l.kind === 'bill' || ['payment', 'spot', 'received', 'onaccount'].includes(l.kind));
  const v = open || { payee_id: payeeId, name, bills: [], credits: [], owing: 0, held: 0, net: 0 };

  return (
    <div className="vendor-account">
      <div className="vendor-account-head">
        <h2>{st.name}</h2>
        <span className="split-lines">Positive balance is what you owe; negative is money they hold for you.</span>
      </div>
      <BillSummaryCards s={st.summary} account={{ balance: st.balance, last: rec.last }} onShowLine={showLine}
        onShowAccount={() => document.querySelector('.vendor-statement')?.scrollIntoView({ block: 'start', behavior: 'smooth' })} />
      <AccountSettings payeeId={payeeId} st={st} onSaved={(d) => (d ? setSt(d) : load())} />

      <div className="vendor-toolbar">
        <span className="seg-toggle" role="group" aria-label="Period">
          {[['year', 'Last 12 months'], ['all', 'All history']].map(([k, l]) => (
            <button key={k} type="button" aria-pressed={range === k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{l}</button>
          ))}
        </span>
        <button type="button" className="small" aria-expanded={adding === 'charge'} onClick={() => setAdding(adding === 'charge' ? null : 'charge')}>Add charge</button>
        <button type="button" className="small" aria-expanded={adding === 'payment'} onClick={() => setAdding(adding === 'payment' ? null : 'payment')}>Add payment</button>
        <button type="button" className="small secondary" aria-expanded={showActions} onClick={() => setShowActions(!showActions)}>
          {showActions ? 'Hide' : 'Pay bills or record a deposit'}
        </button>
        {!recOn && !form && (
          <button type="button" className="small secondary" onClick={() => setForm({ statement_date: today(), statement_balance: '' })}>Reconcile to a statement</button>
        )}
        {!recOn && rec.last && (
          <span className="split-lines">
            Reconciled to {nice(rec.last.statement_date)} at {cents(rec.last.statement_balance)}{' '}
            <button type="button" className="small-link" onClick={() => window.confirm('Undo the last reconciliation? Its lines go back to unticked.') && post('POST', '/undo')}>Undo</button>
          </span>
        )}
        <button type="button" className="small-link vendor-delete-link" aria-expanded={removing} onClick={() => setRemoving(!removing)}>Delete vendor…</button>
      </div>

      {removing && <DeleteVendor payeeId={payeeId} name={st.name} others={others} onCancel={() => setRemoving(false)} onDeleted={onDeleted} />}
      {adding && (
        <AddEntry kind={adding} payeeId={payeeId} accounts={accounts} categories={categories} onCancel={() => setAdding(null)}
          save={save} onDone={() => setAdding(null)} />
      )}
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

      <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png" hidden
        onChange={(e) => attach(e.target.files[0])} />
      <div className="table-scroll">
        <table className="vendor-statement">
          <thead>
            <tr>
              <th className="recon-col" aria-label="On the vendor's statement">✓</th>
              <th>Date</th><th>Item</th><th className="num">GST</th><th className="num">Charges</th><th className="num">Payments &amp; credits</th><th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={7} className="split-lines">Nothing on the account{from ? ' in the last 12 months' : ''}.</td></tr>}
            {[...shown].reverse().map((l) => {
              const done = l.cleared?.done;
              const tickable = recOn && !done && !l.before_opening && l.date <= rec.open.statement_date;
              return (
                <Fragment key={l.key}>
                <tr id={`line-${l.key}`} className={`${flash === l.key ? 'flash ' : ''}stmt-${l.kind}${l.cleared && !done ? ' ticked' : ''}${l.before_opening ? ' before-open' : ''}`}>
                  <td className="recon-col">
                    {done ? <span title="Reconciled" aria-label="Reconciled" className="recon-done">✓</span>
                      : tickable ? <input type="checkbox" aria-label={`On the statement: ${l.label}`} checked={!!l.cleared}
                        onChange={(e) => post('POST', '/tick', { key: l.key, on: e.target.checked })} />
                        : null}
                  </td>
                  <td className="nowrap">{nice(l.date)}</td>
                  <td>
                    {(l.docs || editable(l)) && (
                      <span className="stmt-icons">
                        {(l.docs || []).map((d, i) => (
                          <a key={d.id} href={`/api/receipts/${d.id}/image`} target="_blank" rel="noreferrer" className="stmt-icon has-doc"
                            title={`Open ${d.mime === 'application/pdf' ? 'PDF' : 'photo'}${l.docs.length > 1 ? ` ${i + 1}` : ''}`}
                            aria-label={`Open ${d.mime === 'application/pdf' ? 'PDF' : 'photo'}${l.docs.length > 1 ? ` ${i + 1}` : ''} for ${l.label}`}>
                            <Icon name={d.mime === 'application/pdf' ? 'doc' : 'image'} />
                          </a>
                        ))}
                        {l.docs && (
                          <button type="button" className="stmt-icon" disabled={busy === l.key} onClick={() => pickFor(l)}
                            title={busy === l.key ? 'Attaching…' : 'Attach a PDF or photo'} aria-label={`Attach a PDF or photo to ${l.label}`}>
                            <Icon name={busy === l.key ? 'busy' : 'clip'} />
                          </button>
                        )}
                        {editable(l) && (
                          <button type="button" className={`stmt-icon${editKey === l.key ? ' on' : ''}`} aria-expanded={editKey === l.key}
                            title={editKey === l.key ? 'Close' : 'Edit'} aria-label={`${editKey === l.key ? 'Close editing' : 'Edit'} ${l.label}`}
                            onClick={() => setEditKey(editKey === l.key ? null : l.key)}>
                            <Icon name={editKey === l.key ? 'close' : 'pencil'} />
                          </button>
                        )}
                      </span>
                    )}
                    <span className="stmt-kind">{KIND_LABEL[l.kind]}</span>{' '}
                    {l.transaction_id && ['payment', 'refund', 'deposit', 'spot', 'received', 'onaccount'].includes(l.kind)
                      ? <a href={`/ledgers?edit=${l.transaction_id}`}>{l.label}</a> : l.label}
                    {['spot', 'onaccount'].includes(l.kind) && !l.before_opening && (
                      <button type="button" className="small-link stmt-toggle" onClick={() => setOnAccount(l.transaction_id, l.kind === 'spot')}
                        title={l.kind === 'spot' ? 'It paid down what you owed' : 'It was paid when bought — no effect on the balance'}>
                        {l.kind === 'spot' ? 'Paid on account?' : 'Paid at purchase?'}
                      </button>
                    )}
                    {l.kind === 'received' && <div className="split-lines">Income to you — not on the account, so the balance doesn't change.</div>}
                    {l.before_opening && <span className="tag">before the opening balance</span>}
                    {l.kind === 'bill' && l.due_date && <span className="tag">due {nice(l.due_date)}</span>}
                    {l.awaiting && <span className="tag">Unconfirmed until statement</span>}
                    {l.pays && l.pays.length > 1 && <div className="split-lines">Paid {l.pays.length} bills: {l.pays.join(', ')}</div>}
                    {l.account && <div className="split-lines">{l.account}</div>}
                    {l.cleared?.changed && <div className="review-error" style={{ margin: 0 }}>Changed since ticked (was {cents(l.cleared.amount)})</div>}
                  </td>
                  <td className="num nowrap stmt-gst">{l.gst != null ? cents(l.gst) : l.kind === 'bill' || l.kind === 'payment' ? <span className="split-lines">none</span> : ''}</td>
                  {l.kind === 'spot' ? (
                    <>
                      <td className="num nowrap stmt-spot">{cents(Math.abs(l.spot))}</td>
                      <td className="num nowrap stmt-spot">{cents(Math.abs(l.spot))}</td>
                    </>
                  ) : l.kind === 'received' ? (
                    <td colSpan={2} className="num nowrap stmt-received">+{cents(l.received)} to you</td>
                  ) : (
                    <>
                      <td className="num nowrap">{l.amount > 0 ? cents(l.amount) : ''}</td>
                      <td className="num nowrap pos">{l.amount < 0 ? cents(-l.amount) : ''}</td>
                    </>
                  )}
                  <td className="num nowrap stmt-bal">{l.balance == null ? '—' : cents(l.balance)}</td>
                </tr>
                {editKey === l.key && (
                  <tr className="stmt-edit-row">
                    <td colSpan={7}>
                      <LineEditor line={l} save={save} onClose={() => setEditKey(null)} />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
            {forward != null && (
              <tr className="entries-group"><td /><td className="nowrap">{nice(from)}</td><td>Balance forward</td><td /><td /><td /><td className="num nowrap">{cents(forward)}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {st.upcoming.length > 0 && (
        <div className="vendor-block" id="vendor-upcoming" style={{ padding: '10px 16px' }}>
          <div className="split-lines" style={{ fontWeight: 600 }}>Scheduled — not on the balance until billed</div>
          {st.upcoming.map((u) => (
            <div key={u.bill_id} className="split-lines">{nice(u.date)} · {u.name} · <span className="nowrap">{cents(u.amount)}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Delete a vendor: merge it into another (duplicates — its bills, entries,
 * deposits and reconciliations move across), or just remove it (bills and
 * entries keep everything but the vendor; not allowed while it holds deposits).
 */
function DeleteVendor({ payeeId, name, others, onCancel, onDeleted }) {
  const [u, setU] = useState(null);
  const [mode, setMode] = useState('remove');
  const [into, setInto] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`/api/payees/${payeeId}/usage`).then((r) => r.json()).then((d) => { setU(d); if (d.deposits) setMode('merge'); });
  }, [payeeId]);
  if (!u) return <div className="vendor-delete"><span className="split-lines">Checking what {name} is used on…</span></div>;
  const parts = [
    u.unpaid_bills && `${u.unpaid_bills} unpaid bill${u.unpaid_bills === 1 ? '' : 's'}`,
    u.paid_bills && `${u.paid_bills} paid bill${u.paid_bills === 1 ? '' : 's'}`,
    u.entries && `${u.entries} ledger entr${u.entries === 1 ? 'y' : 'ies'}`,
    u.deposits && `${u.deposits} deposit${u.deposits === 1 ? '' : 's'}`,
    u.reconciliations && `${u.reconciliations} reconciliation${u.reconciliations === 1 ? '' : 's'}`,
  ].filter(Boolean);
  const go = async () => {
    setErr(null); setBusy(true);
    const r = await fetch(`/api/payees/${payeeId}${mode === 'merge' ? `?merge_into=${into}` : ''}`, { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(d.error || `Couldn't delete it (HTTP ${r.status}).`); return; }
    onDeleted();
  };
  return (
    <div className="vendor-delete" role="group" aria-label={`Delete ${name}`}>
      <p className="vendor-delete-what"><strong>Delete {name}?</strong> {parts.length ? `It's on ${parts.join(', ')}.` : 'Nothing uses it.'}</p>
      {parts.length > 0 && (
        <div className="vendor-delete-options">
          <label>
            <input type="radio" name="vd-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
            <span>Merge into
              <select aria-label="Vendor to merge into" value={into} onChange={(e) => { setInto(e.target.value); setMode('merge'); }}>
                <option value="">pick a vendor…</option>
                {others.map((o) => <option key={o.payee_id} value={o.payee_id}>{o.name}</option>)}
              </select>
              <em>Everything moves to that vendor — for a duplicate.</em>
            </span>
          </label>
          <label className={u.deposits ? 'off' : ''}>
            <input type="radio" name="vd-mode" disabled={!!u.deposits} checked={mode === 'remove'} onChange={() => setMode('remove')} />
            <span>Just delete it
              <em>{u.deposits ? 'Not while it holds deposits — merge it instead.' : 'Bills and entries keep their details, with no vendor.'}</em>
            </span>
          </label>
        </div>
      )}
      {err && <p className="review-error" style={{ margin: 0 }}>{err}</p>}
      <div className="vendor-delete-actions">
        <button type="button" className="small danger" disabled={busy || (mode === 'merge' && !into)} onClick={go}>
          {mode === 'merge' && parts.length ? 'Merge and delete' : 'Delete vendor'}
        </button>
        <button type="button" className="small secondary" onClick={onCancel}>Cancel</button>
      </div>
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
