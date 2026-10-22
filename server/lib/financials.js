// Financial statements for a period: the income statement by enterprise
// (Grain, Cattle, shared) on an accrual-adjusted basis, and the statement
// of cash flows. The balance sheet is lib/statement.js.
//
// INCOME STATEMENT — accrual-adjusted, the way a farm lender builds one
// from cash records:
//
//   cash income and expenses (the Income & Expenses rules: farm share
//   without GST, capital purchases and loan principal out, interest in)
//   + change in inventory      grain, feed and market cattle on hand at the
//                              end less at the start (breeding stock is a
//                              capital asset, not inventory)
//   + change in receivables    hauled grain not yet paid for
//   − change in payables       bills received and not yet paid
//   − change in accrued interest
//   − depreciation             capital assets' fall in value over the period
//   = net income (accrual)
//
// Owners: every line counts at its Grain and Cattle shares; the farm share
// that's tagged to neither is "Shared", in its own column — nothing guessed.
//
// Inventory needs a count at both ends. The end is today's inventory (or
// the daily record for a past date); the start is the record for the day
// before the period — taken automatically every day from now on — or a
// count entered by hand (the year-end count). With no count at the start,
// the change in inventory is left out and the statement says so.
//
// CASH FLOWS — the direct method, from the bank accounts themselves, so it
// always reconciles: every dollar in or out of an account in the period
// lands in exactly one line, and opening cash + the lines = closing cash.
// Transfers between your own accounts are left out (both sides net to 0).

import { pool } from '../db.js';
import { ownerWeights, businessShare } from './segments.js';
import { EARNING_COLUMNS, lineValue, lineAmounts } from './earnings.js';
import { toISODate, todayISO, addDays } from './dates.js';
import { loadBalanceSheet, assetValueAt, inventoryOwnerRow } from './balanceSheet.js';
import { billDate, rawOwing } from './vendorAccount.js';
import { loanPosition } from './statement.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const COLUMNS = ['grain', 'livestock', 'shared'];

/** A row's split across the statement's columns: Grain, Cattle, Shared (farm, untagged). Household shares drop out. */
export function farmSplit(row) {
  const w = ownerWeights(row);
  const farm = businessShare(row);
  return { grain: w.grain, livestock: w.livestock, shared: Math.max(0, farm - w.grain - w.livestock) };
}
const add = (acc, split, amount) => { for (const k of COLUMNS) acc[k] = (acc[k] || 0) + split[k] * amount; };
const zero = () => ({ grain: 0, livestock: 0, shared: 0 });
const total = (v) => r2(v.grain + v.livestock + v.shared);
const round = (v) => ({ grain: r2(v.grain), livestock: r2(v.livestock), shared: r2(v.shared), total: total(v) });
const minus = (a, b) => ({ grain: a.grain - b.grain, livestock: a.livestock - b.livestock, shared: a.shared - b.shared });
const INVENTORY_CLASSES = { crop: 'crop_feed', forage: 'crop_feed', other: 'crop_feed', market_livestock: 'market_livestock' };

// ---- Inventory records -----------------------------------------------------------

/** Today's inventory by class and owner, recorded once a day (a later run the same day replaces it). */
export async function recordInventory(today = todayISO()) {
  const sheet = await loadBalanceSheet();
  const sums = new Map();
  for (const i of sheet.inventoryRows) {
    const cls = INVENTORY_CLASSES[i.item_class];
    if (!cls) continue;
    const w = ownerWeights(inventoryOwnerRow(i));
    for (const [owner, f] of Object.entries(w)) {
      if (!f) continue;
      const k = `${cls}|${owner}`;
      sums.set(k, (sums.get(k) || 0) + Number(i.book_value || 0) * f);
    }
  }
  await pool.query(`DELETE FROM inventory_valuations WHERE date = $1 AND source = 'daily'`, [today]);
  for (const [k, v] of sums) {
    const [cls, owner] = k.split('|');
    await pool.query(`INSERT INTO inventory_valuations (date, item_class, owner, value, source) VALUES ($1, $2, $3, $4, 'daily')`, [today, cls, owner, r2(v)]);
  }
}

