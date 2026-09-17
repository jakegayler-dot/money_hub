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

async function migrate() {
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
