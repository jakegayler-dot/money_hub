import { Router } from 'express';
import { pool } from '../db.js';
import { computeDSCR, liquidityFloor, opportunityCostUnits } from '../lib/calculations.js';
import { ah } from '../lib/asyncHandler.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM purchase_evaluations ORDER BY evaluated_at DESC'
  );
  res.json(rows);
}));

/**
 * Runs the purchase against the current business-ledger liquidity floor and
 * DSCR (as if the purchase's financing were added), converts price to
 * opportunity-cost units, and stores the result. `unit_value` is the
 * per-unit annual return of the core return-generating asset (caller-
 * supplied — this system is intentionally source-agnostic and doesn't
 * assume any one operator's asset).
 */
router.post('/evaluate', ah(async (req, res) => {
  const {
    name, price, purchase_class, is_mixed_use = false, mixed_use_business_pct = null,
    unit_value = null, reversibility_score = null, added_monthly_debt_service = 0, notes = null,
  } = req.body;

  const year = new Date().getFullYear();
  const [liquidity, dscr] = await Promise.all([liquidityFloor(year), computeDSCR(year)]);

  // Liquidity gate: does the trough month still clear the buffer after the
  // purchase amount (business-attributable share only) leaves the account?
  const businessShare = is_mixed_use ? price * (Number(mixed_use_business_pct) / 100) : price;
  const projectedFloorAfterPurchase = liquidity.floorMonth.balance - businessShare;
  const liquidity_pass = projectedFloorAfterPurchase >= liquidity.requiredFloor;

  // DSCR gate: recompute worst-month DSCR with the added monthly debt
  // service layered onto every month (a conservative, always-on assumption
  // — real per-month timing can be refined once a schedule exists).
  let dscr_pass = dscr.passes;
  if (added_monthly_debt_service > 0 && dscr.worstMonth) {
    const newDebtService = dscr.worstMonth.debtService + added_monthly_debt_service;
    const newRatio = newDebtService === 0 ? null : dscr.worstMonth.noi / newDebtService;
    dscr_pass = newRatio !== null && newRatio >= dscr.threshold;
  }

  const opportunity_cost_units = opportunityCostUnits(businessShare, unit_value);
  const decision = liquidity_pass && dscr_pass !== false ? 'pass' : 'fail';

  const { rows } = await pool.query(
    `INSERT INTO purchase_evaluations
      (name, price, purchase_class, is_mixed_use, mixed_use_business_pct,
       liquidity_pass, dscr_pass, opportunity_cost_units, reversibility_score, decision, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [name, price, purchase_class, is_mixed_use, mixed_use_business_pct,
     liquidity_pass, dscr_pass, opportunity_cost_units, reversibility_score, decision, notes]
  );

  res.status(201).json({
    result: rows[0],
    detail: { liquidity, dscr, projectedFloorAfterPurchase },
  });
}));

export default router;
