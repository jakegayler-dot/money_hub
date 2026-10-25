// Chart colours for the app's dark panels (#0d1117): eight categorical hues
// in a fixed order, validated for colour-blind separation, a normal-vision
// floor and 3:1 contrast against the panel (dataviz validate_palette.js,
// all checks pass). A ninth series is never a new hue: it folds into
// "Other", a neutral gray.
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const OTHER = '#5b6270';
// Fourteen, for a chart that shows every category over a share (Personal spending: everything at 3% or
// more, Jake Oct 24). The first eight as above; the next six chosen and ordered so neighbours stay apart
// (validate_palette.js, dark, #0d1117: all checks pass, worst adjacent colour-blind ΔE 8.4).
export const SERIES_WIDE = [...SERIES, '#1c8fb0', '#b8742c', '#c25fa0', '#7b8f2a', '#4c6fd0', '#2f9a63'];

/**
 * Colours items (sorted biggest first) by position and folds everything
 * past `max` into one "Other" slice that carries the folded items in `rest`.
 */
export function foldSlices(items, { max = SERIES.length, minShare = 0, palette = SERIES, otherLabel = (n) => `${n} more` } = {}) {
  // With minShare, everything at or above that share of the total gets its own slice (up to the palette's size).
  const total = items.reduce((a, x) => a + x.amount, 0);
  const n = minShare
    ? Math.min(palette.length, items.filter((x) => total && x.amount / total >= minShare).length)
    : Math.min(max, palette.length);
  const top = items.slice(0, n).map((x, i) => ({ ...x, color: palette[i] }));
  const rest = items.slice(n);
  if (!rest.length) return top;
  return [...top, { key: '__rest', label: otherLabel(rest.length), amount: rest.reduce((a, s) => a + s.amount, 0), color: OTHER, rest }];
}
