import { OWNER_KEYS, OWNER_LABELS } from '../owners.jsx';

export const cents = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : new Intl.NumberFormat('en-CA', {
  style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(Number(n)));

export const newPiece = (segment = 'grain') => ({ amount: '', category_id: '', segment, memo: '' });

/**
 * Divides one transaction into pieces, each with its own amount, category
 * and owner — e.g. a $120 Costco run: $80 groceries (Jake), $40 shop
 * supplies (Grain). Amounts use the same sign as the total (negative for
 * spending); the pieces must add up to it.
 */
export default function SplitEditor({ pieces, setPieces, categories, total }) {
  const sum = pieces.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const left = Math.round(((Number(total) || 0) - sum) * 100) / 100;
  const set = (i, patch) => setPieces(pieces.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="split-editor">
      {pieces.map((p, i) => (
        <div className="split-row" key={i}>
          <input
            type="number" step="0.01" placeholder="Amount" aria-label={`Piece ${i + 1} amount`}
            value={p.amount} onChange={(e) => set(i, { amount: e.target.value })}
          />
          <select aria-label={`Piece ${i + 1} category`} value={p.category_id} onChange={(e) => set(i, { category_id: e.target.value })}>
            <option value="">No category</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.name}</option>)}
          </select>
          <select aria-label={`Piece ${i + 1} owner`} value={p.segment} onChange={(e) => set(i, { segment: e.target.value })}>
            {OWNER_KEYS.map((k) => <option key={k} value={k}>{OWNER_LABELS[k]}</option>)}
          </select>
          <input placeholder="Note (optional)" aria-label={`Piece ${i + 1} note`} value={p.memo} onChange={(e) => set(i, { memo: e.target.value })} />
          <button type="button" className="small secondary" onClick={() => setPieces(pieces.filter((_, j) => j !== i))} aria-label={`Remove piece ${i + 1}`}>✕</button>
        </div>
      ))}
      <div className="split-foot">
        <button type="button" className="small secondary" onClick={() => setPieces([...pieces, newPiece(pieces[pieces.length - 1]?.segment)])}>
          + Add piece
        </button>
        <span className={Math.abs(left) < 0.005 ? 'split-ok' : 'split-off'}>
          {Math.abs(left) < 0.005 ? 'Pieces add up' : `${cents(left)} not yet assigned`}
        </span>
      </div>
    </div>
  );
}

/** API payload for pieces. */
export const piecesPayload = (pieces) => pieces.map((p) => ({
  amount: Number(p.amount), category_id: p.category_id ? Number(p.category_id) : null,
  segment: p.segment, memo: p.memo || null,
}));
