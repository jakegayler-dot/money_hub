import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const CLASS_LABELS = {
  variable_seasonal: 'Variable / seasonal',
  fixed: 'Fixed',
  overhead: 'Overhead',
  capex: 'Capital expenditure',
};

const kindOf = (c) => (c.kind === 'income' ? 'income' : 'expense');

// What the picker suggests before anything is typed (GET /api/expenses/usage):
// each payee's recent categories and the most used. Loaded once per page.
let usage = null;
const loadUsage = () => {
  if (!usage) usage = fetch('/api/expenses/usage').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return usage;
};
if (typeof window !== 'undefined') window.addEventListener('categories-changed', () => { usage = null; });

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const words = (s) => norm(s).split(/[^a-z0-9&]+/).filter(Boolean);

/** How well a category matches what's typed: every word must start a word of its name (or its main category's). */
function score(c, q) {
  const qs = words(q);
  if (!qs.length) return 0;
  const name = words(c.name);
  const all = words(c.full_name || c.name);
  let s = 0;
  for (const w of qs) {
    if (name.some((x) => x.startsWith(w))) s += 3;
    else if (all.some((x) => x.startsWith(w))) s += 2;
    else if (norm(c.full_name || c.name).includes(w)) s += 1;
    else return -1;
  }
  if (norm(c.name).startsWith(norm(q).trim())) s += 2;
  return s;
}

/**
 * The category picker: type to find (a word of the category or its main
 * category), or pick from what this payee was given before and what's used
 * most. `moves` puts what isn't a category in the same list — a transfer,
 * a card payment, a refund or payment with CRA — each { key, label, hint };
 * picking one calls onMove(move). "+ New category…" at the bottom creates
 * one (with what was typed as its name). Keyboard: type, ↑↓, Enter, Esc.
 * Without an onKeyDown from the page, ↓ or Enter opens it; in the ledger
 * grid (which passes onKeyDown) those keys move between cells until you type.
 */
