import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { OWNERS, ownerWeights } from '../lib/segments.js';

const router = Router();
const HORIZON = 12;

/**
 * The three headline numbers for one owner (grain / livestock / jake /
 * ashley) or for everything combined ('all').
 *
 * CASH — derived from tagged flows, per the design decision: an owner's
 * cash = their share of each account's STARTING balance (the balance
 * before any transactions were recorded there, owned per the account's
 * owner tag) + every transaction tagged to them since. Because every
 * row's weights sum to 1 (with 'unassigned' catching untagged rows), the
 * four owners plus unassigned add up exactly to the combined total of all
 * account balances. An enterprise's cash CAN be negative — that's the
 * honest signal that it has spent more than it brought in and is being
 * carried by another owner's money.
 *
 * CASH FLOW — from that cash, walks the next 12 months of known future
 * flows attributed to the owner: unsettled contract inflows, unpaid bills,
 * unpaid scheduled loan payments, recurring account fees. Overdue-but-
 * unpaid items land in the current month.
 *
 * EARNINGS YTD — Jan 1 to today, accrual-lite: every transaction tagged to
 * the owner, EXCEPT capital purchases (capex is an asset, not an expense)
 * and the principal portion of loan payments (repaying principal isn't a
 * cost; interest is). No depreciation yet. For Jake/Ashley this reads as
 * net savings: income in minus spending out.
 *
 * EQUITY — cash + the owner's loan-backed asset values − the outstanding
 * principal on those loans. Assets without a loan against them aren't
 * tracked in the app yet, so this is equity in what the app knows about.
 */
