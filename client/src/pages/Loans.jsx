import { Fragment, useEffect, useState } from 'react';
import { money } from '../format.js';

const emptyForm = {
  name: '', lender: '', purpose: 'term', linked_asset: '', principal: '',
  interest_rate_pct: '', rate_type: 'fixed', term_months: '', start_date: '',
  covenant_notes: '', covenant_date: '', asset_value: '', asset_value_date: '',
  segment: 'grain',
};

const PURPOSE_LABELS = {
  operating: 'Operating', term: 'Term', capital_asset: 'Capital asset', mortgage: 'Mortgage',
};
const SEGMENT_LABELS = { grain: 'Grain', livestock: 'Livestock', personal: 'Personal' };

// For an existing loan (a mortgage you already have, say), "principal" and
// "term_months" are entered as the CURRENT outstanding balance and the
// remaining term — not the original loan terms — so the schedule generated
// from today forward matches reality. The math is identical either way;
// only the labels change to guide correct entry.
const usesCurrentState = (purpose) => purpose === 'mortgage';

export default function Loans() {
  const [loans, setLoans] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [planner, setPlanner] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [expandedId, setExpandedId] = useState(null);
  const [schedules, setSchedules] = useState({}); // loanId -> { loan, payments }
  const [estimateDate, setEstimateDate] = useState('');
  const [estimateResult, setEstimateResult] = useState(null);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [recordingId, setRecordingId] = useState(null);
  const [recordAccountId, setRecordAccountId] = useState('');
  const [recordByCheck, setRecordByCheck] = useState(false);

  const load = () => { fetch('/api/loans').then((r) => r.json()).then(setLoans); };
  const loadPlanner = () => {
    fetch('/api/loans/payments/upcoming?months=12')
      .then((r) => r.json())
      .then((d) => setPlanner(Array.isArray(d) ? d : []));
  };
  useEffect(() => {
    load();
    loadPlanner();
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
  }, []);

  const refreshAll = () => { load(); loadPlanner(); setSchedules({}); };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/loans', {
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
        asset_value: form.asset_value ? Number(form.asset_value) : null,
        asset_value_date: form.asset_value_date || null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not save loan (HTTP ${res.status}).`);
      return;
    }
    setForm(emptyForm);
    refreshAll();
  };

  const toggleExpand = async (loan) => {
    if (expandedId === loan.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(loan.id);
    setEstimateResult(null);
    setEstimateDate('');
    if (!schedules[loan.id]) {
      const data = await fetch(`/api/loans/${loan.id}/payments`).then((r) => r.json());
      setSchedules((s) => ({ ...s, [loan.id]: data }));
    }
  };

  const runEstimate = async (loanId) => {
    if (!estimateDate) return;
    const data = await fetch(`/api/loans/${loanId}/estimate?date=${estimateDate}`).then((r) => r.json());
    setEstimateResult(data);
  };

  const startEdit = (l) => {
    setEditingId(l.id);
    setEditForm({
      name: l.name || '', lender: l.lender, purpose: l.purpose,
      linked_asset: l.linked_asset || '', segment: l.segment || 'grain',
      principal: l.principal, interest_rate_pct: l.interest_rate_pct,
      rate_type: l.rate_type, term_months: l.term_months,
      start_date: l.start_date?.slice(0, 10) || '',
      asset_value: l.asset_value ?? '', asset_value_date: l.asset_value_date?.slice(0, 10) || '',
      covenant_date: l.covenant_date?.slice(0, 10) || '', covenant_notes: l.covenant_notes || '',
    });
    setError(null);
  };

  const saveEdit = async (id) => {
    setError(null);
    const res = await fetch(`/api/loans/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...editForm,
        principal: Number(editForm.principal),
        interest_rate_pct: Number(editForm.interest_rate_pct),
        term_months: Number(editForm.term_months),
        linked_asset: editForm.linked_asset || null,
        asset_value: editForm.asset_value !== '' ? Number(editForm.asset_value) : null,
        asset_value_date: editForm.asset_value_date || null,
        covenant_date: editForm.covenant_date || null,
        covenant_notes: editForm.covenant_notes || null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not save loan (HTTP ${res.status}).`);
      return;
    }
    setEditingId(null);
    setEditForm(null);
    refreshAll();
  };

  const deleteLoan = async (l) => {
    if (!window.confirm(`Delete "${l.name || l.lender}" and its payment schedule? Recorded ledger transactions are kept.`)) return;
    const res = await fetch(`/api/loans/${l.id}`, { method: 'DELETE' });
    if (!res.ok) {
      setError(`Could not delete loan (HTTP ${res.status}).`);
      return;
    }
    if (expandedId === l.id) setExpandedId(null);
    refreshAll();
  };

  const recordPayment = async (paymentId) => {
    setError(null);
    const res = await fetch(`/api/loans/payments/${paymentId}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: recordAccountId,
        paid_date: new Date().toISOString().slice(0, 10),
        paid_by_check: recordByCheck,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not record payment (HTTP ${res.status}).`);
      return;
    }
    setRecordingId(null);
    setRecordAccountId('');
    setRecordByCheck(false);
    refreshAll();
  };

  const plannerTotal = planner.reduce((s, p) => s + Number(p.principal_amount) + Number(p.interest_amount), 0);

  return (
    <>
      <div className="page-header"><h1 className="page-title">Loans</h1></div>

      {error && (
        <div className="panel" style={{ borderColor: 'var(--red, #c0392b)' }}>
          <div className="panel-header">Something went wrong</div>
          <p style={{ margin: '8px 0 0', color: 'var(--red, #c0392b)' }}>{error}</p>
        </div>
      )}

      <div className="panel">
        <div className="panel-header">
          Payment planner — next 12 months · {money(plannerTotal)} scheduled
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
          Every upcoming withdrawal, across all loans. These already count against the cash-flow
          forecast. Recording one moves the money for real: it writes the ledger entry, updates the
          account balance, and shows up in the enterprise expense totals — then drops off this plan.
        </p>
        {planner.length === 0 ? (
          <div className="empty-state">No scheduled payments coming up.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Due</th><th>Loan</th><th>Enterprise</th><th>Principal</th><th>Interest</th><th>Total</th><th></th></tr>
            </thead>
            <tbody>
              {planner.map((p) => {
                const overdue = new Date(p.due_date) < new Date();
                return (
                  <tr key={p.id}>
                    <td>
                      {p.due_date?.slice(0, 10)}
                      {overdue && <> <span className="badge fail">OVERDUE</span></>}
                    </td>
                    <td>{p.loan_name}</td>
                    <td>{SEGMENT_LABELS[p.segment] || '—'}</td>
                    <td>{money(Number(p.principal_amount))}</td>
                    <td>{money(Number(p.interest_amount))}</td>
                    <td>{money(Number(p.principal_amount) + Number(p.interest_amount))}</td>
                    <td>
                      {recordingId === p.id ? (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select value={recordAccountId} onChange={(e) => setRecordAccountId(e.target.value)}>
                            <option value="">Paid from…</option>
                            {accounts.map((a) => (
                              <option key={a.id} value={a.id}>{a.name} ({a.ledger})</option>
                            ))}
                          </select>
                          <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            <input type="checkbox" checked={recordByCheck} onChange={(e) => setRecordByCheck(e.target.checked)} />
                            By check
                          </label>
                          <button className="small" disabled={!recordAccountId} onClick={() => recordPayment(p.id)}>Confirm</button>
                          <button className="small secondary" onClick={() => { setRecordingId(null); setRecordAccountId(''); setRecordByCheck(false); }}>Cancel</button>
                        </span>
                      ) : (
                        <button className="small" onClick={() => { setRecordingId(p.id); setRecordAccountId(''); setRecordByCheck(false); }}>
                          Record payment
                        </button>
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
        <div className="panel-header">Add loan</div>
        <form className="form-panel" onSubmit={submit}>
          <div className="field">
            <label>Name (yours to pick — tells this loan apart from others, even at the same lender)</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Home mortgage, 2023 grain truck" />
          </div>
          <div className="field">
            <label>Lender</label>
            <input required value={form.lender} onChange={(e) => setForm({ ...form, lender: e.target.value })} />
          </div>
          <div className="field">
            <label>Category</label>
            <select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })}>
              {Object.entries(PURPOSE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Enterprise (where its payments count in expenses)</label>
            <select value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })}>
              {Object.entries(SEGMENT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {(form.purpose === 'capital_asset' || form.purpose === 'mortgage') && (
            <div className="field">
              <label>{form.purpose === 'mortgage' ? 'Property description' : 'Linked asset'}</label>
              <input value={form.linked_asset} onChange={(e) => setForm({ ...form, linked_asset: e.target.value })} placeholder={form.purpose === 'mortgage' ? 'e.g. Home quarter — SW 12-40-5' : ''} />
            </div>
          )}

          <div className="field">
            <label>{usesCurrentState(form.purpose) ? 'Outstanding balance today' : 'Principal'}</label>
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
            <label>{usesCurrentState(form.purpose) ? 'Term remaining (months)' : 'Term (months)'}</label>
            <input type="number" required value={form.term_months} onChange={(e) => setForm({ ...form, term_months: e.target.value })} />
          </div>
          <div className="field">
            <label>{usesCurrentState(form.purpose) ? 'As of / first payment date' : 'Start date'}</label>
            <input type="date" required value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
          </div>

          {(form.purpose === 'mortgage' || form.purpose === 'capital_asset') && (
            <>
              <div className="field">
                <label>Current value of the underlying asset (optional)</label>
                <input type="number" step="0.01" value={form.asset_value} onChange={(e) => setForm({ ...form, asset_value: e.target.value })} placeholder="e.g. property or equipment market value" />
              </div>
              {form.asset_value && (
                <div className="field">
                  <label>Valuation as of</label>
                  <input type="date" value={form.asset_value_date} onChange={(e) => setForm({ ...form, asset_value_date: e.target.value })} />
                </div>
              )}
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                Asset value is assumed constant going forward — equity changes here come only from paying down principal,
                not from modeling appreciation or depreciation.
              </p>
            </>
          )}

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
              <tr>
                <th>Name</th><th>Lender</th><th>Category</th><th>Outstanding</th><th>Rate</th><th>Term</th>
                <th>Asset value</th><th>Equity</th><th></th>
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => (
                <Fragment key={l.id}>
                  <tr>
                    <td title={l.linked_asset || undefined}>{l.name || l.lender}</td>
                    <td>{l.lender}</td>
                    <td>{PURPOSE_LABELS[l.purpose] || l.purpose}</td>
                    <td>{money(Number(l.outstanding_balance))}</td>
                    <td>{Number(l.interest_rate_pct).toFixed(2)}% ({l.rate_type})</td>
                    <td>{l.term_months} mo.</td>
                    <td>{l.asset_value != null ? money(Number(l.asset_value)) : '—'}</td>
                    <td style={l.equity != null && Number(l.equity) < 0 ? { color: 'var(--negative)' } : undefined}>
                      {l.equity != null ? money(Number(l.equity)) : '—'}
                    </td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                        <button className="small secondary" onClick={() => toggleExpand(l)}>
                          {expandedId === l.id ? 'Hide' : 'Details'}
                        </button>
                        <button className="small secondary" onClick={() => (editingId === l.id ? setEditingId(null) : startEdit(l))}>
                          {editingId === l.id ? 'Close' : 'Edit'}
                        </button>
                        <button className="small secondary" onClick={() => deleteLoan(l)}>Delete</button>
                      </span>
                    </td>
                  </tr>

                  {editingId === l.id && editForm && (
                    <tr>
                      <td colSpan={9} style={{ background: 'var(--panel-alt, rgba(255,255,255,0.03))' }}>
                        <div style={{ padding: '12px 4px' }}>
                          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>
                            Changing balance, rate, term, or start date regenerates this loan's payment
                            schedule from the new terms — the old schedule (including which rows were
                            marked paid) is replaced. Ledger transactions from payments already recorded
                            are kept either way.
                          </p>
                          <div className="form-panel" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
                            <div className="field"><label>Name</label>
                              <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
                            <div className="field"><label>Lender</label>
                              <input value={editForm.lender} onChange={(e) => setEditForm({ ...editForm, lender: e.target.value })} /></div>
                            <div className="field"><label>Category</label>
                              <select value={editForm.purpose} onChange={(e) => setEditForm({ ...editForm, purpose: e.target.value })}>
                                {Object.entries(PURPOSE_LABELS).map(([v, lab]) => <option key={v} value={v}>{lab}</option>)}
                              </select></div>
                            <div className="field"><label>Enterprise</label>
                              <select value={editForm.segment} onChange={(e) => setEditForm({ ...editForm, segment: e.target.value })}>
                                {Object.entries(SEGMENT_LABELS).map(([v, lab]) => <option key={v} value={v}>{lab}</option>)}
                              </select></div>
                            <div className="field"><label>Linked asset / property</label>
                              <input value={editForm.linked_asset} onChange={(e) => setEditForm({ ...editForm, linked_asset: e.target.value })} /></div>
                            <div className="field"><label>Outstanding balance / principal</label>
                              <input type="number" step="0.01" value={editForm.principal} onChange={(e) => setEditForm({ ...editForm, principal: e.target.value })} /></div>
                            <div className="field"><label>Interest rate (%)</label>
                              <input type="number" step="0.001" value={editForm.interest_rate_pct} onChange={(e) => setEditForm({ ...editForm, interest_rate_pct: e.target.value })} /></div>
                            <div className="field"><label>Rate type</label>
                              <select value={editForm.rate_type} onChange={(e) => setEditForm({ ...editForm, rate_type: e.target.value })}>
                                <option value="fixed">Fixed</option>
                                <option value="variable">Variable</option>
                              </select></div>
                            <div className="field"><label>Term (months)</label>
                              <input type="number" value={editForm.term_months} onChange={(e) => setEditForm({ ...editForm, term_months: e.target.value })} /></div>
                            <div className="field"><label>Start / as-of date</label>
                              <input type="date" value={editForm.start_date} onChange={(e) => setEditForm({ ...editForm, start_date: e.target.value })} /></div>
                            <div className="field"><label>Asset value</label>
                              <input type="number" step="0.01" value={editForm.asset_value} onChange={(e) => setEditForm({ ...editForm, asset_value: e.target.value })} /></div>
                            <div className="field"><label>Valuation as of</label>
                              <input type="date" value={editForm.asset_value_date} onChange={(e) => setEditForm({ ...editForm, asset_value_date: e.target.value })} /></div>
                            <div className="field"><label>Covenant / review date</label>
                              <input type="date" value={editForm.covenant_date} onChange={(e) => setEditForm({ ...editForm, covenant_date: e.target.value })} /></div>
                            <div className="field"><label>Covenant notes</label>
                              <input value={editForm.covenant_notes} onChange={(e) => setEditForm({ ...editForm, covenant_notes: e.target.value })} /></div>
                          </div>
                          <div style={{ marginTop: 8 }}>
                            <button className="small" onClick={() => saveEdit(l.id)}>Save changes</button>
                            {' '}
                            <button className="small secondary" onClick={() => { setEditingId(null); setEditForm(null); }}>Cancel</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}

                  {expandedId === l.id && (
                    <tr>
                      <td colSpan={9} style={{ background: 'var(--panel-alt, rgba(255,255,255,0.03))' }}>
                        {!schedules[l.id] ? (
                          <div className="empty-state">Loading schedule…</div>
                        ) : (
                          <div style={{ padding: '12px 4px' }}>
                            {(l.linked_asset || l.asset_value != null) && (
                              <p style={{ fontSize: 13, margin: '0 0 10px' }}>
                                <strong>Underlying asset:</strong> {l.linked_asset || 'Unnamed'}
                                {l.asset_value != null && (
                                  <> — valued at {money(Number(l.asset_value))}
                                    {l.asset_value_date ? ` (as of ${l.asset_value_date.slice(0, 10)})` : ''}
                                    {' '}· current equity {money(Number(l.equity))}</>
                                )}
                              </p>
                            )}
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
                              <label style={{ fontSize: 13 }}>Estimate payment / balance as of:</label>
                              <input type="date" value={estimateDate} onChange={(e) => setEstimateDate(e.target.value)} />
                              <button className="small" onClick={() => runEstimate(l.id)}>Estimate</button>
                            </div>
                            {estimateResult && !estimateResult.error && (
                              <div className="grid" style={{ marginBottom: 12 }}>
                                <div className="metric-card">
                                  <div className="metric-label">Nearest payment</div>
                                  <div className="metric-value">{estimateResult.payment.due_date?.slice(0, 10)}</div>
                                  <div style={{ fontSize: 12 }}>
                                    {money(Number(estimateResult.payment.principal_amount) + Number(estimateResult.payment.interest_amount))} total
                                    ({money(Number(estimateResult.payment.principal_amount))} principal / {money(Number(estimateResult.payment.interest_amount))} interest)
                                  </div>
                                </div>
                                <div className="metric-card">
                                  <div className="metric-label">Balance before / after</div>
                                  <div className="metric-value">{money(estimateResult.balanceBeforePayment)}</div>
                                  <div style={{ fontSize: 12 }}>→ {money(estimateResult.balanceAfterPayment)} after that payment</div>
                                </div>
                                {estimateResult.equityBeforePayment != null && (
                                  <div className="metric-card">
                                    <div className="metric-label">Equity before / after</div>
                                    <div className="metric-value">{money(estimateResult.equityBeforePayment)}</div>
                                    <div style={{ fontSize: 12 }}>→ {money(estimateResult.equityAfterPayment)} after that payment</div>
                                  </div>
                                )}
                              </div>
                            )}
                            <table>
                              <thead>
                                <tr>
                                  <th>Due</th><th>Payment</th><th>Principal</th><th>Interest</th>
                                  <th>Balance after</th>{l.asset_value != null && <th>Equity after</th>}<th>Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {schedules[l.id].payments.slice(0, 24).map((p) => (
                                  <tr key={p.id}>
                                    <td>{p.due_date?.slice(0, 10)}</td>
                                    <td>{money(Number(p.principal_amount) + Number(p.interest_amount))}</td>
                                    <td>{money(Number(p.principal_amount))}</td>
                                    <td>{money(Number(p.interest_amount))}</td>
                                    <td>{money(p.balance_after)}</td>
                                    {l.asset_value != null && <td>{money(p.equity_after)}</td>}
                                    <td>{p.paid ? <span className="badge pass">RECORDED</span> : <span className="badge warn">SCHEDULED</span>}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {schedules[l.id].payments.length > 24 && (
                              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0' }}>
                                Showing the first 24 of {schedules[l.id].payments.length} payments.
                              </p>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