export default function CategorySelect({
  value, onChange, categories, preferKind = 'expense', emptyLabel = 'No category', payeeId = null,
  moves = [], onMove, disabled = false, onKeyDown, className = '', style, required, id, ...rest
}) {
  const [dialog, setDialog] = useState(null); // { name } while creating one
  const [created, setCreated] = useState(null); // shown until the page's list reloads
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [hints, setHints] = useState(null);
  const [pos, setPos] = useState(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const listId = useRef(`catlist-${Math.random().toString(36).slice(2, 9)}`).current;

  const known = created && !categories.some((c) => c.id === created.id) ? [...categories, created] : categories;
  const selected = known.find((c) => String(c.id) === String(value));
  const label = selected ? (selected.full_name || selected.name) : '';

  useEffect(() => { if (open && !hints) loadUsage().then((u) => setHints(u || { by_payee: {}, most_used: { income: [], expense: [] } })); }, [open, hints]);

  // Placed under the input (above it near the bottom of the screen), kept there while the page scrolls.
  useEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      const up = below < 260 && r.top > below;
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 300) - 8)), width: Math.max(r.width, 300),
        top: up ? null : r.bottom + 4, bottom: up ? window.innerHeight - r.top + 4 : null, max: Math.max(160, Math.min(360, (up ? r.top : below) - 16)) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);

  // The list: [{ type: 'head', label } | { type: 'cat', c } | { type: 'move', m } | { type: 'clear' } | { type: 'new' }]
  const items = useMemo(() => {
    if (!open) return [];
    const q = query.trim();
    const out = [];
    const kindOrder = preferKind === 'income' ? ['income', 'expense'] : ['expense', 'income'];
    if (!q) {
      if (moves.length) { out.push({ type: 'head', label: 'Not income or spending' }); for (const m of moves) out.push({ type: 'move', m }); }
      const seen = new Set();
      const sugg = [];
      const add = (cid) => {
        const c = known.find((x) => x.id === cid);
        if (c && !seen.has(c.id)) { seen.add(c.id); sugg.push(c); }
      };
      if (hints) {
        for (const cid of (payeeId && hints.by_payee?.[payeeId]) || []) add(cid);
        for (const cid of hints.most_used?.[preferKind === 'income' ? 'income' : 'expense'] || []) if (sugg.length < 8) add(cid);
      }
      if (sugg.length) { out.push({ type: 'head', label: payeeId && hints?.by_payee?.[payeeId] ? 'This payee before, then most used' : 'Most used' }); for (const c of sugg) out.push({ type: 'cat', c }); }
      if (value) out.push({ type: 'clear' });
      for (const k of kindOrder) {
        const list = known.filter((c) => kindOf(c) === k);
        if (list.length) { out.push({ type: 'head', label: k === 'income' ? 'All income' : 'All expenses' }); for (const c of list) out.push({ type: 'cat', c }); }
      }
    } else {
      const ms = moves.filter((m) => words(m.label).length && score({ name: m.label, full_name: `${m.label} ${m.hint || ''}` }, q) >= 0);
      if (ms.length) { out.push({ type: 'head', label: 'Not income or spending' }); for (const m of ms) out.push({ type: 'move', m }); }
      for (const k of kindOrder) {
        const list = known.map((c) => ({ c, s: kindOf(c) === k ? score(c, q) : -1 })).filter((x) => x.s >= 0)
          .sort((a, b) => b.s - a.s || (a.c.full_name || a.c.name).localeCompare(b.c.full_name || b.c.name));
        if (list.length) { out.push({ type: 'head', label: k === 'income' ? 'Income' : 'Expenses' }); for (const x of list) out.push({ type: 'cat', c: x.c }); }
      }
    }
    out.push({ type: 'new' });
    return out;
  }, [open, query, known, hints, payeeId, preferKind, moves, value]);
  const pickable = items.map((x, i) => (x.type === 'head' ? -1 : i)).filter((i) => i >= 0);

  useEffect(() => { setActive(pickable[0] ?? 0); }, [query, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const close = () => { setOpen(false); setQuery(''); };
  const choose = (it) => {
    if (!it) return;
    if (it.type === 'cat') onChange(String(it.c.id));
    else if (it.type === 'clear') onChange('');
    else if (it.type === 'move') onMove?.(it.m);
    else if (it.type === 'new') { setDialog({ name: query.trim() }); }
    close();
  };
  const step = (d) => {
    const at = pickable.indexOf(active);
    const next = pickable[Math.min(pickable.length - 1, Math.max(0, (at < 0 ? 0 : at) + d))];
    if (next != null) setActive(next);
  };
  const keyDown = (e) => {
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); step(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); return; }
      if (e.key === 'PageDown') { e.preventDefault(); step(8); return; }
      if (e.key === 'PageUp') { e.preventDefault(); step(-8); return; }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); choose(items[active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') { close(); return; }
      return;
    }
    if (!onKeyDown && (e.key === 'ArrowDown' || e.key === 'Enter')) { e.preventDefault(); setOpen(true); return; }
    if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); return; }
    onKeyDown?.(e);
  };

  return (
    <>
      <span className={`catpick${open ? ' open' : ''} ${className}`} style={style}>
        <input
          {...rest}
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && items[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          required={required}
          placeholder={open ? 'Type to search…' : emptyLabel}
          value={open ? query : label}
          title={label || undefined}
          onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
          onMouseDown={() => { if (!disabled && !open) setOpen(true); }}
          onKeyDown={keyDown}
          onBlur={close}
        />
        <svg className="catpick-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      {open && pos && createPortal(
        <ul className="catpick-list" id={listId} role="listbox" ref={listRef}
          style={{ left: pos.left, width: pos.width, top: pos.top ?? undefined, bottom: pos.bottom ?? undefined, maxHeight: pos.max }}
          onMouseDown={(e) => e.preventDefault()}>
          {items.map((it, i) => {
            if (it.type === 'head') return <li key={`h${i}`} className="catpick-head" role="presentation">{it.label}</li>;
            const k = `${it.type}${i}`;
            const props = { id: `${listId}-${i}`, 'data-i': i, role: 'option', 'aria-selected': i === active,
              className: `catpick-opt${i === active ? ' active' : ''}${it.type === 'move' ? ' move' : ''}${it.type === 'new' ? ' new' : ''}`,
              onMouseEnter: () => setActive(i), onClick: () => choose(it) };
            if (it.type === 'cat') {
              const parent = it.c.parent_name || ((it.c.full_name || '').includes(' › ') ? it.c.full_name.split(' › ')[0] : null);
              return <li key={k} {...props}><span>{it.c.name}</span>{parent && <span className="catpick-parent">{parent}</span>}</li>;
            }
            if (it.type === 'move') return <li key={k} {...props}><span>{it.m.label}</span>{it.m.hint && <span className="catpick-parent">{it.m.hint}</span>}</li>;
            if (it.type === 'clear') return <li key={k} {...props}><span className="catpick-muted">{emptyLabel}</span></li>;
            return <li key={k} {...props}><span>{query.trim() ? `+ New category "${query.trim()}"…` : '+ New category…'}</span></li>;
          })}
          {items.length === 1 && <li className="catpick-head" role="presentation">Nothing matches "{query.trim()}"</li>}
        </ul>,
        document.body,
      )}
      {dialog && createPortal(
        <NewCategoryDialog
          categories={categories}
          defaultKind={preferKind}
          initialName={dialog.name}
          onClose={() => setDialog(null)}
          onCreated={(c) => {
            setCreated(c);
            setDialog(null);
            onChange(String(c.id));
            window.dispatchEvent(new Event('categories-changed'));
          }}
        />,
        document.body,
      )}
    </>
  );
}

function NewCategoryDialog({ categories, defaultKind, initialName = '', onClose, onCreated }) {
  const [kind, setKind] = useState(defaultKind === 'income' ? 'income' : 'expense');
  const [name, setName] = useState(initialName);
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
