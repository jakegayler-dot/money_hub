import { pool, getSetting } from '../db.js';
import { occurrences, signedAmount } from './estimates.js';
import { forecastEstimates } from './inventoryForecast.js';
import { ownerWeights, businessShare } from './segments.js';
import { monthIndex, todayISO, toISODate, addMonths, addDays } from './dates.js';
import { LATEST_STATEMENTS_SQL } from './cardLedger.js';
import { farmIncomeTax } from './tax.js';

const MONTHS = 12;

/** Recurring account fees per month, business ledger only. Monthly fees hit
 * every month; annual fees are spread evenly across 12 (approximation —
 * good enough for a planning forecast, not a statement reconciliation). */
export async function monthlyAccountFees(year) {
  const { rows } = await pool.query(
    `SELECT fee_amount, fee_frequency FROM accounts
     WHERE fee_frequency != 'none' AND fee_amount > 0`
  );
  const byMonth = Array(MONTHS).fill(0);
  for (const r of rows) {
    const amount = Number(r.fee_amount);
    if (r.fee_frequency === 'monthly') {
      for (let i = 0; i < MONTHS; i++) byMonth[i] += amount;
    } else if (r.fee_frequency === 'annual') {
      for (let i = 0; i < MONTHS; i++) byMonth[i] += amount / 12;
    }
    // per_transaction fees aren't schedulable — they show up via actual
    // transaction volume, not as a forecastable recurring line.
  }
  return byMonth;
}

const BILL_STEP_MONTHS = { monthly: 1, quarterly: 3 };

/**
 * Dates an unpaid bill will be owed before `toExclusive`: the bill itself
 * (even if overdue — it still hasn't been paid) plus, for a recurring bill,
 * the later instances the app creates as each one is paid. Only one
 * instance of a recurring bill exists at a time, so without this a monthly
 * bill would count once in a 12-month forecast instead of every month.
 * Later instances are counted only from tomorrow on.
 */
export function billDates(bill, todayStr, toExclusive) {
  const first = toISODate(bill.due_date);
  const out = first < toExclusive ? [first] : [];
  const step = BILL_STEP_MONTHS[bill.frequency];
  if (!step || !out.length) return out;
  for (let k = 1; k < 600; k++) {
    const d = addMonths(first, k * step);
    if (d >= toExclusive) break;
    if (d > todayStr) out.push(d);
  }
  return out;
}

/**
 * TERM DEBT COVERAGE RATIO — the repayment-capacity test ag lenders
 * underwrite on (Farm Financial Standards Council definition; the same
 * measure FCC and the banks' ag desks use, typically with a 1.25x minimum):
 *
 *            capacity available for term debt
 *   TDCR = ───────────────────────────────────────────────
 *           scheduled principal + interest on TERM debt
 *
 *   capacity = operating income before debt service
 *              − operating-line interest   (an operating expense)
 *              − owner withdrawals          (family living)
 *
 * Measured over a full year, twice: HISTORICAL (the trailing 12 months of
 * actuals) and PROJECTED (the next 12 months). The projection is the gate —
 * a lender approving new debt asks whether next year's income carries next
 * year's payments. It's annual on purpose: seasonal troughs are a
 * liquidity question, answered by the liquidity floor, not by this ratio.
 *
 * Money Hub is cash basis, so "income" here is business cash in − cash out
 * excluding capital purchases (not an expense — the lender's depreciation
 * add-back nets out the same way) and loan payments (the denominator).
 * Income tax isn't tracked, so it isn't deducted. Operating lines are
 * excluded from the denominator: they revolve within the year and are
 * repaid from the crop, not from surplus. Loans owned by Jake or Ashley
 * personally (a house mortgage) are outside the farm business and don't
 * count on either side.
 */
const BUSINESS_LOAN = `(l.segment IS NULL OR l.segment NOT IN ('personal', 'jake', 'ashley'))`;
const BUSINESS_SEGMENT = `segment NOT IN ('personal', 'jake', 'ashley')`;

