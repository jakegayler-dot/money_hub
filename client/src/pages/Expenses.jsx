import { useEffect, useState } from 'react';
import { money } from '../format.js';

const CLASS_LABELS = {
  fixed: 'Fixed',
  variable_seasonal: 'Variable / seasonal',
  capex: 'Capital expenditure',
  overhead: 'Overhead',
};

const emptyForm = { name: '', class: 'fixed', ledger: 'business', annual_total: '' };

export default function Expenses() {
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [segmentTotals, setSegmentTotals] = useState(null);
  const year = new Date().getFullYear();

  const load = () => { fetch('/api/expenses').then((r) => r.json()).then(setCategories); };
  useEffect(load, []);
  useEffect(() => {
    fetch(`/api/expenses/segment-totals?year=${year}`).then((r) => r.json()).then((d) => setSegmentTotals(d.totals));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    await fetch('/api/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, annual_total: Number(form.annual_total) }),
    });
    setForm(emptyForm);
    load();
  };

  const grouped = Object.keys(CLASS_LABELS).map((klass) => ({
    klass,
    items: categories.filter((c) => c.class === klass),
  }));

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Expenses</h1>
        <span className="page-meta">FY {year}</span>
      </div>

      <div className="panel">
        <div className="panel-header">Actual spend by enterprise — {year}</div>
        {!segmentTotals ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <div className="grid">
            <div className="metric-card">
              <div className="metric-label">Grain</div>
              <div className="metric-value">{money(segmentTotals.grain)}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Livestock</div>
              <div className="metric-value">{money(segmentTotals.livestock)}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Personal</div>
              <div className="metric-value">{money(segmentTotals.personal)}</div>
            </div>
            {segmentTotals.unassigned > 0 && (
              <div className="metric-card">
                <div className="metric-label">Unassigned</div>
                <div className="metric-value">{money(segmentTotals.unassigned)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Older bills/transactions with no enterprise tag</div>
              </div>
            )}
          </div>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 0' }}>
          Actual money spent this year (bills paid + manual ledger entries), not the budget figures below —
          a bill or transaction split across enterprises counts proportionally toward each.
        </p>
      </div>

      <div className="panel">
        <div className="panel-header">Add category</div>
        <form className="form-panel" onSubmit={submit}>
          <div className="field">
            <label>Name</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Class</label>
            <select value={form.class} onChange={(e) => setForm({ ...form, class: e.target.value })}>
              {Object.entries(CLASS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
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
            <label>Annual total</label>
            <input type="number" step="0.01" required value={form.annual_total} onChange={(e) => setForm({ ...form, annual_total: e.target.value })} />
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            Monthly distribution defaults to even 1/12ths — edit the category after creation to set a seasonal curve.
          </p>
          <button type="submit">Save category</button>
        </form>
      </div>

      {grouped.map(({ klass, items }) => (
        <div className="panel" key={klass}>
          <div className="panel-header">{CLASS_LABELS[klass]}</div>
          {items.length === 0 ? (
            <div className="empty-state">No categories yet.</div>
          ) : (
            <table>
              <thead><tr><th>Name</th><th>Ledger</th><th>Annual total</th></tr></thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.ledger}</td>
                    <td>{money(Number(c.annual_total))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </>
  );
}
