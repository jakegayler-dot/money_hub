import { Fragment, useEffect, useRef, useState } from 'react';
import { money, localToday } from '../format.js';
import { OWNER_LABELS, OwnerFields, ownerPayload, ownerFieldsFrom, ownerSummary, emptyOwnerFields } from '../owners.jsx';

const emptyForm = {
  name: '', lender: '', purpose: 'term', linked_asset: '', principal: '',
  interest_rate_pct: '', rate_type: 'fixed', term_months: '', start_date: '',
  covenant_notes: '', covenant_date: '', asset_id: '',
  ...emptyOwnerFields, payment_frequency: 'monthly', first_payment_date: '',
};

// Payment frequencies offered by typical ag lenders — annual and
// semi-annual are common, timed to harvest or calf-sale cash.
const FREQUENCY_LABELS = {
  monthly: 'Monthly', biweekly: 'Bi-weekly', quarterly: 'Quarterly', semiannual: 'Semi-annual', annual: 'Annual',
};

const STALE_DAYS = 90;
const today = () => localToday();
const emptyVerify = { verified_on: today(), balance: '', interest_rate_pct: '', payment_amount: '', source: 'statement', note: '', prior_paid_outside_app: false };

// Verification age: never verified is red, over 90 days amber, else green.
function VerifiedBadge({ loan }) {
  if (loan.days_since_verified == null) return <span className="badge fail">NOT VERIFIED</span>;
  const d = loan.days_since_verified;
  const label = d === 0 ? 'VERIFIED TODAY' : `VERIFIED ${d}D AGO`;
  return <span className={`badge ${d > STALE_DAYS ? 'warn' : 'pass'}`} title={`Last verified ${String(loan.last_verified_on).slice(0, 10)}`}>{label}</span>;
}

