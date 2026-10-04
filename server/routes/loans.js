import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { recordLoanPayment, removeTransaction, unsplitLoanPayment, syncLoanPieceOwners } from '../lib/postings.js';
import { ledgerForSegment, segmentValues, validateSegment } from '../lib/segments.js';
import { buildSchedule, scheduleFromTerms, dueDateFor, FREQUENCIES } from '../lib/amortization.js';
import { toISODate, todayISO } from '../lib/dates.js';
import { assetValueAt, outstandingAt, loadBalanceSheet } from '../lib/balanceSheet.js';

const router = Router();
const round2 = (n) => Math.round(n * 100) / 100;

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
     WHERE lp.paid = false AND lp.is_adjustment = false
       AND lp.due_date <= CURRENT_DATE + ($1 || ' months')::interval
     ORDER BY lp.due_date ASC`,
    [months]
  );
  res.json(rows);
}));

// Records a scheduled payment as actually made: creates the ledger
// transaction (flagged is_debt_service so NOI/DSCR don't double-count it,
// tagged with the loan's owner so Expenses buckets it right), moves the
// account balance, and marks the schedule row paid — one DB transaction.
router.post('/payments/:paymentId/record', ah(async (req, res) => {
  const {
    account_id,
    paid_date = todayISO(),
    paid_by_check = false,
  } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id is required — which account is this payment coming out of?' });
  const r = await withTransaction((client) => recordLoanPayment(client, req.params.paymentId, { account_id, date: paid_date, paid_by_check }));
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r.payment);
}));

// Reverses a recorded payment: deletes the linked transaction, restores
// the account balance, reopens the schedule row.
router.post('/payments/:paymentId/unrecord', ah(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM loan_payments WHERE id = $1 FOR UPDATE', [req.params.paymentId]);
    if (!rows.length) return null;
    const payment = rows[0];
    if (!payment.paid || payment.is_adjustment) return payment;
    // Null the FK reference before deleting the transaction it points to.
    const { rows: updated } = await client.query(
      `UPDATE loan_payments SET paid = false, paid_date = NULL, linked_transaction_id = NULL WHERE id = $1 RETURNING *`,
      [payment.id]
    );
    if (payment.linked_transaction_id && payment.linked_existing) {
      // Matched to a transaction already in the ledger: unlink it, keep it.
      await unsplitLoanPayment(client, payment.linked_transaction_id);
      await client.query('UPDATE transactions SET is_debt_service = false WHERE id = $1', [payment.linked_transaction_id]);
    } else if (payment.linked_transaction_id) {
      await removeTransaction(client, payment.linked_transaction_id);
    }
    await client.query('UPDATE loan_payments SET linked_existing = false WHERE id = $1', [payment.id]);
    return updated[0];
  });
  if (!result) return res.status(404).json({ error: 'not found' });
  res.json(result);
}));

// Loan book: outstanding balance (schedule rows marked paid or already due
// count as paid), the secured asset and its equity (asset value today minus
// every loan secured by it), current payment, and verification age.
router.get('/', ah(async (req, res) => {
  const { loans, assets } = await loadBalanceSheet();
  const assetById = new Map(assets.map((a) => [a.id, a]));
  // Next UPCOMING payment (today or later), plus a separate count of past
  // payments never recorded — those still sit in the forecast as overdue
  // until they're recorded (or a verification confirms the balance).
  const [{ rows: nextPays }, { rows: overdue }] = await Promise.all([
    pool.query(`
      SELECT DISTINCT ON (loan_id) loan_id, principal_amount + interest_amount AS amount, due_date
      FROM loan_payments WHERE paid = false AND is_adjustment = false AND due_date >= CURRENT_DATE
      ORDER BY loan_id, due_date
    `),
    pool.query(`
      SELECT loan_id, COUNT(*)::int AS n FROM loan_payments
      WHERE paid = false AND is_adjustment = false AND due_date < CURRENT_DATE
      GROUP BY loan_id
    `),
  ]);
  const nextByLoan = new Map(nextPays.map((p) => [p.loan_id, p]));
  const overdueByLoan = new Map(overdue.map((o) => [o.loan_id, o.n]));
  const today = todayISO();

  const out = loans
    .sort((a, b) => toISODate(b.start_date).localeCompare(toISODate(a.start_date)))
    .map((l) => {
      const asset = l.asset_id ? assetById.get(l.asset_id) : null;
      const next = nextByLoan.get(l.id);
      const verifiedDays = l.last_verified_on
        ? Math.floor((Date.parse(today) - Date.parse(toISODate(l.last_verified_on))) / 86400000)
        : null;
      return {
        ...l,
        outstanding_balance: round2(l.outstanding),
        asset_name: asset ? asset.name : null,
        asset_value_now: asset ? round2(asset.value_now) : null,
        equity: asset ? round2(asset.equity_now) : null,
        asset_loan_count: asset ? asset.loans.length : 0,
        next_payment: next ? { amount: Number(next.amount), due_date: toISODate(next.due_date) } : null,
        overdue_unrecorded: overdueByLoan.get(l.id) || 0,
        days_since_verified: verifiedDays,
      };
    });
  res.json(out);
}));

// Full schedule for one loan: running balance after each row, and running
// equity in its secured asset (asset value projected to that date by its
// appreciation/depreciation rate, minus this loan's balance, minus any
// other loans on the same asset at their current balances). Verification
// adjustment rows appear in place, flagged.
router.get('/:id/payments', ah(async (req, res) => {
  const { rows: loanRows } = await pool.query('SELECT * FROM loans WHERE id = $1', [req.params.id]);
  if (!loanRows.length) return res.status(404).json({ error: 'not found' });
  const loan = loanRows[0];

  const [{ rows: payments }, { rows: verifications }] = await Promise.all([
    pool.query('SELECT * FROM loan_payments WHERE loan_id = $1 ORDER BY due_date ASC, is_adjustment DESC, id ASC', [loan.id]),
    pool.query('SELECT * FROM loan_verifications WHERE loan_id = $1 ORDER BY verified_on DESC, id DESC', [loan.id]),
  ]);

  let asset = null;
  let otherLoansOnAsset = 0;
  if (loan.asset_id) {
    const { assets } = await loadBalanceSheet();
    asset = assets.find((a) => a.id === loan.asset_id) || null;
    if (asset) otherLoansOnAsset = asset.loans.filter((x) => x.id !== loan.id).reduce((s, x) => s + x.outstanding, 0);
  }

  let balance = Number(loan.principal);
  const schedule = payments.map((p) => {
    balance = Math.max(balance - Number(p.principal_amount), 0);
    return {
      ...p,
      due_date: toISODate(p.due_date),
      balance_after: round2(balance),
      equity_after: asset ? round2(assetValueAt(asset, toISODate(p.due_date)) - balance - otherLoansOnAsset) : null,
    };
  });

  res.json({ loan, asset, payments: schedule, verifications });
}));

// Balance/equity on an arbitrary date, using the nearest scheduled payment
// on or after it.
router.get('/:id/estimate', ah(async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });

  const { rows: loanRows } = await pool.query('SELECT * FROM loans WHERE id = $1', [req.params.id]);
  if (!loanRows.length) return res.status(404).json({ error: 'not found' });
  const loan = loanRows[0];
  const { rows: payments } = await pool.query(
    'SELECT * FROM loan_payments WHERE loan_id = $1 AND is_adjustment = false ORDER BY due_date ASC', [loan.id]
  );
  if (!payments.length) return res.status(404).json({ error: 'no payment schedule on file for this loan' });
  const { rows: allRows } = await pool.query('SELECT * FROM loan_payments WHERE loan_id = $1', [loan.id]);

  const nearest = payments.find((p) => toISODate(p.due_date) >= date) || payments[payments.length - 1];
  const nd = toISODate(nearest.due_date);
  // Balance just before that payment: principal minus every row (payments
  // and verification adjustments) dated before it — same basis as the
  // running balance in the schedule view.
  const before = Math.max(
    Number(loan.principal) - allRows.filter((p) => toISODate(p.due_date) < nd).reduce((s, p) => s + Number(p.principal_amount), 0),
    0
  );
  const after = Math.max(before - Number(nearest.principal_amount), 0);

  let assetNow = null;
  let others = 0;
  if (loan.asset_id) {
    const { assets } = await loadBalanceSheet();
    const a = assets.find((x) => x.id === loan.asset_id);
    if (a) {
      assetNow = assetValueAt(a, date);
      others = a.loans.filter((x) => x.id !== loan.id).reduce((s, x) => s + x.outstanding, 0);
    }
  }

  res.json({
    asOfDate: date,
    payment: { ...nearest, due_date: toISODate(nearest.due_date) },
    balanceBeforePayment: round2(before),
    balanceAfterPayment: round2(after),
    equityBeforePayment: assetNow != null ? round2(assetNow - before - others) : null,
    equityAfterPayment: assetNow != null ? round2(assetNow - after - others) : null,
  });
}));

// ---- Verification -----------------------------------------------------
// Records what a statement or the lender says the loan looks like on a
// date, compares it to what the schedule expected, and — when they differ
// — rebases the schedule:
//   1. A principal-only adjustment row dated the verification day closes
//      the balance gap (positive = lender says you owe less than expected).
//   2. Every unpaid schedule row after that date is replaced by a new
//      schedule built from the verified balance and rate:
//        - payment given  → keep that payment, let the payoff date move
//                            (how lenders usually handle a rate change);
//        - payment blank  → keep the original payoff date, recompute payment.
// Unpaid rows due ON or BEFORE the verification date are left alone and
// reported back: if they were paid outside the app, record them in the
// planner so the cash actually leaves the account they came from.
router.post('/:id/verify', ah(async (req, res) => {
  const {
    verified_on = todayISO(),
    balance,
    interest_rate_pct,
    payment_amount = null,
    source = null,
    note = null,
    rebase = true,
    // The verified balance is proof the payments due before it were made.
    // If they came out by auto-debit and your account balances already
    // reflect them, set this so they stop sitting in the forecast as
    // overdue — they're closed with no transaction (no cash moves twice).
    prior_paid_outside_app = false,
  } = req.body;
  if (balance == null || Number.isNaN(Number(balance)) || Number(balance) < 0) {
    return res.status(400).json({ error: 'balance (from the statement or lender) is required' });
  }

  const outcome = await withTransaction(async (client) => {
    const { rows: loanRows } = await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!loanRows.length) return null;
    const loan = loanRows[0];
    const { rows: rows } = await client.query('SELECT * FROM loan_payments WHERE loan_id = $1 ORDER BY due_date', [loan.id]);

    const B = Number(balance);
    const R = interest_rate_pct != null && interest_rate_pct !== '' ? Number(interest_rate_pct) : Number(loan.interest_rate_pct);
    const P = payment_amount != null && payment_amount !== '' ? Number(payment_amount) : null;
    const expected = outstandingAt(loan, rows, verified_on);
    const expectedRate = Number(loan.interest_rate_pct);
    const future = rows.filter((p) => !p.paid && !p.is_adjustment && toISODate(p.due_date) > verified_on);
    const nextScheduled = future[0] ? Number(future[0].principal_amount) + Number(future[0].interest_amount) : null;

    const balanceGap = round2(expected - B);
    const rateChanged = Math.abs(R - expectedRate) >= 0.0005;
    const paymentChanged = P != null && nextScheduled != null && Math.abs(P - nextScheduled) >= 0.01;
    const drift = Math.abs(balanceGap) >= 0.01 || rateChanged || paymentChanged;
    const unrecordedPastDue = rows.filter((p) => !p.paid && !p.is_adjustment && toISODate(p.due_date) <= verified_on);
    let closedOutsideApp = 0;
    if (prior_paid_outside_app && unrecordedPastDue.length) {
      const { rowCount } = await client.query(
        `UPDATE loan_payments SET paid = true, paid_date = due_date
         WHERE loan_id = $1 AND paid = false AND is_adjustment = false AND due_date <= $2`,
        [loan.id, verified_on]
      );
      closedOutsideApp = rowCount;
    }

    let rebased = false;
    let newSchedule = [];
    if (rebase && drift) {
      if (Math.abs(balanceGap) >= 0.01) {
        await client.query(
          `INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount, paid, paid_date, is_adjustment)
           VALUES ($1, $2, $3, 0, true, $2, true)`,
          [loan.id, verified_on, balanceGap]
        );
      }
      await client.query(
        `DELETE FROM loan_payments WHERE loan_id = $1 AND paid = false AND is_adjustment = false AND due_date > $2`,
        [loan.id, verified_on]
      );
      // Re-anchor to the loan's own payment calendar (its first payment
      // date, or its start date + one period), not to the old rows' dates —
      // schedules built by the earlier code drifted off month-end days
      // (Jan 31 → Mar 3 → Mar 31 → May 1...), and copying those dates
      // forward would preserve the drift. Frequency is kept.
      const frequency = loan.payment_frequency || 'monthly';
      const anchor = toISODate(loan.first_payment_date || loan.start_date);
      let k = loan.first_payment_date ? 0 : 1;
      while (dueDateFor(anchor, frequency, k) <= verified_on && k < 5000) k++;
      try {
        newSchedule = buildSchedule({
          balance: B,
          ratePct: R,
          periods: Math.max(1, future.length),
          frequency,
          anchor,
          anchorOffset: k,
          payment: P,
        });
      } catch (e) {
        const err = new Error(e.message);
        err.status = 400;
        throw err;
      }
      for (const row of newSchedule) {
        await client.query(
          `INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount) VALUES ($1,$2,$3,$4)`,
          [loan.id, row.due_date, row.principal_amount, row.interest_amount]
        );
      }
      rebased = true;
    }

    const effectivePayment = P ?? (newSchedule[0] ? newSchedule[0].principal_amount + newSchedule[0].interest_amount : nextScheduled);
    await client.query(
      `UPDATE loans SET
         interest_rate_pct = $1,
         verified_payment = $2,
         last_verified_on = GREATEST(COALESCE(last_verified_on, $3::date), $3::date)
       WHERE id = $4`,
      [rebase ? R : expectedRate, effectivePayment != null ? round2(effectivePayment) : null, verified_on, loan.id]
    );
    const { rows: vRows } = await client.query(
      `INSERT INTO loan_verifications
         (loan_id, verified_on, balance, interest_rate_pct, payment_amount, source, note, expected_balance, expected_rate_pct, rebased)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [loan.id, verified_on, B, R, P, source, note, round2(expected), expectedRate, rebased]
    );

    return {
      verification: vRows[0],
      expected_balance: round2(expected),
      balance_gap: balanceGap,
      rate_changed: rateChanged,
      payment_changed: paymentChanged,
      matched: !drift,
      rebased,
      new_payment: effectivePayment != null ? round2(effectivePayment) : null,
      remaining_payments: rebased ? newSchedule.length : future.length,
      new_payoff_date: rebased && newSchedule.length ? newSchedule[newSchedule.length - 1].due_date : null,
      closed_as_paid_outside_app: closedOutsideApp,
      unrecorded_past_due: closedOutsideApp ? [] : unrecordedPastDue.map((p) => ({ id: p.id, due_date: toISODate(p.due_date) })),
    };
  });

  if (!outcome) return res.status(404).json({ error: 'not found' });
  res.json(outcome);
}));

