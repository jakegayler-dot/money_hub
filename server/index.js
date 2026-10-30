import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import dashboardRoute from './routes/dashboard.js';
import accountsRoute from './routes/accounts.js';
import transactionsRoute from './routes/transactions.js';
import loansRoute from './routes/loans.js';
import expensesRoute from './routes/expenses.js';
import drawsRoute from './routes/draws.js';
import purchaseEvaluatorRoute from './routes/purchase-evaluator.js';
import billsRoute from './routes/bills.js';
import contractsRoute from './routes/contracts.js';
import entityRoute from './routes/entity.js';
import balanceSheetRoute from './routes/balanceSheet.js';
import financialsRoute from './routes/financials.js';
import { recordInventory } from './lib/financials.js';
import quickenRoute from './routes/quicken.js';
import assetsRoute from './routes/assets.js';
import inventoryRoute from './routes/inventory.js';
import estimatesRoute from './routes/estimates.js';
import creditCardsRoute from './routes/credit-cards.js';
import statementsRoute from './routes/statements.js';
import payeesRoute from './routes/payees.js';
import booksRoute from './routes/books.js';
import forecastRoute from './routes/forecast.js';
import taxRoute from './routes/tax.js';
import personalRoute from './routes/personal.js';
import calendarRoute from './routes/calendar.js';
import receiptsRoute, { receiptUpload } from './routes/receipts.js';
import groceriesRoute from './routes/groceries.js';
import farmDocsRoute from './routes/farmDocs.js';
import goalsRoute from './routes/goals.js';
import rewardsRoute from './routes/rewards.js';
import { readPending, matchPending } from './lib/receipts.js';
import { pairTransfers } from './lib/transferPairs.js';
import { reclassifyCardPayments } from './lib/postings.js';
import { pairAllCardPayments, splitAllLoanPayments, syncLoanPieceOwners, settleAllVendorAccounts, reorderLoanPayments } from './lib/postings.js';
import { withTransaction, pool } from './db.js';
import { authRouter, requireSignIn, authEnabled } from './lib/appAuth.js';
import sentinelReadRoute, { requireActionKey } from './routes/sentinelRead.js';
import { applyContractRules } from './lib/contracts.js';
import sentinelActionsRoute from './routes/sentinelActions.js';
import { trackClaude } from './lib/aiUsage.js';
import { registerBridge } from './lib/sentinelBridge.js';
import sentinelRoute from './routes/sentinel.js';
import advisorRoute from './routes/advisor.js';
import paystubsRoute, { ingestRouter as paystubIngest } from './routes/paystubs.js';
import { matchAllStubs } from './lib/paystubs.js';
import { sentinelWriteTrigger, startSentinelSync } from './lib/sentinel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
trackClaude(); // every Claude call recorded with its cost (lib/aiUsage.js)
const app = express();
// Railway's proxy sits in front: trust exactly that one hop, so req.ip is
// the real visitor (the sign-in limit counts per address).
app.set('trust proxy', 1);
app.use(cors());
// The receipt upload takes a raw image body, so it's mounted before the JSON parser.
app.use('/api/receipts/upload', receiptUpload);
// A Quicken export sent as JSON can be bigger than the usual limit.
app.use('/api/quicken/import', express.json({ limit: '25mb' }));
// Ashley's agent files paystubs with its own key (PAYSTUB_API_KEY), stubs and
// their PDFs in the body: before the JSON parser and the sign-in guard.
app.use('/api/paystubs/ingest', paystubIngest);
app.use(express.json());

// Any successful write under /api (including statement ingest paying bills)
// schedules a debounced Sentinel sync. Fires after the response is sent, so
// it can never slow down or fail the request itself.
app.use('/api', sentinelWriteTrigger);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Sentinel's read-only data API: its own key (SENTINEL_ACTION_KEY), so
// it's mounted before the sign-in guard below; with the actions it's the only path exempt.
app.use('/api/sentinel/read', sentinelReadRoute);
// Sentinel's actions (same key): what-if purchase checks, optionally saved.
// The general bridge: Sentinel can do anything the screens can (lib/sentinelBridge.js); same key as the actions.
registerBridge(app, { port: () => port, auth: requireActionKey });
app.use('/api/sentinel/actions', sentinelActionsRoute);
// The sync preview (GET /api/sentinel/preview) has its own key too (X-Api-Key = INGEST_API_KEY).
app.use('/api/sentinel', sentinelRoute);

// Everything under /api below this needs a signed-in browser or the API key.
app.use('/api/auth', authRouter);
app.use('/api', requireSignIn);
if (!authEnabled()) console.warn('APP_PASSWORD is not set — Money Hub is open to anyone with the link.');

