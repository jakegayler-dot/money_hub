// The GST return (Jake, Nov 15: "a gst return system that compiles all eligible expenses, flags if there is no receipt,
// automatically determines the required data points for the gst return for each quarter").
//
// For every reporting period it gathers the farm's share of each purchase and sale, sorts each purchase by how GST
// applies to it, flags what stops a credit being claimed, and works out the lines of CRA's GST34 return
// (regular method, Saskatchewan: 5% GST, no HST).
//
// How GST applies to a purchase ("treatment"):
//   taxable     GST is charged: the farm's share of the GST recorded is an input tax credit (ITC). GST not recorded on
//               one is a credit being missed until the receipt is read.
//   zero_rated  GST at 0%: seed, fertilizer, bulk crop chemicals, feed, livestock, listed farm machinery.
//   exempt      No GST is charged: insurance, interest and bank charges, wages, property tax, licences, land rent from an
//               individual, government levies and checkoffs.
// GST recorded on an entry always wins (a seed dealer who charged it). Otherwise Jake's choice on the entry, then on its
// category, then a guess from the category's name. A guess is shown as one so he can confirm it once for the category.
//
// A purchase is counted on its invoice when there is one (Jake, Nov 15: Melfort Pipeline "send invoices that update our
// account balance, then i pay the account in lump sums. So it isnt right to have the transaction show up"): GST becomes
// payable on the invoice date, so a bill (a vendor's invoice) is the purchase, in the period of its invoice date
// (vendorAccount.js billDate), paid or not; the payment that pays it (linked to the bill, or paid on account and applied
// to bills) isn't on the return. Everything bought without an invoice is counted on its ledger entry, at its date.
// A recurring bill counts once it's paid or its invoice is in (received date); the copy waiting for next month doesn't.
//
// An ITC can be claimed for four years, so a receipt read after a
// return was filed is claimed on the next one ("ITCs from earlier periods"); an ITC that no longer stands (moved to the
// household, the GST corrected down) goes back on line 104. That needs the return's claim saved when it's filed
// (gst_returns.claimed); returns filed before Nov 15 2026 had none, so nothing carries from them.
//
// What CRA needs on the receipt for an ITC (Input Tax Credit Information Regulations s.3): under $100 the supplier,
// date and total; from $100 also the supplier's GST registration number and the GST (or that it's included); from $500
// also the buyer's name, the terms and what was bought.
import { pool, getSetting } from '../db.js';
import { businessShare } from './segments.js';
import { toISODate, todayISO, addMonths } from './dates.js';
import { gstPeriods } from './tax.js';
import { billDate } from './vendorAccount.js';

const r2 = (n) => Math.round(Number(n) * 100) / 100 + 0; // + 0: never -0
export const TREATMENTS = ['taxable', 'zero_rated', 'exempt'];
export const TREATMENT_LABEL = { taxable: 'GST charged', zero_rated: 'Zero-rated (0%)', exempt: 'No GST charged' };

// Guesses from a category's name (and its parent's). Order matters: the first match wins.
const GUESS = [
  // Meals and entertainment are taxable but only half the GST is a credit.
  ['taxable', /meal|entertain|restaurant/i],
  ['exempt', /insur|interest|bank|service charge|account fee|\bfees?\b.*(bank|account)|wage|salar|payroll|\blabou?r\b|employ|property tax|municipal tax|\btaxes\b|licen[cs]|registration|\bsgi\b|donat|charit|\bcra\b|levy|levies|check-?off|land rent|cash rent|pasture rent|\brent\b|lease of land|membership|dues|association/i],
  ['zero_rated', /fertili[sz]|\bseed|chemical|herbicide|fungicide|insecticide|pesticide|inoculant|\bfeed\b|\bhay\b|straw|silage|fodder|grain purchase|mineral|\bsalt\b|supplement|livestock purchase|cattle purchase|bull purchase|heifer|calf purchase|calves|breeding stock/i],
];
export function guessTreatment(...names) {
  const text = names.filter(Boolean).join(' / ');
  if (!text) return null;
  for (const [t, re] of GUESS) if (re.test(text)) return t;
  return null;
}
const HALF_ITC = /meal|entertain|restaurant/i;

// Income that's a sale of something (line 90: taxable and zero-rated sales in Canada) vs. other revenue (line 91:
// program payments, insurance proceeds, rebates, patronage, interest).
const OTHER_REVENUE = /program|agri-?invest|agri-?stability|crop insurance|insurance proceeds|insurance|rebate|grant|patronage|dividend|interest|refund|compensation|indemnit/i;

