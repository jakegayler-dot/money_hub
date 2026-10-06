import { useEffect, useState } from 'react';
import MetricCard from '../components/MetricCard.jsx';
import { money } from '../format.js';
import { cents } from '../components/SplitEditor.jsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (key) => MONTHS[Number(key.slice(5, 7)) - 1];

/**
 * Household spending in two buckets. Essentials are forecast from what's
 * actually spent; discretionary gets a yearly limit worked out from the
 * farm's projected profit, tax and commitments — and Cash Flow spends
 * exactly that budget.
 */
export default function Personal() {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null); // { savings_pct, cap } while editing
  const [showAll, setShowAll] = useState(false);

  const load = () => fetch('/api/personal').then((r) => r.json()).then((d) => (d.error ? setError(d.error) : setPlan(d))).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const send = async (method, url, body) => {
    setError(null);
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setError(d.error || `HTTP ${r.status}`); return false; }
    setPlan(d);
    return true;
  };

  if (error && !plan) return <div className="empty-state">Could not load the personal plan: {error}</div>;
  if (!plan) return <div className="empty-state">Loading…</div>;

  const d = plan.discretionary;
  const thisMonth = plan.months.find((m) => m.discretionary_budget != null);
  const used = plan.categories.filter((c) => c.spent > 0.005);
  const shown = showAll ? plan.categories : used;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Personal</h1>
        <span className="page-meta">{plan.year} · household — Jake, Ashley and unassigned personal spending</span>
      </div>
      {error && <p className="review-error" style={{ margin: '0 0 12px' }}>{error}</p>}

      <div className="grid personal-cards">
        <MetricCard label="Discretionary this month" value={money(d.per_month)}
          sub={thisMonth ? `${money(thisMonth.discretionary)} spent so far in ${monthName(thisMonth.month)}` : 'Year finished'}
          tone={d.over ? 'negative' : undefined} />
        <MetricCard label="Discretionary left this year" value={money(d.remaining)} tone={d.over ? 'negative' : 'positive'}
          sub={`${money(d.spent)} of ${money(plan.limit)} spent · ${d.months_left} month${d.months_left === 1 ? '' : 's'} left`} />
        <MetricCard label="Essentials this year" value={money(plan.essentials.year)} sub={`Spent so far plus forecast — ${plan.essentials.basis}`} />
      </div>

      <div className="panel personal-plan">
        <div className="panel-header">How the discretionary limit is worked out</div>
        {!plan.tax_available && <p className="split-lines" style={{ margin: '8px 16px' }}>The farm's tax projection isn't available, so profit and tax count as $0.</p>}
        <table className="plan-steps">
          <tbody>
            {plan.steps.map((s) => (
              <tr key={s.key}>
                <td>
                  {s.label}
                  {s.key === 'savings' && (form ? (
                    <span className="plan-edit">
                      <input type="number" min="0" max="100" step="1" aria-label="Savings percentage" value={form.savings_pct}
                        onChange={(e) => setForm({ ...form, savings_pct: e.target.value })} />%
                    </span>
                  ) : null)}
                </td>
                <td className={`num ${s.amount < 0 ? 'out' : ''}`}>{s.amount < 0 ? '−' : s.key === 'profit' ? '' : '+'}{cents(Math.abs(s.amount))}</td>
              </tr>
            ))}
            {plan.capped && (
              <tr className="plan-sub"><td>Before your cap</td><td className="num">{cents(plan.before_cap)}</td></tr>
            )}
            <tr className="plan-total">
              <td>
                Discretionary limit for {plan.year}
                {plan.cap != null && <span className="split-lines"> · capped at {money(plan.cap)}</span>}
                {form && (
                  <span className="plan-edit">
                    cap <input type="number" min="0" step="100" aria-label="Discretionary cap" placeholder="none" value={form.cap}
                      onChange={(e) => setForm({ ...form, cap: e.target.value })} />
                  </span>
                )}
              </td>
              <td className="num">{cents(plan.limit)}</td>
            </tr>
          </tbody>
        </table>
        <div className="plan-actions">
          {form ? (
            <>
              <button type="button" className="small" onClick={() => send('PUT', '/api/personal/settings', { savings_pct: Number(form.savings_pct), cap: form.cap === '' ? null : Number(form.cap) }).then((ok) => ok && setForm(null))}>Save</button>
              <button type="button" className="small-link" onClick={() => setForm(null)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="small secondary" onClick={() => setForm({ savings_pct: plan.savings_pct, cap: plan.cap ?? '' })}>Change savings or cap</button>
          )}
          <span className="split-lines">What's left of the limit is spread over the months left; anything not spent carries into the next month. Cash Flow assumes the budget is spent.</span>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">Month by month</div>
        <table className="personal-months">
          <thead>
            <tr><th>Month</th><th className="num">Essentials</th><th className="num">Discretionary</th><th>Budget</th></tr>
          </thead>
          <tbody>
            {plan.months.map((m) => {
              const past = m.discretionary_budget == null;
              const budget = past ? null : m.discretionary_budget;
              const pctUsed = budget ? Math.min(100, (m.discretionary / budget) * 100) : 0;
              return (
                <tr key={m.month} className={past ? 'past' : ''}>
                  <td>{monthName(m.month)}</td>
                  <td className="num">
                    {m.essential > 0.005 ? cents(m.essential) : '—'}
                    {m.essential_estimate != null && <span className="split-lines"> / est. {money(m.essential_estimate)}</span>}
                  </td>
                  <td className="num">{m.discretionary > 0.005 ? cents(m.discretionary) : '—'}</td>
                  <td>
                    {budget != null ? (
                      <span className="budget-bar" title={`${cents(m.discretionary)} of ${cents(budget)}`}>
                        <span className={`budget-fill${m.discretionary > budget ? ' over' : ''}`} style={{ width: `${pctUsed}%` }} />
                        <span className="budget-label">{money(budget)}</span>
                      </span>
                    ) : <span className="split-lines">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-header personal-cats-head">
          <span>Which spending is which</span>
          <button type="button" className="small-link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Only categories you spent in' : 'All categories'}</button>
        </div>
        <p className="split-lines" style={{ margin: '8px 16px' }}>
          Only the household's share of each line counts here. Categories you haven't set follow their parent, or a best guess from the name.
          {plan.uncategorized > 0.005 && <> {cents(plan.uncategorized)} of personal spending this year has no category — it counts as essential.</>}
        </p>
        {shown.length === 0 ? <div className="empty-state">No personal spending recorded this year yet.</div> : (
          <table className="personal-cats">
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  <td>{c.full}{!c.set && <span className="split-lines"> · default</span>}</td>
                  <td className="num">{c.spent > 0.005 ? cents(c.spent) : ''}</td>
                  <td>
                    <span className="seg-toggle" role="group" aria-label={`Bucket for ${c.full}`}>
                      {[['essential', 'Essential'], ['discretionary', 'Discretionary']].map(([k, l]) => (
                        <button key={k} type="button" aria-pressed={c.bucket === k} className={c.bucket === k ? 'on' : ''}
                          onClick={() => c.bucket !== k && send('PUT', `/api/personal/categories/${c.id}`, { bucket: k })}>{l}</button>
                      ))}
                    </span>
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
