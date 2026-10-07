// Sentinel sync: pushes Money Hub's bills, loan payments, card statements,
// covenant dates and expected contract payments to Sentinel (Jake's
// calendar/task hub) as one full snapshot. One-way: Money Hub owns the data
// and completion happens here; Sentinel only displays it. After each
// successful snapshot push, the Money tile summary (lib/sentinelSummary.js)
// goes to /v1/sources/money_hub/summary.
//
// Triggers: ~60 s after any successful write under /api (debounced), ~30 s
// after startup, and every 6 hours. Failures retry with backoff (1 min
// doubling to 60 min). None of this can block or fail a user request, and
// nothing runs until SENTINEL_URL and SENTINEL_API_KEY are both set.

import { pool, withTransaction } from '../db.js';
import { buildSnapshot, reginaToday, WINDOW_PAST_DAYS, WINDOW_FUTURE_DAYS } from './sentinelSnapshot.js';
import { deadlineItems, taxItems, gstItems } from './calendar.js';
import { buildSummary } from './sentinelSummary.js';
import { liquidityFloor, termDebtCoverage, scheduledServiceBetween } from './calculations.js';
import { loadBalanceSheet, inventoryOwnerRow } from './balanceSheet.js';
import { cardAmountsDue } from './cardLedger.js';
import { addDays, addMonths } from './dates.js';

const DEBOUNCE_MS = 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;
const PERIODIC_MS = 6 * 60 * 60 * 1000;
const RETRY_MIN_MS = 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const state = { timer: null, running: false, rerun: false, retryMs: 0, warned: false, started: false };

function config() {
  const url = process.env.SENTINEL_URL;
  const key = process.env.SENTINEL_API_KEY;
  if (!url || !key) {
    if (!state.warned) {
      console.log('Sentinel sync disabled: set SENTINEL_URL and SENTINEL_API_KEY to enable it.');
      state.warned = true;
    }
    return null;
  }
  return { url: url.replace(/\/+$/, ''), key };
}

/**
 * Reads everything the snapshot needs inside one read-only REPEATABLE READ
 * transaction, so the list is a consistent point-in-time picture — a
 * snapshot that caught a bill mid-payment could otherwise drop it.
 */
export async function loadSnapshotRows() {
  return withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const [bills, loanPayments, statements, loans, contracts] = await Promise.all([
      client.query(`SELECT id, name, ledger, category, amount, frequency, due_date, status, paid_date, notes
                    FROM bills`),
      client.query(`SELECT lp.id, lp.loan_id, lp.due_date, lp.principal_amount, lp.interest_amount,
                           lp.paid, lp.paid_date, lp.is_adjustment, l.name AS loan_name, l.lender
                    FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
                    WHERE lp.is_adjustment = false`),
      client.query(`SELECT s.id, s.credit_card_id, s.statement_date, s.due_date, s.statement_balance, s.minimum_payment,
                           s.paid, s.paid_date, s.paid_amount, s.notes, c.name AS card_name
                    FROM credit_card_statements s JOIN credit_cards c ON c.id = s.credit_card_id`),
      client.query(`SELECT id, name, lender, covenant_date, covenant_notes FROM loans
                    WHERE covenant_date IS NOT NULL`),
      client.query(`SELECT id, commodity, counterparty, quantity, unit, total_value, received_amount, expected_payment_date,
                           status, notes
                    FROM sale_contracts WHERE status != 'cancelled'`),
    ]); // one client: pg runs these one after another, same snapshot
    return {
      bills: bills.rows, loanPayments: loanPayments.rows, statements: statements.rows,
      loans: loans.rows, contracts: contracts.rows,
    };
  });
}

/**
 * Tax, GST and program deadlines over the snapshot's longest possible
 * window. Throws rather than returning a partial list: Sentinel deletes
 * whatever a snapshot leaves out.
 */
export async function loadCalendarDeadlines(now = new Date()) {
  const today = reginaToday(now);
  const from = addDays(today, -WINDOW_PAST_DAYS);
  const to = addDays(today, WINDOW_FUTURE_DAYS);
  const parts = await Promise.all([deadlineItems(from, to), taxItems(from, to), gstItems(from, to)]);
  return parts.flat();
}

export async function buildSnapshotFromDb(now = new Date()) {
  const rows = await loadSnapshotRows();
  rows.deadlines = await loadCalendarDeadlines(now);
  return buildSnapshot(rows, { now, appUrl: process.env.APP_URL || null });
}

