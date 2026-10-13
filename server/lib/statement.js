// The balance sheet: a classified statement of financial position, the way
// an accountant or a farm lender (FCC, the banks) draws one up — accrual
// basis, current vs long-term, assets at market value.
//
// CURRENT ASSETS (turn into cash within a year)
//   Cash and bank             accounts with money in them
//   Investment accounts       marketable — Wealthsimple and the like
//   Accounts receivable       contracts delivered and not paid in full
//   GST receivable            refunds on returns not yet settled
//   Deposits and prepayments  money paid to vendors and not used yet
//   Grain and feed inventory  on hand: under an open contract at the
//                             contract price, the rest at market
//   Market livestock          at market
// LONG-TERM ASSETS
//   Breeding livestock, land, buildings, machinery, vehicles, long-term
//   investments, other — valued today by each asset's yearly change %.
// CURRENT LIABILITIES (due within a year)
//   Bank overdraft            accounts below zero
//   Operating loans           all of it
//   Accounts payable          bills received and not paid (a recurring
//                             bill that hasn't landed yet isn't owed yet)
//   Credit cards
//   GST payable               on returns not yet settled
//   Accrued interest          on every loan since its last payment date,
//                             plus the interest in payments past due
//   Deposits on undelivered contracts   paid to you before delivery
//   Current portion of long-term debt   principal due in the next 12
//                             months, and anything past due
// LONG-TERM LIABILITIES
//   Term loans and mortgages, less the current portion
// EQUITY = total assets − total liabilities
//
// A loan stays owed until a payment is recorded as paid: a payment past
// its date and not recorded is still in the liability (and flagged), not
// assumed paid. Payments due before the loan was entered here are history
// and count as paid.
//
// By owner (Grain, Cattle, Jake, Ashley): each item counts at that owner's
// share. Cash is the owner's share derived from tagged flows (as on the
// equity card); a negative share is money owed to the other owners. GST
// belongs to the farm as a whole and shows on Combined only.

import { pool } from '../db.js';
import { OWNERS, ownerWeights } from './segments.js';
import { todayISO, toISODate, addMonths } from './dates.js';
import { loadBalanceSheet, inventoryOwnerRow } from './balanceSheet.js';
import { gstReport } from './tax.js';
import { billDate, rawOwing } from './vendorAccount.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const SECTIONS = [
  { key: 'current_assets', label: 'Current assets', lines: [
    ['cash', 'Cash and bank'], ['investment_accounts', 'Investment accounts'], ['receivables', 'Accounts receivable'],
    ['gst_receivable', 'GST receivable'], ['prepaid', 'Deposits and prepayments'], ['inventory_grain', 'Grain and feed inventory'],
    ['inventory_livestock', 'Market livestock'],
  ] },
  { key: 'longterm_assets', label: 'Long-term assets', lines: [
    ['breeding_livestock', 'Breeding livestock'], ['land', 'Land'], ['buildings', 'Buildings'], ['machinery', 'Machinery and equipment'],
    ['vehicles', 'Vehicles'], ['investments', 'Long-term investments'], ['other_assets', 'Other assets'],
  ] },
  { key: 'current_liabilities', label: 'Current liabilities', lines: [
    ['overdraft', 'Bank overdraft'], ['operating_loans', 'Operating loans'], ['payables', 'Accounts payable'], ['credit_cards', 'Credit cards'],
    ['gst_payable', 'GST payable'], ['accrued_interest', 'Accrued interest'], ['customer_deposits', 'Deposits on undelivered contracts'],
    ['current_ltd', 'Current portion of long-term debt'], ['due_to_owners', 'Owed to other owners'],
  ] },
  { key: 'longterm_liabilities', label: 'Long-term liabilities', lines: [
    ['term_debt', 'Term loans and mortgages'],
  ] },
];
const ASSET_LINE = { land: 'land', buildings: 'buildings', machinery: 'machinery', vehicles: 'vehicles',
  breeding_livestock: 'breeding_livestock', investments: 'investments', other: 'other_assets' };
