// The options desk's shared helpers (pages/CoveredCalls.jsx, CoveredLive.jsx).
export const send = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; });
export const fmt = (pre, n, d) => (n == null || !Number.isFinite(Number(n)) ? '—'
  : `${Number(n) < 0 ? '−' : ''}${pre}${Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
// Money in CAD (Nov 17: "I want to see outputs in cad"): the desk's figures are the market's US dollars, turned into CAD at the
// Bank of Canada's daily rate (set by the page). Share prices, strikes and per-share premiums stay US$, as the broker shows them.
let FX = null;
export const setFx = (rate) => { FX = rate || null; };
export const getFx = () => FX;
export const usd = (n, d = 0) => fmt('US$', n, d);
export const cad = (n, d = 0) => (n == null || !Number.isFinite(Number(n)) ? '—' : FX ? fmt('$', Number(n) * FX, d) : fmt('US$', n, d));
export const plain = (n, d = 0) => fmt('$', n, d);
export const pctS = (n, d = 1) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}%`);
export const short = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' }) : '—');
export const day = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');
export const asOf = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Regina' }) : '');
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Regina' }) : '');
export const sign = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
export const signed = (n, f = cad) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${n > 0 ? '+' : ''}${f(n)}`);
export const nyToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
/** How old the option prices behind a figure are, in a few words. */
export const pricesWords = (o) => {
  if (!o) return '';
  if (o.error) return o.error;
  const at = o.quoted_at ? new Date(o.quoted_at).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Regina' }) : null;
  return `${o.modelled ? 'estimated at today’s stock price from' : 'as quoted'} ${at ? `option prices of ${at}` : 'the last option prices'}`;
};
