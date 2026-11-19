// Earnings dates for the covered-call desk (Jake, Nov 19: "factor in earnings for the stocks in the list ... ie. earnings report
// calendar"). Nasdaq's public earnings calendar (api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD; no key): every company
// reporting that day, before the open, after the close, or time not given. Read a weekday at a time from today to DAYS_AHEAD out,
// in the background (one request every PAUSE ms), kept a day and in settings so a restart doesn't read it all again. What the
// desk does with it: a stock reporting before its call expires is left out of the day's five (its call premium is the market
// pricing the report, and the shares can gap), and every row says when the next report is and whether the put covers it.
import { pool, getSetting } from '../../db.js';

const KEY = 'options_earnings_calendar';
const DAYS_AHEAD = 60;
const FRESH_MS = 20 * 3600e3;
const PAUSE = 400;
const URL_OF = (d) => `https://api.nasdaq.com/api/calendar/earnings?date=${d}`;
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9', origin: 'https://www.nasdaq.com', referer: 'https://www.nasdaq.com/',
};
const TIME = { 'time-pre-market': 'before the open', 'time-after-hours': 'after the close' };

const state = { days: null, running: null, error: null, at: 0 };
const nyDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
const plusDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekdays = (from, n) => { const out = []; for (let i = 0; i <= n; i++) { const d = plusDays(from, i); const w = new Date(`${d}T12:00:00Z`).getUTCDay(); if (w > 0 && w < 6) out.push(d); } return out; };

/** One day's reports: [[symbol, time], ...] (pure parse of Nasdaq's answer). */
export function parseDay(body) {
  return (body?.data?.rows || []).filter((r) => r && r.symbol).map((r) => [String(r.symbol).toUpperCase().trim(), TIME[r.time] || 'time not given']);
}

async function load() {
  if (state.days) return state.days;
  const v = await getSetting(KEY, null).catch(() => null);
  state.days = (v && typeof v === 'object' && v.days) || {};
  return state.days;
}

/** Read the days not read in the last FRESH_MS (in the background; one at a time). */
export function refresh({ fetchImpl = fetch, now = new Date(), pause = PAUSE } = {}) {
  if (state.running) return state.running;
  state.running = (async () => {
    const days = await load();
    const today = nyDate(now);
    for (const d of Object.keys(days)) if (d < today) delete days[d];
    let failed = 0; let lastError = null;
    for (const d of weekdays(today, DAYS_AHEAD)) {
      if (days[d] && now - new Date(days[d].at) < FRESH_MS) continue;
      try {
        const r = await fetchImpl(URL_OF(d), { headers: HEADERS, signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(`Nasdaq said ${r.status}`);
        days[d] = { at: new Date(now).toISOString(), rows: parseDay(await r.json()) };
      } catch (e) { failed += 1; lastError = e.message; }
      if (pause) await new Promise((res) => setTimeout(res, pause));
    }
    state.error = failed ? `${failed} day${failed === 1 ? '' : 's'} of the earnings calendar couldn't be read (${lastError})` : null;
    state.at = Date.now();
    await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [KEY, JSON.stringify({ days })]).catch(() => {});
  })().finally(() => { state.running = null; });
  return state.running;
}

/** symbol → { date, time } of its next report from today, as far as the calendar has been read. Starts a refresh when due. */
export async function nextEarnings({ now = new Date(), fetchImpl = fetch } = {}) {
  const days = await load();
  const today = nyDate(now);
  const stale = !weekdays(today, 5).every((d) => days[d] && now - new Date(days[d].at) < FRESH_MS);
  if (stale && !state.running) refresh({ fetchImpl, now }).catch((e) => { state.error = e.message; });
  const map = new Map();
  for (const d of Object.keys(days).filter((x) => x >= today).sort()) for (const [s, t] of days[d].rows) if (!map.has(s)) map.set(s, { date: d, time: t });
  const read = Object.keys(days).filter((x) => x >= today).sort();
  return { map, through: read.at(-1) || null, days_read: read.length, running: !!state.running, error: state.error };
}

/** Does a report fall inside an option's life? Before its expiry, or on it before the close (or at an unknown time). Pure. */
export function inside(e, expiry) {
  if (!e || !expiry) return false;
  return e.date < expiry || (e.date === expiry && e.time !== 'after the close');
}

export const _state = state; // tests
