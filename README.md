# Money Hub

Capital allocation and financial decision system. Aggregates business and
personal ledgers, loan schedules, unpaid bills, and expense budgets into a
single model, and gates capital purchases against a five-part quantitative
test:

1. **Liquidity floor** — projected minimum monthly cash balance (net of
   known unpaid bills), with a 15% buffer
2. **Debt Service Coverage Ratio (DSCR)** — Net Operating Income ÷ Total
   Debt Service, computed **monthly** (worst month binds), gated at **1.25x**
3. **Opportunity cost** — purchase price converted into units of the core
   return-generating asset, not evaluated as a raw dollar figure
4. **Reversibility** — resale/exit-cost weighting if the decision proves wrong
5. *(Milestone check deliberately out of scope for v1)*

Plus an **owner's draw / reserve mechanism**: a fixed monthly draw sized off
the cash-flow trough (not the average), a reserve account targeted at **2
months of operating expenses**, and a hard rule that the draw amount only
changes at a scheduled review — never as an in-month patch.

## Structure

```
money-hub/
  server/   Node/Express API + PostgreSQL schema
  client/   React (Vite) dashboard
```

Stack: React/Vite frontend, Node/Express backend, PostgreSQL (Railway in
production, local Postgres for development). Single Railway service builds
the client and serves it alongside the API.

## v1 scope decisions

- Data entry is **manual**, done directly against the schema via the UI —
  no CSV/API ingestion yet.
- Mixed-use asset allocation is a **user-set percentage on a cost basis**
  only (no mileage/usage-log methodology).
- Business and personal ledgers are **structurally separate** — DSCR and
  liquidity calculations run against the business ledger only.
- Milestone/strategic-date tracking is **not** part of v1.
- **Bills (accounts payable)**: invoices received but not yet paid are
  tracked separately from ledger transactions, and factored into the
  liquidity floor forecast at their due month — so the dashboard reflects
  known upcoming obligations before cash actually moves, not after.
- **Account fee structures**: each account can carry its own recurring fee
  (monthly, annual, or per-transaction) so the true cost of holding an
  account is visible, not just its balance.

## Getting started (local development)

```bash
# Server
cd server
cp .env.example .env   # set DATABASE_URL
npm install
npm run migrate        # applies schema.sql
npm run dev             # http://localhost:4000

# Client (separate terminal)
cd client
npm install
npm run dev             # http://localhost:5173, proxies /api to :4000
```

## Deploying to Railway

Single Railway service — it builds the client and serves it alongside the
API.

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub repo → select it. Railway
   detects the root `package.json` and `railway.json` automatically.
3. Add a PostgreSQL database to the same Railway project — Railway injects
   `DATABASE_URL` automatically.
4. The migration runs automatically on every boot (`npm start` runs it
   before starting the server) and is safe to re-run — it treats
   "already exists" errors as success rather than crashing.
5. Every push to `main` auto-deploys.

Environment variables (optional — defaults match the locked v1 thresholds):

```
LIQUIDITY_BUFFER_PCT=0.15
DSCR_THRESHOLD=1.25
RESERVE_TARGET_MONTHS=2
```
</content>
