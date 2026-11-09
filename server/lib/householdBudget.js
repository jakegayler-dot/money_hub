// The household budget, category by category (Jake, Nov 1: "a month-month breakdown of budget — a budgeting system
// up to the standards of a proper financial advisor, editable by me or Sentinel — vs actual spend and where that money
// went"). It covers what isn't a bill or a loan payment (those are planned on their own dates).
//
//   The total each month is Cash Flow's household budget for that month (the room above the cash floor, lib/forecast.js;
//   the figure that stood at a past month's end, kept since Oct 2026; this month's for months before that).
//   It's split across the lines below by a standard household bracket (the shares a planner starts a family's
//   variable spending from). A line Jake or Sentinel sets keeps that amount from its month on, until changed again
//   (budget_lines); "back to the bracket" clears it from that month. Cash Flow spends the lines' total.
//   Each ledger category belongs to one line by its name (first match below; the rest is Other).
import { pool, getSetting } from '../db.js';
import { householdLines, categoryBuckets, discretionary } from './personal.js';
import { todayISO } from './dates.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');

// What's in the budget (Jake, Nov 9: "Money Hub already has a system for recurring bills and forecasted bills.
// Personal/discretionary is for everything that falls outside of this"): every household purchase except what the
// bills system covers — a payment linked to a bill or loan payment, or one to the payee of a recurring bill (by the
// payee, or the bill's name in the payee or description, for a cycle that wasn't linked). No guessing from category
// names: a category the bills don't cover is discretionary, and shows under its group.

