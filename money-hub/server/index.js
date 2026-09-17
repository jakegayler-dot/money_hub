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

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/dashboard', dashboardRoute);
app.use('/api/accounts', accountsRoute);
app.use('/api/transactions', transactionsRoute);
app.use('/api/loans', loansRoute);
app.use('/api/expenses', expensesRoute);
app.use('/api/draws', drawsRoute);
app.use('/api/purchase-evaluations', purchaseEvaluatorRoute);

// In production, this is the only Railway service — it serves the built
// client alongside the API so there's nothing extra to deploy or wire up.
if (process.env.NODE_ENV === 'production') {
  const clientDist = join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'not found' });
    res.sendFile(join(clientDist, 'index.html'));
  });
}

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Money Hub listening on :${port}`));
