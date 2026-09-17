import { pool, getSetting } from '../db.js';

const MONTHS = 12;

/**
 * Net Operating Income per month for a given year, business ledger only.
 * NOI = actual business transactions this month (excluding capex and debt
 * service) + forecasted expense-category outflows not yet booked.
 * For v1 (manual entry, no forecast-vs-actual reconciliation yet) this
 * uses booked transactions where present.
 */
export async function monthlyNOI(year) {
  const { rows } = await pool.query(
    `SELECT EXTRACT(MONTH FROM date)::int AS month, SUM(amount) AS net
     FROM transactions
     WHERE ledger = 'business'
       AND is_capex = false
       AND EXTRACT(YEAR FROM date) = $1
     GROUP BY month`,
    [year]
  );
  const byMonth = Array(MONTHS).fill(0);
  for (const r of rows) byMonth[r.month - 1] = Number(r.net);
  return byMonth;
}

/** Total scheduled debt service (principal + interest) per month, all loans. */
export async function monthlyDebtService(year) {
  const { rows } = await pool.query(
    `SELECT EXTRACT(MONTH FROM due_date)::int AS month,
            SUM(principal_amount + interest_amount) AS total
     FROM loan_payments
     WHERE EXTRACT(YEAR FROM due_date) = $1
     GROUP BY month`,
    [year]
  );
  const byMonth = Array(MONTHS).fill(0);
  for (const r of rows) byMonth[r.month - 1] = Number(r.total);
  return byMonth;
}

/**
 * DSCR = NOI / Total Debt Service, computed per month.
 * The gating number is the worst month, not the annual average —
 * an annual DSCR hides seasonal troughs.
 */
export async function computeDSCR(year) {
  const [noi, debtService] = await Promise.all([monthlyNOI(year), monthlyDebtService(year)]);
  const threshold = Number(await getSetting('dscr_threshold', 1.25));

  const monthly = noi.map((n, i) => {
    const ds = debtService[i];
    const ratio = ds === 0 ? null : n / ds;
    return { month: i + 1, noi: n, debtService: ds, dscr: ratio };
  });

  const withRatio = monthly.filter((m) => m.dscr !== null);
  const worst = withRatio.length
    ? withRatio.reduce((a, b) => (b.dscr < a.dscr ? b : a))
    : null;

  return {
    threshold,
    monthly,
    worstMonth: worst,
    passes: worst ? worst.dscr >= threshold : null,
  };
}

/**
 * Liquidity floor: projected cumulative business cash balance across the
 * year, starting from current operating account balances. The floor is
 * the lowest point in that projection, not the current balance.
 */
export async function liquidityFloor(year) {
  const bufferPct = Number(await getSetting('liquidity_buffer_pct', 0.15));

  const { rows: accountRows } = await pool.query(
    `SELECT COALESCE(SUM(opening_balance), 0) AS total
     FROM accounts WHERE ledger = 'business' AND account_type = 'operating'`
  );
  const startingBalance = Number(accountRows[0].total);

  const noi = await monthlyNOI(year);

  let running = startingBalance;
  const trajectory = noi.map((n, i) => {
    running += n;
    return { month: i + 1, balance: running };
  });

  const floorMonth = trajectory.reduce((a, b) => (b.balance < a.balance ? b : a));
  const avgMonthlyExpense =
    (await pool.query(
      `SELECT COALESCE(AVG(monthly_outflow), 0) AS avg FROM (
         SELECT EXTRACT(MONTH FROM date) AS m, SUM(-amount) AS monthly_outflow
         FROM transactions
         WHERE ledger = 'business' AND amount < 0 AND EXTRACT(YEAR FROM date) = $1
         GROUP BY m
       ) sub`,
      [year]
    )).rows[0].avg;

  const requiredFloor = Number(avgMonthlyExpense) * bufferPct;

  return {
    startingBalance,
    trajectory,
    floorMonth,
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
       FROM transactions
       WHERE ledger = 'business' AND amount < 0 AND EXTRACT(YEAR FROM date) = $1
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

/**
 * Convert a purchase price into units of the core return-generating asset
 * (e.g. heifer-equivalents at a given per-unit annual clear rate), rather
 * than evaluating the raw dollar figure.
 */
export function opportunityCostUnits(price, unitValue) {
  if (!unitValue) return null;
  return price / unitValue;
}