const FARM_ONLY = { segment: null }; // GST: Combined only

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** Loans as the statement carries them: principal owing (paid rows only), current portion, accrued interest. */
export function loanPosition(loan, payments, today) {
  const in12 = addMonths(today, 12);
  // Payments that fell due before the loan was put into Money Hub are its
  // history: paid, just never recorded here. After that, a payment is paid
  // when it's recorded as paid.
  const entered = toISODate(loan.created_at) || today;
  const rows = payments.map((p) => {
    const due = toISODate(p.due_date);
    return { ...p, due, paid: p.paid || due < entered };
  });
  const paidPrincipal = rows.filter((p) => p.paid).reduce((s, p) => s + Number(p.principal_amount), 0);
  const owing = Math.max(0, Number(loan.principal) - paidPrincipal);
  const regular = rows.filter((p) => !p.is_adjustment && !p.is_extra);
  const unpaid = regular.filter((p) => !p.paid);
  const overdue = unpaid.filter((p) => p.due <= today);
  const operating = loan.purpose === 'operating';
  const dueIn12 = unpaid.filter((p) => p.due <= in12).reduce((s, p) => s + Number(p.principal_amount), 0);
  const current = operating ? owing : Math.min(owing, dueIn12);
  // Interest: what's in payments past due, plus simple interest on what's
  // owing from the later of the last payment date and the loan's start.
  const lastDue = regular.map((p) => p.due).filter((d) => d <= today).sort().pop() || null;
  const start = toISODate(loan.start_date);
  const from = [lastDue, start].filter(Boolean).sort().pop() || today;
  const days = Math.max(0, daysBetween(from, today));
  const sinceLast = owing * (Number(loan.interest_rate_pct) || 0) / 100 * days / 365;
  const overdueInterest = overdue.reduce((s, p) => s + Number(p.interest_amount || 0), 0);
  return {
    owing: r2(owing), current: r2(current), longterm: r2(owing - current), operating,
    accrued_interest: r2(sinceLast + overdueInterest), accrued_from: from,
    overdue_count: overdue.length, overdue_principal: r2(overdue.reduce((s, p) => s + Number(p.principal_amount), 0)),
  };
}

