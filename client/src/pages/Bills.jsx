import { Fragment, useEffect, useRef, useState } from 'react';
import { money, localToday } from '../format.js';
import { OwnerFields, ownerPayload, ownerFieldsFrom, ownerSummary, emptyOwnerFields, OWNER_LABELS, OWNER_KEYS, ruleOf } from '../owners.jsx';
import CategorySelect from '../components/CategorySelect.jsx';
import PayeeSelect, { usePayees } from '../components/PayeeSelect.jsx';
import VendorBills from '../components/VendorBills.jsx';
import { cents } from '../components/SplitEditor.jsx';
import { uploadBody } from './Receipts.jsx';

// Sorting, remembered per browser. Ties fall back to soonest due.
const COLUMNS = [['due', 'Due'], ['name', 'Name'], ['category', 'Category'], ['owner', 'Owner'], ['amount', 'Total'], ['status', 'Status']];
const today = () => localToday();
const statusRank = (b) => (b.status === 'paid' ? 2 : b.due_date?.slice(0, 10) < today() ? 0 : 1);
const sortValue = {
  due: (b) => b.due_date?.slice(0, 10) || '',
  name: (b) => (b.name || '').toLowerCase(),
  category: (b) => (b.category_full || b.category || '~').toLowerCase(),
  owner: (b) => ownerSummary(b).toLowerCase(),
  amount: (b) => Number(b.amount),
  status: statusRank,
};
function sortBills(rows, { key, dir }) {
  const get = sortValue[key] || sortValue.due;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
    return c * sign || String(a.due_date).localeCompare(String(b.due_date)) || a.id - b.id;
  });
}
// Owner filter: a split bill shows under every owner it's split to.
const belongsTo = (b, owner) => {
  if (!owner) return true;
  if (b.is_segment_split) return owner !== 'none' && Number(b[`segment_${owner}_pct`]) > 0;
  return owner === 'none' ? !b.segment : b.segment === owner;
};

const emptyForm = {
  name: '', payee_id: '', ledger: 'business', category_id: '', amount: '', frequency: 'one_time',
  received_date: '', due_date: '', notes: '',
  has_gst: false, gst_pct: '5',
  is_financed: false, finance_rate_pct: '', interest_free_until: '', balance_amount: '', balance_as_of: '',
  ...emptyOwnerFields,
};

// Input financing terms: interest-free until a date, then simple interest
// at the rate. A balance from a statement replaces the invoice as the base.
function FinanceFields({ state, setState, disabled = false }) {
  const set = (k) => (e) => setState({ ...state, [k]: e.target.value });
  return (
    <>
      <div className="field">
        <label>
          <input type="checkbox" disabled={disabled} checked={!!state.is_financed}
            onChange={(e) => setState({ ...state, is_financed: e.target.checked })} />
          {' '}On finance terms (input financing)
        </label>
      </div>
      {state.is_financed && (
        <>
          <div className="field">
            <label>Interest-free until</label>
            <input type="date" disabled={disabled} value={state.interest_free_until || ''} onChange={set('interest_free_until')} />
          </div>
          <div className="field">
            <label>Interest after that (% per year)</label>
            <input type="number" step="0.01" min="0" disabled={disabled} value={state.finance_rate_pct ?? ''} onChange={set('finance_rate_pct')} />
          </div>
          <div className="field">
            <label>Balance on latest statement (optional)</label>
            <input type="number" step="0.01" disabled={disabled} value={state.balance_amount ?? ''} onChange={set('balance_amount')} placeholder="Leave blank to use the invoice" />
          </div>
          <div className="field">
            <label>…as of</label>
            <input type="date" disabled={disabled} value={state.balance_as_of || ''} onChange={set('balance_as_of')} />
          </div>
        </>
      )}
    </>
  );
}
const financePayload = (f) => ({
  is_financed: !!f.is_financed,
  finance_rate_pct: f.is_financed && f.finance_rate_pct !== '' ? Number(f.finance_rate_pct) : null,
  interest_free_until: f.is_financed ? f.interest_free_until || null : null,
  balance_amount: f.is_financed && f.balance_amount !== '' && f.balance_amount != null ? Number(f.balance_amount) : null,
  balance_as_of: f.is_financed ? f.balance_as_of || null : null,
});