// The standard bracket, in %. Each ledger category sits in the first group whose pattern its name matches (Other if none).
export const LINES = [
  { key: 'dining', label: 'Dining out', pct: 9, match: /restaurant|dining|eating out|take ?out|fast food|coffee|\bbars?\b|\bpubs?\b|alcohol|liquor|\bbeer|\bwine/ },
  { key: 'groceries', label: 'Groceries', pct: 38, match: /grocer|supermarket|costco|\bfood\b/ },
  { key: 'fuel', label: 'Fuel & vehicle', pct: 14, match: /fuel|\bgas\b|gasoline|vehicle|\bauto\b|\bcars?\b|truck|parking|transit|\btires?\b|oil change|car wash|\bsgi\b|registration/ },
  { key: 'kids', label: 'Kids', pct: 8, match: /\bkids?\b|child|daycare|school|\btoys?\b|baby|lessons|tuition/ },
  { key: 'health', label: 'Health & personal care', pct: 6, match: /health|medical|dental|pharma|prescri|\bdrugs?\b|personal care|beauty|\bhair|salon|\bspa\b|fitness|\bgym|crossfit|optical|massage|physio/ },
  { key: 'shopping', label: 'Clothing & shopping', pct: 8, match: /cloth|shoes|apparel|shopping|amazon|electronic|jewel/ },
  { key: 'subscriptions', label: 'Subscriptions', pct: 2, match: /subscri|streaming|netflix|spotify|software|\bai tools?\b|\bapps?\b|membership/ },
  { key: 'home', label: 'Household & home', pct: 6, match: /\bhome\b|house|furniture|hardware|\bpets?\b|cleaning|garden|\byard\b|repair|utilit|electric|power|energy|water|phone|internet|insurance/ },
  { key: 'fun', label: 'Entertainment & hobbies', pct: 4, match: /entertain|hobb|gaming|\bgames?\b|sport|golf|\bhunt|fishing|camping|concert|ticket|attraction|activit|movie|recreation|\bfun\b|\bbooks?\b/ },
  { key: 'travel', label: 'Travel', pct: 2, match: /travel|hotel|airbnb|air ?fare|flight|vacation|holiday|lodging/ },
  { key: 'gifts', label: 'Gifts & giving', pct: 2, match: /\bgifts?\b|donation|charit|church|tith/ },
  { key: 'other', label: 'Other', pct: 1, match: null },
];
export const LINE_KEYS = LINES.map((l) => l.key);
const squash = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** A bill's name as it shows on a payment: before any " - ", "(", "#" or "invoice", letters and digits only. */
export const billKey = (name) => squash(String(name || '').split(/\s[-–—]\s|\(|#|\binvoice\b/i)[0]);

/** The recurring bills' payees and names (pure input to coveredByBills). */
export async function billSources(db = pool) {
  const { rows } = await db.query(`SELECT name, payee_id FROM bills WHERE frequency <> 'one_time'`).catch(() => ({ rows: [] }));
  return { payees: new Set(rows.map((r) => r.payee_id).filter(Boolean)), keys: [...new Set(rows.map((r) => billKey(r.name)).filter((k) => k.length >= 4))] };
}
/** Is a line covered by the bills system? tx: transaction id → { payee_id, text } (payee name + description, squashed). */
export function coveredByBills(l, bills, tx = new Map()) {
  if (l.scheduled) return true;
  const t = tx.get(l.transaction_id);
  if (!t) return false;
  if (t.payee_id && bills.payees.has(t.payee_id)) return true;
  return bills.keys.some((k) => t.text.includes(k));
}
async function txInfo(lines) {
  const ids = [...new Set(lines.map((l) => l.transaction_id))];
  if (!ids.length) return new Map();
  const { rows } = await pool.query(`SELECT t.id, t.payee_id, COALESCE(p.name, '') AS payee, COALESCE(t.description, '') AS description
    FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id WHERE t.id = ANY($1)`, [ids]);
  return new Map(rows.map((r) => [r.id, { payee_id: r.payee_id, text: squash(`${r.payee} ${r.description}`) }]));
}
export const lineFor = (categoryName) => {
  const n = String(categoryName || '').toLowerCase();
  return (LINES.find((l) => l.match && l.match.test(n)) || LINES[LINES.length - 1]).key;
};

const ymOk = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));
const monthsOfYear = (y, last) => Array.from({ length: last }, (_, i) => `${y}-${pad(i + 1)}`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;

/** Every line's budget for month `key` (pure): set amounts from their month on, the rest the bracket's share of `total`. */
export function lineBudgets(total, overrides, key) {
  const out = LINES.map((l) => {
    const set = overrides.filter((o) => o.key === l.key && o.from_month <= key).sort((a, b) => (a.from_month < b.from_month ? 1 : -1))[0];
    const amount = set && set.amount != null ? Number(set.amount) : Math.round((total * l.pct) / 100);
    return { key: l.key, label: l.label, budget: amount, set: !!(set && set.amount != null), pct: l.pct };
  });
  // Whole dollars that still add to the bracket's part of the total: the rounding goes on the largest line not set.
  const free = out.filter((l) => !l.set);
  if (free.length) {
    const want = Math.round((total * free.reduce((a, l) => a + l.pct, 0)) / 100);
    const big = free.reduce((a, l) => (l.pct > a.pct ? l : a));
    big.budget += want - free.reduce((a, l) => a + l.budget, 0);
  }
  return out.map(({ pct, ...l }) => { void pct; return l; });
}

export async function loadOverrides(db = pool) {
  const { rows } = await db.query('SELECT key, from_month, amount FROM budget_lines ORDER BY from_month').catch(() => ({ rows: [] }));
  return rows.map((r) => ({ key: r.key, from_month: r.from_month, amount: r.amount == null ? null : Number(r.amount) }));
}

/** Cash Flow's household total for each month key: the one kept at that month's end, else today's. */
async function cashTotals(keys, today) {
  const kept = (await getSetting('household_budget_by_month', {})) || {};
  let now = kept[today.slice(0, 7)];
  if (now == null) {
    const { loadForecast } = await import('./forecast.js');
    now = (await loadForecast({ months: 12, today }).catch(() => null))?.personal?.per_month ?? 0;
  }
  return Object.fromEntries(keys.map((k) => [k, Number(kept[k] ?? now) || 0]));
}

/** The page: each month of the year to `month` (budget vs spent), and `month` line by line. who: both | jake | ashley. */
export async function budgetView({ month, who = 'both', today = todayISO() } = {}) {
  const cur = today.slice(0, 7);
  const sel = ymOk(month) && month <= cur ? month : cur;
  const year = Number(sel.slice(0, 4));
  const last = year < Number(cur.slice(0, 4)) ? 12 : Number(cur.slice(5, 7));
  const keys = monthsOfYear(year, last);
  const to = year < Number(cur.slice(0, 4)) ? `${year + 1}-01-01` : addDay(today);
  const [overrides, totals, cats] = await Promise.all([loadOverrides(), cashTotals(keys, today), categoryBuckets()]);
  const [{ spending }, bills] = await Promise.all([householdLines(`${year}-01-01`, to, cats), billSources()]);
  const tx = await txInfo(spending);
  const share = (l) => (who === 'jake' ? l.jake : who === 'ashley' ? l.ashley : l.amount);
  const spent = new Map(); // month → line → amount
  const byCat = new Map(); // the chosen month: line → category → amount
  for (const l of spending) {
    if (!discretionary(l) || coveredByBills(l, bills, tx)) continue;
    const v = share(l);
    if (Math.abs(v) < 0.005) continue;
    const m = spent.get(l.month) || new Map();
    const k = lineFor(l.category);
    m.set(k, (m.get(k) || 0) + v);
    spent.set(l.month, m);
    if (l.month === sel) {
      const c = byCat.get(k) || new Map();
      c.set(l.category, (c.get(l.category) || 0) + v);
      byCat.set(k, c);
    }
  }
  const months = keys.map((k) => {
    const lines = lineBudgets(totals[k], overrides, k);
    const s = spent.get(k) || new Map();
    return { month: k, label: monthLabel(k), current: k === cur, budget: lines.reduce((a, l) => a + l.budget, 0), spent: r2([...s.values()].reduce((a, v) => a + v, 0)) };
  });
  const s = spent.get(sel) || new Map();
  const lines = lineBudgets(totals[sel], overrides, sel).map((l) => ({
    ...l, spent: r2(s.get(l.key) || 0),
    categories: [...(byCat.get(l.key) || new Map())].map(([name, v]) => ({ name, spent: r2(v) })).sort((a, b) => b.spent - a.spent),
  }));
  return {
    month: sel, label: monthLabel(sel), who, today, cash_flow_total: totals[sel],
    months, lines, total: { budget: lines.reduce((a, l) => a + l.budget, 0), spent: r2(lines.reduce((a, l) => a + l.spent, 0)) },
  };
}

/** The transactions behind one line in one month, each with what the page needs to edit it. */
export async function lineEntries({ month, line, who = 'both', today = todayISO() }) {
  if (!ymOk(month)) throw Object.assign(new Error('month is YYYY-MM'), { status: 400 });
  if (!LINE_KEYS.includes(line)) throw Object.assign(new Error('Unknown budget line'), { status: 400 });
  const [y, m] = month.split('-').map(Number);
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  const cats = await categoryBuckets();
  const [{ spending }, bills] = await Promise.all([householdLines(`${month}-01`, end < addDay(today) ? end : addDay(today), cats), billSources()]);
  const tx = await txInfo(spending);
  const share = (l) => (who === 'jake' ? l.jake : who === 'ashley' ? l.ashley : l.amount);
  const mine = spending.filter((l) => discretionary(l) && !coveredByBills(l, bills, tx) && lineFor(l.category) === line && Math.abs(share(l)) >= 0.005);
  const ids = [...new Set(mine.map((l) => l.transaction_id))];
  if (!ids.length) return [];
  const { rows: txs } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, t.category_id, t.is_split, t.segment, t.is_segment_split,
            t.segment_grain_pct, t.segment_livestock_pct, t.segment_jake_pct, t.segment_ashley_pct, p.name AS payee
     FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id WHERE t.id = ANY($1)`, [ids]);
  const byId = new Map(txs.map((t) => [t.id, t]));
  const out = new Map();
  for (const l of mine) {
    const t = byId.get(l.transaction_id);
    if (!t) continue;
    const e = out.get(t.id) || {
      id: t.id, date: l.date, description: t.description || l.description || '', payee: t.payee || null,
      category_id: t.category_id, category: l.category, amount: 0, tx_amount: Number(t.amount),
      whose: whoseKey(t), split: !!t.is_split,
    };
    e.amount = r2(e.amount + share(l));
    out.set(t.id, e);
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
}

/** jake | ashley | both (50/50 between them) | untagged | mixed (shared with the farm, or another split). */
export function whoseKey(t) {
  if (t.is_segment_split) {
    const g = Number(t.segment_grain_pct) || 0; const c = Number(t.segment_livestock_pct) || 0;
    const j = Number(t.segment_jake_pct) || 0; const a = Number(t.segment_ashley_pct) || 0;
    if (g + c < 0.5 && Math.abs(j - 50) < 0.5 && Math.abs(a - 50) < 0.5) return 'both';
    return 'mixed';
  }
  if (t.segment === 'jake' || t.segment === 'ashley') return t.segment;
  return 'untagged';
}
/** The owner fields for a whose choice. */
export function ownerFor(whose) {
  if (whose === 'jake' || whose === 'ashley') return { segment: whose, is_segment_split: false };
  if (whose === 'both') return { is_segment_split: true, segment_grain_pct: 0, segment_livestock_pct: 0, segment_jake_pct: 50, segment_ashley_pct: 50 };
  return null;
}

/** Sets a line's budget from `from_month` on (amount null: back to the bracket's share). */
export async function setLine({ key, amount, from_month, set_by = 'jake' }, db = pool) {
  if (!LINE_KEYS.includes(key)) throw Object.assign(new Error(`Budget lines: ${LINE_KEYS.join(', ')}`), { status: 422 });
  const from = ymOk(from_month) ? from_month : todayISO().slice(0, 7);
  const v = amount === null || amount === '' || amount === undefined ? null : Number(amount);
  if (v != null && !(Number.isFinite(v) && v >= 0)) throw Object.assign(new Error('The budget is a dollar amount, zero or more.'), { status: 422 });
  await db.query(
    `INSERT INTO budget_lines (key, from_month, amount, set_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (key, from_month) DO UPDATE SET amount = EXCLUDED.amount, set_by = EXCLUDED.set_by, updated_at = now()`,
    [key, from, v == null ? null : Math.round(v), set_by]);
  // A later month set before this one would undo it from there: this change runs on, so those go.
  await db.query('DELETE FROM budget_lines WHERE key = $1 AND from_month > $2', [key, from]);
  return { key, from_month: from, amount: v == null ? null : Math.round(v) };
}

/** Cash Flow's household budget for a month once lines are set: the lines' total (pure). */
export const monthTotal = (perMonth, overrides, key) =>
  (overrides.length ? lineBudgets(perMonth, overrides, key).reduce((a, l) => a + l.budget, 0) : perMonth);

function addDay(d) { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); }
