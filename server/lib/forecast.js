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
// (farm shares only) or Personal — from the cash in the chosen accounts.
// Income tax flows are built separately (buildTaxFlows) from a tax figure
// per year, so a scenario can re-work them.

import { pool, getSetting } from '../db.js';
import { occurrences, signedAmount, activeEstimates } from './estimates.js';
import { inventorySales } from './inventoryForecast.js';
import { loadBalanceSheet } from './balanceSheet.js';
import { businessShare } from './segments.js';
import { todayISO, toISODate, addMonths, addDays, monthIndex } from './dates.js';
import { LATEST_STATEMENTS_SQL } from './cardLedger.js';
import { farmIncomeTax, gstReport, gstPeriods } from './tax.js';
import { personalTax } from './taxRates.js';
import { billDates } from './billDates.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayNum = (d) => { const [y, m, dd] = toISODate(d).split('-').map(Number); return Date.UTC(y, m - 1, dd) / 86400000; };
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
  const { endStr, y0 } = win;

  const [accounts, billRows, loanRows, contractRows, cardRows, estimates, inv, sheet, taxY0, settings] = await Promise.all([
    pool.query(`SELECT id, name, ledger, account_type, opening_balance, fee_amount, fee_frequency, segment, is_segment_split,
                       segment_grain_pct, segment_livestock_pct, segment_jake_pct, segment_ashley_pct
                FROM accounts ORDER BY ledger, account_type, name`),
    pool.query(
      `SELECT b.*, p.name AS vendor, COALESCE((SELECT SUM(amount) FROM credit_applications WHERE bill_id = b.id), 0) AS applied,
              bill_owing(b, b.due_date) AS owing_at_due
       FROM bills b LEFT JOIN payees p ON p.id = b.payee_id
       WHERE b.status = 'unpaid' AND b.due_date < $1 ORDER BY b.due_date, b.id`, [endStr]),
    pool.query(
      `SELECT lp.id, lp.loan_id, lp.due_date, lp.principal_amount, lp.interest_amount, COALESCE(NULLIF(l.name, ''), l.lender) AS loan,
              l.interest_rate_pct, l.rate_type, l.purpose, l.segment, l.is_segment_split, l.segment_grain_pct, l.segment_livestock_pct,
              l.segment_jake_pct, l.segment_ashley_pct
       FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
       WHERE NOT lp.paid AND NOT lp.is_adjustment AND lp.due_date < $1 ORDER BY lp.due_date`, [endStr]),
    pool.query(
      `SELECT id, commodity, counterparty, quantity, unit, price_per_unit, expected_payment_date AS due_date, segment, status,
              GREATEST(total_value - received_amount, 0) AS amount
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
      getSetting('liquidity_buffer_pct', 0.15),
      getSetting(`tax_instalment_paid_${y0}`, null),
      getSetting(`tax_prior_year_owing_${y0}`, null),
      getSetting(`tax_instalment_paid_${y0 - 1}`, null),
    ]),
  ]);
  const [bufferPct, paidY0, priorOwingY0, paidPrev] = settings;

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

  // Contracts: what's still to come, at the expected payment date (zero-rated: no GST).
  for (const c of contractRows.rows) {
    const d = toISODate(c.due_date);
    if (d >= endStr) continue;
    const farm = businessShare({ segment: c.segment });
    add({
      key: `contract:${c.id}`, kind: 'contract', label: [c.commodity, c.counterparty].filter(Boolean).join(' — '), date: d,
      amount: Number(c.amount), farm, taxable: Number(c.amount) * farm, overdue: d < today,
      ref: { contract_id: c.id, commodity: norm(c.commodity) },
    });
  }

  // Estimates (each occurrence from today) and uncontracted inventory sales.
  for (const e of estimates) {
    const farm = businessShare(e);
    const commodity = estimateCommodity(e, known);
    for (const d of occurrences(e, today, endStr)) {
      const amt = signedAmount(e);
      add({
        key: `est:${e.id}:${d}`, kind: amt >= 0 ? 'estimate_in' : 'estimate_out', label: e.name || e.commodity || 'Estimate', date: toISODate(d),
        amount: amt, farm, taxable: amt * farm, estimate: true,
        ref: { estimate_id: e.id, commodity, category: e.category || null },
      });
    }
  }
  for (const it of inv.items) {
    const d = toISODate(it.start_date);
    if (d < today || d >= endStr) continue;
    const farm = businessShare(it);
    add({
      key: `inv:${it.inventory_id}`, kind: 'inventory', label: it.name, date: d, amount: Number(it.amount), farm,
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
        key: `bill:${b.id}:${d}`, kind: 'bill', label: b.name, date: d, amount: -amt, farm,
        taxable: -(amt - gst) * farm, overdue: d < today,
        ref: { bill_id: b.id, first: i === 0, financed: !!b.is_financed, gst, category_id: b.category_id || null },
      });
    });
  }

  // Loan payments: principal + interest; only the interest is deductible.
  for (const p of loanRows.rows) {
    const farm = businessShare(p);
    const d = toISODate(p.due_date);
    const interest = Number(p.interest_amount) || 0;
    add({
      key: `loan:${p.id}`, kind: 'loan', label: p.loan, date: d, amount: -(Number(p.principal_amount) + interest), farm,
      taxable: -interest * farm, overdue: d < today,
      ref: { loan_id: p.loan_id, interest, principal: Number(p.principal_amount), rate: Number(p.interest_rate_pct), rate_type: p.rate_type, purpose: p.purpose },
    });
  }

  // Card statements still unpaid (the purchases were expenses when made).
  for (const c of cardRows.rows) {
    const d = toISODate(c.due_date);
    add({ key: `card:${c.card_id}:${d}`, kind: 'card', label: `${c.card} statement`, date: d, amount: -Number(c.amount),
      farm: businessShare({ segment: c.segment }), overdue: d < today, ref: { card_id: c.card_id } });
  }

  // Account fees: monthly fees every month; annual ones spread across the year.
  for (const a of accounts.rows) {
    const fee = Number(a.fee_amount) || 0;
    if (!fee || !['monthly', 'annual'].includes(a.fee_frequency)) continue;
    const perMonth = a.fee_frequency === 'monthly' ? fee : fee / 12;
    const farm = businessShare(a);
    win.meta.forEach((m, i) => {
      let d = `${m.year}-${pad(m.month)}-28`;
      if (i === 0 && d < today) d = today;
      add({ key: `fee:${a.id}:${m.year}-${m.month}`, kind: 'fee', label: `Account fees — ${a.name}`, date: d, amount: -perMonth, farm, taxable: -perMonth * farm });
    });
  }

  // GST refunds and payments.
  for (const f of await gstFlows(win)) add(f);

  const accountRows = accounts.rows.map((a) => ({
    id: a.id, name: a.name, ledger: a.ledger, type: a.account_type, balance: Number(a.opening_balance),
    farm: businessShare(a),
  }));

  // Income tax: this year's projection from the Tax tab; next year assumed
  // like this year unless a scenario says otherwise.
  const netY0 = taxY0 ? taxY0.projected.net_income : null;
  return {
    win, today, flows, accounts: accountRows, groups, known,
    bills: billRows.rows, loans: loanRows.rows, contracts: contractRows.rows, estimates,
    inventory: inv, bufferPct: Number(bufferPct),
    tax: {
      available: !!taxY0, netY0, taxY0: taxY0 ? taxY0.projected.tax.total : null,
      paidY0: paidY0 || null, priorOwingY0: priorOwingY0 != null ? Number(priorOwingY0) : null, paidPrev: paidPrev || null,
      instalmentY0: taxY0 ? taxY0.instalment : null,
    },
  };
}

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
export const scopeShare = (scope, farm) => (scope === 'farm' ? farm : scope === 'personal' ? 1 - farm : 1);

/**
 * Buckets flows into the window's months for a scope, from the cash in the
 * chosen accounts. Returns the opening cash and one entry per month.
 */
export function evaluate(flows, ctx, { scope = 'everything', accountIds = null } = {}) {
  const { win } = ctx;
  const { meta, endStr, y0, m0 } = win;
  const n = meta.length;
  const pick = accountIds ? new Set(accountIds.map(Number)) : null;
  const opening = r2(ctx.accounts.filter((a) => !pick || pick.has(a.id)).reduce((s, a) => s + a.balance * scopeShare(scope, a.farm), 0));
  const months = meta.map((m) => ({
    year: m.year, month: m.month, items: [],
    contractInflows: 0, estimatedInflows: 0, unpaidBillsDue: 0, debtServiceDue: 0, creditCardDue: 0, accountFees: 0,
    estimatedOutflows: 0, taxInstalment: 0, gst: 0, other: 0,
  }));
  for (const f of flows) {
    if (f.date >= endStr) continue;
    const share = scopeShare(scope, f.farm);
    const amount = r2(f.amount * share);
    if (Math.abs(amount) < 0.005) continue;
    const i = Math.min(Math.max(0, monthIndex(f.date, y0, m0)), n - 1);
    const m = months[i];
    m.items.push({ ...f, amount });
    switch (f.kind) {
      case 'contract': m.contractInflows += amount; break;
      case 'estimate_in': case 'inventory': m.estimatedInflows += amount; break;
      case 'estimate_out': m.estimatedOutflows -= amount; break;
      case 'bill': m.unpaidBillsDue -= amount; break;
      case 'loan': m.debtServiceDue -= amount; break;
      case 'card': m.creditCardDue -= amount; break;
      case 'fee': m.accountFees -= amount; break;
      case 'tax': m.taxInstalment -= amount; break;
      case 'gst': m.gst += amount; break;
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
  const lowIdx = trajectory.reduce((k, t, i) => (t.balance < trajectory[k].balance ? i : k), 0);
  return { opening, trajectory, lowIdx, low: trajectory[lowIdx].balance, end: trajectory[n - 1].balance };
}

/** Required floor: a buffer on the average monthly outflow of the trailing 12 months. */
export async function requiredFloorFor(bufferPct) {
  const { rows: [r] } = await pool.query(
    `SELECT COALESCE(AVG(monthly_outflow), 0) AS avg FROM (
       SELECT date_trunc('month', date) AS m, SUM(-amount) AS monthly_outflow
       FROM transaction_lines
       WHERE amount < 0 AND is_transfer = false AND date >= CURRENT_DATE - INTERVAL '12 months'
       GROUP BY m) sub`);
  return Number(r.avg) * bufferPct;
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
