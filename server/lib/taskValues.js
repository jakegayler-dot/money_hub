// What a task is worth (Jake, 2026-10-31: "pass the estimated economic value of the job too"): the money that
// rides on doing it on time — what's gained by doing it, or the penalty, interest or lost money of missing it.
// Sent to Sentinel with each Money Hub task (job.value_cents, job.value_basis, and a line in the notes).
// Only dates where the money can be worked out get one; the rest (SCIC dates, year-end, statements) don't.
//
//   GST return        a refund: the refund (it comes once it's filed); owing: CRA's late-filing penalty,
//                     1% of what's owing plus 0.25% a month — one month's worth
//   Tax instalment    instalment interest from Dec 31 to Apr 30 at CRA's rate on what's due
//   Tax balance       a month's interest at CRA's rate on what's owing
//   T1 filing         the 5% late-filing penalty on the balance owing (plus 1% a month after)
//   AgriInvest/       the government's matching contribution for that program year (1% of allowable net
//   AgriStability     sales, lib/agriInvest.js) — lost if the forms or the deposit miss the final date
//   Rebate claim      the rebate expected
//   Gift card         what's left on it
import { pool, getSetting } from '../db.js';
import { ACTUAL_SQL, MATCH_PCT, ANS_CAP, MIN_ANS } from './agriInvest.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const $ = (n) => `$${Math.round(n).toLocaleString('en-CA')}`;

/** The AgriInvest match for a program year: from the ledger once the year is over, else the forecast's. */
export async function agriInvestMatches(years, { forecastFlows = null } = {}) {
  const out = {};
  const ys = [...new Set(years)].filter(Boolean);
  if (!ys.length) return out;
  const lo = Math.min(...ys); const hi = Math.max(...ys);
  const { rows } = await pool.query(ACTUAL_SQL, [`${lo}-01-01`, `${hi + 1}-01-01`]).catch(() => ({ rows: [] }));
  const thisYear = new Date().getUTCFullYear();
  for (const y of ys) {
    const f = (forecastFlows || []).find((x) => x.ref?.program === 'agriinvest' && Number(x.ref.program_year) === y);
    if (f) { out[y] = { amount: r2(f.amount), ans: f.ref.ans }; continue; }
    if (y >= thisYear) continue; // not over yet and nothing forecast
    const a = rows.find((r) => Number(r.year) === y);
    const ans = a ? Number(a.sales) - Number(a.purchases) : 0;
    if (ans >= MIN_ANS) out[y] = { amount: r2(Math.min(ans, ANS_CAP) * MATCH_PCT), ans: Math.round(ans) };
  }
  return out;
}

/** Value for each task (pure given what it needs — exported for tests). Sets i.value and i.value_basis. */
export function valueTasks(items, { rate = 7, matches = {}, rebates = new Map(), cards = new Map() } = {}) {
  const r = Number(rate) / 100;
  const byId = new Map(items.map((i) => [String(i.id), i]));
  for (const i of items) {
    if (!i.task) continue;
    const id = String(i.id);
    let v = null; let basis = null;
    if (i.kind === 'gst') {
      if (i.amount != null && i.amount < 0) { v = -i.amount * 0.0125; basis = `CRA's late-filing penalty on ${$(-i.amount)} owing (1% plus 0.25% a month)`; }
      else if (i.amount > 0) { v = i.amount; basis = 'the refund, paid once the return is filed'; }
    } else if (id.startsWith('tax:inst:') && i.amount < 0) {
      v = -i.amount * r * (4 / 12); basis = `instalment interest to Apr 30 at CRA's ${rate}% on ${$(-i.amount)}`;
    } else if (id.startsWith('tax:bal:') && i.amount < 0) {
      v = -i.amount * r / 12; basis = `a month's interest at CRA's ${rate}% on ${$(-i.amount)} owing`;
    } else if (id.startsWith('tax:file:')) {
      const bal = byId.get(`tax:bal:${id.slice('tax:file:'.length)}`);
      if (bal?.amount < 0) { v = -bal.amount * 0.05; basis = `the 5% late-filing penalty on ${$(-bal.amount)} owing (then 1% a month)`; }
    } else if (/^deadline:(agri_forms|agri_forms_final|agriinvest_deposit):/.test(id)) {
      const y = Number(i.date.slice(0, 4)) - 1;
      const m = matches[y];
      if (m?.amount > 0) { v = m.amount; basis = `AgriInvest's government match for ${y} (1% of ${$(m.ans)} allowable net sales)`; }
    } else if (id.startsWith('rebate-claim:')) {
      const amt = rebates.get(Number(id.split(':')[1]));
      if (amt > 0) { v = amt; basis = 'the rebate, lost if it isn’t claimed'; }
    } else if (id.startsWith('giftcard:')) {
      const left = cards.get(Number(id.split(':')[1]));
      if (left > 0) { v = left; basis = 'what’s left on the card'; }
    }
    if (v != null && v >= 1) { i.value = r2(v); i.value_basis = basis; }
  }
  return items;
}

/** Loads what valueTasks needs and applies it. */
export async function attachValues(items, { forecastFlows = null } = {}) {
  const years = items.filter((i) => i.task && /^deadline:(agri_forms|agri_forms_final|agriinvest_deposit):/.test(String(i.id))).map((i) => Number(i.date.slice(0, 4)) - 1);
  const [matches, rate, { rows: rb }, { rows: gc }] = await Promise.all([
    agriInvestMatches(years, { forecastFlows }).catch(() => ({})),
    getSetting('cra_interest_rate_pct', 7),
    pool.query('SELECT id, amount, qualifying_spend, rate_pct FROM rebates').catch(() => ({ rows: [] })),
    pool.query(`SELECT g.id, g.value - COALESCE((SELECT SUM(amount) FROM gift_card_uses u WHERE u.card_id = g.id), 0) AS left FROM gift_cards g`).catch(() => ({ rows: [] })),
  ]);
  const rebates = new Map(rb.map((x) => [x.id, x.amount != null ? Number(x.amount) : x.qualifying_spend != null && x.rate_pct != null ? Number(x.qualifying_spend) * Number(x.rate_pct) / 100 : 0]));
  const cards = new Map(gc.map((x) => [x.id, Number(x.left)]));
  return valueTasks(items, { rate: Number(rate) || 7, matches, rebates, cards });
}
