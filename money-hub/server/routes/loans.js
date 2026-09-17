import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM loans ORDER BY start_date DESC');
  res.json(rows);
});

router.get('/:id/payments', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM loan_payments WHERE loan_id = $1 ORDER BY due_date ASC',
    [req.params.id]
  );
  res.json(rows);
});

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

router.post('/', async (req, res) => {
  const {
    lender, purpose, linked_asset = null, principal, interest_rate_pct,
    rate_type = 'fixed', term_months, start_date, covenant_notes = null,
    covenant_date = null, custom_schedule = null,
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO loans
        (lender, purpose, linked_asset, principal, interest_rate_pct, rate_type,
         term_months, start_date, covenant_notes, covenant_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [lender, purpose, linked_asset, principal, interest_rate_pct, rate_type,
       term_months, start_date, covenant_notes, covenant_date]
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
});

export default router;
