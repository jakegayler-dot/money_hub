import { Fragment, useEffect, useState } from 'react';
import { money, localToday } from '../format.js';
import { cents } from '../components/SplitEditor.jsx';
import CategorySelect from '../components/CategorySelect.jsx';
import { OwnerFields, ownerPayload, ownerFieldsFrom, ownerSummary, emptyOwnerFields } from '../owners.jsx';

// Invoices and receipts the farm writes (Jake, 2026-10-26): invoices to
// customers (money owed to the farm until paid, then their receipt), receipts
// for sales paid on the spot, and payment receipts for people the farm pays.
// Each prints as a PDF on the farm's letterhead; money is booked when it moves.

const KIND = {
  invoice: { label: 'Invoice', who: 'Bill to', make: 'New invoice', cats: 'income' },
  sale_receipt: { label: 'Sale receipt', who: 'Received from', make: 'New sale receipt', cats: 'income' },
  payment_receipt: { label: 'Payment receipt', who: 'Paid to', make: 'New payment receipt', cats: 'expense' },
};
const GST = 0.05;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const plusDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const blankLine = () => ({ description: '', qty: '1', unit_price: '', gst: false, category_id: '' });
const newForm = (kind) => ({
  kind, party_name: '', party_address: '', date: localToday(), due_date: kind === 'invoice' ? plusDays(localToday(), 30) : '',
  lines: [blankLine()], notes: '', paid_by: '', account_id: '',
  ...emptyOwnerFields, segment: kind === 'payment_receipt' ? 'grain' : 'grain',
});
const totals = (lines) => {
  const amt = lines.map((l) => r2((l.qty === '' ? 1 : Number(l.qty)) * Number(l.unit_price || 0)));
  const subtotal = r2(amt.reduce((a, v) => a + v, 0));
  const gst = r2(lines.reduce((a, l, i) => a + (l.gst ? amt[i] * GST : 0), 0));
  return { amt, subtotal, gst, total: r2(subtotal + gst) };
};

function send(method, url, body) {
  return fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => { const d = r.status === 204 ? {} : await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; });
}

function Letterhead({ value, onSaved, onClose }) {
  const [f, setF] = useState(value);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="panel">
      <div className="panel-header">Letterhead — printed at the top of every invoice and receipt</div>
      <div className="fd-grid" style={{ padding: 16 }}>
        <div className="field"><label>Farm name</label><input value={f.name} onChange={set('name')} placeholder="As it should appear" /></div>
        <div className="field"><label>GST number</label><input value={f.gst_number} onChange={set('gst_number')} placeholder="123456789 RT0001" /></div>
        <div className="field"><label>Phone</label><input value={f.phone} onChange={set('phone')} /></div>
        <div className="field"><label>Email</label><input value={f.email} onChange={set('email')} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Mailing address</label>
          <textarea rows={2} value={f.address} onChange={set('address')} placeholder={'Box 123\nStar City SK  S0E 1P0'} /></div>
      </div>
      {err && <p className="review-error" style={{ margin: '0 16px 8px' }}>{err}</p>}
      <div style={{ padding: '0 16px 16px', display: 'flex', gap: 8 }}>
        <button type="button" className="small" onClick={() => send('PUT', '/api/farm-docs/letterhead', f).then(onSaved).catch((e) => setErr(e.message))}>Save letterhead</button>
        {onClose && <button type="button" className="small secondary" onClick={onClose}>Cancel</button>}
      </div>
    </div>
  );
}

