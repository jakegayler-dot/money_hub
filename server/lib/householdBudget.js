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
//   One budget for the whole sole proprietorship (Jake, Nov 15: "i just want all expenses included in the budget").
//   What's in it (Jake, Nov 16: "This category must include all that which is not already in cash flow forecast!" — Randy's
//   rent had landed on Other though the forecast already carries it, farm fuel was on Other, and the small capital buys at
//   RB Auction were missing): every purchase, the farm's share and the household's, capital ones included, LESS what the
//   cash flow forecast already plans (forecastWhy, plannedByEstimates): bills (paid by a linked payment, to a recurring
//   bill's payee or name, or lump sums on a vendor's account; but a one-off invoice entered within a week of being paid is
//   only the record of a purchase, not a planned bill: PLANNED_DAYS), loan payments, rent (projected from the landlords' rent bills)
//   and, for the farm and capital buys, an active estimate dated near it, up to the estimate's amount (a capital buy only by
//   a plan about its size). What's left out is listed on the page with why. A farm purchase sits on its own line by its category
//   (farm fuel on Fuel & vehicle), except lines that only fit a household (Household & home, Health, Kids): those, and
//   capital buys, are Other.
import { pool, getSetting } from '../db.js';
import { householdLines, categoryBuckets, discretionary } from './personal.js';
import { RENT_SQL } from './rentProjection.js';
import { occurrences } from './estimates.js';
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
  const named = rows.map((r) => ({ name: r.name, key: billKey(r.name), payee_id: r.payee_id }));
  return {
    payees: new Set(rows.map((r) => r.payee_id).filter(Boolean)), keys: [...new Set(named.map((r) => r.key).filter((k) => k.length >= 4))],
    names: { payee: new Map(named.filter((r) => r.payee_id).map((r) => [r.payee_id, r.name])), key: new Map(named.map((r) => [r.key, r.name])) },
  };
}
/** Which bill covers a line, in words (null: none). tx: transaction id → { payee_id, text } (payee name + description, squashed). */
export function billFor(l, bills, tx = new Map()) {
  const t = tx.get(l.transaction_id);
  if (l.scheduled && !invoiceBuy(l, t)) {
    if (t?.loan) return 'A loan payment';
    return t?.bill_name ? `Paid against the ${t.bill_name} bill${t.bill_one_time && t.bill_since ? ` (on the books since ${t.bill_since})` : ''}` : 'Paid against a bill or a loan payment';
  }
  if (!t) return null;
  if (t.payee_id && bills.payees.has(t.payee_id)) return `The ${bills.names?.payee.get(t.payee_id) || 'recurring'} bill`;
  const k = bills.keys.find((x) => t.text.includes(x));
  return k ? `The ${bills.names?.key.get(k) || 'recurring'} bill` : null;
}
/** How long a one-off bill must have been on the books before it was paid for the forecast to have planned it. */
export const PLANNED_DAYS = 7;
/**
 * A purchase paid against its own one-off invoice that the forecast never planned (Nov 16, the RB Auction buys: "Paid against
 * a bill"; Nov 17: "the rbauction items remain unaccounted for in the discretionary budget account and were not accounted for
 * in the forecast"): an invoice entered when it's paid, or within a week of it, is only the record of the purchase, so the
 * payment counts unless an estimate plans it. A one-off bill on the books a week or more ahead was in the forecast. Capital or
 * not: a bill paid from the Bills page makes a payment with no capital flag, which is how the auction buys kept dropping out.
 */
