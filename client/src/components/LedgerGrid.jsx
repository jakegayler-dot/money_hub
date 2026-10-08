import { useRef, useState } from 'react';
import { OWNER_KEYS, OWNER_LABELS } from '../owners.jsx';
import { cents } from './SplitEditor.jsx';

/**
 * The ledger as a spreadsheet: every cell is a box you type in. A cell
 * saves when you leave it or press Enter; Enter (and ↓) moves to the same
 * column one row down, Shift+Enter (and ↑) one row up, Tab across, Esc
 * puts the cell back. Date, amount and account are locked where the bank
 * statement or a linked bill/loan/card payment fixes them; a split entry's
 * category and owner open the full editor.
 */
const COLS = ['date', 'account', 'description', 'payee', 'category', 'owner', 'amount', 'gst'];

export default function LedgerGrid({ rows: sortedRows, sort, onSort, accounts, cards, categories, payees, balance, onPatched, onOpen, onAttach, onDelete, attaching }) {
  const [status, setStatus] = useState({}); // id → 'saving' | 'saved' | error text
  const tableRef = useRef(null);
  // Rows keep their places while you type: an edited date or amount doesn't
  // make the row jump away under the cursor. The order refreshes when the
  // sort or the set of rows changes.
  const order = useRef({ sig: '', ids: [] });
  const sig = `${sort?.key}:${sort?.dir}|${sortedRows.map((t) => t.id).sort((a, b) => a - b).join(',')}`;
  if (order.current.sig !== sig) order.current = { sig, ids: sortedRows.map((t) => t.id) };
  const byId = new Map(sortedRows.map((t) => [t.id, t]));
  const rows = order.current.ids.map((id) => byId.get(id)).filter(Boolean);
  const Th = ({ k, label, num }) => (
    <th className={`sortable${num ? ' num' : ''}`} aria-sort={sort?.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(k)}>{label}<span className="sort-mark" aria-hidden="true">{sort?.key === k ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span></button>
    </th>
  );

  const focusCell = (row, col) => {
    const el = tableRef.current?.querySelector(`[data-r="${row}"][data-c="${col}"]`);
    if (el) { el.focus(); if (el.select) el.select(); }
  };
  const nav = (e, r, c) => {
    const tag = e.target.tagName;
    if (e.key === 'Enter' || (tag !== 'SELECT' && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
      e.preventDefault();
      e.target.blur(); // saves
      const up = e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey);
      focusCell(r + (up ? -1 : 1), c);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if ('defaultValue' in e.target && tag !== 'SELECT') e.target.value = e.target.defaultValue;
      e.target.dataset.cancel = '1';
      e.target.blur();
    }
  };

  // el: the cell that changed, put back to its old value if the save fails.
  const save = async (t, patch, local, el, old) => {
    setStatus((s) => ({ ...s, [t.id]: 'saving' }));
    let r; let d = {};
    try {
      r = await fetch(`/api/transactions/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      d = await r.json().catch(() => ({}));
    } catch { r = { ok: false, status: 'offline' }; }
    if (!r.ok) {
      setStatus((s) => ({ ...s, [t.id]: d.error || `Not saved (${r.status})` }));
      if (el && old !== undefined) el.value = old;
      return;
    }
    onPatched(t.id, { ...pick(d), ...local });
    setStatus((s) => ({ ...s, [t.id]: 'saved' }));
    setTimeout(() => setStatus((s) => (s[t.id] === 'saved' ? { ...s, [t.id]: undefined } : s)), 1200);
  };
  // Commit a text cell when it changed and wasn't cancelled.
  const commit = (e, t, make) => {
    const el = e.target;
    if (el.dataset.cancel) { delete el.dataset.cancel; return; }
    if (el.value === el.defaultValue) return;
    const out = make(el.value);
    if (out) save(t, out.patch, out.local, el, el.defaultValue); else el.value = el.defaultValue;
  };

  const catOptions = (kind) => {
    const list = [...categories].sort((a, b) => (a.full_name || a.name).localeCompare(b.full_name || b.name));
    const order = kind === 'income' ? ['income', 'expense'] : ['expense', 'income'];
    return order.map((k) => (
      <optgroup key={k} label={k === 'income' ? 'Income' : 'Expenses'}>
        {list.filter((c) => (c.kind || 'expense') === k).map((c) => <option key={c.id} value={c.id}>{c.full_name || c.name}</option>)}
      </optgroup>
    ));
  };

  return (
    <div className="ledger-grid-wrap">
      <datalist id="ledger-grid-payees">{payees.map((p) => <option key={p.id} value={p.name} />)}</datalist>
      <table className="ledger-grid" ref={tableRef} data-nostack="">
        <thead>
          <tr>
            <Th k="date" label="Date" /><Th k="account" label="Account" /><Th k="description" label="Description" /><th>Paid to / from</th><th>Category</th>
            <Th k="owner" label="Owner" /><Th k="amount" label="Amount" num /><th className="num">GST</th>{balance && <th className="num bal">{balance.kind === 'card' ? 'Owed after' : 'Balance'}</th>}<th aria-label="Row actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((t, r) => {
            const closed = !!t.in_closed_month;
            const moneyLocked = closed || !!t.source || !!t.pays || !!t.transfer_peer_id || !!(t.account_id && t.credit_card_id);
            const why = closed ? 'This month is closed on the Books tab'
              : t.source ? 'From a bank statement — date, amount and account are what the bank shows'
                : t.pays ? `Payment for ${t.pays} — change it from there` : t.transfer_peer_id ? 'One side of a paired transfer' : 'A card payment';
            const st = status[t.id];
            const amt = Number(t.amount);
            const own = t.is_segment_split ? 'split' : (t.segment || '');
            return (
              <tr key={t.id} className={`${closed ? 'closed' : ''}${st && st !== 'saving' && st !== 'saved' ? ' err' : ''}`}>
                <td>
                  <input key={`d${t.date}`} type="date" data-r={r} data-c={0} defaultValue={t.date?.slice(0, 10)} disabled={moneyLocked} title={moneyLocked ? why : undefined}
                    aria-label="Date" onKeyDown={(e) => nav(e, r, 0)}
                    onBlur={(e) => commit(e, t, (v) => (v ? { patch: { date: v }, local: { date: v } } : null))} />
                </td>
                <td>
                  {t.credit_card_id && !t.account_id ? (
                    <span className="grid-fixed" title="A card purchase stays on its card">{t.card_name} (card)</span>
                  ) : (
                    <select key={`a${t.account_id}`} data-r={r} data-c={1} defaultValue={t.account_id || ''} disabled={moneyLocked} title={moneyLocked ? why : undefined}
                      aria-label="Account" onKeyDown={(e) => nav(e, r, 1)}
                      onChange={(e) => save(t, { account_id: Number(e.target.value) }, { account_id: Number(e.target.value), account_name: accounts.find((a) => a.id === Number(e.target.value))?.name }, e.target, String(t.account_id || ''))}>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  )}
                </td>
                <td>
                  <input key={`s${t.description}`} data-r={r} data-c={2} defaultValue={t.description || ''} disabled={closed} aria-label="Description" onKeyDown={(e) => nav(e, r, 2)}
                    onBlur={(e) => commit(e, t, (v) => ({ patch: { description: v }, local: { description: v } }))} />
                </td>
                <td>
                  <input key={`p${t.payee_name}`} data-r={r} data-c={3} list="ledger-grid-payees" defaultValue={t.payee_name || ''} disabled={closed} aria-label="Paid to or from"
                    onKeyDown={(e) => nav(e, r, 3)}
                    onBlur={(e) => commit(e, t, (v) => {
                      const name = v.trim();
                      const known = payees.find((p) => p.name.toLowerCase() === name.toLowerCase());
                      return { patch: name ? (known ? { payee_id: known.id } : { payee: name }) : { payee_id: null }, local: { payee_name: known ? known.name : name || null } };
                    })} />
                </td>
                <td>
                  {t.is_split ? (
                    <button type="button" className="grid-split" data-r={r} data-c={4} onClick={() => onOpen(t)} onKeyDown={(e) => nav(e, r, 4)}>Split — {t.splits?.length || 2} piece{(t.splits?.length || 2) === 1 ? '' : 's'}</button>
                  ) : (
                    <select key={`c${t.category_id}`} data-r={r} data-c={4} defaultValue={t.category_id || ''} disabled={closed} aria-label="Category" onKeyDown={(e) => nav(e, r, 4)}
                      onChange={(e) => {
                        const id = e.target.value ? Number(e.target.value) : null;
                        const c = categories.find((x) => x.id === id);
                        save(t, { category_id: id }, { category_id: id, category_name: c ? c.name : null }, e.target, String(t.category_id || ''));
                      }}>
                      <option value="">—</option>
                      {catOptions(amt > 0 ? 'income' : 'expense')}
                    </select>
                  )}
                </td>
                <td>
                  {t.is_split ? <span className="grid-fixed">Split</span> : (
                    <select data-r={r} data-c={5} value={own} disabled={closed} aria-label="Owner" onKeyDown={(e) => nav(e, r, 5)}
                      onChange={(e) => (e.target.value === 'split' ? onOpen(t)
                        : save(t, { segment: e.target.value, is_segment_split: false }, { segment: e.target.value, is_segment_split: false }))}>
                      {own === '' && <option value="">—</option>}
                      {OWNER_KEYS.map((k) => <option key={k} value={k}>{OWNER_LABELS[k]}</option>)}
                      <option value="split">{t.is_segment_split ? 'Split %' : 'Split between owners…'}</option>
                    </select>
                  )}
                </td>
                <td className="num">
                  <input key={`m${t.amount}`} type="number" step="0.01" data-r={r} data-c={6} defaultValue={amt.toFixed(2)} disabled={moneyLocked || t.is_split}
                    title={moneyLocked ? why : t.is_split ? 'Split — change the pieces in the full editor' : undefined}
                    aria-label="Amount" className={amt < 0 ? 'out' : 'in'} onKeyDown={(e) => nav(e, r, 6)}
                    onBlur={(e) => commit(e, t, (v) => (Number(v) ? { patch: { amount: Number(v) }, local: { amount: Number(v) } } : null))} />
                </td>
                <td className="num">
                  <input key={`g${t.gst_amount}`} type="number" step="0.01" min="0" data-r={r} data-c={7} defaultValue={t.gst_amount == null ? '' : Number(t.gst_amount).toFixed(2)} disabled={closed}
                    placeholder="—" aria-label="GST" onKeyDown={(e) => nav(e, r, 7)}
                    onBlur={(e) => commit(e, t, (v) => ({ patch: { gst_amount: v === '' ? null : Number(v) }, local: { gst_amount: v === '' ? null : Number(v) } }))} />
                </td>
                {balance && <td className="num grid-bal">{t.running_balance == null ? '—' : cents(t.running_balance)}</td>}
                <td className="grid-actions">
                  {st === 'saving' ? <span className="grid-state">saving…</span>
                    : st === 'saved' ? <span className="grid-state ok">saved</span>
                      : st ? <span className="grid-state bad" title={st}>not saved</span> : null}
                  {t.needs_review && (
                    <button type="button" className="grid-dot" title={`${t.review_note || 'Needs review'} — click to mark reviewed`}
                      aria-label={`Mark ${t.description} reviewed`} onClick={() => save(t, { needs_review: false }, { needs_review: false, review_note: null })} />
                  )}
                  <button type="button" className="stmt-icon" title="Full editor (splits, links, transfer)" aria-label={`Open ${t.description} in the full editor`} onClick={() => onOpen(t)}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" /></svg>
                  </button>
                  {!closed && (
                    <>
                      <button type="button" className={`stmt-icon${(t.documents || []).length ? ' has-doc' : ''}`} disabled={attaching === t.id}
                        title={(t.documents || []).length ? `${t.documents.length} attached — add another` : 'Attach a photo or PDF'} aria-label={`Attach to ${t.description}`} onClick={() => onAttach(t)}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.5 4.5 5.4 9.6a1.9 1.9 0 0 0 2.7 2.7l5.4-5.4a3.2 3.2 0 0 0-4.5-4.5L3.4 8a4.4 4.4 0 0 0 6.3 6.3l4.1-4.1" /></svg>
                      </button>
                      <button type="button" className="stmt-icon grid-del" title="Delete" aria-label={`Delete ${t.description}`} onClick={() => onDelete(t)}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {Object.values(status).some((s) => s && s !== 'saving' && s !== 'saved') && (
        <p className="review-error grid-errors">
          {Object.entries(status).filter(([, s]) => s && s !== 'saving' && s !== 'saved').slice(0, 3).map(([id, s]) => <span key={id}>#{id}: {s} </span>)}
        </p>
      )}
    </div>
  );
}

const pick = (d) => {
  const out = {};
  for (const k of ['date', 'amount', 'description', 'category_id', 'segment', 'is_segment_split', 'gst_amount', 'account_id', 'payee_id', 'ledger', 'needs_review', 'review_note']) {
    if (d[k] !== undefined) out[k] = d[k];
  }
  if (out.date) out.date = String(out.date).slice(0, 10);
  return out;
};
