# Money Hub

Capital allocation and financial decision system. Aggregates business and
personal ledgers, loan schedules, and expense budgets into a single model,
and gates capital purchases against a five-part quantitative test:

1. **Liquidity floor** — projected minimum monthly cash balance, with a 15% buffer
2. **Debt Service Coverage Ratio (DSCR)** — Net Operating Income ÷ Total Debt
   Service, computed **monthly** (worst month binds), gated at **1.25x**
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

Stack matches the Quarter-Section project: React/Vite frontend, Node/Express
backend, PostgreSQL (Railway in production, local Postgres or the bundled
JSON fallback for development).

## v1 scope decisions

- Data entry is **manual**, done directly against the schema via the UI —
  no CSV/API ingestion yet. The schema is designed so an automated importer
  can write into the same tables later without a data-model change.
- Mixed-use asset allocation is a **user-set percentage on a cost basis**
  only (no mileage/usage-log methodology).
- Business and personal ledgers are **structurally separate** — DSCR and
  liquidity calculations run against the business ledger only.
- Milestone/strategic-date tracking is **not** part of v1.

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
API, matching the Quarter-Section pattern (GitHub auto-deploy on push).

1. **Push this repo to GitHub.**
   ```bash
   git init
   git add .
   git commit -m "Money Hub v1"
   gh repo create money-hub --private --source=. --push
   # or create the repo on github.com and `git remote add origin ...` / `git push`
   ```

2. **In Railway:** New Project → Deploy from GitHub repo → select `money-hub`.
   Railway detects the root `package.json` and `railway.json` automatically
   (Nixpacks builder, `npm start` as the start command).

3. **Add a PostgreSQL database:** New → Database → PostgreSQL, in the same
   Railway project. Railway injects `DATABASE_URL` into your service's
   environment automatically — no manual wiring needed.

4. **Run the migration once**, after the first successful deploy:
   ```bash
   railway login
   railway link          # select this project
   railway run npm run migrate
   ```
   (Or use Railway's dashboard → your service → the one-off command runner,
   same command.)

5. **Redeploy on every push** — Railway's GitHub integration handles this
   automatically once connected, same as Quarter-Section.

Environment variables Railway needs on the service (`DATABASE_URL` is
auto-injected by the Postgres plugin; the rest are optional — defaults
match the locked v1 thresholds and only need setting if you want to
override them):

```
LIQUIDITY_BUFFER_PCT=0.15
DSCR_THRESHOLD=1.25
RESERVE_TARGET_MONTHS=2
```

(These map to the `settings` table seeded by `schema.sql` — changing the
env var doesn't retroactively change a row already in the database; update
the `settings` table directly, or re-run that part of the migration, if you
change a threshold after go-live.)
