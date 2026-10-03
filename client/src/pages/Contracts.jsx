import { Fragment, useEffect, useRef, useState } from 'react';
import { uploadBody } from './Receipts.jsx';
import { money, unitPrice } from '../format.js';
import { OWNER_LABELS } from '../owners.jsx';
import { cents } from '../components/SplitEditor.jsx';

const emptyForm = {
  commodity: '', quantity: '', unit: 'tonnes', price_per_unit: '', total_value: '',
  counterparty: '', delivery_date: '', contract_period_end: '', expected_payment_date: '',
  segment: 'grain', notes: '',
};

const SEGMENT_LABELS = OWNER_LABELS;
const STATUS_BADGE = {
  open: <span className="badge warn">OPEN</span>,
  delivered: <span className="badge warn">DELIVERED</span>,
  partial: <span className="badge warn">PARTLY PAID</span>,
  settled: <span className="badge pass">SETTLED</span>,
  cancelled: <span className="badge fail">CANCELLED</span>,
};
const statusOf = (c) => ((c.status === 'open' || c.status === 'delivered') && Number(c.received_amount) > 0 ? 'partial' : c.status);
const isOpen = (c) => c.status === 'open' || c.status === 'delivered';

export default function Contracts() {
  const [contracts, setContracts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState(null);
  // File the contract itself (or an amendment) with the contract.
  const docRef = useRef(null);
  const [docFor, setDocFor] = useState(null);
  const addDocument = async (file) => {
    const id = docFor;
    setDocFor(null);
    if (!file || !id) return;
    setError(null);
    try {
      const { body, type } = await uploadBody(file);
      const r = await fetch(`/api/receipts/upload?contract_id=${id}`, { method: 'POST', headers: { 'Content-Type': type }, body });
      if (!r.ok) { const b = await r.json().catch(() => ({})); setError(b.error || `Couldn't add it (HTTP ${r.status}).`); }
    } catch {
      setError(`Couldn't open ${file.name} — photos and PDFs only.`);
    }
    if (docRef.current) docRef.current.value = '';
    load();
  };
  const [settlingId, setSettlingId] = useState(null);
  const [settleAccountId, setSettleAccountId] = useState('');
  const [settleAmount, setSettleAmount] = useState('');
  const [allowance, setAllowance] = useState(null);
  const [allowanceDraft, setAllowanceDraft] = useState('');

  const post = async (url, body, what) => {
    setError(null);
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b?.error || `Could not ${what} (HTTP ${res.status}).`);
      return false;
    }
    load();
    window.dispatchEvent(new Event('review-changed'));
    return true;
  };

  const load = () => {
    const q = filter === 'all' ? '' : `?status=${filter}`;
    fetch(`/api/contracts${q}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setContracts(data);
        else setError(data?.error || 'Failed to load contracts.');
      })
      .catch(() => setError('Failed to load contracts.'));
  };
  useEffect(load, [filter]);
  useEffect(() => {
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
    fetch('/api/contracts/settings').then((r) => r.json()).then((d) => { setAllowance(d.deduction_allowance_pct); setAllowanceDraft(String(d.deduction_allowance_pct)); });
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/contracts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        quantity: form.quantity ? Number(form.quantity) : null,
        price_per_unit: form.price_per_unit ? Number(form.price_per_unit) : null,
        total_value: form.total_value ? Number(form.total_value) : null,
        counterparty: form.counterparty || null,
        delivery_date: form.delivery_date || null,
        contract_period_end: form.contract_period_end || null,
        expected_payment_date: form.expected_payment_date || null,
        notes: form.notes || null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not save contract (HTTP ${res.status}).`);
      return;
    }
    setForm(emptyForm);
    load();
  };

  const settle = async (id) => {
    setError(null);
    const res = await fetch(`/api/contracts/${id}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: settleAccountId,
        settled_date: new Date().toISOString().slice(0, 10),
        amount: settleAmount ? Number(settleAmount) : null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not settle contract (HTTP ${res.status}).`);
      return;
    }
    setSettlingId(null);
    setSettleAccountId('');
    setSettleAmount('');
    load();
  };

  const unsettle = async (id) => {
    setError(null);
    const res = await fetch(`/api/contracts/${id}/reopen`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not unsettle (HTTP ${res.status}).`);
      return;
    }
    load();
  };

  const remove = async (id) => {
    setError(null);
    const res = await fetch(`/api/contracts/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error || `Could not delete (HTTP ${res.status}).`);
      return;
    }
    load();
  };

  const outstanding = contracts.filter(isOpen).reduce((s, c) => s + Number(c.remaining ?? c.total_value), 0);

  const previewTotal = form.total_value
    ? Number(form.total_value)
    : (Number(form.quantity) || 0) * (Number(form.price_per_unit) || 0);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Contracts</h1>
        <span className="page-meta">Still to come on open contracts: {money(outstanding)}</span>
      </div>

      {error && (
        <div className="panel" style={{ borderColor: 'var(--red, #c0392b)' }}>
          <div className="panel-header">Something went wrong</div>
          <p style={{ margin: '8px 0 0', color: 'var(--red, #c0392b)' }}>{error}</p>
        </div>
      )}

      <div className="panel">
        <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Sale contracts — expected money in</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="delivered">Delivered</option>
            <option value="settled">Settled</option>
          </select>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 16px 12px' }}>
          Deposits count toward a contract as they land — on their own when the deposit names the buyer and only one
          contract fits, otherwise listed under the contract to confirm. A contract settles itself once its deposits
          reach its value less{' '}
          {allowance == null ? '…' : (
            <span style={{ whiteSpace: 'nowrap' }}>
              <input aria-label="Deductions allowance %" type="number" step="0.1" min="0" max="49" value={allowanceDraft}
                onChange={(e) => setAllowanceDraft(e.target.value)} style={{ width: 54, padding: '1px 4px' }}
                onBlur={() => { if (Number(allowanceDraft) !== allowance) post('/api/contracts/settings', { deduction_allowance_pct: Number(allowanceDraft) }, 'save the allowance').then((ok) => ok && setAllowance(Number(allowanceDraft))); }} />%
            </span>
          )}{' '}
          for checkoff and levies; the difference is booked as deductions so income shows at the contract value.
          Only what's still to come counts on the cash-flow forecast.
        </p>
        <input ref={docRef} type="file" accept="image/*,application/pdf,.pdf" hidden onChange={(e) => addDocument(e.target.files?.[0])} />
        {contracts.length === 0 ? (
          <div className="empty-state">No contracts on file.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Payment expected</th><th>Commodity</th><th>Qty</th><th>Value</th><th>Received</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <Fragment key={c.id}>
                  <tr>
                    <td>{c.expected_payment_date?.slice(0, 10)}</td>
                    <td>{c.commodity}{c.delivery_date ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> · deliv. {c.delivery_date.slice(0, 10)}</span> : null}
                      {(c.counterparty || c.source !== 'manual') && (
                        <div className="split-lines">{[c.counterparty, c.source !== 'manual' ? `via ${c.source}` : null].filter(Boolean).join(' · ')}</div>
                      )}
                    </td>
                    <td>{c.quantity ? `${Number(c.quantity)} ${c.unit || ''}${c.price_per_unit ? ` @ ${unitPrice(Number(c.price_per_unit))}/${c.unit || 'unit'}` : ''}` : '—'}</td>
                    <td>{money(Number(c.total_value))}</td>
                    <td>
                      <span className="nowrap">{money(Number(c.received_amount || 0))}</span>
                      <div className="contract-bar" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, (Number(c.received_amount || 0) / Math.max(Number(c.total_value), 1)) * 100)}%` }} />
                      </div>
                      {isOpen(c) && Number(c.received_amount) > 0 && <div className="split-lines nowrap">{money(c.remaining)} to come</div>}
                      {Number(c.deductions_amount) > 0 && <div className="split-lines nowrap">incl. {money(Number(c.deductions_amount))} deductions</div>}
                    </td>
                    <td>{STATUS_BADGE[statusOf(c)] || c.status}</td>
                    <td>
                      {settlingId === c.id ? (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                          <select value={settleAccountId} onChange={(e) => setSettleAccountId(e.target.value)}>
                            <option value="">Deposited to…</option>
                            {accounts.map((a) => (
                              <option key={a.id} value={a.id}>{a.name} ({a.ledger})</option>
                            ))}
                          </select>
                          <input
                            type="number" step="0.01" style={{ width: 110 }}
                            placeholder={`Amount (${money(c.remaining ?? Number(c.total_value))})`}
                            value={settleAmount}
                            onChange={(e) => setSettleAmount(e.target.value)}
                          />
                          <button className="small" disabled={!settleAccountId} onClick={() => settle(c.id)}>Confirm</button>
                          <button className="small secondary" onClick={() => { setSettlingId(null); setSettleAccountId(''); setSettleAmount(''); }}>Cancel</button>
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                          {isOpen(c) && (
                            <button className="small secondary" title="Money arrived that isn't on a statement yet — records the deposit by hand"
                              onClick={() => { setSettlingId(c.id); setSettleAccountId(''); setSettleAmount(''); }}>Record deposit</button>
                          )}
                          {c.status === 'settled' && (
                            <button className="small secondary" onClick={() => unsettle(c.id)}>Reopen</button>
                          )}
                          <button className="small secondary" title="The signed contract, an amendment or confirmation — photo or PDF"
                            onClick={() => { setDocFor(c.id); docRef.current?.click(); }}>Add document</button>
                          {c.status !== 'settled' && !(c.deposits || []).length && (
                            <button className="small secondary" onClick={() => remove(c.id)}>Delete</button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                  {((c.deposits || []).length > 0 || (c.suggestions || []).length > 0 || c.settle_note || (c.documents || []).length > 0) && (
                    <tr className="contract-detail">
                      <td colSpan={7}>
                        {(c.documents || []).length > 0 && (
                          <div className="split-lines">
                            Contract documents:{' '}
                            {c.documents.map((d, i) => (
                              <a key={d.id} className="tag" href={`/api/receipts/${d.id}/image`} target="_blank" rel="noreferrer">
                                {i === 0 ? 'Contract' : `Document ${i + 1}`}{d.mime === 'application/pdf' ? ' (PDF)' : ''}
                              </a>
                            ))}
                          </div>
                        )}
                        {(c.deposits || []).length > 0 && (
                          <div className="contract-deposits">
                            {c.deposits.map((d) => (
                              <div key={d.id} className="split-lines">
                                {d.date} · {d.account} · <span className="nowrap">{cents(d.amount)}</span> · {d.description}
                                {d.awaiting_statement && <span className="tag">Awaiting statement</span>}
                                {(d.documents || []).map((x, i) => (
                                  <a key={x.id} className="tag" href={`/api/receipts/${x.id}/image`} target="_blank" rel="noreferrer">
                                    Ticket{d.documents.length > 1 ? ` ${i + 1}` : ''}
                                  </a>
                                ))}{' '}
                                <a className="small-link" href={`/ledgers?edit=${d.id}`}>Open</a>{' '}
                                <button type="button" className="small-link" title={d.created_here ? 'Removes this hand-recorded deposit' : 'Not this contract — the deposit stays in the ledger'}
                                  onClick={() => post(`/api/contracts/${c.id}/unlink`, { transaction_id: d.id }, 'unlink it')}>
                                  {d.created_here ? 'Remove' : 'Not this contract'}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        {c.settle_note && <div className="split-lines">{c.settle_note}</div>}
                        {isOpen(c) && Number(c.received_amount) > 0 && (
                          <div className="contract-actions">
                            <span className="split-lines">All of it delivered and paid?</span>
                            <button type="button" className={c.remaining <= Number(c.total_value) * 0.15 ? 'small' : 'small secondary'}
                              onClick={() => post(`/api/contracts/${c.id}/settle-now`, { mode: 'deductions' }, 'settle it')}>
                              Settle — the {money(c.remaining)} left was deductions
                            </button>
                            <button type="button" className="small secondary" onClick={() => post(`/api/contracts/${c.id}/settle-now`, { mode: 'short' }, 'settle it')}>
                              Settle — delivered short
                            </button>
                          </div>
                        )}
                        {(c.suggestions || []).length > 0 && (
                          <div className="contract-suggest">
                            <div className="split-lines">Deposits that look like this contract:</div>
                            {c.suggestions.map((t) => (
                              <div key={t.id} className="split-lines">
                                <button type="button" className="small" onClick={() => post(`/api/contracts/${c.id}/link`, { transaction_id: t.id }, 'link it')}>Counts toward this</button>{' '}
                                {t.date} · {t.account} · <span className="nowrap">{cents(t.amount)}</span> · {t.description}
                                {t.names_buyer && <span className="tag">Names {c.counterparty}</span>}
                                {t.names_crop && <span className="tag">{c.commodity}</span>}
                              </div>
                            ))}
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
        <div className="panel-header">Add a contract manually</div>
        <form className="form-panel" onSubmit={submit}>
          <div className="field">
            <label>Commodity</label>
            <input required value={form.commodity} onChange={(e) => setForm({ ...form, commodity: e.target.value })} placeholder="e.g. Canola, HRSW, Feeder steers" />
          </div>
          <div className="field">
            <label>Quantity</label>
            <input type="number" step="0.001" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </div>
          <div className="field">
            <label>Unit</label>
            <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="tonnes / bu / head" />
          </div>
          <div className="field">
            <label>Price per unit</label>
            <input type="number" step="0.01" value={form.price_per_unit} onChange={(e) => setForm({ ...form, price_per_unit: e.target.value })} />
          </div>
          <div className="field">
            <label>Total value (leave blank to use qty × price{previewTotal ? ` = ${money(previewTotal)}` : ''})</label>
            <input type="number" step="0.01" value={form.total_value} onChange={(e) => setForm({ ...form, total_value: e.target.value })} />
          </div>
          <div className="field">
            <label>Counterparty / buyer</label>
            <input value={form.counterparty} onChange={(e) => setForm({ ...form, counterparty: e.target.value })} />
          </div>
          <div className="field">
            <label>Confirmed delivery date (payment lands 7 days after)</label>
            <input type="date" value={form.delivery_date} onChange={(e) => setForm({ ...form, delivery_date: e.target.value })} />
          </div>
          <div className="field">
            <label>Contract period end (used when no delivery is scheduled yet)</label>
            <input type="date" value={form.contract_period_end} onChange={(e) => setForm({ ...form, contract_period_end: e.target.value })} />
          </div>
          <div className="field">
            <label>Expected payment date (only if actually known — overrides the rule)</label>
            <input type="date" value={form.expected_payment_date} onChange={(e) => setForm({ ...form, expected_payment_date: e.target.value })} />
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            Payment date rule: confirmed delivery + 7 days; no delivery scheduled → last day of the
            contract period (the latest the window allows, so the forecast stays conservative).
            Enter at least one of the three dates.
          </p>
          <div className="field">
            <label>Owner</label>
            <select value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })}>
              {Object.entries(SEGMENT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Notes</label>
            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <button type="submit">Add contract</button>
        </form>
      </div>
    </>
  );
}
