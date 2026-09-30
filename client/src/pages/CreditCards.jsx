import { Fragment, useEffect, useState } from 'react';
import { money, pct } from '../format.js';
import { OWNER_LABELS } from '../owners.jsx';

const emptyForm = {
  name: '', issuer: '', last4: '', credit_limit: '', apr_purchase: '', apr_cash_advance: '',
  annual_fee: '0', annual_fee_month: '', grace_period_days: '21', segment: 'grain', notes: '',
  current_balance: '', current_balance_as_of: '',
};
const emptyStatement = { statement_date: '', due_date: '', statement_balance: '', minimum_payment: '', interest_amount: '', notes: '' };
const emptyReward = { category: '', rate_pct: '', notes: '' };
const today = () => new Date().toISOString().slice(0, 10);
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEGMENT_LABELS = OWNER_LABELS;

export default function CreditCards() {
  const [cards, setCards] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [statements, setStatements] = useState({}); // cardId -> rows
  const [statementForm, setStatementForm] = useState(emptyStatement);
  const [rewardForm, setRewardForm] = useState(emptyReward);
  const [payingId, setPayingId] = useState(null);
  const [payAccountId, setPayAccountId] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payByCheck, setPayByCheck] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [calcAmount, setCalcAmount] = useState('');
  const [calcCategory, setCalcCategory] = useState('');
  const [calcResult, setCalcResult] = useState(null);
  const [cardTx, setCardTx] = useState({}); // cardId -> recent transactions charged to / paid on it
  const [ledgerForm, setLedgerForm] = useState({ start_date: '', opening_balance: '' });

  const load = () => { fetch('/api/credit-cards').then((r) => r.json()).then((d) => setCards(Array.isArray(d) ? d : [])); };
  useEffect(() => {
    load();
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
  }, []);

  const refreshAll = () => { load(); setStatements({}); };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/credit-cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        credit_limit: form.credit_limit ? Number(form.credit_limit) : null,
        apr_purchase: Number(form.apr_purchase),
        apr_cash_advance: form.apr_cash_advance ? Number(form.apr_cash_advance) : null,
        annual_fee: Number(form.annual_fee) || 0,
        annual_fee_month: form.annual_fee_month ? Number(form.annual_fee_month) : null,
        grace_period_days: Number(form.grace_period_days) || 21,
        current_balance: form.current_balance !== '' ? Number(form.current_balance) : null,
        current_balance_as_of: form.current_balance_as_of || null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not save card (HTTP ${res.status}).`);
      return;
    }
    setForm(emptyForm);
    refreshAll();
  };

  const startEdit = (c) => {
    setEditingId(c.id);
    setEditForm({
      name: c.name || '', issuer: c.issuer || '', last4: c.last4 || '',
      credit_limit: c.credit_limit ?? '', apr_purchase: c.apr_purchase, apr_cash_advance: c.apr_cash_advance ?? '',
      annual_fee: c.annual_fee, annual_fee_month: c.annual_fee_month ?? '', grace_period_days: c.grace_period_days,
      status: c.status, segment: c.segment || 'grain', notes: c.notes || '',
      current_balance: c.current_balance ?? '', current_balance_as_of: c.current_balance_as_of?.slice(0, 10) || '',
    });
    setError(null);
  };

  const saveEdit = async (id) => {
    setError(null);
    const res = await fetch(`/api/credit-cards/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...editForm,
        credit_limit: editForm.credit_limit !== '' ? Number(editForm.credit_limit) : null,
        apr_purchase: Number(editForm.apr_purchase),
        apr_cash_advance: editForm.apr_cash_advance !== '' ? Number(editForm.apr_cash_advance) : null,
        annual_fee: Number(editForm.annual_fee) || 0,
        annual_fee_month: editForm.annual_fee_month !== '' ? Number(editForm.annual_fee_month) : null,
        grace_period_days: Number(editForm.grace_period_days) || 21,
        current_balance: editForm.current_balance !== '' ? Number(editForm.current_balance) : null,
        current_balance_as_of: editForm.current_balance_as_of || null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not save card (HTTP ${res.status}).`);
      return;
    }
    setEditingId(null);
    setEditForm(null);
    refreshAll();
  };

  const deleteCard = async (c) => {
    if (!window.confirm(`Delete "${c.name}" and its statement/reward history? Recorded ledger transactions are kept.`)) return;
    const res = await fetch(`/api/credit-cards/${c.id}`, { method: 'DELETE' });
    if (!res.ok) { setError(`Could not delete card (HTTP ${res.status}).`); return; }
    if (expandedId === c.id) setExpandedId(null);
    refreshAll();
  };

  const toggleExpand = (c) => {
    setExpandedId(expandedId === c.id ? null : c.id);
    setStatementForm(emptyStatement);
    setRewardForm(emptyReward);
    if (!statements[c.id]) {
      fetch(`/api/credit-cards/${c.id}/statements`).then((r) => r.json())
        .then((rows) => setStatements((s) => ({ ...s, [c.id]: rows })));
    }
    setLedgerForm({ start_date: '', opening_balance: '' });
    fetch(`/api/transactions?credit_card_id=${c.id}&limit=25`).then((r) => r.json())
      .then((rows) => setCardTx((t) => ({ ...t, [c.id]: rows })));
  };

  const addStatement = async (cardId) => {
    setError(null);
    const res = await fetch(`/api/credit-cards/${cardId}/statements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...statementForm,
        statement_date: statementForm.statement_date || null,
        statement_balance: Number(statementForm.statement_balance),
        minimum_payment: statementForm.minimum_payment !== '' ? Number(statementForm.minimum_payment) : null,
        interest_amount: statementForm.interest_amount !== '' ? Number(statementForm.interest_amount) : null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not log statement (HTTP ${res.status}).`);
      return;
    }
    setStatementForm(emptyStatement);
    const rows = await fetch(`/api/credit-cards/${cardId}/statements`).then((r) => r.json());
    setStatements((s) => ({ ...s, [cardId]: rows }));
    load();
  };

  const payStatement = async (stmtId, cardId) => {
    setError(null);
    const res = await fetch(`/api/credit-cards/statements/${stmtId}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: payAccountId,
        amount: payAmount !== '' ? Number(payAmount) : null,
        paid_date: today(),
        paid_by_check: payByCheck,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not record payment (HTTP ${res.status}).`);
      return;
    }
    setPayingId(null);
    setPayAccountId('');
    setPayAmount('');
    setPayByCheck(false);
    const rows = await fetch(`/api/credit-cards/${cardId}/statements`).then((r) => r.json());
    setStatements((s) => ({ ...s, [cardId]: rows }));
    load();
  };

  const unpayStatement = async (stmtId, cardId) => {
    if (!window.confirm('Reverse this payment? The ledger transaction it created is deleted and the account balance restored.')) return;
    const res = await fetch(`/api/credit-cards/statements/${stmtId}/unpay`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not reverse payment (HTTP ${res.status}).`);
      return;
    }
    const rows = await fetch(`/api/credit-cards/${cardId}/statements`).then((r) => r.json());
    setStatements((s) => ({ ...s, [cardId]: rows }));
    load();
  };

  const deleteStatement = async (stmtId, cardId) => {
    if (!window.confirm('Delete this statement record?')) return;
    const res = await fetch(`/api/credit-cards/statements/${stmtId}`, { method: 'DELETE' });
    if (!res.ok) { setError(`Could not delete (HTTP ${res.status}).`); return; }
    const rows = await fetch(`/api/credit-cards/${cardId}/statements`).then((r) => r.json());
    setStatements((s) => ({ ...s, [cardId]: rows }));
    load();
  };

  const startLedger = async (cardId) => {
    setError(null);
    const res = await fetch(`/api/credit-cards/${cardId}/start-ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_date: ledgerForm.start_date, opening_balance: Number(ledgerForm.opening_balance) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not start itemizing (HTTP ${res.status}).`);
      return;
    }
    load();
  };

  const addReward = async (cardId) => {
    setError(null);
    const res = await fetch(`/api/credit-cards/${cardId}/rewards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...rewardForm, rate_pct: Number(rewardForm.rate_pct) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not add reward category (HTTP ${res.status}).`);
      return;
    }
    setRewardForm(emptyReward);
    load();
  };

  const deleteReward = async (id) => {
    const res = await fetch(`/api/credit-cards/rewards/${id}`, { method: 'DELETE' });
    if (!res.ok) { setError(`Could not delete (HTTP ${res.status}).`); return; }
    load();
  };

  const runCalc = async () => {
    if (!calcAmount) return;
    const params = new URLSearchParams({ amount: calcAmount, category: calcCategory });
    const data = await fetch(`/api/credit-cards/rewards/estimate?${params}`).then((r) => r.json());
    setCalcResult(data);
  };

  const totalBalance = cards.reduce((s, c) => s + Number(c.outstanding_balance), 0);
  const anyGraceLost = cards.some((c) => c.grace_period_intact === false);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Credit Cards</h1>
        <span className="page-meta">{money(totalBalance)} outstanding across {cards.length} card{cards.length === 1 ? '' : 's'}</span>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: 'var(--red, #c0392b)' }}>
          <div className="panel-header">Something went wrong</div>
          <p style={{ margin: '8px 0 0', color: 'var(--red, #c0392b)' }}>{error}</p>
        </div>
      )}

      {anyGraceLost && (
        <div className="notice" style={{ borderColor: 'var(--negative)', color: 'var(--negative)' }}>
          At least one card's last statement wasn't paid in full by its due date — its grace period is gone, so
          new purchases on it accrue interest from the transaction date until a full payment resets it.
        </div>
      )}

      <div className="panel">
        <div className="panel-header">Add card</div>
        <form className="form-panel" onSubmit={submit}>
          <div className="field">
            <label>Name (yours to pick)</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Capital One Gold" />
          </div>
          <div className="field">
            <label>Issuer</label>
            <input value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="e.g. Capital One" />
          </div>
          <div className="field">
            <label>Last 4 digits</label>
            <input value={form.last4} onChange={(e) => setForm({ ...form, last4: e.target.value })} maxLength={4} />
          </div>
          <div className="field">
            <label>Owner</label>
            <select value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })}>
              {Object.entries(SEGMENT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Credit limit</label>
            <input type="number" step="0.01" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })} />
          </div>
          <div className="field">
            <label>Purchase APR (%)</label>
            <input type="number" step="0.01" required value={form.apr_purchase} onChange={(e) => setForm({ ...form, apr_purchase: e.target.value })} />
          </div>
          <div className="field">
            <label>Cash advance APR (%, optional — defaults to purchase APR)</label>
            <input type="number" step="0.01" value={form.apr_cash_advance} onChange={(e) => setForm({ ...form, apr_cash_advance: e.target.value })} />
          </div>
          <div className="field">
            <label>Grace period (days)</label>
            <input type="number" value={form.grace_period_days} onChange={(e) => setForm({ ...form, grace_period_days: e.target.value })} />
          </div>
          <div className="field">
            <label>Annual fee</label>
            <input type="number" step="0.01" value={form.annual_fee} onChange={(e) => setForm({ ...form, annual_fee: e.target.value })} />
          </div>
          <div className="field">
            <label>Annual fee posts in (month, optional)</label>
            <select value={form.annual_fee_month} onChange={(e) => setForm({ ...form, annual_fee_month: e.target.value })}>
              <option value="">— unknown —</option>
              {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Current balance (optional — what you owe right now, per the issuer's app)</label>
            <input type="number" step="0.01" value={form.current_balance} onChange={(e) => setForm({ ...form, current_balance: e.target.value })} />
          </div>
          {form.current_balance !== '' && (
            <div className="field">
              <label>As of</label>
              <input type="date" value={form.current_balance_as_of} onChange={(e) => setForm({ ...form, current_balance_as_of: e.target.value })} />
            </div>
          )}
          <div className="field">
            <label>Notes</label>
            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <button type="submit">Save card</button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-header">Cards</div>
        {cards.length === 0 ? (
          <div className="empty-state">No cards on file.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Card</th><th>Balance</th><th>Utilization</th><th>APR</th><th>Next due</th>
                <th>Grace period</th><th>Annual fee</th><th></th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => (
                <Fragment key={c.id}>
                  <tr>
                    <td>
                      {c.name}
                      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                        {c.issuer}{c.last4 ? ` …${c.last4}` : ''} · {SEGMENT_LABELS[c.segment] || 'Unassigned'}
                        {c.status === 'closed' && <> · <span className="badge">CLOSED</span></>}
                      </div>
                    </td>
                    <td>
                      {money(Number(c.outstanding_balance))}
                      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                        {c.itemized ? 'itemized' : c.current_balance != null ? 'entered by hand' : 'from latest statement'}
                      </div>
                    </td>
                    <td>{c.utilization_pct != null ? pct(c.utilization_pct / 100) : '—'}</td>
                    <td>{Number(c.apr_purchase).toFixed(2)}%</td>
                    <td>
                      {c.next_due ? (
                        <>
                          {money(c.next_due.amount)}
                          <div style={{ fontSize: 11, color: c.next_due.overdue ? 'var(--negative)' : 'var(--text-faint)' }}>
                            {c.next_due.due_date}{c.next_due.overdue && ' — OVERDUE'}
                          </div>
                        </>
                      ) : '—'}
                    </td>
                    <td>
                      {c.grace_period_intact === null ? '—'
                        : c.grace_period_intact
                        ? <span className="badge pass">INTACT</span>
                        : <span className="badge fail">LOST</span>}
                    </td>
                    <td>{money(Number(c.annual_fee))}{c.annual_fee_month ? <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{MONTH_NAMES[c.annual_fee_month - 1]}</div> : null}</td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                        <button className="small secondary" onClick={() => toggleExpand(c)}>{expandedId === c.id ? 'Hide' : 'Details'}</button>
                        <button className="small secondary" onClick={() => (editingId === c.id ? setEditingId(null) : startEdit(c))}>{editingId === c.id ? 'Close' : 'Edit'}</button>
                        <button className="small secondary" onClick={() => deleteCard(c)}>Delete</button>
                      </span>
                    </td>
                  </tr>

                  {editingId === c.id && editForm && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--panel-alt, rgba(255,255,255,0.03))' }}>
                        <div style={{ padding: '12px 4px' }}>
                          <div className="form-panel" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
                            <div className="field"><label>Name</label>
                              <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
                            <div className="field"><label>Issuer</label>
                              <input value={editForm.issuer} onChange={(e) => setEditForm({ ...editForm, issuer: e.target.value })} /></div>
                            <div className="field"><label>Last 4</label>
                              <input value={editForm.last4} onChange={(e) => setEditForm({ ...editForm, last4: e.target.value })} maxLength={4} /></div>
                            <div className="field"><label>Owner</label>
                              <select value={editForm.segment} onChange={(e) => setEditForm({ ...editForm, segment: e.target.value })}>
                                {Object.entries(SEGMENT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                              </select></div>
                            <div className="field"><label>Status</label>
                              <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}>
                                <option value="active">Active</option><option value="closed">Closed</option>
                              </select></div>
                            <div className="field"><label>Credit limit</label>
                              <input type="number" step="0.01" value={editForm.credit_limit} onChange={(e) => setEditForm({ ...editForm, credit_limit: e.target.value })} /></div>
                            <div className="field"><label>Purchase APR (%)</label>
                              <input type="number" step="0.01" value={editForm.apr_purchase} onChange={(e) => setEditForm({ ...editForm, apr_purchase: e.target.value })} /></div>
                            <div className="field"><label>Cash advance APR (%)</label>
                              <input type="number" step="0.01" value={editForm.apr_cash_advance} onChange={(e) => setEditForm({ ...editForm, apr_cash_advance: e.target.value })} /></div>
                            <div className="field"><label>Grace period (days)</label>
                              <input type="number" value={editForm.grace_period_days} onChange={(e) => setEditForm({ ...editForm, grace_period_days: e.target.value })} /></div>
                            <div className="field"><label>Annual fee</label>
                              <input type="number" step="0.01" value={editForm.annual_fee} onChange={(e) => setEditForm({ ...editForm, annual_fee: e.target.value })} /></div>
                            <div className="field"><label>Fee month</label>
                              <select value={editForm.annual_fee_month} onChange={(e) => setEditForm({ ...editForm, annual_fee_month: e.target.value })}>
                                <option value="">— unknown —</option>
                                {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                              </select></div>
                            <div className="field"><label>Current balance{c.itemized ? ' (not used — itemized)' : ''}</label>
                              <input type="number" step="0.01" value={editForm.current_balance} onChange={(e) => setEditForm({ ...editForm, current_balance: e.target.value })} /></div>
                            <div className="field"><label>As of</label>
                              <input type="date" value={editForm.current_balance_as_of} onChange={(e) => setEditForm({ ...editForm, current_balance_as_of: e.target.value })} /></div>
                            <div className="field"><label>Notes</label>
                              <input value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} /></div>
                          </div>
                          <div style={{ marginTop: 8 }}>
                            <button className="small" onClick={() => saveEdit(c.id)}>Save changes</button>
                            {' '}
                            <button className="small secondary" onClick={() => { setEditingId(null); setEditForm(null); }}>Cancel</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}

                  {expandedId === c.id && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--panel-alt, rgba(255,255,255,0.03))' }}>
                        <div style={{ padding: '12px 4px' }}>
                          <div className="metric-label" style={{ margin: '0 0 8px' }}>Purchases</div>
                          {c.itemized ? (
                            <>
                              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
                                Itemized since {c.ledger_start_date} — the balance is what the card owed then plus every purchase,
                                refund and payment since. Purchases count as expenses when made; payments are transfers.
                              </p>
                              {!cardTx[c.id] ? null : cardTx[c.id].length === 0 ? (
                                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 14px' }}>Nothing entered yet.</p>
                              ) : (
                                <table style={{ marginBottom: 14 }}>
                                  <thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>
                                  <tbody>
                                    {cardTx[c.id].map((t) => (
                                      <tr key={t.id}>
                                        <td>{t.date}</td>
                                        <td>
                                          {t.description}
                                          {t.account_name && <span className="tag">Payment from {t.account_name}</span>}
                                          {t.is_split && <span className="tag">Split</span>}
                                        </td>
                                        <td>{money(t.account_name ? -Number(t.amount) : Number(t.amount))}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </>
                          ) : (
                            <div style={{ margin: '0 0 16px' }}>
                              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>
                                Not itemized — the balance comes from statements, and payments count as the expense. Turn on
                                itemizing to enter purchases one by one (an agent's first card statement does this automatically).
                              </p>
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                <input type="date" aria-label="Itemize from" style={{ maxWidth: 160 }}
                                  value={ledgerForm.start_date} onChange={(e) => setLedgerForm({ ...ledgerForm, start_date: e.target.value })} />
                                <input type="number" step="0.01" placeholder="Balance owed on that date" style={{ maxWidth: 200 }}
                                  value={ledgerForm.opening_balance} onChange={(e) => setLedgerForm({ ...ledgerForm, opening_balance: e.target.value })} />
                                <button className="small" disabled={!ledgerForm.start_date || ledgerForm.opening_balance === ''} onClick={() => startLedger(c.id)}>Start itemizing</button>
                              </div>
                            </div>
                          )}

                          <div className="metric-label" style={{ margin: '0 0 8px' }}>Reward categories</div>
                          {c.reward_categories.length === 0 ? (
                            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>None entered yet.</p>
                          ) : (
                            <table style={{ marginBottom: 12 }}>
                              <thead><tr><th>Category</th><th>Rate</th><th>Notes</th><th></th></tr></thead>
                              <tbody>
                                {c.reward_categories.map((r) => (
                                  <tr key={r.id}>
                                    <td>{r.category}</td>
                                    <td>{Number(r.rate_pct)}%</td>
                                    <td>{r.notes || '—'}</td>
                                    <td><button className="small secondary" onClick={() => deleteReward(r.id)}>Remove</button></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
                            <input placeholder="Category (e.g. Groceries, Everything else)" style={{ maxWidth: 220 }}
                              value={rewardForm.category} onChange={(e) => setRewardForm({ ...rewardForm, category: e.target.value })} />
                            <input type="number" step="0.01" placeholder="Rate %" style={{ maxWidth: 90 }}
                              value={rewardForm.rate_pct} onChange={(e) => setRewardForm({ ...rewardForm, rate_pct: e.target.value })} />
                            <input placeholder="Notes (optional)" style={{ maxWidth: 180 }}
                              value={rewardForm.notes} onChange={(e) => setRewardForm({ ...rewardForm, notes: e.target.value })} />
                            <button className="small" disabled={!rewardForm.category || rewardForm.rate_pct === ''} onClick={() => addReward(c.id)}>Add</button>
                          </div>

                          <div className="metric-label" style={{ margin: '0 0 8px' }}>Statements</div>
                          {!statements[c.id] ? (
                            <div className="empty-state">Loading…</div>
                          ) : statements[c.id].length === 0 ? (
                            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>No statements logged yet.</p>
                          ) : (
                            <table style={{ marginBottom: 12 }}>
                              <thead><tr><th>Due</th><th>Balance</th><th>Min. payment</th><th>Interest billed</th><th>Status</th><th></th></tr></thead>
                              <tbody>
                                {statements[c.id].map((s, idx) => {
                                  // Statements are cumulative: the newest one is what's due;
                                  // an older unpaid one has rolled into it.
                                  const current = idx === 0;
                                  const remaining = Number(s.statement_balance) - Number(s.paid_amount || 0);
                                  const overdue = current && !s.paid && String(s.due_date).slice(0, 10) < today();
                                  return (
                                    <tr key={s.id}>
                                      <td>{String(s.due_date).slice(0, 10)}</td>
                                      <td>{money(Number(s.statement_balance))}</td>
                                      <td>{s.minimum_payment != null ? money(Number(s.minimum_payment)) : '—'}</td>
                                      <td>{s.interest_amount != null ? money(Number(s.interest_amount)) : '—'}</td>
                                      <td>
                                        {s.paid
                                          ? <span className={`badge ${s.paid_in_full ? 'pass' : 'warn'}`}>{s.paid_in_full ? 'PAID IN FULL' : 'PAID LATE'}</span>
                                          : !current ? <span className="badge">ROLLED INTO NEXT</span>
                                          : overdue ? <span className="badge fail">OVERDUE</span>
                                          : Number(s.paid_amount) > 0 ? <span className="badge warn">{money(remaining)} LEFT</span>
                                          : <span className="badge">UNPAID</span>}
                                      </td>
                                      <td>
                                        {payingId === s.id ? (
                                          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                            <select value={payAccountId} onChange={(e) => setPayAccountId(e.target.value)}>
                                              <option value="">Paid from…</option>
                                              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.ledger})</option>)}
                                            </select>
                                            <input type="number" step="0.01" placeholder={`Amount (default ${money(remaining)})`}
                                              style={{ width: 140 }} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                                            <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                              <input type="checkbox" checked={payByCheck} onChange={(e) => setPayByCheck(e.target.checked)} /> By check
                                            </label>
                                            <button className="small" disabled={!payAccountId} onClick={() => payStatement(s.id, c.id)}>Confirm</button>
                                            <button className="small secondary" onClick={() => { setPayingId(null); setPayAccountId(''); setPayAmount(''); setPayByCheck(false); }}>Cancel</button>
                                          </span>
                                        ) : (
                                          <span style={{ display: 'inline-flex', gap: 4 }}>
                                            {current && !s.paid && (
                                              <button className="small" onClick={() => { setPayingId(s.id); setPayAccountId(''); setPayAmount(''); setPayByCheck(false); }}>Pay</button>
                                            )}
                                            {Number(s.paid_amount) > 0 && (
                                              <button className="small secondary" onClick={() => unpayStatement(s.id, c.id)}>Unpay</button>
                                            )}
                                            {!s.paid && !(Number(s.paid_amount) > 0) && (
                                              <button className="small secondary" onClick={() => deleteStatement(s.id, c.id)}>Delete</button>
                                            )}
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                          <div className="form-panel" style={{ maxWidth: 'none', padding: 0, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                            <div className="field"><label>Statement date (optional)</label>
                              <input type="date" value={statementForm.statement_date} onChange={(e) => setStatementForm({ ...statementForm, statement_date: e.target.value })} /></div>
                            <div className="field"><label>Due date</label>
                              <input type="date" value={statementForm.due_date} onChange={(e) => setStatementForm({ ...statementForm, due_date: e.target.value })} /></div>
                            <div className="field"><label>Statement balance</label>
                              <input type="number" step="0.01" value={statementForm.statement_balance} onChange={(e) => setStatementForm({ ...statementForm, statement_balance: e.target.value })} /></div>
                            <div className="field"><label>Minimum payment</label>
                              <input type="number" step="0.01" value={statementForm.minimum_payment} onChange={(e) => setStatementForm({ ...statementForm, minimum_payment: e.target.value })} /></div>
                            <div className="field"><label>Interest billed (optional)</label>
                              <input type="number" step="0.01" value={statementForm.interest_amount} onChange={(e) => setStatementForm({ ...statementForm, interest_amount: e.target.value })} /></div>
                            <div className="field"><label>Notes</label>
                              <input value={statementForm.notes} onChange={(e) => setStatementForm({ ...statementForm, notes: e.target.value })} /></div>
                          </div>
                          <div style={{ marginTop: 8 }}>
                            <button className="small" disabled={!statementForm.due_date || statementForm.statement_balance === ''} onClick={() => addStatement(c.id)}>
                              Log statement
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">Rewards calculator</div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
          What a purchase would earn on each active card, by its best-matching category rate. This estimates one
          purchase — it isn't a running total of rewards actually earned, since Money Hub doesn't know which card
          paid for which ledger transaction.
        </p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <input type="number" step="0.01" placeholder="Purchase amount" style={{ maxWidth: 140 }}
            value={calcAmount} onChange={(e) => setCalcAmount(e.target.value)} />
          <input placeholder="Category (e.g. Groceries)" style={{ maxWidth: 200 }}
            value={calcCategory} onChange={(e) => setCalcCategory(e.target.value)} />
          <button className="small" disabled={!calcAmount} onClick={runCalc}>Calculate</button>
        </div>
        {calcResult && (
          <table>
            <thead><tr><th>Card</th><th>Matched category</th><th>Rate</th><th>Estimated reward</th></tr></thead>
            <tbody>
              {calcResult.cards.map((r) => (
                <tr key={r.credit_card_id}>
                  <td>{r.name}</td>
                  <td>{r.matched_category || '—'}</td>
                  <td>{r.rate_pct}%</td>
                  <td>{money(r.estimated_reward)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
