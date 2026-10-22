// Groceries: which receipts are groceries, store names, unit prices, the
// typical month and the price book — against a real Postgres (PGlite) with
// the app's schema — and the push that lets Sentinel tick the shopping list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { isGroceryReceipt, storeName, unitPrice, cleanLine, median, saveLines, grocerySummary, priceBook, pushToSentinel } from '../lib/groceries.js';
import { reginaToday } from '../lib/sentinelSnapshot.js';
import { addMonths, addDays } from '../lib/dates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => new Date(`${s}T00:00:00`), 1700: (s) => s };
let db;

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const query = (sql, params) => db.query(sql, params);
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
});
after(async () => { await db?.close(); });

test('which receipts are groceries', () => {
  const r = (o) => ({ is_receipt: true, doc_type: 'receipt', total: 84.2, ...o });
  assert.equal(isGroceryReceipt(r({ party: 'SOBEYS #4471 MELFORT', category: null })), true);
  assert.equal(isGroceryReceipt(r({ party: 'Melfort Co-op', category: 'Groceries' })), true);
  assert.equal(isGroceryReceipt(r({ party: 'Melfort Co-op Food Store', category: null })), true);
  assert.equal(isGroceryReceipt(r({ party: 'Melfort Co-op', category: 'Fuel › Diesel — dyed', owner: 'grain' })), false);
  assert.equal(isGroceryReceipt(r({ party: 'Walmart', category: 'Clothing' })), false);
  assert.equal(isGroceryReceipt(r({ party: 'Rocky Mountain Equipment', category: 'Parts' })), false);
  assert.equal(isGroceryReceipt(r({ party: 'Safeway', doc_type: 'invoice' })), false);
  assert.equal(storeName('REAL CANADIAN SUPERSTORE #1520'), 'Superstore');
  assert.equal(storeName('Melfort & District Co-op'), 'Co-op');
  assert.equal(storeName('Bob\'s Meats #2 Tisdale'), "Bob's Meats");
});

test('unit prices make stores comparable', () => {
  assert.deepEqual(unitPrice({ amount: 6.29, qty: 1, size_value: 4, size_unit: 'l' }), { unit: 'l', unit_price: 1.5725 });
  assert.deepEqual(unitPrice({ amount: 4.93, qty: 1, size_value: 1.235, size_unit: 'kg' }), { unit: 'kg', unit_price: 3.9919 });
  assert.deepEqual(unitPrice({ amount: 3.98, qty: 2, size_value: 500, size_unit: 'g' }), { unit: 'kg', unit_price: 3.98 });
  assert.deepEqual(unitPrice({ amount: 5.49, qty: 1, size_value: 18, size_unit: 'each' }), { unit: 'each', unit_price: 0.305 });
  assert.deepEqual(unitPrice({ amount: 2.5, qty: null }), { unit: 'each', unit_price: 2.5 });
  const l = cleanLine({ printed: 'GRN ONION', item: ' Green  Onions', food_type: 'Produce', amount: '1.29', discount: -0.3 });
  assert.equal(l.item, 'green onions');
  assert.equal(l.food_type, 'produce');
  assert.equal(l.discount, 0.3);
  assert.equal(cleanLine({ item: 'x', amount: 0 }), null);
  assert.equal(cleanLine({ item: 'thing', food_type: 'gadgets', amount: 3 }).food_type, 'other');
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('spending by food type, the typical month and the price book', async () => {
  const today = reginaToday();
  const month = (n) => addMonths(`${today.slice(0, 7)}-01`, n);
  const receipt = async () => (await db.query(`INSERT INTO receipts (mime, bytes, image, status, grocery) VALUES ('image/jpeg', 1, '\\x00', 'matched', 'catalogued') RETURNING id`)).rows[0].id;
  const line = (item, food_type, amount, size_value, size_unit, extra = {}) => cleanLine({ item, printed: item.toUpperCase(), food_type, amount, qty: 1, size_value, size_unit, ...extra });
  // Three full months: milk at the Co-op every time, once at Superstore for less.
  for (const [n, meat] of [[-3, 40], [-2, 60], [-1, 50]]) {
    await saveLines(pool, await receipt(), { date: addDays(month(n), 4), store: 'Co-op' },
      [line('2% milk', 'dairy & eggs', 6.29, 4, 'l'), line('ground beef', 'meat & seafood', meat, 4, 'kg'), line('paper towels', 'household', 12, 6, 'each')]);
  }
  await saveLines(pool, await receipt(), { date: addDays(month(-1), 10), store: 'Superstore' },
    [line('2% milk', 'dairy & eggs', 5.49, 4, 'l', { store_brand: true }), line('bananas', 'produce', 2.1, 1.5, 'kg')]);
  // This month so far.
  await saveLines(pool, await receipt(), { date: today, store: 'Co-op' }, [line('2% milk', 'dairy & eggs', 6.49, 4, 'l')]);

  const s = await grocerySummary({ months: 6 });
  assert.equal(s.months.length, 6);
  assert.deepEqual(s.typical.months_used, [month(-3), month(-2), month(-1)].map((m) => m.slice(0, 7)));
  assert.equal(s.typical.by_type['meat & seafood'], 50);
  assert.equal(s.typical.by_type['dairy & eggs'], 6.29); // median of 6.29, 6.29, 11.78
  assert.equal(s.typical.total, 75.88); // months of 58.29, 78.29, 75.88
  const last = s.months.find((m) => m.month === month(-1).slice(0, 7));
  assert.equal(last.receipts, 2);
  assert.equal(last.total, 75.88);
  assert.equal(s.this_month.total, 6.49);
  assert.ok(s.stores[0].store === 'Co-op' && s.stores[0].trips === 4);

  const book = await priceBook({});
  const milk = book.find((p) => p.item === '2% milk');
  assert.equal(book[0].item, '2% milk'); // bought at two stores: first
  assert.equal(milk.unit, 'l');
  assert.equal(milk.usual_store, 'Co-op');
  assert.equal(milk.cheapest_store, 'Superstore');
  assert.equal(milk.saving_pct, 15); // 1.3725 vs 1.6225 a litre
  assert.ok(milk.yearly_saving > 0);
  assert.equal(milk.stores.find((x) => x.store === 'Co-op').latest, 1.6225);
  assert.ok(!book.some((p) => p.item === 'paper towels' && p.stores.length > 1));
});

test("a fresh receipt goes to Sentinel's shopping list", async () => {
  let got = null;
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      got = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ticked: [{ title: 'Milk' }], lines: 1 }));
    });
  });
  await new Promise((ok) => server.listen(0, ok));
  process.env.SENTINEL_URL = `http://127.0.0.1:${server.address().port}/`;
  process.env.SENTINEL_API_KEY = 'k';
  try {
    const out = await pushToSentinel({ receipt_id: 7, store: 'Co-op', date: '2026-10-22', lines: [{ item: '2% milk', printed: '2% MILK 4L', amount: 6.29 }] });
    assert.deepEqual(out.ticked, [{ title: 'Milk' }]);
    assert.equal(got.url, '/v1/groceries/receipt');
    assert.equal(got.auth, 'Bearer k');
    assert.deepEqual(got.body, { receipt_id: 7, store: 'Co-op', date: '2026-10-22', lines: [{ item: '2% milk', printed: '2% MILK 4L' }] });
  } finally {
    delete process.env.SENTINEL_URL;
    delete process.env.SENTINEL_API_KEY;
    server.close();
  }
});