/** Inventory on a date by column, from a hand count on that date if there is one, else the last daily record on or before it within a week. */
async function inventoryAt(date) {
  const { rows: manual } = await pool.query(`SELECT * FROM inventory_valuations WHERE source = 'manual' AND date = $1`, [date]);
  let rows = manual;
  let basis = rows.length ? 'count entered' : null;
  if (!rows.length) {
    const { rows: [d] } = await pool.query(
      `SELECT max(date) AS d FROM inventory_valuations WHERE source = 'daily' AND date <= $1 AND date >= $1::date - 7`, [date]);
    if (d?.d) {
      ({ rows } = await pool.query(`SELECT * FROM inventory_valuations WHERE source = 'daily' AND date = $1`, [toISODate(d.d)]));
      basis = `daily record ${toISODate(d.d)}`;
    }
  }
  if (!rows.length) return null;
  const v = { crop_feed: zero(), market_livestock: zero() };
  for (const r of rows) {
    const split = r.owner === 'grain' ? { grain: 1, livestock: 0, shared: 0 }
      : r.owner === 'livestock' ? { grain: 0, livestock: 1, shared: 0 }
        : r.owner === 'unassigned' ? { grain: 0, livestock: 0, shared: 1 } : null;
    if (split && v[r.item_class]) add(v[r.item_class], split, Number(r.value));
  }
  return { ...v, basis };
}

// ---- Balances on a past date, rebuilt from the records ---------------------------

/** Hauled grain not yet paid for on a date. */
async function receivablesAt(date) {
  const { rows } = await pool.query(
    `SELECT c.*, COALESCE((SELECT SUM(t.amount) FROM contract_payments cp JOIN transactions t ON t.id = cp.transaction_id
                           WHERE cp.contract_id = c.id AND t.date <= $1), 0) AS paid_by
     FROM sale_contracts c WHERE c.status != 'cancelled'`, [date]);
  const v = zero();
  for (const c of rows) {
    const hauled = toISODate(c.delivered_on) || (['delivered', 'settled'].includes(c.status) ? toISODate(c.delivery_date) : null);
    if (!hauled || hauled > date) continue;
    const net = c.settlement_net != null ? Number(c.settlement_net) : Number(c.total_value) - Number(c.deductions_amount || 0);
    const owed = net - Number(c.paid_by);
    if (owed > 0.005) add(v, farmSplit({ segment: c.segment }), owed);
  }
  return v;
}

/** Bills received and not yet paid on a date, without the GST the farm gets back. */
async function payablesAt(date) {
  const { rows } = await pool.query(
    `SELECT b.*, COALESCE((SELECT SUM(amount) FROM credit_applications WHERE bill_id = b.id AND created_at::date <= $1), 0) AS applied,
            (SELECT t.date FROM transactions t WHERE t.id = b.linked_transaction_id) AS tx_date
     FROM bills b WHERE b.status = 'unpaid' OR COALESCE(b.paid_date, b.due_date) > $1`, [date]);
  const v = zero();
  for (const b of rows) {
    if (billDate(b) > date) continue;
    const paidOn = b.status === 'paid' ? toISODate(b.tx_date || b.paid_date) : null;
    if (paidOn && paidOn <= date) continue;
    const owing = Math.max(0, rawOwing(b, date) - Number(b.applied || 0));
    const gstShare = b.has_gst && Number(b.amount) ? Number(b.gst_amount || 0) / Number(b.amount) : 0;
    if (owing > 0.005) add(v, farmSplit(b), owing * (1 - gstShare));
  }
  return v;
}

/** Interest owed and not yet paid on every loan on a date. */
async function accruedInterestAt(date) {
  const [{ rows: loans }, { rows: pays }] = await Promise.all([
    pool.query('SELECT * FROM loans WHERE created_at::date <= $1', [date]),
    pool.query('SELECT loan_id, due_date, principal_amount, interest_amount, paid, paid_date, is_adjustment, is_extra FROM loan_payments'),
  ]);
  const v = zero();
  for (const l of loans) {
    const mine = pays.filter((p) => p.loan_id === l.id)
      .map((p) => ({ ...p, paid: p.paid && toISODate(p.paid_date || p.due_date) <= date }));
    const pos = loanPosition(l, mine, date);
    if (pos.accrued_interest > 0.005) add(v, farmSplit(l), pos.accrued_interest);
  }
  return v;
}

