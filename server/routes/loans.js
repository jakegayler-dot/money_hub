import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { loanOutstandingBalance } from '../lib/calculations.js';

const router = Router();

// principal_paid_to_date: sum of principal from payments that are marked
// paid, OR whose due date has already passed (matches loanOutstandingBalance's
// assumption that a scheduled payment happened on time unless told otherwise).
// outstanding_balance and equity (when asset_value is set) are computed here
// so the loan list can show them without a separate round trip per loan.
router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT l.*,
      COALESCE(SUM(
        CASE WHEN lp.paid = true OR lp.due_date <= CURRENT_DATE
             THEN lp.principal_amount ELSE 0 END
      ), 0) AS principal_paid_to_date
    FROM loans l
    LEFT JOIN loan_payments lp ON lp.loan_id = l.id
    GROUP BY l.id
    ORDER BY l.start_date DESC
  `);
  const withBalances = rows.map((l) => {
    const outstanding_balance = Math.max(Number(l.principal) - Number(l.principal_paid_to_date), 0);
    const equity = l.asset_value != null ? Number(l.asset_value) - outstanding_balance : null;
    return { ...l, outstanding_balance, equity };
  });
  res.json(withBalances);
}));

// Full schedule for one loan, with a running balance and running equity
// (if asset_value is set) after each payment — this is the interest/
// principal breakdown plus equity build-up over the life of the loan.
router.get('/:id/payments', ah(async (req, res) => {
  const { rows: loanRows } = await pool.query('SELECT * FROM loans WHERE id = $1', [req.params.id]);
  if (!loanRows.length) return res.status(404).json({ error: 'not found' });
  const loan = loanRows[0];

  const { rows: payments } = await pool.query(
    'SELECT * FROM loan_payments WHERE loan_id = $1 ORDER BY due_date ASC',
    [req.params.id]
  );

  let balance = Number(loan.principal);
  const schedule = payments.map((p) => {
    balance = Math.max(balance - Number(p.principal_amount), 0);
    return {
      ...p,
      balance_after: Math.round(balance * 100) / 100,
      equity_after: loan.asset_value != null ? Number(loan.asset_value) - balance : null,
    };
  });

  res.json({ loan, payments: schedule });
}));

// Estimated payment and balance/equity as of an arbitrary date — "what's
// the payment around this date, and what would I owe / have in equity at
// that point" — using the closest scheduled payment on or after the date.
router.get('/:id/estimate', ah(async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });

  const { rows: loanRows } = await pool.query('SELECT * FROM loans WHERE id = $1', [req.params.id]);
  if (!loanRows.length) return res.status(404).json({ error: 'not found' });
  const loan = loanRows[0];

  const { rows: payments } = await pool.query(
    'SELECT * FROM loan_payments WHERE loan_id = $1 ORDER BY due_date ASC',
    [req.params.id]
  );
  if (!payments.length) return res.status(404).json({ error: 'no payment schedule on file for this loan' });

  const asOf = new Date(date);
  const nearestPayment =
    payments.find((p) => new Date(p.due_date) >= asOf) || payments[payments.length - 1];

  const balanceAsOf = loanOutstandingBalance(loan, payments, asOf);
  const balanceAfterPayment = Math.max(
    balanceAsOf - Number(nearestPayment.principal_amount),
    0
  );

  res.json({
    asOfDate: date,
    payment: nearestPayment,
    balanceBeforePayment: Math.round(balanceAsOf * 100) / 100,
    balanceAfterPayment: Math.round(balanceAfterPayment * 100) / 100,
    equityBeforePayment: loan.asset_value != null ? Number(loan.asset_value) - balanceAsOf : null,
    equityAfterPayment: loan.asset_value != null ? Number(loan.asset_value) - balanceAfterPayment : null,
  });
}));

/** Standard fixed-rate amortization; produces one row per month. */
function buildAmortizationSchedule({ principal, interest_rate_pct, term_months, start_date }) {
  const monthlyRate = interest_rate_pct / 100 / 12;
  const payment =
    monthlyRate === 0
      ? principal / term_months
      : (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -term_months));

  let balance = principal;
  const schedule = [];
  const start = new Date(start_date);

  for (let i = 0; i < term_months; i++) {
    const interest = balance * monthlyRate;
    const principalPortion = payment - interest;
    balance -= principalPortion;

    const dueDate = new Date(start);
    dueDate.setMonth(dueDate.getMonth() + i + 1);

    schedule.push({
      due_date: dueDate.toISOString().slice(0, 10),
      principal_amount: Math.round(principalPortion * 100) / 100,
      interest_amount: Math.round(interest * 100) / 100,
    });
  }
  return schedule;
}

router.post('/', ah(async (req, res) => {
  const {
    name, lender, purpose, linked_asset = null, principal, interest_rate_pct,
    rate_type = 'fixed', term_months, start_date, covenant_notes = null,
    covenant_date = null, custom_schedule = null,
    asset_value = null, asset_value_date = null,
  } = req.body;
  // A blank name falls back to the lender name, same as the backfill for
  // rows that predate this field — never leaves a loan with nothing to
  // tell it apart from another one at the same lender.
  const resolvedName = (name && name.trim()) || lender;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO loans
        (name, lender, purpose, linked_asset, principal, interest_rate_pct, rate_type,
         term_months, start_date, covenant_notes, covenant_date, asset_value, asset_value_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [resolvedName, lender, purpose, linked_asset, principal, interest_rate_pct, rate_type,
       term_months, start_date, covenant_notes, covenant_date, asset_value, asset_value_date]
    );
    const loan = rows[0];

    // `custom_schedule` lets a loan mirror seasonal income (larger payments
    // after harvest/sale, smaller or skipped off-season) instead of an even
    // monthly amount — pass an array of { due_date, principal_amount, interest_amount }.
    const schedule =
      custom_schedule ||
      buildAmortizationSchedule({ principal, interest_rate_pct, term_months, start_date });

    for (const row of schedule) {
      await client.query(
        `INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount)
         VALUES ($1,$2,$3,$4)`,
        [loan.id, row.due_date, row.principal_amount, row.interest_amount]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(loan);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}));

// Lets the asset valuation (and covenant info) be updated without touching
// the loan's rate/term/schedule — re-amortizing an existing schedule isn't
// supported yet, so principal/rate/term are intentionally not editable here.
router.patch('/:id', ah(async (req, res) => {
  const { name, asset_value, asset_value_date, covenant_notes, covenant_date } = req.body;
  const { rows } = await pool.query(
    `UPDATE loans SET
       name = COALESCE($1, name),
       asset_value = COALESCE($2, asset_value),
       asset_value_date = COALESCE($3, asset_value_date),
       covenant_notes = COALESCE($4, covenant_notes),
       covenant_date = COALESCE($5, covenant_date)
     WHERE id = $6 RETURNING *`,
    [name, asset_value, asset_value_date, covenant_notes, covenant_date, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

export default router;