// A GST/HST registration number: the 9-digit business number + RT + 4 digits (spaces and dashes allowed), or the bare
// 9 digits some till slips print.
export function cleanGstNumber(s) {
  const t = String(s || '').toUpperCase().replace(/[\s-]/g, '');
  const m = t.match(/(\d{9})(RT\d{4})?/);
  return m ? `${m[1]}${m[2] ? ` ${m[2]}` : ''}` : null;
}

/** Which period of the filing frequency a date falls in. */
export function periodOf(date, frequency) {
  const y = Number(String(date).slice(0, 4));
  return gstPeriods(y, frequency).find((p) => date >= p.start && date <= p.end) || null;
}

/**
 * Every farm purchase and sale between two dates (inclusive), one row per entry with its farm share, how GST applies,
 * its credit, its receipt and what's wrong. The building block of each period's return.
 */
export async function gstEntries(from, to, db = pool) {
  const { rows } = await db.query(
    `SELECT l.transaction_id, l.split_id, l.date, l.amount, l.ledger, l.segment, l.is_segment_split, l.is_capex,
            l.segment_grain_pct, l.segment_livestock_pct, l.segment_jake_pct, l.segment_ashley_pct,
            c.id AS category_id, c.name AS category, c.kind AS category_kind, c.gst_treatment AS category_treatment,
            pc.name AS parent_category, pc.gst_treatment AS parent_treatment,
            t.amount AS tx_amount, t.gst_amount, t.gst_treatment AS tx_treatment, t.description AS tx_description,
            t.credit_card_id, p.id AS payee_id, p.name AS payee, p.gst_number AS payee_gst_number,
            COALESCE(a.name, cc.name) AS paid_from
     FROM transaction_lines l
     JOIN transactions t ON t.id = l.transaction_id
     LEFT JOIN expense_categories c ON c.id = l.category_id
     LEFT JOIN expense_categories pc ON pc.id = c.parent_id
     LEFT JOIN payees p ON p.id = t.payee_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     WHERE l.date >= $1 AND l.date <= $2 AND NOT l.is_transfer AND NOT t.is_transfer AND NOT t.is_debt_service AND t.tax_kind IS NULL
       AND NOT (t.account_id IS NOT NULL AND t.credit_card_id IS NOT NULL)
       AND NOT (l.amount < 0 AND ${PAYS_BILLS})
     ORDER BY l.date, l.transaction_id, l.split_id NULLS FIRST`,
    [from, to]
  );
  const bills = await invoiceRows(from, to, db);
  if (!rows.length && !bills.length) return { expenses: [], sales: [], aliases: new Map() };
  const ids = [...new Set(rows.map((r) => r.transaction_id))];
  const [{ rows: receipts }, { rows: docs }] = await Promise.all([
    db.query(
      `SELECT id, transaction_id, extracted->>'total' AS total, extracted->>'gst_number' AS gst_number,
              (extracted ? 'gst_number') AS read_for_number, extracted->>'doc_type' AS doc_type
       FROM receipts WHERE transaction_id = ANY($1) ORDER BY id`, [ids]),
    db.query(`SELECT id, transaction_id, kind, number, receipt_number FROM farm_documents WHERE transaction_id = ANY($1) AND status <> 'void'`, [ids]),
  ]);
  const receiptsOf = new Map();
  for (const r of receipts) receiptsOf.set(String(r.transaction_id), [...(receiptsOf.get(String(r.transaction_id)) || []), r]);
  const docOf = new Map(docs.map((d) => [String(d.transaction_id), d]));
  // An invoice's paper: filed on the bill, or on the payment that paid that bill alone.
  if (bills.length) {
    const { rows: billReceipts } = await db.query(
      `SELECT r.id, r.bill_id, r.transaction_id, r.extracted->>'total' AS total, r.extracted->>'gst_number' AS gst_number,
              (r.extracted ? 'gst_number') AS read_for_number, r.extracted->>'doc_type' AS doc_type
       FROM receipts r WHERE r.bill_id = ANY($1) OR r.transaction_id = ANY($2) ORDER BY r.id`,
      [bills.map((b) => b.id), bills.filter((b) => Number(b.on_tx) === 1).map((b) => b.linked_transaction_id)]);
    for (const b of bills) {
      const mine = billReceipts.filter((r) => r.bill_id === b.id || (Number(b.on_tx) === 1 && r.transaction_id && r.transaction_id === b.linked_transaction_id));
      if (mine.length) receiptsOf.set(`b${b.id}`, mine);
    }
  }

  // One row per entry and side: its lines added up at the farm's share.
  const byKey = new Map();
  for (const l of rows) {
    const share = businessShare(l);
    const amt = Number(l.amount);
    const income = l.category_kind === 'income' || (l.category_kind == null && amt > 0);
    const key = `${l.transaction_id}:${income ? 'in' : 'out'}`;
    let e = byKey.get(key);
    if (!e) {
      e = {
        key: String(l.transaction_id), transaction_id: l.transaction_id, bill_id: null, invoice: null,
        side: income ? 'sale' : 'purchase', date: toISODate(l.date),
        payee: l.payee || null, payee_id: l.payee_id, payee_gst_number: l.payee_gst_number || null,
        description: l.tx_description || null, paid_from: l.paid_from || null,
        tx_amount: Number(l.tx_amount), gst_recorded: l.gst_amount == null ? null : Number(l.gst_amount),
        tx_treatment: l.tx_treatment || null, amount: 0, farm_amount: 0, capital: false, categories: [], _lines: [],
      };
      byKey.set(key, e);
    }
    e.amount += amt;
    e.farm_amount += amt * share;
    if (l.is_capex) e.capital = true;
    if (l.category && !e.categories.some((c) => c.id === l.category_id)) e.categories.push({ id: l.category_id, name: l.category, parent: l.parent_category });
    e._lines.push({ amt, share, l });
  }
  // Each vendor invoice, as the purchase.
  for (const b of bills) {
    const amt = -Number(b.amount);
    const share = businessShare(b);
    const one = Number(b.on_tx) === 1;
    const gst = b.has_gst ? Number(b.gst_amount) : (b.gst_treatment && b.gst_treatment !== 'taxable') ? null
      : one && b.tx_gst != null ? Number(b.tx_gst) * Math.min(1, Number(b.amount) / (Math.abs(Number(b.tx_amount)) || 1)) : null;
    const l = { category_id: b.category_id, category: b.category, parent_category: b.parent_category,
      category_treatment: b.category_treatment, parent_treatment: b.parent_treatment };
    byKey.set(`b${b.id}`, {
      key: `b${b.id}`, transaction_id: null, bill_id: b.id, side: 'purchase', date: b.date,
      invoice: { name: b.name, status: b.status, paid_date: b.status === 'paid' ? toISODate(b.tx_date || b.paid_date) : null, due_date: toISODate(b.due_date) },
      payee: b.payee || b.name, payee_id: b.payee_id, payee_gst_number: b.payee_gst_number || null,
      description: b.name, paid_from: null, tx_amount: amt, gst_recorded: gst == null ? null : r2(gst),
      tx_treatment: b.gst_treatment || (one ? b.tx_treatment : null) || null, amount: amt, farm_amount: amt * share, capital: false,
      categories: b.category ? [{ id: b.category_id, name: b.category, parent: b.parent_category }] : [],
      _lines: [{ amt, share, l }],
    });
  }

  const expenses = [];
  const sales = [];
  for (const e of byKey.values()) {
    const lines = e._lines;
    delete e._lines;
    if (Math.abs(e.farm_amount) < 0.005) continue; // the household's alone
    const txAbs = Math.abs(e.tx_amount) || 1;
    // The farm's part of the entry's GST: the entry's GST in proportion to this side's farm amount.
    const farmFraction = Math.abs(e.farm_amount) / txAbs;
    const gstFarm = e.gst_recorded == null ? null : Math.abs(e.gst_recorded) * Math.min(1, farmFraction);
    const rec = receiptsOf.get(e.key) || [];
    const doc = docOf.get(e.key);
    e.amount = r2(e.amount);
    e.farm_amount = r2(e.farm_amount);
    e.farm_share = r2(Math.min(1, farmFraction) * 100);
    e.category = e.categories.map((c) => c.name).join(', ') || null;
    e.receipt = rec.length ? { id: rec[0].id, count: rec.length, gst_number: cleanGstNumber(rec.find((r) => r.gst_number)?.gst_number) } : null;
    e.farm_document = doc ? { id: doc.id, kind: doc.kind, number: doc.receipt_number || doc.number } : null;
    const sign = Math.sign(e.farm_amount); // purchases are negative; a refund of a purchase is positive

    if (e.side === 'sale') {
      e.gst_collected = gstFarm == null ? 0 : r2(gstFarm * (sign || 1));
      e.line = e.categories.some((c) => OTHER_REVENUE.test(`${c.name} ${c.parent || ''}`)) ? 91 : 90;
      e.revenue = r2(e.farm_amount - e.gst_collected); // revenue without its GST
      e.flags = [];
      sales.push(e);
      continue;
    }

    // How GST applies.
    let treatment = null;
    let source = null;
    if (e.gst_recorded != null && Math.abs(e.gst_recorded) > 0.004) { treatment = 'taxable'; source = 'gst'; }
    else if (e.tx_treatment) { treatment = e.tx_treatment; source = 'entry'; }
    else {
      const set = lines.map(({ l }) => l.category_treatment || l.parent_treatment).filter(Boolean);
      if (set.length) { treatment = set.includes('taxable') ? 'taxable' : set.includes('zero_rated') ? 'zero_rated' : 'exempt'; source = 'category'; }
      else {
        const guesses = lines.map(({ l }) => guessTreatment(l.category, l.parent_category)).filter(Boolean);
        if (guesses.length) { treatment = guesses.includes('taxable') ? 'taxable' : guesses.includes('zero_rated') ? 'zero_rated' : 'exempt'; source = 'guess'; }
      }
    }
    if (!treatment && e.gst_recorded != null) { treatment = 'exempt'; source = 'gst'; } // GST recorded as 0
    // Most things the farm buys carry GST (fuel, repairs, parts, services): a category with no other rule is taxable.
    // Only an entry with no category at all needs a look.
    if (!treatment) { treatment = 'taxable'; source = e.categories.length ? 'usual' : 'default'; }
    e.treatment = treatment;
    e.treatment_source = source;

    // The credit: the farm's share of the GST (half on meals and entertainment). A refund of a purchase gives it back.
    const half = e.categories.some((c) => HALF_ITC.test(`${c.name} ${c.parent || ''}`));
    e.half_itc = half && treatment === 'taxable';
    e.itc = treatment === 'taxable' && gstFarm != null ? r2(gstFarm * (half ? 0.5 : 1) * (sign < 0 ? 1 : -1)) : 0;
    // GST not recorded on something taxable: at most 5/105 of the farm's share (less when PST was on it too).
    e.itc_up_to = treatment === 'taxable' && e.gst_recorded == null ? r2(Math.abs(e.farm_amount) * 5 / 105 * (half ? 0.5 : 1)) : 0;

    const total = Math.abs(e.tx_amount);
    const hasDoc = !!(e.receipt || e.farm_document);
    e.flags = [];
    if (treatment === 'taxable' && e.gst_recorded == null) e.flags.push(hasDoc ? 'gst_not_recorded' : 'no_receipt_gst_unknown');
    else if (e.itc && !hasDoc) e.flags.push('no_receipt');
    // From $100 the supplier's GST number must be on the receipt. Only receipts read for it can say it's missing.
    if (e.itc > 0 && hasDoc && total >= 100 && !e.receipt?.gst_number && !e.payee_gst_number
        && e.receipt && rec.some((r) => r.read_for_number) && !rec.some((r) => r.gst_number)) e.flags.push('no_gst_number');
    if (source === 'default') e.flags.push('check_treatment');
    e.receipt_rules = total >= 500 ? 'From $500: supplier, date, total, GST number, GST, your name, terms and what was bought'
      : total >= 100 ? 'From $100: supplier, date, total, GST number and the GST' : 'Under $100: supplier, date and total';
    expenses.push(e);
  }
  expenses.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // A payment once claimed on its own, now counted on the invoices it paid (for returns filed before Nov 15's change).
  const aliases = new Map();
  for (const b of bills) {
    for (const tx of [b.linked_transaction_id, ...(b.credit_txs || [])].filter(Boolean)) {
      aliases.set(String(tx), [...new Set([...(aliases.get(String(tx)) || []), `b${b.id}`])]);
    }
  }
  return { expenses, sales, aliases };
}

