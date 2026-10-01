import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const NEW = '__new__';

/** Loads the payee list and keeps it fresh when one is added anywhere. */
export function usePayees() {
  const [payees, setPayees] = useState([]);
  useEffect(() => {
    const load = () => fetch('/api/payees').then((r) => r.json()).then((d) => setPayees(Array.isArray(d) ? d : [])).catch(() => {});
    load();
    window.addEventListener('payees-changed', load);
    return () => window.removeEventListener('payees-changed', load);
  }, []);
  return payees;
}

/**
 * Who was paid, or who paid — Cargill, Viterra, the auction mart, Co-op.
 * Pick from the list, or "+ New…" to add one in a small window.
 */
export default function PayeeSelect({ value, onChange, payees, emptyLabel = 'Not recorded', ...rest }) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState(null);
  const known = created && !payees.some((p) => p.id === created.id) ? [...payees, created] : payees;
  return (
    <>
      <select {...rest} value={value} onChange={(e) => (e.target.value === NEW ? setOpen(true) : onChange(e.target.value))}>
        <option value="">{emptyLabel}</option>
        {known.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        <option value={NEW}>+ New…</option>
      </select>
      {open && createPortal(
        <NewPayeeDialog
          onClose={() => setOpen(false)}
          onCreated={(p) => {
            setCreated(p);
            setOpen(false);
            onChange(String(p.id));
            window.dispatchEvent(new Event('payees-changed'));
          }}
        />,
        document.body,
      )}
    </>
  );
}

function NewPayeeDialog({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  const save = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setError(null);
    const r = await fetch('/api/payees', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
    }).catch(() => null);
    const out = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r || !r.ok) { setError(out.error || 'Could not add it.'); return; }
    onCreated(out);
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="New payee or buyer">
        <div className="modal-head">
          <span>New payee / buyer</span>
          <button type="button" className="small secondary" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body" onKeyDown={(e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') save(e); }}>
          <div className="field">
            <label htmlFor="newpayee-name">Name</label>
            <input id="newpayee-name" ref={ref} value={name} onChange={(e) => { setName(e.target.value); setError(null); }}
              placeholder="e.g. Cargill, Federated Co-op, Heartland Livestock" />
          </div>
          <p className="modal-note">One name per business — use the same one every time so its totals add up.</p>
          {error && <p className="review-error" style={{ margin: 0 }}>{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            <button type="button" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Saving…' : 'Add'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
