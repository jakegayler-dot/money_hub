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
// budget is kept.
//
// That profit-based plan is opt-in now (Jake, 2026-10-24: tax predictions
// are never factored in by default). By default ('actual') discretionary is
// what the household actually spends — the median of the last six full
// months — or a monthly budget you set; no profit, no tax. The household share of every line counts as paid (GST
// in), the same rule as Income & Expenses.
import { pool, getSetting } from '../db.js';
import { EARNING_COLUMNS, lineValue } from './earnings.js';
import { ownerWeights } from './segments.js';
import { toISODate, todayISO } from './dates.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); if (!a.length) return 0; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
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
  // Each line also says whether it paid a bill or a loan (`scheduled`): those are forecast on their
  // own dates, so the estimate of everything else leaves them out (Jake, Oct 24: an annual bill the
  // typical month never saw was being subtracted from it, dropping the month's groceries and fuel).
  const byId = new Map(buckets.map((b) => [b.id, b]));
  const { rows: cats } = await pool.query('SELECT id, kind FROM expense_categories');
  const kindOf = new Map(cats.map((c) => [c.id, c.kind]));
  const { rows } = await pool.query(
    `SELECT ${EARNING_COLUMNS}, l.date, l.category_id, l.transaction_id
     FROM transaction_lines l JOIN transactions t ON t.id = l.transaction_id
     LEFT JOIN loan_payments lp ON lp.linked_transaction_id = l.transaction_id
     WHERE l.is_transfer = false AND (l.is_debt_service = false OR l.split_id IS NOT NULL)
       AND l.date >= $1 AND l.date < $2`, [from, to]);
  const { rows: sched } = await pool.query(
    `SELECT linked_transaction_id AS id FROM bills WHERE linked_transaction_id IS NOT NULL
     UNION SELECT linked_transaction_id FROM loan_payments WHERE linked_transaction_id IS NOT NULL`);
  const scheduled = new Set(sched.map((r) => r.id));
  const spending = [];
  let income = 0;
  for (const l of rows) {
    if (l.is_capex) continue;
    const v = lineValue(l, 'household');
    if (Math.abs(v) < 0.005) continue;
    const kind = l.category_id ? kindOf.get(l.category_id) : (Number(l.amount) > 0 ? 'income' : 'expense');
    if (kind === 'income') { income += v; continue; }
    const b = l.category_id ? byId.get(l.category_id) : null;
    const w = ownerWeights(l);
    const wsum = (w.jake + w.ashley + w.unassigned) || 1;
    spending.push({ date: toISODate(l.date), month: ym(l.date), bucket: b ? b.bucket : 'essential', category: b ? b.full : 'Uncategorized',
      category_id: l.category_id || null, amount: -v, scheduled: scheduled.has(l.transaction_id),
      jake: -v * w.jake / wsum, ashley: -v * w.ashley / wsum });
  }
  return { spending, income: r2(income) };
}

