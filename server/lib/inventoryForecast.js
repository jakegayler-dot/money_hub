// Uncontracted grain in the bins and market cattle on hand are money you
// expect to receive; this turns them into forecast inflows so the cash
// forecast sees them, not just the balance sheet.
//
// What's forecast: only the uncontracted part (contracted grain is already
// in the forecast as its contract, paid at delivery + 7 days or at the end
// of the delivery period), valued at the manager's price. Hay/straw and
// breeding cows are kept, not sold, so they're left out.
//
// When it sells, first match wins:
//   1. the item's own expected_sale_date, if its manager sent one
//   2. the date of the manager's estimate for the same crop (Quarter
//      Section dates its estimated, not-yet-sold grain; binned grain sells
//      on that same date)
//   3. the fallback "sold by" setting (month + day, next occurrence)
// A date already in the past doesn't count — the next rule applies. With no
// usable date at all, the item is left out and reported as undated.
//
// These count as estimates: in every "with estimates" figure, never in
// "committed only".

import { pool, getSetting } from '../db.js';
import { loadBalanceSheet, inventoryOwnerRow } from './balanceSheet.js';
import { activeEstimates } from './estimates.js';
import { toISODate, todayISO } from './dates.js';

export const FORECAST_CLASSES = ['crop', 'market_livestock'];
export const FALLBACK_KEY = 'inventory_sale_fallback'; // "MM-DD"

const pad = (n) => String(n).padStart(2, '0');

/** Next date on or after `today` that falls on month-day "MM-DD". */
export function nextMonthDay(mmdd, today = todayISO()) {
  if (!/^\d{2}-\d{2}$/.test(String(mmdd || ''))) return null;
  const [m, d] = mmdd.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const [y] = today.split('-').map(Number);
  const on = (year) => {
    const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
    return `${year}-${pad(m)}-${pad(Math.min(d, last))}`;
  };
  const thisYear = on(y);
  return thisYear >= today ? thisYear : on(y + 1);
}

const norm = (s) => String(s || '').toLowerCase().trim();

/** Estimate date for a commodity: matched on `commodity`, else the estimate's name containing it. */
function estimateDateFor(commodity, estimates, today) {
  const c = norm(commodity);
  if (!c) return null;
  const hits = estimates
    .filter((e) => e.direction === 'inflow')
    .filter((e) => (e.commodity ? norm(e.commodity) === c : new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(norm(e.name))))
    .map((e) => ({ date: toISODate(e.start_date), active: e.status === 'active', updated: new Date(e.updated_at || 0).getTime() }))
    .filter((e) => e.date >= today)
    // An active estimate beats a retired one (a crop's estimate is retired
    // once it's all harvested, but its date still says when it sells).
    .sort((a, b) => (b.active - a.active) || (b.updated - a.updated));
  return hits[0]?.date || null;
}

/**
 * Forecast sales from inventory. Returns { items, undated, fallback }:
 * items are estimate-shaped rows (direction, amount, start_date, owner
 * fields) plus `basis` saying where the date came from.
 */
export async function inventorySales() {
  const today = todayISO();
  const [sheet, { rows: estimates }, fallback] = await Promise.all([
    loadBalanceSheet(),
    pool.query(`SELECT name, commodity, direction, start_date, status, updated_at FROM cash_estimates`),
    getSetting(FALLBACK_KEY, null),
  ]);
  const fallbackDate = nextMonthDay(fallback, today);
  const items = [];
  const undated = [];
  for (const it of sheet.inventoryRows) {
    if (!FORECAST_CLASSES.includes(it.item_class)) continue;
    const value = Number(it.counted_value) || 0;
    if (value <= 0.005) continue;
    const own = it.expected_sale_date ? toISODate(it.expected_sale_date) : null;
    let date = null;
    let basis = null;
    if (own && own >= today) { date = own; basis = 'item'; }
    if (!date) {
      const est = estimateDateFor(it.commodity, estimates, today);
      if (est) { date = est; basis = 'crop estimate'; }
    }
    if (!date && fallbackDate) { date = fallbackDate; basis = 'fallback'; }
    const label = `${it.commodity}${it.location ? ` — ${it.location}` : ''} (in inventory)`;
    if (!date) { undated.push({ id: it.id, name: label, amount: Math.round(value * 100) / 100 }); continue; }
    items.push({
      id: `inv-${it.id}`, inventory_id: it.id, name: label, commodity: it.commodity,
      direction: 'inflow', amount: Math.round(value * 100) / 100, frequency: 'one_time',
      start_date: date, end_date: null, status: 'active', basis, source: it.source,
      ...inventoryOwnerRow(it), is_segment_split: false,
    });
  }
  return { items, undated, fallback: fallback || null, fallback_date: fallbackDate };
}

/** Everything the forecast treats as estimated: active estimates + inventory sales. */
export async function forecastEstimates() {
  const [est, inv] = await Promise.all([activeEstimates(), inventorySales()]);
  return [...est, ...inv.items];
}