/** Capital assets' fall in value between two dates (appreciation, such as land, is not income). */
async function depreciation(from, to) {
  const { rows } = await pool.query('SELECT * FROM assets');
  const v = zero();
  const lines = [];
  for (const a of rows) {
    if (!(Number(a.annual_change_pct) < 0)) continue;
    const vd = toISODate(a.value_date);
    if (vd > to) continue;
    const start = vd > from ? vd : from;
    const drop = assetValueAt(a, start) - assetValueAt(a, to);
    if (drop > 0.005) {
      const split = farmSplit(a);
      add(v, split, drop);
      if (split.grain + split.livestock + split.shared > 0) lines.push({ name: a.name, amount: r2(drop * (split.grain + split.livestock + split.shared)) });
    }
  }
  return { v, lines: lines.sort((x, y) => y.amount - x.amount) };
}

// ---- Income statement ------------------------------------------------------------

/**
 * { from, to } → the statement: revenue and expense lines by parent
 * category, the accrual adjustments, net income, each with Grain /
 * Cattle / Shared / total.
 */
export async function incomeStatement({ from, to, today = todayISO() }) {
  const end = to < today ? to : today;
  const before = addDays(from, -1);
  const [{ rows: cats }, { rows: lines }] = await Promise.all([
    pool.query('SELECT id, name, parent_id, kind FROM expense_categories'),
    pool.query(
      `SELECT ${EARNING_COLUMNS}, l.category_id, l.date
       FROM transaction_lines l JOIN transactions t ON t.id = l.transaction_id
       LEFT JOIN loan_payments lp ON lp.linked_transaction_id = l.transaction_id
       WHERE l.is_transfer = false AND (l.is_debt_service = false OR l.split_id IS NOT NULL OR lp.id IS NOT NULL)
         AND l.date >= $1 AND l.date <= $2`, [from, end]),
  ]);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const parentOf = (id) => { const c = byId.get(id); return c?.parent_id && byId.has(c.parent_id) ? byId.get(c.parent_id) : c; };
  const revenue = new Map();
  const expense = new Map();
  let interest = zero();
  for (const l of lines) {
    if (l.is_capex) continue;
    const { net } = lineAmounts(l);
    if (Math.abs(net) < 0.005) continue;
    const split = farmSplit(l);
    if (split.grain + split.livestock + split.shared < 0.0001) continue;
    if (l.is_debt_service && l.split_id == null) { add(interest, split, -net); continue; }
    const c = l.category_id ? byId.get(l.category_id) : null;
    const kind = c ? c.kind : (net > 0 ? 'income' : 'expense');
    const p = c ? parentOf(c.id) : null;
    const key = p ? p.name : (kind === 'income' ? 'Uncategorized income' : 'Uncategorized expenses');
    const map = kind === 'income' ? revenue : expense;
    if (!map.has(key)) map.set(key, zero());
    add(map.get(key), split, kind === 'income' ? net : -net);
  }
  if (total(interest) > 0.005) {
    if (!expense.has('Interest')) expense.set('Interest', zero());
    const i = expense.get('Interest');
    for (const k of COLUMNS) i[k] += interest[k];
  }

  // Adjustments.
  const [invStart, invEnd, recStart, recEnd, payStart, payEnd, accStart, accEnd, dep] = await Promise.all([
    inventoryAt(before), end >= addDays(today, -1) ? currentInventory() : inventoryAt(end),
    receivablesAt(before), receivablesAt(end), payablesAt(before), payablesAt(end),
    accruedInterestAt(before), accruedInterestAt(end), depreciation(from, end),
  ]);
  const notes = [];
  const adjustments = { revenue: [], expense: [] };
  if (invStart && invEnd) {
    adjustments.revenue.push({ key: 'inventory_crop', label: 'Change in grain and feed inventory', ...round(minus(invEnd.crop_feed, invStart.crop_feed)),
      detail: `From ${invStart.basis} to ${invEnd.basis}` });
    adjustments.revenue.push({ key: 'inventory_cattle', label: 'Change in market cattle inventory', ...round(minus(invEnd.market_livestock, invStart.market_livestock)),
      detail: `From ${invStart.basis} to ${invEnd.basis}` });
  } else {
    notes.push({ key: 'no_opening_inventory', date: before,
      text: `No inventory count for ${before}, so the change in inventory is left out — net income below is before it. Enter the count for that day to complete it.` });
  }
  adjustments.revenue.push({ key: 'receivables', label: 'Change in grain hauled, not yet paid', ...round(minus(recEnd, recStart)) });
  adjustments.expense.push({ key: 'payables', label: 'Change in bills received, not yet paid', ...round(minus(payEnd, payStart)) });
  adjustments.expense.push({ key: 'accrued_interest', label: 'Change in interest owed, not yet paid', ...round(minus(accEnd, accStart)) });
  adjustments.expense.push({ key: 'depreciation', label: 'Depreciation', ...round(dep.v), items: dep.lines });

  const toLines = (m) => [...m].map(([label, v]) => ({ label, ...round(v) })).filter((x) => Math.abs(x.total) >= 0.005 || Math.abs(x.grain) + Math.abs(x.livestock) >= 0.005)
    .sort((a, b) => (a.label.startsWith('Uncategorized') ? 1 : b.label.startsWith('Uncategorized') ? -1 : b.total - a.total));
  const sumCols = (list) => {
    const s = zero();
    for (const x of list) for (const k of COLUMNS) s[k] += x[k];
    return round(s);
  };
  const revLines = toLines(revenue);
  const expLines = toLines(expense);
  const cashRevenue = sumCols(revLines);
  const cashExpenses = sumCols(expLines);
  const accrualRevenue = sumCols([cashRevenue, ...adjustments.revenue]);
  const accrualExpenses = sumCols([cashExpenses, ...adjustments.expense]);
  const net = (a, b) => ({ grain: r2(a.grain - b.grain), livestock: r2(a.livestock - b.livestock), shared: r2(a.shared - b.shared), total: r2(a.total - b.total) });
  return {
    from, to, through: end, basis: 'accrual-adjusted',
    revenue: { lines: revLines, cash_total: cashRevenue, adjustments: adjustments.revenue, total: accrualRevenue },
    expenses: { lines: expLines, cash_total: cashExpenses, adjustments: adjustments.expense, total: accrualExpenses },
    cash_net_income: net(cashRevenue, cashExpenses),
    net_income: net(accrualRevenue, accrualExpenses),
    complete: !!(invStart && invEnd),
    notes,
  };
}

