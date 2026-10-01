import { Fragment, useEffect, useState } from 'react';
import { money } from '../format.js';
import { OWNER_KEYS, OWNER_LABELS } from '../owners.jsx';

const CLASS_LABELS = {
  fixed: 'Fixed',
  variable_seasonal: 'Variable / seasonal',
  capex: 'Capital expenditure',
  overhead: 'Overhead',
};

const emptyForm = { kind: 'expense', name: '', parent_id: '', class: 'variable_seasonal', ledger: 'business', annual_total: '' };
const pctOf = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

export default function Expenses() {
  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [segmentTotals, setSegmentTotals] = useState(null);
  const [owner, setOwner] = useState('all');
  const [spend, setSpend] = useState(null);
  const [income, setIncome] = useState(null);
  const [payeeKind, setPayeeKind] = useState('expense');
  const [payeeTotals, setPayeeTotals] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const year = new Date().getFullYear();

  const loadCategories = () => { fetch('/api/expenses').then((r) => r.json()).then((d) => setCategories(Array.isArray(d) ? d : [])); };
  const loadSpend = () => {
    fetch(`/api/expenses/by-category?year=${year}&owner=${owner}`).then((r) => r.json()).then(setSpend);
    fetch(`/api/expenses/by-category?year=${year}&owner=${owner}&kind=income`).then((r) => r.json()).then(setIncome);
  };
  useEffect(loadCategories, []);
  useEffect(loadSpend, [owner]);
  useEffect(() => {
    fetch(`/api/payees/totals?year=${year}&owner=${owner}&kind=${payeeKind}`).then((r) => r.json()).then(setPayeeTotals);
  }, [owner, payeeKind]);
  useEffect(() => {
    fetch(`/api/expenses/segment-totals?year=${year}`).then((r) => r.json()).then((d) => setSegmentTotals(d.totals));
  }, []);

  const call = async (url, method, body) => {
    setError(null);
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error || `HTTP ${res.status}`); return null; }
    return data;
  };

  const submit = async (e) => {
    e.preventDefault();
    const body = { name: form.name, annual_total: Number(form.annual_total) || 0, kind: form.kind };
    if (form.parent_id) body.parent_id = Number(form.parent_id);
    else { body.class = form.class; body.ledger = form.ledger; }
    if (await call('/api/expenses', 'POST', body)) { setForm(emptyForm); loadCategories(); }
  };

  const addStandard = async () => {
    const r = await call('/api/expenses/standard-farm', 'POST');
    if (r) {
      setNotice(r.added.length ? `Added ${r.added.length} categories.` : 'All standard categories were already there.');
      loadCategories();
    }
  };

  const parents = categories.filter((c) => !c.parent_id);
  const formParents = parents.filter((c) => (c.kind || 'expense') === form.kind);
  const ownerToggle = (
    <div className="seg-toggle" role="group" aria-label="Owner">
      {['all', ...OWNER_KEYS].map((k) => (
        <button key={k} type="button" aria-pressed={owner === k} className={owner === k ? 'on' : ''} onClick={() => setOwner(k)}>
          {k === 'all' ? 'All' : OWNER_LABELS[k]}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Income &amp; Expenses</h1>
        <span className="page-meta">FY {year}</span>
      </div>

      {error && <div className="notice" style={{ borderColor: 'var(--negative)', color: 'var(--negative)' }}>{error}</div>}

      <div className="panel">
        <div className="panel-header">Actual spend by owner — {year}</div>
        {!segmentTotals ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <div className="grid" style={{ padding: '16px 20px 0' }}>
            {OWNER_KEYS.map((k) => (
              <div className="metric-card" key={k}>
                <div className="metric-label">{OWNER_LABELS[k]}</div>
                <div className="metric-value">{money(segmentTotals[k] || 0)}</div>
              </div>
            ))}
            {segmentTotals.unassigned > 0 && (
              <div className="metric-card">
                <div className="metric-label">Unassigned</div>
                <div className="metric-value">{money(segmentTotals.unassigned)}</div>
                <div className="metric-sub">Untagged or old "Personal" items — retag them</div>
              </div>
            )}
          </div>
        )}
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 0', padding: '0 20px 16px' }}>
          Actual money spent this year, not the budget figures below — a transaction split between owners
          counts proportionally toward each.
        </p>
      </div>

      <div className="panel">
        <div className="panel-header spend-header">
          <span>Spending by category — {year}</span>
          {ownerToggle}
        </div>
        {!spend ? (
          <div className="empty-state">Loading…</div>
        ) : spend.categories.length === 0 && !spend.uncategorized ? (
          <div className="empty-state">No spending recorded for {owner === 'all' ? 'anyone' : OWNER_LABELS[owner]} in {year} yet.</div>
        ) : (
          <SpendBars data={spend} />
        )}
      </div>

      <div className="panel">
        <div className="panel-header spend-header">
          <span>Income by category — {year}</span>
          {ownerToggle}
        </div>
        {!income ? (
          <div className="empty-state">Loading…</div>
        ) : income.categories.length === 0 && !income.uncategorized ? (
          <div className="empty-state">No income recorded for {owner === 'all' ? 'anyone' : OWNER_LABELS[owner]} in {year} yet.</div>
        ) : (
          <SpendBars data={income} income />
        )}
      </div>

      <div className="panel">
        <div className="panel-header spend-header">
          <span>{payeeKind === 'income' ? 'Who paid you' : 'Who you paid'} — {year}</span>
          <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
            <div className="seg-toggle" role="group" aria-label="Direction">
              {[['expense', 'Paid to'], ['income', 'Received from']].map(([k, l]) => (
                <button key={k} type="button" aria-pressed={payeeKind === k} className={payeeKind === k ? 'on' : ''} onClick={() => setPayeeKind(k)}>{l}</button>
              ))}
            </div>
            {ownerToggle}
          </span>
        </div>
        {!payeeTotals ? (
          <div className="empty-state">Loading…</div>
        ) : payeeTotals.payees.length === 0 ? (
          <div className="empty-state">Nothing yet.</div>
        ) : (
          <table>
            <thead><tr><th>{payeeKind === 'income' ? 'Buyer / payer' : 'Payee'}</th><th>Total</th><th>Share</th><th>Transactions</th></tr></thead>
            <tbody>
              {payeeTotals.payees.map((x) => (
                <tr key={x.payee_id || 'none'} style={x.payee_id ? undefined : { color: 'var(--text-faint)' }}>
                  <td>{x.payee_id ? <a className="small-link" style={{ color: 'var(--text)', fontSize: 'inherit' }} href={`/ledgers?payee=${x.payee_id}`}>{x.name}</a> : x.name}</td>
                  <td>{money(x.total)}</td>
                  <td>{pctOf(x.total, payeeTotals.total)}</td>
                  <td>{x.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>Categories</span>
          <button className="small secondary" onClick={addStandard}>Add standard farm categories</button>
        </div>
        {notice && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, padding: '10px 20px 0' }}>{notice}</p>}
        {categories.length === 0 ? (
          <div className="empty-state">No categories yet — start with the standard farm set above, then add your own.</div>
        ) : (
          <CategoryTable categories={categories} parents={parents} call={call} reload={loadCategories} />
        )}
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0, padding: '12px 20px 0' }}>
          Two levels: charts and totals use the top-level categories; subcategories hold the detail and roll up
          into their parent. Tag transactions with the most specific one. Names are unique, so a statement
          agent sending "Diesel — dyed" always lands in exactly one place.
        </p>
        <form className="form-panel" onSubmit={submit} style={{ maxWidth: 'none', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
          <div className="field"><label>Income or expense</label>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, parent_id: '' })}>
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select></div>
          <div className="field"><label>Name</label>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Diesel — dyed" /></div>
          <div className="field"><label>Under (optional)</label>
            <select value={form.parent_id} onChange={(e) => setForm({ ...form, parent_id: e.target.value })}>
              <option value="">— top level —</option>
              {formParents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></div>
          {!form.parent_id && (
            <>
              <div className="field"><label>Class</label>
                <select value={form.class} onChange={(e) => setForm({ ...form, class: e.target.value })}>
                  {Object.entries(CLASS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select></div>
              <div className="field"><label>Ledger</label>
                <select value={form.ledger} onChange={(e) => setForm({ ...form, ledger: e.target.value })}>
                  <option value="business">Business</option>
                  <option value="personal">Personal</option>
                </select></div>
            </>
          )}
          <div className="field"><label>Annual budget (optional)</label>
            <input type="number" step="0.01" value={form.annual_total} onChange={(e) => setForm({ ...form, annual_total: e.target.value })} /></div>
          <div className="field" style={{ alignSelf: 'end' }}><button type="submit">Add category</button></div>
        </form>
      </div>
    </>
  );
}

// Horizontal bars, one hue: parents sorted by spend, each opening to its
// subcategories. Bars share one scale (the largest parent), so a
// subcategory's bar is directly comparable to any parent's.
function SpendBars({ data, income = false }) {
  const [open, setOpen] = useState(() => new Set());
  const [tip, setTip] = useState(null);
  const max = Math.max(...data.categories.map((c) => c.total), data.uncategorized, 1);
  const toggle = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Tooltip sits just past the end of the hovered bar, in the empty track
  // space, so it never covers the category labels; it flips to the bar's
  // left when there's no room on the right.
  const show = (e, label, amount) => {
    const box = e.currentTarget.closest('.spend-chart').getBoundingClientRect();
    const bar = e.currentTarget.querySelector('.spend-bar').getBoundingClientRect();
    const tipW = 200;
    const right = bar.right - box.left + 10;
    const x = right + tipW <= box.width - 8 ? right : Math.max(8, bar.right - box.left - tipW - 10);
    setTip({ label, amount, x, y: bar.top - box.top + bar.height / 2 });
  };
  const width = (v) => `${Math.max(0, (v / max) * 100)}%`;

  const row = ({ key, label, amount, level, onClick, expanded, hasKids, muted }) => (
    <div
      key={key}
      className={`spend-row level-${level}${onClick ? ' clickable' : ''}`}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-expanded={hasKids ? expanded : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      onMouseEnter={(e) => show(e, label, amount)}
      onFocus={(e) => show(e, label, amount)}
      onMouseLeave={() => setTip(null)}
      onBlur={() => setTip(null)}
    >
      <span className="spend-label">
        {hasKids && <span className="spend-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>}
        {label}
      </span>
      <span className="spend-track"><span className={`spend-bar${muted ? ' muted' : ''}`} style={{ width: width(amount) }} /></span>
      <span className="spend-value">{money(amount)}</span>
    </div>
  );

  return (
    <div className="spend-chart">
      {data.categories.map((c) => {
        const hasKids = c.children.length > 0;
        const expanded = open.has(c.id);
        return (
          <Fragment key={c.id}>
            {row({ key: `p${c.id}`, label: c.name, amount: c.total, level: 0, hasKids, expanded, onClick: hasKids ? () => toggle(c.id) : undefined })}
            {hasKids && expanded && (
              <>
                {c.children.map((ch) => row({ key: `c${ch.id}`, label: ch.name, amount: ch.total, level: 1 }))}
                {Math.abs(c.direct) >= 0.005 && row({ key: `d${c.id}`, label: `${c.name} (not broken down)`, amount: c.direct, level: 1, muted: true })}
              </>
            )}
          </Fragment>
        );
      })}
      {Math.abs(data.uncategorized) >= 0.005 && row({ key: 'uncat', label: 'Uncategorized', amount: data.uncategorized, level: 0, muted: true })}
      {tip && (
        <div className="spend-tip" style={{ left: tip.x, top: tip.y }} role="status">
          <strong>{tip.label}</strong>
          <span>{money(tip.amount)} · {pctOf(tip.amount, data.total)} of {income ? 'income' : 'spending'}</span>
        </div>
      )}
      {income ? (
        <p className="spend-note">
          Total {money(data.total)}. Excludes transfers between accounts and loan advances.
          {Math.abs(data.uncategorized) >= 0.005 ? ' Uncategorized income is waiting on the Review tab.' : ''}
        </p>
      ) : (
        <p className="spend-note">
          Total {money(data.total)}. Excludes transfers between accounts, loan payments, and capital purchases
          {data.capex_total ? ` (${money(data.capex_total)} this year)` : ''}. Refunds net against their category.
        </p>
      )}
    </div>
  );
}

function CategoryTable({ categories, parents, call, reload }) {
  const [editing, setEditing] = useState(null); // { id, name, parent_id }
  const childrenOf = (id) => categories.filter((c) => c.parent_id === id);
  const save = async () => {
    const body = { name: editing.name, parent_id: editing.parent_id ? Number(editing.parent_id) : null };
    if (await call(`/api/expenses/${editing.id}`, 'PATCH', body)) { setEditing(null); reload(); }
  };
  const remove = async (c) => {
    if (!window.confirm(`Delete "${c.name}"?`)) return;
    if (await call(`/api/expenses/${c.id}`, 'DELETE')) reload();
  };
  const line = (c, sub) => (
    <tr key={c.id}>
      <td style={sub ? { paddingLeft: 40, color: 'var(--text-muted)' } : { fontWeight: 600 }}>
        {editing?.id === c.id ? (
          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
            <input aria-label="Name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <select aria-label="Parent" value={editing.parent_id} onChange={(e) => setEditing({ ...editing, parent_id: e.target.value })}>
              <option value="">— top level —</option>
              {parents.filter((p) => p.id !== c.id && (p.kind || 'expense') === (c.kind || 'expense')).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </span>
        ) : c.name}
      </td>
      <td>{CLASS_LABELS[c.class] || c.class}</td>
      <td>{c.ledger}</td>
      <td>{Number(c.annual_total) ? money(Number(c.annual_total)) : '—'}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {editing?.id === c.id ? (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <button className="small" onClick={save}>Save</button>
            <button className="small secondary" onClick={() => setEditing(null)}>Cancel</button>
          </span>
        ) : (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <button className="small secondary" onClick={() => setEditing({ id: c.id, name: c.name, parent_id: c.parent_id ? String(c.parent_id) : '' })}>Edit</button>
            <button className="small secondary" onClick={() => remove(c)}>Delete</button>
          </span>
        )}
      </td>
    </tr>
  );
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead><tr><th>Category</th><th>Class</th><th>Ledger</th><th>Budget</th><th></th></tr></thead>
        <tbody>
          {[['expense', 'Expense categories'], ['income', 'Income categories']].map(([k, title]) => {
            const group = parents.filter((p) => (p.kind || 'expense') === k);
            if (!group.length) return null;
            return (
              <Fragment key={k}>
                <tr><td colSpan={5} className="group-row">{title}</td></tr>
                {group.map((p) => (
                  <Fragment key={p.id}>
                    {line(p, false)}
                    {childrenOf(p.id).map((c) => line(c, true))}
                  </Fragment>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
