// Quarter Section's crop plan in the forecast without counting anything twice (Jake, Oct 30: "skip what's already
// billed"). Its estimates (source quarter-section-plan, external_id plan:<year>:…) are the next crop year's sales,
// inputs and rent. What Money Hub already has for that crop year comes off:
//   costs   bills due from January 1 of the crop year to January 31 after it, by type from their category (rent,
//           fertilizer, seed, chemical; pasture rent and bales aren't crop rent); a cost type billed in full is gone.
//   sales   new-crop sale contracts (delivered or paid from August 1 of the crop year, not cancelled), by commodity:
//           a crop's planned sales shrink by what's already contracted.
import { pool } from '../db.js';
import { toISODate } from './dates.js';

// The database hands back DATE columns as Date objects: compare them as YYYY-MM-DD.
const ymd = (d) => (d ? String(d instanceof Date ? toISODate(d) : d).slice(0, 10) : '');

export const PLAN_SOURCE = 'quarter-section-plan';
const yearOf = (e) => Number(/^plan:(\d{4}):/.exec(e.external_id || '')?.[1]) || null;
export const costType = (category = '', name = '') => {
  const c = String(category);
  if (/rent/i.test(c) && !/pasture|bale/i.test(`${c} ${name}`)) return 'rent';
  if (/^fertili/i.test(c)) return 'fertilizer';
  if (/^seed/i.test(c)) return 'seed';
  if (/^chemical|herbicide|fungicide|insecticide|desiccant/i.test(c)) return 'chemical';
  return null;
};
const planType = (e) => /^plan:\d{4}:cost:(\w+)$/.exec(e.external_id || '')?.[1] || null;

/** From the bills and contracts already there: { amountOf(e) } giving each plan estimate's amount to use. */
export function netting(estimates, { bills = [], contracts = [] } = {}) {
  const plan = estimates.filter((e) => e.source === PLAN_SOURCE && yearOf(e));
  const billed = {}; // year|type → $
  const contracted = {}; // year|commodity → $
  const planned = {}; // year|commodity → planned sales $
  for (const e of plan) if (e.direction === 'inflow') { const k = `${yearOf(e)}|${e.commodity}`; planned[k] = (planned[k] || 0) + Number(e.amount); }
  const years = [...new Set(plan.map(yearOf))];
  for (const y of years) {
    for (const b of bills) {
      const due = ymd(b.due_date);
      if (due < `${y}-01-01` || due > `${y + 1}-01-31`) continue;
      const t = costType(b.category, b.name);
      if (t) billed[`${y}|${t}`] = (billed[`${y}|${t}`] || 0) + Number(b.amount || 0);
    }
    for (const c of contracts) {
      const when = ymd(c.delivery_date || c.expected_payment_date);
      if (!when || when < `${y}-08-01` || c.status === 'cancelled') continue;
      const k = Object.keys(planned).find((p) => p.startsWith(`${y}|`) && String(c.commodity || '').toLowerCase().includes(p.split('|')[1]));
      if (k) contracted[k] = (contracted[k] || 0) + Number(c.total_value || 0);
    }
  }
  return {
    billed, contracted,
    amountOf(e) {
      if (e.source !== PLAN_SOURCE || !yearOf(e)) return Number(e.amount);
      const y = yearOf(e);
      if (e.direction === 'outflow') { const t = planType(e); return Math.max(0, Number(e.amount) - (billed[`${y}|${t}`] || 0)); }
      const k = `${y}|${e.commodity}`;
      const share = planned[k] > 0 ? Math.max(0, 1 - (contracted[k] || 0) / planned[k]) : 1;
      return Number(e.amount) * share;
    },
  };
}

/** Loads what netting needs, only when there's a crop plan. */
export async function loadNetting(estimates) {
  if (!estimates.some((e) => e.source === PLAN_SOURCE)) return null;
  const years = [...new Set(estimates.filter((e) => e.source === PLAN_SOURCE).map(yearOf).filter(Boolean))];
  if (!years.length) return null;
  const lo = `${Math.min(...years)}-01-01`, hi = `${Math.max(...years) + 1}-01-31`;
  const [b, c] = await Promise.all([
    pool.query('SELECT name, category, amount, due_date FROM bills WHERE due_date BETWEEN $1 AND $2', [lo, hi]).catch(() => ({ rows: [] })),
    pool.query(`SELECT commodity, total_value, delivery_date, expected_payment_date, status::text AS status FROM sale_contracts WHERE status::text <> 'cancelled'`).catch(() => ({ rows: [] })),
  ]);
  return netting(estimates, { bills: b.rows, contracts: c.rows });
}
