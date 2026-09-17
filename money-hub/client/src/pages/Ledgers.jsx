import { useEffect, useState } from 'react';
import { money } from '../format.js';

const emptyForm = {
  account_id: '', ledger: 'business', date: '', amount: '', description: '',
  is_mixed_use: false, mixed_use_business_pct: '', is_capex: false,
};

export default function Ledgers() {
  const [transactions, setTransactions] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState('all');

  const load = () => {
    const q = filter === 'all' ? '' : `?ledger=${filter}`;
    fetch(`/api/transactions${q}`).then((r) => r.json()).then(setTransactions);
  };

  useEffect(load, [filter]);
  useEffect(() => {
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    await fetch('/api/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        amount: Number(form.amount),
        mixed_use_business_pct: form.is_mixed_use ? Number(form.mixed_use_business_pct) : null,
      }),
    });
    setForm(emptyForm);
    load();
  };

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
        <form className="form-panel" onSubmit={submit}>
          <div className="field">
            <label>Account</label>
            <select
              required
              value={form.account_id}
              onChange={(e) => setForm({ ...form, account_id: e.target.value })}
            >
              <option value="">Select account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.ledger})</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Ledger</label>
            <select value={form.ledger} onChange={(e) => setForm({ ...form, ledger: e.target.value })}>
              <option value="business">Business</option>
              <option value="personal">Personal</option>
            </select>
          </div>
          <div className="field">
            <label>Date</label>
            <input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>
          <div className="field">
            <label>Amount (negative = outflow)</label>
            <input type="number" step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div className="field">
            <label>Description</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="field">
            <label>
              <input
                type="checkbox"
                checked={form.is_mixed_use}
                onChange={(e) => setForm({ ...form, is_mixed_use: e.target.checked })}
              /> Mixed-use (cost-basis split)
            </label>
          </div>
          {form.is_mixed_use && (
            <div className="field">
              <label>Business % of cost</label>
              <input
                type="number" min="0" max="100"
                value={form.mixed_use_business_pct}
                onChange={(e) => setForm({ ...form, mixed_use_business_pct: e.target.value })}
              />
            </div>
          )}
          <div className="field">
            <label>
              <input
                type="checkbox"
                checked={form.is_capex}
                onChange={(e) => setForm({ ...form, is_capex: e.target.checked })}
              /> Capital expenditure
            </label>
          </div>
          <button type="submit">Save transaction</button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-header">Recent transactions</div>
        {transactions.length === 0 ? (
          <div className="empty-state">No transactions recorded yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Date</th><th>Ledger</th><th>Description</th><th>Amount</th></tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td>{t.date?.slice(0, 10)}</td>
                  <td>{t.ledger}</td>
                  <td>{t.description}</td>
                  <td>{money(Number(t.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
