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
