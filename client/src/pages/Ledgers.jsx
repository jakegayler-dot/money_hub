import { useEffect, useState } from 'react';
import { money } from '../format.js';
import { OwnerFields, ownerPayload, ownerSummary, emptyOwnerFields, ownerFieldsFrom, OWNER_LABELS } from '../owners.jsx';
import SplitEditor, { cents, newPiece, piecesPayload } from '../components/SplitEditor.jsx';
import CategorySelect from '../components/CategorySelect.jsx';
import PayeeSelect, { usePayees } from '../components/PayeeSelect.jsx';

// Column sorting. Ties fall back to newest first, so equal amounts or
// names keep a sensible order.
const SORT_COLUMNS = [['date', 'Date'], ['account', 'Account / card'], ['description', 'Description'], ['owner', 'Owner'], ['amount', 'Amount']];
const sortValue = {
  date: (t) => `${t.date || ''}`,
  account: (t) => (t.account_name || t.card_name || '').toLowerCase(),
  description: (t) => (t.description || '').toLowerCase(),
  owner: (t) => (t.is_split ? 'split' : ownerSummary(t) || '').toLowerCase(),
  amount: (t) => Number(t.amount),
};
function sortRows(rows, { key, dir }) {
  const get = sortValue[key] || sortValue.date;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
    if (c) return c * sign;
    return String(b.date).localeCompare(String(a.date)) || b.id - a.id;
  });
}

const emptyForm = {
  source: 'account', account_id: '', credit_card_id: '', ledger: '', date: '', amount: '', description: '',
  category_id: '', is_mixed_use: false, mixed_use_business_pct: '', is_capex: false, is_transfer: false,
  paid_by_check: false, is_split: false, needs_review: false, review_note: '', transfer_account_id: '', pays: '', payee_id: '', gst_amount: '',
  ...emptyOwnerFields,
};

// Date, amount and account are fixed on these — the edit route says why.
const moneyLockedHint = (t) => (t.source ? 'from a bank statement'
  : t.transfer_peer_id ? 'one side of a paired transfer'
  : t.credit_card_id && t.account_id ? 'a credit card payment' : null);

