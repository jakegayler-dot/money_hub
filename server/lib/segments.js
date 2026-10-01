// Owners ("entities"): every dollar in the app belongs to one of these, or
// is split across them by percentage — the same pattern as the mixed-use
// business/personal split. 'livestock' is displayed as "Cattle".
// 'personal' is a legacy value from before Jake/Ashley existed and is
// reported as Unassigned until retagged; it's never offered in the UI.
export const OWNERS = ['grain', 'livestock', 'jake', 'ashley'];
export const PCT_COLUMN = {
  grain: 'segment_grain_pct',
  livestock: 'segment_livestock_pct',
  jake: 'segment_jake_pct',
  ashley: 'segment_ashley_pct',
};

// Column list + value extractor, so every INSERT/UPDATE that carries
// segment tagging stays in lockstep with the schema.
export const SEGMENT_COLUMNS = [
  'segment', 'is_segment_split',
  'segment_grain_pct', 'segment_livestock_pct', 'segment_jake_pct', 'segment_ashley_pct',
];

/** Normalizes segment fields from a request body or DB row, in SEGMENT_COLUMNS order. */
export function segmentValues(src = {}) {
  const split = !!src.is_segment_split;
  const pct = (k) => (split && src[k] != null && src[k] !== '' ? Number(src[k]) : null);
  return [
    split ? null : (src.segment || null),
    split,
    pct('segment_grain_pct'),
    pct('segment_livestock_pct'),
    pct('segment_jake_pct'),
    pct('segment_ashley_pct'),
  ];
}

/**
 * Split percentages must add to 100 (half a percent rounding tolerance) —
 * otherwise per-owner totals wouldn't reconcile back to the real amount.
 * Returns an error string, or null if valid.
 */
export function validateSegment(src = {}) {
  if (src.is_segment_split) {
    const sum = OWNERS.reduce((s, o) => s + (Number(src[PCT_COLUMN[o]]) || 0), 0);
    if (Math.abs(sum - 100) > 0.5) return `Owner split must add up to 100% (currently ${sum}%).`;
  } else if (src.segment && ![...OWNERS, 'personal'].includes(src.segment)) {
    return `Unknown owner "${src.segment}".`;
  }
  return null;
}

/**
 * Fraction (0–1) of a row that belongs to each owner, plus 'unassigned'
 * for anything untagged or legacy-'personal'. Always sums to 1, which is
 * what makes the four owner views add up exactly to Combined.
 */
export function ownerWeights(row = {}) {
  const w = { grain: 0, livestock: 0, jake: 0, ashley: 0, unassigned: 0 };
  if (row.is_segment_split) {
    let assigned = 0;
    for (const o of OWNERS) {
      const f = (Number(row[PCT_COLUMN[o]]) || 0) / 100;
      w[o] = f;
      assigned += f;
    }
    w.unassigned = Math.max(0, 1 - assigned);
  } else if (row.segment && OWNERS.includes(row.segment)) {
    w[row.segment] = 1;
  } else {
    w.unassigned = 1;
  }
  return w;
}

/** Splits a dollar amount (as a positive number) across owners. */
export function allocateBySegment(amount, row) {
  const abs = Math.abs(Number(amount));
  const w = ownerWeights(row);
  const out = {};
  for (const k of Object.keys(w)) out[k] = abs * w[k];
  return out;
}

/** Personal owners post to the personal ledger; enterprises to business. */
export function ledgerForSegment(segment) {
  return segment === 'jake' || segment === 'ashley' || segment === 'personal' ? 'personal' : 'business';
}

/**
 * Fraction (0–1) of a row that is farm business: Grain + Cattle's share of
 * a percentage split; 1 for a Grain or Cattle row; 0 for Jake or Ashley;
 * otherwise whatever its ledger says. Used wherever a business-only figure
 * reads rows that can be split between farm and personal (bills, estimates).
 */
export function businessShare(row = {}) {
  if (row.is_segment_split) {
    return ((Number(row.segment_grain_pct) || 0) + (Number(row.segment_livestock_pct) || 0)) / 100;
  }
  if (row.segment === 'grain' || row.segment === 'livestock') return 1;
  if (row.segment === 'jake' || row.segment === 'ashley' || row.segment === 'personal') return 0;
  return row.ledger === 'personal' ? 0 : 1;
}
