import { Router } from 'express';
import { termDebtCoverage, liquidityFloor, reserveStatus, monthlyAccountFees } from '../lib/calculations.js';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { loadBalanceSheet } from '../lib/balanceSheet.js';
import { cardAmountsDue } from '../lib/cardLedger.js';
import { toISODate } from '../lib/dates.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();

  const [coverage, liquidity, reserve, upcomingPayments, drawTotal, unpaidBills, accountFees, outstandingChecks, openContracts, activeCards, unpaidCardStatements, lastPaidCardStatements] = await Promise.all([
    termDebtCoverage(), // trailing and next 12 months, not the calendar year
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
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(GREATEST(total_value - received_amount, 0)), 0) AS total
       FROM sale_contracts WHERE status IN ('open', 'delivered')`
    ),
    pool.query(`SELECT * FROM credit_cards WHERE status = 'active'`),
    cardAmountsDue(pool),
    // Per card, the most recent statement whose deadline has come (paid,
    // or past due): if it wasn't paid in full by its due date, the grace
    // period is gone.
    pool.query(
      `SELECT DISTINCT ON (s.credit_card_id) s.credit_card_id, s.paid_in_full
       FROM credit_card_statements s JOIN credit_cards cc ON cc.id = s.credit_card_id
       WHERE cc.status = 'active' AND (s.paid OR s.due_date < CURRENT_DATE)
       ORDER BY s.credit_card_id, COALESCE(s.statement_date, s.due_date) DESC, s.id DESC`
    ),
  ]);

  // Net worth = all account balances (both ledgers — net worth is the whole
  // household) + capital assets valued today + uncontracted inventory −
  // outstanding loan principal. Same valuation as the Assets tab and the
  // Combined equity card (lib/balanceSheet.js), so the numbers always agree.
  const [cashRow, sheet] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(opening_balance), 0) AS total FROM accounts`),
    loadBalanceSheet(),
  ]);
  const netWorth = {
    cash: Number(cashRow.rows[0].total),
    assetValues: sheet.assets.reduce((s, a) => s + a.value_now, 0) + sheet.inventoryRows.reduce((s, i) => s + i.counted_value, 0),
    outstandingPrincipal: sheet.loans.reduce((s, l) => s + l.outstanding, 0),
    creditCardBalances: sheet.creditCards.reduce((s, c) => s + c.outstanding, 0),
  };
  netWorth.total = netWorth.cash + netWorth.assetValues - netWorth.outstandingPrincipal - netWorth.creditCardBalances;

  const totalUnpaidBills = unpaidBills.rows.reduce((s, b) => s + Number(b.amount), 0);
  const totalUnpaidGst = unpaidBills.rows.reduce((s, b) => s + Number(b.gst_amount || 0), 0);
  const overdueBills = unpaidBills.rows.filter((b) => new Date(b.due_date) < new Date());

  res.json({
    year,
    coverage,
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
    creditCards: {
      count: activeCards.rows.length,
      totalBalance: sheet.creditCards.reduce((s, c) => s + c.outstanding, 0),
      dueSoon: unpaidCardStatements
        .map((r) => ({ credit_card_id: r.credit_card_id, name: r.name, due_date: toISODate(r.due_date), amount: Number(r.amount) }))
        .sort((a, b) => a.due_date.localeCompare(b.due_date))
        .slice(0, 5),
      // A card whose last decided statement wasn't paid in full by its due
      // date has lost its grace period — new purchases now accrue interest
      // from the transaction date, not the due date, until a full-balance
      // payment resets it.
      gracePeriodLost: lastPaidCardStatements.rows.filter((r) => r.paid_in_full !== true).length,
    },
    netWorth,
  });
}));

export default router;
