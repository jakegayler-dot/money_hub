import { useEffect, useState } from 'react';
import { money, ratio } from '../format.js';

const emptyForm = {
  name: '', price: '', purchase_class: 'productive_tool',
  is_mixed_use: false, mixed_use_business_pct: '',
  unit_value: '', reversibility_score: '3', added_monthly_debt_service: '0', notes: '',
};

export default function PurchaseEvaluator() {
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [result, setResult] = useState(null);

  const load = () => { fetch('/api/purchase-evaluations').then((r) => r.json()).then(setHistory); };
  useEffect(load, []);

  const submit = async (e) => {
    e.preventDefault();
    const res = await fetch('/api/purchase-evaluations/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        price: Number(form.price),
        unit_value: form.unit_value ? Number(form.unit_value) : null,
        mixed_use_business_pct: form.is_mixed_use ? Number(form.mixed_use_business_pct) : null,
        reversibility_score: Number(form.reversibility_score),
        added_monthly_debt_service: Number(form.added_monthly_debt_service),
      }),
    });
    const json = await res.json();
    setResult(json);
    load();
  };

  return (
    <>
      <div className="page-header"><h1 className="page-title">Purchase Evaluator</h1></div>

      <div className="panel">
        <div className="panel-header">
          Five-gate test: liquidity floor · DSCR · opportunity cost · reversibility
        </div>
        <form className="form-panel" onSubmit={submit}>
          <div className="field">
            <label>Item</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Price</label>
            <input type="number" step="0.01" required value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </div>
          <div className="field">
            <label>Classification</label>
            <select value={form.purchase_class} onChange={(e) => setForm({ ...form, purchase_class: e.target.value })}>
              <option value="compounding">Compounding</option>
              <option value="productive_tool">Productive tool</option>
              <option value="consumptive">Consumptive</option>
            </select>
          </div>
          <div className="field">
            <label>
              <input type="checkbox" checked={form.is_mixed_use} onChange={(e) => setForm({ ...form, is_mixed_use: e.target.checked })} />
              {' '}Mixed-use (cost-basis split)
            </label>
          </div>
          {form.is_mixed_use && (
            <div className="field">
              <label>Business % of cost</label>
              <input type="number" min="0" max="100" value={form.mixed_use_business_pct} onChange={(e) => setForm({ ...form, mixed_use_business_pct: e.target.value })} />
            </div>
          )}
          <div className="field">
            <label>Core-asset unit value (annual return per unit — optional)</label>
            <input type="number" step="0.01" value={form.unit_value} onChange={(e) => setForm({ ...form, unit_value: e.target.value })} />
          </div>
          <div className="field">
            <label>Added monthly debt service if financed</label>
            <input type="number" step="0.01" value={form.added_monthly_debt_service} onChange={(e) => setForm({ ...form, added_monthly_debt_service: e.target.value })} />
          </div>
          <div className="field">
            <label>Reversibility (1 = illiquid, 5 = highly liquid)</label>
            <input type="number" min="1" max="5" value={form.reversibility_score} onChange={(e) => setForm({ ...form, reversibility_score: e.target.value })} />
          </div>
          <div className="field">
            <label>Notes</label>
            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <button type="submit">Run evaluation</button>
        </form>
      </div>

      {result && (
        <div className="panel">
          <div className="panel-header">Result — {result.result.name}</div>
          <div className="grid">
            <div className="metric-card">
              <div className="metric-label">Decision</div>
              <span className={`badge ${result.result.decision === 'pass' ? 'pass' : 'fail'}`}>
                {result.result.decision.toUpperCase()}
              </span>
            </div>
            <div className="metric-card">
              <div className="metric-label">Liquidity gate</div>
              <span className={`badge ${result.result.liquidity_pass ? 'pass' : 'fail'}`}>
                {result.result.liquidity_pass ? 'CLEARS' : 'FAILS'}
              </span>
            </div>
            <div className="metric-card">
              <div className="metric-label">DSCR gate</div>
              <span className={`badge ${result.result.dscr_pass ? 'pass' : 'fail'}`}>
                {result.result.dscr_pass ? 'CLEARS' : 'FAILS'}
              </span>
            </div>
            <div className="metric-card">
              <div className="metric-label">Opportunity cost</div>
              <div className="metric-value">
                {result.result.opportunity_cost_units
                  ? `${Number(result.result.opportunity_cost_units).toFixed(1)} units`
                  : '—'}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-header">Evaluation history</div>
        {history.length === 0 ? (
          <div className="empty-state">No evaluations run yet.</div>
        ) : (
          <table>
            <thead><tr><th>Item</th><th>Price</th><th>Class</th><th>Decision</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{h.name}</td>
                  <td>{money(Number(h.price))}</td>
                  <td>{h.purchase_class}</td>
                  <td><span className={`badge ${h.decision === 'pass' ? 'pass' : 'fail'}`}>{h.decision}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