// A ledger payment that pays bills: linked to a bill, or paid on account / as a deposit and applied to bills. Its bills
// are the purchases on the return, so it isn't (a deposit the vendor kept is spending with no invoice, so it stays).
const PAYS_BILLS = `(EXISTS (SELECT 1 FROM bills b WHERE b.linked_transaction_id = t.id AND b.loan_id IS NULL)
  OR EXISTS (SELECT 1 FROM vendor_credits vc WHERE vc.transaction_id = t.id AND vc.status <> 'kept')
  OR EXISTS (SELECT 1 FROM vendor_on_account o WHERE o.transaction_id = t.id))`;

/** The vendor invoices (bills) dated in the period, with what the return needs. */
async function invoiceRows(from, to, db) {
  const { rows } = await db.query(
    `SELECT b.id, b.name, b.ledger, b.amount, b.status, b.frequency, b.received_date, b.due_date, b.created_at, b.paid_date,
            b.has_gst, b.gst_amount, b.gst_treatment, b.payee_id, b.linked_transaction_id, b.category_id,
            b.segment, b.is_segment_split, b.segment_grain_pct, b.segment_livestock_pct, b.segment_jake_pct, b.segment_ashley_pct,
            c.name AS category, c.gst_treatment AS category_treatment, pc.name AS parent_category, pc.gst_treatment AS parent_treatment,
            p.name AS payee, p.gst_number AS payee_gst_number,
            t.date AS tx_date, t.amount AS tx_amount, t.gst_amount AS tx_gst, t.gst_treatment AS tx_treatment,
            (SELECT COUNT(*) FROM bills x WHERE x.linked_transaction_id = b.linked_transaction_id) AS on_tx,
            (SELECT array_agg(DISTINCT vc.transaction_id) FROM credit_applications ca JOIN vendor_credits vc ON vc.id = ca.credit_id
              WHERE ca.bill_id = b.id AND vc.transaction_id IS NOT NULL) AS credit_txs
     FROM bills b
     LEFT JOIN expense_categories c ON c.id = b.category_id
     LEFT JOIN expense_categories pc ON pc.id = c.parent_id
     LEFT JOIN payees p ON p.id = b.payee_id
     LEFT JOIN transactions t ON t.id = b.linked_transaction_id
     WHERE b.loan_id IS NULL AND b.amount > 0
       AND (t.id IS NULL OR (t.tax_kind IS NULL AND NOT t.is_debt_service AND NOT t.is_transfer))
       AND (b.received_date BETWEEN $1 AND $2
         OR (b.received_date IS NULL AND (b.due_date BETWEEN $1::date - 400 AND $2::date + 400)))`,
    [from, to]);
  return rows
    // A recurring bill not yet paid and with no invoice date is the next cycle waiting, not an invoice.
    .filter((b) => b.frequency === 'one_time' || b.received_date || b.status === 'paid')
    .map((b) => ({ ...b, date: billDate(b), credit_txs: (b.credit_txs || []).map(Number) }))
    .filter((b) => b.date >= from && b.date <= to && businessShare(b) > 0);
}

