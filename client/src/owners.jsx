// Shared owner (entity) definitions for every form and label in the app:
// Grain, Cattle, Jake, Ashley. The DB value for Cattle is 'livestock'.
// Legacy 'personal' rows display as Unassigned until retagged.

export const OWNER_LABELS = { grain: 'Grain', livestock: 'Cattle', jake: 'Jake', ashley: 'Ashley' };
export const OWNER_KEYS = Object.keys(OWNER_LABELS);
const PCT = {
  grain: 'segment_grain_pct', livestock: 'segment_livestock_pct',
  jake: 'segment_jake_pct', ashley: 'segment_ashley_pct',
};

export const emptyOwnerFields = {
  segment: 'grain', is_segment_split: false,
  segment_grain_pct: '', segment_livestock_pct: '', segment_jake_pct: '', segment_ashley_pct: '',
};

/** Pulls owner fields off a DB row into form state. */
export function ownerFieldsFrom(row = {}) {
  return {
    segment: OWNER_KEYS.includes(row.segment) ? row.segment : 'grain',
    is_segment_split: !!row.is_segment_split,
    segment_grain_pct: row.segment_grain_pct ?? '',
    segment_livestock_pct: row.segment_livestock_pct ?? '',
    segment_jake_pct: row.segment_jake_pct ?? '',
    segment_ashley_pct: row.segment_ashley_pct ?? '',
  };
}

/** Converts form state into the API payload for owner fields. */
export function ownerPayload(state) {
  const split = !!state.is_segment_split;
  const out = { segment: split ? null : state.segment, is_segment_split: split };
  for (const k of OWNER_KEYS) out[PCT[k]] = split ? Number(state[PCT[k]]) || 0 : null;
  return out;
}

export function ownerSummary(row) {
  if (row.is_segment_split) {
    const parts = OWNER_KEYS
      .filter((k) => Number(row[PCT[k]]))
      .map((k) => `${OWNER_LABELS[k]} ${Number(row[PCT[k]])}%`);
    return parts.join(' / ') || 'Split';
  }
  return OWNER_LABELS[row.segment] || 'Unassigned';
}

/** Pick one owner, or split by percentage across all four. */
export function OwnerFields({ state, setState, disabled = false, label = 'Belongs to' }) {
  const total = OWNER_KEYS.reduce((s, k) => s + (Number(state[PCT[k]]) || 0), 0);
  return (
    <>
      <div className="field">
        <label>
          <input
            type="checkbox" disabled={disabled}
            checked={!!state.is_segment_split}
            onChange={(e) => setState({ ...state, is_segment_split: e.target.checked })}
          />
          {' '}Split between owners
        </label>
      </div>
      {!state.is_segment_split ? (
        <div className="field">
          <label>{label}</label>
          <select disabled={disabled} value={state.segment || 'grain'} onChange={(e) => setState({ ...state, segment: e.target.value })}>
            {OWNER_KEYS.map((k) => <option key={k} value={k}>{OWNER_LABELS[k]}</option>)}
          </select>
        </div>
      ) : (
        <div className="field">
          <label>Split % (must total 100)</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            {OWNER_KEYS.map((k) => (
              <input
                key={k} type="number" step="0.1" disabled={disabled}
                placeholder={OWNER_LABELS[k]} title={OWNER_LABELS[k]}
                value={state[PCT[k]]}
                onChange={(e) => setState({ ...state, [PCT[k]]: e.target.value })}
              />
            ))}
          </div>
          <p style={{ fontSize: 11, color: Math.abs(total - 100) < 0.5 ? 'var(--text-muted)' : 'var(--negative)', margin: '4px 0 0' }}>
            Grain / Cattle / Jake / Ashley — total {total}%
          </p>
        </div>
      )}
    </>
  );
}
