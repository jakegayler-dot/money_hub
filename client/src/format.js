export function money(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    maximumFractionDigits: 0,
  }).format(n);
}

/** Per-unit prices keep their cents — $5.40/bu must not read as $5. */
export function unitPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency: 'CAD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function ratio(n) {
  if (n === null || n === undefined) return '—';
  return `${n.toFixed(2)}x`;
}

export function pct(n) {
  if (n === null || n === undefined) return '—';
  return `${(n * 100).toFixed(0)}%`;
}
