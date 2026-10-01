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
import assetsRoute from './routes/assets.js';
import inventoryRoute from './routes/inventory.js';
import estimatesRoute from './routes/estimates.js';
import creditCardsRoute from './routes/credit-cards.js';
import statementsRoute from './routes/statements.js';
import payeesRoute from './routes/payees.js';
import booksRoute from './routes/books.js';
import taxRoute from './routes/tax.js';
import receiptsRoute, { receiptUpload } from './routes/receipts.js';
import { readPending, matchPending } from './lib/receipts.js';
import { authRouter, requireSignIn, authEnabled } from './lib/appAuth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
// Railway's proxy sits in front: trust exactly that one hop, so req.ip is
// the real visitor (the sign-in limit counts per address).
app.set('trust proxy', 1);
app.use(cors());
// The receipt upload takes a raw image body, so it's mounted before the JSON parser.
app.use('/api/receipts/upload', receiptUpload);
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

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
app.use('/api/assets', assetsRoute);
app.use('/api/inventory', inventoryRoute);
app.use('/api/estimates', estimatesRoute);
app.use('/api/credit-cards', creditCardsRoute);
app.use('/api/statements', statementsRoute);
app.use('/api/payees', payeesRoute);
app.use('/api/books', booksRoute);
app.use('/api/tax', taxRoute);
app.use('/api/receipts', receiptsRoute);

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
  // Receipts that arrived before the API key was set, or while the server was down.
  setTimeout(() => readPending().then(matchPending).catch((e) => console.error('Receipt catch-up failed:', e.message)), 3000);
});
