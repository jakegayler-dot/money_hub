// The cash forecast as a list of dated flows.
//
// Every expected movement of money — contracts, inventory sales, estimates,
// bills, loan payments, card statements, account fees, GST refunds and
// payments, income tax — is one flow with:
//   date, amount (signed: money in positive), kind, label
//   farm      the farm's share (Grain + Cattle) of it, 0–1; the rest is personal
//   taxable   its effect on farm taxable income (farm share, GST out,
//             loan principal and card payments 0) — what the what-if
//             engine uses to re-work income tax when a flow moves or changes
//   estimate  true for estimates and inventory sales (never in "committed")
//   ref       what it came from (bill, contract, loan, inventory group…)
//
// evaluate() buckets flows into months for a scope — Everything, Farm
// (farm shares only), Personal, or one owner (Grain, Cattle, Jake, Ashley)
// — from the cash in the chosen accounts. Each flow also carries
//   owners    its share for each owner { grain, livestock, jake, ashley }
// (Jake, 2026-10-24): from what it's tagged to; farm-wide flows (GST,
// tax) split by each enterprise's share of the farm's activity; household
// spending by who actually spends it. Money the farm pays for Jake or
// Ashley (a card paid from a farm account, the household spending that
// goes through farm accounts) stays out of their own views.
// Income tax flows are built separately (buildTaxFlows) from a tax figure
// per year, so a scenario can re-work them.

import { pool, getSetting } from '../db.js';
import { loadNetting } from './cropPlanNetting.js';
import { RENT_SQL, projectRent } from './rentProjection.js';
import { ACTUAL_SQL, PURCHASE_IDS_SQL, agriInvestFlows } from './agriInvest.js';
import { occurrences, signedAmount, activeEstimates } from './estimates.js';
import { inventorySales } from './inventoryForecast.js';
import { loadBalanceSheet } from './balanceSheet.js';
import { businessShare, ownerWeights } from './segments.js';
import { todayISO, toISODate, addMonths, addDays, monthIndex } from './dates.js';
import { LATEST_STATEMENTS_SQL, cardBalances } from './cardLedger.js';
import { farmIncomeTax, gstReport, gstPeriods } from './tax.js';
import { personalTax } from './taxRates.js';
import { billDates } from './billDates.js';
import { householdSpentThisMonth } from './personal.js';
import { contractParts } from './contracts.js';
import { paystubForecastFlows } from './paystubs.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayNum = (d) => { const [y, m, dd] = toISODate(d).split('-').map(Number); return Date.UTC(y, m - 1, dd) / 86400000; };

// ---- The cash floor --------------------------------------------------------------
// What has to be paid whether or not any money comes in: loan payments,
// bills, card statements, account fees, income tax and GST owing, and the
// household's essential spending. The floor at a month-end is what falls
// due in the FLOOR_DAYS after it — cash on hand should cover it if nothing
// arrives in that time. Capital purchases, estimates and discretionary
// spending can be put off, so they are left out.
// It's capped (Jake, Oct 27: "20k max of cash and cash equivalents"): the
// payments themselves are already taken off month by month in the forecast,
// so the floor is a cushion, never more than FLOOR_CAP (setting floor_cap).
export const FLOOR_DAYS = 60;
export const FLOOR_CAP = 20000;
const MAX_FLOOR_DAYS = 90;
const LOOKAHEAD_MONTHS = 3;
const MUST_PAY = new Set(['loan', 'lease', 'bill', 'card', 'fee', 'tax', 'gst']);
// The household budget isn't must-pay: it's sized from the room above the floor, so it can't be part of it.
export const mustPay = (f) => f.amount < 0 && MUST_PAY.has(f.kind);
const FLOOR_PART = { loan: 'loans', lease: 'loans', bill: 'bills', card: 'cards', fee: 'fees', tax: 'tax', gst: 'tax', personal: 'household' };

export const OWNER_SCOPES = ['grain', 'livestock', 'jake', 'ashley'];
export const SCOPES = ['everything', 'farm', 'personal', ...OWNER_SCOPES];
const EVEN = { farm: { grain: 0.5, livestock: 0.5 }, household: { jake: 0.5, ashley: 0.5, farm: 0 } };

/** Owner shares from a flow's farm share alone: the farm part by the enterprise split, the rest by the household split. */
function derivedOwners(farm, splits = EVEN) {
  const f = farm ?? 1;
  const h = splits.household;
  return {
    grain: f * splits.farm.grain, livestock: f * splits.farm.livestock,
    jake: (1 - f) * h.jake, ashley: (1 - f) * h.ashley,
  };
}

/** Owner shares of a tagged row (contract, bill, loan, account, estimate…); untagged parts follow its ledger. */
export function ownersOf(row, splits = EVEN) {
  const w = ownerWeights(row);
  const o = { grain: w.grain, livestock: w.livestock, jake: w.jake, ashley: w.ashley };
  if (w.unassigned > 0) {
    const personal = row.ledger === 'personal' || row.segment === 'personal';
    const d = derivedOwners(personal ? 0 : 1, splits);
    for (const k of OWNER_SCOPES) o[k] += w.unassigned * d[k];
  }
  return o;
}

/**
 * The share of a flow (or account) a scope sees. Everything: all of it.
 * Farm / Personal: by its farm share. One owner: that owner's share — and
 * nothing for Jake or Ashley when the farm pays it (ref.paid_from_farm).
 */
export function shareFor(scope, x, splits = EVEN) {
  const farm = typeof x === 'number' ? x : (x.farm ?? 1);
  if (scope === 'farm') return farm;
  if (scope === 'personal') return 1 - farm;
  if (!OWNER_SCOPES.includes(scope)) return 1;
  if (typeof x === 'object' && x.ref?.paid_from_farm && (scope === 'jake' || scope === 'ashley')) return 0;
  const o = (typeof x === 'object' && x.owners) || derivedOwners(farm, splits);
  return o[scope] || 0;
}