router.get('/', ah(async (req, res) => {
  const entity = String(req.query.entity || 'all');
  if (entity !== 'all' && !OWNERS.includes(entity)) {
    return res.status(400).json({ error: `entity must be all, ${OWNERS.join(', ')}` });
  }
  const w = (row) => (entity === 'all' ? 1 : ownerWeights(row)[entity]);
  const wUnassigned = (row) => ownerWeights(row).unassigned;

  const now = new Date();
  const y0 = now.getFullYear();
  const m0 = now.getMonth();
  const windowEnd = new Date(y0, m0 + HORIZON, 1);
  const endStr = `${windowEnd.getFullYear()}-${String(windowEnd.getMonth() + 1).padStart(2, '0')}-01`;
  const ytdStart = `${y0}-01-01`;

  const [accounts, txSums, allTx, ytdTx, loans, bills, loanPays, contracts] = await Promise.all([
    pool.query(`SELECT * FROM accounts`),
    pool.query(`SELECT account_id, COALESCE(SUM(amount), 0) AS total FROM transactions GROUP BY account_id`),
    pool.query(`SELECT amount, segment, is_segment_split, segment_grain_pct, segment_livestock_pct,
                       segment_jake_pct, segment_ashley_pct FROM transactions`),
    pool.query(
      `SELECT t.amount, t.is_capex, t.is_debt_service, t.segment, t.is_segment_split,
              t.segment_grain_pct, t.segment_livestock_pct, t.segment_jake_pct, t.segment_ashley_pct,
              lp.interest_amount
       FROM transactions t
       LEFT JOIN loan_payments lp ON lp.linked_transaction_id = t.id
       WHERE t.date >= $1 AND t.date <= CURRENT_DATE`,
      [ytdStart]
    ),
    pool.query(`
      SELECT l.id, l.segment, l.asset_value,
             GREATEST(l.principal - COALESCE(paid.principal_paid, 0), 0) AS outstanding
      FROM loans l
      LEFT JOIN LATERAL (
        SELECT SUM(CASE WHEN lp.paid = true OR lp.due_date <= CURRENT_DATE
                        THEN lp.principal_amount ELSE 0 END) AS principal_paid
        FROM loan_payments lp WHERE lp.loan_id = l.id
      ) paid ON true
    `),
    pool.query(
      `SELECT due_date, amount, segment, is_segment_split, segment_grain_pct, segment_livestock_pct,
              segment_jake_pct, segment_ashley_pct
       FROM bills WHERE status = 'unpaid' AND due_date < $1`,
      [endStr]
    ),
    pool.query(
      `SELECT lp.due_date, lp.principal_amount + lp.interest_amount AS amount, l.segment
       FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
       WHERE lp.paid = false AND lp.due_date < $1`,
      [endStr]
    ),
    pool.query(
      `SELECT expected_payment_date AS due_date, total_value AS amount, segment
       FROM sale_contracts WHERE status IN ('open', 'delivered') AND expected_payment_date < $1`,
      [endStr]
    ),
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

  // ---- 12-month forward flows ----
  const idxFor = (dateStr) => {
    const d = new Date(dateStr);
    const idx = (d.getFullYear() - y0) * 12 + (d.getMonth() - m0);
    return Math.min(Math.max(0, idx), HORIZON - 1);
  };
  const flows = Array(HORIZON).fill(0);
  for (const c of contracts.rows) flows[idxFor(c.due_date)] += Number(c.amount) * w({ segment: c.segment });
  for (const b of bills.rows) flows[idxFor(b.due_date)] -= Number(b.amount) * w(b);
  for (const p of loanPays.rows) flows[idxFor(p.due_date)] -= Number(p.amount) * w({ segment: p.segment });
  let feesPerMonth = 0;
  for (const a of accounts.rows) {
    const amt = Number(a.fee_amount) || 0;
    const monthly = a.fee_frequency === 'monthly' ? amt : a.fee_frequency === 'annual' ? amt / 12 : 0;
    feesPerMonth += monthly * w(a);
  }
  for (let i = 0; i < HORIZON; i++) flows[i] -= feesPerMonth;

  let running = cash;
  let low = { balance: cash, year: y0, month: m0 + 1 };
  const trajectory = flows.map((f, i) => {
    running += f;
    const d = new Date(y0, m0 + i, 1);
    const point = { year: d.getFullYear(), month: d.getMonth() + 1, balance: running, net: f };
    if (running < low.balance) low = point;
    return point;
  });
  const projectedNet12 = flows.reduce((s, f) => s + f, 0);

  // ---- Earnings YTD ----
  let revenue = 0;
  let costs = 0;
  for (const t of ytdTx.rows) {
    if (t.is_capex) continue;
    const weight = w(t);
    if (!weight) continue;
    // Debt service counts only its interest as a cost — principal
    // repayment reduces a liability, it doesn't reduce earnings.
    const amount = t.is_debt_service
      ? (t.interest_amount != null ? -Number(t.interest_amount) : 0)
      : Number(t.amount);
    if (amount >= 0) revenue += amount * weight;
    else costs += -amount * weight;
  }

  // ---- Equity ----
  let assets = 0;
  let loanPrincipal = 0;
  for (const l of loans.rows) {
    const weight = w({ segment: l.segment });
    assets += (Number(l.asset_value) || 0) * weight;
    loanPrincipal += Number(l.outstanding) * weight;
  }

  const r2 = (n) => Math.round(n * 100) / 100;
  res.json({
    entity,
    cashFlow: {
      cashNow: r2(cash),
      projectedNet12: r2(projectedNet12),
      projectedEnd: r2(running),
      lowPoint: { ...low, balance: r2(low.balance) },
      trajectory: trajectory.map((p) => ({ ...p, balance: r2(p.balance), net: r2(p.net) })),
    },
    earningsYTD: {
      total: r2(revenue - costs),
      revenue: r2(revenue),
      costs: r2(costs),
      from: ytdStart,
    },
    equity: {
      total: r2(cash + assets - loanPrincipal),
      cash: r2(cash),
      assets: r2(assets),
      loans: r2(loanPrincipal),
    },
    // Only meaningful in the Combined view: money nobody has been tagged
    // as owning yet. Shrinks to zero as accounts/transactions get owners.
    unassignedCash: entity === 'all' ? r2(unassignedCash) : undefined,
  });
}));

export default router;