/** Whose a line is, in words: "Jake", or the split — "Grain 70% · Jake 30%" — so a farm entry with a personal share shows. */
function whoseLabel(w) {
  if (w.jake >= 0.999) return 'Jake';
  if (w.ashley >= 0.999) return 'Ashley';
  const parts = [['grain', 'Grain'], ['livestock', 'Cattle'], ['jake', 'Jake'], ['ashley', 'Ashley'], ['unassigned', 'not tagged']]
    .filter(([k]) => w[k] > 0.001).map(([k, l]) => `${l} ${Math.round(w[k] * 100)}%`);
  return parts.length > 1 ? parts.join(' / ') : w.unassigned > 0.999 ? 'Not tagged' : parts[0] || 'Not tagged';
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
  const unscheduled = new Map(byMonth); // the same, without bill and loan payments
  for (const l of spending) {
    if (l.bucket !== 'essential' || !byMonth.has(l.month)) continue;
    byMonth.set(l.month, byMonth.get(l.month) + l.amount);
    if (!l.scheduled) unscheduled.set(l.month, unscheduled.get(l.month) + l.amount);
  }
  // A month with no essential spending at all is a gap in the records, not a free month — and so is one
  // with next to nothing in it (Jake, Oct 24: last November held $114 of stray entries from before his
  // records really started, and became this November's whole forecast). Under GAP of the typical month
  // is missing records, not a cheap month: left out of the median and never used as "last year".
  const GAP = 0.35;
  const nonzero = [...byMonth].filter(([k, v]) => k <= lastFull && v > 0.005);
  const mid = median(nonzero.map(([, v]) => v));
  const months = nonzero.filter(([, v]) => v >= GAP * mid);
  const full = months.length >= 12;
  // The typical month: the median, so one big month (a repair, a lump card payment) doesn't set the forecast.
  const avg = median(months.map(([, v]) => v));
  const kept = new Set(months.map(([k]) => k));
  const avgU = median([...unscheduled].filter(([k]) => kept.has(k)).map(([, v]) => v));
  return {
    basis: full ? 'same month last year' : months.length ? `the typical (median) month of the ${months.length} on file, weighted toward the same month last year where there is one` : 'no history yet',
    gaps: nonzero.filter(([, v]) => v < GAP * mid).map(([k]) => k), // months too thin to trust
    months: months.map(([k, v]) => ({ month: k, amount: r2(v) })),
    // The same month last year carries weight as history builds: all of it
    // with a full year, months/12 of it before that (the rest from the
    // average), so a seasonal month shows up as soon as it's been seen once.
    estimate: (key) => {
      const lyKey = shiftMonth(key, -12);
      const ly = byMonth.get(lyKey);
      if (!kept.has(lyKey)) return r2(avg);
      const w = full ? 1 : months.length / 12;
      return r2(w * ly + (1 - w) * avg);
    },
    // Everything except bills and loan payments, which the forecast adds on their own dates.
    unscheduled: (key) => {
      const lyKey = shiftMonth(key, -12);
      const ly = unscheduled.get(lyKey);
      if (!kept.has(lyKey)) return r2(avgU);
      const w = full ? 1 : months.length / 12;
      return r2(w * ly + (1 - w) * avgU);
    },
  };
}