/**
 * The splits behind derived shares, from the last 12 months of the ledger:
 * Grain vs Cattle by each one's share of the farm's activity (money in and
 * out); household spending by who spends it — Jake, Ashley, or the farm
 * when it's paid from a farm account (a farm-paid card's purchases too).
 */
export async function ownerSplits(today = todayISO(), db = pool) {
  const [{ rows: lines }, payers] = await Promise.all([ // cardPayers gives a Map, not rows
    db.query(
      `SELECT l.amount, l.ledger, l.account_id, l.credit_card_id, l.segment, l.is_segment_split, l.segment_grain_pct, l.segment_livestock_pct,
              l.segment_jake_pct, l.segment_ashley_pct, a.ledger AS acct_ledger, a.segment AS acct_segment, a.is_segment_split AS acct_split,
              a.segment_grain_pct AS acct_g, a.segment_livestock_pct AS acct_l
       FROM transaction_lines l LEFT JOIN accounts a ON a.id = l.account_id
       WHERE NOT l.is_transfer AND NOT l.is_debt_service AND l.date > $1::date - 365 AND l.date <= $1::date`, [today]),
    cardPayers(db),
  ]);
  let grain = 0; let livestock = 0; let jake = 0; let ashley = 0; let unassigned = 0; let farmPaid = 0;
  for (const l of lines) {
    const amt = Math.abs(Number(l.amount));
    const w = ownerWeights(l);
    grain += amt * w.grain;
    livestock += amt * w.livestock;
    if (Number(l.amount) >= 0) continue;
    // Household spending: whose, unless the farm's account paid it.
    const personalPart = w.jake + w.ashley + (businessShare(l) < 0.5 ? w.unassigned : 0);
    if (personalPart <= 0) continue;
    const viaFarm = l.account_id
      ? businessShare({ ledger: l.acct_ledger, segment: l.acct_segment, is_segment_split: l.acct_split, segment_grain_pct: l.acct_g, segment_livestock_pct: l.acct_l }) >= 0.5
      : !!(l.credit_card_id && payers.get(l.credit_card_id));
    if (viaFarm) { farmPaid += amt * personalPart; continue; }
    jake += amt * w.jake;
    ashley += amt * w.ashley;
    if (businessShare(l) < 0.5) unassigned += amt * w.unassigned;
  }
  const f = grain + livestock;
  const own = jake + ashley;
  const t = own + unassigned + farmPaid;
  // Untagged personal spending goes to Jake and Ashley in the proportion they spend.
  const jr = own > 0 ? jake / own : 0.5;
  return {
    farm: f > 0 ? { grain: grain / f, livestock: livestock / f } : EVEN.farm,
    household: t > 0 ? { jake: (jake + unassigned * jr) / t, ashley: (ashley + unassigned * (1 - jr)) / t, farm: farmPaid / t } : EVEN.household,
  };
}

