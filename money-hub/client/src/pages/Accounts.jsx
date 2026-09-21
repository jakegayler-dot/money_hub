import { useEffect, useState } from 'react';
import { money } from '../format.js';

const ACCOUNT_TYPE_LABELS = {
  operating: 'Operating', reserve: 'Reserve', credit: 'Credit card / line of credit',
  personal: 'Personal', investment: 'Investment', draw: 'Draw',
};

const FEE_FREQUENCY_LABELS = {
  none: 'No fee', monthly: 'Monthly', annual: 'Annual', per_transaction: 'Per transaction',
};

const emptyForm = {
  name: '', ledger: 'business', account_type: 'operating', opening_balance: '',
  fee_amount: '', fee_frequency: 'none', fee_notes: '',
};

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
      body: JSON.stringify({
        ...form,
        opening_balance: Number(form.opening_balance),
        fee_amount: form.fee_amount ? Number(form.fee_amount) : 0,
      }),
    });
    setForm(emptyForm);
    load();
  };

  const business = accounts.filter((a) => a.ledger === 'business');
  const personal = accounts.filter((a) => a.ledger === 'personal');
  const netTotal = accounts.reduce((s, a) => s + Number(a.opening_balance), 0);
  const totalAnnualFees = accounts.reduce((s, a) => {
    const amt = Number(a.fee_amount) || 0;
    if (a.fee_frequency === 'monthly') return s + amt * 12;
    if (a.fee_frequency === 'annual') return s + amt;
    return s;
  }, 0);

  const feeDisplay = (a) => {
    if (a.fee_frequency === 'none' || !Number(a.fee_amount)) return '—';
    return `${money(Number(a.fee_amount))} / ${a.fee_frequency === 'per_transaction' ? 'txn' : a.fee_frequency}`;
  };

  const renderGroup = (label, items) => (
    <div key={label}>
      <div className="panel-header">{label} — net {money(items.reduce((s, a) => s + Number(a.opening_balance), 0))}</div>
      {items.length === 0 ? (
        <div className="empty-state">No accounts yet.</div>
      ) : (
        <table>
          <thead><tr><th>Account</th><th>Type</th><th>Balance</th><th>Fee</th></tr></thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>{ACCOUNT_TYPE_LABELS[a.account_type] || a.account_type}</td>
                <td style={Number(a.opening_balance) < 0 ? { color: 'var(--negative)' } : undefined}>
                  {money(Number(a.opening_balance))}
                </td>
                <td title={a.fee_notes || ''}>{feeDisplay(a)}</td>
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
        <span className="page-meta">Net {money(netTotal)} · Fees {money(totalAnnualFees)}/yr</span>
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

          <div className="field">
            <label>Fee structure</label>
            <select value={form.fee_frequency} onChange={(e) => setForm({ ...form, fee_frequency: e.target.value })}>
              {Object.entries(FEE_FREQUENCY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {form.fee_frequency !== 'none' && (
            <>
              <div className="field">
                <label>Fee amount (per {form.fee_frequency === 'per_transaction' ? 'transaction' : form.fee_frequency === 'monthly' ? 'month' : 'year'})</label>
                <input type="number" step="0.01" value={form.fee_amount} onChange={(e) => setForm({ ...form, fee_amount: e.target.value })} placeholder="e.g. 14.95" />
              </div>
              <div className="field">
                <label>Fee notes (optional)</label>
                <input value={form.fee_notes} onChange={(e) => setForm({ ...form, fee_notes: e.target.value })} placeholder="e.g. waived if balance > $5,000" />
              </div>
            </>
          )}

          <button type="submit">Add account</button>
        </form>
      </div>
    </>
  );
}
