// Personal spending in two buckets, for the household (Jake, Ashley and
// unassigned personal spending together):
//
//   essential      what life costs — forecast from what was actually spent,
//                  month by month (seasonal once there's a full year).
//   discretionary  a yearly limit that comes from the plan, not history:
//
//     farm profit this year (the projection on the Tax tab)
//     − income tax and CPP on it
//     + capital cost allowance (deducted in profit, but no cash left)
//     − capital purchases paid this year
//     − loan principal due this year (interest is already in profit / essentials)
//     + other household income received
//     − the reserve top-up to its target
//     − savings: a share of after-tax profit
//     − essentials for the year
//     = what's left for discretionary, never below 0, capped if a cap is set
//
// What's left of the limit is spread evenly over the months left in the
// year; the Cash Flow forecast spends exactly that, so it assumes the
// budget is kept. The household share of every line counts as paid (GST
// in), the same rule as Income & Expenses.
import { pool, getSetting } from '../db.js';
import { EARNING_COLUMNS, lineValue } from './earnings.js';
import { toISODate, todayISO } from './dates.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ym = (d) => toISODate(d).slice(0, 7);
const pad = (n) => String(n).padStart(2, '0');

// First match wins; anything unmatched is essential (a wrong "essential"
// only makes the budget tighter, never looser).
const DISCRETIONARY = /restaurant|dining|eating out|take ?out|fast food|coffee|\bbars?\b|liquor|alcohol|\bbeer|\bwine|entertain|recreation|hobb|travel|vacation|holiday|hotel|\bgifts?\b|\btoys?\b|\bsport|golf|\bhunt|\bfishing|\bcamping|streaming|subscription|\bgym|fitness|crossfit|concert|\bevents?\b|ticket|activit|lessons|\bclubs?\b|shopping|electronic|gaming|\bgames\b|jewel|\bspa\b|beauty|\bpets?\b|\bboat|snowmobile|\batv\b|donation|charit/i;
const ESSENTIAL = /grocer|food|utilit|power|electric|natural gas|heat|water|sewer|phone|internet|insurance|mortgage|rent|property tax|tax|medical|health|dental|pharma|prescri|child ?care|daycare|school|tuition|vehicle|fuel|gasoline|auto|repair|maintenance|household|home|loan|interest|bank|fee|clothing|personal care|toiletr/i;

/** A category's bucket from its full name ("Food › Restaurants"), when none is set. */
export function guessBucket(fullName) {
  if (DISCRETIONARY.test(fullName || '')) return 'discretionary';
  if (ESSENTIAL.test(fullName || '')) return 'essential';
  return 'essential';
}