router.get('/:id/verifications', ah(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM loan_verifications WHERE loan_id = $1 ORDER BY verified_on DESC, id DESC', [req.params.id]
  );
  res.json(rows);
}));

// ---- Create / edit / delete ---------------------------------------------

function checkFrequency(f) {
  if (f != null && !FREQUENCIES.includes(f)) {
    const err = new Error(`payment_frequency must be one of ${FREQUENCIES.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

router.post('/', ah(async (req, res) => {
  const {
    name, lender, purpose, linked_asset = null, principal, interest_rate_pct,
    rate_type = 'fixed', term_months, start_date, covenant_notes = null,
    covenant_date = null, custom_schedule = null, segment = null, asset_id = null,
    payment_frequency = 'monthly', first_payment_date = null,
  } = req.body;
  checkFrequency(payment_frequency);
  const ownerErr = validateSegment(req.body);
  if (ownerErr) return res.status(400).json({ error: ownerErr });
  const [segVal, isSplit, gPct, lPct, jPct, aPct] = segmentValues({ ...req.body, segment });
  // A blank name falls back to the lender name so two loans at the same
  // lender are never indistinguishable.
  const resolvedName = (name && name.trim()) || lender;

  const loan = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO loans
        (name, lender, purpose, linked_asset, principal, interest_rate_pct, rate_type,
         term_months, start_date, covenant_notes, covenant_date, segment, asset_id,
         payment_frequency, first_payment_date,
         is_segment_split, segment_grain_pct, segment_livestock_pct, segment_jake_pct, segment_ashley_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [resolvedName, lender, purpose, linked_asset, principal, interest_rate_pct, rate_type,
       term_months, start_date, covenant_notes, covenant_date, segVal, asset_id || null,
       payment_frequency, first_payment_date || null, isSplit, gPct, lPct, jPct, aPct]
    );
    const created = rows[0];
    // `custom_schedule` lets a loan mirror seasonal income (larger payments
    // after harvest, smaller off-season) — an array of
    // { due_date, principal_amount, interest_amount }.
    const schedule = custom_schedule || scheduleFromTerms({
      principal, interest_rate_pct, term_months, start_date, payment_frequency, first_payment_date,
    });
    for (const row of schedule) {
      await client.query(
        `INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount) VALUES ($1,$2,$3,$4)`,
        [created.id, row.due_date, row.principal_amount, row.interest_amount]
      );
    }
    return created;
  });
  res.status(201).json(loan);
}));

// Full loan edit. Cosmetic fields update in place. Changing the financial
// terms — principal, rate, term, start date, payment frequency, first
// payment date — REGENERATES the schedule
// from the new terms (including dropping verification adjustments; the
// verification history itself is kept). To correct a loan against a
// statement, use Verify instead — it rebases without discarding history.
router.patch('/:id', ah(async (req, res) => {
  const b = req.body;
  checkFrequency(b.payment_frequency);
  const loan = await withTransaction(async (client) => {
    const { rows: currentRows } = await client.query('SELECT * FROM loans WHERE id = $1', [req.params.id]);
    if (!currentRows.length) return null;
    const cur = currentRows[0];
    const pick = (k) => (b[k] !== undefined ? b[k] : cur[k]);
    const ownerSrc = b.is_segment_split !== undefined || b.segment !== undefined
      ? { ...cur, ...Object.fromEntries(['segment', 'is_segment_split', 'segment_grain_pct', 'segment_livestock_pct', 'segment_jake_pct', 'segment_ashley_pct']
        .filter((k) => b[k] !== undefined).map((k) => [k, b[k]])) }
      : cur;
    const ownerErr = validateSegment(ownerSrc);
    if (ownerErr) { const e = new Error(ownerErr); e.status = 400; throw e; }
    const [segVal, isSplit, gPct, lPct, jPct, aPct] = segmentValues(ownerSrc);
    const next = {
      name: pick('name'), lender: pick('lender'), purpose: pick('purpose'), linked_asset: pick('linked_asset'),
      segment: pick('segment'), principal: pick('principal'), interest_rate_pct: pick('interest_rate_pct'),
      rate_type: pick('rate_type'), term_months: pick('term_months'), start_date: toISODate(pick('start_date')),
      covenant_notes: pick('covenant_notes'), covenant_date: pick('covenant_date'),
      asset_id: b.asset_id !== undefined ? (b.asset_id || null) : cur.asset_id,
      payment_frequency: pick('payment_frequency') || 'monthly',
      first_payment_date: b.first_payment_date !== undefined
        ? (b.first_payment_date || null)
        : (cur.first_payment_date ? toISODate(cur.first_payment_date) : null),
    };

    const { rows: updatedRows } = await client.query(
      `UPDATE loans SET
         name = $1, lender = $2, purpose = $3, linked_asset = $4, segment = $5,
         principal = $6, interest_rate_pct = $7, rate_type = $8, term_months = $9, start_date = $10,
         covenant_notes = $11, covenant_date = $12, asset_id = $13,
         payment_frequency = $14, first_payment_date = $15,
         is_segment_split = $17, segment_grain_pct = $18, segment_livestock_pct = $19, segment_jake_pct = $20, segment_ashley_pct = $21
       WHERE id = $16 RETURNING *`,
      [next.name, next.lender, next.purpose, next.linked_asset, segVal,
       next.principal, next.interest_rate_pct, next.rate_type, next.term_months, next.start_date,
       next.covenant_notes, next.covenant_date, next.asset_id,
       next.payment_frequency, next.first_payment_date, req.params.id, isSplit, gPct, lPct, jPct, aPct]
    );
    const updated = updatedRows[0];

    const termsChanged =
      Number(next.principal) !== Number(cur.principal) ||
      Number(next.interest_rate_pct) !== Number(cur.interest_rate_pct) ||
      Number(next.term_months) !== Number(cur.term_months) ||
      next.start_date !== toISODate(cur.start_date) ||
      next.payment_frequency !== (cur.payment_frequency || 'monthly') ||
      (next.first_payment_date || null) !== (cur.first_payment_date ? toISODate(cur.first_payment_date) : null);

    if (termsChanged) {
      await client.query('DELETE FROM loan_payments WHERE loan_id = $1', [updated.id]);
      for (const row of scheduleFromTerms(next)) {
        await client.query(
          `INSERT INTO loan_payments (loan_id, due_date, principal_amount, interest_amount) VALUES ($1,$2,$3,$4)`,
          [updated.id, row.due_date, row.principal_amount, row.interest_amount]
        );
      }
    }
    await syncLoanPieceOwners(client, updated.id); // recorded payments follow the loan's owner split
    return { ...updated, schedule_regenerated: termsChanged };
  });

  if (!loan) return res.status(404).json({ error: 'not found' });
  res.json(loan);
}));

// Deleting a loan removes its schedule and verification history with it.
// Ledger transactions from payments already recorded are left alone — the
// money really moved.
router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM loans WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));

export default router;