/** Scheduled loan payments due in (from, to], split term vs operating. */
async function scheduledServiceBetween(fromExclusive, toInclusive) {
  const { rows } = await pool.query(
    `SELECT (l.purpose = 'operating') AS operating,
            COALESCE(SUM(lp.principal_amount), 0) AS principal,
            COALESCE(SUM(lp.interest_amount), 0) AS interest
     FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
     WHERE lp.is_adjustment = false            -- verification corrections aren't payments
       AND lp.due_date > $1 AND lp.due_date <= $2
       AND ${BUSINESS_LOAN}
     GROUP BY 1`,
    [fromExclusive, toInclusive]
  );
  const out = { termPrincipal: 0, termInterest: 0, operatingInterest: 0 };
  for (const r of rows) {
    if (r.operating) out.operatingInterest += Number(r.interest);
    else { out.termPrincipal += Number(r.principal); out.termInterest += Number(r.interest); }
  }
  return out;
}

function coverageResult({ from, to, lines, service, threshold }) {
  const capacity = lines.reduce((s, l) => s + l.amount, 0);
  const termDebtService = service.termPrincipal + service.termInterest;
  const ratio = termDebtService > 0 ? capacity / termDebtService : null;
  return {
    from, to, lines, capacity,
    termPrincipal: service.termPrincipal,
    termInterest: service.termInterest,
    termDebtService,
    ratio,
    // No term debt scheduled = nothing to cover: not a fail, not a pass.
    passes: ratio == null ? null : ratio >= threshold,
  };
}

/**
 * Historical and projected TDCR. `projected` is the gating figure.
 * Returns { threshold, historical, projected, ratio, passes }, each period
 * carrying its line-by-line build so the number can be checked by hand.
 */
