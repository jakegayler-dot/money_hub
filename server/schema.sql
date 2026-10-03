-- Money Hub schema (v1)
-- Business and personal ledgers are kept structurally separate: every
-- account and transaction carries a `ledger` tag, and DSCR/liquidity
-- calculations filter on ledger = 'business' only.
--
-- CREATE TYPE has no IF NOT EXISTS in Postgres, so every enum is wrapped in
-- a DO block that swallows "already exists" — this file is re-run on every
-- deploy (see server/lib/migrate.js) and must be safe to apply repeatedly.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('liquidity_buffer_pct', '0.15'),
  ('dscr_threshold', '1.25'),
  ('reserve_target_months', '2')
ON CONFLICT (key) DO NOTHING;

DO $$ BEGIN
  CREATE TYPE ledger_type AS ENUM ('business', 'personal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_type AS ENUM ('operating', 'draw', 'reserve', 'personal', 'investment', 'credit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE fee_frequency AS ENUM ('none', 'monthly', 'annual', 'per_transaction');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS accounts (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  ledger          ledger_type NOT NULL,
  account_type    account_type NOT NULL,
  opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  source_system   TEXT,              -- e.g. 'quicken', 'agexpert', 'wealthsimple', 'manual'
  -- Fee structure: the recurring cost of holding this account, tracked
  -- alongside its balance so the true cost of an account is visible, not
  -- just its balance. fee_amount is per-occurrence at fee_frequency
  -- (e.g. $14.95 'monthly', or $2.50 'per_transaction').
  fee_amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
  fee_frequency   fee_frequency NOT NULL DEFAULT 'none',
  fee_notes       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent column additions for databases created before fee tracking
-- existed — ADD COLUMN IF NOT EXISTS is safe to re-run, unlike CREATE TYPE.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS fee_frequency fee_frequency NOT NULL DEFAULT 'none';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS fee_notes TEXT;

DO $$ BEGIN
  CREATE TYPE expense_class AS ENUM ('fixed', 'variable_seasonal', 'capex', 'overhead');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS expense_categories (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  class        expense_class NOT NULL,
  ledger       ledger_type NOT NULL DEFAULT 'business',
  annual_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- 12 numbers summing to ~1.0; index 0 = January
  monthly_pct  JSONB NOT NULL DEFAULT '[0.0833,0.0833,0.0834,0.0833,0.0833,0.0834,0.0833,0.0833,0.0834,0.0833,0.0833,0.0834]'
);

-- Two levels: a parent (e.g. "Fuel & oil") every chart and total is built
-- on, and optional subcategories under it ("Diesel — dyed", "Gasoline")
-- for detail. Transactions carry the most specific category; totals roll
-- up to the parent. One level only — a subcategory can't have children.
ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL;

DO $$ BEGIN
  CREATE TYPE purchase_class AS ENUM ('compounding', 'productive_tool', 'consumptive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Enterprise segment: which part of the operation a transaction or bill
-- belongs to. Separate from `ledger` (business/personal) on purpose — most
-- personal-ledger items are segment 'personal', but this lets a business
-- expense be split across grain and livestock the same way mixed-use
-- already splits business/personal by cost basis, using the same
-- single-value-or-percentage-split pattern as `is_mixed_use`.
DO $$ BEGIN
  CREATE TYPE enterprise_segment AS ENUM ('grain', 'livestock', 'personal', 'jake', 'ashley');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS transactions (
  id                      SERIAL PRIMARY KEY,
  account_id              INTEGER NOT NULL REFERENCES accounts(id),
  ledger                  ledger_type NOT NULL,
  date                    DATE NOT NULL,
  amount                  NUMERIC(14,2) NOT NULL,   -- negative = outflow
  description             TEXT,
  category_id             INTEGER REFERENCES expense_categories(id),
  purchase_class          purchase_class,
  is_mixed_use            BOOLEAN NOT NULL DEFAULT false,
  mixed_use_business_pct  NUMERIC(5,2),             -- cost-basis %, e.g. 60.00
  is_capex                BOOLEAN NOT NULL DEFAULT false,
  entered_by              TEXT NOT NULL DEFAULT 'manual', -- manual | agent
  -- Enterprise segment: single value (segment) when the whole transaction
  -- belongs to one enterprise, or a cost-basis split across all three when
  -- is_segment_split is true — same pattern as is_mixed_use above, just for
  -- grain/livestock/personal instead of business/personal.
  segment                 enterprise_segment,
  is_segment_split        BOOLEAN NOT NULL DEFAULT false,
  segment_grain_pct       NUMERIC(5,2),
  segment_livestock_pct   NUMERIC(5,2),
  segment_personal_pct    NUMERIC(5,2),
  -- True for transactions created by recording a loan payment. NOI must
  -- exclude these (NOI is income before debt service, by definition) or
  -- DSCR would divide by a denominator already subtracted from its own
  -- numerator, and the liquidity forecast would double-count payments that
  -- are also on the loan schedule.
  is_debt_service         BOOLEAN NOT NULL DEFAULT false,
  -- Book balance vs. bank balance: `amount` hits the account's balance the
  -- moment the transaction is recorded (e.g. a check is written), but a
  -- check can sit uncashed for months. `cleared` tracks whether it has
  -- actually cleared the bank, purely for reconciliation — it does NOT
  -- change the balance a second time. Non-check entries default cleared,
  -- since there's nothing to reconcile.
  cleared                 BOOLEAN NOT NULL DEFAULT true,
  cleared_date            DATE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cleared BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cleared_date DATE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS segment enterprise_segment;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_segment_split BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS segment_grain_pct NUMERIC(5,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS segment_livestock_pct NUMERIC(5,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS segment_personal_pct NUMERIC(5,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_debt_service BOOLEAN NOT NULL DEFAULT false;
-- Four-owner split: grain / livestock / jake / ashley. segment_personal_pct
-- is legacy (pre-Jake/Ashley) and counts as Unassigned.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS segment_jake_pct NUMERIC(5,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS segment_ashley_pct NUMERIC(5,2);

-- Account ownership: who owns the balance that was sitting in the account
-- BEFORE any transactions were recorded here (the "starting share"). An
-- owner's cash = their share of starting balances + every flow tagged to
-- them since — derived from tagged flows, not a fixed % of the live
-- balance. A shared farm account can split its starting balance across
-- grain and cattle the same way a bill splits its cost.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS segment enterprise_segment;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_segment_split BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS segment_grain_pct NUMERIC(5,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS segment_livestock_pct NUMERIC(5,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS segment_jake_pct NUMERIC(5,2);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS segment_ashley_pct NUMERIC(5,2);
CREATE INDEX IF NOT EXISTS idx_transactions_cleared ON transactions (cleared);
CREATE INDEX IF NOT EXISTS idx_transactions_segment ON transactions (segment);

DO $$ BEGIN
  CREATE TYPE loan_purpose AS ENUM ('operating', 'term', 'capital_asset', 'mortgage');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Adding 'mortgage' to an existing loan_purpose enum (for databases created
-- before this value existed) happens separately in migrate.js, NOT here —
-- Postgres refuses to run ALTER TYPE ... ADD VALUE inside a multi-statement
-- string/transaction block, which is exactly how this whole file is applied.

CREATE TABLE IF NOT EXISTS loans (
  id                SERIAL PRIMARY KEY,
  -- A short name you pick, e.g. "Home mortgage" or "2023 grain truck" —
  -- exists because `lender` alone can't tell apart two loans from the same
  -- bank (a farm's operating line and a mortgage, both from the same credit
  -- union, say). Defaults to the lender name if left blank so existing rows
  -- (and anyone who skips it) still get something sane, not NULL.
  name              TEXT NOT NULL DEFAULT '',
  lender            TEXT NOT NULL,
  purpose           loan_purpose NOT NULL,
  linked_asset      TEXT,                 -- free text description if purpose = capital_asset/mortgage
  principal         NUMERIC(14,2) NOT NULL, -- for an existing loan, enter the CURRENT outstanding balance
  interest_rate_pct NUMERIC(6,3) NOT NULL,
  rate_type         TEXT NOT NULL DEFAULT 'fixed', -- fixed | variable
  term_months       INTEGER NOT NULL,       -- for an existing loan, enter the term REMAINING
  start_date        DATE NOT NULL,          -- for an existing loan, use today / next payment date
  covenant_notes    TEXT,
  covenant_date     DATE,
  -- Underlying asset value, for equity tracking (mortgages, vehicle/equipment
  -- loans). Entered manually and assumed constant going forward — this app
  -- doesn't forecast appreciation/depreciation, only how the loan balance
  -- (and therefore equity) changes as it's paid down.
  asset_value       NUMERIC(14,2),
  asset_value_date  DATE,
  -- Which enterprise this loan's payments belong to (grain/livestock/
  -- personal) — carried onto the transaction each recorded payment creates,
  -- so debt service shows up in the right bucket on the Expenses page.
  segment           enterprise_segment,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE loans ADD COLUMN IF NOT EXISTS asset_value NUMERIC(14,2);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS asset_value_date DATE;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS segment enterprise_segment;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
-- Backfill: any loan that predates the `name` column gets the lender name
-- as a starting point, so nothing shows up blank in the UI. Safe to re-run —
-- once a loan has a real name it will no longer be the empty string.
UPDATE loans SET name = lender WHERE name = '';

-- One row per scheduled payment; lets a loan's payment timing be seasonal
-- (larger after harvest/sale, smaller or skipped off-season) rather than
-- assuming an even monthly amount.
CREATE TABLE IF NOT EXISTS loan_payments (
  id                SERIAL PRIMARY KEY,
  loan_id           INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  due_date          DATE NOT NULL,
  principal_amount  NUMERIC(14,2) NOT NULL,
  interest_amount   NUMERIC(14,2) NOT NULL,
  paid              BOOLEAN NOT NULL DEFAULT false,
  paid_date         DATE,
  -- Set when the payment is recorded through the payment planner: the
  -- ledger transaction that actually moved the money, same linkage
  -- pattern as bills.linked_transaction_id.
  linked_transaction_id INTEGER REFERENCES transactions(id)
);

ALTER TABLE loan_payments ADD COLUMN IF NOT EXISTS linked_transaction_id INTEGER REFERENCES transactions(id);

CREATE TABLE IF NOT EXISTS owner_draws (
  id      SERIAL PRIMARY KEY,
  date    DATE NOT NULL,
  amount  NUMERIC(14,2) NOT NULL,
  note    TEXT
);

DO $$ BEGIN
  CREATE TYPE reserve_direction AS ENUM ('sweep_in', 'draw_out');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS reserve_transfers (
  id        SERIAL PRIMARY KEY,
  date      DATE NOT NULL,
  amount    NUMERIC(14,2) NOT NULL,
  direction reserve_direction NOT NULL,
  note      TEXT
);

DO $$ BEGIN
  CREATE TYPE eval_decision AS ENUM ('pass', 'fail', 'pending');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS purchase_evaluations (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL,
  price                   NUMERIC(14,2) NOT NULL,
  purchase_class          purchase_class NOT NULL,
  is_mixed_use            BOOLEAN NOT NULL DEFAULT false,
  mixed_use_business_pct  NUMERIC(5,2),
  liquidity_pass          BOOLEAN,
  dscr_pass               BOOLEAN,
  opportunity_cost_units  NUMERIC(14,4),  -- e.g. heifer-equivalents
  reversibility_score     SMALLINT,       -- 1 (illiquid) - 5 (highly liquid)
  decision                eval_decision NOT NULL DEFAULT 'pending',
  notes                   TEXT,
  evaluated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Accounts payable: invoices/bills received but not yet paid. Kept
-- separate from `transactions` (which records money that has actually
-- moved) so a known upcoming obligation shows up on the liquidity forecast
-- before it clears, not after.
DO $$ BEGIN
  CREATE TYPE bill_status AS ENUM ('unpaid', 'paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bill_frequency AS ENUM ('one_time', 'monthly', 'quarterly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS bills (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,          -- vendor / bill name, e.g. "AgriChem Ltd invoice #4471"
  ledger         ledger_type NOT NULL DEFAULT 'business',
  category       TEXT,
  amount         NUMERIC(14,2) NOT NULL, -- total amount owed, GST-inclusive if has_gst
  frequency      bill_frequency NOT NULL DEFAULT 'one_time',
  received_date  DATE,                   -- when the invoice was received (optional)
  due_date       DATE NOT NULL,
  status         bill_status NOT NULL DEFAULT 'unpaid',
  paid_date      DATE,
  linked_transaction_id INTEGER REFERENCES transactions(id),
  -- GST split: `amount` is the total invoice value; when has_gst is true,
  -- gst_amount/subtotal_amount are derived server-side from gst_pct so the
  -- pre-tax cost and the GST component (for ITC/remittance tracking) are
  -- both visible without changing what actually leaves the account.
  has_gst        BOOLEAN NOT NULL DEFAULT false,
  gst_pct        NUMERIC(5,2) NOT NULL DEFAULT 5,
  gst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  subtotal_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- Same enterprise-segment tagging as transactions (see that table's
  -- comment) — carried onto the transaction this bill produces when paid,
  -- and onto the next auto-recurred bill, so the tag doesn't have to be
  -- re-entered every cycle.
  segment                enterprise_segment,
  is_segment_split       BOOLEAN NOT NULL DEFAULT false,
  segment_grain_pct      NUMERIC(5,2),
  segment_livestock_pct  NUMERIC(5,2),
  segment_personal_pct   NUMERIC(5,2),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE bills ADD COLUMN IF NOT EXISTS has_gst BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS gst_pct NUMERIC(5,2) NOT NULL DEFAULT 5;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS segment enterprise_segment;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS is_segment_split BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS segment_grain_pct NUMERIC(5,2);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS segment_livestock_pct NUMERIC(5,2);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS segment_personal_pct NUMERIC(5,2);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS segment_jake_pct NUMERIC(5,2);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS segment_ashley_pct NUMERIC(5,2);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS subtotal_amount NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Sale contracts (accounts receivable side): known future INFLOWS — e.g. a
-- grain contract deliverable in November — the mirror image of bills. The
-- liquidity forecast adds each unsettled contract's value at its expected
-- payment month; settling one converts it into a real transaction (and
-- drops it from the forecast so it's never counted twice). `source` +
-- `external_id` exist so an outside system (another business's API, an
-- agent, a script) can push contracts idempotently: re-pushing the same
-- external_id updates the row instead of duplicating it.
DO $$ BEGIN
  CREATE TYPE contract_status AS ENUM ('open', 'delivered', 'settled', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS sale_contracts (
  id                    SERIAL PRIMARY KEY,
  source                TEXT NOT NULL DEFAULT 'manual', -- pushing system's name, or 'manual'
  external_id           TEXT,                            -- the contract's id in the source system
  commodity             TEXT NOT NULL,                   -- e.g. 'canola', 'feeder steers'
  quantity              NUMERIC(14,3),
  unit                  TEXT,                            -- e.g. 'tonnes', 'bu', 'head'
  price_per_unit        NUMERIC(14,2),
  total_value           NUMERIC(14,2) NOT NULL,
  counterparty          TEXT,
  delivery_date         DATE,
  contract_period_end   DATE,        -- last day of the delivery window, e.g. an Oct 1 – Nov 30 contract → Nov 30
  expected_payment_date DATE NOT NULL,
  status                contract_status NOT NULL DEFAULT 'open',
  segment               enterprise_segment NOT NULL DEFAULT 'grain',
  linked_transaction_id INTEGER REFERENCES transactions(id),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sale_contracts ADD COLUMN IF NOT EXISTS contract_period_end DATE;

-- Boot-time enforcement of the payment-date rule for INGESTED contracts
-- (manual entries are a human's explicit dates and are left alone):
-- payment = delivery + 7 days, else the contract period's last day. This
-- runs on every deploy, so rows stored under an older rule — or pushed by
-- an exporter that fabricated a payment date — are corrected without
-- waiting for the source system to push again. Idempotent: rows already
-- matching the rule are untouched. Settled/cancelled rows are history and
-- are never rewritten.
UPDATE sale_contracts
SET expected_payment_date = COALESCE(delivery_date + 7, contract_period_end)
WHERE source != 'manual'
  AND status IN ('open', 'delivered')
  AND COALESCE(delivery_date + 7, contract_period_end) IS NOT NULL
  AND expected_payment_date IS DISTINCT FROM COALESCE(delivery_date + 7, contract_period_end);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_contracts_source_ext
  ON sale_contracts (source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sale_contracts_status ON sale_contracts (status);
CREATE INDEX IF NOT EXISTS idx_sale_contracts_payment ON sale_contracts (expected_payment_date);

-- =====================================================================
-- CERTAINTY MODEL
-- Every number in the app sits at one of three certainty levels:
--   ACTUAL     — money has moved (transactions; `cleared` adds the bank
--                statement confirmation on top).
--   COMMITTED  — money hasn't moved but the amount comes from a real
--                document with a counterparty: bills received, sale
--                contracts, loan schedules.
--   ESTIMATED  — the operator's own assumptions (cash_estimates below),
--                plus market-price valuations of inventory and assets.
-- Forecasts are produced twice — committed only, and with estimates — and
-- the gap between the two is exposure to the operator's own assumptions.
-- =====================================================================

-- ---- Estimated cash flows -------------------------------------------
-- One-off or recurring. `amount` is per occurrence and always positive;
-- `direction` says which way it moves. Occurrences dated before today
-- drop out of every forecast: an estimate whose date passed without the
-- money moving is stale, not an obligation (unlike an overdue bill).
-- source + external_id allow idempotent pushes from outside systems.
DO $$ BEGIN
  CREATE TYPE flow_direction AS ENUM ('inflow', 'outflow');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE estimate_frequency AS ENUM ('one_time', 'monthly', 'quarterly', 'annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE estimate_status AS ENUM ('active', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS cash_estimates (
  id                    SERIAL PRIMARY KEY,
  source                TEXT NOT NULL DEFAULT 'manual',
  external_id           TEXT,
  name                  TEXT NOT NULL,
  category              TEXT,
  direction             flow_direction NOT NULL,
  amount                NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  frequency             estimate_frequency NOT NULL DEFAULT 'one_time',
  start_date            DATE NOT NULL,       -- first (or only) occurrence
  end_date              DATE,                -- last possible occurrence for recurring; NULL = open-ended
  status                estimate_status NOT NULL DEFAULT 'active',
  segment               enterprise_segment,
  is_segment_split      BOOLEAN NOT NULL DEFAULT false,
  segment_grain_pct     NUMERIC(5,2),
  segment_livestock_pct NUMERIC(5,2),
  segment_jake_pct      NUMERIC(5,2),
  segment_ashley_pct    NUMERIC(5,2),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_estimates_source_ext
  ON cash_estimates (source, external_id) WHERE external_id IS NOT NULL;
-- What crop/stock an estimate is for ("Canola"). Grain in the bins that
-- isn't contracted is forecast to sell on the date of its crop's estimate,
-- so the two are matched on this (or, failing that, on the name).
ALTER TABLE cash_estimates ADD COLUMN IF NOT EXISTS commodity TEXT;

-- ---- Capital assets -------------------------------------------------
-- Land, buildings, machinery, vehicles, breeding stock, investments.
-- Value is rolled forward from value_date by annual_change_pct,
-- compounded: negative = declining-balance depreciation (the CCA method,
-- e.g. -30 for a Class 10 truck), positive = appreciation (land). The
-- CCA half-year rule is a tax-year convention and isn't applied to
-- market-value projections. Owners use the same four-way split as
-- everything else, so a shared truck can be 50/50 grain/cattle.
DO $$ BEGIN
  CREATE TYPE asset_category AS ENUM ('land', 'buildings', 'machinery', 'vehicles', 'breeding_livestock', 'investments', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS assets (
  id                    SERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  category              asset_category NOT NULL DEFAULT 'other',
  value                 NUMERIC(14,2) NOT NULL,
  value_date            DATE NOT NULL DEFAULT CURRENT_DATE,
  annual_change_pct     NUMERIC(6,2) NOT NULL DEFAULT 0,
  cca_class             TEXT,
  segment               enterprise_segment,
  is_segment_split      BOOLEAN NOT NULL DEFAULT false,
  segment_grain_pct     NUMERIC(5,2),
  segment_livestock_pct NUMERIC(5,2),
  segment_jake_pct      NUMERIC(5,2),
  segment_ashley_pct    NUMERIC(5,2),
  notes                 TEXT,
  migrated_from_loan_id INTEGER,           -- set only by the one-time migration below
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A loan can be secured by one asset; an asset can carry several loans
-- (land with two mortgages). Deleting an asset unlinks its loans.
ALTER TABLE loans ADD COLUMN IF NOT EXISTS asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL;

-- One-time move of asset values that used to live on loan rows into real
-- asset records. Idempotent: only touches loans with a legacy value and
-- no linked asset yet. Category is a starting guess (mortgage → land,
-- everything else → other) and meant to be corrected on the Assets tab.
INSERT INTO assets (name, category, value, value_date, segment, notes, migrated_from_loan_id)
SELECT COALESCE(NULLIF(l.linked_asset, ''), l.name, l.lender),
       CASE WHEN l.purpose = 'mortgage' THEN 'land'::asset_category ELSE 'other'::asset_category END,
       l.asset_value,
       COALESCE(l.asset_value_date, l.created_at::date),
       l.segment,
       'Moved from loan "' || COALESCE(NULLIF(l.name, ''), l.lender) || '" — check category and depreciation rate.',
       l.id
FROM loans l
WHERE l.asset_value IS NOT NULL AND l.asset_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.migrated_from_loan_id = l.id);

UPDATE loans l SET asset_id = a.id
FROM assets a
WHERE a.migrated_from_loan_id = l.id AND l.asset_id IS NULL;

-- ---- Inventory & livestock --------------------------------------------
-- Grain in the bin, market cattle, breeding herd — fed from source systems
-- (Quarter Section, Livestock Manager) via /api/inventory/ingest, or added
-- by hand. Valued at an estimated market price, so it's ESTIMATED
-- certainty. Only the UNCONTRACTED quantity counts toward equity: grain
-- already under an open sale contract is counted once, as that contract's
-- receivable. quantity_contracted, when the source sends it, wins; when it
-- doesn't, Money Hub derives it from open contracts for the same commodity
-- and unit.
DO $$ BEGIN
  CREATE TYPE inventory_class AS ENUM ('crop', 'forage', 'market_livestock', 'breeding_livestock', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS inventory_items (
  id                    SERIAL PRIMARY KEY,
  source                TEXT NOT NULL DEFAULT 'manual',
  external_id           TEXT,
  item_class            inventory_class NOT NULL DEFAULT 'crop',
  commodity             TEXT NOT NULL,          -- 'Canola', 'Bred heifers'
  quantity              NUMERIC(14,3) NOT NULL,
  unit                  TEXT NOT NULL,          -- 'bu', 'tonnes', 'head'
  quantity_contracted   NUMERIC(14,3),          -- NULL = let Money Hub derive it
  price_per_unit        NUMERIC(14,4) NOT NULL, -- estimated market price
  location              TEXT,                   -- bin / yard / pasture
  as_of                 DATE NOT NULL DEFAULT CURRENT_DATE,
  segment               enterprise_segment,
  notes                 TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_source_ext
  ON inventory_items (source, external_id) WHERE external_id IS NOT NULL;

-- ---- Loan verification ------------------------------------------------
-- Payments and rates change for reasons the app can't see (variable
-- rates, lender re-amortization, missed or extra payments). Each loan
-- carries when it was last checked against a statement or the lender,
-- and every check is kept as history. A verification that disagrees with
-- the schedule rebases it: an adjustment row reconciles the balance and
-- the remaining schedule is rebuilt from the verified figures.
ALTER TABLE loans ADD COLUMN IF NOT EXISTS last_verified_on DATE;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS verified_payment NUMERIC(14,2);

CREATE TABLE IF NOT EXISTS loan_verifications (
  id                  SERIAL PRIMARY KEY,
  loan_id             INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  verified_on         DATE NOT NULL,
  balance             NUMERIC(14,2) NOT NULL,
  interest_rate_pct   NUMERIC(6,3) NOT NULL,
  payment_amount      NUMERIC(14,2),
  source              TEXT,                   -- statement / lender / online banking / other
  note                TEXT,
  expected_balance    NUMERIC(14,2) NOT NULL, -- what the schedule said on that date
  expected_rate_pct   NUMERIC(6,3) NOT NULL,
  rebased             BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Adjustment rows: a principal-only, already-"paid" schedule row that
-- closes the gap between what the schedule expected and what the lender
-- confirmed. Being principal-only and paid, every balance calculation
-- picks it up automatically; debt-service and forecast queries exclude it
-- because no money moved.
ALTER TABLE loan_payments ADD COLUMN IF NOT EXISTS is_adjustment BOOLEAN NOT NULL DEFAULT false;

-- ---- Payment frequency ------------------------------------------------
-- Ag lenders commonly schedule annual or semi-annual payments timed to
-- harvest/calf-sale cash, alongside the usual monthly/quarterly/biweekly
-- options. term_months stays the amortization length; the number of
-- payments = term_months × payments-per-year / 12. first_payment_date
-- (optional) pins when the first payment falls — e.g. a loan advanced in
-- March with its first annual payment due December 1 — and the schedule
-- steps from there; without it, the first payment is one period after
-- start_date.
DO $$ BEGIN
  CREATE TYPE payment_frequency AS ENUM ('biweekly', 'monthly', 'quarterly', 'semiannual', 'annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS payment_frequency payment_frequency NOT NULL DEFAULT 'monthly';
ALTER TABLE loans ADD COLUMN IF NOT EXISTS first_payment_date DATE;

-- ---- Inventory: prices come from the managers -------------------------
-- Each item's price_per_unit is the estimate its manager (Quarter Section,
-- Livestock Manager) sends, or the one typed in for a hand-entered item.
-- Money Hub keeps no price list of its own: an item without a price counts
-- at $0 and is flagged, never valued at a guess.
ALTER TABLE inventory_items ALTER COLUMN price_per_unit DROP NOT NULL;
-- When this (uncontracted) item is expected to be sold. Optional: without
-- it, grain takes its crop's estimate date, then the fallback setting.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expected_sale_date DATE;
-- Retired: Money Hub's own price list, replaced by the managers' estimates.
DROP TABLE IF EXISTS commodity_prices;

-- ---- Credit cards ------------------------------------------------------
-- A card is revolving debt, not a loan with an amortization schedule: what
-- Money Hub tracks is its terms (rates, fee, rewards) and, cycle by cycle,
-- what the issuer says you owe and by when — logged by hand, the same way
-- a loan verification is, since there's no live bank feed for a card.
DO $$ BEGIN
  CREATE TYPE credit_card_status AS ENUM ('active', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS credit_cards (
  id                    SERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,  -- yours to pick, e.g. "Capital One Gold"
  issuer                TEXT,
  last4                 TEXT,
  credit_limit          NUMERIC(14,2),
  apr_purchase          NUMERIC(6,3) NOT NULL,
  apr_cash_advance      NUMERIC(6,3),
  annual_fee            NUMERIC(14,2) NOT NULL DEFAULT 0,
  annual_fee_month      INTEGER,  -- 1-12, the month the fee typically posts
  grace_period_days     INTEGER NOT NULL DEFAULT 21,
  status                credit_card_status NOT NULL DEFAULT 'active',
  -- Same enterprise-segment tagging as loans/bills/accounts — whose card
  -- this is, so its balance and payments count in the right owner's cash
  -- flow, equity and net worth.
  segment               enterprise_segment,
  -- What you currently owe, entered by hand whenever you check the card —
  -- mirrors the issuer's own "Current Balance", which can run ahead of the
  -- last statement if new purchases posted since. NULL falls back to the
  -- latest unpaid statement's balance.
  current_balance       NUMERIC(14,2),
  current_balance_as_of DATE,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Structured reward rate by spending category, e.g. Groceries 5%, Fuel 2%,
-- "Everything else" 1% — lets cards be compared side by side and backs a
-- rewards estimate for a hypothetical purchase. Money Hub doesn't know
-- which card paid for which ledger transaction, so this doesn't total
-- rewards actually earned from your spending — only what a purchase in a
-- category WOULD earn on this card.
CREATE TABLE IF NOT EXISTS credit_card_reward_categories (
  id              SERIAL PRIMARY KEY,
  credit_card_id  INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  rate_pct        NUMERIC(6,3) NOT NULL,
  notes           TEXT
);

-- One row per billing cycle: the statement Money Hub was told about, and
-- (once paid) the payment against it — same paid/paid_date/
-- linked_transaction_id pattern as loan_payments, since a row IS the next
-- scheduled due amount until it's recorded paid.
CREATE TABLE IF NOT EXISTS credit_card_statements (
  id                    SERIAL PRIMARY KEY,
  credit_card_id        INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
  statement_date        DATE,
  due_date              DATE NOT NULL,
  statement_balance     NUMERIC(14,2) NOT NULL,
  minimum_payment       NUMERIC(14,2),
  -- Interest the issuer actually charged this cycle, if any. Already
  -- folded into statement_balance — kept separately only so carrying a
  -- balance shows up as a real, visible cost rather than just a bigger
  -- number.
  interest_amount       NUMERIC(14,2),
  paid                  BOOLEAN NOT NULL DEFAULT false,
  -- Was the FULL statement_balance paid by due_date — the grace-period
  -- test: miss this once and interest starts accruing from the purchase
  -- date next cycle, not the due date.
  paid_in_full          BOOLEAN,
  paid_date             DATE,
  paid_amount           NUMERIC(14,2),
  account_id            INTEGER REFERENCES accounts(id),
  linked_transaction_id INTEGER REFERENCES transactions(id),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cc_statements_due_date ON credit_card_statements (due_date);
CREATE INDEX IF NOT EXISTS idx_cc_statements_card ON credit_card_statements (credit_card_id);

-- ============================================================================
-- Statement ingest: split lines, card purchase ledger, transfers, dedupe,
-- and the review queue. Built for agent data entry — an agent reads bank
-- and card statements and pushes every line; the server does the matching
-- (bills, loan payments, card payments, contracts, transfers, duplicates,
-- uncleared checks) and holds anything uncertain for a human.
-- ============================================================================

-- Last four digits of the account number, so a statement header ("account
-- ending 4821") can be matched to an account without guessing by name.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last4 TEXT;

-- A card purchase is a transaction charged to a card, not paid out of an
-- account: account_id is null and credit_card_id is set. A card PAYMENT is
-- a bank-side transaction (account_id set) that also carries the
-- credit_card_id it paid down. Every transaction still belongs to one or
-- the other.
ALTER TABLE transactions ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS credit_card_id INTEGER REFERENCES credit_cards(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS credit_card_statement_id INTEGER REFERENCES credit_card_statements(id) ON DELETE SET NULL;
DO $$ BEGIN
  ALTER TABLE transactions ADD CONSTRAINT transactions_account_or_card
    CHECK (account_id IS NOT NULL OR credit_card_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Money moving between things Money Hub already tracks (account to
-- account, bank to card, loan advances) is neither income nor expense.
-- Transfers still move account balances; every income/expense/NOI figure
-- excludes them. Both sides of an account-to-account transfer are
-- recorded, each on its own account, and paired via transfer_peer_id.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_transfer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_peer_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL;

-- A split transaction's category/owner detail lives in transaction_splits;
-- the parent row still carries the full amount and moves the balance.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_split BOOLEAN NOT NULL DEFAULT false;

-- Dedupe key for anything that came from a statement. A manual entry that
-- a statement line later matches is "claimed" by stamping these on it, so
-- a second line can't match it again.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_source_external
  ON transactions (source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions (account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_card ON transactions (credit_card_id);

-- A transaction someone (usually the data-entry agent) wasn't sure about:
-- it's recorded and counts like any other, but sits on the Review tab with
-- the reason until a person checks it and clears the flag.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS review_note TEXT;
CREATE INDEX IF NOT EXISTS idx_transactions_needs_review ON transactions (needs_review) WHERE needs_review;

-- Card payments recorded before transactions carried credit_card_id.
UPDATE transactions t SET credit_card_id = s.credit_card_id, credit_card_statement_id = s.id
FROM credit_card_statements s
WHERE s.linked_transaction_id = t.id AND t.credit_card_id IS NULL;

CREATE TABLE IF NOT EXISTS transaction_splits (
  id                    SERIAL PRIMARY KEY,
  transaction_id        INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount                NUMERIC(14,2) NOT NULL,   -- pieces sum to the parent amount
  category_id           INTEGER REFERENCES expense_categories(id),
  memo                  TEXT,
  ledger                ledger_type NOT NULL,
  is_capex              BOOLEAN NOT NULL DEFAULT false,
  segment               enterprise_segment,
  is_segment_split      BOOLEAN NOT NULL DEFAULT false,
  segment_grain_pct     NUMERIC(5,2),
  segment_livestock_pct NUMERIC(5,2),
  segment_jake_pct      NUMERIC(5,2),
  segment_ashley_pct    NUMERIC(5,2),
  -- Only card payments use this: the part paying off a card's pre-
  -- itemization balance is an expense, the rest is a transfer.
  is_transfer           BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE transaction_splits ADD COLUMN IF NOT EXISTS is_transfer BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_transaction_splits_tx ON transaction_splits (transaction_id);

-- Itemized card ledger. Once a card's purchases are entered line by line,
-- its balance is ledger_opening_balance (the "previous balance" on the
-- first itemized statement) plus every purchase, refund and payment dated
-- on or after ledger_start_date — and its payments become transfers, since
-- the purchases themselves are now the expenses. Null = not itemized; the
-- balance comes from current_balance or the latest statement as before.
ALTER TABLE credit_cards ADD COLUMN IF NOT EXISTS ledger_start_date DATE;
ALTER TABLE credit_cards ADD COLUMN IF NOT EXISTS ledger_opening_balance NUMERIC(14,2);

-- Owner draws recorded from a statement line point at the transfer that
-- moved the money; deleting that transaction removes the draw with it.
ALTER TABLE owner_draws ADD COLUMN IF NOT EXISTS linked_transaction_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE;

DO $$ BEGIN
  CREATE TYPE statement_line_status AS ENUM ('posted', 'matched', 'held', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One uploaded statement (or export) for one account or card.
CREATE TABLE IF NOT EXISTS statement_imports (
  id                       SERIAL PRIMARY KEY,
  source                   TEXT NOT NULL,
  external_id              TEXT,
  account_id               INTEGER REFERENCES accounts(id),
  credit_card_id           INTEGER REFERENCES credit_cards(id) ON DELETE CASCADE,
  period_start             DATE,
  period_end               DATE,
  opening_balance          NUMERIC(14,2),
  closing_balance          NUMERIC(14,2),
  due_date                 DATE,
  minimum_payment          NUMERIC(14,2),
  interest_charged         NUMERIC(14,2),
  credit_card_statement_id INTEGER REFERENCES credit_card_statements(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Historical statements (loading past months): a bill, loan or contract
-- payment with nothing on file to match posts directly instead of waiting
-- for review — last year's bills were never entered as bills.
ALTER TABLE statement_imports ADD COLUMN IF NOT EXISTS historical BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_imports_source_external
  ON statement_imports (source, external_id) WHERE external_id IS NOT NULL;

-- Every line ever pushed, and what became of it: posted (new transaction),
-- matched (linked to money already on file — nothing new moved), held
-- (waiting in the review queue) or rejected (discarded by a human).
CREATE TABLE IF NOT EXISTS statement_lines (
  id              SERIAL PRIMARY KEY,
  import_id       INTEGER REFERENCES statement_imports(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  account_id      INTEGER REFERENCES accounts(id),
  credit_card_id  INTEGER REFERENCES credit_cards(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  amount          NUMERIC(14,2) NOT NULL,
  description     TEXT,
  kind            TEXT NOT NULL DEFAULT 'standard',
  payload         JSONB NOT NULL,
  status          statement_line_status NOT NULL,
  reason          TEXT,
  candidates      JSONB,
  transaction_id  INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_lines_source_external ON statement_lines (source, external_id);
CREATE INDEX IF NOT EXISTS idx_statement_lines_status ON statement_lines (status);

-- One row per piece of money for reporting: an unsplit transaction is one
-- line; a split transaction contributes one line per split piece, each with
-- its own amount, category, owner, ledger and capex flag. Every income,
-- expense and per-owner calculation reads this, never raw transactions —
-- that is what makes a split count correctly everywhere at once.
--
-- A percentage owner split that crosses farm and personal (e.g. 60% Cattle
-- / 40% Jake) is further divided here into a business line and a personal
-- line, each carrying its share of the dollars and its owners' percentages
-- rescaled to 100. Without this the whole amount would sit on one ledger
-- and business figures (coverage ratio, expense averages) would count the
-- personal share as a farm cost. Owner totals come out identical either way.
-- Dropped and recreated (not CREATE OR REPLACE) because its column types
-- changed when this was added; nothing else depends on the view.
DROP VIEW IF EXISTS transaction_lines;
CREATE VIEW transaction_lines AS
WITH base AS (
  SELECT t.id AS transaction_id, NULL::integer AS split_id, t.account_id, t.credit_card_id,
         t.ledger, t.date, t.amount, t.description, t.category_id,
         t.is_capex, t.is_debt_service, t.is_transfer, t.cleared,
         t.segment, t.is_segment_split, t.segment_grain_pct, t.segment_livestock_pct,
         t.segment_jake_pct, t.segment_ashley_pct
  FROM transactions t
  WHERE t.is_split = false
  UNION ALL
  SELECT t.id, s.id, t.account_id, t.credit_card_id,
         s.ledger, t.date, s.amount, COALESCE(s.memo, t.description), s.category_id,
         s.is_capex, t.is_debt_service, (t.is_transfer OR s.is_transfer), t.cleared,
         s.segment, s.is_segment_split, s.segment_grain_pct, s.segment_livestock_pct,
         s.segment_jake_pct, s.segment_ashley_pct
  FROM transactions t
  JOIN transaction_splits s ON s.transaction_id = t.id
  WHERE t.is_split = true
),
pct AS (
  SELECT base.*,
         COALESCE(segment_grain_pct, 0) AS g, COALESCE(segment_livestock_pct, 0) AS l,
         COALESCE(segment_jake_pct, 0) AS j, COALESCE(segment_ashley_pct, 0) AS a
  FROM base
),
mixed AS (
  SELECT pct.*, ROUND(amount * (g + l) / 100.0, 2) AS biz_amount
  FROM pct
  WHERE is_segment_split AND (g + l) > 0 AND (j + a) > 0
)
SELECT transaction_id, split_id, account_id, credit_card_id, ledger, date, amount, description, category_id,
       is_capex, is_debt_service, is_transfer, cleared, segment, is_segment_split,
       segment_grain_pct, segment_livestock_pct, segment_jake_pct, segment_ashley_pct
FROM pct
WHERE NOT (is_segment_split AND (g + l) > 0 AND (j + a) > 0)
UNION ALL
-- business share: grain/cattle percentages rescaled to 100
SELECT transaction_id, split_id, account_id, credit_card_id, 'business'::ledger_type, date, biz_amount,
       description, category_id, is_capex, is_debt_service, is_transfer, cleared,
       NULL::enterprise_segment, true,
       CASE WHEN l = 0 THEN 100 ELSE ROUND(g * 100 / (g + l), 2) END,
       CASE WHEN l = 0 THEN 0 ELSE 100 - ROUND(g * 100 / (g + l), 2) END,
       0, 0
FROM mixed
UNION ALL
-- personal share: Jake/Ashley percentages rescaled to 100
SELECT transaction_id, split_id, account_id, credit_card_id, 'personal'::ledger_type, date, amount - biz_amount,
       description, category_id, is_capex, is_debt_service, is_transfer, cleared,
       NULL::enterprise_segment, true,
       0, 0,
       CASE WHEN a = 0 THEN 100 ELSE ROUND(j * 100 / (j + a), 2) END,
       CASE WHEN a = 0 THEN 0 ELSE 100 - ROUND(j * 100 / (j + a), 2) END
FROM mixed;

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);
CREATE INDEX IF NOT EXISTS idx_transactions_ledger ON transactions (ledger);
CREATE INDEX IF NOT EXISTS idx_loan_payments_due_date ON loan_payments (due_date);
CREATE INDEX IF NOT EXISTS idx_bills_due_date ON bills (due_date);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills (status);

-- A bill or loan payment can be matched to a transaction that was already
-- in the ledger (entered by hand or from a statement) instead of creating
-- a new one. linked_existing marks those, so undoing the payment unlinks
-- the transaction rather than deleting it.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS linked_existing BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE loan_payments ADD COLUMN IF NOT EXISTS linked_existing BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Income categories and payees.
--
-- Categories are one two-level tree for both directions; `kind` says which
-- side a category belongs to. Income categories follow the CRA farm income
-- lines plus the crops grown here.
ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'expense';

INSERT INTO expense_categories (name, class, ledger, kind, parent_id)
SELECT v.name, 'variable_seasonal', 'business', 'income', NULL
FROM (VALUES ('Grain sales'), ('Cattle sales'), ('Program payments'), ('Custom work income'),
             ('Patronage dividends'), ('Other farm income')) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM expense_categories c WHERE lower(c.name) = lower(v.name));

INSERT INTO expense_categories (name, class, ledger, kind, parent_id)
SELECT v.name, 'variable_seasonal', 'business', 'income', p.id
FROM (VALUES ('Canola sales', 'Grain sales'), ('Wheat sales', 'Grain sales'), ('Oat sales', 'Grain sales'),
             ('Barley sales', 'Grain sales'),
             ('Calf sales', 'Cattle sales'), ('Cull cow sales', 'Cattle sales'), ('Bull sales', 'Cattle sales'),
             ('Feeder sales', 'Cattle sales'),
             ('AgriStability', 'Program payments'), ('AgriInvest', 'Program payments'),
             ('Crop insurance proceeds', 'Program payments'), ('Rebates & grants', 'Program payments')) AS v(name, parent)
JOIN expense_categories p ON lower(p.name) = lower(v.parent) AND p.kind = 'income' AND p.parent_id IS NULL
WHERE NOT EXISTS (SELECT 1 FROM expense_categories c WHERE lower(c.name) = lower(v.name));

-- Who was paid, or who paid: Cargill, Viterra, the auction mart, Co-op.
-- One list that builds itself as transactions are entered.
CREATE TABLE IF NOT EXISTS payees (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payees_name ON payees (lower(name));
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payee_id INTEGER REFERENCES payees(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_payee ON transactions (payee_id);

-- Settled contracts already in the ledger: income category from the
-- commodity ("Canola" -> "Canola sales"), payee from the buyer.
UPDATE transactions t SET category_id = (
  SELECT c.id FROM expense_categories c
  WHERE c.kind = 'income' AND c.parent_id IS NOT NULL
    AND sc.commodity ILIKE '%' || regexp_replace(lower(c.name), ' *sales$', '') || '%'
  ORDER BY length(c.name) DESC LIMIT 1)
FROM sale_contracts sc
WHERE sc.linked_transaction_id = t.id AND t.category_id IS NULL AND NOT t.is_split;

INSERT INTO payees (name)
SELECT DISTINCT ON (lower(trim(counterparty))) trim(counterparty) FROM sale_contracts
WHERE COALESCE(trim(counterparty), '') <> ''
ON CONFLICT DO NOTHING;
UPDATE transactions t SET payee_id = p.id
FROM sale_contracts sc JOIN payees p ON lower(p.name) = lower(trim(sc.counterparty))
WHERE sc.linked_transaction_id = t.id AND t.payee_id IS NULL;

-- Money in with no category waits on Review until it gets one (the app
-- refuses to clear the flag without one, so this only ever catches new
-- or older uncategorized income).
UPDATE transactions SET needs_review = true,
       review_note = COALESCE(review_note, 'Income with no category — pick one.')
WHERE amount > 0 AND NOT is_transfer AND NOT is_split AND category_id IS NULL AND NOT needs_review;

-- ---------------------------------------------------------------------------
-- Month-end close. A closed month's transactions can't be added, edited,
-- deleted or cleared — from the app or from the statement agent — until the
-- month is reopened. Every close and reopen is logged.
CREATE TABLE IF NOT EXISTS closed_periods (
  month      DATE PRIMARY KEY,           -- first day of the month
  closed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  forced     BOOLEAN NOT NULL DEFAULT false,
  note       TEXT
);
CREATE TABLE IF NOT EXISTS period_log (
  id      SERIAL PRIMARY KEY,
  month   DATE NOT NULL,
  action  TEXT NOT NULL,                 -- 'closed' | 'reopened'
  forced  BOOLEAN NOT NULL DEFAULT false,
  note    TEXT,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- GST. `gst_amount` is the GST included in a transaction's amount, taken
-- from the receipt or invoice — exact figures only, never estimated. On
-- money out it's an input tax credit (the farm's share of it); on money in
-- it's GST collected. NULL = none recorded.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(14,2);

-- One row per GST reporting period once it's been filed. The refund (or
-- payment) that settles it is linked here and kept out of income/expense.
CREATE TABLE IF NOT EXISTS gst_returns (
  period_start              DATE PRIMARY KEY,
  period_end                DATE NOT NULL,
  filed_on                  DATE,
  net_amount                NUMERIC(14,2),         -- as filed: negative = refund to the farm
  settlement_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  notes                     TEXT
);

INSERT INTO settings (key, value) VALUES ('gst_filing_frequency', '"quarterly"') ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Receipts. A photo goes in (from the phone Shortcut or the Receipts page),
-- is read by Claude (date, total, GST, business, items, category), and is
-- matched to the bank or card transaction it belongs to. The image is the
-- record CRA would ask for, so it's kept here, backed up with everything else.
CREATE TABLE IF NOT EXISTS receipts (
  id              SERIAL PRIMARY KEY,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT NOT NULL DEFAULT 'app',
  mime            TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  image           BYTEA NOT NULL,
  -- reading → unmatched (read, no transaction yet) → matched; or
  -- review (several possible transactions), failed (couldn't read),
  -- not_receipt, unread (no API key — fill in by hand)
  status          TEXT NOT NULL DEFAULT 'reading',
  extracted       JSONB,
  candidates      JSONB,
  transaction_id  INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  error           TEXT,
  matched_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts (status);
CREATE INDEX IF NOT EXISTS idx_receipts_tx ON receipts (transaction_id);

-- A contract settled by a deposit that was already in the ledger: undoing
-- the settlement unlinks that deposit instead of deleting it.
ALTER TABLE sale_contracts ADD COLUMN IF NOT EXISTS linked_existing BOOLEAN NOT NULL DEFAULT false;

-- Invoices photographed through Receipts become unpaid bills; the photo
-- points at the bill until it's paid, then at the payment.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL;

-- Deductions on grain settlements and livestock sale statements: farm
-- sales are reported gross, with these as expenses.
INSERT INTO expense_categories (name, class, ledger, kind, parent_id)
SELECT 'Marketing & sales costs', 'variable_seasonal', 'business', 'expense', NULL
WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE lower(name) = 'marketing & sales costs');
INSERT INTO expense_categories (name, class, ledger, kind, parent_id)
SELECT v.name, 'variable_seasonal', 'business', 'expense', p.id
FROM (VALUES ('Levies & checkoff'), ('Trucking & freight'), ('Grading, drying & dockage'), ('Commission & yardage')) AS v(name)
JOIN expense_categories p ON lower(p.name) = 'marketing & sales costs' AND p.parent_id IS NULL
WHERE NOT EXISTS (SELECT 1 FROM expense_categories c WHERE lower(c.name) = lower(v.name));

-- Bills use the same category list as the ledger (category_id). The text
-- `category` is kept as that category's name for older readers. Old
-- free-text bill categories are moved onto the list: an existing category
-- of the same name is used; "Fuel: Diesel" / "Fuel › Diesel" / "Land
-- Rent - Greenfeed" become a subcategory under its parent; anything else
-- becomes a category of its own. Same rule as expenseCategoryFor() in
-- lib/postings.js, which handles bills that arrive later with text.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL;
DO $$
DECLARE
  r RECORD; pname TEXT; cname TEXT; pid INTEGER; cid INTEGER;
  sep CONSTANT TEXT := '\s*(›|:| - | — | – )\s*';
BEGIN
  FOR r IN SELECT DISTINCT trim(category) AS cat FROM bills
           WHERE category_id IS NULL AND COALESCE(trim(category), '') <> '' LOOP
    cid := NULL; pid := NULL;
    SELECT id INTO cid FROM expense_categories
      WHERE kind = 'expense' AND lower(name) = lower(r.cat) ORDER BY parent_id NULLS FIRST, id LIMIT 1;
    IF cid IS NULL AND r.cat ~ sep THEN
      pname := trim(substring(r.cat FROM '^(.*?)' || sep));
      cname := trim(regexp_replace(r.cat, '^.*?' || sep, ''));
      SELECT id INTO pid FROM expense_categories
        WHERE kind = 'expense' AND parent_id IS NULL AND lower(name) = lower(pname) ORDER BY id LIMIT 1;
      IF pid IS NULL THEN
        INSERT INTO expense_categories (name, class, ledger, kind) VALUES (pname, 'variable_seasonal', 'business', 'expense')
        RETURNING id INTO pid;
      END IF;
      SELECT id INTO cid FROM expense_categories
        WHERE kind = 'expense' AND parent_id = pid AND lower(name) = lower(cname) LIMIT 1;
      IF cid IS NULL THEN
        INSERT INTO expense_categories (name, class, ledger, kind, parent_id) VALUES (cname, 'variable_seasonal', 'business', 'expense', pid)
        RETURNING id INTO cid;
      END IF;
    ELSIF cid IS NULL THEN
      INSERT INTO expense_categories (name, class, ledger, kind) VALUES (r.cat, 'variable_seasonal', 'business', 'expense')
      RETURNING id INTO cid;
    END IF;
    UPDATE bills SET category_id = cid, category = (SELECT name FROM expense_categories WHERE id = cid)
      WHERE category_id IS NULL AND trim(category) = r.cat;
  END LOOP;
END $$;

-- "That payment wasn't this bill": undoing an automatic or confirmed link
-- remembers the pair so the matcher never offers it again.
CREATE TABLE IF NOT EXISTS bill_link_rejections (
  bill_id        INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bill_id, transaction_id)
);

-- Entries Money Hub made on your word — a bill marked paid, a loan payment
-- or contract settlement recorded by hand, or an entry typed into an
-- account that gets statements — wait for the statement to show them.
-- Cleared when a statement line claims the entry. Everything else (statement
-- lines, history, imports) never carries it.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS awaiting_statement BOOLEAN NOT NULL DEFAULT false;
UPDATE transactions t SET awaiting_statement = true
WHERE NOT t.awaiting_statement AND t.source IS NULL
  AND NOT EXISTS (SELECT 1 FROM statement_lines sl WHERE sl.transaction_id = t.id)
  AND (EXISTS (SELECT 1 FROM bills b WHERE b.linked_transaction_id = t.id AND NOT b.linked_existing)
    OR EXISTS (SELECT 1 FROM loan_payments lp WHERE lp.linked_transaction_id = t.id AND NOT lp.linked_existing)
    OR EXISTS (SELECT 1 FROM sale_contracts c WHERE c.linked_transaction_id = t.id AND NOT c.linked_existing));

-- Sale contracts are paid by one or more deposits (grain pays per load or
-- per settlement, each net of checkoff/levies/freight). Each deposit that
-- counts toward a contract is a row here. received_amount is the gross
-- received (a deposit split by a settlement ticket counts its gross sale);
-- the contract settles when that reaches the contract value less the
-- deductions allowance (setting contract_deduction_allowance_pct, default
-- 3%), and the remaining gap is booked as deductions so income shows at
-- the contract value. See lib/postings.js refreshContract.
CREATE TABLE IF NOT EXISTS contract_payments (
  id             SERIAL PRIMARY KEY,
  contract_id    INTEGER NOT NULL REFERENCES sale_contracts(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  created_here   BOOLEAN NOT NULL DEFAULT false, -- recorded from the Contracts tab (removed again on unlink)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contract_payments_contract ON contract_payments (contract_id);
ALTER TABLE sale_contracts ADD COLUMN IF NOT EXISTS received_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sale_contracts ADD COLUMN IF NOT EXISTS deductions_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sale_contracts ADD COLUMN IF NOT EXISTS settle_note TEXT;
-- Contracts settled the old way (one linked deposit) move onto the list.
INSERT INTO contract_payments (contract_id, transaction_id, created_here)
SELECT id, linked_transaction_id, NOT linked_existing FROM sale_contracts
WHERE linked_transaction_id IS NOT NULL
ON CONFLICT (transaction_id) DO NOTHING;
UPDATE sale_contracts c SET received_amount = x.gross, linked_transaction_id = NULL
FROM (SELECT cp.contract_id, SUM(CASE WHEN t.is_split
        THEN COALESCE((SELECT SUM(s.amount) FROM transaction_splits s WHERE s.transaction_id = t.id AND s.amount > 0), 0)
        ELSE t.amount END) AS gross
      FROM contract_payments cp JOIN transactions t ON t.id = cp.transaction_id GROUP BY cp.contract_id) x
WHERE x.contract_id = c.id AND c.linked_transaction_id IS NOT NULL;
-- "That deposit isn't this contract": never linked automatically again.
CREATE TABLE IF NOT EXISTS contract_link_rejections (
  contract_id    INTEGER NOT NULL REFERENCES sale_contracts(id) ON DELETE CASCADE,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, transaction_id)
);
INSERT INTO settings (key, value) VALUES ('contract_deduction_allowance_pct', '3') ON CONFLICT (key) DO NOTHING;

-- Bills on finance terms (input financing: interest-free until a date,
-- then interest at a set rate until paid). What's owing on any date is
-- bill_owing(): the balance (the invoice, or the latest statement's
-- balance) plus simple daily interest (actual/365) from the later of the
-- interest-free date and that statement's date. Ordinary bills owe their
-- amount. The forecast counts a financed bill at what will be owing on
-- its due date (the date you plan to pay it).
ALTER TABLE bills ADD COLUMN IF NOT EXISTS is_financed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS finance_rate_pct NUMERIC(6,3);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS interest_free_until DATE;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS balance_amount NUMERIC(14,2);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS balance_as_of DATE;
CREATE OR REPLACE FUNCTION bill_owing(b bills, d date) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NOT b.is_financed THEN b.amount
    ELSE round(COALESCE(b.balance_amount, b.amount) * (1 + COALESCE(b.finance_rate_pct, 0) / 100.0 *
      GREATEST(d - COALESCE(GREATEST(b.balance_as_of, b.interest_free_until), b.received_date, b.created_at::date, d), 0) / 365.0), 2)
  END
$$;

-- Documents filed on a sale contract (the signed contract, amendments,
-- confirmations) — kept, not read. Settlement tickets belong to deposits.
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS contract_id INTEGER REFERENCES sale_contracts(id) ON DELETE SET NULL;

-- Vendors: a bill belongs to a vendor (a payee), so the Bills tab can show
-- one balance per vendor and one payment can clear several of its bills.
-- Existing bills take the vendor from their name ("JS & CL Gayler — Inv.
-- 0588652" → JS & CL Gayler).
ALTER TABLE bills ADD COLUMN IF NOT EXISTS payee_id INTEGER REFERENCES payees(id) ON DELETE SET NULL;
INSERT INTO payees (name)
SELECT DISTINCT trim(regexp_replace(name, '\s+(—|–|-|#|inv\.?\s|invoice\s).*$', '', 'i'))
FROM bills WHERE payee_id IS NULL AND trim(regexp_replace(name, '\s+(—|–|-|#|inv\.?\s|invoice\s).*$', '', 'i')) <> ''
ON CONFLICT ((lower(name))) DO NOTHING;
UPDATE bills b SET payee_id = p.id FROM payees p
WHERE b.payee_id IS NULL AND lower(p.name) = lower(trim(regexp_replace(b.name, '\s+(—|–|-|#|inv\.?\s|invoice\s).*$', '', 'i')));

-- Money a vendor is holding for you: a deposit paid ahead. 'prepayment'
-- is applied to later bills; 'refundable' (a bin or container deposit) is
-- given back. The payment that made it is held as yours (a transfer, not
-- an expense); the parts applied to bills become those bills' expense.
CREATE TABLE IF NOT EXISTS vendor_credits (
  id                    SERIAL PRIMARY KEY,
  payee_id              INTEGER NOT NULL REFERENCES payees(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (kind IN ('prepayment', 'refundable')),
  amount                NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  date                  DATE NOT NULL,
  transaction_id        INTEGER REFERENCES transactions(id) ON DELETE SET NULL,  -- the deposit paid
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'used', 'refunded', 'kept')),
  refund_transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  kept_category_id      INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
  note                  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS credit_applications (
  id         SERIAL PRIMARY KEY,
  credit_id  INTEGER NOT NULL REFERENCES vendor_credits(id) ON DELETE CASCADE,
  bill_id    INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  amount     NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- What a bill still needs paid: less any deposit applied to it.
CREATE OR REPLACE FUNCTION bill_owing(b bills, d date) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT GREATEST(0, CASE
    WHEN NOT b.is_financed THEN b.amount
    ELSE round(COALESCE(b.balance_amount, b.amount) * (1 + COALESCE(b.finance_rate_pct, 0) / 100.0 *
      GREATEST(d - COALESCE(GREATEST(b.balance_as_of, b.interest_free_until), b.received_date, b.created_at::date, d), 0) / 365.0), 2)
  END - COALESCE((SELECT SUM(ca.amount) FROM credit_applications ca WHERE ca.bill_id = b.id), 0))
$$;
