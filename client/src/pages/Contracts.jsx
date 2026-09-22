import { Fragment, useEffect, useState } from 'react';
import { money } from '../format.js';

const emptyForm = {
  commodity: '', quantity: '', unit: 'tonnes', price_per_unit: '', total_value: '',
  counterparty: '', delivery_date: '', contract_period_end: '', expected_payment_date: '',
  segment: 'grain', notes: '',
};

const SEGMENT_LABELS = { grain: 'Grain', livestock: 'Livestock', personal: 'Personal' };
const STATUS_BADGE = {
  open: <span className="badge warn">OPEN</span>,
  delivered: <span className="badge warn">DELIVERED</span>,
  settled: <span className="badge pass">SETTLED</span>,
  cancelled: <span className="badge fail">CANCELLED</span>,
};

export default function Contracts() {
  const [contracts, setContracts] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState(null);
  const [settlingId, setSettlingId] = useState(null);
  const [settleAccountId, setSettleAccountId] = useState('');
  const [settleAmount, setSettleAmount] = useState('');

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
    const res = await fetch(`/api/contracts/${id}/unsettle`, { method: 'POST' });
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

  const outstanding = contracts
    .filter((c) => c.status === 'open' || c.status === 'delivered')
    .reduce((s, c) => s + Number(c.total_value), 0);

  const previewTotal = form.total_value
    ? Number(form.total_value)
    : (Number(form.quantity) || 0) * (Number(form.price_per_unit) || 0);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Contracts</h1>
        <span className="page-meta">Contracted, not yet received: {money(outstanding)}</span>
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
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px' }}>
          Unsettled contracts count as inflows on the cash-flow forecast at their expected payment
          month. Settling one (when the money lands) books the real transaction — with the actual
          amount received, since final settlement often differs from the contracted value — and it
          stops being a forecast line. Contracts pushed automatically from another system show their
          source; re-pushes update in place.
        </p>
        {contracts.length === 0 ? (
          <div className="empty-state">No contracts on file.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Payment expected</th><th>Commodity</th><th>Qty</th><th>Value</th><th>Counterparty</th><th>Source</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <Fragment key={c.id}>
                  <tr>
                    <td>{c.expected_payment_date?.slice(0, 10)}</td>
                    <td>{c.commodity}{c.delivery_date ? <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> · deliv. {c.delivery_date.slice(0, 10)}</span> : null}</td>
                    <td>{c.quantity ? `${Number(c.quantity)} ${c.unit || ''}${c.price_per_unit ? ` @ ${money(Number(c.price_per_unit))}` : ''}` : '—'}</td>
                    <td>{money(Number(c.total_value))}</td>
                    <td>{c.counterparty || '—'}</td>
                    <td>{c.source === 'manual' ? '—' : c.source}</td>
                    <td>{STATUS_BADGE[c.status] || c.status}</td>
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
                            placeholder={`Actual (${money(Number(c.total_value))})`}
                            value={settleAmount}
                            onChange={(e) => setSettleAmount(e.target.value)}
                          />
                          <button className="small" disabled={!settleAccountId} onClick={() => settle(c.id)}>Confirm</button>
                          <button className="small secondary" onClick={() => { setSettlingId(null); setSettleAccountId(''); setSettleAmount(''); }}>Cancel</button>
                        </span>
                      ) : (
                        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                          {(c.status === 'open' || c.status === 'delivered') && (
                            <button className="small" onClick={() => { setSettlingId(c.id); setSettleAccountId(''); setSettleAmount(''); }}>Settle</button>
                          )}
                          {c.status === 'settled' && (
                            <button className="small secondary" onClick={() => unsettle(c.id)}>Unsettle</button>
                          )}
                          {c.status !== 'settled' && (
                            <button className="small secondary" onClick={() => remove(c.id)}>Delete</button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
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
            <label>Enterprise</label>
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