export async function termDebtCoverage() {
  const threshold = Number(await getSetting('dscr_threshold', 1.25));
  const today = todayISO();
  const histFrom = addMonths(today, -12);
  const projTo = addMonths(today, 12);

  // ---- Historical: trailing 12 months of actuals -------------------------
  const [txRow, histDraws, histService] = await Promise.all([
    pool.query(
      // transaction_lines: split pieces count by their own ledger/capex
      // flag. Transfers (account to account, card payments on itemized
      // cards, draws) are not income or expense; card purchases are
      // expenses when made, even before the card is paid.
      `SELECT COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0) AS cash_in,
              COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0) AS cash_out
       FROM transaction_lines
       WHERE ledger = 'business' AND is_capex = false AND is_debt_service = false AND is_transfer = false
         AND date > $1 AND date <= $2`,
      [histFrom, today]
    ),
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM owner_draws WHERE date > $1 AND date <= $2`, [histFrom, today]),
    scheduledServiceBetween(histFrom, today),
  ]);
  const drawsTrailing = Number(histDraws.rows[0].total);
  const historical = coverageResult({
    from: addDays(histFrom, 1), to: today, threshold,
    service: histService,
    lines: [
      { label: 'Business receipts', amount: Number(txRow.rows[0].cash_in) },
      { label: 'Operating expenses paid', amount: Number(txRow.rows[0].cash_out) },
      { label: 'Operating-line interest', amount: -histService.operatingInterest },
      { label: 'Owner draws', amount: -drawsTrailing },
    ],
  });

  // ---- Projected: next 12 months --------------------------------------------
  // Committed flows (contracts, bills, fees) plus the business share of
  // active estimates — the same inputs as the default forecast basis.
  // Unsettled contracts and unpaid bills count even if their date has
  // passed: the money still hasn't moved, so it lands in this period.
  const [contractRow, billRow, fees, projService, cardRow] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(GREATEST(total_value - received_amount, 0)), 0) AS total FROM sale_contracts
       WHERE status IN ('open', 'delivered') AND expected_payment_date <= $1 AND ${BUSINESS_SEGMENT}`,
      [projTo]
    ),
    pool.query(
      // Every unpaid bill, counted at its farm share — a bill split 60%
      // Cattle / 40% Jake is $60 of every $100 here, not all or nothing.
      `SELECT due_date, bill_owing(bills, due_date) AS amount, frequency, ledger, segment, is_segment_split, segment_grain_pct, segment_livestock_pct, segment_jake_pct, segment_ashley_pct FROM bills
       WHERE status = 'unpaid' AND due_date <= $1`,
      [projTo]
    ),
    monthlyAccountFees(),
    scheduledServiceBetween(today, projTo),
    // What's left unpaid on each card's LATEST statement (statements are
    // cumulative — older ones are already inside it), due within the
    // window — a committed outflow, same standing as an unpaid bill.
    // Business cards only; personal (Jake/Ashley) cards are outside the
    // farm business.
    pool.query(
      `SELECT COALESCE(SUM(GREATEST(s.statement_balance - COALESCE(s.paid_amount, 0), 0)), 0) AS total
       FROM (${LATEST_STATEMENTS_SQL}) s JOIN credit_cards cc ON cc.id = s.credit_card_id
       WHERE s.paid = false AND cc.status = 'active' AND s.due_date > $1 AND s.due_date <= $2
         AND (cc.segment IS NULL OR cc.segment NOT IN ('personal', 'jake', 'ashley'))`,
      [today, projTo]
    ),
  ]);
  let estIn = 0;
  let estOut = 0;
  const estFrom = addDays(today, 1);
  const estToExclusive = addDays(projTo, 1);
  for (const est of await forecastEstimates()) {
    const w = ownerWeights(est);
    const businessShare = 1 - w.jake - w.ashley;
    if (businessShare <= 0) continue;
    const n = occurrences(est, estFrom, estToExclusive).length;
    const amt = n * signedAmount(est) * businessShare;
    if (amt >= 0) estIn += amt; else estOut += -amt;
  }
  const billsTotal = billRow.rows.reduce(
    (s, b) => s + billDates(b, today, estToExclusive).length * Number(b.amount) * businessShare(b), 0
  );
  // No draw budget is stored, so next year's withdrawals are assumed to
  // match the last 12 months' — lenders use the family-living budget here,
  // and the trailing actual is the evidence-based stand-in for one.
  const projected = coverageResult({
    from: estFrom, to: projTo, threshold,
    service: projService,
    lines: [
      { label: 'Contracted receipts', amount: Number(contractRow.rows[0].total) },
      { label: 'Estimated receipts', amount: estIn },
      { label: 'Bills (incl. recurring)', amount: -billsTotal },
      { label: 'Estimated expenses', amount: -estOut },
      { label: 'Account fees', amount: -fees.reduce((a, b) => a + b, 0) },
      { label: 'Credit card payments due', amount: -Number(cardRow.rows[0].total) },
      { label: 'Operating-line interest', amount: -projService.operatingInterest },
      { label: 'Owner draws (at last 12 months’ pace)', amount: -drawsTrailing },
    ],
  });

  return {
    standard: 'FFSC term debt coverage ratio',
    threshold,
    historical,
    projected,
    ratio: projected.ratio,
    passes: projected.passes,
  };
}

/**
 * Projected TDCR with extra annual term payments layered on — how a
 * financed purchase is tested. Returns null when there'd still be no term
 * debt to cover.
 */
export function coverageWithAddedDebt(coverage, addedAnnualService) {
  const service = coverage.projected.termDebtService + Math.max(0, Number(addedAnnualService) || 0);
  return service > 0 ? coverage.projected.capacity / service : null;
}


/**
 * Liquidity floor: ROLLING 12-month projection of business cash, starting
 * from the live operating balance TODAY and walking forward from the
 * current month. Only future known flows enter it — unsettled contract
 * inflows, unpaid bills, unpaid scheduled debt service, recurring account
 * fees — because everything already booked is already inside today's
 * balance (replaying past months on top of a live balance would count the
 * same dollars twice). Anything overdue-but-unpaid lands in the current
 * month: past its due date or not, it still hasn't moved. The floor is the
 * lowest point in the projection, not the current balance.
 */
