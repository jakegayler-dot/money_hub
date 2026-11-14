// Clothes from a receipt to Self Hub's wardrobe through Sentinel (Jake, Nov 14: "when I scan a receipt for moneyhub, if it's
// clothes or groceries, it automatically updates self hubs wardrobe library and grocery inventory").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { looksLikeClothes, cleanItem, pushClothes } from '../lib/clothes.js';
import { FOOD_TYPES, NON_FOOD } from '../lib/groceries.js';

test('which receipts may hold clothes: a clothing store, a receipt filed as clothing, or clothing lines on it', () => {
  const r = (o) => ({ is_receipt: true, doc_type: 'receipt', total: 89.99, ...o });
  assert.equal(looksLikeClothes(r({ party: "Mark's #212 Melfort", category: 'Repairs' })), true);
  assert.equal(looksLikeClothes(r({ party: 'Canadian Tire', category: 'Clothing & shopping' })), true);
  assert.equal(looksLikeClothes(r({ party: 'Peavey Mart', items: [{ description: 'MENS WORK BOOTS 11' }] })), true);
  assert.equal(looksLikeClothes(r({ party: 'Peavey Mart', items: [{ description: 'RADIATOR CAP' }, { description: 'DRIVE BELT' }] })), false);
  assert.equal(looksLikeClothes(r({ party: 'Mark\'s', doc_type: 'invoice' })), false);
  // A grocery slip's clothes are their own lines, kept out of the food spending.
  assert.ok(FOOD_TYPES.includes('clothing') && NON_FOOD.has('clothing'));
});

test("the reader's items in the wardrobe's words; who it's for kept for Sentinel to decide", () => {
  assert.deepEqual(cleanItem({ printed: 'MNS DH WRK PNT 34X32', for: 'jake', category: 'bottom', type: 'Work pants', brand: 'Dakota', size: '34x32', style: 'farm', season: 'nonsense', qty: 2, price: 49.994 }),
    { printed: 'MNS DH WRK PNT 34X32', for: 'jake', category: 'Bottom', type: 'Work pants', brand: 'Dakota', colour: null, size: '34x32', style: 'Farm', season: null, qty: 2, price: 49.99 });
  assert.equal(cleanItem({ category: 'Hat', type: 'Cap' }), null, 'not a wardrobe category');
  assert.equal(cleanItem({ for: 'grandma', category: 'Top', type: 'T-shirt' }).for, 'unsure');
});

test('the clothes go to Sentinel with the receipt', async () => {
  let got = null;
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { got = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ added: [{ type: 'Work pants' }] })); });
  });
  await new Promise((ok) => server.listen(0, ok));
  process.env.SENTINEL_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SENTINEL_API_KEY = 'k';
  try {
    const items = [{ for: 'jake', category: 'Bottom', type: 'Work pants', qty: 1, price: 49.99 }];
    const out = await pushClothes({ receipt_id: 9, store: "Mark's", date: '2026-11-14', items });
    assert.deepEqual(out.added, [{ type: 'Work pants' }]);
    assert.equal(got.url, '/v1/wardrobe/receipt');
    assert.equal(got.auth, 'Bearer k');
    assert.deepEqual(got.body, { receipt_id: 9, store: "Mark's", date: '2026-11-14', items });
  } finally {
    delete process.env.SENTINEL_URL;
    delete process.env.SENTINEL_API_KEY;
    server.close();
  }
});
