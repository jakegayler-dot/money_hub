import { pool, getSetting } from '../db.js';
import { occurrences, signedAmount } from './estimates.js';
import { forecastEstimates } from './inventoryForecast.js';
import { ownerWeights, businessShare } from './segments.js';
import { monthIndex, todayISO, toISODate, addMonths, addDays } from './dates.js';
import { LATEST_STATEMENTS_SQL } from './cardLedger.js';
import { loadForecast, evaluate, buildTaxFlows, taxesFor, baseNetByYear, requiredFloorFor, scopeShare } from './forecast.js';

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

import { billDates } from './billDates.js';

export { billDates };

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
 * Liquidity floor: a ROLLING projection of cash (12 months by default),
 * starting from the live balances TODAY and walking forward from the
 * current month. Only future known flows enter it — contracts still to
 * come, inventory and estimated sales, unpaid bills, scheduled loan
 * payments, card statements, account fees, GST refunds and payments and
 * (by default) income tax — because everything already booked is already
 * inside today's balance. Anything overdue-but-unpaid lands in the current
 * month. The floor is the lowest point in the projection.
 *
 * scope: 'everything' (farm and household — a sole proprietorship's one
 * pot), 'farm' (Grain + Cattle shares only) or 'personal'. `accounts`
 * limits the starting cash to those account ids. With scope 'farm', the
 * Everything line comes back too as `reserve` — what the farm could draw on.
 */
export async function liquidityFloor({ months = 12, scope = 'everything', accounts = null, includeTax = true } = {}) {
  const ctx = await loadForecast({ months });
  const taxes = ctx.tax.available ? taxesFor(baseNetByYear(ctx)) : null;
  const flows = [...ctx.flows, ...(includeTax && taxes ? buildTaxFlows(ctx, taxes) : [])];
  const ev = evaluate(flows, ctx, { scope, accountIds: accounts });
  const requiredFloor = await requiredFloorFor(ctx.bufferPct);
  const trajectory = ev.trajectory;
  const floorMonth = trajectory[ev.lowIdx];
  const committedFloor = trajectory.reduce((a, b) => (b.committedBalance < a.committedBalance ? b : a));
  const reserve = scope === 'farm' ? evaluate(flows, ctx, { scope: 'everything' }) : null;
  const pick = accounts ? new Set(accounts.map(Number)) : null;
  return {
    scope, months, includeTax,
    startingBalance: ev.opening,
    accounts: ctx.accounts.map((a) => ({ ...a, included: !pick || pick.has(a.id), counted: (!pick || pick.has(a.id)) ? a.balance * scopeShare(scope, a.farm) : 0 })),
    trajectory,
    floorMonth,
    committedFloorMonth: { year: committedFloor.year, month: committedFloor.month, balance: committedFloor.committedBalance },
    bufferPct: ctx.bufferPct,
    requiredFloor,
    passes: floorMonth.balance >= requiredFloor,
    reserve: reserve ? { startingBalance: reserve.opening, balances: reserve.trajectory.map((t) => t.balance) } : null,
    tax: ctx.tax.available ? { y0: ctx.win.y0, net: ctx.tax.netY0, total: ctx.tax.taxY0, instalment: ctx.tax.instalmentY0 } : null,
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
