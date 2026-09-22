import { Router } from 'express';
import { computeDSCR, liquidityFloor, reserveStatus, monthlyAccountFees } from '../lib/calculations.js';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();

  const [dscr, liquidity, reserve, upcomingPayments, drawTotal, unpaidBills, accountFees, outstandingChecks, openContracts] = await Promise.all([
    computeDSCR(year),
    liquidityFloor(), // rolling 12-month window from today, not the calendar year
    reserveStatus(year),
    pool.query(
      `SELECT lp.due_date, lp.principal_amount, lp.interest_amount, l.lender
       FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
       WHERE lp.paid = false AND lp.due_date >= CURRENT_DATE
       ORDER BY lp.due_date ASC LIMIT 5`
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM owner_draws
       WHERE EXTRACT(YEAR FROM date) = $1`,
      [year]
    ),
    pool.query(
      `SELECT * FROM bills WHERE status = 'unpaid' ORDER BY due_date ASC LIMIT 10`
    ),
    monthlyAccountFees(year),
    // Outstanding checks: transactions already deducted from the book
    // balance but not yet confirmed cleared against the bank statement —
    // this is the gap that makes the app's balance look "wrong" next to
    // what the bank shows, when really it's just ahead of it.
    pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(ABS(amount)), 0) AS total
       FROM transactions WHERE cleared = false`
    ),
    // Money contracted but not yet received — already counted into the
    // liquidity forecast at its expected payment month.
    pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_value), 0) AS total
       FROM sale_contracts WHERE status IN ('open', 'delivered')`
    ),
  ]);

  // Net worth = all account balances (both ledgers — net worth is the whole
  // person) + underlying asset values on loans − outstanding loan principal.
  // Outstanding principal uses the same paid-or-past-due assumption as the
  // loan book. Assets with no loan aren't tracked yet, so this is net worth
  // of what the app knows about, not an appraisal of everything owned.
  const [cashRow, loanAgg] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(opening_balance), 0) AS total FROM accounts`),
    pool.query(`
      SELECT
        COALESCE(SUM(l.asset_value), 0) AS asset_values,
        COALESCE(SUM(GREATEST(l.principal - paid.principal_paid, 0)), 0) AS outstanding_principal
      FROM loans l
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(
          CASE WHEN lp.paid = true OR lp.due_date <= CURRENT_DATE
               THEN lp.principal_amount ELSE 0 END
        ), 0) AS principal_paid
        FROM loan_payments lp WHERE lp.loan_id = l.id
      ) paid ON true
    `),
  ]);
  const netWorth = {
    cash: Number(cashRow.rows[0].total),
    assetValues: Number(loanAgg.rows[0].asset_values),
    outstandingPrincipal: Number(loanAgg.rows[0].outstanding_principal),
  };
  netWorth.total = netWorth.cash + netWorth.assetValues - netWorth.outstandingPrincipal;

  const totalUnpaidBills = unpaidBills.rows.reduce((s, b) => s + Number(b.amount), 0);
  const totalUnpaidGst = unpaidBills.rows.reduce((s, b) => s + Number(b.gst_amount || 0), 0);
  const overdueBills = unpaidBills.rows.filter((b) => new Date(b.due_date) < new Date());

  res.json({
    year,
    dscr,
    liquidity,
    reserve,
    upcomingDebtService: upcomingPayments.rows,
    ownerDrawYTD: Number(drawTotal.rows[0].total),
    bills: {
      upcoming: unpaidBills.rows,
      totalUnpaid: totalUnpaidBills,
      totalUnpaidGst: totalUnpaidGst,
      overdueCount: overdueBills.length,
    },
    annualAccountFees: accountFees.reduce((a, b) => a + b, 0),
    outstandingChecks: {
      count: outstandingChecks.rows[0].count,
      total: Number(outstandingChecks.rows[0].total),
    },
    contractedInflows: {
      count: openContracts.rows[0].count,
      total: Number(openContracts.rows[0].total),
    },
    netWorth,
  });
}));

export default router;