/** Every expense category with its bucket: set by hand, inherited from its parent, or guessed. */
export async function categoryBuckets(db = pool) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.parent_id, c.personal_bucket, p.name AS parent_name, p.personal_bucket AS parent_bucket
     FROM expense_categories c LEFT JOIN expense_categories p ON p.id = c.parent_id WHERE c.kind = 'expense' ORDER BY 1`);
  return rows.map((c) => {
    const full = c.parent_name ? `${c.parent_name} › ${c.name}` : c.name;
    const bucket = c.personal_bucket || c.parent_bucket || guessBucket(full);
    return { id: c.id, parent_id: c.parent_id, full, bucket, set: !!c.personal_bucket };
  });
}

/**
 * Household spending (positive) and income from `from` to `to`
 * (exclusive), as lines { date, month 'YYYY-MM', bucket, category, amount }.
 */
async function householdLines(from, to, buckets) {
  const byId = new Map(buckets.map((b) => [b.id, b]));
  const { rows: cats } = await pool.query('SELECT id, kind FROM expense_categories');
  const kindOf = new Map(cats.map((c) => [c.id, c.kind]));
  const { rows } = await pool.query(
    `SELECT ${EARNING_COLUMNS}, l.date, l.category_id
     FROM transaction_lines l JOIN transactions t ON t.id = l.transaction_id
     LEFT JOIN loan_payments lp ON lp.linked_transaction_id = l.transaction_id
     WHERE l.is_transfer = false AND (l.is_debt_service = false OR l.split_id IS NOT NULL)
       AND l.date >= $1 AND l.date < $2`, [from, to]);
  const spending = [];
  let income = 0;
  for (const l of rows) {
    if (l.is_capex) continue;
    const v = lineValue(l, 'household');
    if (Math.abs(v) < 0.005) continue;
    const kind = l.category_id ? kindOf.get(l.category_id) : (Number(l.amount) > 0 ? 'income' : 'expense');
    if (kind === 'income') { income += v; continue; }
    const b = l.category_id ? byId.get(l.category_id) : null;
    spending.push({ date: toISODate(l.date), month: ym(l.date), bucket: b ? b.bucket : 'essential', category: b ? b.full : 'Uncategorized', amount: -v });
  }
  return { spending, income: r2(income) };
}

/** Months 'YYYY-MM' from a to b inclusive. */
function monthsBetween(a, b) {
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  while (y < by || (y === by && m <= bm)) { out.push(`${y}-${pad(m)}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
const shiftMonth = (key, n) => { let [y, m] = key.split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${pad(m)}`; };

/**
 * What essentials cost per calendar month going forward: the same month
 * last year once there's a full year of history, otherwise the average
 * of the complete months on file. { estimate(monthKey), basis, months }.
 */
export async function essentialsModel(today = todayISO(), buckets = null) {
  const cats = buckets || await categoryBuckets();
  const { rows: [first] } = await pool.query('SELECT MIN(date) AS d FROM transactions');
  const thisMonth = ym(today);
  const lastFull = shiftMonth(thisMonth, -1);
  const yearAgo = shiftMonth(thisMonth, -12);
  const startKey = first?.d ? ym(first.d) : thisMonth;
  // The first month on file is usually partial: complete months start after it.
  const from = [shiftMonth(startKey, 1), yearAgo].sort().pop();
  const { spending } = await householdLines(`${from}-01`, `${thisMonth}-01`, cats);
  const byMonth = new Map(monthsBetween(from, lastFull).map((k) => [k, 0]));
  for (const l of spending) if (l.bucket === 'essential' && byMonth.has(l.month)) byMonth.set(l.month, byMonth.get(l.month) + l.amount);
  // A month with no essential spending at all is a gap in the records, not a free month.
  const months = [...byMonth].filter(([k, v]) => k <= lastFull && v > 0.005);
  const full = months.length >= 12;
  const avg = months.length ? months.reduce((s, [, v]) => s + v, 0) / months.length : 0;
  return {
    basis: full ? 'same month last year' : months.length ? `average of the ${months.length} month${months.length === 1 ? '' : 's'} on file` : 'no history yet',
    months: months.map(([k, v]) => ({ month: k, amount: r2(v) })),
    estimate: (key) => {
      const ly = byMonth.get(shiftMonth(key, -12));
      return r2(full && ly > 0.005 ? ly : avg);
    },
  };
}

/** The year's plan: the steps from profit to the discretionary limit, and how the year is going. */
export async function personalPlan(year, { tax = null, today = todayISO() } = {}) {
  const { farmIncomeTax, reserveStatus } = await loadDeps();
  const cats = await categoryBuckets();
  const [taxRes, savingsPct, capSetting, reserve, ess] = await Promise.all([
    tax ? Promise.resolve(tax) : farmIncomeTax(year).catch(() => null),
    getSetting('personal_savings_pct', 20),
    getSetting('personal_discretionary_cap', null),
    reserveStatus(year).catch(() => null),
    essentialsModel(today, cats),
  ]);
  const yStart = `${year}-01-01`;
  const yEnd = `${year + 1}-01-01`;
  const { spending, income: householdIncome } = await householdLines(yStart, today < yEnd ? addDay(today) : yEnd, cats);
  const { rows: [pr] } = await pool.query(
    `SELECT COALESCE(SUM(principal_amount), 0) AS p FROM loan_payments
     WHERE NOT is_adjustment AND COALESCE(paid_date, due_date) >= $1 AND COALESCE(paid_date, due_date) < $2`, [yStart, yEnd]);

  const basis = taxRes ? (taxRes.scenario || taxRes.projected) : null;
  const profit = basis ? Number(basis.net_income) : 0;
  const incomeTax = basis ? Number(basis.tax.total) : 0;
  const cca = basis ? Number(basis.cca || 0) : 0;
  const capex = taxRes ? Number(taxRes.actual.capex || 0) : 0;
  const principal = Number(pr.p);
  const reserveTopUp = reserve ? Math.max(0, Number(reserve.target) - Number(reserve.currentReserve)) : 0;
  const afterTax = profit - incomeTax;
  const pct = Number(savingsPct) || 0;
  const savings = Math.max(0, afterTax) * pct / 100;

  // Essentials: spent so far, plus the forecast for each month left (this month: whichever is more).
  const curKey = ym(today);
  const monthKeys = Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}`);
  const spentBy = (bucket) => {
    const m = new Map(monthKeys.map((k) => [k, 0]));
    for (const l of spending) if (l.bucket === bucket && m.has(l.month)) m.set(l.month, m.get(l.month) + l.amount);
    return m;
  };
  const essSpent = spentBy('essential');
  const discSpent = spentBy('discretionary');
  let essentials = 0;
  for (const k of monthKeys) {
    if (k < curKey) essentials += essSpent.get(k);
    else if (k === curKey) essentials += Math.max(essSpent.get(k), ess.estimate(k));
    else essentials += ess.estimate(k);
  }

  const before = afterTax + cca - capex - principal + householdIncome - reserveTopUp - savings - essentials;
  const cap = capSetting == null || capSetting === '' ? null : Number(capSetting);
  const limit = Math.max(0, cap != null ? Math.min(before, cap) : before);
  const spentYTD = [...discSpent.values()].reduce((s, v) => s + v, 0);
  const monthsLeft = year === Number(curKey.slice(0, 4)) ? 13 - Number(curKey.slice(5, 7)) : year > Number(curKey.slice(0, 4)) ? 12 : 0;
  const remaining = limit - spentYTD;
  const perMonth = monthsLeft ? Math.max(0, remaining) / monthsLeft : 0;

  const steps = [
    { key: 'profit', label: 'Farm profit this year (projected)', amount: profit },
    { key: 'tax', label: 'Income tax and CPP', amount: -incomeTax },
    { key: 'cca', label: 'Add back capital cost allowance (no cash leaves)', amount: cca },
    { key: 'capex', label: 'Capital purchases paid this year', amount: -capex },
    { key: 'principal', label: 'Loan principal this year', amount: -principal },
    { key: 'income', label: 'Other household income received', amount: householdIncome },
    { key: 'reserve', label: 'Top up the reserve to its target', amount: -reserveTopUp },
    { key: 'savings', label: `Savings — ${pct}% of after-tax profit`, amount: -savings },
    { key: 'essentials', label: 'Essentials for the year', amount: -essentials },
  ].map((s) => ({ ...s, amount: r2(s.amount) })).filter((s) => Math.abs(s.amount) >= 0.005 || ['profit', 'tax', 'savings', 'essentials'].includes(s.key));

  return {
    year, as_of: today, tax_available: !!basis,
    steps, before_cap: r2(before), cap, limit: r2(limit), capped: cap != null && before > cap,
    savings_pct: pct, savings: r2(savings),
    discretionary: {
      spent: r2(spentYTD), remaining: r2(remaining), months_left: monthsLeft, per_month: r2(perMonth),
      over: remaining < -0.005,
    },
    essentials: { year: r2(essentials), basis: ess.basis, history: ess.months },
    months: monthKeys.map((k) => ({
      month: k,
      essential: r2(essSpent.get(k)), essential_estimate: k >= curKey ? ess.estimate(k) : null,
      discretionary: r2(discSpent.get(k)),
      discretionary_budget: k < curKey ? null : r2(perMonth),
    })),
    // Each category with what the household spent in it this year, most first.
    categories: (() => {
      const spent = new Map();
      for (const l of spending) spent.set(l.category, (spent.get(l.category) || 0) + l.amount);
      return cats.map((c) => ({ ...c, spent: r2(spent.get(c.full) || 0) })).sort((a, b) => b.spent - a.spent || a.full.localeCompare(b.full));
    })(),
    uncategorized: r2(spending.filter((l) => l.category === 'Uncategorized').reduce((t, l) => t + l.amount, 0)),
  };
}