/** Cards whose payments come out of a farm account (the most recent payment's account): card id → true. */
async function cardPayers(db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (t.credit_card_id) t.credit_card_id, a.ledger, a.segment, a.is_segment_split, a.segment_grain_pct, a.segment_livestock_pct
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.credit_card_id IS NOT NULL AND t.account_id IS NOT NULL ORDER BY t.credit_card_id, t.date DESC, t.id DESC`);
  return new Map(rows.map((r) => [r.credit_card_id, businessShare(r) >= 0.5]));
}

/** What must be paid in [from, to) for a scope: total and by part. */
export function mustPayBetween(flows, from, to, scope, splits = EVEN) {
  const parts = { loans: 0, bills: 0, cards: 0, tax: 0, household: 0, fees: 0 };
  let total = 0;
  for (const f of flows) {
    if (f.date < from || f.date >= to || !mustPay(f)) continue;
    const amt = -f.amount * shareFor(scope, f, splits);
    if (amt < 0.005) continue;
    parts[FLOOR_PART[f.kind]] += amt;
    total += amt;
  }
  for (const k of Object.keys(parts)) parts[k] = r2(parts[k]);
  return { total: r2(total), parts };
}

export const norm = (s) => String(s || '').toLowerCase().trim();
export const groupKey = (commodity, unit) => `${norm(commodity)}|${norm(unit)}`;

/** 'YYYY-MM' → the 15th of that month. */
export const midMonth = (ym) => `${String(ym).slice(0, 7)}-15`;

/** Months in the window, from the current month. */
export function windowFor(months, today = todayISO()) {
  const [y0, m1] = today.split('-').map(Number);
  const m0 = m1 - 1;
  const meta = Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(y0, m0 + i, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  });
  const end = new Date(Date.UTC(y0, m0 + months, 1));
  const endStr = `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-01`;
  return { y0, m0, meta, endStr, today, months };
}

/** Tax year of a flow on the cash method: the year it moves (overdue items move now). */
export const taxYearOf = (date, today) => Number((date > today ? date : today).slice(0, 4));

/** Which known commodity an estimate is for: its commodity field, else a commodity named in it. */
function estimateCommodity(e, known) {
  if (e.commodity) return norm(e.commodity);
  const name = norm(e.name);
  return known.find((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(name)) || null;
}

/**
 * Everything the forecast needs, loaded once: accounts, the base flows
 * (no income tax), what tax is projected at, and the raw rows the what-if
 * engine works from.
 */
export async function loadForecast({ months = 12, today = todayISO() } = {}) {
  const win = windowFor(months, today);
  // Flows are loaded a few months past the window so the cash floor of the
  // last months can see what falls due after them; those extra flows are
  // kept apart (ctx.lookahead) and never enter a balance.
  const lwin = windowFor(months + LOOKAHEAD_MONTHS, today);
  const { endStr } = lwin;
  const { y0 } = win;

  const [accounts, billRows, loanRows, contractRows, cardRows, estimates, inv, sheet, taxY0, settings] = await Promise.all([
    pool.query(`SELECT id, name, ledger, account_type, opening_balance, fee_amount, fee_frequency, segment, is_segment_split,
                       segment_grain_pct, segment_livestock_pct, segment_jake_pct, segment_ashley_pct
                FROM accounts ORDER BY ledger, account_type, name`),
    pool.query(
      `SELECT b.*, p.name AS vendor, COALESCE((SELECT SUM(amount) FROM credit_applications WHERE bill_id = b.id), 0) AS applied,
              bill_owing(b, GREATEST(b.due_date, $2::date)) AS owing_at_due
       FROM bills b LEFT JOIN payees p ON p.id = b.payee_id
       WHERE b.status = 'unpaid' AND b.due_date < $1 ORDER BY b.due_date, b.id`, [endStr, today]),
    pool.query(
      `SELECT lp.id, lp.loan_id, lp.due_date, lp.principal_amount, lp.interest_amount, COALESCE(NULLIF(l.name, ''), l.lender) AS loan,
              l.interest_rate_pct, l.rate_type, l.purpose, l.segment, l.is_segment_split, l.segment_grain_pct, l.segment_livestock_pct,
              l.segment_jake_pct, l.segment_ashley_pct
       FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
       WHERE NOT lp.paid AND NOT lp.is_adjustment AND lp.due_date < $1
         -- A one-time bill that pays the loan off is in the forecast itself: the loan's payments from its due date on aren't.
         AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.loan_id = lp.loan_id AND b.status = 'unpaid' AND b.frequency = 'one_time' AND b.due_date <= lp.due_date)
       ORDER BY lp.due_date`, [endStr]),
    pool.query(
      `SELECT *, expected_payment_date AS due_date, GREATEST(total_value - received_amount, 0) AS amount
       FROM sale_contracts WHERE status IN ('open', 'delivered') ORDER BY expected_payment_date, id`),
    pool.query(
      `SELECT s.due_date, GREATEST(s.statement_balance - COALESCE(s.paid_amount, 0), 0) AS amount, cc.id AS card_id, cc.name AS card, cc.segment
       FROM (${LATEST_STATEMENTS_SQL}) s JOIN credit_cards cc ON cc.id = s.credit_card_id
       WHERE s.paid = false AND cc.status = 'active' AND s.due_date < $1`, [endStr]),
    activeEstimates(),
    inventorySales(),
    loadBalanceSheet(),
    farmIncomeTax(y0).catch((e) => { console.error('Tax projection unavailable for the forecast:', e.message); return null; }),
    Promise.all([
      getSetting('floor_window_days', FLOOR_DAYS),
      getSetting('floor_cap', FLOOR_CAP),
      getSetting(`tax_instalment_paid_${y0}`, null),
      getSetting(`tax_prior_year_owing_${y0}`, null),
      getSetting(`tax_instalment_paid_${y0 - 1}`, null),
      getSetting('gst_filing_frequency', 'quarterly'),
    ]),
  ]);
  const [floorDaysSetting, floorCapSetting, paidY0, priorOwingY0, paidPrev, gstFreq] = settings;
  const [splits, payers] = await Promise.all([ownerSplits(today), cardPayers()]);
  const own = (row) => ownersOf(row, splits);

  // ---- Inventory groups (what the what-if prices and quantities act on) ----
  const groups = new Map();
  const itemGroup = new Map();
  for (const g of sheet.inventoryGroups) {
    if (!['crop', 'market_livestock'].includes(g.item_class)) continue;
    const key = groupKey(g.commodity, g.unit);
    const prev = groups.get(key);
    const entry = prev || { key, commodity: g.commodity, unit: g.unit, item_class: g.item_class, on_hand: 0, uncontracted: 0, value: 0, priced_qty: 0, gross: 0 };
    entry.on_hand += g.on_hand;
    entry.uncontracted += g.uncontracted;
    entry.value += g.counted_value;
    for (const it of g.items) {
      itemGroup.set(it.id, key);
      if (it.effective_price != null) { entry.priced_qty += Number(it.quantity); entry.gross += Number(it.quantity) * it.effective_price; }
    }
    groups.set(key, entry);
  }
  for (const g of groups.values()) g.avg_price = g.priced_qty > 0 ? g.gross / g.priced_qty : null;
  const known = [...new Set([...[...groups.values()].map((g) => norm(g.commodity)), ...contractRows.rows.map((c) => norm(c.commodity))])]
    .filter(Boolean).sort((a, b) => b.length - a.length);

  const flows = [];
  const add = (f) => { if (Math.abs(f.amount) >= 0.005) flows.push({ estimate: false, taxable: 0, ref: {}, ...f, amount: r2(f.amount), taxable: r2(f.taxable || 0) }); };

  // Contracts: what's still to come (zero-rated: no GST), in pieces
  // (lib/contracts.js): a settlement ticket's net a few days after it, a
  // hauled load two weeks after delivery, the rest at the payment date.
  const PART_NOTE = { ticketed: 'settlement in', hauled: 'delivered — awaiting payment', open: null };
  for (const c of contractRows.rows) {
    const farm = businessShare({ segment: c.segment });
    const base = [c.commodity, c.counterparty].filter(Boolean).join(' — ');
    for (const p of contractParts(c, today)) {
      if (p.date >= endStr) continue;
      add({
        key: `contract:${c.id}${p.part === 'open' ? '' : `:${p.part}`}`, kind: 'contract',
        label: PART_NOTE[p.part] ? `${base} (${PART_NOTE[p.part]})` : base, date: p.date,
        amount: p.amount, farm, owners: own({ segment: c.segment }), taxable: p.amount * farm, overdue: p.date < today,
        ref: { contract_id: c.id, commodity: norm(c.commodity), part: p.part },
      });
    }
  }

  // Invoices the farm sent that aren't paid yet (Jake, Oct 26): money in on the due date (30 days
  // after the invoice without one); an overdue one counts now.
  const { rows: invoices } = await pool.query(
    `SELECT * FROM farm_documents WHERE kind = 'invoice' AND status = 'open'`).catch(() => ({ rows: [] }));
  for (const d of invoices) {
    const due = d.due_date ? toISODate(d.due_date) : addDays(toISODate(d.date), 30);
    if (due >= endStr) continue;
    const farm = businessShare(d);
    add({
      key: `invoice:${d.id}`, kind: 'receivable', label: `${d.number} — ${d.party_name}`, date: due < today ? today : due,
      amount: Number(d.total), farm, owners: own(d), taxable: Number(d.subtotal) * farm, overdue: due < today,
      ref: { invoice_id: d.id },
    });
  }

  // Rebates still to come (Jake, Oct 29): claimed or approved on their expected date; earning ones too, as
  // estimates. An overdue one counts now.
  const { rows: rebateRows } = await pool.query(
    `SELECT * FROM rebates WHERE status IN ('earning', 'claimed', 'approved') AND expected_date IS NOT NULL`).catch(() => ({ rows: [] }));
  for (const r of rebateRows) {
    const amt = r.amount != null ? Number(r.amount) : r.qualifying_spend != null && r.rate_pct != null ? Number(r.qualifying_spend) * Number(r.rate_pct) / 100 : 0;
    const due = toISODate(r.expected_date);
    if (!(amt > 0) || due >= endStr) continue;
    const farm = businessShare(r);
    add({
      key: `rebate:${r.id}`, kind: 'receivable', label: `Rebate — ${r.program}`, date: due < today ? today : due, amount: amt, farm, owners: own(r),
      taxable: amt * farm, overdue: due < today, estimate: r.status === 'earning', ref: { rebate_id: r.id },
    });
  }

  // Estimates (each occurrence from today) and uncontracted inventory sales. Quarter Section's crop plan less what's
  // already billed or contracted for its crop year (cropPlanNetting.js, Oct 30).
  const net = await loadNetting(estimates).catch(() => null);
  for (const e of estimates) {
    const farm = businessShare(e);
    const commodity = estimateCommodity(e, known);
    const planAmt = net ? net.amountOf(e) : null;
    if (planAmt != null && !(planAmt > 0)) continue;
    for (const d of occurrences(e, today, endStr)) {
      const amt = planAmt != null ? (e.direction === 'outflow' ? -planAmt : planAmt) : signedAmount(e);
      add({
        key: `est:${e.id}:${d}`, kind: amt >= 0 ? 'estimate_in' : 'estimate_out', label: e.name || e.commodity || 'Estimate', date: toISODate(d),
        amount: amt, farm, owners: own(e), taxable: amt * farm, estimate: true,
        ref: { estimate_id: e.id, commodity, category: e.category || null },
      });
    }
  }
  // Pay from paystubs: the next net pays, as expected income (personal).
  try {
    for (const f of await paystubForecastFlows({ today, endStr })) add({ ...f, owners: own({ segment: f.ref?.owner }) });
  } catch (e) { console.error('Paystub pays unavailable for the forecast:', e.message); }
  for (const it of inv.items) {
    const d = toISODate(it.start_date);
    if (d < today || d >= endStr) continue;
    const farm = businessShare(it);
    add({
      key: `inv:${it.inventory_id}`, kind: 'inventory', label: it.name, date: d, amount: Number(it.amount), farm, owners: own(it),
      taxable: Number(it.amount) * farm, estimate: true,
      ref: { inventory_id: it.inventory_id, group: itemGroup.get(it.inventory_id) || groupKey(it.commodity, ''), commodity: norm(it.commodity), basis: it.basis },
    });
  }

  // Bills: every unpaid bill in full (financed ones at what they'll owe on
  // the due date), plus later instances of recurring bills.
  for (const b of billRows.rows) {
    const farm = businessShare(b);
    const gst = b.has_gst ? Number(b.gst_amount || 0) : 0;
    const owing = Math.max(0, Number(b.owing_at_due) || 0);
    billDates(b, today, endStr).forEach((d, i) => {
      const amt = i === 0 ? owing : Number(b.amount);
      add({
        key: `bill:${b.id}:${d}`, kind: 'bill', label: b.name, date: d, amount: -amt, farm, owners: own(b),
        taxable: -(amt - gst) * farm, overdue: d < today,
        ref: { bill_id: b.id, first: i === 0, financed: !!b.is_financed, gst, category_id: b.category_id || null },
      });
    });
  }

  // Rent comes round every year: each landlord's next payments that no bill covers yet (rentProjection.js, Oct 30).
  const { rows: rentBills } = await pool.query(RENT_SQL).catch(() => ({ rows: [] }));
  for (const { bill: b, date: d } of projectRent(rentBills, today, endStr)) {
    const farm = businessShare(b);
    const amt = Number(b.amount) || 0;
    if (!(amt > 0)) continue;
    add({
      key: `rent:${b.id}:${d}`, kind: 'bill', label: `${b.name} (yearly rent)`, date: d, amount: -amt, farm, owners: own(b),
      taxable: -amt * farm, overdue: false, ref: { rent_from_bill: b.id, category_id: b.category_id || null },
    });
  }

  // AgriInvest: each program year's government match, worked out from its sales less its purchases (agriInvest.js, Oct 30).
  try {
    const [{ rows: act }, { rows: pids }] = await Promise.all([
      pool.query(ACTUAL_SQL, [`${Number(today.slice(0, 4)) - 1}-01-01`, today]),
      pool.query(PURCHASE_IDS_SQL),
    ]);
    const actual = Object.fromEntries(act.map((r) => [r.year, r]));
    for (const f of agriInvestFlows({ flows, actual, purchaseIds: new Set(pids.map((r) => Number(r.id))), today, endStr })) add(f);
  } catch (e) { console.error('AgriInvest unavailable for the forecast:', e.message); }

  // Loan payments: principal + interest; only the interest is deductible.
  for (const p of loanRows.rows) {
    const farm = businessShare(p);
    const d = toISODate(p.due_date);
    const interest = Number(p.interest_amount) || 0;
    add({
      key: `loan:${p.id}`, kind: 'loan', label: p.loan, date: d, amount: -(Number(p.principal_amount) + interest), farm, owners: own(p),
      taxable: -interest * farm, overdue: d < today,
      ref: { loan_id: p.loan_id, interest, principal: Number(p.principal_amount), rate: Number(p.interest_rate_pct), rate_type: p.rate_type, purpose: p.purpose },
    });
  }

  // Card statements still unpaid (the purchases were expenses when made).
  for (const c of cardRows.rows) {
    const d = toISODate(c.due_date);
    add({ key: `card:${c.card_id}:${d}`, kind: 'card', label: `${c.card} statement`, date: d, amount: -Number(c.amount),
      farm: businessShare({ segment: c.segment }), owners: own({ segment: c.segment }), overdue: d < today,
      ref: { card_id: c.card_id, paid_from_farm: !!payers.get(c.card_id) } });
  }

  // Charges since the last statement: what paying the card off will take
  // beyond the statement above. Due on the card's next due date (a cycle
  // after the last statement's), estimated until that statement is entered.
  const { rows: activeCards } = await pool.query(`SELECT * FROM credit_cards WHERE status = 'active'`);
  if (activeCards.length) {
    const [balances, { rows: latest }] = await Promise.all([cardBalances(pool, activeCards), pool.query(LATEST_STATEMENTS_SQL)]);
    const latestBy = new Map(latest.map((x) => [x.credit_card_id, x]));
    for (const c of activeCards) {
      const owed = balances.get(c.id)?.outstanding || 0;
      const st = latestBy.get(c.id);
      const onStatement = st && !st.paid ? Math.max(Number(st.statement_balance) - Number(st.paid_amount || 0), 0) : 0;
      const unbilled = r2(owed - onStatement);
      if (unbilled < 0.5) continue;
      let due = st ? addMonths(toISODate(st.due_date), 1) : addDays(today, 30);
      while (due < today) due = addMonths(due, 1);
      if (due >= endStr) continue;
      add({ key: `card-unbilled:${c.id}`, kind: 'card', label: `${c.name} — charges since the last statement`, date: due, amount: -unbilled,
        farm: businessShare({ segment: c.segment }), owners: own({ segment: c.segment }), estimate: true,
        ref: { card_id: c.id, unbilled: true, paid_from_farm: !!payers.get(c.id) } });
    }
  }

  // Account fees: monthly fees every month; annual ones spread across the year.
  for (const a of accounts.rows) {
    const fee = Number(a.fee_amount) || 0;
    if (!fee || !['monthly', 'annual'].includes(a.fee_frequency)) continue;
    const perMonth = a.fee_frequency === 'monthly' ? fee : fee / 12;
    const farm = businessShare(a);
    lwin.meta.forEach((m, i) => {
      let d = `${m.year}-${pad(m.month)}-28`;
      if (i === 0 && d < today) d = today;
      add({ key: `fee:${a.id}:${m.year}-${m.month}`, kind: 'fee', label: `Account fees — ${a.name}`, date: d, amount: -perMonth, farm, owners: own(a), taxable: -perMonth * farm });
    });
  }

  // GST refunds and payments.
  for (const f of await gstFlows(lwin)) add(f);

  // Household spending is one budget line a month, added at the end (householdBudget, below): a share of
  // the room above the cash floor. The history-based estimate is gone (Jake, Oct 24: it double counted bills).
  let personal = null;

  const accountRows = accounts.rows.map((a) => ({
    id: a.id, name: a.name, ledger: a.ledger, type: a.account_type, balance: Number(a.opening_balance),
    farm: businessShare(a), owners: own(a),
  }));
  // Everything else (GST, tax, household spending) from its farm share and the splits.
  for (const f of flows) if (!f.owners) f.owners = derivedOwners(f.farm, splits);

  // Income tax: this year's projection from the Tax tab; next year assumed
  // like this year unless a scenario says otherwise.
  const netY0 = taxY0 ? taxY0.projected.net_income : null;
  const inWindow = (d) => toISODate(d) < win.endStr;
  const floorDays = Math.min(MAX_FLOOR_DAYS, Math.max(14, Number(floorDaysSetting) || FLOOR_DAYS));
  const floorCap = Number.isFinite(Number(floorCapSetting)) && Number(floorCapSetting) >= 0 ? Number(floorCapSetting) : FLOOR_CAP;

  // The household budget: everything the household spends that isn't a bill, a loan or a card statement, as
  // one line a month. Jake, Oct 30: "take my balance at end of August 2027 and divide it by the number of months
  // till August. That's how much discretionary spending I have." So: with every other item in and no household
  // spending, the balance at the end of the next August (the low before harvest money comes in) ÷ the months
  // from this one to it, times the share (setting household_budget_share, all of it unless set), rounded down
  // to $10. (Before, Oct 24: the smallest room above the floor ÷ months-to-it, 90% of it.) The budget isn't
  // must-pay, so the floor doesn't move with it. This month it's what's left after what's been spent.
  try {
    const share = Math.min(1, Math.max(0, Number(await getSetting('household_budget_share', 1)) || 1));
    const base = { win, today, accounts: accountRows, splits, floorDays, floorCap, lookahead: flows.filter((f) => !inWindow(f.date)) };
    const ev0 = evaluate(flows.filter((f) => inWindow(f.date)), base, { scope: 'everything' });
    const { room, bindingIdx, perMonth, months: monthsLeft, until } = householdBudget(ev0.trajectory.map((t) => t.balance), share, win.meta, today);
    const spent = await householdSpentThisMonth(today);
    // Each month's budget as it stands, kept for the tracker on the Personal page (Jake, Oct 30: "a discretionary
    // budget for each month and a tracker to determine if I surpassed it"). The last figure in a month stands.
    if (today === todayISO()) {
      await pool.query(`INSERT INTO settings (key, value) VALUES ('household_budget_by_month', jsonb_build_object($1::text, $2::numeric))
        ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`, [today.slice(0, 7), perMonth]).catch(() => {});
    }
    win.meta.forEach((m, i) => {
      const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
      // This month: what's left of it (the balance it's worked from already has this month's spending in it); the
      // months after it in full, through August (the one after August's month-end isn't the budget's).
      const amt = i === 0 ? perMonth * Math.max(0, Math.min(1, (daysIn(m) - Number(today.slice(8, 10)) + 1) / MONTH_DAYS)) : perMonth;
      if (amt < 0.5) return;
      flows.push({
        key: `personal:budget:${key}`, kind: 'personal', label: 'Household budget', date: i === 0 ? today : `${key}-15`,
        amount: -r2(amt), farm: 0, estimate: true, taxable: 0, ref: { bucket: 'budget' }, owners: derivedOwners(0, splits),
      });
    });
    const worst = ev0.trajectory.reduce((k, t, i) => (t.headroom < ev0.trajectory[k].headroom ? i : k), 0);
    personal = {
      per_month: perMonth, share, room: r2(Math.max(0, room)), spent_this_month: r2(spent),
      binding: bindingIdx >= 0 ? { year: win.meta[bindingIdx].year, month: win.meta[bindingIdx].month, months_to_it: Math.round(monthsLeft * 100) / 100, until } : null,
      // Even with no household spending, cash goes below the floor here.
      shortfall: room < 0 ? { year: win.meta[worst].year, month: win.meta[worst].month, amount: r2(-ev0.trajectory[worst].headroom) } : null,
    };
  } catch (e) {
    console.error('Household budget unavailable for the forecast:', e.message);
  }

  return {
    win, today, flows: flows.filter((f) => inWindow(f.date)), lookahead: flows.filter((f) => !inWindow(f.date)), accounts: accountRows, groups, known, personal, splits,
    bills: billRows.rows.filter((b) => inWindow(b.due_date)), loans: loanRows.rows.filter((l) => inWindow(l.due_date)), contracts: contractRows.rows, estimates,
    inventory: inv, floorDays, floorCap, gstFreq: String(gstFreq || 'quarterly'),
    tax: {
      available: !!taxY0, netY0, taxY0: taxY0 ? taxY0.projected.tax.total : null,
      paidY0: paidY0 || null, priorOwingY0: priorOwingY0 != null ? Number(priorOwingY0) : null, paidPrev: paidPrev || null,
      instalmentY0: taxY0 ? taxY0.instalment : null,
    },
  };
}

/**
 * The household budget (pure — exported for tests): the month-end balance with no household spending at the
 * next August (not this month's; the last month in the window if no August is in it) ÷ the months from this one
 * to it, times `share`, rounded down to $10. `meta` is [{ year, month }] for each balance.
 */
export function householdBudget(balances, share = 1, meta = [], today = null) {
  if (!balances.length) return { room: 0, bindingIdx: -1, perMonth: 0, months: 0, until: null };
  let bindingIdx = meta.findIndex((m, i) => i >= 1 && m.month === 8);
  if (bindingIdx < 0 || bindingIdx >= balances.length) bindingIdx = balances.length - 1;
  // Jake, Oct 31: "the balance as of august 30th 2027 divided by the remaining months till august 30th 2027" — the
  // months left counted in days (Oct 31 to Aug 30 is 303 days, 9.95 months), not whole months.
  const m = meta[bindingIdx];
  const until = m ? `${m.year}-${String(m.month).padStart(2, '0')}-${m.month === 8 ? '30' : String(daysIn(m)).padStart(2, '0')}` : null;
  const months = today && until ? Math.max(0.5, (Date.parse(`${until}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400e3 / MONTH_DAYS) : bindingIdx + 1;
  const room = balances[bindingIdx] / months;
  const perMonth = room > 0 ? Math.floor((room * share) / 10) * 10 : 0;
  return { room, bindingIdx, perMonth, months, until };
}
const MONTH_DAYS = 365.25 / 12;
function daysIn(m) { return new Date(Date.UTC(m.year, m.month, 0)).getUTCDate(); }