export const FLAG_TEXT = {
  no_receipt: 'No receipt: the credit needs one',
  no_receipt_gst_unknown: 'No receipt and no GST recorded: photograph the receipt to claim the GST',
  gst_not_recorded: 'GST not recorded: the receipt is here, enter the GST from it',
  no_gst_number: "The receipt doesn't show the supplier's GST number (needed from $100)",
  check_treatment: 'Uncategorized or unknown: counted as GST charged, check it',
};

const sum = (xs, f) => r2(xs.reduce((a, x) => a + (Number(f(x)) || 0), 0));

/** The returns filed, with what each claimed, by period start. */
async function filedReturns(db) {
  const { rows } = await db.query('SELECT * FROM gst_returns ORDER BY period_start');
  return rows.map((r) => ({ ...r, period_start: toISODate(r.period_start), period_end: toISODate(r.period_end), filed_on: r.filed_on ? toISODate(r.filed_on) : null }));
}

/**
 * ITC changes from earlier filed periods to put on this return: a credit grown since it was filed (line 106) or shrunk
 * (line 104). Only returns filed with their claim saved, ending within four years before this period, and only on the
 * first unfiled return after them (a later one would count them twice).
 */
async function carriedInto(period, frequency, filed, db) {
  const withClaims = filed.filter((r) => r.claimed && r.filed_on && r.period_end < period.start
    && r.period_end >= addMonths(period.start, -48));
  if (!withClaims.length) return [];
  const filedStarts = new Set(filed.filter((r) => r.filed_on).map((r) => r.period_start));
  // Every claim made so far on each entry, its own return's and carried ones.
  const claimedSoFar = new Map();
  for (const r of filed) {
    for (const [tx, v] of Object.entries(r.claimed || {})) claimedSoFar.set(tx, (claimedSoFar.get(tx) || 0) + Number(v));
    for (const c of r.carried || []) { const k = c.key || String(c.transaction_id); claimedSoFar.set(k, (claimedSoFar.get(k) || 0) + Number(c.itc)); }
  }
  const from = withClaims[0].period_start;
  const to = withClaims[withClaims.length - 1].period_end;
  const { expenses, aliases } = await gstEntries(from, to, db);
  const itcOf = new Map();
  for (const e of expenses) itcOf.set(e.key, r2((itcOf.get(e.key) || 0) + e.itc));
  // A claim on a payment that's now counted on its invoices moves onto them (in proportion to their credits now).
  const onKeys = (key, v, into) => {
    const to = !itcOf.has(key) && aliases.get(key);
    if (!to) { into.set(key, r2((into.get(key) || 0) + v)); return; }
    const total = to.reduce((a, k) => a + Math.abs(itcOf.get(k) || 0), 0);
    for (const k of to) into.set(k, r2((into.get(k) || 0) + v * (total ? Math.abs(itcOf.get(k) || 0) / total : 1 / to.length)));
  };
  // Re-key claimedSoFar the same way.
  const soFar = new Map();
  for (const [k, v] of claimedSoFar) onKeys(k, v, soFar);
  const out = [];
  // The filed returns this one is the first unfiled after. Compared as one: a payment claimed in one period may now be
  // counted on an invoice dated in another.
  const step = frequency === 'monthly' ? 1 : frequency === 'annual' ? 12 : 3;
  const eligible = withClaims.filter((r) => {
    let p = periodOf(addMonths(r.period_start, step), frequency);
    while (p && p.start < period.start) { if (!filedStarts.has(p.start)) return false; p = periodOf(addMonths(p.start, step), frequency); }
    return true;
  });
  const inAny = (d) => eligible.find((r) => d >= r.period_start && d <= r.period_end);
  const inR = expenses.filter((e) => inAny(e.date));
  const now = new Map();
  for (const e of inR) now.set(e.key, r2((now.get(e.key) || 0) + e.itc));
  const claimedHere = new Map();
  for (const r of eligible) for (const [k, v] of Object.entries(r.claimed || {})) onKeys(k, Number(v), claimedHere);
  for (const key of new Set([...now.keys(), ...claimedHere.keys()])) {
    const d = r2((now.get(key) || 0) - (soFar.get(key) || 0));
    if (Math.abs(d) < 0.01) continue;
    const e = inR.find((x) => x.key === key);
    out.push({ key, transaction_id: key.startsWith('b') ? null : Number(key), bill_id: key.startsWith('b') ? Number(key.slice(1)) : null,
      period: (e && inAny(e.date)?.period_start) || eligible[eligible.length - 1].period_start,
      date: e?.date || null, payee: e?.payee || null, description: e?.description || null, itc: d });
  }
  return out;
}

