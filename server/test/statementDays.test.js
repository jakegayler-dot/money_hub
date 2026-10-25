// Statement days on the calendar; closed cards stay off it (Oct 24).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { statementReleaseItems } from '../lib/calendar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db;

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const q = (text, params) => db.query(text, params);
  pool.query = q;
  await db.query(`INSERT INTO accounts (name, ledger, account_type, opening_balance, statement_day) VALUES ('RBC Farm Business', 'business', 'operating', 0, 31)`);
  await db.query(`INSERT INTO credit_cards (name, apr_purchase, statement_day) VALUES ('RBC Signature', 20.99, 9)`);
  await db.query(`INSERT INTO credit_cards (name, apr_purchase, statement_day, status) VALUES ('Old Capital One', 20.99, 15, 'closed')`);
});
after(async () => { await db?.close(); });

test('a statement day goes on the calendar every month; day 31 falls on the last day of short months; closed cards stay off', async () => {
  const items = await statementReleaseItems('2026-11-01', '2027-02-28');
  const acct = items.filter((i) => i.title.includes('Farm Business')).map((i) => i.date);
  assert.deepEqual(acct, ['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
  assert.deepEqual(items.filter((i) => i.title.includes('Signature')).map((i) => i.date), ['2026-11-09', '2026-12-09', '2027-01-09', '2027-02-09']);
  assert.ok(!items.some((i) => i.title.includes('Capital One')));
  assert.ok(items.every((i) => i.kind === 'statement'));
});