/**
 * GST refunds and payments for every return not yet settled: a filed
 * return at its filed net (a refund about 30 days after filing); a past
 * quarter not filed yet at its net from the ledger; the current quarter
 * projected from its pace so far; later quarters at the average of the
 * quarters already closed. Refunds land about two weeks after the due date.
 */
export async function gstFlows(win) {
  const { today, endStr, y0 } = win;
  const out = [];
  const freq = String(await getSetting('gst_filing_frequency', 'quarterly'));
  const report = await gstReport(y0);
  const closed = report.periods.filter((p) => p.end < today && (p.purchases > 0 || p.collected > 0));
  const recent = closed.slice(-4);
  const avg = recent.length ? recent.reduce((s, p) => s + p.net, 0) / recent.length : null;
  const later = [];
  for (let y = y0 + 1; `${y}-01-01` < endStr; y++) later.push(...gstPeriods(y, freq).map((p) => ({ ...p, status: 'future', net: null })));
  const when = (p, net) => {
    const base = net < 0 ? addDays(p.due, 14) : p.due;
    return base < today ? today : base;
  };
  const push = (p, amount, date, estimate, note) => {
    if (Math.abs(amount) < 1 || date >= endStr) return;
    out.push({
      key: `gst:${p.start}`, kind: 'gst', label: `GST ${amount > 0 ? 'refund' : 'payment'} — ${p.label}${note ? ` (${note})` : ''}`,
      date, amount, farm: 1, taxable: 0, estimate, ref: { period_start: p.start, refund: amount > 0 },
    });
  };
  for (const p of [...report.periods, ...later]) {
    if (p.status === 'settled') continue;
    if (p.filed_on && p.filed_net != null) {
      const d = p.filed_net < 0 ? addDays(p.filed_on, 30) : p.due;
      push(p, -p.filed_net, d < today ? today : d, false, 'filed');
    } else if (p.end < today) {
      push(p, -p.net, when(p, p.net), true, 'not filed yet');
    } else if (p.start <= today) {
      const f = (dayNum(today) - dayNum(p.start) + 1) / (dayNum(p.end) - dayNum(p.start) + 1);
      const proj = f >= 0.25 ? p.net / f : (avg ?? p.net / 0.25);
      push(p, -proj, when(p, proj), true, 'projected');
    } else if (avg != null) {
      push(p, -avg, when(p, avg), true, 'estimate');
    }
  }
  // Filed returns from earlier years still waiting on their refund or payment.
  const { rows: prior } = await pool.query(
    `SELECT * FROM gst_returns WHERE settlement_transaction_id IS NULL AND filed_on IS NOT NULL AND period_start < $1`, [`${y0}-01-01`]);
  for (const r of prior) {
    const start = toISODate(r.period_start);
    const net = Number(r.net_amount);
    const due = addMonths(`${toISODate(r.period_end).slice(0, 7)}-01`, 2);
    const d = net < 0 ? addDays(toISODate(r.filed_on), 30) : due;
    push({ start, label: `${start.slice(0, 7)} return`, due }, -net, d < today ? today : d, false, 'filed');
  }
  return out;
}

