import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { OWNERS, ownerWeights } from '../lib/segments.js';
import { occurrences, signedAmount } from '../lib/estimates.js';
import { forecastEstimates } from '../lib/inventoryForecast.js';
import { cardAmountsDue } from '../lib/cardLedger.js';
import { loadBalanceSheet, inventoryOwnerRow } from '../lib/balanceSheet.js';
import { todayISO, addMonths, monthIndex } from '../lib/dates.js';
import { billDates } from '../lib/calculations.js';
import { farmIncomeTax } from '../lib/tax.js';

const router = Router();
const HORIZON = 12;

/**
 * The three headline numbers for one owner (grain / livestock / jake /
 * ashley) or for everything combined ('all').
 *
 * CASH — derived from tagged flows: an owner's share of each account's
 * STARTING balance (before any transactions were recorded there, owned per
 * the account's owner tag) + every transaction tagged to them since. Every
 * row's weights sum to 1 (untagged → 'unassigned'), so the four owners
 * plus unassigned reconcile exactly to Combined. An enterprise's cash CAN
 * go negative — that's it being carried by someone else's money.
 *
 * CASH FLOW — two 12-month projections from that cash:
 *   committed:      contracts, bills, loan schedules, account fees
 *   withEstimates:  committed + the owner's active cash estimates (default)
 * Overdue committed items land in the current month; past-dated estimate
 * occurrences drop out (an estimate nobody is owed can't be overdue).
 *
 * EARNINGS YTD — Jan 1 to today: every transaction tagged to the owner,
 * except capital purchases (an asset, not an expense) and the principal
 * portion of loan payments (repaying principal isn't a cost; interest is).
 * No depreciation yet. For Jake/Ashley it reads as net savings.
 *
 * EQUITY — cash + capital assets (valued today by their appreciation/CCA
 * rate) + uncontracted inventory at estimated market price − outstanding
 * loan principal. Contracted grain is counted once, as the contract's
 * receivable in cash flow, never also as inventory.
 */