function Editor({ initial, categories, accounts, onDone, onCancel }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const k = KIND[f.kind];
  const t = totals(f.lines);
  const editing = !!f.id;
  const setLine = (i, patch) => setF({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const save = async () => {
    setBusy(true); setErr(null);
    const body = {
      ...f, ...ownerPayload(f),
      lines: f.lines.filter((l) => l.description.trim() || Number(l.unit_price)).map((l) => ({
        description: l.description, qty: l.qty === '' ? 1 : Number(l.qty), unit_price: Number(l.unit_price || 0), gst: !!l.gst, category_id: l.category_id ? Number(l.category_id) : null,
      })),
      due_date: f.kind === 'invoice' ? (f.due_date || null) : null,
      account_id: f.account_id ? Number(f.account_id) : null,
    };
    try {
      const d = editing ? await send('PATCH', `/api/farm-docs/${f.id}`, body) : await send('POST', '/api/farm-docs', body);
      onDone(d);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="panel fd-editor">
      <div className="panel-header">{editing ? `Edit ${f.number}` : k.make}</div>
      <div className="fd-grid" style={{ padding: '16px 16px 0' }}>
        <div className="field"><label>{k.who}</label><input value={f.party_name} onChange={(e) => setF({ ...f, party_name: e.target.value })} placeholder="Name" /></div>
        <div className="field"><label>Their address (optional)</label><textarea rows={2} value={f.party_address} onChange={(e) => setF({ ...f, party_address: e.target.value })} /></div>
        <div className="field"><label>Date</label><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
        {f.kind === 'invoice' && <div className="field"><label>Due</label><input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></div>}
      </div>

      <div className="fd-lines-wrap">
        <table className="fd-lines" data-nostack="">
          <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit price</th><th>GST</th><th>Category</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {f.lines.map((l, i) => (
              <tr key={i}>
                <td><input value={l.description} aria-label="Description" placeholder={f.kind === 'payment_receipt' ? 'e.g. 2026 cash rent, NW 12-46-18 W2' : 'e.g. Round bales, alfalfa/brome'} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                <td><input className="fd-num" type="number" step="any" min="0" aria-label="Quantity" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></td>
                <td><input className="fd-num" type="number" step="0.01" aria-label="Unit price" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} /></td>
                <td><input type="checkbox" aria-label="5% GST on this line" checked={l.gst} onChange={(e) => setLine(i, { gst: e.target.checked })} /></td>
                <td className="fd-cat"><CategorySelect categories={categories} preferKind={k.cats} value={l.category_id} onChange={(v) => setLine(i, { category_id: v })} /></td>
                <td className="num">{cents(t.amt[i])}</td>
                <td>{f.lines.length > 1 && <button type="button" className="small-link" aria-label="Remove line" onClick={() => setF({ ...f, lines: f.lines.filter((_, j) => j !== i) })}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="small-link" onClick={() => setF({ ...f, lines: [...f.lines, blankLine()] })}>Add a line</button>
      </div>

      <div className="fd-foot">
        <div className="fd-foot-left">
          <OwnerFields state={f} setState={setF} label="Whose money" />
          {!editing && f.kind !== 'invoice' && (
            <div className="fd-grid">
              <div className="field"><label>{f.kind === 'payment_receipt' ? 'Paid from' : 'Deposited to'}</label>
                <select value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>
                  <option value="">Choose an account</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select></div>
              <div className="field"><label>Paid by</label><input value={f.paid_by} onChange={(e) => setF({ ...f, paid_by: e.target.value })} placeholder="Cash, cheque 412, e-transfer" /></div>
            </div>
          )}
          <div className="field"><label>Notes on the document (optional)</label><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        </div>
        <table className="fd-totals" data-nostack="">
          <tbody>
            <tr><td>Subtotal</td><td className="num">{cents(t.subtotal)}</td></tr>
            {t.gst > 0 && <tr><td>GST 5%</td><td className="num">{cents(t.gst)}</td></tr>}
            <tr className="fd-total"><td>Total</td><td className="num">{cents(t.total)}</td></tr>
          </tbody>
        </table>
      </div>
      {err && <p className="review-error" style={{ margin: '0 16px 8px' }}>{err}</p>}
      <div style={{ padding: '0 16px 16px', display: 'flex', gap: 8 }}>
        <button type="button" className="small" disabled={busy} onClick={save}>
          {editing ? 'Save changes' : f.kind === 'invoice' ? 'Create invoice' : 'Create and book it'}
        </button>
        <button type="button" className="small secondary" onClick={onCancel}>Cancel</button>
      </div>
      {!editing && f.kind !== 'invoice' && <p className="field-hint" style={{ margin: '-8px 16px 14px' }}>Booking puts the {f.kind === 'payment_receipt' ? 'payment' : 'deposit'} in the ledger now, filed under the lines' categories.</p>}
    </div>
  );
}

function PayPanel({ doc, accounts, onDone, onCancel }) {
  const [account, setAccount] = useState('');
  const [date, setDate] = useState(localToday());
  const [by, setBy] = useState(doc.paid_by || '');
  const [cands, setCands] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { fetch(`/api/farm-docs/${doc.id}/candidates`).then((r) => r.json()).then((d) => setCands(Array.isArray(d) ? d : [])).catch(() => setCands([])); }, [doc.id]);
  const pay = (body) => send('POST', `/api/farm-docs/${doc.id}/pay`, body).then(onDone).catch((e) => setErr(e.message));
  return (
    <div className="fd-pay">
      {cands?.length > 0 && (
        <div>
          <div className="split-lines">Already in the ledger? Link it instead of booking a second deposit:</div>
          {cands.map((c) => (
            <div key={c.id} className="fd-cand">
              <span>{c.date} · {c.account} · {c.description} · {cents(c.amount)}</span>
              <button type="button" className="small" onClick={() => pay({ transaction_id: c.id, paid_by: by })}>This is it</button>
            </div>
          ))}
        </div>
      )}
      <div className="fd-pay-row">
        <select value={account} aria-label="Deposited to" onChange={(e) => setAccount(e.target.value)}>
          <option value="">Deposited to…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input type="date" value={date} aria-label="Paid on" onChange={(e) => setDate(e.target.value)} />
        <input value={by} aria-label="Paid by" placeholder="Cheque 1043, e-transfer…" onChange={(e) => setBy(e.target.value)} />
        <button type="button" className="small" disabled={!account} onClick={() => pay({ account_id: Number(account), date, paid_by: by })}>Book the deposit</button>
        <button type="button" className="small-link" onClick={onCancel}>Cancel</button>
      </div>
      {err && <p className="review-error">{err}</p>}
    </div>
  );
}

export default function Invoices() {
  const [docs, setDocs] = useState(null);
  const [lh, setLh] = useState(null);
  const [editLh, setEditLh] = useState(false);
  const [form, setForm] = useState(null);
  const [paying, setPaying] = useState(null);
  const [categories, setCategories] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [filter, setFilter] = useState('all');
  const [err, setErr] = useState(null);
  const load = () => fetch('/api/farm-docs').then((r) => r.json()).then((d) => setDocs(Array.isArray(d) ? d : [])).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    fetch('/api/farm-docs/letterhead').then((r) => r.json()).then(setLh).catch(() => setLh({ name: '' }));
    fetch('/api/expenses').then((r) => r.json()).then((c) => setCategories(Array.isArray(c) ? c : []));
    fetch('/api/accounts').then((r) => r.json()).then((a) => setAccounts((Array.isArray(a) ? a : []).filter((x) => !x.closed && x.status !== 'closed')));
  }, []);
  if (!docs || !lh) return <div className="empty-state">Loading…</div>;

  const act = (fn) => fn.then(() => { setErr(null); load(); }).catch((e) => setErr(e.message));
  const today = localToday();
  const open = docs.filter((d) => d.kind === 'invoice' && d.status === 'open');
  const overdue = open.filter((d) => d.due_date && d.due_date < today);
  const shown = docs.filter((d) => (filter === 'all' ? true : filter === 'open' ? d.kind === 'invoice' && d.status === 'open' : d.kind === filter));
  const startEdit = (d) => setForm({
    ...d, ...ownerFieldsFrom(d), party_address: d.party_address || '', notes: d.notes || '', paid_by: d.paid_by || '', due_date: d.due_date || '', account_id: '',
    lines: d.lines.map((l) => ({ description: l.description, qty: String(l.qty), unit_price: String(l.unit_price), gst: !!l.gst, category_id: l.category_id || '' })),
  });

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Invoices &amp; receipts</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {Object.entries(KIND).map(([key, v]) => (
            <button key={key} type="button" className={key === 'invoice' ? 'small' : 'small secondary'} onClick={() => { setForm(newForm(key)); setPaying(null); }}>{v.make}</button>
          ))}
          <button type="button" className="small secondary" onClick={() => setEditLh(!editLh)}>Letterhead</button>
        </div>
      </div>
      {err && <p className="review-error" style={{ margin: '0 0 12px' }}>{err}</p>}

      {(editLh || !lh.name) && (
        <Letterhead value={lh} onSaved={(v) => { setLh(v); setEditLh(false); }} onClose={lh.name ? () => setEditLh(false) : null} />
      )}

      {form && (
        <Editor key={form.id || form.kind} initial={form} categories={categories} accounts={accounts}
          onCancel={() => setForm(null)} onDone={(d) => { setForm(null); load(); if (!form.id) window.open(`/api/farm-docs/${d.id}/pdf`, '_blank'); }} />
      )}

      <div className="grid personal-cards">
        <div className="metric-card"><div className="metric-label">Owed to the farm</div><div className="metric-value">{money(open.reduce((a, d) => a + d.total, 0))}</div>
          <div className="split-lines">{open.length} open invoice{open.length === 1 ? '' : 's'} · in Cash Flow on their due dates</div></div>
        <div className="metric-card"><div className="metric-label">Overdue</div><div className={`metric-value${overdue.length ? ' neg' : ''}`}>{money(overdue.reduce((a, d) => a + d.total, 0))}</div>
          <div className="split-lines">{overdue.length ? overdue.map((d) => d.party_name).join(', ') : 'nothing past due'}</div></div>
      </div>

      <div className="panel">
        <div className="panel-header spend-header">
          <span>Documents</span>
          <span className="seg-toggle" role="group" aria-label="Show">
            {[['all', 'All'], ['open', 'Unpaid'], ['invoice', 'Invoices'], ['sale_receipt', 'Sale receipts'], ['payment_receipt', 'Payment receipts']].map(([key, l]) => (
              <button key={key} type="button" aria-pressed={filter === key} className={filter === key ? 'on' : ''} onClick={() => setFilter(key)}>{l}</button>
            ))}
          </span>
        </div>
        {shown.length === 0 ? (
          <div className="empty-state">Nothing here yet. Make an invoice when you sell hay, custom work or cattle privately; a payment receipt when you pay rent or wages in cash or by cheque.</div>
        ) : (
          <table className="fd-list">
            <thead><tr><th>Number</th><th>Date</th><th>Who</th><th>Owner</th><th className="num">Total</th><th>Status</th><th /></tr></thead>
            <tbody>
              {shown.map((d) => {
                const late = d.kind === 'invoice' && d.status === 'open' && d.due_date && d.due_date < today;
                return (
                  <Fragment key={d.id}>
                    <tr className={d.status === 'void' ? 'fd-void' : ''}>
                      <td><b>{d.number}</b><div className="split-lines">{KIND[d.kind].label}{d.receipt_number ? ` · receipt ${d.receipt_number}` : ''}</div></td>
                      <td>{d.date}{d.kind === 'invoice' && d.due_date && <div className="split-lines">due {d.due_date}</div>}</td>
                      <td>{d.party_name}<div className="split-lines">{d.lines.map((l) => l.description).join(', ')}</div></td>
                      <td>{ownerSummary(d)}</td>
                      <td className="num">{cents(d.kind === 'payment_receipt' ? -d.total : d.total)}</td>
                      <td>
                        {d.status === 'paid' ? <span className="badge pass">PAID {d.paid_date}</span>
                          : d.status === 'void' ? <span className="badge">VOID</span>
                          : late ? <span className="badge fail">OVERDUE</span> : <span className="badge warn">UNPAID</span>}
                        {d.account && <div className="split-lines">{d.account}{d.paid_by ? ` · ${d.paid_by}` : ''}</div>}
                      </td>
                      <td className="fd-acts">
                        <a className="small-link" href={`/api/farm-docs/${d.id}/pdf`} target="_blank" rel="noreferrer">{d.kind === 'invoice' ? 'Invoice PDF' : 'PDF'}</a>
                        {d.kind === 'invoice' && d.status === 'paid' && <a className="small-link" href={`/api/farm-docs/${d.id}/pdf?as=receipt`} target="_blank" rel="noreferrer">Receipt PDF</a>}
                        {d.kind === 'invoice' && d.status === 'open' && <button type="button" className="small-link" onClick={() => setPaying(paying === d.id ? null : d.id)}>Mark paid</button>}
                        {d.status === 'open' && <button type="button" className="small-link" onClick={() => { setForm(null); setTimeout(() => startEdit(d)); }}>Edit</button>}
                        {d.status === 'paid' && <button type="button" className="small-link" onClick={() => { if (window.confirm(`Undo the payment on ${d.number}? ${d.linked_existing ? 'The ledger entry stays, unlinked.' : 'The entry it booked is deleted.'}`)) act(send('POST', `/api/farm-docs/${d.id}/unpay`)); }}>Undo payment</button>}
                        {d.status === 'open' && <button type="button" className="small-link" onClick={() => { if (window.confirm(`Void ${d.number}? Its number isn't reused.`)) act(send('POST', `/api/farm-docs/${d.id}/void`)); }}>Void</button>}
                        {d.status !== 'paid' && <button type="button" className="small-link" onClick={() => { if (window.confirm(`Delete ${d.number}?`)) act(send('DELETE', `/api/farm-docs/${d.id}`)); }}>Delete</button>}
                      </td>
                    </tr>
                    {paying === d.id && (
                      <tr><td colSpan={7}><PayPanel doc={d} accounts={accounts} onCancel={() => setPaying(null)} onDone={() => { setPaying(null); load(); window.open(`/api/farm-docs/${d.id}/pdf?as=receipt`, '_blank'); }} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