/**
 * Everything the Money tile summary needs, taken from the same functions
 * Money Hub's own screens use (liquidityFloor, termDebtCoverage,
 * loadBalanceSheet) so the tile and the app agree, plus a few raw sums.
 * Business ledger, transfers excluded — same line filters as calculations.js.
 */
export async function loadSummaryInputs(now = new Date(), snapshotRows = null) {
  const today = reginaToday(now);
  const d30 = addDays(today, -30);
  const d12 = addMonths(today, -12);
  const ytdFrom = `${today.slice(0, 4)}-01-01`;
  const [liquidity, coverage, sheet, accounts, flows, t12Service, cardDue, rows] = await Promise.all([
    liquidityFloor(),
    termDebtCoverage(),
    loadBalanceSheet(today),
    pool.query(`SELECT ledger, opening_balance AS balance FROM accounts`),
    pool.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE amount > 0 AND date > $1), 0) AS cf_in,
         COALESCE(SUM(amount) FILTER (WHERE amount < 0 AND date > $1), 0) AS cf_out,
         MAX(date) AS last_tx,
         COALESCE(SUM(amount) FILTER (WHERE op AND amount > 0 AND date >= $2), 0) AS ytd_rev,
         COALESCE(SUM(amount) FILTER (WHERE op AND amount < 0 AND date >= $2), 0) AS ytd_exp,
         COALESCE(SUM(amount) FILTER (WHERE op AND amount > 0 AND date > $3), 0) AS t12_rev,
         COALESCE(SUM(amount) FILTER (WHERE op AND amount < 0 AND date > $3), 0) AS t12_exp,
         COUNT(*) FILTER (WHERE date > $3)::int AS t12_lines
       FROM (SELECT date, amount, (is_capex = false AND is_debt_service = false) AS op
             FROM transaction_lines
             WHERE ledger = 'business' AND is_transfer = false AND date <= $4) l`,
      [d30, ytdFrom, d12, today]
    ),
    scheduledServiceBetween(d12, today),
    cardAmountsDue(pool),
    snapshotRows || loadSnapshotRows(),
  ]);
  const f = flows.rows[0];
  return {
    cashFlow30: { inflow: f.cf_in, outflow: f.cf_out, lastTxDate: f.last_tx },
    liquidity,
    coverage,
    balance: {
      accounts: accounts.rows,
      assets: sheet.assets,
      inventoryRows: sheet.inventoryRows.map((i) => ({ counted_value: i.counted_value, ...inventoryOwnerRow(i) })),
      loans: sheet.loans,
      creditCards: sheet.creditCards,
      needsPrice: sheet.inventoryGroups.reduce((s, g) => s + (g.needs_price || 0), 0),
    },
    ytd: { revenue: f.ytd_rev, expenses: f.ytd_exp },
    trailing12: {
      revenue: f.t12_rev, expenses: f.t12_exp, lineCount: f.t12_lines,
      interest: t12Service.termInterest + t12Service.operatingInterest,
    },
    overdue: { bills: rows.bills, loanPayments: rows.loanPayments, cardStatements: cardDue },
  };
}

export async function buildSummaryFromDb(now = new Date(), snapshotRows = null) {
  return buildSummary(await loadSummaryInputs(now, snapshotRows), { now });
}

/** Sends the Money tile summary. Returns { retry } like pushSnapshot. */
async function pushSummary(cfg, body) {
  let res;
  try {
    res = await fetch(`${cfg.url}/v1/sources/money_hub/summary`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Sentinel summary: network error (${err.name}: ${err.message}) — will retry.`);
    return { retry: true };
  }
  const text = await res.text().catch(() => '');
  if (res.ok) {
    console.log(`Sentinel summary sent: ${body.summary.status_line}`);
    return { retry: false };
  }
  const detail = text.slice(0, 500);
  if (res.status >= 500 || res.status === 429 || res.status === 408) {
    console.error(`Sentinel summary: HTTP ${res.status} — will retry. ${detail}`);
    return { retry: true };
  }
  console.error(`Sentinel summary: HTTP ${res.status} — not retrying. ${detail}`);
  return { retry: false };
}