router.get('/', ah(async (req, res) => {
  const entity = String(req.query.entity || 'all');
  if (entity !== 'all' && !OWNERS.includes(entity)) {
    return res.status(400).json({ error: `entity must be all, ${OWNERS.join(', ')}` });
  }
  const w = (row) => (entity === 'all' ? 1 : ownerWeights(row)[entity]);
  const wUnassigned = (row) => ownerWeights(row).unassigned;

  const today = todayISO();
  const [y0, m1] = today.split('-').map(Number);
  const m0 = m1 - 1;
  const endStr = addMonths(`${today.slice(0, 7)}-01`, HORIZON); // exclusive
  const ytdStart = `${y0}-01-01`;

  const [accounts, txSums, allTx, ytdTx, bills, loanPays, cardStatements, contracts, estimates, sheet] = await Promise.all([
    pool.query(`SELECT * FROM accounts`),
    pool.query(`SELECT account_id, COALESCE(SUM(amount), 0) AS total FROM transactions GROUP BY account_id`),
    // Cash: only money that moved through an account (a card purchase is
    // owed on the card, counted under equity below). Transfers included —
    // they move cash between owners.
    pool.query(`SELECT amount, segment, is_segment_split, segment_grain_pct, segment_livestock_pct,
                       segment_jake_pct, segment_ashley_pct FROM transaction_lines WHERE account_id IS NOT NULL`),
    // Earnings: every split piece under its own owner, card purchases
    // included, transfers excluded.
    pool.query(
      `SELECT t.amount, t.is_capex, t.is_debt_service, t.segment, t.is_segment_split,
              t.segment_grain_pct, t.segment_livestock_pct, t.segment_jake_pct, t.segment_ashley_pct,
              lp.interest_amount
       FROM transaction_lines t
       LEFT JOIN loan_payments lp ON lp.linked_transaction_id = t.transaction_id
       WHERE t.is_transfer = false AND t.date >= $1 AND t.date <= CURRENT_DATE`,
      [ytdStart]
    ),
    pool.query(
      `SELECT due_date, amount, frequency, segment, is_segment_split, segment_grain_pct, segment_livestock_pct,
              segment_jake_pct, segment_ashley_pct
       FROM bills WHERE status = 'unpaid' AND due_date < $1`,
      [endStr]
    ),
    pool.query(
      `SELECT lp.due_date, lp.principal_amount + lp.interest_amount AS amount, l.segment
       FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
       WHERE lp.paid = false AND lp.is_adjustment = false AND lp.due_date < $1`,
      [endStr]
    ),
    cardAmountsDue(pool, { dueBefore: endStr }),
    pool.query(
      `SELECT expected_payment_date AS due_date, total_value AS amount, segment
       FROM sale_contracts WHERE status IN ('open', 'delivered') AND expected_payment_date < $1`,
      [endStr]
    ),
    forecastEstimates(),
    loadBalanceSheet(),
  ]);

  // ---- Cash (derived from tagged flows) ----
  const sumByAccount = new Map(txSums.rows.map((r) => [r.account_id, Number(r.total)]));
  let cash = 0;
  let unassignedCash = 0;
  for (const a of accounts.rows) {
    const starting = Number(a.opening_balance) - (sumByAccount.get(a.id) || 0);
    cash += starting * w(a);
    unassignedCash += starting * wUnassigned(a);
  }
  for (const t of allTx.rows) {
    cash += Number(t.amount) * w(t);
    unassignedCash += Number(t.amount) * wUnassigned(t);
  }

  // ---- 12-month forward flows: committed and estimated kept apart ----
  const idx = (d) => Math.min(Math.max(0, monthIndex(d, y0, m0)), HORIZON - 1);
  const committed = Array(HORIZON).fill(0);
  const estimated = Array(HORIZON).fill(0);
  for (const c of contracts.rows) committed[idx(c.due_date)] += Number(c.amount) * w({ segment: c.segment });
  for (const b of bills.rows) {
    for (const d of billDates(b, today, endStr)) committed[idx(d)] -= Number(b.amount) * w(b);
  }
  for (const p of loanPays.rows) committed[idx(p.due_date)] -= Number(p.amount) * w({ segment: p.segment });
  for (const s of cardStatements) committed[idx(s.due_date)] -= Number(s.amount) * w({ segment: s.segment });
  let feesPerMonth = 0;
  for (const a of accounts.rows) {
    const amt = Number(a.fee_amount) || 0;
    const monthly = a.fee_frequency === 'monthly' ? amt : a.fee_frequency === 'annual' ? amt / 12 : 0;
    feesPerMonth += monthly * w(a);
  }
  for (let i = 0; i < HORIZON; i++) committed[i] -= feesPerMonth;
  for (const e of estimates) {
    const weight = w(e);
    if (!weight) continue;
    for (const d of occurrences(e, today, endStr)) estimated[idx(d)] += signedAmount(e) * weight;
  }
  // The farm's Dec 31 income tax instalment — personal tax, so it sits
  // with Jake (and Combined), as an estimate until it's marked paid.
  if (w({ segment: 'jake' })) {
    try {
      const tax = await farmIncomeTax(y0);
      const due = tax.instalment.due;
      if (tax.instalment.amount > 0 && !tax.instalment.paid && due >= today && due < endStr) {
        estimated[idx(due)] -= tax.instalment.amount * w({ segment: 'jake' });
      }
    } catch (e) { console.error('Tax instalment forecast skipped:', e.message); }
  }

  const project = (includeEstimates) => {
    let running = cash;
    let low = { year: y0, month: m1, balance: cash };
    const trajectory = committed.map((c, i) => {
      const net = c + (includeEstimates ? estimated[i] : 0);
      running += net;
      const [yy, mm] = addMonths(`${today.slice(0, 7)}-01`, i).split('-').map(Number);
      const point = { year: yy, month: mm, balance: running, net };
      if (running < low.balance) low = point;
      return point;
    });
    return { trajectory, lowPoint: low, projectedNet12: trajectory.reduce((s, p) => s + p.net, 0), projectedEnd: running };
  };
  const withEst = project(true);
  const committedOnly = project(false);

  // ---- Earnings YTD ----
  let revenue = 0;
  let costs = 0;
  for (const t of ytdTx.rows) {
    if (t.is_capex) continue;
    const weight = w(t);
    if (!weight) continue;
    const amount = t.is_debt_service
      ? (t.interest_amount != null ? -Number(t.interest_amount) : 0)
      : Number(t.amount);
    if (amount >= 0) revenue += amount * weight;
    else costs += -amount * weight;
  }

  // ---- Equity ----
  let assetValue = 0;
  for (const a of sheet.assets) assetValue += a.value_now * w(a);
  let inventoryValue = 0;
  for (const it of sheet.inventoryRows) inventoryValue += it.counted_value * w(inventoryOwnerRow(it));
  let loanPrincipal = 0;
  for (const l of sheet.loans) loanPrincipal += l.outstanding * w({ segment: l.segment });
  let cardBalance = 0;
  for (const c of sheet.creditCards) cardBalance += c.outstanding * w({ segment: c.segment });

  const r2 = (n) => Math.round(n * 100) / 100;
  const shape = (p) => ({
    projectedNet12: r2(p.projectedNet12),
    projectedEnd: r2(p.projectedEnd),
    lowPoint: { ...p.lowPoint, balance: r2(p.lowPoint.balance) },
    trajectory: p.trajectory.map((x) => ({ ...x, balance: r2(x.balance), net: r2(x.net) })),
  });

  res.json({
    entity,
    cashFlow: {
      cashNow: r2(cash),
      withEstimates: shape(withEst),
      committed: shape(committedOnly),
      estimatedNet12: r2(estimated.reduce((s, x) => s + x, 0)),
    },
    earningsYTD: { total: r2(revenue - costs), revenue: r2(revenue), costs: r2(costs), from: ytdStart },
    equity: {
      total: r2(cash + assetValue + inventoryValue - loanPrincipal - cardBalance),
      cash: r2(cash),
      assets: r2(assetValue),
      inventory: r2(inventoryValue),
      loans: r2(loanPrincipal),
      creditCards: r2(cardBalance),
    },
    unassignedCash: entity === 'all' ? r2(unassignedCash) : undefined,
  });
}));

export default router;