export async function liquidityFloor() {
  const bufferPct = Number(await getSetting('liquidity_buffer_pct', 0.15));

  // Everything: a sole proprietorship's farm and household money is one
  // pot, so the forecast starts from every account and carries every
  // owner's bills, contracts, loans, cards and estimates.
  const accounts = await allAccountBalances();
  const startingBalance = accounts.reduce((s, a) => s + a.balance, 0);

  const now = new Date();
  const y0 = now.getFullYear();
  const m0 = now.getMonth(); // 0-based
  const monthsMeta = Array.from({ length: MONTHS }, (_, i) => {
    const d = new Date(y0, m0 + i, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });
  const windowEnd = new Date(y0, m0 + MONTHS, 1); // exclusive
  const endStr = `${windowEnd.getFullYear()}-${String(windowEnd.getMonth() + 1).padStart(2, '0')}-01`;

  // Bucket a due date into the window; anything overdue clamps to month 0.
  const idxFor = (d) => Math.max(0, monthIndex(d, y0, m0));

  const [billRows, debtRows, contractRows, fees, cardRows] = await Promise.all([
    pool.query(
      // Every unpaid bill, in full (financed bills at what they'll owe on the due date).
      `SELECT id, name, due_date, bill_owing(bills, due_date) AS amount, frequency, ledger, segment, is_segment_split, segment_grain_pct, segment_livestock_pct, segment_jake_pct, segment_ashley_pct FROM bills
       WHERE status = 'unpaid' AND due_date < $1`,
      [endStr]
    ),
    // Every scheduled loan payment, farm and personal (a home mortgage included).
    pool.query(
      `SELECT lp.due_date, lp.principal_amount + lp.interest_amount AS amount, lp.interest_amount, COALESCE(l.name, l.lender) AS loan
       FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
       WHERE lp.paid = false AND lp.due_date < $1`,
      [endStr]
    ),
    pool.query(
      `SELECT id, commodity, counterparty, expected_payment_date AS due_date, GREATEST(total_value - received_amount, 0) AS amount
       FROM sale_contracts
       WHERE status IN ('open', 'delivered') AND expected_payment_date < $1`,
      [endStr]
    ),
    monthlyAccountFees(y0), // same value every month (monthly fees + annual/12)
    // What's left unpaid on each card's latest statement — a scheduled
    // outflow at its due date, same treatment as an unpaid bill.
    // Every active card.
    pool.query(
      `SELECT s.due_date, GREATEST(s.statement_balance - COALESCE(s.paid_amount, 0), 0) AS amount, cc.name AS card
       FROM (${LATEST_STATEMENTS_SQL}) s JOIN credit_cards cc ON cc.id = s.credit_card_id
       WHERE s.paid = false AND cc.status = 'active' AND s.due_date < $1`,
      [endStr]
    ),
  ]);
  const feesPerMonth = fees[0] || 0;

  // Estimates: every active estimate, at each occurrence from today through
  // the window. Past occurrences never count — see lib/estimates.js.
  // Every flow, itemized by month — what the Cash Flow page lists when a
  // month is opened. kind: contract / estimate_in / bill / loan / card /
  // fee / tax / estimate_out. amount is signed (money in positive).
  const items = Array.from({ length: MONTHS }, () => []);
  const put = (i, it) => items[Math.min(Math.max(i, 0), MONTHS - 1)].push({ ...it, amount: Math.round(it.amount * 100) / 100 });
  const estInBy = Array(MONTHS).fill(0);
  const estOutBy = Array(MONTHS).fill(0);
  for (const est of await forecastEstimates()) {
    for (const d of occurrences(est, todayISO(), endStr)) {
      const amt = signedAmount(est);
      put(idxFor(d), {
        kind: amt >= 0 ? 'estimate_in' : 'estimate_out', label: est.name || est.commodity || 'Estimate',
        date: toISODate(d), amount: amt, estimate: true,
      });
      const i = Math.min(idxFor(d), MONTHS - 1);
      if (amt >= 0) estInBy[i] += amt; else estOutBy[i] += -amt;
    }
  }

  const billsBy = Array(MONTHS).fill(0);
  for (const r of billRows.rows) {
    for (const d of billDates(r, todayISO(), endStr)) {
      billsBy[Math.min(idxFor(d), MONTHS - 1)] += Number(r.amount);
      put(idxFor(d), { kind: 'bill', label: r.name, date: toISODate(d), amount: -Number(r.amount), id: r.id,
        overdue: toISODate(d) < todayISO() });
    }
  }
  // The farm's Dec 31 income tax instalment (personal tax, paid from the same pot).
  const taxBy = Array(MONTHS).fill(0);
  try {
    const tax = await farmIncomeTax(y0);
    const due = tax.instalment.due;
    if (tax.instalment.amount > 0 && !tax.instalment.paid && due >= todayISO() && due < endStr) {
      taxBy[Math.min(idxFor(due), MONTHS - 1)] += tax.instalment.amount;
      put(idxFor(due), { kind: 'tax', label: 'Income tax instalment (farm)', date: due, amount: -tax.instalment.amount, estimate: true });
    }
  } catch (e) { console.error('Tax instalment skipped in cash flow:', e.message); }
  const debtBy = Array(MONTHS).fill(0);
  for (const r of debtRows.rows) {
    debtBy[Math.min(idxFor(r.due_date), MONTHS - 1)] += Number(r.amount);
    put(idxFor(r.due_date), { kind: 'loan', label: r.loan, date: toISODate(r.due_date), amount: -Number(r.amount),
      interest: Number(r.interest_amount) });
  }
  const contractsBy = Array(MONTHS).fill(0);
  for (const r of contractRows.rows) {
    contractsBy[Math.min(idxFor(r.due_date), MONTHS - 1)] += Number(r.amount);
    put(idxFor(r.due_date), { kind: 'contract', label: [r.commodity, r.counterparty].filter(Boolean).join(' — '),
      date: toISODate(r.due_date), amount: Number(r.amount), id: r.id, overdue: toISODate(r.due_date) < todayISO() });
  }
  const cardsBy = Array(MONTHS).fill(0);
  for (const r of cardRows.rows) {
    cardsBy[Math.min(idxFor(r.due_date), MONTHS - 1)] += Number(r.amount);
    put(idxFor(r.due_date), { kind: 'card', label: `${r.card} statement`, date: toISODate(r.due_date), amount: -Number(r.amount) });
  }
  if (feesPerMonth) for (let i = 0; i < MONTHS; i++) put(i, { kind: 'fee', label: 'Account fees', amount: -feesPerMonth });

  // Two projections from the same starting balance. COMMITTED uses only
  // documented flows (contracts, bills, loan schedules, fees). WITH
  // ESTIMATES adds the operator's own estimated inflows/outflows — and is
  // the default everywhere, including the purchase gate, because this
  // operation's cash arrives in large lumps between long dry stretches: a
  // big balance today is not spendable if months of estimated costs with
  // no committed income follow it.
  let committedRunning = startingBalance;
  let running = startingBalance;
  const trajectory = monthsMeta.map((meta, i) => {
    const committedNet = contractsBy[i] - billsBy[i] - debtBy[i] - feesPerMonth - cardsBy[i];
    committedRunning += committedNet;
    running += committedNet + estInBy[i] - estOutBy[i] - taxBy[i];
    return {
      year: meta.year,
      month: meta.month,
      balance: running,
      committedBalance: committedRunning,
      contractInflows: contractsBy[i],
      unpaidBillsDue: billsBy[i],
      debtServiceDue: debtBy[i],
      accountFees: feesPerMonth,
      creditCardDue: cardsBy[i],
      estimatedInflows: estInBy[i],
      estimatedOutflows: estOutBy[i],
      taxInstalment: taxBy[i],
      items: items[i].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    };
  });

  const floorMonth = trajectory.reduce((a, b) => (b.balance < a.balance ? b : a));
  const committedFloor = trajectory.reduce((a, b) => (b.committedBalance < a.committedBalance ? b : a));

  // Buffer benchmark: average monthly outflow (farm and household) over
  // the trailing 12 months of actuals (not the calendar year to date).
  const avgMonthlyExpense =
    (await pool.query(
      `SELECT COALESCE(AVG(monthly_outflow), 0) AS avg FROM (
         SELECT date_trunc('month', date) AS m, SUM(-amount) AS monthly_outflow
         FROM transaction_lines
         WHERE amount < 0 AND is_transfer = false
           AND date >= CURRENT_DATE - INTERVAL '12 months'
         GROUP BY m
       ) sub`
    )).rows[0].avg;

  const requiredFloor = Number(avgMonthlyExpense) * bufferPct;

  return {
    startingBalance,
    accounts,
    trajectory,
    floorMonth,
    committedFloorMonth: { year: committedFloor.year, month: committedFloor.month, balance: committedFloor.committedBalance },
    bufferPct,
    requiredFloor,
    passes: floorMonth.balance >= requiredFloor,
  };
}

/** Reserve status vs. target (default: 2 months of average business expenses). */
export async function reserveStatus(year) {
  const targetMonths = Number(await getSetting('reserve_target_months', 2));

  const { rows: reserveAccountRows } = await pool.query(
    `SELECT COALESCE(SUM(opening_balance), 0) AS total
     FROM accounts WHERE account_type = 'reserve'`
  );
  const { rows: transferRows } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'sweep_in' THEN amount ELSE 0 END), 0) AS in_total,
       COALESCE(SUM(CASE WHEN direction = 'draw_out' THEN amount ELSE 0 END), 0) AS out_total
     FROM reserve_transfers`
  );
  const currentReserve =
    Number(reserveAccountRows[0].total) +
    Number(transferRows[0].in_total) -
    Number(transferRows[0].out_total);

  const { rows: avgExpenseRows } = await pool.query(
    `SELECT COALESCE(AVG(monthly_outflow), 0) AS avg FROM (
       SELECT EXTRACT(MONTH FROM date) AS m, SUM(-amount) AS monthly_outflow
       FROM transaction_lines
       WHERE ledger = 'business' AND amount < 0 AND is_transfer = false AND EXTRACT(YEAR FROM date) = $1
       GROUP BY m
     ) sub`,
    [year]
  );
  const avgMonthlyExpense = Number(avgExpenseRows[0].avg);
  const target = avgMonthlyExpense * targetMonths;

  return {
    currentReserve,
    targetMonths,
    target,
    fundedPct: target > 0 ? Math.min(currentReserve / target, 1) : null,
    passes: currentReserve >= target,
  };
}

/** Every account and its balance today — the cash the forecast starts from. */
export async function allAccountBalances() {
  const { rows } = await pool.query(
    `SELECT id, name, ledger, account_type, opening_balance FROM accounts ORDER BY ledger, account_type, name`);
  return rows.map((a) => ({ id: a.id, name: a.name, ledger: a.ledger, type: a.account_type, balance: Number(a.opening_balance) }));
}

/**
 * Cash above the floor and the reserve — what could actually be deployed
 * today. All accounts are counted (the reserve's money included), so the
 * whole reserve target is held back, not just its shortfall.
 */
export async function deployableCapital(year, liquidity, reserve) {
  const cash = (await allAccountBalances()).reduce((s, a) => s + a.balance, 0);
  return cash - liquidity.requiredFloor - reserve.target;
}

async function avgMonthlyExpenseValue(year) {
  const { rows } = await pool.query(
    `SELECT COALESCE(AVG(monthly_outflow), 0) AS avg FROM (
       SELECT EXTRACT(MONTH FROM date) AS m, SUM(-amount) AS monthly_outflow
       FROM transaction_lines
       WHERE amount < 0 AND is_transfer = false AND EXTRACT(YEAR FROM date) = $1
       GROUP BY m
     ) sub`,
    [year]
  );
  return Number(rows[0].avg);
}

export async function runwayMonths(year) {
  const operatingCash = (await allAccountBalances()).reduce((s, a) => s + a.balance, 0);
  const avg = await avgMonthlyExpenseValue(year);
  return avg > 0 ? operatingCash / avg : null;
}

/** Outstanding principal balance on a loan as of a given date. */
export function loanOutstandingBalance(loan, payments, asOf = new Date()) {
  const paidPrincipal = payments
    .filter((p) => p.paid || new Date(p.due_date) <= asOf)
    .reduce((s, p) => s + Number(p.principal_amount), 0);
  return Math.max(Number(loan.principal) - paidPrincipal, 0);
}

/**
 * Convert a purchase price into units of the core return-generating asset
 * (e.g. heifer-equivalents at a given per-unit annual clear rate), rather
 * than evaluating the raw dollar figure.
 */
export function opportunityCostUnits(price, unitValue) {
  if (!unitValue) return null;
  return price / unitValue;
}
