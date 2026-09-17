import { useEffect, useState } from 'react';
import { money } from '../format.js';

const ACCOUNT_TYPE_LABELS = {
  operating: 'Operating', reserve: 'Reserve', credit: 'Credit card / line of credit',
  personal: 'Personal', investment: 'Investment', draw: 'Draw',
};

const emptyForm = { name: '', ledger: 'business', account_type: 'operating', opening_balance: '' };

export default function Accounts() {
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(emptyForm);

  const load = () => { fetch('/api/accounts').then((r) => r.json()).then(setAccounts); };
  useEffect(load, []);

  const submit = async (e) => {
    e.preventDefault();
    await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, opening_balance: Number(form.opening_balance) }),
    });
    setForm(emptyForm);
    load();
  };

  const business = accounts.filter((a) => a.ledger === 'business');
  const personal = accounts.filter((a) => a.ledger === 'personal');
  const netTotal = accounts.reduce((s, a) => s + Number(a.opening_balance), 0);

  const renderGroup = (label, items) => (
    <div key={label}>
      <div className="panel-header">{label} — net {money(items.reduce((s, a) => s + Number(a.opening_balance), 0))}</div>
      {items.length === 0 ? (
        <div className="empty-state">No accounts yet.</div>
      ) : (
        <table>
          <thead><tr><th>Account</th><th>Type</th><th>Balance</th></tr></thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>{ACCOUNT_TYPE_LABELS[a.account_type] || a.account_type}</td>
                <td style={Number(a.opening_balance) < 0 ? { color: 'var(--negative)' } : undefined}>
                  {money(Number(a.opening_balance))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Accounts</h1>
        <span className="page-meta">Net {money(netTotal)}</span>
      </div>

      <div className="panel">
        {renderGroup('Business', business)}
        {renderGroup('Personal', personal)}
      </div>

      <div className="panel">
        <div className="panel-header">Add account</div>
        <form className="form-panel" onSubmit={submit}>
          <div className="field">
            <label>Account name</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Operating, Personal Credit Card" />
          </div>
          <div className="field">
            <label>Ledger</label>
            <select value={form.ledger} onChange={(e) => setForm({ ...form, ledger: e.target.value })}>
              <option value="business">Business</option>
              <option value="personal">Personal</option>
            </select>
          </div>
          <div className="field">
            <label>Type</label>
            <select value={form.account_type} onChange={(e) => setForm({ ...form, account_type: e.target.value })}>
              {Object.entries(ACCOUNT_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Current balance (negative = amount owed, e.g. a credit card)</label>
            <input type="number" step="0.01" required value={form.opening_balance} onChange={(e) => setForm({ ...form, opening_balance: e.target.value })} />
          </div>
          <button type="submit">Add account</button>
        </form>
      </div>
    </>
  );
}
