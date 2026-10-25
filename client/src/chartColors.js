// Chart colours for the app's dark panels (#0d1117): eight categorical hues
// in a fixed order, validated for colour-blind separation, a normal-vision
// floor and 3:1 contrast against the panel (dataviz validate_palette.js,
// all checks pass). A ninth series is never a new hue: it folds into
// "Other", a neutral gray.
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const OTHER = '#5b6270';

/**
 * Colours items (sorted biggest first) by position and folds everything
 * past `max` into one "Other" slice that carries the folded items in `rest`.
 */
export function foldSlices(items, { max = SERIES.length, otherLabel = (n) => `${n} more` } = {}) {
  const top = items.slice(0, max).map((x, i) => ({ ...x, color: SERIES[i % SERIES.length] }));
  const rest = items.slice(max);
  if (!rest.length) return top;
  return [...top, { key: '__rest', label: otherLabel(rest.length), amount: rest.reduce((a, s) => a + s.amount, 0), color: OTHER, rest }];
}
