import { Router } from 'express';
import { pool } from '../db.js';
import { termDebtCoverage, coverageWithAddedDebt, liquidityFloor, opportunityCostUnits } from '../lib/calculations.js';
import { ah } from '../lib/asyncHandler.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM purchase_evaluations ORDER BY evaluated_at DESC'
  );
  res.json(rows);
}));

/**
 * Runs the purchase against the business liquidity floor and the projected
 * term debt coverage ratio (as if the purchase's financing were added),
 * converts price to opportunity-cost units, and stores the result.
 * `unit_value` is the per-unit annual return of the core return-generating
 * asset (caller-supplied — this system is intentionally source-agnostic and
 * doesn't assume any one operator's asset).
 */
router.post('/evaluate', ah(async (req, res) => {
  const {
    name, price, purchase_class, is_mixed_use = false, mixed_use_business_pct = null,
    unit_value = null, reversibility_score = null, notes = null,
  } = req.body;
  // Annual principal + interest on the new financing — what an ag lender
  // adds to the denominator. Older clients sent a monthly figure.
  const addedAnnual = req.body.added_annual_debt_service != null
    ? Number(req.body.added_annual_debt_service) || 0
    : (Number(req.body.added_monthly_debt_service) || 0) * 12;

  const [liquidity, coverage] = await Promise.all([liquidityFloor(), termDebtCoverage()]);

  // Liquidity gate: does the trough month still clear the buffer after the
  // purchase amount (business-attributable share only) leaves the account?
  const businessShare = is_mixed_use ? price * (Number(mixed_use_business_pct) / 100) : price;
  const projectedFloorAfterPurchase = liquidity.floorMonth.balance - businessShare;
  const liquidity_pass = projectedFloorAfterPurchase >= liquidity.requiredFloor;

  // Coverage gate (ag-lender standard): next 12 months' capacity over next
  // 12 months' term payments INCLUDING the new loan's annual payment, vs
  // the threshold (1.25x by default). With no term debt before or after,
  // there's nothing to cover and the gate doesn't apply.
  const coverageAfter = coverageWithAddedDebt(coverage, addedAnnual);
  const dscr_pass = coverageAfter == null ? null : coverageAfter >= coverage.threshold;

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
    detail: { liquidity, coverage, coverageAfter, addedAnnualDebtService: addedAnnual, projectedFloorAfterPurchase },
  });
}));

export default router;
