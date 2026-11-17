// His option profit and loss from the brokerage entries already in Money Hub (Jake, Nov 17: "it doesnt show my option profit
// and loss. it should look like any asset that produces cash ... You've collected US$673 in call premium and paid US$1,551 net
// for puts ... Calls: US$558 on NVDA and US$115 on SpaceX").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { classify, optionCash, tagEntry, untagEntry, saveSource } from '../lib/options/cash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let db; let acct; let cat; let other;
const tx = async (date, amount, description, opts = {}) => (await db.query(
  `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, is_transfer) VALUES ($1, 'personal', $2, $3, $4, $5, $6) RETURNING id`,
  [opts.account || acct, date, amount, description, opts.category === undefined ? cat : opts.category, !!opts.transfer])).rows[0].id;
before(async () => {
  db = new PGlite({ parsers: { 1082: (s) => s, 1700: (s) => s } });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  acct = (await db.query(`INSERT INTO accounts (name, ledger, account_type) VALUES ('Account 9', 'personal', 'investment') RETURNING id`)).rows[0].id;
  other = (await db.query(`INSERT INTO accounts (name, ledger, account_type) VALUES ('Chequing', 'personal', 'operating') RETURNING id`)).rows[0].id;
  cat = (await db.query(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Investment buy/sell', 'variable_seasonal', 'personal', 'expense') RETURNING id`)).rows[0].id;
});
after(async () => { await db?.close(); });

test('the words say which it is: call, put, shares or other, and which stock', () => {
  const known = new Set(['NVDA', 'TSLA']);
  assert.deepEqual(classify('Sold 1 NVDA Nov 20 165 Call @ 5.30', known), { kind: 'call', symbol: 'NVDA' });
  assert.deepEqual(classify('STO 1 NVDA 261120C00165000', known), { kind: 'call', symbol: 'NVDA' });
  assert.deepEqual(classify('Bought to open 1 NVDA 12/31 150P at 10.55', known), { kind: 'put', symbol: 'NVDA' });
  assert.deepEqual(classify('NVDA put roll to Dec 31 $150 (debit)', known), { kind: 'put', symbol: 'NVDA' });
  assert.deepEqual(classify('Bought 105 shares NVDA @ 159.84', known), { kind: 'stock', symbol: 'NVDA' });
  assert.deepEqual(classify('Margin interest', known), { kind: 'other', symbol: null });
  assert.deepEqual(classify('Rolled NVDA call into put', known), { kind: null, symbol: 'NVDA' }, 'both named: his to say');
  assert.deepEqual(classify('SpaceX covered call premium', known), { kind: 'call', symbol: null }, 'a name, not a symbol');
  assert.deepEqual(classify('SpaceX covered call premium', known, { SpaceX: 'SPCX' }), { kind: 'call', symbol: 'SPCX' });
  assert.deepEqual(classify('nvda option', known), { kind: null, symbol: null }, 'a symbol only as written in capitals');
  assert.deepEqual(classify('SOLD 2 SHOP NOV 20 110 CALL', known), { kind: 'call', symbol: 'SHOP' }, 'a stock the desk does not know yet');
});

test('calls in, puts net, by stock; what the words don’t say waits for him; his own sorting wins', async () => {
  await tx('2026-11-03', -16783.2, 'Bought 105 shares NVDA @ 159.84');
  await tx('2026-11-04', 182, 'Sold 1 NVDA Nov 6 167.5 Call @ 1.82');
  await tx('2026-11-10', 376, 'Sold 1 NVDA Nov 13 165 Call @ 3.76');
  await tx('2026-11-05', -387, 'Bought 1 NVDA Dec 19 140 Put @ 3.87');
  await tx('2026-11-07', 450, 'Sold 1 NVDA Dec 19 140 Put @ 4.50');
  await tx('2026-11-07', -544, 'Bought 1 NVDA Dec 19 145 Put @ 5.44');
  await tx('2026-11-12', -485, 'NVDA put roll to Dec 31 $150 (debit)');
  const space = await tx('2026-11-11', 115, 'SpaceX covered call premium');
  const mystery = await tx('2026-11-11', -585, 'Option purchase');
  await tx('2026-11-14', -12.4, 'Margin interest');
  await tx('2026-11-02', 20000, 'Deposit from chequing', { transfer: true });
  await tx('2026-11-09', -64, 'Groceries', { account: other, category: null });

  let c = await optionCash();
  assert.equal(c.currency, 'USD');
  assert.equal(c.read.entries, 10, 'the Investment category, no transfers, nothing from other accounts');
  const nv = c.stocks.find((s) => s.symbol === 'NVDA');
  assert.equal(nv.calls, 558);
  assert.equal(nv.puts, -966); // −387 + 450 − 544 − 485
  assert.equal(nv.options_net, -408);
  assert.equal(nv.stock, -16783.2);
  assert.equal(nv.first, '2026-11-04');
  assert.deepEqual(c.unsorted.map((e) => e.id).sort(), [space, mystery].sort());

  // He says what they are; "SpaceX" files every entry that mentions it from now on.
  await tagEntry(space, { kind: 'call', symbol: 'spcx', word: 'SpaceX' });
  await tagEntry(mystery, { kind: 'put', symbol: 'SPCX' });
  await tx('2026-11-13', 60, 'SpaceX call premium');
  c = await optionCash();
  assert.equal(c.unsorted.length, 0);
  const sp = c.stocks.find((s) => s.symbol === 'SPCX');
  assert.equal(sp.calls, 175);
  assert.equal(sp.puts, -585);
  assert.deepEqual(c.totals, { calls: 733, puts: -1551, options_net: -818, first: '2026-11-04' });
  assert.equal(c.entries.find((e) => e.id === space).sorted_by, 'you');

  await assert.rejects(tagEntry(mystery, { kind: 'put' }), /Which stock/);
  await assert.rejects(tagEntry(mystery, { kind: 'banana', symbol: 'SPCX' }), /Call, put/);
  await untagEntry(mystery);
  assert.equal((await optionCash()).unsorted.length, 1);
});

test('another account he picks is read too; the currency is his to set', async () => {
  await tx('2026-11-15', 90, 'Sold 1 TSLA Nov 20 400 Call', { account: other, category: null });
  assert.equal((await optionCash({ symbols: ['TSLA'] })).stocks.some((s) => s.symbol === 'TSLA'), false);
  await saveSource({ account_ids: [other], currency: 'CAD' });
  const c = await optionCash({ symbols: ['TSLA'] });
  assert.equal(c.stocks.find((s) => s.symbol === 'TSLA').calls, 90);
  assert.equal(c.currency, 'CAD');
});
