import { useEffect, useState } from 'react';
import { money } from '../format.js';
import { OwnerFields, ownerPayload, ownerSummary, emptyOwnerFields, OWNER_LABELS } from '../owners.jsx';
import SplitEditor, { cents, newPiece, piecesPayload } from '../components/SplitEditor.jsx';

const emptyForm = {
  source: 'account', account_id: '', credit_card_id: '', ledger: '', date: '', amount: '', description: '',
  category_id: '', is_mixed_use: false, mixed_use_business_pct: '', is_capex: false, is_transfer: false,
  paid_by_check: false, is_split: false,
  ...emptyOwnerFields,
};

export default function Ledgers() {
  const [transactions, setTransactions] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [cards, setCards] = useState([]);
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [pieces, setPieces] = useState([newPiece(), newPiece()]);
  const [filter, setFilter] = useState('all');
  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [error, setError] = useState(null);

  const load = () => {
    const q = filter === 'all' ? '' : `?ledger=${filter}`;
    fetch(`/api/transactions${q}`).then((r) => r.json()).then(setTransactions);
  };

  useEffect(load, [filter]);
  useEffect(() => {
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
    fetch('/api/credit-cards').then((r) => r.json()).then((c) => setCards(c.filter((x) => x.status === 'active')));
    fetch('/api/expenses').then((r) => r.json()).then(setCategories);
  }, []);

  const onCard = form.source === 'card';
  const itemizedCards = cards.filter((c) => c.itemized);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const r = await fetch('/api/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: onCard ? null : Number(form.account_id),
        credit_card_id: onCard ? Number(form.credit_card_id) : null,
        ledger: form.ledger || null, date: form.date, amount: Number(form.amount), description: form.description,
        category_id: !form.is_split && form.category_id ? Number(form.category_id) : null,
        is_mixed_use: form.is_mixed_use,
        mixed_use_business_pct: form.is_mixed_use ? Number(form.mixed_use_business_pct) : null,
        is_capex: form.is_capex,
        is_transfer: !onCard && form.is_transfer,
        cleared: onCard || !form.paid_by_check,
        splits: form.is_split ? piecesPayload(pieces) : [],
        ...ownerPayload(form),
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
  };

  const markCleared = async (id) => {
    await fetch(`/api/transactions/${id}/clear`, { method: 'POST' });
    load();
  };

  const remove = async (t) => {
    if (!window.confirm(`Delete "${t.description || 'this transaction'}" (${cents(t.amount)})? ${t.account_name ? `${t.account_name}'s balance goes back by that amount.` : ''}`)) return;
    const r = await fetch(`/api/transactions/${t.id}`, { method: 'DELETE' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      window.alert(body.error || 'Could not delete.');
    }
    load();
  };

  const visible = outstandingOnly ? transactions.filter((t) => !t.cleared) : transactions;
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
        <div className="panel-header">Record transaction</div>
        <form className="form-panel" onSubmit={submit} style={{ maxWidth: 640 }}>
          <div className="field">
            <label>Paid with</label>
            <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
              <option value="account">An account (cash, cheque, debit, e-transfer)</option>
              <option value="card">A credit card (charged, not yet paid)</option>
            </select>
          </div>
          {!onCard ? (
            <div className="field">
              <label>Account</label>
              <select required value={form.account_id} onChange={(e) => setForm({ ...form, account_id: e.target.value })}>
                <option value="">Select account</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.ledger})</option>)}
              </select>
            </div>
          ) : (
            <div className="field">
              <label>Card</label>
              <select required value={form.credit_card_id} onChange={(e) => setForm({ ...form, credit_card_id: e.target.value })}>
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
            <input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div className="field">
            <label>Amount (negative = money out / spent)</label>
            <input type="number" step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div className="field">
            <label>Description</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          {!onCard && (
            <div className="field">
              <label>
                <input type="checkbox" checked={form.is_transfer} onChange={(e) => setForm({ ...form, is_transfer: e.target.checked, is_split: false })} />
                {' '}Transfer — money moving between accounts, a loan advance, etc. (not income or spending)
              </label>
            </div>
          )}
          {!form.is_transfer && (
            <div className="field">
              <label>
                <input type="checkbox" checked={form.is_split} onChange={(e) => setForm({ ...form, is_split: e.target.checked })} />
                {' '}Split into pieces (different categories or owners)
              </label>
            </div>
          )}
          {form.is_split && !form.is_transfer ? (
            <SplitEditor pieces={pieces} setPieces={setPieces} categories={categories} total={form.amount} />
          ) : (
            <>
              {!form.is_transfer && (
                <div className="field">
                  <label>Category</label>
                  <select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
                    <option value="">No category</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.name}</option>)}
                  </select>
                </div>
              )}
              <OwnerFields state={form} setState={setForm} />
            </>
          )}
          <div className="field">
            <label>Ledger</label>
            <select value={form.ledger} onChange={(e) => setForm({ ...form, ledger: e.target.value })}>
              <option value="">Automatic — Grain/Cattle = business, Jake/Ashley = personal</option>
              <option value="business">Business</option>
              <option value="personal">Personal</option>
            </select>
          </div>
          {!form.is_transfer && (
            <div className="field">
              <label>
                <input type="checkbox" checked={form.is_capex} onChange={(e) => setForm({ ...form, is_capex: e.target.checked })} /> Capital expenditure
              </label>
            </div>
          )}
          {!onCard && (
            <div className="field">
              <label>
                <input type="checkbox" checked={form.paid_by_check} onChange={(e) => setForm({ ...form, paid_by_check: e.target.checked })} /> Paid by check (not yet cleared)
              </label>
            </div>
          )}
          {error && <p className="review-error" style={{ margin: 0 }}>{error}</p>}
          <button type="submit">Save transaction</button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <span>
            Recent transactions
            {outstandingCount > 0 && ` — ${outstandingCount} outstanding check${outstandingCount === 1 ? '' : 's'} totaling ${money(outstandingTotal)}`}
          </span>
          <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={outstandingOnly} onChange={(e) => setOutstandingOnly(e.target.checked)} />
            Outstanding checks only
          </label>
        </div>
        {visible.length === 0 ? (
          <div className="empty-state">{outstandingOnly ? 'Nothing outstanding.' : 'No transactions recorded yet.'}</div>
        ) : (
          <table>
            <thead>
              <tr><th>Date</th><th>Account / card</th><th>Ledger</th><th>Owner</th><th>Description</th><th>Amount</th><th>Cleared</th><th></th></tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id}>
                  <td>{t.date?.slice(0, 10)}</td>
                  <td>
                    {t.account_name || (t.card_name ? `${t.card_name} (card)` : '—')}
                    {t.account_name && t.card_name && <div className="split-lines">to {t.card_name}</div>}
                  </td>
                  <td>{t.is_split ? 'Split' : t.ledger}</td>
                  <td>{t.is_split ? 'Split' : ownerSummary(t)}</td>
                  <td>
                    {t.description}
                    {t.is_transfer && <span className="tag">Transfer</span>}
                    {t.source && <span className="tag" title={`From ${t.source}`}>Statement</span>}
                    {!t.is_split && t.category_name && <div className="split-lines">{t.category_name}</div>}
                    {t.is_split && (t.splits || []).map((s) => (
                      <div className="split-lines" key={s.id}>
                        {cents(s.amount)} · {s.category_name || s.memo || 'Uncategorized'} · {OWNER_LABELS[s.segment] || 'Split'}
                        {s.is_transfer ? ' · transfer' : ''}
                      </div>
                    ))}
                  </td>
                  <td>{cents(Number(t.amount))}</td>
                  <td>
                    {!t.account_id ? <span className="tag">On card</span> : t.cleared ? (
                      <span className="badge pass">CLEARED</span>
                    ) : (
                      <span className="badge warn">OUTSTANDING</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {t.account_id && !t.cleared && (
                      <button className="small" onClick={() => markCleared(t.id)}>Mark cleared</button>
                    )}{' '}
                    <button className="small secondary" onClick={() => remove(t)}>Delete</button>
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
