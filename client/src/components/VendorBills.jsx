import { Fragment, useEffect, useState } from 'react';
import { money } from '../format.js';
import { cents } from './SplitEditor.jsx';
import CategorySelect from './CategorySelect.jsx';

const today = () => new Date().toISOString().slice(0, 10);
const KIND = { prepayment: 'Prepayment (applied to bills)', refundable: 'Refundable deposit' };
const CREDIT_STATUS = { open: 'Held', used: 'All applied', refunded: 'Refunded', kept: 'Kept by vendor' };

/**
 * Bills by vendor: one line each with what's owed, deposits the vendor is
 * holding, and the net. Open a vendor to pay everything in one payment,
 * record a deposit, apply it to a bill, or mark it refunded.
 */
export default function VendorBills({ accounts, categories, onChanged }) {
  const [vendors, setVendors] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState(null);

  const load = () => fetch('/api/bills/vendors').then((r) => r.json()).then((d) => setVendors(Array.isArray(d) ? d : []));
  useEffect(() => { load(); }, []);

  const call = async (method, url, body, what) => {
    setError(null);
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      setError(b.error || `Could not ${what} (HTTP ${r.status}).`);
      return false;
    }
    await load();
    onChanged?.();
    return true;
  };

  if (!vendors) return <div className="empty-state">Loading…</div>;
  if (!vendors.length) return <div className="empty-state">No unpaid bills or deposits.</div>;

  return (
    <>
      {error && <p className="review-error" style={{ margin: '0 16px 8px' }}>{error}</p>}
      <table>
        <thead>
          <tr><th>Vendor</th><th>Open bills</th><th>Oldest due</th><th>Owing</th><th>Deposits held</th><th>Net</th></tr>
        </thead>
        <tbody>
          {vendors.map((v) => {
            const key = v.payee_id ?? 0;
            const isOpen = open === key;
            return (
              <Fragment key={key}>
                <tr className="vendor-row" onClick={() => setOpen(isOpen ? null : key)} style={{ cursor: 'pointer' }}>
                  <td><span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> {v.name}</td>
                  <td>{v.bills.length}</td>
                  <td>{v.oldest_due || '—'}{v.oldest_due && v.oldest_due < today() && <span className="badge fail" style={{ marginLeft: 6 }}>OVERDUE</span>}</td>
                  <td className="nowrap">{money(v.owing)}</td>
                  <td className="nowrap">{v.held ? money(v.held) : '—'}</td>
                  <td className="nowrap" style={{ fontWeight: 600 }}>{money(v.net)}</td>
                </tr>
                {isOpen && (
                  <tr className="contract-detail">
                    <td colSpan={6}>
                      <VendorDetail v={v} accounts={accounts} categories={categories} call={call} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function VendorDetail({ v, accounts, categories, call }) {
  const [payAccount, setPayAccount] = useState('');
  const [payCheck, setPayCheck] = useState(false);
  const [picked, setPicked] = useState(() => new Set(v.bills.map((b) => b.id)));
  const [deposit, setDeposit] = useState(null); // form state when recording one
  const [refundFor, setRefundFor] = useState(null);
  const [keepFor, setKeepFor] = useState(null);
  const [payments, setPayments] = useState([]);
  const pickedTotal = v.bills.filter((b) => picked.has(b.id)).reduce((s, b) => s + b.owing, 0);
  const openCredits = v.credits.filter((c) => c.status === 'open');

  const loadPayments = (direction) => fetch(`/api/bills/vendors/${v.payee_id}/payments?direction=${direction}`)
    .then((r) => r.json()).then((d) => setPayments(Array.isArray(d) ? d : []));

  return (
    <div className="vendor-detail">
      {v.bills.length > 0 && (
        <div className="vendor-block">
          <div className="split-lines" style={{ fontWeight: 600 }}>Unpaid bills</div>
          {v.bills.map((b) => (
            <label key={b.id} className="split-lines vendor-bill">
              <input type="checkbox" checked={picked.has(b.id)} onChange={(e) => {
                const n = new Set(picked);
                if (e.target.checked) n.add(b.id); else n.delete(b.id);
                setPicked(n);
              }} />
              {' '}{b.due_date} · {b.name} · <span className="nowrap">{cents(b.owing)}</span>
              {b.applied > 0 && <span className="tag">deposit applied {cents(b.applied)}</span>}
              {openCredits.length > 0 && (
                <select aria-label="Apply a deposit" value="" onChange={(e) => e.target.value && call('POST', `/api/bills/credits/${e.target.value}/apply`, { bill_id: b.id }, 'apply the deposit')}>
                  <option value="">Apply a deposit…</option>
                  {openCredits.map((c) => <option key={c.id} value={c.id}>{cents(c.remaining)} held since {c.date}</option>)}
                </select>
              )}
            </label>
          ))}
          {v.payee_id && picked.size > 0 && (
            <div className="contract-actions">
              <span className="split-lines">Pay {picked.size === v.bills.length ? 'all' : `${picked.size} picked`} — {money(pickedTotal)} in one payment from</span>
              <select value={payAccount} onChange={(e) => setPayAccount(e.target.value)}>
                <option value="">Account…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <label className="split-lines"><input type="checkbox" checked={payCheck} onChange={(e) => setPayCheck(e.target.checked)} /> by cheque</label>
              <button type="button" className="small" disabled={!payAccount}
                onClick={() => call('POST', '/api/bills/pay-many', { bill_ids: [...picked], account_id: Number(payAccount), paid_date: today(), paid_by_check: payCheck }, 'pay them')}>
                Pay
              </button>
            </div>
          )}
        </div>
      )}

      {v.payee_id && (
        <div className="vendor-block">
          <div className="split-lines" style={{ fontWeight: 600 }}>Deposits with {v.name}</div>
          {v.credits.length === 0 && <div className="split-lines">None.</div>}
          {v.credits.map((c) => (
            <div key={c.id} className="split-lines">
              {c.date} · {KIND[c.kind]} · <span className="nowrap">{cents(c.amount)}</span>
              {c.status === 'open' && c.remaining < c.amount && <> · {cents(c.remaining)} left</>}
              <span className="tag">{CREDIT_STATUS[c.status]}</span>
              {(c.applications || []).map((a) => (
                <span key={a.id} className="tag">
                  {cents(a.amount)} → {a.bill}{' '}
                  <button type="button" className="small-link" onClick={() => call('POST', `/api/bills/credits/applications/${a.id}/remove`, null, 'take it off')}>×</button>
                </span>
              ))}
              {c.status === 'open' && c.kind === 'refundable' && (
                <button type="button" className="small-link" onClick={() => { setRefundFor(c.id); loadPayments('in'); }}>Refunded…</button>
              )}{' '}
              {c.status === 'open' && <button type="button" className="small-link" onClick={() => setKeepFor(c.id)}>Vendor kept it…</button>}{' '}
              <button type="button" className="small-link" onClick={() => window.confirm('Remove this deposit record? Its payment stays in the ledger.') && call('DELETE', `/api/bills/credits/${c.id}`, null, 'remove it')}>Remove</button>
              {refundFor === c.id && (
                <div className="contract-actions">
                  <span className="split-lines">Which deposit was the refund?</span>
                  {payments.length === 0 && <span className="split-lines">No money in from {v.name} on file yet — it matches on its own when it arrives.</span>}
                  {payments.map((t) => (
                    <button key={t.id} type="button" className="small secondary"
                      onClick={() => call('POST', `/api/bills/credits/${c.id}/refund`, { transaction_id: t.id }, 'mark it refunded').then(() => setRefundFor(null))}>
                      {t.date} · {cents(t.amount)}
                    </button>
                  ))}
                  <button type="button" className="small-link" onClick={() => setRefundFor(null)}>Cancel</button>
                </div>
              )}
              {keepFor === c.id && (
                <KeepForm categories={categories} onCancel={() => setKeepFor(null)}
                  onSave={(cat) => call('POST', `/api/bills/credits/${c.id}/keep`, { category_id: cat }, 'save').then(() => setKeepFor(null))} />
              )}
            </div>
          ))}
          {deposit ? (
            <div className="contract-actions">
              <select value={deposit.kind} onChange={(e) => setDeposit({ ...deposit, kind: e.target.value })}>
                <option value="prepayment">{KIND.prepayment}</option>
                <option value="refundable">{KIND.refundable}</option>
              </select>
              {payments.length > 0 && (
                <select value={deposit.transaction_id} onChange={(e) => setDeposit({ ...deposit, transaction_id: e.target.value })}>
                  <option value="">A payment already in the ledger…</option>
                  {payments.map((t) => <option key={t.id} value={t.id}>{t.date} · {cents(t.amount)} · {t.description}</option>)}
                </select>
              )}
              {!deposit.transaction_id && (
                <>
                  <select value={deposit.account_id} onChange={(e) => setDeposit({ ...deposit, account_id: e.target.value })}>
                    <option value="">…or paid now from</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <input type="number" step="0.01" placeholder="Amount" style={{ width: 100 }} value={deposit.amount}
                    onChange={(e) => setDeposit({ ...deposit, amount: e.target.value })} />
                  <input type="date" value={deposit.date} onChange={(e) => setDeposit({ ...deposit, date: e.target.value })} />
                </>
              )}
              <button type="button" className="small"
                disabled={!deposit.transaction_id && !(deposit.account_id && Number(deposit.amount) > 0)}
                onClick={() => call('POST', '/api/bills/credits', {
                  payee_id: v.payee_id, kind: deposit.kind,
                  transaction_id: deposit.transaction_id ? Number(deposit.transaction_id) : null,
                  account_id: deposit.account_id ? Number(deposit.account_id) : null,
                  amount: deposit.amount ? Number(deposit.amount) : null, date: deposit.date,
                }, 'record the deposit').then((ok) => ok && setDeposit(null))}>
                Save deposit
              </button>
              <button type="button" className="small secondary" onClick={() => setDeposit(null)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="small secondary" style={{ marginTop: 4 }}
              onClick={() => { setDeposit({ kind: 'prepayment', transaction_id: '', account_id: '', amount: '', date: today() }); loadPayments('out'); }}>
              Record a deposit
            </button>
          )}
        </div>
      )}
      {!v.payee_id && <div className="split-lines">Edit these bills and pick their vendor to group them.</div>}
    </div>
  );
}

function KeepForm({ categories, onSave, onCancel }) {
  const [cat, setCat] = useState('');
  return (
    <div className="contract-actions">
      <span className="split-lines">Book what's left as an expense under</span>
      <CategorySelect categories={categories} value={cat} onChange={setCat} />
      <button type="button" className="small" onClick={() => onSave(cat ? Number(cat) : null)}>Save</button>
      <button type="button" className="small-link" onClick={onCancel}>Cancel</button>
    </div>
  );
}