/** The Dec 31 instalment farmers pay: two-thirds of this year's tax, or of last year's if less; none under $3,000. */
export function instalmentFor(tax, priorTax) {
  if (!(tax > 3000)) return 0;
  const est = tax * 2 / 3;
  return priorTax != null ? Math.min(est, Math.max(0, priorTax) * 2 / 3) : est;
}

/**
 * Income tax as cash: last year's balance on Apr 30 (if still ahead), this
 * year's Dec 31 instalment and its balance (or refund) next spring.
 * `taxByYear` is tax + CPP per year from this year on.
 *
 * Later years' income isn't in the forecast (next year's crop isn't
 * forecast yet), so their tax isn't either — except what a scenario
 * changes: with `planTaxes` (the plan's tax per year), a later year shows
 * only the difference, on its instalment and balance dates. That's how
 * deferring a sale into next year shows next year's extra tax.
 * `method`: 'plan' pays this year's instalment; 'skip' pays it all in
 * April plus instalment interest at `prescribedRate`.
 */
export function buildTaxFlows(ctx, taxByYear, { method = 'plan', prescribedRate = 7, planTaxes = null } = {}) {
  const { win, today, tax: t } = ctx;
  const { y0, endStr } = win;
  const out = [];
  const add = (key, label, date, amount) => {
    if (Math.abs(amount) < 1 || date < today || date >= endStr) return;
    out.push({ key, kind: 'tax', label, date, amount: r2(amount), farm: 1, taxable: 0, estimate: true, ref: {} });
  };
  if (today <= `${y0}-04-30` && t.priorOwingY0 != null) {
    add(`tax:bal:${y0 - 1}`, `Income tax balance — ${y0 - 1}`, `${y0}-04-30`, -(t.priorOwingY0 - (Number(t.paidPrev?.amount) || 0)));
  }
  // This year, in full.
  const tax0 = taxByYear[y0];
  if (tax0 != null) {
    const planned = instalmentFor(tax0, t.priorOwingY0);
    const paid = t.paidY0 ? Number(t.paidY0.amount) || 0 : null;
    const instalment = paid != null ? paid : method === 'skip' ? 0 : planned;
    if (paid == null) add(`tax:inst:${y0}`, `Income tax instalment — ${y0}`, `${y0}-12-31`, -instalment);
    const interest = paid == null && method === 'skip' ? planned * (prescribedRate / 100) * 120 / 365 : 0;
    const balance = tax0 - instalment + interest;
    if (balance >= 0) add(`tax:bal:${y0}`, `Income tax balance — ${y0}${interest ? ' (incl. instalment interest)' : ''}`, `${y0 + 1}-04-30`, -balance);
    else add(`tax:refund:${y0}`, `Income tax refund — ${y0}`, `${y0 + 1}-06-15`, -balance);
  }
  // Later years: only what changes against the plan.
  const plan = planTaxes || taxByYear;
  for (let y = y0 + 1; y <= y0 + 2; y++) {
    const tx = taxByYear[y];
    const pl = plan[y];
    if (tx == null || pl == null || Math.abs(tx - pl) < 1) continue;
    const inst = instalmentFor(tx, taxByYear[y - 1]) - instalmentFor(pl, plan[y - 1]);
    add(`tax:inst:${y}`, `Income tax instalment — ${y}, change from what-if`, `${y}-12-31`, -inst);
    add(`tax:bal:${y}`, `Income tax balance — ${y}, change from what-if`, `${y + 1}-04-30`, -((tx - pl) - inst));
  }
  return out;
}