export default function Bills() {
  const [bills, setBills] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState('unpaid');
  const [error, setError] = useState(null);
  const [payingId, setPayingId] = useState(null);
  const [payAccountId, setPayAccountId] = useState('');
  const [payByCheck, setPayByCheck] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [sort, setSort] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem('moneyhub.billSort')) || { key: 'due', dir: 'asc' }; } catch { return { key: 'due', dir: 'asc' }; }
  });
  useEffect(() => { try { window.localStorage.setItem('moneyhub.billSort', JSON.stringify(sort)); } catch { /* private mode */ } }, [sort]);
  const [photoFor, setPhotoFor] = useState(null);
  const payees = usePayees();
  const [view, setView] = useState(() => { try { return window.localStorage.getItem('moneyhub.billView') || 'bill'; } catch { return 'bill'; } });
  useEffect(() => { try { window.localStorage.setItem('moneyhub.billView', view); } catch { /* private mode */ } }, [view]);
  const photoRef = useRef(null);

  const load = () => {
    const q = filter === 'all' ? '' : `?status=${filter}`;
    fetch(`/api/bills${q}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setBills(data);
        else setError(data?.error || 'Failed to load bills.');
      })
      .catch(() => setError('Failed to load bills.'));
  };
  useEffect(load, [filter]);
  useEffect(() => {
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
    const loadCats = () => fetch('/api/expenses').then((r) => r.json()).then((c) => setCategories(Array.isArray(c) ? c : []));
    loadCats();
    window.addEventListener('categories-changed', loadCats);
    return () => window.removeEventListener('categories-changed', loadCats);
  }, []);

  const post = async (url, body, what) => {
    setError(null);
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b?.error || `Could not ${what} (HTTP ${res.status}).`);
      return false;
    }
    load();
    return true;
  };

  const addPhoto = async (file) => {
    const id = photoFor;
    setPhotoFor(null);
    if (!file || !id) return;
    setError(null);
    try {
      const { body, type } = await uploadBody(file);
      const res = await fetch(`/api/receipts/upload?bill_id=${id}`, { method: 'POST', headers: { 'Content-Type': type }, body });
      if (!res.ok) { const b = await res.json().catch(() => ({})); setError(b.error || `Upload failed (HTTP ${res.status}).`); }
    } catch {
      setError(`Couldn't open ${file.name} — photos and PDFs only.`);
    }
    if (photoRef.current) photoRef.current.value = '';
    load();
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/bills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        amount: Number(form.amount),
        category_id: form.category_id ? Number(form.category_id) : null,
        payee_id: form.payee_id ? Number(form.payee_id) : null,
        received_date: form.received_date || null,
        notes: form.notes || null,
        gst_pct: form.has_gst ? Number(form.gst_pct) : 5,
        ...financePayload(form),
        ...ownerPayload(form),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not save bill (HTTP ${res.status}).`);
      return;
    }
    setForm(emptyForm);
    load();
  };

  const confirmPay = async () => {
    if (!payingId) return;
    setError(null);
    const res = await fetch(`/api/bills/${payingId}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paid_date: localToday(),
        account_id: payAccountId || null,
        paid_by_check: payByCheck,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not mark bill paid (HTTP ${res.status}).`);
      return;
    }
    setPayingId(null);
    setPayAccountId('');
    setPayByCheck(false);
    load();
  };

  const remove = async (id) => {
    await fetch(`/api/bills/${id}`, { method: 'DELETE' });
    load();
  };

  const startEdit = (b) => {
    setEditingId(b.id);
    setEditForm({
      name: b.name, payee_id: b.payee_id ? String(b.payee_id) : '', category_id: b.category_id || '', amount: b.amount, due_date: b.due_date?.slice(0, 10),
      notes: b.notes || '', has_gst: b.has_gst, gst_pct: b.gst_pct,
      is_financed: !!b.is_financed, finance_rate_pct: b.finance_rate_pct == null ? '' : Number(b.finance_rate_pct),
      interest_free_until: b.interest_free_until || '', balance_amount: b.balance_amount == null ? '' : Number(b.balance_amount),
      balance_as_of: b.balance_as_of || '',
      ...ownerFieldsFrom(b),
    });
    setError(null);
  };

  const cancelEdit = () => { setEditingId(null); setEditForm(null); };

  const saveEdit = async (id) => {
    setError(null);
    const res = await fetch(`/api/bills/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...editForm,
        category_id: editForm.category_id ? Number(editForm.category_id) : null,
        payee_id: editForm.payee_id ? Number(editForm.payee_id) : null,
        amount: Number(editForm.amount),
        gst_pct: Number(editForm.gst_pct),
        ...(bills.find((x) => x.id === id)?.status === 'paid' ? {} : financePayload(editForm)),
        ...ownerPayload(editForm),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not save changes (HTTP ${res.status}).`);
      return;
    }
    cancelEdit();
    load();
  };

  const undoPayment = async (id) => {
    setError(null);
    const res = await fetch(`/api/bills/${id}/unpay`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not undo payment (HTTP ${res.status}).`);
      return;
    }
    load();
  };

  const usedCats = [...new Map(bills.filter((b) => b.category_id).map((b) => [b.category_id, b.category_full || b.category])).entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const q = search.trim().toLowerCase();
  const shown = sortBills(bills.filter((b) => {
    if (q && !`${b.name} ${b.category_full || b.category || ''} ${b.notes || ''} ${b.paid_tx_description || ''}`.toLowerCase().includes(q)) return false;
    if (catFilter === 'none' ? b.category_id : catFilter && String(b.category_id) !== catFilter) return false;
    return belongsTo(b, ownerFilter);
  }), sort);
  const filtering = q || catFilter || ownerFilter;

  const totalUnpaid = bills
    .filter((b) => b.status === 'unpaid')
    .reduce((s, b) => s + Number(b.owing_now ?? b.amount), 0);
  const totalUnpaidGst = bills
    .filter((b) => b.status === 'unpaid')
    .reduce((s, b) => s + Number(b.gst_amount || 0), 0);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Bills</h1>
        <span className="page-meta">
          Unpaid total {money(totalUnpaid)}
          {totalUnpaidGst > 0 && ` · GST portion ${money(totalUnpaidGst)}`}
        </span>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: 'var(--red, #c0392b)' }}>
          <div className="panel-header">Something went wrong</div>
          <p style={{ margin: '8px 0 0', color: 'var(--red, #c0392b)' }}>{error}</p>
        </div>
      )}

      <div className="panel">
        <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="seg-toggle" role="group" aria-label="View" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {[['bill', 'By bill'], ['vendor', 'By vendor']].map(([k, l]) => (
                <button key={k} type="button" aria-pressed={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>
              ))}
            </span>
            {view === 'bill' && <span>Invoices received{filtering ? ` — ${shown.length} of ${bills.length}` : ''}</span>}
          </span>
          {view === 'bill' && <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', textTransform: 'none', letterSpacing: 0 }}>
            <input aria-label="Search bills" placeholder="Search name, category, notes" value={search}
              onChange={(e) => setSearch(e.target.value)} style={{ width: 200 }} />
            <select aria-label="Category" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
              <option value="">All categories</option>
              {usedCats.map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}
              <option value="none">No category</option>
            </select>
            <select aria-label="Owner" value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
              <option value="">All owners</option>
              {OWNER_KEYS.map((k) => <option key={k} value={k}>{OWNER_LABELS[k]}</option>)}
              <option value="none">Unassigned</option>
            </select>
            <select aria-label="Status" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="unpaid">Unpaid</option>
              <option value="paid">Paid</option>
              <option value="all">All</option>
            </select>
          </span>}
        </div>
        {view === 'vendor' ? (
          <>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 16px 12px' }}>
              Each vendor is an account: bills and finance interest raise its balance; payments and deposits lower it. Pick a vendor
              to see every line with a running balance, pay several bills in one payment, or reconcile it to their statement.
              Profit and tax still count each bill when it's paid.
            </p>
            <VendorBills accounts={accounts} categories={categories} onChanged={load} />
          </>
        ) : (<>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 16px 12px' }}>
          A bill is marked paid on its own when the payment for exactly its total shows up in the ledger — from a statement or
          entered by hand. If more than one payment fits, it's listed under the bill to confirm. "Mark paid" is for paying it
          yourself now; that entry stays unconfirmed until the bank statement shows it.
        </p>
        <input ref={photoRef} type="file" accept="image/*,application/pdf,.pdf" hidden onChange={(e) => addPhoto(e.target.files?.[0])} />
        {shown.length === 0 ? (
          <div className="empty-state">{bills.length ? 'No bills match.' : 'Nothing to show.'}</div>
        ) : (
          <table>
            <thead>
              <tr>
                {COLUMNS.map(([key, label]) => (
                  <th key={key} className="sortable" aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'amount' ? 'desc' : 'asc' }))}>
                      {label}<span className="sort-mark" aria-hidden="true">{sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                    </button>
                  </th>
                ))}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => {
                const overdue = b.status === 'unpaid' && b.due_date?.slice(0, 10) < today();
                return (
                  <Fragment key={b.id}>
                    <tr>
                      <td>{b.due_date?.slice(0, 10)}</td>
                      <td>
                        {b.name}
                        {b.frequency !== 'one_time' && <span className="tag">{{ monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Yearly' }[b.frequency]}</span>}
                        {b.is_financed && <span className="tag">Financed</span>}
                        <div>
                          {b.invoice_receipt_id ? (
                            <a className="tag" style={{ marginLeft: 0 }} href={`/api/receipts/${b.invoice_receipt_id}/image`} target="_blank" rel="noreferrer">Invoice</a>
                          ) : (
                            <button type="button" className="small-link" onClick={() => { setPhotoFor(b.id); photoRef.current?.click(); }}>Add invoice (photo or PDF)</button>
                          )}
                        </div>
                        {b.vendor && b.vendor !== b.name && <div className="split-lines">{b.vendor}</div>}
                        {Number(b.deposit_applied) > 0 && <div className="split-lines">Deposit applied {cents(Number(b.deposit_applied))}</div>}
                        {b.notes && <div className="split-lines">{b.notes}</div>}
                      </td>
                      <td>
                        {b.category_id ? (b.category_full || b.category) : b.category ? (
                          <>
                            <span style={{ color: 'var(--text-muted)' }}>{b.category}</span>
                            <div className="split-lines" style={{ color: 'var(--gold-bright)' }}>Not in your categories — Edit to pick one</div>
                          </>
                        ) : '—'}
                      </td>
                      <td>
                        {ownerSummary(b)}
                        <div className="split-lines">{b.ledger}</div>
                      </td>
                      <td>
                        <span className="nowrap">{money(Number(b.amount))}</span>
                        {b.is_financed && b.status === 'unpaid' && (
                          <div className="split-lines nowrap">
                            {b.owing_now > Number(b.amount) + 0.005 ? `owing now ${cents(b.owing_now)}` : `0% until ${b.interest_free_until || '—'}`}
                            {b.owing_at_due > b.owing_now + 0.005 && <div>{cents(b.owing_at_due)} by {b.due_date?.slice(0, 10)}</div>}
                            <div>{Number(b.finance_rate_pct)}%/yr after{b.balance_as_of ? ` · stmt ${b.balance_as_of}` : ''}</div>
                          </div>
                        )}
                        {b.has_gst && (
                          <div className="split-lines nowrap">
                            {money(Number(b.subtotal_amount))} + GST {money(Number(b.gst_amount))} ({Number(b.gst_pct)}%)
                          </div>
                        )}
                      </td>
                      <td>
                        {b.status === 'paid' ? (
                          <>
                            <span className="badge pass">PAID</span>
                            {b.linked_transaction_id ? (
                              <div className="split-lines">
                                {b.paid_tx_date} · {b.paid_account || (b.paid_card ? `${b.paid_card} (card)` : '')} · {cents(b.paid_tx_amount)}
                                <div>
                                  {b.paid_awaiting ? 'Awaiting statement · ' : b.paid_from_statement ? 'From statement · ' : ''}
                                  <a className="small-link" href={`/ledgers?edit=${b.linked_transaction_id}`}>Open entry</a>
                                </div>
                              </div>
                            ) : (
                              <div className="split-lines">Marked paid {b.paid_date?.slice(0, 10)} — no ledger entry</div>
                            )}
                          </>
                        ) : (
                          <>
                            {overdue ? <span className="badge fail">OVERDUE</span> : <span className="badge warn">UNPAID</span>}
                            {(b.suggestions || []).length > 0 && (
                              <div className="bill-suggest">
                                <div className="split-lines">Paid by one of these?</div>
                                {b.suggestions.map((t) => (
                                  <div key={t.id} className="split-lines">
                                    <button type="button" className="small" onClick={() => post(`/api/bills/${b.id}/link`, { transaction_id: t.id }, 'link it')}>This one</button>{' '}
                                    {t.date} · {t.account} · {t.description}
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        {b.status === 'unpaid' && payingId === b.id ? (
                          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                            <select value={payAccountId} onChange={(e) => setPayAccountId(e.target.value)}>
                              <option value="">Paid from…</option>
                              {accounts.map((a) => (
                                <option key={a.id} value={a.id}>{a.name} ({a.ledger})</option>
                              ))}
                            </select>
                            <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              <input type="checkbox" checked={payByCheck} onChange={(e) => setPayByCheck(e.target.checked)} />
                              By check
                            </label>
                            {b.is_financed && <span className="split-lines nowrap">Pays {cents(b.owing_now)} (invoice + interest to today)</span>}
                            <button className="small" disabled={!payAccountId} onClick={confirmPay}>Confirm</button>
                            <button className="small secondary" onClick={() => { setPayingId(null); setPayAccountId(''); setPayByCheck(false); }}>Cancel</button>
                          </span>
                        ) : (
                          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                            {b.status === 'unpaid' && (
                              <button className="small" onClick={() => { setPayingId(b.id); setPayAccountId(''); setPayByCheck(false); }}>Mark paid</button>
                            )}
                            <button className="small secondary" onClick={() => (editingId === b.id ? cancelEdit() : startEdit(b))}>
                              {editingId === b.id ? 'Close' : 'Edit'}
                            </button>
                            {b.status === 'paid' && (
                              <button className="small secondary" onClick={() => undoPayment(b.id)} title={b.linked_existing ? 'This bill wasn\'t paid by that entry — unlink it (the entry stays)' : 'Reverse the payment made from this tab'}>{b.linked_existing ? 'Not this payment' : 'Undo payment'}</button>
                            )}
                            <button className="small secondary" onClick={() => remove(b.id)}>Delete</button>
                          </span>
                        )}
                      </td>
                    </tr>
                    {editingId === b.id && editForm && (
                      <tr>
                        <td colSpan={7} style={{ background: 'var(--panel-alt, rgba(255,255,255,0.03))' }}>
                          <div style={{ padding: '12px 4px' }}>
                            {b.status === 'paid' && (
                              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>
                                This bill is paid, so amount, due date, and GST are locked (a transaction already
                                moved money based on them). Only name, category, and notes can be changed here.
                                Use "Undo payment" first if the amount itself needs fixing.
                              </p>
                            )}
                            <div className="form-panel" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                              <div className="field">
                                <label>Name</label>
                                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                              </div>
                              <div className="field">
                                <label>Vendor</label>
                                <PayeeSelect payees={payees} value={editForm.payee_id} emptyLabel="No vendor"
                                  onChange={(v) => setEditForm({ ...editForm, payee_id: v, ...(ruleOf(payees.find((x) => String(x.id) === String(v))) || {}) })} />
                              </div>
                              <div className="field">
                                <label>Category</label>
                                <CategorySelect categories={categories} value={editForm.category_id}
                                  onChange={(v) => setEditForm({ ...editForm, category_id: v })} />
                              </div>
                              <div className="field">
                                <label>Amount</label>
                                <input type="number" step="0.01" disabled={b.status === 'paid'} value={editForm.amount} onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })} />
                              </div>
                              <div className="field">
                                <label>Due date</label>
                                <input type="date" disabled={b.status === 'paid'} value={editForm.due_date} onChange={(e) => setEditForm({ ...editForm, due_date: e.target.value })} />
                              </div>
                              <div className="field">
                                <label>
                                  <input type="checkbox" disabled={b.status === 'paid'} checked={editForm.has_gst} onChange={(e) => setEditForm({ ...editForm, has_gst: e.target.checked })} />
                                  {' '}Includes GST
                                </label>
                              </div>
                              {editForm.has_gst && (
                                <div className="field">
                                  <label>GST rate (%)</label>
                                  <input type="number" step="0.01" disabled={b.status === 'paid'} value={editForm.gst_pct} onChange={(e) => setEditForm({ ...editForm, gst_pct: e.target.value })} />
                                </div>
                              )}
                              <div className="field">
                                <label>Notes</label>
                                <input value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} />
                              </div>
                              <FinanceFields state={editForm} setState={setEditForm} disabled={b.status === 'paid'} />
                              <OwnerFields state={editForm} setState={setEditForm} />
                            </div>
                            <div style={{ marginTop: 8 }}>
                              <button className="small" onClick={() => saveEdit(b.id)}>Save changes</button>
                              {' '}
                              <button className="small secondary" onClick={cancelEdit}>Cancel</button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        </>)}
      </div>

      <div className="panel">
        <div className="panel-header">Record a received bill</div>
        <form className="form-panel" onSubmit={submit}>
          <div className="field">
            <label>Name</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. AgriChem Ltd — invoice #4471" />
          </div>
          <div className="field">
            <label>Vendor (blank = from the name)</label>
            <PayeeSelect payees={payees} value={form.payee_id} emptyLabel="From the name"
              onChange={(v) => setForm({ ...form, payee_id: v, ...(ruleOf(payees.find((x) => String(x.id) === String(v))) || {}) })} />
          </div>
          <div className="field">
            <label>Ledger</label>
            <select value={form.ledger} onChange={(e) => setForm({ ...form, ledger: e.target.value })}>
              <option value="business">Business</option>
              <option value="personal">Personal</option>
            </select>
          </div>
          <div className="field">
            <label>Category</label>
            <CategorySelect categories={categories} value={form.category_id} onChange={(v) => setForm({ ...form, category_id: v })} />
          </div>
          <OwnerFields state={form} setState={setForm} />
          <div className="field">
            <label>Amount (total invoice value)</label>
            <input type="number" step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div className="field">
            <label>
              <input type="checkbox" checked={form.has_gst} onChange={(e) => setForm({ ...form, has_gst: e.target.checked })} />
              {' '}Amount includes GST
            </label>
          </div>
          {form.has_gst && (
            <div className="field">
              <label>GST rate (%)</label>
              <input type="number" step="0.01" min="0" max="100" value={form.gst_pct} onChange={(e) => setForm({ ...form, gst_pct: e.target.value })} />
              {form.amount && (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  {(() => {
                    const total = Number(form.amount) || 0;
                    const pct = Number(form.gst_pct) || 0;
                    const gst = Math.round((total * pct / (100 + pct)) * 100) / 100;
                    return `Subtotal ${money(total - gst)} + GST ${money(gst)} = ${money(total)}`;
                  })()}
                </p>
              )}
            </div>
          )}
          <div className="field">
            <label>Frequency</label>
            <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
              <option value="one_time">One-time</option>
              <option value="monthly">Monthly (recurs automatically once paid)</option>
              <option value="quarterly">Quarterly (recurs automatically once paid)</option>
              <option value="annual">Yearly (recurs automatically once paid)</option>
            </select>
          </div>
          <FinanceFields state={form} setState={setForm} />
          <div className="field">
            <label>Received date (optional)</label>
            <input type="date" value={form.received_date} onChange={(e) => setForm({ ...form, received_date: e.target.value })} />
          </div>
          <div className="field">
            <label>{form.is_financed ? 'Due date (or when you plan to pay it)' : 'Due date'}</label>
            <input type="date" required value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          </div>
          <div className="field">
            <label>Notes</label>
            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            Unpaid bills count against the liquidity floor forecast at their due month —
            the dashboard reflects this obligation before it's paid, not after.
          </p>
          <button type="submit">Add bill</button>
        </form>
      </div>
    </>
  );
}