app.use('/api/dashboard', dashboardRoute);
app.use('/api/accounts', accountsRoute);
app.use('/api/transactions', transactionsRoute);
app.use('/api/loans', loansRoute);
app.use('/api/expenses', expensesRoute);
app.use('/api/draws', drawsRoute);
app.use('/api/purchase-evaluations', purchaseEvaluatorRoute);
app.use('/api/bills', billsRoute);
app.use('/api/contracts', contractsRoute);
app.use('/api/entity-summary', entityRoute);
app.use('/api/balance-sheet', balanceSheetRoute);
app.use('/api/financials', financialsRoute);
app.use('/api/advisor', advisorRoute);
app.use('/api/paystubs', paystubsRoute);
app.use('/api/quicken', quickenRoute);
app.use('/api/assets', assetsRoute);
app.use('/api/inventory', inventoryRoute);
app.use('/api/estimates', estimatesRoute);
app.use('/api/credit-cards', creditCardsRoute);
app.use('/api/statements', statementsRoute);
app.use('/api/payees', payeesRoute);
app.use('/api/books', booksRoute);
app.use('/api/tax', taxRoute);
app.use('/api/forecast', forecastRoute);
app.use('/api/personal', personalRoute);
app.use('/api/calendar', calendarRoute);
app.use('/api/receipts', receiptsRoute);
app.use('/api/groceries', groceriesRoute);
app.use('/api/farm-docs', farmDocsRoute);
app.use('/api/goals', goalsRoute);
app.use('/api/rewards', rewardsRoute);

// In production, this is the only Railway service — it serves the built
// client alongside the API so there's nothing extra to deploy or wire up.
if (process.env.NODE_ENV === 'production') {
  const clientDist = join(__dirname, '..', 'client', 'dist');
  // redirect: false — the build keeps its JS/CSS in dist/assets/, which
  // collides with the /assets page route. Without this, visiting /assets
  // triggers a directory redirect to /assets/ instead of loading the page.
  app.use(express.static(clientDist, { redirect: false }));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'not found' });
    res.sendFile(join(clientDist, 'index.html'));
  });
}

// Catches any error thrown/rejected inside a route (including async ones) and
// returns it as JSON instead of letting Node crash the whole process on an
// unhandled rejection — a single bad query should never take the app down.
app.use((err, req, res, next) => {
  console.error('Request error:', err);
  // Routes can throw an error carrying .status (e.g. 400 for a loan
  // payment that doesn't cover interest) to report a user-fixable problem.
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (recovered, not crashing):', reason);
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Money Hub listening on :${port}`);
  startSentinelSync(); // bills, loan and card payments, contracts → Sentinel's calendar; Money tile summary
  // Receipts that arrived before the API key was set, or while the server was down.
  setTimeout(() => readPending().then(matchPending).catch((e) => console.error('Receipt catch-up failed:', e.message)), 3000);
  // Card payments seen on both the bank and the card statement count once
  // (also folds in duplicates posted before this rule existed).
  setTimeout(() => withTransaction((c) => pairAllCardPayments(c))
    .then((n) => n && console.log(`Folded ${n} card-side payment line(s) into their bank-side payments.`))
    .catch((e) => console.error('Card payment pairing failed:', e.message)), 2000);
  // Both sides of transfers between your own accounts, paired.
  setTimeout(() => withTransaction((c) => pairTransfers(c))
    .then((p) => p.length && console.log(`Paired ${p.length} transfer(s) between your accounts.`))
    .catch((e) => console.error('Transfer pairing failed:', e.message)), 2200);
  // Card payments re-filed under the current rules (a carried starting balance is debt, not spending).
  setTimeout(() => withTransaction(async (c) => {
    const { rows } = await c.query('SELECT id FROM credit_cards WHERE ledger_start_date IS NOT NULL');
    for (const r of rows) await reclassifyCardPayments(c, r.id);
    return rows.length;
  }).catch((e) => console.error('Card payment re-filing failed:', e.message)), 2300);
  // Loan payments recorded before interest/principal were split out.
  setTimeout(() => withTransaction(async (c) => { const n = await splitAllLoanPayments(c); await syncLoanPieceOwners(c); return n; })
    .then((n) => n && console.log(`Split ${n} loan payment(s) into interest and principal.`))
    .catch((e) => console.error('Loan payment split failed:', e.message)), 2500);
  // Loan payments that were put on a later scheduled payment while an earlier one was open: back in order.
  setTimeout(() => reorderLoanPayments(withTransaction)
    .then((ids) => ids.length && console.log(`Put the payments on ${ids.length} loan(s) back in date order.`))
    .catch((e) => console.error('Loan reorder failed:', e.message)), 3000);
  // Vendor accounts settle oldest first: credit with a vendor pays its bills as they're billed.
  setTimeout(() => settleAllVendorAccounts(withTransaction), 3500);
  // Contracts: delivered once their delivery date passes; payment dates on the rule (lib/contracts.js).
  const contractRules = () => applyContractRules(pool).catch((e) => console.error('Contract rules failed:', e.message));
  setTimeout(contractRules, 4000);
  setInterval(contractRules, 6 * 60 * 60 * 1000);
  // Inventory value once a day, so an income statement has the start of its period (lib/financials.js).
  const inventoryRecord = () => recordInventory().catch((e) => console.error('Inventory record failed:', e.message));
  setTimeout(inventoryRecord, 6000);
  setInterval(inventoryRecord, 6 * 60 * 60 * 1000);
  setInterval(() => settleAllVendorAccounts(withTransaction), 6 * 60 * 60 * 1000);
  // Paystubs whose deposit hadn't arrived yet: look again.
  const stubMatch = () => matchAllStubs().catch((e) => console.error('Paystub matching failed:', e.message));
  setTimeout(stubMatch, 9000);
  setInterval(stubMatch, 6 * 60 * 60 * 1000);
});