/** Tax + CPP per year from net farm income per year. */
export function taxesFor(netByYear) {
  const out = {};
  for (const [y, net] of Object.entries(netByYear)) out[y] = net == null ? null : personalTax(net, Number(y)).total;
  return out;
}

/** What share of a flow (or account) a scope sees. */
export const scopeShare = (scope, x, splits) => shareFor(scope, x, splits);

/**
 * Buckets flows into the window's months for a scope, from the cash in the
 * chosen accounts. Returns the opening cash and one entry per month.
 */
export function evaluate(flows, ctx, { scope = 'everything', accountIds = null } = {}) {
  const { win } = ctx;
  const { meta, endStr, y0, m0 } = win;
  const n = meta.length;
  const pick = accountIds ? new Set(accountIds.map(Number)) : null;
  const opening = r2(ctx.accounts.filter((a) => !pick || pick.has(a.id)).reduce((s, a) => s + a.balance * shareFor(scope, a, ctx.splits), 0));
  const months = meta.map((m) => ({
    year: m.year, month: m.month, items: [],
    contractInflows: 0, estimatedInflows: 0, unpaidBillsDue: 0, debtServiceDue: 0, creditCardDue: 0, accountFees: 0,
    estimatedOutflows: 0, taxInstalment: 0, gst: 0, personalSpending: 0, other: 0,
  }));
  for (const f of flows) {
    if (f.date >= endStr) continue;
    const share = shareFor(scope, f, ctx.splits);
    const amount = r2(f.amount * share);
    if (Math.abs(amount) < 0.005) continue;
    const i = Math.min(Math.max(0, monthIndex(f.date, y0, m0)), n - 1);
    const m = months[i];
    m.items.push({ ...f, amount });
    switch (f.kind) {
      case 'contract': case 'receivable': m.contractInflows += amount; break;
      case 'estimate_in': case 'inventory': m.estimatedInflows += amount; break;
      case 'estimate_out': m.estimatedOutflows -= amount; break;
      case 'bill': m.unpaidBillsDue -= amount; break;
      case 'loan': case 'lease': m.debtServiceDue -= amount; break;
      case 'card': m.creditCardDue -= amount; break;
      case 'fee': m.accountFees -= amount; break;
      case 'tax': m.taxInstalment -= amount; break;
      case 'gst': m.gst += amount; break;
      case 'personal': m.personalSpending -= amount; break;
      default: m.other += amount;
    }
  }
  let bal = opening;
  let com = opening;
  const trajectory = months.map((m) => {
    const inflow = r2(m.items.filter((x) => x.amount > 0).reduce((s, x) => s + x.amount, 0));
    const outflow = r2(m.items.filter((x) => x.amount < 0).reduce((s, x) => s + x.amount, 0));
    const committedNet = m.items.filter((x) => !x.estimate).reduce((s, x) => s + x.amount, 0);
    const open = bal;
    bal = r2(bal + inflow + outflow);
    com = r2(com + committedNet);
    m.items.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    return { ...m, open, inflow, outflow, balance: bal, committedBalance: com };
  });
  // The floor at each month-end: what must be paid in the days after it.
  const days = ctx.floorDays || FLOOR_DAYS;
  const cap = ctx.floorCap ?? Infinity;
  const all = [...flows, ...(ctx.lookahead || [])];
  trajectory.forEach((t, i) => {
    const next = i + 1 < n ? `${meta[i + 1].year}-${pad(meta[i + 1].month)}-01` : endStr;
    const f = mustPayBetween(all, next, addDays(next, days), scope, ctx.splits);
    t.floorDue = f.total; // everything due in the window, before the cap
    t.floor = r2(Math.min(f.total, cap));
    t.floorParts = f.parts;
    t.headroom = r2(t.balance - t.floor);
  });
  // Today's floor: everything overdue plus what falls due in the next `days`.
  const now = mustPayBetween(all, '0000-01-01', addDays(ctx.today || todayISO(), days), scope, ctx.splits);
  const lowIdx = trajectory.reduce((k, t, i) => (t.balance < trajectory[k].balance ? i : k), 0);
  const tightIdx = trajectory.reduce((k, t, i) => (t.headroom < trajectory[k].headroom ? i : k), 0);
  return {
    opening, trajectory, lowIdx, low: trajectory[lowIdx].balance, end: trajectory[n - 1].balance,
    tightIdx, floorDays: days, floorCap: Number.isFinite(cap) ? cap : null, floorNow: r2(Math.min(now.total, cap)), floorNowParts: now.parts,
  };
}

/** Base tax per year (this year from the Tax tab; next years like this year). */
export function baseNetByYear(ctx, nextYearNet = null) {
  const { y0 } = ctx.win;
  const n0 = ctx.tax.netY0;
  if (n0 == null) return null;
  const n1 = nextYearNet != null && nextYearNet !== '' ? Number(nextYearNet) : n0;
  return { [y0]: n0, [y0 + 1]: n1, [y0 + 2]: n1 };
}

export const monthLabel = (m) => `${MONTH_NAMES[m.month - 1]} ${m.year}`;
