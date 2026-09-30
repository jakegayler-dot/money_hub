// Sentinel sync: pushes Money Hub's bills, loan payments, card statements,
// covenant dates and expected contract payments to Sentinel (Jake's
// calendar/task hub) as one full snapshot. One-way: Money Hub owns the data
// and completion happens here; Sentinel only displays it.
//
// Triggers: ~60 s after any successful write under /api (debounced), ~30 s
// after startup, and every 6 hours. Failures retry with backoff (1 min
// doubling to 60 min). None of this can block or fail a user request, and
// nothing runs until SENTINEL_URL and SENTINEL_API_KEY are both set.

import { withTransaction } from '../db.js';
import { buildSnapshot } from './sentinelSnapshot.js';

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
      client.query(`SELECT s.id, s.credit_card_id, s.due_date, s.statement_balance, s.minimum_payment,
                           s.paid, s.paid_date, s.paid_amount, s.notes, c.name AS card_name
                    FROM credit_card_statements s JOIN credit_cards c ON c.id = s.credit_card_id`),
      client.query(`SELECT id, name, lender, covenant_date, covenant_notes FROM loans
                    WHERE covenant_date IS NOT NULL`),
      client.query(`SELECT id, commodity, counterparty, quantity, unit, total_value, expected_payment_date,
                           status, notes
                    FROM sale_contracts WHERE status != 'cancelled'`),
    ]); // one client: pg runs these one after another, same snapshot
    return {
      bills: bills.rows, loanPayments: loanPayments.rows, statements: statements.rows,
      loans: loans.rows, contracts: contracts.rows,
    };
  });
}

export async function buildSnapshotFromDb(now = new Date()) {
  const rows = await loadSnapshotRows();
  return buildSnapshot(rows, { now, appUrl: process.env.APP_URL || null });
}

/** Sends one snapshot. Returns { retry } — true only for failures worth retrying. */
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
    return { retry: false };
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
    try {
      snapshot = await buildSnapshotFromDb();
    } catch (err) {
      // Never send a partial list — Sentinel would delete what's missing.
      console.error('Sentinel sync: building the snapshot failed, nothing sent — will retry.', err);
      retry = true;
    }
    if (snapshot) retry = (await pushSnapshot(cfg, snapshot)).retry;
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