/** Sends one snapshot. Returns { retry, ok } — retry true only for failures worth retrying. */
async function pushSnapshot(cfg, snapshot) {
  let res;
  try {
    res = await fetch(`${cfg.url}/v1/sources/money_hub/snapshot`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`Sentinel sync: network error (${err.name}: ${err.message}) — will retry.`);
    return { retry: true };
  }

  const text = await res.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

  if (res.ok) {
    const b = body || {};
    console.log(`Sentinel sync: ${snapshot.items.length} items sent (${snapshot.from} → ${snapshot.to}) — `
      + `created ${b.created ?? '?'}, updated ${b.updated ?? '?'}, unchanged ${b.unchanged ?? '?'}, `
      + `removed ${b.removed ?? '?'}, stale ${Array.isArray(b.stale_items) ? b.stale_items.length : (b.stale_items ?? 0)}.`);
    if (Array.isArray(b.invalid) && b.invalid.length) {
      console.error(`Sentinel sync: ${b.invalid.length} item(s) rejected as invalid:`, JSON.stringify(b.invalid).slice(0, 4000));
    }
    return { retry: false, ok: true };
  }
  if (res.status === 409) {
    console.log('Sentinel sync: 409 stale_snapshot (a newer snapshot already landed) — ignored.');
    return { retry: false };
  }
  if (res.status === 401 || res.status === 403) {
    console.error(`Sentinel sync: REJECTED ${res.status} — check SENTINEL_API_KEY (and that it's allowed to write the money_hub source). Not retrying until the next trigger.`);
    return { retry: false };
  }
  const detail = text.slice(0, 500);
  if (res.status >= 500 || res.status === 429 || res.status === 408) {
    console.error(`Sentinel sync: HTTP ${res.status} — will retry. ${detail}`);
    return { retry: true };
  }
  console.error(`Sentinel sync: HTTP ${res.status} — not retrying. ${detail}`);
  return { retry: false };
}

async function runSync() {
  state.timer = null;
  const cfg = config();
  if (!cfg) return;
  state.running = true;
  let retry = false;
  try {
    let snapshot;
    let snapshotRows;
    const now = new Date();
    try {
      snapshotRows = await loadSnapshotRows();
      snapshotRows.deadlines = await loadCalendarDeadlines(now);
      snapshot = buildSnapshot(snapshotRows, { now, appUrl: process.env.APP_URL || null });
    } catch (err) {
      // Never send a partial list — Sentinel would delete what's missing.
      console.error('Sentinel sync: building the snapshot failed, nothing sent — will retry.', err);
      retry = true;
    }
    if (snapshot) {
      const pushed = await pushSnapshot(cfg, snapshot);
      retry = pushed.retry;
      // The Money tile summary follows each successful snapshot push. Its
      // failure never affects the snapshot; a retryable one retries the
      // whole sync (re-sending the snapshot is idempotent).
      if (pushed.ok) {
        let summary;
        try {
          summary = await buildSummaryFromDb(now, snapshotRows);
        } catch (err) {
          console.error('Sentinel summary: building it failed, nothing sent — will retry.', err);
          retry = true;
        }
        if (summary && (await pushSummary(cfg, summary)).retry) retry = true;
      }
    }
  } catch (err) {
    console.error('Sentinel sync: unexpected error — will retry.', err);
    retry = true;
  } finally {
    state.running = false;
  }

  if (state.rerun) {
    // A write landed mid-sync: send a fresh snapshot rather than a retry.
    state.rerun = false;
    state.retryMs = 0;
    scheduleSentinelSync(DEBOUNCE_MS);
  } else if (retry) {
    state.retryMs = state.retryMs ? Math.min(state.retryMs * 2, RETRY_MAX_MS) : RETRY_MIN_MS;
    console.log(`Sentinel sync: retrying in ${Math.round(state.retryMs / 60000)} min.`);
    scheduleSentinelSync(state.retryMs);
  } else {
    state.retryMs = 0;
  }
}

/** (Re)arms the sync timer. A newer call replaces a pending one (debounce). */
export function scheduleSentinelSync(delayMs = DEBOUNCE_MS) {
  if (!config()) return;
  if (state.running) { state.rerun = true; return; }
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { runSync().catch(() => {}); }, delayMs);
  state.timer.unref?.();
}

/** Express middleware: after any successful write under /api, schedule a sync. */
export function sentinelWriteTrigger(req, res, next) {
  if (WRITE_METHODS.has(req.method)) {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try { scheduleSentinelSync(); } catch (err) { console.error('Sentinel sync: could not schedule', err); }
      }
    });
  }
  next();
}

/** Called once at server start: first sync ~30 s in, then every 6 hours. */
export function startSentinelSync() {
  if (state.started || !config()) return;
  state.started = true;
  scheduleSentinelSync(STARTUP_DELAY_MS);
  setInterval(() => scheduleSentinelSync(0), PERIODIC_MS).unref?.();
}
