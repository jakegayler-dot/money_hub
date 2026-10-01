import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const NEW = '__new__';

const CLASS_LABELS = {
  variable_seasonal: 'Variable / seasonal',
  fixed: 'Fixed',
  overhead: 'Overhead',
  capex: 'Capital expenditure',
};

/**
 * Category dropdown with a "+ New category…" option at the bottom. Picking
 * it opens a small window to create one; the new category is selected
 * straight away and every other category list on the page reloads
 * (pages listen for the 'categories-changed' event).
 */
export default function CategorySelect({ value, onChange, categories, emptyLabel = 'No category', ...rest }) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState(null); // shown until the page's list reloads
  const known = created && !categories.some((c) => c.id === created.id) ? [...categories, created] : categories;

  return (
    <>
      <select {...rest} value={value} onChange={(e) => (e.target.value === NEW ? setOpen(true) : onChange(e.target.value))}>
        <option value="">{emptyLabel}</option>
        {known.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.name}</option>)}
        <option value={NEW}>+ New category…</option>
      </select>
      {open && createPortal(
        <NewCategoryDialog
          categories={categories}
          onClose={() => setOpen(false)}
          onCreated={(c) => {
            setCreated(c);
            setOpen(false);
            onChange(String(c.id));
            window.dispatchEvent(new Event('categories-changed'));
          }}
        />,
        document.body,
      )}
    </>
  );
}

function NewCategoryDialog({ categories, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [ledger, setLedger] = useState('business');
  const [klass, setKlass] = useState('variable_seasonal');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef(null);
  const parents = categories.filter((c) => !c.parent_id);

  useEffect(() => {
    nameRef.current?.focus();
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const save = async (e) => {
    e.preventDefault();
    e.stopPropagation(); // never submit the form this dialog sits inside
    setBusy(true);
    setError(null);
    const body = { name: name.trim() };
    if (parentId) body.parent_id = Number(parentId);
    else { body.ledger = ledger; body.class = klass; }
    const r = await fetch('/api/expenses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null);
    const out = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r || !r.ok) { setError(out.error || 'Could not create it.'); return; }
    const parent = parents.find((p) => String(p.id) === String(parentId));
    onCreated({ ...out, full_name: parent ? `${parent.name} › ${out.name}` : out.name });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="New expense category">
        <div className="modal-head">
          <span>New category</span>
          <button type="button" className="small secondary" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {/* A div, not a <form>: this can open inside another form. */}
        <div className="modal-body" onKeyDown={(e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') save(e); }}>
          <div className="field">
            <label htmlFor="newcat-name">Name</label>
            <input id="newcat-name" ref={nameRef} value={name} onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="e.g. Diesel — dyed" />
          </div>
          <div className="field">
            <label htmlFor="newcat-parent">Under</label>
            <select id="newcat-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Nothing — a new main category</option>
              {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          {!parentId && (
            <div className="modal-row">
              <div className="field">
                <label htmlFor="newcat-ledger">Ledger</label>
                <select id="newcat-ledger" value={ledger} onChange={(e) => setLedger(e.target.value)}>
                  <option value="business">Business</option>
                  <option value="personal">Personal</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="newcat-class">Type</label>
                <select id="newcat-class" value={klass} onChange={(e) => setKlass(e.target.value)}>
                  {Object.entries(CLASS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            </div>
          )}
          {parentId && <p className="modal-note">Takes its ledger and type from the main category, and rolls up into its totals.</p>}
          {error && <p className="review-error" style={{ margin: 0 }}>{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            <button type="button" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Saving…' : 'Add category'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