async function currentInventory() {
  const sheet = await loadBalanceSheet();
  const v = { crop_feed: zero(), market_livestock: zero(), basis: 'inventory today' };
  for (const i of sheet.inventoryRows) {
    const cls = INVENTORY_CLASSES[i.item_class];
    if (cls) add(v[cls], farmSplit(inventoryOwnerRow(i)), Number(i.book_value || 0));
  }
  return v;
}

// ---- Cash flows ----------------------------------------------------------------

/** { from, to } → cash in and out of every bank account, by activity. */
export async function cashFlowStatement({ from, to, today = todayISO() }) {
  const end = to < today ? to : today;
  const [{ rows: accounts }, { rows: after }, { rows: txs }, { rows: gst }, { rows: draws }] = await Promise.all([
    pool.query('SELECT id, opening_balance FROM accounts'),
    pool.query('SELECT account_id, SUM(amount) AS s FROM transactions WHERE account_id IS NOT NULL AND date > $1 GROUP BY 1', [end]),
    pool.query(
      `SELECT t.*, lp.interest_amount, lp.principal_amount, c.kind AS category_kind, c.parent_id,
              (SELECT count(*) FROM transaction_splits s WHERE s.transaction_id = t.id) AS pieces
       FROM transactions t
       LEFT JOIN loan_payments lp ON lp.linked_transaction_id = t.id
       LEFT JOIN expense_categories c ON c.id = t.category_id
       WHERE t.account_id IS NOT NULL AND t.date >= $1 AND t.date <= $2`, [from, end]),
    pool.query('SELECT settlement_transaction_id AS id FROM gst_returns WHERE settlement_transaction_id IS NOT NULL'),
    pool.query('SELECT linked_transaction_id AS id FROM owner_draws WHERE linked_transaction_id IS NOT NULL'),
  ]);
  const gstTx = new Set(gst.map((r) => r.id));
  const drawTx = new Set(draws.map((r) => r.id));
  const afterBy = new Map(after.map((r) => [r.account_id, Number(r.s)]));
  const closing = accounts.reduce((s, a) => s + Number(a.opening_balance) - (afterBy.get(a.id) || 0), 0);
  const inPeriod = txs.reduce((s, t) => s + Number(t.amount), 0);
  const opening = closing - inPeriod;

  // Split pieces, for entries split between farm and household or that carry a capital piece.
  const ids = txs.filter((t) => t.is_split).map((t) => t.id);
  const { rows: pieces } = ids.length
    ? await pool.query('SELECT * FROM transaction_splits WHERE transaction_id = ANY($1::int[])', [ids]) : { rows: [] };
  const piecesOf = new Map();
  for (const p of pieces) { if (!piecesOf.has(p.transaction_id)) piecesOf.set(p.transaction_id, []); piecesOf.get(p.transaction_id).push(p); }

  const L = {
    farm_receipts: 0, farm_payments: 0, interest_paid: 0, card_payments: 0, gst: 0,
    capital_purchases: 0, capital_sales: 0,
    loan_principal: 0, other_transfers: 0, owner_draws: 0, household: 0,
  };
  for (const t of txs) {
    const amt = Number(t.amount);
    if (t.is_transfer && t.transfer_peer_id) continue; // between your own accounts
    if (gstTx.has(t.id)) { L.gst += amt; continue; }
    if (drawTx.has(t.id)) { L.owner_draws += amt; continue; }
    if (t.credit_card_id) { L.card_payments += amt; continue; } // paying a card from the bank
    if (t.is_debt_service) {
      const i = t.interest_amount != null ? -Number(t.interest_amount) : 0;
      L.interest_paid += i * businessShare(t);
      L.household += i * (1 - businessShare(t));
      L.loan_principal += amt - i;
      continue;
    }
    if (t.is_transfer) { L.other_transfers += amt; continue; }
    const parts = t.is_split ? (piecesOf.get(t.id) || []) : [t];
    for (const p of parts) {
      const a = Number(p.amount);
      if (p.is_transfer) { L.other_transfers += a; continue; }
      if (p.is_capex) { if (a < 0) L.capital_purchases += a; else L.capital_sales += a; continue; }
      const farm = businessShare(p);
      if (a >= 0) L.farm_receipts += a * farm; else L.farm_payments += a * farm;
      L.household += a * (1 - farm);
    }
  }
  const sec = (key, label, rows) => {
    const lines = rows.map(([k, lab]) => ({ key: k, label: lab, amount: r2(L[k]) })).filter((x) => Math.abs(x.amount) >= 0.005);
    return { key, label, lines, total: r2(lines.reduce((s, x) => s + x.amount, 0)) };
  };
  const sections = [
    sec('operating', 'Operating activities', [
      ['farm_receipts', 'Received from sales and other farm income'], ['farm_payments', 'Paid for farm expenses'],
      ['card_payments', 'Credit card payments'], ['interest_paid', 'Interest paid'], ['gst', 'GST refunded or remitted'],
    ]),
    sec('investing', 'Investing activities', [
      ['capital_purchases', 'Capital purchases'], ['capital_sales', 'Proceeds from selling capital assets'],
    ]),
    sec('financing', 'Financing activities', [
      ['loan_principal', 'Loan principal repaid'], ['other_transfers', 'Loans received and other transfers in or out'],
      ['owner_draws', 'Owner draws'], ['household', 'Household spending and income'],
    ]),
  ];
  const change = r2(sections.reduce((s, x) => s + x.total, 0));
  return {
    from, to, through: end,
    opening_cash: r2(opening), sections, net_change: change, closing_cash: r2(closing),
    reconciles: Math.abs(opening + change - closing) < 0.01,
  };
}
