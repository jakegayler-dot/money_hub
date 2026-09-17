-- Money Hub schema (v1)
-- Business and personal ledgers are kept structurally separate: every
-- account and transaction carries a `ledger` tag, and DSCR/liquidity
-- calculations filter on ledger = 'business' only.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('liquidity_buffer_pct', '0.15'),
  ('dscr_threshold', '1.25'),
  ('reserve_target_months', '2')
ON CONFLICT (key) DO NOTHING;

CREATE TYPE ledger_type AS ENUM ('business', 'personal');
CREATE TYPE account_type AS ENUM ('operating', 'draw', 'reserve', 'personal', 'investment');

CREATE TABLE IF NOT EXISTS accounts (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  ledger          ledger_type NOT NULL,
  account_type    account_type NOT NULL,
  opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  source_system   TEXT,              -- e.g. 'quicken', 'agexpert', 'wealthsimple', 'manual'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE expense_class AS ENUM ('fixed', 'variable_seasonal', 'capex', 'overhead');

CREATE TABLE IF NOT EXISTS expense_categories (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  class        expense_class NOT NULL,
  ledger       ledger_type NOT NULL DEFAULT 'business',
  annual_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- 12 numbers summing to ~1.0; index 0 = January
  monthly_pct  JSONB NOT NULL DEFAULT '[0.0833,0.0833,0.0834,0.0833,0.0833,0.0834,0.0833,0.0833,0.0834,0.0833,0.0833,0.0834]'
);

CREATE TYPE purchase_class AS ENUM ('compounding', 'productive_tool', 'consumptive');

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

CREATE TYPE loan_purpose AS ENUM ('operating', 'term', 'capital_asset');

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

CREATE TYPE reserve_direction AS ENUM ('sweep_in', 'draw_out');

CREATE TABLE IF NOT EXISTS reserve_transfers (
  id        SERIAL PRIMARY KEY,
  date      DATE NOT NULL,
  amount    NUMERIC(14,2) NOT NULL,
  direction reserve_direction NOT NULL,
  note      TEXT
);

CREATE TYPE eval_decision AS ENUM ('pass', 'fail', 'pending');

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

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions (date);
CREATE INDEX IF NOT EXISTS idx_transactions_ledger ON transactions (ledger);
CREATE INDEX IF NOT EXISTS idx_loan_payments_due_date ON loan_payments (due_date);
