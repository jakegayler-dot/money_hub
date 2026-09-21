import { Fragment, useEffect, useState } from 'react';
import { money } from '../format.js';

const emptyForm = {
  name: '', ledger: 'business', category: '', amount: '', frequency: 'one_time',
  received_date: '', due_date: '', notes: '',
  has_gst: false, gst_pct: '5',
  segment: 'grain', is_segment_split: false,
  segment_grain_pct: '', segment_livestock_pct: '', segment_personal_pct: '',
};

const SEGMENT_LABELS = { grain: 'Grain', livestock: 'Livestock', personal: 'Personal' };

// Shared by the add-bill form and the per-bill edit panel: either pick one
// enterprise, or split the amount across all three by percentage — same
// shape as the mixed-use business/personal split elsewhere in the app.
function SegmentFields({ state, setState, disabled }) {
  const splitTotal = (Number(state.segment_grain_pct) || 0) + (Number(state.segment_livestock_pct) || 0) + (Number(state.segment_personal_pct) || 0);
  return (
    <>
      <div className="field">
        <label>
          <input
            type="checkbox" disabled={disabled}
            checked={state.is_segment_split}
            onChange={(e) => setState({ ...state, is_segment_split: e.target.checked })}
          />
          {' '}Split across enterprises
        </label>
      </div>
      {!state.is_segment_split ? (
        <div className="field">
          <label>Enterprise</label>
          <select disabled={disabled} value={state.segment || ''} onChange={(e) => setState({ ...state, segment: e.target.value })}>
            {Object.entries(SEGMENT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      ) : (
        <div className="field">
          <label>Split % (must total 100)</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" step="0.1" disabled={disabled} placeholder="Grain" style={{ width: 70 }}
              value={state.segment_grain_pct} onChange={(e) => setState({ ...state, segment_grain_pct: e.target.value })} />
            <input type="number" step="0.1" disabled={disabled} placeholder="Livestock" style={{ width: 70 }}
              value={state.segment_livestock_pct} onChange={(e) => setState({ ...state, segment_livestock_pct: e.target.value })} />
            <input type="number" step="0.1" disabled={disabled} placeholder="Personal" style={{ width: 70 }}
              value={state.segment_personal_pct} onChange={(e) => setState({ ...state, segment_personal_pct: e.target.value })} />
          </div>
          <p style={{ fontSize: 11, color: splitTotal === 100 ? 'var(--text-muted)' : 'var(--negative)', margin: '4px 0 0' }}>
            Total: {splitTotal}%
          </p>
        </div>
      )}
    </>
  );
}

function segmentSummary(b) {
  if (b.is_segment_split) {
    const parts = [];
    if (Number(b.segment_grain_pct)) parts.push(`Grain ${b.segment_grain_pct}%`);
    if (Number(b.segment_livestock_pct)) parts.push(`Livestock ${b.segment_livestock_pct}%`);
    if (Number(b.segment_personal_pct)) parts.push(`Personal ${b.segment_personal_pct}%`);
    return parts.join(' / ') || 'Split';
  }
  return SEGMENT_LABELS[b.segment] || '—';
}

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
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/bills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        amount: Number(form.amount),
        category: form.category || null,
        received_date: form.received_date || null,
        notes: form.notes || null,
        gst_pct: form.has_gst ? Number(form.gst_pct) : 5,
        segment: form.is_segment_split ? null : form.segment,
        segment_grain_pct: form.is_segment_split ? Number(form.segment_grain_pct) || 0 : null,
        segment_livestock_pct: form.is_segment_split ? Number(form.segment_livestock_pct) || 0 : null,
        segment_personal_pct: form.is_segment_split ? Number(form.segment_personal_pct) || 0 : null,
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
        paid_date: new Date().toISOString().slice(0, 10),
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
      name: b.name, category: b.category || '', amount: b.amount, due_date: b.due_date?.slice(0, 10),
      notes: b.notes || '', has_gst: b.has_gst, gst_pct: b.gst_pct,
      segment: b.segment || 'grain', is_segment_split: b.is_segment_split,
      segment_grain_pct: b.segment_grain_pct ?? '', segment_livestock_pct: b.segment_livestock_pct ?? '',
      segment_personal_pct: b.segment_personal_pct ?? '',
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
        amount: Number(editForm.amount),
        gst_pct: Number(editForm.gst_pct),
        segment: editForm.is_segment_split ? null : editForm.segment,
        segment_grain_pct: editForm.is_segment_split ? Number(editForm.segment_grain_pct) || 0 : null,
        segment_livestock_pct: editForm.is_segment_split ? Number(editForm.segment_livestock_pct) || 0 : null,
        segment_personal_pct: editForm.is_segment_split ? Number(editForm.segment_personal_pct) || 0 : null,
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

  const totalUnpaid = bills
    .filter((b) => b.status === 'unpaid')
    .reduce((s, b) => s + Number(b.amount), 0);
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
        <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Invoices received, sorted by due date</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="unpaid">Unpaid</option>
            <option value="paid">Paid</option>
            <option value="all">All</option>
          </select>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
          Marking a bill paid asks which account it came out of, and moves that account's balance —
          it isn't just a status label. Check "By check" if it might sit uncashed for a while;
          it still leaves the balance right away, but the Ledgers tab will flag it as
          not-yet-cleared until you reconcile it against your bank statement.
        </p>
        {bills.length === 0 ? (
          <div className="empty-state">Nothing to show.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Due</th><th>Name</th><th>Category</th><th>Ledger</th><th>Enterprise</th><th>Subtotal</th><th>GST</th><th>Total</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {bills.map((b) => {
                const overdue = b.status === 'unpaid' && new Date(b.due_date) < new Date();
                return (
                  <Fragment key={b.id}>
                    <tr>
                      <td>{b.due_date?.slice(0, 10)}</td>
                      <td>{b.name}</td>
                      <td>{b.category || '—'}</td>
                      <td>{b.ledger}</td>
                      <td>{segmentSummary(b)}</td>
                      <td>{b.has_gst ? money(Number(b.subtotal_amount)) : '—'}</td>
                      <td>{b.has_gst ? `${money(Number(b.gst_amount))} (${Number(b.gst_pct)}%)` : '—'}</td>
                      <td>{money(Number(b.amount))}</td>
                      <td>
                        {b.status === 'paid' ? (
                          <span className="badge pass">PAID</span>
                        ) : overdue ? (
                          <span className="badge fail">OVERDUE</span>
                        ) : (
                          <span className="badge warn">UNPAID</span>
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
                              <button className="small secondary" onClick={() => undoPayment(b.id)}>Undo payment</button>
                            )}
                            <button className="small secondary" onClick={() => remove(b.id)}>Delete</button>
                          </span>
                        )}
                      </td>
                    </tr>
                    {editingId === b.id && editForm && (
                      <tr>
                        <td colSpan={10} style={{ background: 'var(--panel-alt, rgba(255,255,255,0.03))' }}>
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
                                <label>Name / vendor</label>
                                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                              </div>
                              <div className="field">
                                <label>Category</label>
                                <input value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} />
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
                              <SegmentFields state={editForm} setState={setEditForm} disabled={false} />
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
      </div>

      <div className="panel">
        <div className="panel-header">Record a received bill</div>
        <form className="form-panel" onSubmit={submit}>
          <div className="field">
            <label>Name / vendor</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. AgriChem Ltd — invoice #4471" />
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
            <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="e.g. Inputs, Utilities" />
          </div>
          <SegmentFields state={form} setState={setForm} disabled={false} />
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
            </select>
          </div>
          <div className="field">
            <label>Received date (optional)</label>
            <input type="date" value={form.received_date} onChange={(e) => setForm({ ...form, received_date: e.target.value })} />
          </div>
          <div className="field">
            <label>Due date</label>
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
