import { useEffect, useState } from 'react';
import { money } from '../format.js';

const emptyForm = {
  lender: '', purpose: 'term', linked_asset: '', principal: '',
  interest_rate_pct: '', rate_type: 'fixed', term_months: '', start_date: '',
  covenant_notes: '', covenant_date: '',
};

export default function Loans() {
  const [loans, setLoans] = useState([]);
  const [form, setForm] = useState(emptyForm);

  const load = () => fetch('/api/loans').then((r) => r.json()).then(setLoans);
  useEffect(load, []);

  const submit = async (e) => {
    e.preventDefault();
    await fetch('/api/loans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        principal: Number(form.principal),
        interest_rate_pct: Number(form.interest_rate_pct),
        term_months: Number(form.term_months),
        linked_asset: form.linked_asset || null,
        covenant_notes: form.covenant_notes || null,
        covenant_date: form.covenant_date || null,
      }),
    });
    setForm(emptyForm);
    load();
  };

  return (
    <>
      <div className="page-header"><h1 className="page-title">Loans</h1></div>

      <div className="panel">
        <div className="panel-header">Add loan</div>
        <form className="form-panel" onSubmit={submit}>
          <div className="field">
            <label>Lender</label>
            <input required value={form.lender} onChange={(e) => setForm({ ...form, lender: e.target.value })} />
          </div>
          <div className="field">
            <label>Purpose</label>
            <select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })}>
              <option value="operating">Operating</option>
              <option value="term">Term</option>
              <option value="capital_asset">Capital asset</option>
            </select>
          </div>
          {form.purpose === 'capital_asset' && (
            <div className="field">
              <label>Linked asset</label>
              <input value={form.linked_asset} onChange={(e) => setForm({ ...form, linked_asset: e.target.value })} />
            </div>
          )}
          <div className="field">
            <label>Principal</label>
            <input type="number" step="0.01" required value={form.principal} onChange={(e) => setForm({ ...form, principal: e.target.value })} />
          </div>
          <div className="field">
            <label>Interest rate (%)</label>
            <input type="number" step="0.001" required value={form.interest_rate_pct} onChange={(e) => setForm({ ...form, interest_rate_pct: e.target.value })} />
          </div>
          <div className="field">
            <label>Rate type</label>
            <select value={form.rate_type} onChange={(e) => setForm({ ...form, rate_type: e.target.value })}>
              <option value="fixed">Fixed</option>
              <option value="variable">Variable</option>
            </select>
          </div>
          <div className="field">
            <label>Term (months)</label>
            <input type="number" required value={form.term_months} onChange={(e) => setForm({ ...form, term_months: e.target.value })} />
          </div>
          <div className="field">
            <label>Start date</label>
            <input type="date" required value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
          </div>
          <div className="field">
            <label>Covenant / review date</label>
            <input type="date" value={form.covenant_date} onChange={(e) => setForm({ ...form, covenant_date: e.target.value })} />
          </div>
          <div className="field">
            <label>Covenant notes</label>
            <input value={form.covenant_notes} onChange={(e) => setForm({ ...form, covenant_notes: e.target.value })} />
          </div>
          <button type="submit">Save loan &amp; generate schedule</button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-header">Loan book</div>
        {loans.length === 0 ? (
          <div className="empty-state">No loans on file.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Lender</th><th>Purpose</th><th>Principal</th><th>Rate</th><th>Term</th><th>Start</th></tr>
            </thead>
            <tbody>
              {loans.map((l) => (
                <tr key={l.id}>
                  <td>{l.lender}</td>
                  <td>{l.purpose}</td>
                  <td>{money(Number(l.principal))}</td>
                  <td>{Number(l.interest_rate_pct).toFixed(2)}% ({l.rate_type})</td>
                  <td>{l.term_months} mo.</td>
                  <td>{l.start_date?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