const invoiceBuy = (l, t) => !!(t?.bill_one_time && !t.loan && !(t.bill_lead >= PLANNED_DAYS));
/** Is a line covered by the bills system? */
export const coveredByBills = (l, bills, tx = new Map()) => !!billFor(l, bills, tx);
async function txInfo(lines) {
  const ids = [...new Set(lines.map((l) => l.transaction_id))];
  if (!ids.length) return new Map();
  // pays_bills: a lump sum paid on a vendor's account and applied to its invoices (the invoices are the forecast's bills).
  const { rows } = await pool.query(`SELECT t.id, t.payee_id, COALESCE(p.name, '') AS payee, COALESCE(t.description, '') AS description,
      (EXISTS (SELECT 1 FROM vendor_credits vc WHERE vc.transaction_id = t.id AND vc.status <> 'kept')
       OR EXISTS (SELECT 1 FROM vendor_on_account o WHERE o.transaction_id = t.id)) AS pays_bills,
      b.name AS bill_name, b.frequency::text AS bill_frequency, b.loan_id AS bill_loan,
      (t.date - b.created_at::date) AS bill_lead, to_char(b.created_at, 'YYYY-MM-DD') AS bill_since,
      EXISTS (SELECT 1 FROM loan_payments lp WHERE lp.linked_transaction_id = t.id) AS loan_paid,
      -- A lump sum on the vendor's account: a bill it was applied to (else, with nothing applied yet, one of the vendor's
      -- still owing then) that was on the books a week ahead, or recurs. None: the invoices were only records of the buys.
      COALESCE(
        (SELECT ab.name FROM vendor_credits vc JOIN credit_applications ca ON ca.credit_id = vc.id JOIN bills ab ON ab.id = ca.bill_id
          WHERE vc.transaction_id = t.id AND (ab.frequency <> 'one_time' OR ab.created_at::date <= t.date - ${PLANNED_DAYS}) ORDER BY ab.id LIMIT 1),
        (SELECT ob.name FROM bills ob WHERE ob.payee_id = t.payee_id AND t.payee_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM vendor_credits vc JOIN credit_applications ca ON ca.credit_id = vc.id WHERE vc.transaction_id = t.id)
            AND (ob.frequency <> 'one_time' OR ob.created_at::date <= t.date - ${PLANNED_DAYS})
            AND ob.linked_transaction_id IS NULL AND (ob.paid_date IS NULL OR ob.paid_date >= t.date) ORDER BY ob.id LIMIT 1)) AS account_bill
    FROM transactions t
    LEFT JOIN LATERAL (SELECT name, frequency, loan_id, created_at FROM bills WHERE linked_transaction_id = t.id ORDER BY id LIMIT 1) b ON true LEFT JOIN payees p ON p.id = t.payee_id WHERE t.id = ANY($1)`, [ids]);
  return new Map(rows.map((r) => [r.id, {
    payee_id: r.payee_id, payee: squash(r.payee), text: squash(`${r.payee} ${r.description}`), pays_bills: !!r.pays_bills,
    name: r.payee || r.description || '',
    bill_name: r.bill_name || null, bill_one_time: r.bill_frequency === 'one_time', loan: !!(r.loan_paid || r.bill_loan),
    bill_lead: r.bill_lead == null ? null : Number(r.bill_lead), bill_since: r.bill_since || null, account_bill: r.account_bill || null,
  }]));
}

/** What else the forecast plans beyond recurring bills: rent (from the rent bills) and active outflow estimates. */
export async function forecastSources(db = pool) {
  const [bills, { rows: rent }, { rows: est }] = await Promise.all([
    billSources(db),
    db.query(RENT_SQL).catch(() => ({ rows: [] })),
    db.query(`SELECT id, name, category, amount, frequency, start_date, end_date FROM cash_estimates WHERE status = 'active' AND direction = 'outflow'`)
      .catch(() => ({ rows: [] })),
  ]);
  return {
    ...bills,
    rent: {
      payees: new Map(rent.filter((b) => b.payee_id).map((b) => [b.payee_id, b.name])),
      categories: new Map(rent.filter((b) => b.category_id).map((b) => [b.category_id, b.name])),
      keys: new Map(rent.flatMap((b) => [[billKey(b.name), b.name], [squash(b.vendor), b.name]]).filter(([k]) => k.length >= 4)),
    },
    estimates: est.map((e) => ({ ...e, amount: Number(e.amount), key: squash(e.category), nameKey: squash(e.name) })),
  };
}

const RENT = /\brent\b/i;
const shiftDays = (iso, n) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const EST_DAYS = 60; // an estimate covers what's paid within two months of its date (money rarely moves on the planned day)

/** Why the forecast already has this purchase, besides an estimate (pure; null: it doesn't). src from forecastSources, tx from txInfo. */
export function forecastWhy(l, src, tx = new Map()) {
  const t = tx.get(l.transaction_id);
  if (!discretionary(l) && !(l.scheduled && invoiceBuy(l, t))) {
    return l.scheduled ? billFor(l, src, tx) : 'A loan, interest or tax payment';
  }
  const bill = billFor(l, src, tx);
  if (bill) return bill;
  if (t?.pays_bills && t.account_bill) return `Paid on the vendor’s account against the ${t.account_bill} bill`;
  // Rent: the forecast brings every landlord's rent round each year from the rent bills.
  if (src.rent && RENT.test(l.category || '')) {
    if (t?.payee_id && src.rent.payees.has(t.payee_id)) return `Rent (the ${src.rent.payees.get(t.payee_id)} bill)`;
    const k = t && [...src.rent.keys.keys()].find((x) => t.text.includes(x));
    if (k) return `Rent (the ${src.rent.keys.get(k)} bill)`;
    const c = [l.category_id, l.parent_category_id].find((x) => x && src.rent.categories.has(x));
    if (c) return `Rent (the ${src.rent.categories.get(c)} bill)`;
  }
  return null;
}