/** Everything the statement needs, loaded once; statementFor() then draws it for any owner. */
export async function loadStatement(today = todayISO()) {
  const year = Number(today.slice(0, 4));
  const [sheet, accounts, txSums, cashTx, pays, contracts, bills, credits, gstNow, gstPrev, priorGst] = await Promise.all([
    loadBalanceSheet(),
    pool.query('SELECT * FROM accounts ORDER BY name'),
    pool.query('SELECT account_id, COALESCE(SUM(amount), 0) AS total FROM transactions GROUP BY account_id'),
    pool.query(`SELECT amount, segment, is_segment_split, segment_grain_pct, segment_livestock_pct, segment_jake_pct, segment_ashley_pct
                FROM transaction_lines WHERE account_id IS NOT NULL`),
    pool.query('SELECT loan_id, due_date, principal_amount, interest_amount, paid, is_adjustment, is_extra FROM loan_payments'),
    pool.query(`SELECT id, commodity, counterparty, status, total_value, received_amount, delivery_date, segment
                FROM sale_contracts WHERE status IN ('open', 'delivered')`),
    pool.query(`SELECT b.*, p.name AS payee_name, COALESCE((SELECT SUM(amount) FROM credit_applications WHERE bill_id = b.id), 0) AS applied
                FROM bills b LEFT JOIN payees p ON p.id = b.payee_id WHERE b.status = 'unpaid'`),
    pool.query(`SELECT vc.*, p.name AS payee_name, p.segment, p.is_segment_split, p.segment_grain_pct, p.segment_livestock_pct,
                       p.segment_jake_pct, p.segment_ashley_pct,
                       vc.amount - COALESCE((SELECT SUM(amount) FROM credit_applications WHERE credit_id = vc.id), 0) AS remaining
                FROM vendor_credits vc JOIN payees p ON p.id = vc.payee_id WHERE vc.status = 'open'`),
    gstReport(year).catch(() => null),
    gstReport(year - 1).catch(() => null),
    pool.query(`SELECT * FROM gst_returns WHERE settlement_transaction_id IS NULL AND filed_on IS NOT NULL AND period_start < $1`, [`${year - 1}-01-01`]),
  ]);

  const items = []; // { line, name, amount, row (owner weights) }
  const notes = [];
  const add = (line, name, amount, row, extra = {}) => { if (Math.abs(Number(amount)) >= 0.005) items.push({ line, name, amount: r2(amount), row, ...extra }); };

  // Accounts (Combined): by type and sign.
  for (const a of accounts.rows) {
    const bal = Number(a.opening_balance);
    if (bal < 0) add('overdraft', a.name, -bal, a);
    else add(a.account_type === 'investment' ? 'investment_accounts' : 'cash', a.name, bal, a);
  }
  // Owner cash, derived from tagged flows (same as the equity card).
  const sums = new Map(txSums.rows.map((r) => [r.account_id, Number(r.total)]));
  const ownerCash = Object.fromEntries(OWNERS.map((o) => [o, 0]));
  for (const a of accounts.rows) {
    const starting = Number(a.opening_balance) - (sums.get(a.id) || 0);
    const w = ownerWeights(a);
    for (const o of OWNERS) ownerCash[o] += starting * w[o];
  }
  for (const t of cashTx.rows) {
    const w = ownerWeights(t);
    for (const o of OWNERS) ownerCash[o] += Number(t.amount) * w[o];
  }

  // Receivables and customer deposits.
  for (const c of contracts.rows) {
    const left = Number(c.total_value) - Number(c.received_amount);
    const name = [c.commodity, c.counterparty].filter(Boolean).join(' — ');
    if (c.status === 'delivered' && left > 0) add('receivables', name, left, { segment: c.segment });
    if (c.status === 'open' && Number(c.received_amount) > 0) add('customer_deposits', name, Number(c.received_amount), { segment: c.segment });
  }

  // GST: every return not settled, at its filed net if filed, else the ledger's net so far.
  for (const rep of [gstPrev, gstNow]) {
    for (const p of rep?.periods || []) {
      if (p.status === 'settled' || p.start > today) continue;
      const net = p.filed_net ?? p.net;
      const name = `${p.label}${p.status === 'current' ? ' (so far)' : p.status === 'filed' ? ' (filed)' : ''}`;
      if (net < 0) add('gst_receivable', name, -net, FARM_ONLY); else add('gst_payable', name, net, FARM_ONLY);
    }
  }
  for (const r of priorGst.rows) {
    const net = Number(r.net_amount);
    const name = `${toISODate(r.period_start).slice(0, 7)} return (filed)`;
    if (net < 0) add('gst_receivable', name, -net, FARM_ONLY); else add('gst_payable', name, net, FARM_ONLY);
  }

  // Payables: bills that have landed (received, or a recurring one that's come due), less deposits applied.
  let scheduled = 0;
  for (const b of bills.rows) {
    const owing = Math.max(0, rawOwing(b, today) - Number(b.applied || 0));
    if (billDate(b) > today) { scheduled += owing; continue; }
    add('payables', b.payee_name && !b.name.toLowerCase().startsWith(b.payee_name.toLowerCase()) ? `${b.payee_name} — ${b.name}` : b.name, owing, b, { due: toISODate(b.due_date) });
  }
  for (const c of credits.rows) add('prepaid', `${c.payee_name} — ${c.kind === 'refundable' ? 'refundable deposit' : 'prepayment'}`, Number(c.remaining), c);

  // Inventory.
  for (const i of sheet.inventoryRows) {
    const line = i.item_class === 'breeding_livestock' ? 'breeding_livestock' : i.item_class === 'market_livestock' ? 'inventory_livestock' : 'inventory_grain';
    const qty = `${Number(i.quantity).toLocaleString('en-CA')} ${i.unit}`;
    add(line, `${i.commodity} — ${qty}${i.contract_price != null ? ' (part at contract price)' : ''}`, i.book_value, inventoryOwnerRow(i));
  }
  const unpriced = sheet.inventoryGroups.reduce((s, g) => s + (g.needs_price || 0), 0);
  if (unpriced) notes.push(`${unpriced} inventory item${unpriced === 1 ? ' has' : 's have'} no price and count${unpriced === 1 ? 's' : ''} at $0.`);

  // Capital assets.
  for (const a of sheet.assets) add(ASSET_LINE[a.category] || 'other_assets', a.name, a.value_now, a);

  // Loans.
  const byLoan = new Map();
  for (const p of pays.rows) { if (!byLoan.has(p.loan_id)) byLoan.set(p.loan_id, []); byLoan.get(p.loan_id).push(p); }
  let overdueLoans = 0;
  for (const l of sheet.loans) {
    const pos = loanPosition(l, byLoan.get(l.id) || [], today);
    const name = l.name || l.lender;
    if (pos.operating) add('operating_loans', name, pos.owing, l);
    else { add('current_ltd', name, pos.current, l); add('term_debt', name, pos.longterm, l); }
    add('accrued_interest', name, pos.accrued_interest, l, { since: pos.accrued_from });
    if (pos.overdue_count) overdueLoans += pos.overdue_count;
  }
  if (overdueLoans) notes.push(`${overdueLoans} loan payment${overdueLoans === 1 ? ' is' : 's are'} past due and not recorded as paid — still counted as owing. Record them on the Loans tab if they went through.`);

  // Credit cards.
  for (const c of sheet.creditCards) add('credit_cards', c.name, c.outstanding, c);

  return { today, items, ownerCash, notes, scheduledBills: r2(scheduled) };
}