/**
 * One period's return: its GST34 lines, the entries behind them and what's wrong. `start` is the period's first day.
 */
export async function gstReturn(start, db = pool) {
  const frequency = String(await getSetting('gst_filing_frequency', 'quarterly'));
  const period = periodOf(String(start), frequency);
  if (!period || period.start !== String(start)) return null;
  const [filed, bn] = await Promise.all([filedReturns(db), getSetting('gst_business_number', null)]);
  const ret = filed.find((r) => r.period_start === period.start) || null;
  const today = todayISO();
  const { expenses, sales } = await gstEntries(period.start, period.end, db);
  // A filed return keeps what it carried; an open one works it out now.
  const carried = ret?.filed_on ? (ret.carried || []) : await carriedInto(period, frequency, filed, db);

  const line90 = sum(sales.filter((s) => s.line === 90), (s) => s.revenue);
  const line91 = sum(sales.filter((s) => s.line === 91), (s) => s.revenue);
  const line103 = sum(sales, (s) => s.gst_collected);
  const line104 = r2(-sum(carried.filter((c) => c.itc < 0), (c) => c.itc));
  const line106 = r2(sum(expenses, (e) => e.itc) + sum(carried.filter((c) => c.itc > 0), (c) => c.itc));
  const line107 = 0;
  const line105 = r2(line103 + line104);
  const line108 = r2(line106 + line107);
  const line109 = r2(line105 - line108);
  const line110 = 0;
  const line111 = 0;
  const line113A = r2(line109 - line110 - line111);
  const line113C = line113A; // nothing self-assessed (lines 205, 405)
  const lines = {
    90: Math.round(line90), 91: Math.round(line91), 101: Math.round(line90 + line91),
    103: line103, 104: line104, 105: line105, 106: line106, 107: line107, 108: line108, 109: line109,
    110: line110, 111: line111, 112: 0, '113A': line113A, 205: 0, 405: 0, '113B': 0, '113C': line113C,
    114: line113C < 0 ? r2(-line113C) : 0, 115: line113C > 0 ? line113C : 0,
  };

  // Invoices the farm wrote in the period with GST that aren't paid: GST is owed when it's invoiced, not when paid.
  const { rows: unpaid } = await db.query(
    `SELECT id, number, party_name, date, gst, total FROM farm_documents
     WHERE kind = 'invoice' AND status = 'open' AND gst > 0 AND date >= $1 AND date <= $2 ORDER BY date`, [period.start, period.end]);

  const count = (f) => expenses.filter((e) => e.flags.includes(f));
  const flagged = expenses.filter((e) => e.flags.some((f) => f !== 'check_treatment'));
  const status = ret?.settlement_transaction_id ? 'settled' : ret?.filed_on ? 'filed'
    : period.end >= today ? 'current' : period.due < today ? 'overdue' : 'to_file';
  const missingGst = [...count('gst_not_recorded'), ...count('no_receipt_gst_unknown')];
  return {
    period: { ...period, frequency, status },
    business_number: bn || null,
    lines,
    totals: {
      purchases: expenses.length, farm_spend: r2(-sum(expenses, (e) => e.farm_amount)),
      by_treatment: Object.fromEntries(TREATMENTS.map((t) => [t, {
        count: expenses.filter((e) => e.treatment === t).length,
        farm_amount: r2(-sum(expenses.filter((e) => e.treatment === t), (e) => e.farm_amount)),
        itc: sum(expenses.filter((e) => e.treatment === t), (e) => e.itc),
      }])),
      capital_itc: sum(expenses.filter((e) => e.capital), (e) => e.itc),
      carried_itc: sum(carried, (c) => c.itc),
      sales: sales.length, revenue: r2(line90 + line91),
    },
    flags: {
      no_receipt: { count: count('no_receipt').length, itc: sum(count('no_receipt'), (e) => e.itc) },
      gst_missing: { count: missingGst.length, farm_amount: r2(-sum(missingGst, (e) => e.farm_amount)), itc_up_to: sum(missingGst, (e) => e.itc_up_to) },
      no_receipt_gst_unknown: count('no_receipt_gst_unknown').length,
      no_gst_number: count('no_gst_number').length,
      check_treatment: count('check_treatment').length,
      guessed: expenses.filter((e) => e.treatment_source === 'guess').length,
      unpaid_invoices: unpaid.map((d) => ({ id: d.id, number: d.number, party: d.party_name, date: toISODate(d.date), gst: Number(d.gst), total: Number(d.total) })),
      open: flagged.length,
    },
    ready: !flagged.length && !unpaid.length,
    expenses, sales, carried,
    filed: ret?.filed_on ? { filed_on: ret.filed_on, net_amount: ret.net_amount == null ? null : Number(ret.net_amount), lines: ret.lines || null,
      settlement_transaction_id: ret.settlement_transaction_id || null, notes: ret.notes || null } : null,
  };
}

/** What a filed return claimed, entry by entry, saved with it so later changes carry to the next return. */
export function claimOf(r) {
  const claimed = {};
  for (const e of r.expenses) if (e.itc) claimed[e.key] = r2((claimed[e.key] || 0) + e.itc);
  return claimed;
}

/** Every period of a year in short: the lines that matter and the flags (the Tax page, the calendar, the forecast). */
export async function gstYear(year, db = pool) {
  const frequency = String(await getSetting('gst_filing_frequency', 'quarterly'));
  const out = [];
  for (const p of gstPeriods(year, frequency)) out.push(await gstReturn(p.start, db));
  return { year, frequency, returns: out };
}
