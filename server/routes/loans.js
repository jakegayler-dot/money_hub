import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { loanOutstandingBalance } from '../lib/calculations.js';

const router = Router();

// ---- Payment planner -------------------------------------------------
// Every still-unpaid scheduled payment across all loans, soonest first —
// when and how much will be withdrawn. Recording one (below) is what
// actually moves the money; this list is the plan.
router.get('/payments/upcoming', ah(async (req, res) => {
  const months = Math.min(Number(req.query.months) || 12, 60);
  const { rows } = await pool.query(
    `SELECT lp.*, l.name AS loan_name, l.lender, l.segment
     FROM loan_payments lp
     JOIN loans l ON l.id = lp.loan_id
     WHERE lp.paid = false
       AND lp.due_date <= CURRENT_DATE + ($1 || ' months')::interval
     ORDER BY lp.due_date ASC`,
    [months]
  );
  res.json(rows);
}));

// Records a scheduled payment as actually made: creates the ledger
// transaction (flagged is_debt_service so NOI/DSCR don't double-count it,
// tagged with the loan's enterprise segment so Expenses buckets it right),
// moves the account balance, and marks the schedule row paid — all in one
// DB transaction. This is the "automatically updates ledger, expenses, and
// cash flow forecast" path: the forecast subtracts only unpaid scheduled
// payments, so recording one shifts it from forecast to actuals.
router.post('/payments/:paymentId/record', ah(async (req, res) => {
  const {
    account_id,
    paid_date = new Date().toISOString().slice(0, 10),
    paid_by_check = false,
  } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id is required — which account is this payment coming out of?' });

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT lp.*, l.name AS loan_name, l.segment FROM loan_payments lp
       JOIN loans l ON l.id = lp.loan_id
       WHERE lp.id = $1`,
      [req.params.paymentId]
    );
    if (!rows.length) return null;
    const payment = rows[0];
    if (payment.paid) return payment;

    const total = Number(payment.principal_amount) + Number(payment.interest_amount);
    // A personal-segment loan (e.g. a home mortgage) posts to the personal
    // ledger; everything else is business debt service.
    const ledger = payment.segment === 'personal' ? 'personal' : 'business';
    const { rows: txRows } = await client.query(
      `INSERT INTO transactions
        (account_id, ledger, date, amount, description, entered_by, is_debt_service, segment, cleared, cleared_date)
       VALUES ($1, $2, $3, $4, $5, 'manual', true, $6, $7, $8) RETURNING id`,
      [account_id, ledger, paid_date, -total,
       `Loan payment: ${payment.loan_name}${paid_by_check ? ' (check)' : ''}`,
       payment.segment, !paid_by_check, paid_by_check ? null : paid_date]
    );
    await client.query(
      `UPDATE accounts SET opening_balance = opening_balance - $1 WHERE id = $2`,
      [total, account_id]
    );
    const { rows: updated } = await client.query(
      `UPDATE loan_payments SET paid = true, paid_date = $1, linked_transaction_id = $2 WHERE id = $3 RETURNING *`,
      [paid_date, txRows[0].id, payment.id]
    );
    return updated[0];
  });

  if (!result) return res.status(404).json({ error: 'not found' });
  res.json(result);
}));

// Reverses a recorded payment (mirrors bills /unpay): deletes the linked
// transaction, restores the account balance, reopens the schedule row.
router.post('/payments/:paymentId/unrecord', ah(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM loan_payments WHERE id = $1', [req.params.paymentId]);
    if (!rows.length) return null;
    const payment = rows[0];
    if (!payment.paid) return payment;

    if (payment.linked_transaction_id) {
      const { rows: txRows } = await client.query('SELECT * FROM transactions WHERE id = $1', [payment.linked_transaction_id]);
      if (txRows.length) {
        const tx = txRows[0];
        await client.query(
          `UPDATE accounts SET opening_balance = opening_balance - $1 WHERE id = $2`,
          [tx.amount, tx.account_id]
        );
        await client.query('DELETE FROM transactions WHERE id = $1', [tx.id]);
      }
    }
    const { rows: updated } = await client.query(
      `UPDATE loan_payments SET paid = false, paid_date = NULL, linked_transaction_id = NULL WHERE id = $1 RETURNING *`,
      [payment.id]
    );
    return updated[0];
  });

  if (!result) return res.status(404).json({ error: 'not found' });
  res.json(result);
}));

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
    asset_value = null, asset_value_date = null, segment = null,
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
         term_months, start_date, covenant_notes, covenant_date, asset_value, asset_value_date, segment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [resolvedName, lender, purpose, linked_asset, principal, interest_rate_pct, rate_type,
       term_months, start_date, covenant_notes, covenant_date, asset_value, asset_value_date, segment]
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

// Full loan edit. Cosmetic fields (name, lender, asset value, covenant,
// segment, linked asset) update in place. Changing the financial terms —
// principal, rate, term, start date — REGENERATES the amortization
// schedule from the new terms: the old schedule's rows are deleted,
// including their paid/unpaid flags, because a schedule amortized from
// different terms is a different schedule, not the old one edited.
// (Payments already recorded as transactions keep their ledger entries and
// balance effects — only the schedule-side history resets.)
router.patch('/:id', ah(async (req, res) => {
  const {
    name, lender, purpose, linked_asset, segment,
    principal, interest_rate_pct, rate_type, term_months, start_date,
    asset_value, asset_value_date, covenant_notes, covenant_date,
  } = req.body;

  const loan = await withTransaction(async (client) => {
    const { rows: currentRows } = await client.query('SELECT * FROM loans WHERE id = $1', [req.params.id]);
    if (!currentRows.length) return null;
    const current = currentRows[0];

    const next = {
      name: name ?? current.name,
      lender: lender ?? current.lender,
      purpose: purpose ?? current.purpose,
      linked_asset: linked_asset ?? current.linked_asset,
      segment: segment ?? current.segment,
      principal: principal ?? current.principal,
      interest_rate_pct: interest_rate_pct ?? current.interest_rate_pct,
      rate_type: rate_type ?? current.rate_type,
      term_months: term_months ?? current.term_months,
      start_date: start_date ?? current.start_date,
      asset_value: asset_value ?? current.asset_value,
      asset_value_date: asset_value_date ?? current.asset_value_date,
      covenant_notes: covenant_notes ?? current.covenant_notes,
      covenant_date: covenant_date ?? current.covenant_date,
    };

    const { rows: updatedRows } = await client.query(
      `UPDATE loans SET
         name = $1, lender = $2, purpose = $3, linked_asset = $4, segment = $5,
         principal = $6, interest_rate_pct = $7, rate_type = $8, term_months = $9, start_date = $10,
         asset_value = $11, asset_value_date = $12, covenant_notes = $13, covenant_date = $14
       WHERE id = $15 RETURNING *`,
      [next.name, next.lender, next.purpose, next.linked_asset, next.segment,
       next.principal, next.interest_rate_pct, next.rate_type, next.term_months, next.start_date,
       next.asset_value, next.asset_value_date, next.covenant_notes, next.covenant_date,
       req.params.id]
    );
    const updated = updatedRows[0];

    const termsChanged =
      Number(next.principal) !== Number(current.principal) ||
      Number(next.interest_rate_pct) !== Number(current.interest_rate_pct) ||
      Number(next.term_months) !== Number(current.term_months) ||
      String(next.start_date).slice(0, 10) !== String(current.start_date instanceof Date ? current.start_date.toISOString() : current.start_date).slice(0, 10);

    if (termsChanged) {
      await client.query('DELETE FROM loan_payments WHERE loan_id = $1', [updated.id]);
      const schedule = buildAmortizationSchedule({
        principal: Number(next.principal),
        interest_rate_pct: Number(next.interest_rate_pct),
        term_months: Number(next.term_months),
        start_date: next.start_date,
      });
      for (const row of schedule) {
        await client.query(
          `INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount)
           VALUES ($1,$2,$3,$4)`,
          [updated.id, row.due_date, row.principal_amount, row.interest_amount]
        );
      }
    }

    return { ...updated, schedule_regenerated: termsChanged };
  });

  if (!loan) return res.status(404).json({ error: 'not found' });
  res.json(loan);
}));

// Deleting a loan removes its schedule with it (ON DELETE CASCADE).
// Ledger transactions from payments already recorded are left alone — the
// money really moved; deleting the loan doesn't un-spend it.
router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM loans WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