/**
 * Farm and capital purchases an active estimate plans (pure): line index → the estimate's name. An estimate fits by its
 * category or the payee it names, dated within two months, and covers only up to its own amount. A capital buy is the
 * planned one only if it's about the plan's size (half to one and a half times): smaller buys in the same category aren't
 * (Nov 16: the small RB Auction buys had gone under a planned $95,000 machine). Any purchase under a tenth of a one-off
 * plan isn't that plan either.
 */
export function plannedByEstimates(lines, src, tx = new Map()) {
  const out = new Map();
  if (!src.estimates?.length) return out;
  const room = new Map(); // estimate occurrence → what's left of it
  const order = lines.map((l, i) => i).filter((i) => (lines[i].farm || lines[i].capex) && lines[i].date)
    .sort((a, b) => (lines[a].date < lines[b].date ? -1 : lines[a].date > lines[b].date ? 1 : lines[b].amount - lines[a].amount));
  for (const i of order) {
    const l = lines[i];
    const cat = squash(l.base_category ?? l.category);
    const payee = tx.get(l.transaction_id)?.payee || '';
    for (const e of src.estimates) {
      if (!((e.key.length >= 4 && cat.includes(e.key)) || (payee.length >= 4 && e.nameKey.includes(payee)))) continue;
      if (l.capex && !(l.amount >= e.amount * 0.5 && l.amount <= e.amount * 1.5)) continue;
      // A one-off plan is one purchase: a payment under a tenth of it isn't that purchase (Nov 17: a $900 auction buy had
      // gone under a planned $400,000 combine in the same category). A recurring estimate takes small buys up to its amount.
      if (e.frequency === 'one_time' && l.amount < e.amount * 0.1) continue;
      const hit = occurrences(e, shiftDays(l.date, -EST_DAYS), shiftDays(l.date, EST_DAYS + 1))
        .map((d) => `${e.id}:${String(d).slice(0, 10)}`).find((k) => (room.has(k) ? room.get(k) : e.amount) >= l.amount - 0.005);
      if (!hit) continue;
      room.set(hit, (room.has(hit) ? room.get(hit) : e.amount) - l.amount);
      out.set(i, e.name);
      break;
    }
  }
  return out;
}

/** Every purchase, the household's and the farm's share, capital ones included. */
async function allLines(from, to, cats) {
  const [home, farm] = await Promise.all([
    householdLines(from, to, cats, { capex: true }), householdLines(from, to, cats, { farm: true, capex: true }),
  ]);
  const parent = new Map(cats.map((c) => [c.id, c.parent_id]));
  return [...home.spending, ...farm.spending].map((l) => ({
    ...l, parent_category_id: parent.get(l.category_id) || null, base_category: l.category,
    category: l.capex ? `${l.category} (capital)` : l.category,
  }));
}
/** The lines that only fit a household; a farm purchase there goes on Other. */
const HOUSEHOLD_ONLY = new Set(['home', 'health', 'kids']);
export const lineOf = (l) => {
  if (l.capex) return 'other';
  const k = lineFor(l.category);
  return l.farm && HOUSEHOLD_ONLY.has(k) ? 'other' : k;
};
/** The purchases from `from` to `to` (exclusive): kept (the budget's: everything the forecast doesn't already plan) and
 *  left (in the forecast already, each with why), so the page can show what it left out. */
