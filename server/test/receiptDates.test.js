// Receipt dates (Oct 24): a till slip's date read the wrong way round is
// settled by the bank entry for its total; a date fixed on the receipt
// reaches its grocery lines; a grocery line fixed by hand is learned.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { dateReadings, settleDate, recheckReceiptDates } from '../lib/receiptDates.js';
import { saveLines, printedKey } from '../lib/groceries.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, acct;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  acct = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('Joint', 'personal', 'personal', 0) RETURNING id`)).id;
});
after(async () => { await db?.close(); });

test('every reading of a printed date', () => {
  assert.deepEqual(dateReadings('04/10/26').sort(), ['2004-10-26', '2026-04-10', '2026-10-04'].sort());
  assert.deepEqual(dateReadings('2026-10-04'), ['2026-10-04', '2026-04-10']);
  assert.ok(dateReadings('OCT 24 2026').includes('2026-10-24'));
  assert.deepEqual(dateReadings('24/10/26').sort(), ['2024-10-26', '2026-10-24'].sort());
});

test('the bank entry for the total settles which reading it is', async () => {
  await db.query(`INSERT INTO transactions (account_id, ledger, date, amount, description) VALUES ($1, 'personal', '2026-10-05', -87.43, 'SUPERSTORE')`, [acct]);
  // Read as April 10; printed 04/10/26; the money left on Oct 5 → it was Oct 4.
  const s = await settleDate({ date: '2026-04-10', printed: '04/10/26', total: 87.43, uploaded: '2026-10-20T12:00:00Z' });
  assert.equal(s.date, '2026-10-04');
  assert.equal(s.changed, true);
  // A date in the future of the upload can't be right.
  const f = await settleDate({ date: '2026-12-10', printed: '10/12/26', total: 5, uploaded: '2026-10-20T12:00:00Z' });
  assert.equal(f.date, '2026-10-12');
  // No evidence and both possible: the reader's reading stands.
  const k = await settleDate({ date: '2026-03-05', printed: '05/03/26', total: 12.5, uploaded: '2026-10-20T12:00:00Z' });
  assert.equal(k.date, '2026-03-05');
});

test('re-checking moves a misread receipt and its grocery lines, but never one fixed by hand', async () => {
  const mk = async (ex) => (await one(`INSERT INTO receipts (mime, bytes, image, status, extracted, uploaded_at) VALUES ('image/jpeg', 1, '\\x00', 'unmatched', $1, '2026-10-20') RETURNING id`, [ex])).id;
  const misread = await mk({ is_receipt: true, date: '2026-04-10', total: 87.43, party: 'SUPERSTORE' });
  const fixed = await mk({ is_receipt: true, date: '2026-04-10', total: 87.43, party: 'SUPERSTORE', date_set_by: 'hand' });
  await saveLines(pool, misread, { date: '2026-04-10', store: 'Superstore' }, [{ printed: 'BANANAS', item: 'bananas', food_type: 'produce', store_brand: false, amount: 2.5, discount: 0 }]);
  const changed = await recheckReceiptDates();
  assert.deepEqual(changed.map((c) => [c.id, c.to]), [[misread, '2026-10-04']]);
  assert.equal((await one('SELECT date FROM grocery_items WHERE receipt_id = $1', [misread])).date, '2026-10-04');
  assert.equal((await one('SELECT extracted FROM receipts WHERE id = $1', [fixed])).extracted.date, '2026-04-10');
});

test('a grocery line fixed by hand is that item on every receipt read after', async () => {
  await db.query(`INSERT INTO grocery_corrections (printed, item, food_type) VALUES ($1, 'green onions', 'produce')`, [printedKey('GRN ONION 1.29')]);
  const rc = (await one(`INSERT INTO receipts (mime, bytes, image, status) VALUES ('image/jpeg', 1, '\\x00', 'unmatched') RETURNING id`)).id;
  await saveLines(pool, rc, { date: '2026-10-10', store: 'Co-op' }, [{ printed: 'GRN ONION 0.99', item: 'onions', food_type: 'pantry', store_brand: false, amount: 0.99, discount: 0 }]);
  const g = await one('SELECT item, food_type FROM grocery_items WHERE receipt_id = $1', [rc]);
  assert.deepEqual(g, { item: 'green onions', food_type: 'produce' });
});