/** The statement for one owner ('all' = Combined). */
export function statementFor(loaded, entity = 'all') {
  const weight = (row) => (entity === 'all' ? 1 : ownerWeights(row || {})[entity] || 0);
  const lines = new Map();
  const put = (line, name, amount, extra = {}) => {
    if (Math.abs(amount) < 0.005) return;
    if (!lines.has(line)) lines.set(line, []);
    lines.get(line).push({ name, amount: r2(amount), ...extra });
  };
  for (const it of loaded.items) {
    if (entity !== 'all' && ['cash', 'investment_accounts', 'overdraft'].includes(it.line)) continue; // owners: cash below
    const { line, name, amount, row, ...extra } = it;
    put(line, name, amount * weight(row), extra);
  }
  if (entity !== 'all') {
    const c = loaded.ownerCash[entity] || 0;
    if (c >= 0) put('cash', 'Share of bank accounts', c);
    else put('due_to_owners', 'Cash carried by the other owners', -c);
  }
  const sections = SECTIONS.map((s) => {
    const out = s.lines.map(([key, label]) => {
      const list = (lines.get(key) || []).sort((a, b) => b.amount - a.amount);
      return { key, label, amount: r2(list.reduce((t, x) => t + x.amount, 0)), items: list };
    }).filter((l) => l.items.length);
    return { key: s.key, label: s.label, lines: out, total: r2(out.reduce((t, l) => t + l.amount, 0)) };
  });
  const tot = Object.fromEntries(sections.map((s) => [s.key, s.total]));
  const assets = r2(tot.current_assets + tot.longterm_assets);
  const liabilities = r2(tot.current_liabilities + tot.longterm_liabilities);
  const equity = r2(assets - liabilities);
  return {
    as_of: loaded.today, entity, sections,
    totals: { current_assets: tot.current_assets, longterm_assets: tot.longterm_assets, total_assets: assets,
      current_liabilities: tot.current_liabilities, longterm_liabilities: tot.longterm_liabilities, total_liabilities: liabilities, equity },
    // What lenders read off a balance sheet.
    ratios: {
      working_capital: r2(tot.current_assets - tot.current_liabilities),
      current_ratio: tot.current_liabilities > 0 ? r2(tot.current_assets / tot.current_liabilities) : null,
      debt_to_asset: assets > 0 ? r2(liabilities / assets) : null,
      debt_to_equity: equity > 0 ? r2(liabilities / equity) : null,
    },
    notes: [
      ...loaded.notes,
      ...(loaded.scheduledBills > 0 && entity === 'all' ? [`Bills not yet received (recurring ones still to come): $${Math.round(loaded.scheduledBills).toLocaleString('en-CA')} — not a liability until they land.`] : []),
      ...(entity !== 'all' ? ['GST is the farm’s as a whole and shows on Combined only.'] : []),
    ],
  };
}

/** Load and draw in one go. */
export async function balanceSheetStatement(entity = 'all', today = todayISO()) {
  return statementFor(await loadStatement(today), entity);
}