async function budgetSplit(from, to) {
  const cats = await categoryBuckets();
  const [spending, src] = await Promise.all([allLines(from, to, cats), forecastSources()]);
  const tx = await txInfo(spending);
  const why = spending.map((l) => forecastWhy(l, src, tx));
  const open = spending.map((l, i) => (why[i] ? null : l));
  for (const [i, name] of plannedByEstimates(open.map((l) => l || {}), src, tx)) why[i] = `Planned in the forecast: ${name}`;
  const kept = []; const left = [];
  spending.forEach((l, i) => (why[i] ? left.push({ ...l, why: why[i], name: tx.get(l.transaction_id)?.name || l.description || '' }) : kept.push(l)));
  return { kept, left };
}
const budgetLines = async (from, to) => (await budgetSplit(from, to)).kept;
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
  const [overrides, totals, { kept: spending, left }] = await Promise.all([loadOverrides(), cashTotals(keys, today), budgetSplit(`${year}-01-01`, to)]);
  const share = (l) => (who === 'jake' ? l.jake : who === 'ashley' ? l.ashley : l.amount);
  // What the month left out because the forecast already has it, a row per payment (Nov 16: so he can see where it went).
  const leftOut = new Map();
  for (const l of left) {
    const v = share(l);
    if (l.month !== sel || Math.abs(v) < 0.005) continue;
    const e = leftOut.get(l.transaction_id) || { id: l.transaction_id, date: l.date, name: l.name, category: l.category, why: l.why, amount: 0 };
    e.amount = r2(e.amount + v);
    leftOut.set(l.transaction_id, e);
  }
  const spent = new Map(); // month → line → amount
  const farmBy = new Map(); // month → the farm's part
  const farmLine = new Map(); // the chosen month: line → the farm's part
  const byCat = new Map(); // the chosen month: line → category → amount
  for (const l of spending) {
    const v = share(l);
    if (Math.abs(v) < 0.005) continue;
    const m = spent.get(l.month) || new Map();
    const k = lineOf(l);
    m.set(k, (m.get(k) || 0) + v);
    spent.set(l.month, m);
    if (l.farm) farmBy.set(l.month, (farmBy.get(l.month) || 0) + v);
    if (l.month === sel) {
      if (l.farm) farmLine.set(k, (farmLine.get(k) || 0) + v);
      const c = byCat.get(k) || new Map();
      c.set(l.category, (c.get(l.category) || 0) + v);
      byCat.set(k, c);
    }
  }
  const months = keys.map((k) => {
    const lines = lineBudgets(totals[k], overrides, k);
    const s = spent.get(k) || new Map();
    return { month: k, label: monthLabel(k), current: k === cur, budget: lines.reduce((a, l) => a + l.budget, 0), spent: r2([...s.values()].reduce((a, v) => a + v, 0)), farm: r2(farmBy.get(k) || 0) };
  });
  const s = spent.get(sel) || new Map();
  const lines = lineBudgets(totals[sel], overrides, sel).map((l) => ({
    ...l, spent: r2(s.get(l.key) || 0), farm: r2(farmLine.get(l.key) || 0),
    categories: [...(byCat.get(l.key) || new Map())].map(([name, v]) => ({ name, spent: r2(v) })).sort((a, b) => b.spent - a.spent),
  }));
  return {
    month: sel, label: monthLabel(sel), who, today, cash_flow_total: totals[sel],
    months, lines, total: { budget: lines.reduce((a, l) => a + l.budget, 0), spent: r2(lines.reduce((a, l) => a + l.spent, 0)), farm: r2(farmBy.get(sel) || 0) },
    left_out: [...leftOut.values()].sort((a, b) => b.amount - a.amount),
  };
}

/**
 * Where a payment went (Jake, Nov 17: "the rbauction items remain unaccounted for in the discretionary budget account and were
 * not accounted for in the forecast"): every entry this year whose payee or description has the words, and what the budget did
 * with it: on a line, left out (with why), or not a purchase at all. Bills by that name with no payment linked are listed too:
 * no money shows leaving an account for those.
 */
