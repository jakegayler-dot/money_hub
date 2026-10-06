import { OWNER_KEYS, OWNER_LABELS } from '../owners.jsx';
import CategorySelect from './CategorySelect.jsx';

export const cents = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : new Intl.NumberFormat('en-CA', {
  style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(Number(n)));

const PCT = { grain: 'segment_grain_pct', livestock: 'segment_livestock_pct', jake: 'segment_jake_pct', ashley: 'segment_ashley_pct' };
const SHORT = { grain: 'Grain', livestock: 'Cattle', jake: 'Jake', ashley: 'Ashley' };

export const newPiece = (segment = 'grain') => ({
  amount: '', category_id: '', segment, memo: '', is_transfer: false,
  is_segment_split: false, segment_grain_pct: '', segment_livestock_pct: '', segment_jake_pct: '', segment_ashley_pct: '',
});

/** A saved split piece as editor state (owner split and transfer flag included). */
export const pieceFrom = (p) => ({
  amount: String(Number(p.amount)), category_id: p.category_id ? String(p.category_id) : '',
  segment: p.segment || 'grain', memo: p.memo || '', is_transfer: !!p.is_transfer,
  is_segment_split: !!p.is_segment_split,
  segment_grain_pct: p.segment_grain_pct ?? '', segment_livestock_pct: p.segment_livestock_pct ?? '',
  segment_jake_pct: p.segment_jake_pct ?? '', segment_ashley_pct: p.segment_ashley_pct ?? '',
});

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
          <CategorySelect aria-label={`Piece ${i + 1} category`} categories={categories} value={p.category_id}
            preferKind={Number(p.amount || total) > 0 ? 'income' : 'expense'}
            onChange={(v) => set(i, { category_id: v })} />
          <select aria-label={`Piece ${i + 1} owner`} value={p.is_segment_split ? 'split' : p.segment}
            onChange={(e) => (e.target.value === 'split' ? set(i, { is_segment_split: true }) : set(i, { is_segment_split: false, segment: e.target.value }))}>
            {OWNER_KEYS.map((k) => <option key={k} value={k}>{OWNER_LABELS[k]}</option>)}
            <option value="split">Split between owners…</option>
          </select>
          <input placeholder="Note (optional)" aria-label={`Piece ${i + 1} note`} value={p.memo} onChange={(e) => set(i, { memo: e.target.value })} />
          <button type="button" className="small secondary" onClick={() => setPieces(pieces.filter((_, j) => j !== i))} aria-label={`Remove piece ${i + 1}`}>✕</button>
          {p.is_transfer && <span className="split-transfer" title="Money moving, not spending — e.g. a loan's principal">Transfer — not an expense</span>}
          {p.is_segment_split && (() => {
            const total = OWNER_KEYS.reduce((s2, k) => s2 + (Number(p[PCT[k]]) || 0), 0);
            return (
              <div className="split-owners">
                {OWNER_KEYS.map((k) => (
                  <label key={k}>{SHORT[k]}
                    <input type="number" min="0" max="100" step="1" inputMode="decimal" aria-label={`Piece ${i + 1} ${SHORT[k]} %`}
                      value={p[PCT[k]]} onChange={(e) => set(i, { [PCT[k]]: e.target.value })} />%
                  </label>
                ))}
                <span className={Math.abs(total - 100) < 0.5 ? 'split-ok' : 'split-off'}>{Math.abs(total - 100) < 0.5 ? '100%' : `${total}% of 100`}</span>
              </div>
            );
          })()}
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
export const piecesPayload = (pieces) => pieces.map((p) => {
  const split = !!p.is_segment_split;
  const out = {
    amount: Number(p.amount), category_id: p.category_id ? Number(p.category_id) : null,
    segment: split ? null : p.segment, is_segment_split: split, memo: p.memo || null, is_transfer: !!p.is_transfer,
  };
  for (const k of OWNER_KEYS) out[PCT[k]] = split ? Number(p[PCT[k]]) || 0 : null;
  return out;
});