export default function Ledgers() {
  const [transactions, setTransactions] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [cards, setCards] = useState([]);
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [pieces, setPieces] = useState([newPiece(), newPiece()]);
  const [filter, setFilter] = useState('all');
  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem('moneyhub.ledgerSort')) || { key: 'date', dir: 'desc' }; } catch { return { key: 'date', dir: 'desc' }; }
  });
  useEffect(() => { try { window.localStorage.setItem('moneyhub.ledgerSort', JSON.stringify(sort)); } catch { /* not saved */ } }, [sort]);
  // /ledgers?payee=ID (from the payee totals) shows only that payee's entries.
  const [payeeFilter, setPayeeFilter] = useState(() => new URLSearchParams(window.location.search).get('payee') || '');
  // One account ("a:ID") or card ("c:ID") — shows its running balance.
  const [where, setWhere] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('account')) return `a:${q.get('account')}`;
    if (q.get('card')) return `c:${q.get('card')}`;
    try { return window.localStorage.getItem('moneyhub.ledgerWhere') || ''; } catch { return ''; }
  });
  const [balance, setBalance] = useState(null);
  const [editing, setEditing] = useState(null); // the transaction being edited
  const [error, setError] = useState(null);
  const payees = usePayees();
  const [linkOptions, setLinkOptions] = useState({ bills: [], loan_payments: [], contracts: [] });
  const loadLinkOptions = () => fetch('/api/transactions/link-options').then((r) => r.json())
    .then((d) => setLinkOptions(d && d.bills ? { contracts: [], ...d } : { bills: [], loan_payments: [], contracts: [] })).catch(() => {});

  const load = () => {
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('ledger', filter);
    if (reviewOnly) params.set('needs_review', 'true');
    if (search.trim()) params.set('q', search.trim());
    if (payeeFilter) params.set('payee_id', payeeFilter);
    const [kind, whereId] = where.split(':');
    const one = kind === 'a' ? `account_id=${whereId}` : kind === 'c' ? `credit_card_id=${whereId}` : null;
    if (kind === 'a') params.set('account_id', whereId);
    if (kind === 'c') params.set('credit_card_id', whereId);
    params.set('limit', '2000');
    fetch(`/api/transactions?${params}`).then((r) => r.json()).then((d) => setTransactions(Array.isArray(d) ? d : []));
    if (one) fetch(`/api/transactions/balance?${one}`).then((r) => (r.ok ? r.json() : null)).then(setBalance).catch(() => setBalance(null));
    else setBalance(null);
  };

  useEffect(load, [filter, reviewOnly, payeeFilter, where]);
  useEffect(() => { try { window.localStorage.setItem('moneyhub.ledgerWhere', where); } catch { /* private mode */ } }, [where]);
  // /ledgers?edit=ID (from the Review tab) opens that transaction for editing.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('edit');
    if (!id) return;
    fetch(`/api/transactions?id=${encodeURIComponent(id)}`).then((r) => r.json()).then((rows) => {
      if (Array.isArray(rows) && rows[0]) startEdit(rows[0]);
    });
  }, []);
  useEffect(() => {
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
    fetch('/api/credit-cards').then((r) => r.json()).then((c) => setCards(c.filter((x) => x.status === 'active')));
    fetch('/api/expenses').then((r) => r.json()).then(setCategories);
    loadLinkOptions();
    const reload = () => fetch('/api/expenses').then((r) => r.json()).then(setCategories);
    window.addEventListener('categories-changed', reload);
    return () => window.removeEventListener('categories-changed', reload);
  }, []);

  const onCard = form.source === 'card';
  const itemizedCards = cards.filter((c) => c.itemized);

  const lockedFor = editing ? moneyLockedHint(editing) : null;
  // A transfer between two of your own accounts: both sides get recorded.
  // Shown for a new transfer, or when editing a transfer whose other side
  // isn't recorded yet.
  const canPair = !onCard && form.is_transfer && (!editing || (!editing.transfer_peer_id && !!editing.account_id && !editing.credit_card_id));
  const pairedTransfer = canPair && !!form.transfer_account_id;
  const amt = Number(form.amount) || 0;
  const otherLabel = amt < 0 ? 'Going into' : amt > 0 ? 'Coming from' : 'Other account';
  // Money going out can be the payment for an unpaid bill or a scheduled
  // loan payment — linking it marks that paid instead of entering it twice.
  const canLink = amt < 0 && !form.is_transfer && (!editing || (!editing.pays && !(editing.credit_card_id && editing.account_id)));
  // Money coming in can be the payment for an open sale contract.
  const canSettle = amt > 0 && !onCard && !form.is_transfer && (!editing || !editing.pays);
  const near = (x) => Math.abs(Math.abs(x) - Math.abs(amt)) < 0.005;
  // Amount matches first, then the due date closest to this transaction's date.
  const dayGap = (d) => (form.date ? Math.abs(new Date(d) - new Date(form.date)) : 0);
  const byMatch = (list) => [...list].sort((a, b) => (Number(near(b.amount)) - Number(near(a.amount))) || (dayGap(a.due_date) - dayGap(b.due_date)));
  const linkPayload = () => {
    if (!form.pays) return {};
    const [kind, id] = form.pays.split(':');
    if (kind === 'contract') return canSettle ? { link_contract_id: Number(id) } : {};
    if (!canLink) return {};
    return kind === 'bill' ? { link_bill_id: Number(id) } : { link_loan_payment_id: Number(id) };
  };

  const startEdit = (t) => {
    setError(null);
    setEditing(t);
    const split = !!t.is_split && (t.splits || []).length > 1;
    setForm({
      ...emptyForm,
      source: t.account_id ? 'account' : 'card',
      account_id: t.account_id ? String(t.account_id) : '', credit_card_id: t.credit_card_id ? String(t.credit_card_id) : '',
      ledger: '', date: (t.date || '').slice(0, 10), amount: String(Number(t.amount)), description: t.description || '',
      category_id: t.category_id ? String(t.category_id) : '', is_capex: !!t.is_capex, is_transfer: !!t.is_transfer,
      is_split: split, needs_review: !!t.needs_review, review_note: t.review_note || '',
      payee_id: t.payee_id ? String(t.payee_id) : '',
      gst_amount: t.gst_amount != null ? String(Number(t.gst_amount)) : '',
      ...ownerFieldsFrom(t),
    });
    setPieces(split
      ? t.splits.map((p) => ({ amount: String(Number(p.amount)), category_id: p.category_id ? String(p.category_id) : '', segment: p.segment || 'grain', memo: p.memo || '' }))
      : [newPiece(), newPiece()]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => { setEditing(null); setForm(emptyForm); setPieces([newPiece(), newPiece()]); setError(null); };

  const saveEdit = async () => {
    const body = {
      description: form.description,
      payee_id: form.payee_id ? Number(form.payee_id) : null,
      gst_amount: form.gst_amount === '' || form.is_transfer ? null : Number(form.gst_amount),
      category_id: !form.is_split && form.category_id ? Number(form.category_id) : null,
      is_capex: form.is_capex,
      splits: form.is_split ? piecesPayload(pieces) : [],
      needs_review: form.needs_review, review_note: form.needs_review ? form.review_note : null,
      ...ownerPayload(form),
    };
    if (form.ledger) body.ledger = form.ledger;
    if (!(editing.credit_card_id && editing.account_id)) body.is_transfer = !onCard && form.is_transfer;
    if (body.is_transfer) { body.category_id = null; body.splits = []; }
    if (pairedTransfer) body.transfer_account_id = Number(form.transfer_account_id);
    Object.assign(body, linkPayload());
    if (!lockedFor) {
      body.date = form.date;
      body.amount = Number(form.amount);
      if (!onCard) body.account_id = Number(form.account_id);
    }
    const r = await fetch(`/api/transactions/${editing.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      setError(b.error || `Could not save (${r.status}).`);
      return;
    }
    cancelEdit();
    load();
    loadLinkOptions();
    window.dispatchEvent(new Event('review-changed'));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (editing) { await saveEdit(); return; }
    const r = await fetch('/api/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: onCard ? null : Number(form.account_id),
        credit_card_id: onCard ? Number(form.credit_card_id) : null,
        ledger: form.ledger || null, date: form.date, amount: Number(form.amount), description: form.description,
        payee_id: form.payee_id ? Number(form.payee_id) : null,
        gst_amount: form.gst_amount === '' || form.is_transfer ? null : Number(form.gst_amount),
        category_id: !form.is_split && form.category_id ? Number(form.category_id) : null,
        is_mixed_use: form.is_mixed_use,
        mixed_use_business_pct: form.is_mixed_use ? Number(form.mixed_use_business_pct) : null,
        is_capex: form.is_capex,
        is_transfer: !onCard && form.is_transfer,
        transfer_account_id: pairedTransfer ? Number(form.transfer_account_id) : null,
        cleared: onCard || !form.paid_by_check,
        splits: form.is_split ? piecesPayload(pieces) : [],
        needs_review: form.needs_review, review_note: form.needs_review ? form.review_note : null,
        ...ownerPayload(form),
        ...linkPayload(),
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      setError(body.error || `Could not save (${r.status}).`);
      return;
    }
    setForm(emptyForm);
    setPieces([newPiece(), newPiece()]);
    load();
    loadLinkOptions();
    if (form.needs_review) window.dispatchEvent(new Event('review-changed'));
  };

  const markCleared = async (id) => {
    const r = await fetch(`/api/transactions/${id}/clear`, { method: 'POST' });
    if (!r.ok) { const b = await r.json().catch(() => ({})); window.alert(b.error || 'Could not mark it cleared.'); }
    load();
  };

  const remove = async (t) => {
    const both = t.transfer_peer_id && !t.source ? ' Both sides of this transfer are deleted.' : '';
    if (!window.confirm(`Delete "${t.description || 'this transaction'}" (${cents(t.amount)})? ${t.account_name ? `${t.account_name}'s balance goes back by that amount.` : ''}${both}`)) return;
    const r = await fetch(`/api/transactions/${t.id}`, { method: 'DELETE' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      window.alert(body.error || 'Could not delete.');
    }
    load();
  };

  const filtered = outstandingOnly ? transactions.filter((t) => !t.cleared) : transactions;
  const visible = sortRows(filtered, sort);
  const outstandingCount = transactions.filter((t) => !t.cleared).length;
  const outstandingTotal = transactions
    .filter((t) => !t.cleared)
    .reduce((s, t) => s + Math.abs(Number(t.amount)), 0);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Ledgers</h1>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All</option>
          <option value="business">Business</option>
          <option value="personal">Personal</option>
        </select>
      </div>

      <div className="panel">
        <div className="panel-header">{editing ? `Edit transaction — ${editing.description || `#${editing.id}`}` : 'Record transaction'}</div>
        <form className="form-panel" onSubmit={submit}>
          {editing && lockedFor && (
            <p className="notice" style={{ margin: 0 }}>
              This is {lockedFor}, so its date, amount and account are fixed. Category, owner, splits and the review flag can still be changed.
            </p>
          )}
          <div className="field">
            <label>Paid with</label>
            <select disabled={!!editing} value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
              <option value="account">An account (cash, cheque, debit, e-transfer)</option>
              <option value="card">A credit card (charged, not yet paid)</option>
            </select>
          </div>
          {!onCard ? (
            <div className="field">
              <label>Account</label>
              <select required disabled={!!lockedFor} value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
                <option value="">Select account</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.ledger})</option>)}
              </select>
            </div>
          ) : (
            <div className="field">
              <label>Card</label>
              <select required disabled={!!editing} value={form.credit_card_id} onChange={(e) => setForm({ ...form, credit_card_id: e.target.value })}>
                <option value="">Select card</option>
                {itemizedCards.map((c) => <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` ••${c.last4}` : ''}</option>)}
              </select>
              {cards.length > itemizedCards.length && (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                  Only cards with itemizing turned on are listed — start it from the card's details on the Credit Cards tab.
                </p>
              )}
            </div>
          )}
          <div className="field">
            <label>Date</label>
            <input type="date" required disabled={!!lockedFor} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div className="field">
            <label>Amount (negative = money out / spent)</label>
            <input type="number" step="0.01" required disabled={!!lockedFor} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div className="field">
            <label>Description</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          {!form.is_transfer && (
            <div className="field">
              <label>GST on the receipt (optional)</label>
              <input type="number" step="0.01" min="0" placeholder="Blank = none recorded" value={form.gst_amount}
                onChange={(e) => setForm({ ...form, gst_amount: e.target.value })} />
            </div>
          )}
          {!form.is_transfer && (
            <div className="field">
              <label>{amt > 0 ? 'Received from' : 'Paid to'}</label>
              <PayeeSelect payees={payees} value={form.payee_id} onChange={(v) => setForm((f) => ({ ...f, payee_id: v }))} />
            </div>
          )}
          {!onCard && (
            <div className="field">
              <label>
                <input type="checkbox" checked={form.is_transfer} onChange={(e) => setForm({ ...form, is_transfer: e.target.checked, is_split: false })} />
                {' '}Transfer — money moving between accounts, a loan advance, etc. (not income or spending)
              </label>
            </div>
          )}
          {canPair && (
            <div className="field">
              <label>{otherLabel}</label>
              <select value={form.transfer_account_id} onChange={(e) => setForm({ ...form, transfer_account_id: e.target.value })}>
                <option value="">Not one of my accounts (loan advance, etc.)</option>
                {accounts.filter((a) => String(a.id) !== String(form.account_id)).map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.ledger})</option>
                ))}
              </select>
            </div>
          )}
          {pairedTransfer && (
            <p className="split-lines" style={{ margin: 0 }}>
              Records both sides: {money(Math.abs(amt))} {amt < 0 ? 'out of' : 'into'} {accounts.find((a) => String(a.id) === String(form.account_id))?.name || 'the account above'} and{' '}
              {amt < 0 ? 'into' : 'out of'} {accounts.find((a) => String(a.id) === String(form.transfer_account_id))?.name}. Each side takes its own account's owner.
            </p>
          )}
          {!form.is_transfer && (
            <div className="field">
              <label>
                <input type="checkbox" checked={form.is_split} onChange={(e) => setForm({ ...form, is_split: e.target.checked })} />
                {' '}Split into pieces (different categories or owners)
              </label>
            </div>
          )}
          {canLink && (linkOptions.bills.length > 0 || linkOptions.loan_payments.length > 0) && (
            <div className="field span2">
              <label>Pays a bill or loan? (✓ = amount matches)</label>
              <select value={form.pays} onChange={(e) => setForm({ ...form, pays: e.target.value })}>
                <option value="">No — regular spending</option>
                {linkOptions.bills.length > 0 && (
                  <optgroup label="Unpaid bills">
                    {byMatch(linkOptions.bills).map((b) => (
                      <option key={`b${b.id}`} value={`bill:${b.id}`}>
                        {near(b.amount) ? '✓ ' : ''}{b.name} · {cents(b.amount)} · due {b.due_date}
                      </option>
                    ))}
                  </optgroup>
                )}
                {!onCard && linkOptions.loan_payments.length > 0 && (
                  <optgroup label="Loan payments">
                    {byMatch(linkOptions.loan_payments).map((l) => (
                      <option key={`l${l.id}`} value={`loan:${l.id}`}>
                        {near(l.amount) ? '✓ ' : ''}{l.loan_name} · {cents(l.amount)} · due {l.due_date}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          )}
          {canSettle && linkOptions.contracts.length > 0 && (
            <div className="field span2">
              <label>Settles a contract? (✓ = amount matches)</label>
              <select value={form.pays} onChange={(e) => setForm({ ...form, pays: e.target.value })}>
                <option value="">No — not under contract</option>
                {byMatch(linkOptions.contracts).map((c) => (
                  <option key={`c${c.id}`} value={`contract:${c.id}`}>
                    {near(c.amount) ? '✓ ' : ''}{c.commodity}{c.counterparty ? ` — ${c.counterparty}` : ''} · {cents(c.amount)} · expected {c.due_date}
                  </option>
                ))}
              </select>
              {form.pays.startsWith('contract:') && <span className="split-lines">Settles the contract with this deposit; income category and buyer fill in from it.</span>}
            </div>
          )}
          {form.is_split && !form.is_transfer ? (
            <SplitEditor pieces={pieces} setPieces={setPieces} categories={categories} total={form.amount} />
          ) : (
            <>
              {!form.is_transfer && (
                <div className="field">
                  <label>Category</label>
                  <CategorySelect categories={categories} value={form.category_id} preferKind={amt > 0 ? 'income' : 'expense'}
                    onChange={(v) => setForm((f) => ({ ...f, category_id: v }))} />
                  {amt > 0 && !form.category_id && (
                    <span className="split-lines" style={{ color: 'var(--gold-bright)' }}>Money in needs an income category, or it waits on Review.</span>
                  )}
                </div>
              )}
              {!pairedTransfer && <OwnerFields state={form} setState={setForm} />}
            </>
          )}
          {!(pairedTransfer && !editing) && <div className="field">
            <label>Ledger</label>
            <select value={form.ledger} onChange={(e) => setForm({ ...form, ledger: e.target.value })}>
              <option value="">Automatic — Grain/Cattle = business, Jake/Ashley = personal</option>
              <option value="business">Business</option>
              <option value="personal">Personal</option>
            </select>
          </div>}
          {!form.is_transfer && (
            <div className="field">
              <label>
                <input type="checkbox" checked={form.is_capex} onChange={(e) => setForm({ ...form, is_capex: e.target.checked })} /> Capital expenditure
              </label>
            </div>
          )}
          {!onCard && !editing && !pairedTransfer && (
            <div className="field">
              <label>
                <input type="checkbox" checked={form.paid_by_check} onChange={(e) => setForm({ ...form, paid_by_check: e.target.checked })} /> Paid by check (not yet cleared)
              </label>
            </div>
          )}
          <div className="field">
            <label>
              <input type="checkbox" checked={form.needs_review} onChange={(e) => setForm({ ...form, needs_review: e.target.checked })} />
              {' '}Needs review — not sure about this one (it still counts; it waits on the Review tab until checked)
            </label>
          </div>
          {form.needs_review && (
            <div className="field">
              <label>What's uncertain</label>
              <input value={form.review_note} onChange={(e) => setForm({ ...form, review_note: e.target.value })}
                placeholder="e.g. Can't tell if this Amazon order was farm or personal" />
            </div>
          )}
          {error && <p className="review-error" style={{ margin: 0 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit">{editing ? 'Save changes' : 'Save transaction'}</button>
            {editing && <button type="button" className="secondary" onClick={cancelEdit}>Cancel</button>}
          </div>
        </form>
      </div>

      <div className="panel">
        <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span>
            Transactions
            {payeeFilter && (
              <> — {payees.find((x) => String(x.id) === String(payeeFilter))?.name || 'one payee'}{' '}
                <button type="button" className="small secondary" onClick={() => { setPayeeFilter(''); window.history.replaceState(null, '', '/ledgers'); }}>Show all</button>
              </>
            )}
            {outstandingCount > 0 && ` — ${outstandingCount} outstanding check${outstandingCount === 1 ? '' : 's'} totaling ${money(outstandingTotal)}`}
          </span>
          <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', textTransform: 'none', letterSpacing: 0 }}>
            <select aria-label="Account or card" value={where} onChange={(e) => setWhere(e.target.value)}>
              <option value="">All accounts &amp; cards</option>
              <optgroup label="Accounts">
                {accounts.map((a) => <option key={a.id} value={`a:${a.id}`}>{a.name}</option>)}
              </optgroup>
              {cards.length > 0 && (
                <optgroup label="Credit cards">
                  {cards.map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}
                </optgroup>
              )}
            </select>
            <form onSubmit={(e) => { e.preventDefault(); load(); }} style={{ display: 'inline-flex', gap: 4 }}>
              <input aria-label="Search descriptions" placeholder="Search descriptions" value={search}
                onChange={(e) => setSearch(e.target.value)} style={{ width: 180 }} />
              <button type="submit" className="small secondary">Search</button>
            </form>
            <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} />
              Needs review only
            </label>
            <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={outstandingOnly} onChange={(e) => setOutstandingOnly(e.target.checked)} />
              Outstanding checks only
            </label>
          </span>
        </div>
        {balance && (
          <div className="balance-strip">
            {balance.kind === 'account' ? (
              <>
                <span><b>{cents(balance.balance_now)}</b> balance in Money Hub</span>
                {balance.outstanding_count > 0 ? (
                  <span>
                    <b>{cents(balance.bank_balance)}</b> the bank should show — {balance.outstanding_count} outstanding
                    {' '}({cents(balance.outstanding)}) not through yet
                  </span>
                ) : <span>Nothing outstanding — the bank should show the same.</span>}
              </>
            ) : (
              <>
                <span><b>{cents(balance.balance_now)}</b> owed on {balance.name}</span>
                <span>{balance.itemized_from ? `Running balance counted from ${balance.itemized_from}.` : 'Not itemized — set a starting balance on Credit Cards to see a running balance.'}</span>
              </>
            )}
          </div>
        )}
        {visible.length === 0 ? (
          <div className="empty-state">{outstandingOnly ? 'Nothing outstanding.' : 'No transactions recorded yet.'}</div>
        ) : (
          <table>
            <thead>
              <tr>
                {SORT_COLUMNS.map(([key, label]) => (
                  <th key={key} className="sortable" aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'date' || key === 'amount' ? 'desc' : 'asc' }))}>
                      {label}<span className="sort-mark" aria-hidden="true">{sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                    </button>
                  </th>
                ))}
                {balance && <th className="num" title={sort.key === 'date' ? '' : 'Sort by date to read it top to bottom'}>{balance.kind === 'card' ? 'Owed after' : 'Balance'}</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id} style={editing?.id === t.id ? { background: 'var(--gold-soft)' } : undefined}>
                  <td>{t.date?.slice(0, 10)}</td>
                  <td>
                    {t.account_name || (t.card_name ? `${t.card_name} (card)` : '—')}
                    {t.account_name && t.card_name && <div className="split-lines">to {t.card_name}</div>}
                  </td>
                  <td>
                    {t.description}
                    {t.is_transfer && <span className="tag">Transfer</span>}
                    {t.pays && <span className="tag tag-link">{t.pays}</span>}
                    {t.receipt_id && <a className="tag" href={`/api/receipts/${t.receipt_id}/image`} target="_blank" rel="noreferrer">Receipt</a>}
                    {t.payee_name && <div className="split-lines" style={{ color: 'var(--text)' }}>{Number(t.amount) > 0 ? 'From' : 'To'} {t.payee_name}</div>}
                    {t.source && <span className="tag" title={`From ${t.source}`}>Statement</span>}
                    {t.needs_review && <span className="badge warn" style={{ marginLeft: 6 }}>NEEDS REVIEW</span>}
                    {t.needs_review && t.review_note && <div className="split-lines" style={{ color: 'var(--gold-bright)' }}>{t.review_note}</div>}
                    {!t.is_split && t.category_name && <div className="split-lines">{t.category_name}</div>}
                    {t.is_split && (t.splits || []).map((s) => (
                      <div className="split-lines" key={s.id}>
                        {cents(s.amount)} · {s.category_name || s.memo || 'Uncategorized'} · {OWNER_LABELS[s.segment] || 'Split'}
                        {s.is_transfer ? ' · transfer' : ''}
                      </div>
                    ))}
                  </td>
                  <td>
                    {t.is_split ? 'Split' : ownerSummary(t)}
                    {!t.is_split && <div className="split-lines">{t.ledger}</div>}
                  </td>
                  <td>
                    <span className="nowrap">{cents(Number(t.amount))}</span>
                    {t.gst_amount != null && Number(t.gst_amount) > 0 && <div className="split-lines nowrap">incl. GST {cents(Number(t.gst_amount))}</div>}
                    <div style={{ marginTop: 4 }}>
                      {!t.account_id ? <span className="tag" style={{ marginLeft: 0 }}>On card</span> : t.cleared ? (
                        <span className="badge pass">CLEARED</span>
                      ) : (
                        <span className="badge warn">OUTSTANDING</span>
                      )}
                    </div>
                  </td>
                  {balance && (
                    <td className="nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {t.running_balance == null ? '—' : cents(t.running_balance)}
                    </td>
                  )}
                  <td>
                    {t.account_id && !t.cleared && (
                      <button className="small" onClick={() => markCleared(t.id)}>Mark cleared</button>
                    )}{' '}
                    {t.in_closed_month ? (
                      <span className="tag" title="This month is closed on the Books tab" style={{ marginLeft: 0 }}>Closed month</span>
                    ) : (
                      <>
                        <button className="small secondary" onClick={() => startEdit(t)}>Edit</button>{' '}
                        <button className="small secondary" onClick={() => remove(t)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
