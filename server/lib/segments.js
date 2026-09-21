// Shared by bills.js and transactions.js — both let a dollar amount be
// tagged to one enterprise (grain/livestock/personal) or split across all
// three by percentage, the same pattern as the existing is_mixed_use split.

/**
 * When splitting across enterprises, the three percentages must add to 100
 * (within a cent of rounding tolerance) — otherwise segment totals wouldn't
 * reconcile back to the actual amount spent. Returns an error string, or
 * null if the split (or non-split single segment) is valid.
 */
export function validateSegment({ segment, is_segment_split, segment_grain_pct, segment_livestock_pct, segment_personal_pct }) {
  if (is_segment_split) {
    const sum = (Number(segment_grain_pct) || 0) + (Number(segment_livestock_pct) || 0) + (Number(segment_personal_pct) || 0);
    if (Math.abs(sum - 100) > 0.5) {
      return `Segment split must add up to 100% (currently ${sum}%).`;
    }
  } else if (segment && !['grain', 'livestock', 'personal'].includes(segment)) {
    return `Unknown segment "${segment}".`;
  }
  return null;
}

/**
 * Splits a (positive) dollar amount across grain/livestock/personal per a
 * transaction's segment fields. A single segment gets the whole amount; a
 * split divides it by percentage; an untagged transaction is bucketed as
 * "unassigned" so totals are never silently short of the real spend.
 */
export function allocateBySegment(amount, row) {
  const abs = Math.abs(Number(amount));
  const result = { grain: 0, livestock: 0, personal: 0, unassigned: 0 };
  if (row.is_segment_split) {
    result.grain += abs * (Number(row.segment_grain_pct) || 0) / 100;
    result.livestock += abs * (Number(row.segment_livestock_pct) || 0) / 100;
    result.personal += abs * (Number(row.segment_personal_pct) || 0) / 100;
  } else if (row.segment) {
    result[row.segment] += abs;
  } else {
    result.unassigned += abs;
  }
  return result;
}
