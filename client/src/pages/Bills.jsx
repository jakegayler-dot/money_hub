import { useEffect, useState } from 'react';
import { money } from '../format.js';

const emptyForm = {
  name: '', ledger: 'business', category: '', amount: '', frequency: 'one_time',
  received_date: '', due_date: '', notes: '',
  has_gst: false, gst_pct: '5',
};

export default function Bills() {
  const [bills, setBills] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState('unpaid');
  const [error, setError] = useState(null);
  const [payingId, setPayingId] = useState(null);
  const [payAccountId, setPayAccountId] = useState('');
  const [payByCheck, setPayByCheck] = useState(false);

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
              <tr><th>Due</th><th>Name</th><th>Category</th><th>Ledger</th><th>Subtotal</th><th>GST</th><th>Total</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {bills.map((b) => {
                const overdue = b.status === 'unpaid' && new Date(b.due_date) < new Date();
                return (
                  <tr key={b.id}>
                    <td>{b.due_date?.slice(0, 10)}</td>
                    <td>{b.name}</td>
                    <td>{b.category || '—'}</td>
                    <td>{b.ledger}</td>
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
                        <>
                          {b.status === 'unpaid' && (
                            <button className="small" onClick={() => { setPayingId(b.id); setPayAccountId(''); setPayByCheck(false); }}>Mark paid</button>
                          )}
                          {' '}
                          <button className="small secondary" onClick={() => remove(b.id)}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
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
