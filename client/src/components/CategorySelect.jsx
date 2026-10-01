import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const NEW = '__new__';

const CLASS_LABELS = {
  variable_seasonal: 'Variable / seasonal',
  fixed: 'Fixed',
  overhead: 'Overhead',
  capex: 'Capital expenditure',
};

const kindOf = (c) => (c.kind === 'income' ? 'income' : 'expense');

/**
 * Category dropdown — income and expense categories in two groups, the one
 * that fits the amount first (`preferKind`: money in → 'income'). "+ New
 * category…" at the bottom opens a small window to create one; it's
 * selected straight away and every other category list on the page reloads
 * (pages listen for the 'categories-changed' event).
 */
export default function CategorySelect({ value, onChange, categories, preferKind = 'expense', emptyLabel = 'No category', ...rest }) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState(null); // shown until the page's list reloads
  const known = created && !categories.some((c) => c.id === created.id) ? [...categories, created] : categories;
  const order = preferKind === 'income' ? ['income', 'expense'] : ['expense', 'income'];
  const label = { income: 'Income', expense: 'Expenses' };

  return (
    <>
      <select {...rest} value={value} onChange={(e) => (e.target.value === NEW ? setOpen(true) : onChange(e.target.value))}>
        <option value="">{emptyLabel}</option>
        {order.map((k) => {
          const list = known.filter((c) => kindOf(c) === k);
          return list.length ? (
            <optgroup key={k} label={label[k]}>
              {list.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.name}</option>)}
            </optgroup>
          ) : null;
        })}
        <option value={NEW}>+ New category…</option>
      </select>
      {open && createPortal(
        <NewCategoryDialog
          categories={categories}
          defaultKind={preferKind}
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

function NewCategoryDialog({ categories, defaultKind, onClose, onCreated }) {
  const [kind, setKind] = useState(defaultKind === 'income' ? 'income' : 'expense');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [ledger, setLedger] = useState('business');
  const [klass, setKlass] = useState('variable_seasonal');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef(null);
  const parents = categories.filter((c) => !c.parent_id && kindOf(c) === kind);

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
    const body = { name: name.trim(), kind };
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
      <div className="modal" role="dialog" aria-modal="true" aria-label="New category">
        <div className="modal-head">
          <span>New category</span>
          <button type="button" className="small secondary" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {/* A div, not a <form>: this can open inside another form. */}
        <div className="modal-body" onKeyDown={(e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') save(e); }}>
          <div className="seg-toggle" role="group" aria-label="Income or expense" style={{ justifySelf: 'start' }}>
            {['expense', 'income'].map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'on' : ''}
                onClick={() => { setKind(k); setParentId(''); }}>
                {k === 'income' ? 'Income' : 'Expense'}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="newcat-name">Name</label>
            <input id="newcat-name" ref={nameRef} value={name} onChange={(e) => { setName(e.target.value); setError(null); }}
              placeholder={kind === 'income' ? 'e.g. Pea sales' : 'e.g. Diesel — dyed'} />
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
              {kind === 'expense' && (
                <div className="field">
                  <label htmlFor="newcat-class">Type</label>
                  <select id="newcat-class" value={klass} onChange={(e) => setKlass(e.target.value)}>
                    {Object.entries(CLASS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </div>
              )}
            </div>
          )}
          {parentId && <p className="modal-note">Takes its ledger from the main category, and rolls up into its totals.</p>}
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