const addDay = (d) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

// Loaded late: tax.js and calculations.js pull in the forecast, which uses this file.
async function loadDeps() {
  const [{ farmIncomeTax }, { reserveStatus }] = await Promise.all([import('./tax.js'), import('./calculations.js')]);
  return { farmIncomeTax, reserveStatus };
}

/**
 * Cash Flow flows for personal spending, month by month over the window:
 * essentials at the history estimate less what's already in the forecast
 * for the household that month (personal bills, loan interest, fees,
 * personal estimates), and discretionary at the budget. All estimates.
 * `known(monthKey)` → household outflow already forecast that month.
 */
export async function personalFlows({ meta, today, tax, known }) {
  const plan = await personalPlan(Number(today.slice(0, 4)), { tax, today });
  const ess = await essentialsModel(today);
  const curKey = ym(today);
  const thisYear = Number(curKey.slice(0, 4));
  const spentThisMonth = plan.months.find((m) => m.month === curKey) || { essential: 0 };
  const out = [];
  for (const m of meta) {
    const key = `${m.year}-${pad(m.month)}`;
    if (key < curKey) continue;
    const date = key === curKey ? today : `${key}-15`;
    let essential = ess.estimate(key) - known(key);
    if (key === curKey) essential -= spentThisMonth.essential; // already spent this month is in the bank balance
    // This year: what's left of the limit, spread over the months left (this month's spending is already out of it).
    // Next year: this year's limit a month at a time, until next year's plan takes over.
    const disc = m.year === thisYear ? plan.discretionary.per_month : plan.limit / 12;
    if (essential > 0.5) out.push({ key: `personal:ess:${key}`, kind: 'personal', label: 'Personal essentials (from what you spend)', date, amount: -r2(essential), farm: 0, estimate: true, ref: { bucket: 'essential' } });
    if (disc > 0.5) out.push({ key: `personal:disc:${key}`, kind: 'personal', label: 'Discretionary budget', date, amount: -r2(disc), farm: 0, estimate: true, ref: { bucket: 'discretionary' } });
  }
  return { flows: out, plan };
}
