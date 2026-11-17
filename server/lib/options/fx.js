// US dollars to Canadian for the covered-call desk (Jake, Nov 17: "I want to see outputs in cad"). The quotes, strikes and
// premiums are the market's, in US dollars; the money figures are shown in CAD at the Bank of Canada's daily rate (Valet API,
// series FXUSDCAD, no key; published each business day). Held 6 hours; the last good rate is kept in settings so a failed
// fetch still converts, and says how old the rate is.
import { pool, getSetting } from '../../db.js';

const URL = 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1';
const KEY = 'usd_cad_rate';
let held = null; // { at, fx }

/** From the Valet API's reply: { rate, date } or null. Pure. */
export function rateFrom(j) {
  const o = (j?.observations || []).at(-1);
  const rate = Number(o?.FXUSDCAD?.v);
  return Number.isFinite(rate) && rate > 0.5 && rate < 3 ? { rate, date: o.d } : null;
}

/** { rate, date, source } — CAD per US dollar. Null only if it has never been fetched. */
export async function usdCad({ fetchImpl = fetch } = {}) {
  if (held && Date.now() - held.at < 6 * 3600e3) return held.fx;
  try {
    const res = await fetchImpl(URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Bank of Canada ${res.status}`);
    const r = rateFrom(await res.json());
    if (!r) throw new Error('no rate in the reply');
    const fx = { ...r, source: 'Bank of Canada' };
    held = { at: Date.now(), fx };
    await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [KEY, JSON.stringify(fx)]).catch(() => {});
    return fx;
  } catch {
    const last = await getSetting(KEY, null).catch(() => null);
    if (last?.rate) { held = { at: Date.now() - 5 * 3600e3, fx: last }; return last; } // try again within the hour
    return null;
  }
}

export const _reset = () => { held = null; };