export async function findPayments({ q, today = todayISO() } = {}) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const from = `${today.slice(0, 4)}-01-01`;
  const like = `%${term.replace(/[%_]/g, ' ')}%`;
  const [{ rows: txs }, { kept, left }, { rows: bills }] = await Promise.all([
    pool.query(`SELECT t.id, t.date, t.amount, t.description, t.is_transfer, t.is_debt_service, p.name AS payee, c.kind
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id LEFT JOIN expense_categories c ON c.id = t.category_id
      WHERE t.date >= $1 AND t.date <= $2 AND (p.name ILIKE $3 OR t.description ILIKE $3) ORDER BY t.date DESC, t.id DESC LIMIT 60`, [from, today, like]),
    budgetSplit(from, addDay(today)),
    pool.query(`SELECT b.id, b.name, b.amount, b.status::text AS status, b.due_date, b.paid_date FROM bills b LEFT JOIN payees p ON p.id = b.payee_id
      WHERE b.linked_transaction_id IS NULL AND b.due_date >= $1 AND (b.name ILIKE $2 OR p.name ILIKE $2) ORDER BY b.due_date DESC LIMIT 30`, [from, like]),
  ]);
  const label = Object.fromEntries(LINES.map((l) => [l.key, l.label]));
  const inBudget = new Map(); const out = new Map();
  for (const l of kept) {
    const e = inBudget.get(l.transaction_id) || { amount: 0, lines: new Set(), month: l.month };
    e.amount += l.amount; e.lines.add(label[lineOf(l)]);
    inBudget.set(l.transaction_id, e);
  }
  for (const l of left) { const e = out.get(l.transaction_id) || { amount: 0, why: l.why }; e.amount += l.amount; out.set(l.transaction_id, e); }
  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
  const rows = txs.map((t) => {
    const base = { id: t.id, date: iso(t.date), name: t.payee || t.description || '', description: t.description || '', amount: r2(Math.abs(Number(t.amount))) };
    const b = inBudget.get(t.id); const o = out.get(t.id);
    if (b) {
      return { ...base, where: 'budget', counted: r2(b.amount),
        detail: `In the budget for ${monthLabel(b.month)}: ${[...b.lines].join(', ')}${o ? `; $${Math.round(o.amount).toLocaleString('en-US')} of it left out (${o.why})` : ''}` };
    }
    if (o) return { ...base, where: 'left_out', counted: 0, detail: `Left out: ${o.why}` };
    const why = t.is_transfer ? 'a transfer between your own accounts' : t.is_debt_service ? 'a loan payment'
      : t.kind === 'income' || Number(t.amount) > 0 ? 'money in' : 'none of it is the farm’s or the household’s share';
    return { ...base, where: 'not_counted', counted: 0, detail: `Not a purchase: ${why}` };
  });
  for (const b of bills) {
    rows.push({ id: `bill-${b.id}`, date: iso(b.paid_date || b.due_date), name: b.name, description: 'bill', amount: r2(Number(b.amount)), counted: 0, where: 'bill',
      detail: b.status === 'paid' ? 'A bill marked paid with no payment linked: no money shows leaving an account for it. The payment that paid it is what the budget counts.'
        : 'An unpaid bill: in the forecast on its due date' });
  }
  return rows;
}

/** The transactions behind one line in one month, each with what the page needs to edit it. */
export async function lineEntries({ month, line, who = 'both', today = todayISO() }) {
  if (!ymOk(month)) throw Object.assign(new Error('month is YYYY-MM'), { status: 400 });
  if (!LINE_KEYS.includes(line)) throw Object.assign(new Error('Unknown budget line'), { status: 400 });
  const [y, m] = month.split('-').map(Number);
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  const spending = await budgetLines(`${month}-01`, end < addDay(today) ? end : addDay(today));
  const share = (l) => (who === 'jake' ? l.jake : who === 'ashley' ? l.ashley : l.amount);
  const mine = spending.filter((l) => lineOf(l) === line && Math.abs(share(l)) >= 0.005);
  const ids = [...new Set(mine.map((l) => l.transaction_id))];
  if (!ids.length) return [];
  const { rows: txs } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, t.category_id, t.is_split, t.segment, t.is_segment_split,
            t.segment_grain_pct, t.segment_livestock_pct, t.segment_jake_pct, t.segment_ashley_pct, p.name AS payee
     FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id WHERE t.id = ANY($1)`, [ids]);
  const byId = new Map(txs.map((t) => [t.id, t]));
  // One row per payment and category: a split payment shows under each category it has on this line.
  const out = new Map();
  for (const l of mine) {
    const t = byId.get(l.transaction_id);
    if (!t) continue;
    const key = `${t.id}|${l.category}`;
    const e = out.get(key) || {
      key, id: t.id, date: l.date, description: t.description || l.description || '', payee: t.payee || null,
      category_id: t.category_id, category: l.category, amount: 0, tx_amount: Number(t.amount),
      whose: whoseKey(t), split: !!t.is_split,
    };
    e.amount = r2(e.amount + share(l));
    out.set(key, e);
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
  if (['jake', 'ashley', 'grain', 'livestock'].includes(t.segment)) return t.segment;
  return 'untagged';
}
/** The owner fields for a whose choice. */
export function ownerFor(whose) {
  if (['jake', 'ashley', 'grain', 'livestock'].includes(whose)) return { segment: whose, is_segment_split: false };
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
