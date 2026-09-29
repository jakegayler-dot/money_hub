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

-- ---- Inventory: forage and a price list -------------------------------
-- Source systems (Quarter Section) know bushels and bale counts but often
-- not market prices. price_per_unit on an item is therefore optional: when
-- it's missing, the item is valued from commodity_prices (maintained in
-- Money Hub or pushed separately); when neither exists, the item counts at
-- $0 and is flagged as needing a price — never valued at a guess.
ALTER TABLE inventory_items ALTER COLUMN price_per_unit DROP NOT NULL;

CREATE TABLE IF NOT EXISTS commodity_prices (
  id              SERIAL PRIMARY KEY,
  commodity       TEXT NOT NULL,
  unit            TEXT NOT NULL,
  price_per_unit  NUMERIC(14,4) NOT NULL,
  as_of           DATE NOT NULL DEFAULT CURRENT_DATE,
  source          TEXT NOT NULL DEFAULT 'manual',
  notes           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commodity_prices_key
  ON commodity_prices (lower(commodity), lower(unit));

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

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);
CREATE INDEX IF NOT EXISTS idx_transactions_ledger ON transactions (ledger);
CREATE INDEX IF NOT EXISTS idx_loan_payments_due_date ON loan_payments (due_date);
CREATE INDEX IF NOT EXISTS idx_bills_due_date ON bills (due_date);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills (status);
