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
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  CREATE TYPE loan_purpose AS ENUM ('operating', 'term', 'capital_asset');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS loans (
  id                SERIAL PRIMARY KEY,
  lender            TEXT NOT NULL,
  purpose           loan_purpose NOT NULL,
  linked_asset      TEXT,                 -- free text description if purpose = capital_asset
  principal         NUMERIC(14,2) NOT NULL,
  interest_rate_pct NUMERIC(6,3) NOT NULL,
  rate_type         TEXT NOT NULL DEFAULT 'fixed', -- fixed | variable
  term_months       INTEGER NOT NULL,
  start_date        DATE NOT NULL,
  covenant_notes    TEXT,
  covenant_date     DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  paid_date         DATE
);

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
  amount         NUMERIC(14,2) NOT NULL,
  frequency      bill_frequency NOT NULL DEFAULT 'one_time',
  received_date  DATE,                   -- when the invoice was received (optional)
  due_date       DATE NOT NULL,
  status         bill_status NOT NULL DEFAULT 'unpaid',
  paid_date      DATE,
  linked_transaction_id INTEGER REFERENCES transactions(id),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);
CREATE INDEX IF NOT EXISTS idx_transactions_ledger ON transactions (ledger);
CREATE INDEX IF NOT EXISTS idx_loan_payments_due_date ON loan_payments (due_date);
CREATE INDEX IF NOT EXISTS idx_bills_due_date ON bills (due_date);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills (status);