/** The year's plan: the steps from profit to the discretionary limit, and how the year is going. */
export async function personalPlan(year, { tax = null, today = todayISO() } = {}) {
  const { farmIncomeTax, reserveStatus } = await loadDeps();
  const cats = await categoryBuckets();
  const mode = String(await getSetting('personal_budget_mode', 'actual')) === 'plan' ? 'plan' : 'actual';
  const monthSetting = await getSetting('personal_discretionary_month', null);
  const [taxRes, savingsPct, capSetting, reserve, ess] = await Promise.all([
    mode === 'plan' ? (tax ? Promise.resolve(tax) : farmIncomeTax(year).catch(() => null)) : Promise.resolve(null),
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
  const spentYTD = [...discSpent.values()].reduce((s, v) => s + v, 0);
  const monthsLeft = year === Number(curKey.slice(0, 4)) ? 13 - Number(curKey.slice(5, 7)) : year > Number(curKey.slice(0, 4)) ? 12 : 0;
  // Actual (the default): what's really spent on discretionary, the median of the last six full months
  // (a month with none counts as none), or the monthly budget you set.
  const disc6 = await discretionaryHistory(today, cats);
  const typicalDisc = median(disc6.map((m) => m.amount));
  const setMonth = monthSetting == null || monthSetting === '' ? null : Number(monthSetting);
  let limit;
  let perMonth;
  if (mode === 'actual') {
    perMonth = setMonth != null ? setMonth : typicalDisc;
    limit = spentYTD + perMonth * monthsLeft;
  } else {
    limit = Math.max(0, cap != null ? Math.min(before, cap) : before);
    perMonth = monthsLeft ? Math.max(0, limit - spentYTD) / monthsLeft : 0;
  }
  const remaining = limit - spentYTD;

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

  // Pace: the last two complete months against a month of the limit. Two
  // in a row more than 15% over means the budget isn't what's happening.
  // Actual mode warns only against a budget you set; the plan warns against its limit.
  const monthBudget = mode === 'actual' ? (setMonth ?? 0) : limit / 12;
  const lastTwo = monthKeys.filter((k) => k < curKey).slice(-2).map((k) => ({ month: k, spent: r2(discSpent.get(k)) }));
  const overBoth = lastTwo.length === 2 && monthBudget > 0 && lastTwo.every((m) => m.spent > monthBudget * 1.15);
  const pace = {
    budget_month: r2(monthBudget), last_two: lastTwo, over: overBoth,
    over_pct: overBoth ? Math.round(((lastTwo[0].spent + lastTwo[1].spent) / 2 / monthBudget - 1) * 100) : null,
    actual_month: lastTwo.length ? r2(lastTwo.reduce((t, m) => t + m.spent, 0) / lastTwo.length) : null,
  };

  return {
    mode, monthly_budget: setMonth, typical_discretionary: r2(typicalDisc), discretionary_history: disc6,
    year, as_of: today, tax_available: !!basis, pace,
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

/** Discretionary spending in each of the last six full months (0 where there was none). */
async function discretionaryHistory(today, cats) {
  const cur = ym(today);
  const from = shiftMonth(cur, -6);
  const { rows: [first] } = await pool.query('SELECT MIN(date) AS d FROM transactions');
  const start = first?.d ? shiftMonth(ym(first.d), 1) : cur; // the first month on file is usually partial
  const keys = monthsBetween(from > start ? from : start, shiftMonth(cur, -1));
  if (!keys.length) return [];
  const { spending } = await householdLines(`${keys[0]}-01`, `${cur}-01`, cats);
  const by = new Map(keys.map((k) => [k, 0]));
  // Bills filed under a discretionary category (a streaming subscription) are forecast as bills, not here.
  for (const l of spending) if (l.bucket === 'discretionary' && !l.scheduled && by.has(l.month)) by.set(l.month, by.get(l.month) + l.amount);
  return [...by].map(([month, amount]) => ({ month, amount: r2(amount) }));
}

const addDay = (d) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };

// Loaded late: tax.js and calculations.js pull in the forecast, which uses this file.
async function loadDeps() {
  const [{ farmIncomeTax }, { reserveStatus }] = await Promise.all([import('./tax.js'), import('./calculations.js')]);
  return { farmIncomeTax, reserveStatus };
}

/**
 * Cash Flow flows for personal spending, month by month over the window:
 * essentials from history without bill and loan payments (those are in the
 * forecast on their own dates, whatever their frequency), less what else is
 * already forecast for the household that month (card statements on cards
 * that aren't itemized, fees, personal estimates); discretionary at the
 * budget. All estimates.
 * `known(monthKey)` → household outflow already forecast that month.
 */
export async function personalFlows({ meta, today, tax, known }) {
  const plan = await personalPlan(Number(today.slice(0, 4)), { tax, today });
  const ess = await essentialsModel(today);
  const curKey = ym(today);
  const thisYear = Number(curKey.slice(0, 4));
  // Spent so far this month, apart from bills and loan payments (those come off their own forecast items).
  const { spending: cm } = await householdLines(`${curKey}-01`, addDay(today), await categoryBuckets());
  const spentThisMonth = { essential: 0, discretionary: 0 };
  for (const l of cm) if (!l.scheduled && l.month === curKey) spentThisMonth[l.bucket] += l.amount;
  const out = [];
  for (const m of meta) {
    const key = `${m.year}-${pad(m.month)}`;
    if (key < curKey) continue;
    const date = key === curKey ? today : `${key}-15`;
    let essential = ess.unscheduled(key) - known(key);
    if (key === curKey) essential -= spentThisMonth.essential; // already spent this month is in the bank balance
    // This year: what's left of the limit, spread over the months left (this month's spending is already out of it).
    // Next year: this year's limit a month at a time, until next year's plan takes over.
    let disc = m.year === thisYear || plan.mode === 'actual' ? plan.discretionary.per_month : plan.limit / 12;
    // This month: what's already been spent on discretionary is in the bank balance (and in the card's unbilled
    // charges), so only what's left of the month's amount is still to come.
    if (key === curKey && plan.mode === 'actual') disc = Math.max(0, disc - (spentThisMonth.discretionary || 0));
    if (essential > 0.5) out.push({ key: `personal:ess:${key}`, kind: 'personal', label: 'Personal essentials (from what you spend)', date, amount: -r2(essential), farm: 0, estimate: true, ref: { bucket: 'essential' } });
    if (disc > 0.5) out.push({ key: `personal:disc:${key}`, kind: 'personal', label: 'Discretionary budget', date, amount: -r2(disc), farm: 0, estimate: true, ref: { bucket: 'discretionary' } });
  }
  return { flows: out, plan };
}

/**
 * Where household spending went from `from` to `to` (exclusive): by main
 * category and subcategory (with the payees behind each), by person, by
 * bucket, plus the last 12 months by bucket and the months ahead as
 * forecast. The Personal page draws its charts from this.
 */
export async function spendingBreakdown({ from, to, today = todayISO() }) {
  const cats = await categoryBuckets();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const { rows: catRows } = await pool.query('SELECT c.id, c.name, c.kind, p.name AS parent FROM expense_categories c LEFT JOIN expense_categories p ON p.id = c.parent_id');
  const meta = new Map(catRows.map((c) => [c.id, c]));
  const { rows } = await pool.query(
    `SELECT ${EARNING_COLUMNS}, l.date, l.category_id, l.transaction_id, l.description AS line_description,
            p.name AS payee, t.description, t.account_id AS tx_account, t.credit_card_id AS tx_card,
            COALESCE(cc.name, a.name) AS paid_with
     FROM transaction_lines l JOIN transactions t ON t.id = l.transaction_id
     LEFT JOIN loan_payments lp ON lp.linked_transaction_id = l.transaction_id
     LEFT JOIN payees p ON p.id = t.payee_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     WHERE l.is_transfer = false AND (l.is_debt_service = false OR l.split_id IS NOT NULL) AND l.date >= $1 AND l.date < $2`, [from, to]);
  const groups = new Map();
  const people = { jake: 0, ashley: 0, unassigned: 0 };
  const buckets = { essential: 0, discretionary: 0 };
  let total = 0;
  for (const l of rows) {
    if (l.is_capex) continue;
    const v = -lineValue(l, 'household');
    if (Math.abs(v) < 0.005) continue;
    const m = l.category_id ? meta.get(l.category_id) : null;
    if (m?.kind === 'income' || (!m && v < 0)) continue; // money in isn't spending
    const cardPayment = !!(l.tx_account && l.tx_card);
    const parent = m ? (m.parent || m.name) : cardPayment ? 'Card payments (not itemized)' : 'Uncategorized';
    const child = m ? (m.parent ? m.name : m.name) : cardPayment ? 'Card payments (not itemized)' : 'Uncategorized';
    const bucket = l.category_id ? (byId.get(l.category_id)?.bucket || 'essential') : 'essential';
    const g = groups.get(parent) || { name: parent, amount: 0, essential: 0, discretionary: 0, children: new Map() };
    g.amount += v; g[bucket] += v;
    const c = g.children.get(child) || { name: child, amount: 0, count: 0, payees: new Map(), entries: [] };
    c.amount += v; c.count++;
    const who = l.payee || l.description || '(no payee)';
    c.payees.set(who, (c.payees.get(who) || 0) + v);
    g.children.set(child, c);
    groups.set(parent, g);
    const w = ownerWeights(l);
    const personal = w.jake + w.ashley + w.unassigned || 1;
    // The ledger entries behind the category (Jake, Oct 24: he could only find them by searching the ledger).
    const whose = whoseLabel(w);
    c.entries.push({ id: l.transaction_id, date: toISODate(l.date), description: l.line_description || l.description || '',
      payee: l.payee || null, paid_with: l.paid_with || null, amount: r2(v), whose, split: l.split_id != null });
    people.jake += v * (w.jake / personal); people.ashley += v * (w.ashley / personal); people.unassigned += v * (w.unassigned / personal);
    buckets[bucket] += v;
    total += v;
  }
  const categories = [...groups.values()].map((g) => ({
    name: g.name, amount: r2(g.amount), essential: r2(g.essential), discretionary: r2(g.discretionary),
    children: [...g.children.values()].map((c) => ({
      name: c.name, amount: r2(c.amount), count: c.count,
      entries: c.entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)),
      payees: [...c.payees].map(([name, amount]) => ({ name, amount: r2(amount) })).sort((a, b) => b.amount - a.amount).slice(0, 6),
    })).sort((a, b) => b.amount - a.amount),
  })).filter((g) => g.amount > 0.005).sort((a, b) => b.amount - a.amount);

  // The last 12 full months and this one, by bucket; then the months ahead as Cash Flow forecasts them.
  const cur = ym(today);
  const histFrom = shiftMonth(cur, -12);
  const { spending } = await householdLines(`${histFrom}-01`, addDay(today), cats);
  const hist = new Map(monthsBetween(histFrom, cur).map((k) => [k, { month: k, essential: 0, discretionary: 0 }]));
  for (const l of spending) { const h = hist.get(l.month); if (h) h[l.bucket] += l.amount; }
  const plan = await personalPlan(Number(cur.slice(0, 4)), { today });
  const ess = await essentialsModel(today, cats);
  const ahead = [1, 2, 3].map((n) => { const k = shiftMonth(cur, n); return { month: k, essential: ess.estimate(k), discretionary: plan.discretionary.per_month, forecast: true }; });
  return {
    from, to, total: r2(total), buckets: { essential: r2(buckets.essential), discretionary: r2(buckets.discretionary) },
    people: { jake: r2(people.jake), ashley: r2(people.ashley), unassigned: r2(people.unassigned) },
    categories,
    months: [...[...hist.values()].map((h) => ({ ...h, essential: r2(h.essential), discretionary: r2(h.discretionary), partial: h.month === cur })), ...ahead],
  };
}

/**
 * What the household typically spends by category, from the last `n` full
 * months, without bill and loan payments (forecast on their own dates):
 * { months, essential: [...], discretionary: [...], thisMonth: Map(category → spent) }.
 * Each category: { category, monthly, jake, ashley, untagged } — monthly
 * averages; jake/ashley/untagged split `monthly` by who spent it.
 */
export async function spendingMix(today = todayISO(), n = 6) {
  const cats = await categoryBuckets();
  const cur = ym(today);
  const { rows: [first] } = await pool.query('SELECT MIN(date) AS d FROM transactions');
  const start = first?.d ? shiftMonth(ym(first.d), 1) : cur;
  const from = [shiftMonth(cur, -n), start].sort().pop();
  const keys = from < cur ? monthsBetween(from, shiftMonth(cur, -1)) : [];
  const { spending } = await householdLines(`${keys[0] || cur}-01`, addDay(today), cats);
  const span = Math.max(1, keys.length);
  const groups = { essential: new Map(), discretionary: new Map() };
  const thisMonth = new Map();
  for (const l of spending) {
    if (l.scheduled) continue;
    if (l.month === cur) { if (l.bucket === 'discretionary') thisMonth.set(l.category, (thisMonth.get(l.category) || 0) + l.amount); continue; }
    if (!keys.includes(l.month)) continue;
    const g = groups[l.bucket];
    const c = g.get(l.category) || { category: l.category, category_ids: new Set(), total: 0, jake: 0, ashley: 0 };
    c.total += l.amount; c.jake += l.jake; c.ashley += l.ashley;
    if (l.category_id) c.category_ids.add(l.category_id);
    g.set(l.category, c);
  }
  const out = (g) => [...g.values()].map((c) => ({
    category: c.category, category_ids: [...c.category_ids], monthly: r2(c.total / span),
    jake: r2(c.jake / span), ashley: r2(c.ashley / span), untagged: r2((c.total - c.jake - c.ashley) / span),
  })).filter((c) => c.monthly > 0.5).sort((a, b) => b.monthly - a.monthly);
  return { months: keys.length, essential: out(groups.essential), discretionary: out(groups.discretionary), thisMonth };
}

/**
 * The ledger entries behind one category's household spending from `from`
 * to `to` (exclusive), newest first — what "Which spending is which" adds up
 * (Jake, Oct 24: the totals showed, the transactions didn't).
 */
export async function categoryEntries({ category_id, from, to }) {
  const { rows } = await pool.query(
    `SELECT ${EARNING_COLUMNS}, l.date, l.category_id, l.transaction_id, l.description AS line_description,
            p.name AS payee, t.description, COALESCE(cc.name, a.name) AS paid_with
     FROM transaction_lines l JOIN transactions t ON t.id = l.transaction_id
     LEFT JOIN loan_payments lp ON lp.linked_transaction_id = l.transaction_id
     LEFT JOIN payees p ON p.id = t.payee_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     WHERE l.is_transfer = false AND (l.is_debt_service = false OR l.split_id IS NOT NULL)
       AND l.category_id = $1 AND l.date >= $2 AND l.date < $3`, [category_id, from, to]);
  const out = [];
  for (const l of rows) {
    if (l.is_capex) continue;
    const v = -lineValue(l, 'household');
    if (Math.abs(v) < 0.005) continue;
    const w = ownerWeights(l);
    const whose = whoseLabel(w);
    out.push({ id: l.transaction_id, date: toISODate(l.date), description: l.line_description || l.description || '',
      payee: l.payee || null, paid_with: l.paid_with || null, amount: r2(v), whose, split: l.split_id != null });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
}
