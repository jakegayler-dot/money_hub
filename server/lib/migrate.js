import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Postgres error codes that mean "this object already exists" — safe to
// treat as success, since it means the schema was already applied by an
// earlier run. Anything else (bad connection, syntax error, etc.) is a
// real failure and should still stop the deploy.
const ALREADY_APPLIED_CODES = new Set([
  '42710', // duplicate_object (types, etc.)
  '42P07', // duplicate_table
  '42701', // duplicate_column
]);

// Adding a value to an existing enum (ALTER TYPE ... ADD VALUE) cannot run
// inside a transaction block, and schema.sql is applied as one multi-
// statement string, which Postgres treats as an implicit transaction. So
// enum value additions run here instead, each as its own single-statement
// query, before schema.sql is applied. Safe to re-run: IF NOT EXISTS means
// a database that already has the value just no-ops.
const ENUM_ADDITIONS = [
  `ALTER TYPE loan_purpose ADD VALUE IF NOT EXISTS 'mortgage'`,
];

async function migrate() {
  console.log('Applying enum additions ...');
  for (const stmt of ENUM_ADDITIONS) {
    try {
      await pool.query(stmt);
    } catch (err) {
      // 42704 = undefined_object — the enum itself doesn't exist yet on a
      // brand-new database; schema.sql's CREATE TYPE below already includes
      // this value in that case, so there's nothing to add.
      if (err.code !== '42704') throw err;
    }
  }

  const sql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
  console.log('Applying schema.sql ...');
  try {
    await pool.query(sql);
    console.log('Done — schema applied.');
  } catch (err) {
    if (ALREADY_APPLIED_CODES.has(err.code)) {
      console.log(`Schema already applied (${err.code}: ${err.message}) — continuing.`);
    } else {
      throw err;
    }
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