const PURPOSE_LABELS = {
  operating: 'Operating', term: 'Term', capital_asset: 'Capital asset', mortgage: 'Mortgage',
};
const SEGMENT_LABELS = OWNER_LABELS;

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
  const [assets, setAssets] = useState([]);
  const [verifyingId, setVerifyingId] = useState(null);
  const [verifyForm, setVerifyForm] = useState(emptyVerify);
  const [verifyResult, setVerifyResult] = useState(null);

  const [showAdd, setShowAdd] = useState(false);
  const [showPlanner, setShowPlanner] = useState(false);
  const [projection, setProjection] = useState(null);
  const load = () => {
    fetch('/api/loans').then((r) => r.json()).then(setLoans);
    fetch('/api/loans/projection').then((r) => r.json()).then((d) => setProjection(d && d.months ? d : null)).catch(() => {});
  };
  const loadPlanner = () => {
    fetch('/api/loans/payments/upcoming?months=12')
      .then((r) => r.json())
      .then((d) => setPlanner(Array.isArray(d) ? d : []));
  };
  useEffect(() => {
    load();
    loadPlanner();
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
    fetch('/api/assets').then((r) => r.json()).then((d) => setAssets(Array.isArray(d) ? d : []));
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
        ...ownerPayload(form),
        principal: Number(form.principal),
        interest_rate_pct: Number(form.interest_rate_pct),
        term_months: Number(form.term_months),
        linked_asset: form.linked_asset || null,
        covenant_notes: form.covenant_notes || null,
        covenant_date: form.covenant_date || null,
        asset_id: form.asset_id ? Number(form.asset_id) : null,
        first_payment_date: form.first_payment_date || null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not save loan (HTTP ${res.status}).`);
      return;
    }
    setForm(emptyForm);
    setShowAdd(false);
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
      linked_asset: l.linked_asset || '', ...ownerFieldsFrom(l),
      principal: l.principal, interest_rate_pct: l.interest_rate_pct,
      rate_type: l.rate_type, term_months: l.term_months,
      start_date: l.start_date?.slice(0, 10) || '',
      asset_id: l.asset_id ?? '',
      payment_frequency: l.payment_frequency || 'monthly',
      first_payment_date: l.first_payment_date ? String(l.first_payment_date).slice(0, 10) : '',
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
        ...ownerPayload(editForm),
        principal: Number(editForm.principal),
        interest_rate_pct: Number(editForm.interest_rate_pct),
        term_months: Number(editForm.term_months),
        linked_asset: editForm.linked_asset || null,
        asset_id: editForm.asset_id ? Number(editForm.asset_id) : null,
        first_payment_date: editForm.first_payment_date || null,
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
        paid_date: localToday(),
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

  const startVerify = (l) => {
    setVerifyingId(l.id);
    setVerifyResult(null);
    setVerifyForm({
      ...emptyVerify,
      verified_on: today(),
      interest_rate_pct: String(Number(l.interest_rate_pct)),
      payment_amount: l.verified_payment != null ? String(Number(l.verified_payment)) : '',
    });
    setError(null);
  };

  const submitVerify = async (l) => {
    setError(null);
    const res = await fetch(`/api/loans/${l.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...verifyForm,
        balance: Number(verifyForm.balance),
        interest_rate_pct: verifyForm.interest_rate_pct === '' ? null : Number(verifyForm.interest_rate_pct),
        payment_amount: verifyForm.payment_amount === '' ? null : Number(verifyForm.payment_amount),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body.error || `Could not verify (HTTP ${res.status}).`); return; }
    setVerifyResult({ loanId: l.id, ...body });
    refreshAll();
  };

  const staleLoans = loans.filter((l) => l.days_since_verified == null || l.days_since_verified > STALE_DAYS);
  const assetName = (id) => (assets.find((a) => a.id === Number(id)) || {}).name;

  const plannerTotal = planner.reduce((s, p) => s + Number(p.principal_amount) + Number(p.interest_amount), 0);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Loans</h1>
        <span style={{ display: 'inline-flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          {staleLoans.length > 0 && (
            <span className="page-meta" style={{ color: 'var(--gold-bright)' }}>
              {staleLoans.length} loan{staleLoans.length > 1 ? 's' : ''} not verified in {STALE_DAYS} days
            </span>
          )}
          <button type="button" className="small" onClick={() => setShowAdd(true)}>Add a loan</button>
        </span>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: 'var(--red, #c0392b)' }}>
          <div className="panel-header">Something went wrong</div>
          <p style={{ margin: '8px 0 0', color: 'var(--red, #c0392b)' }}>{error}</p>
        </div>
      )}

      <LoanMetrics loans={loans} planner={planner} projection={projection} staleCount={staleLoans.length} />
      {projection && projection.loans.length > 0 && <PaydownChart projection={projection} />}

      <div className="panel">
        <div className="panel-header">Loan book</div>
        {loans.length === 0 ? (
          <div className="empty-state">No loans on file.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Loan</th><th>Outstanding</th><th>Rate</th><th>Next payment</th>
                <th>Secured by</th><th>Equity</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => (
                <Fragment key={l.id}>
                  <tr className={`loan-row${expandedId === l.id ? ' open' : ''}`} onClick={() => toggleExpand(l)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') toggleExpand(l); }} aria-expanded={expandedId === l.id}>
                    <td>
                      <span className="loan-caret" aria-hidden="true">{expandedId === l.id ? '▾' : '▸'}</span>{' '}
                      {l.name || l.lender}
                      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{l.name && l.lender ? `${l.lender} · ` : ''}{PURPOSE_LABELS[l.purpose] || l.purpose} · {ownerSummary(l)}</div>
                    </td>
                    <td>
                      {money(Number(l.outstanding_balance))}
                      <div style={{ marginTop: 4 }}><VerifiedBadge loan={l} /></div>
                    </td>
                    <td>
                      {Number(l.interest_rate_pct).toFixed(2)}% <span style={{ color: 'var(--text-faint)' }}>{l.rate_type}</span>
                      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{FREQUENCY_LABELS[l.payment_frequency] || 'Monthly'} payments</div>
                    </td>
                    <td>
                      {l.next_payment ? <>{money(l.next_payment.amount)}<div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{l.next_payment.due_date}</div></> : '—'}
                      {l.overdue_unrecorded > 0 && <div style={{ fontSize: 11, color: 'var(--gold-bright)' }}>{l.overdue_unrecorded} past unrecorded</div>}
                    </td>
                    <td>
                      {l.asset_name ? <>{l.asset_name}<div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{money(l.asset_value_now)}</div></> : '—'}
                    </td>
                    <td style={l.equity != null && Number(l.equity) < 0 ? { color: 'var(--negative)' } : undefined}>
                      {l.equity != null ? money(Number(l.equity)) : '—'}
                      {l.asset_loan_count > 1 && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>after all {l.asset_loan_count} loans</div>}
                    </td>
                  </tr>

                  {verifyingId === l.id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--panel-alt)' }}>
                        <div style={{ padding: '12px 4px' }}>
                          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>
                            Enter what your statement or lender says. The schedule currently expects{' '}
                            <strong>{money(Number(l.outstanding_balance))}</strong> at {Number(l.interest_rate_pct)}%.
                            If yours differs, the gap is booked as an adjustment and every future payment is rebuilt
                            from your figures. Leave the payment blank to keep the payoff date; enter it to keep the
                            payment and let the payoff date move (usual for a variable-rate change).
                          </p>
                          <div className="form-panel" style={{ maxWidth: 'none', padding: 0, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                            <div className="field"><label>As of</label>
                              <input type="date" value={verifyForm.verified_on} onChange={(e) => setVerifyForm({ ...verifyForm, verified_on: e.target.value })} /></div>
                            <div className="field"><label>Balance owing</label>
                              <input type="number" step="0.01" required value={verifyForm.balance} onChange={(e) => setVerifyForm({ ...verifyForm, balance: e.target.value })} /></div>
                            <div className="field"><label>Rate (%)</label>
                              <input type="number" step="0.001" value={verifyForm.interest_rate_pct} onChange={(e) => setVerifyForm({ ...verifyForm, interest_rate_pct: e.target.value })} /></div>
                            <div className="field"><label>Payment per period (optional)</label>
                              <input type="number" step="0.01" value={verifyForm.payment_amount} onChange={(e) => setVerifyForm({ ...verifyForm, payment_amount: e.target.value })} placeholder="keep payoff date" /></div>
                            <div className="field"><label>Source</label>
                              <select value={verifyForm.source} onChange={(e) => setVerifyForm({ ...verifyForm, source: e.target.value })}>
                                <option value="statement">Statement</option><option value="lender">Lender (call/email)</option>
                                <option value="online banking">Online banking</option><option value="other">Other</option>
                              </select></div>
                            <div className="field"><label>Note</label>
                              <input value={verifyForm.note} onChange={(e) => setVerifyForm({ ...verifyForm, note: e.target.value })} placeholder="e.g. prime +0.5 reset" /></div>
                          </div>
                          {l.overdue_unrecorded > 0 && (
                            <label style={{ fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, color: 'var(--text-muted)' }}>
                              <input type="checkbox" checked={verifyForm.prior_paid_outside_app}
                                onChange={(e) => setVerifyForm({ ...verifyForm, prior_paid_outside_app: e.target.checked })} />
                              <span>
                                The {l.overdue_unrecorded} past payment{l.overdue_unrecorded > 1 ? 's' : ''} never recorded here were paid
                                outside the app (e.g. auto-debit) and my account balances already reflect them — close them without
                                moving any money, so the forecast stops counting them as overdue.
                              </span>
                            </label>
                          )}
                          <div style={{ marginTop: 10 }}>
                            <button className="small" disabled={verifyForm.balance === ''} onClick={() => submitVerify(l)}>Verify</button>
                          </div>
                          {verifyResult && verifyResult.loanId === l.id && (
                            <div className="notice" style={{ marginTop: 12, marginBottom: 0 }}>
                              {verifyResult.matched ? (
                                <>Matches the schedule — nothing to change. Verified {verifyResult.verification.verified_on?.slice(0, 10)}.</>
                              ) : (
                                <>
                                  Schedule expected {money(verifyResult.expected_balance)}; you verified {money(Number(verifyResult.verification.balance))}
                                  {verifyResult.balance_gap ? ` — ${money(Math.abs(verifyResult.balance_gap))} ${verifyResult.balance_gap > 0 ? 'less owing than expected' : 'more owing than expected'}` : ''}
                                  {verifyResult.rate_changed ? `, rate now ${Number(verifyResult.verification.interest_rate_pct)}%` : ''}.
                                  {verifyResult.rebased && <> Rebuilt: {verifyResult.remaining_payments} payments of about {money(verifyResult.new_payment)}, paid off {verifyResult.new_payoff_date}.</>}
                                </>
                              )}
                              {verifyResult.closed_as_paid_outside_app > 0 && <> Closed {verifyResult.closed_as_paid_outside_app} past payments as paid outside the app.</>}
                              {verifyResult.unrecorded_past_due?.length > 0 && (
                                <> {verifyResult.unrecorded_past_due.length} past payment{verifyResult.unrecorded_past_due.length > 1 ? 's are' : ' is'} still unrecorded and counted as overdue in the forecast — record {verifyResult.unrecorded_past_due.length > 1 ? 'them' : 'it'} in the planner, or verify again with the "paid outside the app" box.</>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}

                  {editingId === l.id && editForm && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--panel-alt, rgba(255,255,255,0.03))' }}>
                        <div style={{ padding: '12px 4px' }}>
                          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>
                            Changing balance, rate, term, start date, frequency or first payment date regenerates this loan's payment
                            schedule from scratch — the old schedule (including which rows were marked paid
                            and any verification adjustments) is replaced. To bring a loan in line with a
                            statement, use Verify instead: it keeps the history and rebases from that date.
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
                            <OwnerFields state={editForm} setState={setEditForm} label="Owner — what the money is used for" />
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
                            <div className="field"><label>Payment frequency</label>
                              <select value={editForm.payment_frequency} onChange={(e) => setEditForm({ ...editForm, payment_frequency: e.target.value })}>
                                {Object.entries(FREQUENCY_LABELS).map(([v, lab]) => <option key={v} value={v}>{lab}</option>)}
                              </select></div>
                            <div className="field"><label>First payment date</label>
                              <input type="date" value={editForm.first_payment_date} onChange={(e) => setEditForm({ ...editForm, first_payment_date: e.target.value })} /></div>
                            <div className="field"><label>Secured by asset</label>
                              <select value={editForm.asset_id} onChange={(e) => setEditForm({ ...editForm, asset_id: e.target.value })}>
                                <option value="">— none —</option>
                                {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                              </select></div>
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
                      <td colSpan={6} style={{ background: 'var(--panel-alt, rgba(255,255,255,0.03))' }}>
                        {!schedules[l.id] ? (
                          <div className="empty-state">Loading schedule…</div>
                        ) : (
                          <div style={{ padding: '12px 4px' }}>
                            <div className="loan-actions">
                              <button className="small" onClick={() => (verifyingId === l.id ? setVerifyingId(null) : startVerify(l))}>
                                {verifyingId === l.id ? 'Close verify' : 'Verify against a statement'}
                              </button>
                              <button className="small secondary" onClick={() => (editingId === l.id ? setEditingId(null) : startEdit(l))}>
                                {editingId === l.id ? 'Close edit' : 'Edit loan'}
                              </button>
                              <button className="small secondary" onClick={() => deleteLoan(l)}>Delete</button>
                            </div>
                            {schedules[l.id].asset && (
                              <p style={{ fontSize: 13, margin: '0 0 10px' }}>
                                <strong>Secured by:</strong> {schedules[l.id].asset.name} — worth {money(schedules[l.id].asset.value_now)} today
                                {Number(schedules[l.id].asset.annual_change_pct) ? ` (${Number(schedules[l.id].asset.annual_change_pct) > 0 ? '+' : ''}${Number(schedules[l.id].asset.annual_change_pct)}%/yr)` : ''}
                                {' '}· equity {money(schedules[l.id].asset.equity_now)}
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
                                  <th>Balance after</th>{schedules[l.id].asset && <th>Equity after</th>}<th>Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {schedules[l.id].payments.filter((p) => !p.paid || p.is_adjustment || p.due_date >= today().slice(0, 7)).slice(0, 24).map((p) => (
                                  <tr key={p.id} style={p.is_adjustment ? { background: 'var(--gold-soft)' } : undefined}>
                                    <td>{p.due_date?.slice(0, 10)}</td>
                                    <td>{money(Number(p.principal_amount) + Number(p.interest_amount))}</td>
                                    <td>{money(Number(p.principal_amount))}</td>
                                    <td>{money(Number(p.interest_amount))}</td>
                                    <td>{money(p.balance_after)}</td>
                                    {schedules[l.id].asset && <td>{money(p.equity_after)}</td>}
                                    <td>
                                      {p.is_adjustment ? <span className="badge warn" title="Balance correction from a verification — no money moved">ADJUSTMENT</span>
                                        : p.paid ? <span className="badge pass">{p.linked_transaction_id ? 'RECORDED' : 'PAID OUTSIDE'}</span>
                                        : p.due_date < today() ? <span className="badge fail">OVERDUE</span>
                                        : <span className="badge">SCHEDULED</span>}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0' }}>
                              Showing unsettled rows, adjustments and this month onward — up to 24 of {schedules[l.id].payments.length}.
                            </p>
                            {schedules[l.id].verifications?.length > 0 && (
                              <>
                                <div className="metric-label" style={{ margin: '16px 0 6px' }}>Verification history</div>
                                <table>
                                  <thead><tr><th>Date</th><th>Source</th><th>Verified balance</th><th>Schedule expected</th><th>Rate</th><th>Payment</th><th>Result</th><th>Note</th></tr></thead>
                                  <tbody>
                                    {schedules[l.id].verifications.map((v) => {
                                      const gap = Number(v.expected_balance) - Number(v.balance);
                                      return (
                                        <tr key={v.id}>
                                          <td>{String(v.verified_on).slice(0, 10)}</td>
                                          <td>{v.source || '—'}</td>
                                          <td>{money(Number(v.balance))}</td>
                                          <td>{money(Number(v.expected_balance))}{Math.abs(gap) >= 0.01 && <span style={{ color: 'var(--text-faint)' }}> ({gap > 0 ? '−' : '+'}{money(Math.abs(gap))})</span>}</td>
                                          <td>{Number(v.interest_rate_pct)}%{Number(v.interest_rate_pct) !== Number(v.expected_rate_pct) && <span style={{ color: 'var(--text-faint)' }}> (was {Number(v.expected_rate_pct)}%)</span>}</td>
                                          <td>{v.payment_amount != null ? money(Number(v.payment_amount)) : '—'}</td>
                                          <td>{v.rebased ? <span className="badge warn">REBASED</span> : <span className="badge pass">MATCHED</span>}</td>
                                          <td>{v.note || ''}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </>
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
      <div className="panel">
        <button type="button" className="panel-header loans-planner-toggle" aria-expanded={showPlanner} onClick={() => setShowPlanner(!showPlanner)}>
          <span>{showPlanner ? '▾' : '▸'} Upcoming payments — next 12 months · {planner.length} payment{planner.length === 1 ? '' : 's'} · {money(plannerTotal)}</span>
          <span className="split-lines">{showPlanner ? 'Hide' : 'Show and record payments'}</span>
        </button>
        {showPlanner && (<>
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
              <tr><th>Due</th><th>Loan</th><th>Owner</th><th>Principal</th><th>Interest</th><th>Total</th><th></th></tr>
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
        </>)}
      </div>

      {showAdd && (
      <div className="loan-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAdd(false); }}>
      <div className="panel loan-modal" role="dialog" aria-modal="true" aria-label="Add a loan">
        <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Add a loan</span>
          <button type="button" className="wi-close" aria-label="Close" onClick={() => setShowAdd(false)}>×</button>
        </div>
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
          <OwnerFields state={form} setState={setForm} label="Owner — what the borrowed money is used for" />
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
            <label>{usesCurrentState(form.purpose) ? 'Amortization remaining (months)' : 'Amortization (months — 20 yr = 240)'}</label>
            <input type="number" required value={form.term_months} onChange={(e) => setForm({ ...form, term_months: e.target.value })} />
          </div>
          <div className="field">
            <label>{usesCurrentState(form.purpose) ? 'As of date' : 'Start (advance) date'}</label>
            <input type="date" required value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
          </div>
          <div className="field">
            <label>Payment frequency</label>
            <select value={form.payment_frequency} onChange={(e) => setForm({ ...form, payment_frequency: e.target.value })}>
              {Object.entries(FREQUENCY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label>First payment date (optional)</label>
            <input type="date" value={form.first_payment_date} onChange={(e) => setForm({ ...form, first_payment_date: e.target.value })} />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Set this when the first payment isn't one period after the start — e.g. an annual loan advanced in
              March with its first payment Dec 1. That first payment then carries interest for the actual months
              elapsed, and every later payment falls on the same calendar day.
            </p>
          </div>

          <div className="field">
            <label>Secured by asset (optional)</label>
            <select value={form.asset_id} onChange={(e) => setForm({ ...form, asset_id: e.target.value })}>
              <option value="">— none —</option>
              {assets.map((a) => <option key={a.id} value={a.id}>{a.name} ({money(a.value_now)})</option>)}
            </select>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Asset values, appreciation and depreciation live on the Assets tab — add the asset there first.
            </p>
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
      </div>
      )}
    </>
  );
}

const farmShare = (l) => (l.is_segment_split
  ? ((Number(l.segment_grain_pct) || 0) + (Number(l.segment_livestock_pct) || 0)) / 100
  : ['jake', 'ashley', 'personal'].includes(l.segment) ? 0 : 1);
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (d) => (d ? `${MONTH_SHORT[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : '—');

/** The loan book in five numbers. */
function LoanMetrics({ loans, planner, projection, staleCount }) {
  const total = loans.reduce((s, l) => s + Number(l.outstanding_balance || 0), 0);
  const rate = total ? loans.reduce((s, l) => s + Number(l.outstanding_balance || 0) * Number(l.interest_rate_pct || 0), 0) / total : 0;
  const farm = loans.reduce((s, l) => s + Number(l.outstanding_balance || 0) * farmShare(l), 0);
  const principal = planner.reduce((s, p) => s + Number(p.principal_amount), 0);
  const interest = planner.reduce((s, p) => s + Number(p.interest_amount), 0);
  const overdue = loans.reduce((s, l) => s + (l.overdue_unrecorded || 0), 0);
  const freeDate = projection ? projection.months[projection.months.length - 1] : null;
  return (
    <div className="grid loan-metrics">
      <div className="metric-card">
        <div className="metric-label">Owed on all loans</div>
        <div className="metric-value">{money(total)}</div>
        <div className="metric-sub">{loans.length} loan{loans.length === 1 ? '' : 's'} · farm {money(farm)} · personal {money(total - farm)}</div>
      </div>
      <div className="metric-card">
        <div className="metric-label">Next 12 months</div>
        <div className="metric-value">{money(principal + interest)}</div>
        <div className="metric-sub">{money(principal)} principal · {money(interest)} interest</div>
      </div>
      <div className="metric-card">
        <div className="metric-label">Average rate</div>
        <div className="metric-value">{rate.toFixed(2)}%</div>
        <div className="metric-sub">Weighted by what's owed</div>
      </div>
      <div className="metric-card">
        <div className="metric-label">Debt-free</div>
        <div className="metric-value">{monthYear(freeDate)}</div>
        <div className="metric-sub">On the current schedules</div>
      </div>
      <div className="metric-card">
        <div className="metric-label">Needs attention</div>
        <div className={`metric-value${overdue || staleCount ? ' negative' : ''}`}>{overdue + staleCount || 'None'}</div>
        <div className="metric-sub">{overdue} past payment{overdue === 1 ? '' : 's'} unrecorded · {staleCount} not verified in {STALE_DAYS} days</div>
      </div>
    </div>
  );
}

const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];

/** Principal still owed by month, stacked by loan, until the last one is paid off. */
function PaydownChart({ projection }) {
  const boxRef = useRef(null);
  const [W, setW] = useState(900);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    if (!boxRef.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, []);
  const { months } = projection;
  // Biggest loans get their own colour; the rest fold into "Other".
  const sorted = [...projection.loans].sort((a, b) => b.balances[0] - a.balances[0]);
  const series = sorted.slice(0, SERIES.length).map((l, i) => ({ ...l, color: SERIES[i] }));
  if (sorted.length > SERIES.length) {
    const rest = sorted.slice(SERIES.length);
    series.push({ id: 'other', name: `Other (${rest.length})`, color: '#6b7280', balances: months.map((_, i) => rest.reduce((s, l) => s + l.balances[i], 0)) });
  }
  const n = months.length;
  const H = W < 560 ? 220 : 280;
  const pad = { t: 14, r: 14, b: 26, l: W < 560 ? 48 : 64 };
  const iw = W - pad.l - pad.r; const ih = H - pad.t - pad.b;
  const totals = months.map((_, i) => series.reduce((s, x) => s + x.balances[i], 0));
  const max = Math.max(1, ...totals);
  const rough = max / 4; const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= rough);
  const top = Math.ceil(max / step) * step;
  const x = (i) => pad.l + (n > 1 ? (i / (n - 1)) * iw : 0);
  const y = (v) => pad.t + (1 - v / top) * ih;
  const kf = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1000)}k`);
  // Stack: each loan's band sits on the ones before it.
  let base = months.map(() => 0);
  const bands = series.map((s) => {
    const lo = base; const hi = base.map((b, i) => b + s.balances[i]); base = hi;
    const d = `${hi.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} ${lo.map((v, i) => [i, v]).reverse().map(([i, v]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} Z`;
    return { ...s, d };
  });
  const years = [];
  months.forEach((d, i) => { if (i > 0 && d.slice(5, 7) === '12') years.push({ i, label: String(Number(d.slice(0, 4)) + 1) }); });
  const every = Math.max(1, Math.ceil(years.length / (W < 560 ? 5 : 10)));
  const grid = []; for (let v = 0; v <= top + 1; v += step) grid.push(v);
  const svgRef = useRef(null);
  const move = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / iw) * (n - 1)))));
  };
  const at = hover;
  return (
    <div className="panel">
      <div className="panel-header">Principal paydown</div>
      <div className="loan-chart" ref={boxRef}>
        <div className="loan-legend">
          {series.map((s) => <span key={s.id}><i style={{ background: s.color }} />{s.name}</span>)}
        </div>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="loan-svg" role="img"
          aria-label={`Principal owed, ${kf(totals[0])} today, paid off by ${monthYear(months[n - 1])}.`}
          onPointerMove={move} onPointerLeave={() => setHover(null)}>
          {grid.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} stroke="var(--border)" />
              <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="cft-axis">{kf(v)}</text>
            </g>
          ))}
          {bands.map((b) => <path key={b.id} d={b.d} fill={b.color} fillOpacity="0.75" stroke="var(--panel)" strokeWidth="1" />)}
          {years.filter((_, k) => k % every === 0).map((yv) => (
            <text key={yv.i} x={x(yv.i)} y={H - 6} textAnchor="middle" className="cft-axis">{yv.label}</text>
          ))}
          {at != null && <line x1={x(at)} x2={x(at)} y1={pad.t} y2={pad.t + ih} stroke="var(--text-faint)" strokeDasharray="3 3" />}
        </svg>
        <div className="loan-readout" aria-live="polite">
          {at != null ? (
            <>
              <strong>{monthYear(months[at])}</strong>
              <span>Total <b>{money(totals[at])}</b></span>
              {series.filter((s) => s.balances[at] > 0.5).map((s) => <span key={s.id}><i style={{ background: s.color }} />{s.name} <b>{money(s.balances[at])}</b></span>)}
            </>
          ) : <span className="split-lines">Point at the chart to see what's owed on each loan.</span>}
        </div>
      </div>
    </div>
  );
}
