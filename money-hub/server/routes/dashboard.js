import { Router } from 'express';
import { computeDSCR, liquidityFloor, reserveStatus } from '../lib/calculations.js';
import { pool } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();

  const [dscr, liquidity, reserve, upcomingPayments, drawTotal] = await Promise.all([
    computeDSCR(year),
    liquidityFloor(year),
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
  ]);

  res.json({
    year,
    dscr,
    liquidity,
    reserve,
    upcomingDebtService: upcomingPayments.rows,
    ownerDrawYTD: Number(drawTotal.rows[0].total),
  });
});

export default router;
