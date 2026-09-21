import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's internal DB connection doesn't need SSL; its external/public
  // proxy URL does. DATABASE_URL_SSL=true switches this on if you ever
  // connect via the public host instead of the internal one.
  ssl: process.env.DATABASE_URL_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

export async function getSetting(key, fallback) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (rows.length === 0) return fallback;
  return rows[0].value;
}

/**
 * Runs `fn` inside a single DB transaction (BEGIN/COMMIT, ROLLBACK on
 * error), passing it a dedicated client. Use this any time an action needs
 * to touch more than one table consistently — e.g. recording a transaction
 * AND moving the account balance it affects, so the two can never drift
 * apart even if one write fails.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
