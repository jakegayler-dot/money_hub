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
import { classify, optionCash, tagEntry, untagEntry, saveSource, insurance, sessionEarnings } from '../lib/options/cash.js';
import { marketCalendar, expiryClose } from '../lib/options/strategy.js';

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

test('the puts as insurance (Nov 17: "a fixed cost that needs to be extracted over the remaining trading days"): what is left, a trading day, and when the calls make it even', async () => {
  await saveSource({ account_ids: [], currency: 'USD' });
  const { rows: [opt] } = await db.query("SELECT id FROM transactions WHERE description = 'Option purchase'");
  await tagEntry(opt.id, { kind: 'put', symbol: 'SPCX' });
  const now = new Date('2026-11-17T15:30:00Z'); // Tuesday morning: 31 trading days to Dec 31
  const leg = (type, side, strike, expiry, premium, days) => ({ type, side, strike, expiry, premium, contracts: 1, days, per_day: Math.round((premium * 100 / days) * 100) / 100 });
  const list = [
    { symbol: 'NVDA', status: 'open', premium_collected: 0, open_legs: [leg('call', 'short', 165, '2026-11-20', 5.3, 4), leg('put', 'long', 150, '2026-12-31', 10.55, 33)] },
    // No Money Hub entries for this one: it goes by the positions record (a put for $600, $250 of calls so far).
    { symbol: 'AMD', status: 'open', premium_collected: -350, open_legs: [leg('put', 'long', 450, '2026-12-18', 6, 23)] },
    { symbol: 'TSLA', status: 'closed', premium_collected: 0, open_legs: [] },
  ];
  const r = await insurance({ now, list, fx: null });
  const nv = r.stocks.find((x) => x.symbol === 'NVDA');
  // From his entries: puts −$966 net, calls $558: $408 to go over 31 trading days.
  assert.equal(nv.from, 'entries');
  assert.equal(nv.puts_paid, 966);
  assert.equal(nv.calls_collected, 558);
  assert.equal(nv.left, 408);
  assert.equal(nv.trading_days_left, 31);
  assert.equal(nv.needed_per_day, 13.16);
  assert.equal(nv.call_now_per_day, 132.5); // $530 over the call's 4 trading days
  assert.equal(nv.days_to_even, 4);
  assert.equal(nv.even_on, '2026-11-20');
  assert.equal(nv.in_time, true);
  const amd = r.stocks.find((x) => x.symbol === 'AMD');
  // Nov 17 ("why does it say the puts have been paid off?"): with no entries the calls aren't known, so the whole cost stands.
  assert.equal(amd.from, 'positions');
  assert.equal(amd.puts_paid, 600);
  assert.equal(amd.calls_collected, null);
  assert.equal(amd.left, 600);
  assert.equal(amd.needed_per_day, 26.09);
  assert.equal(amd.trading_days_left, 23);
  assert.equal(amd.call_now_per_day, 0);
  assert.equal(amd.days_to_even, null, 'no call open: nothing coming in to pay it off');
  assert.equal(amd.even_on, null);
  // SPCX: entries only (a $585 put), the put no longer on a position: the cost stands, with no expiry to spread it to.
  const sp = r.stocks.find((x) => x.symbol === 'SPCX');
  assert.equal(sp.puts_paid, 585);
  assert.equal(sp.trading_days_left, null);
  assert.equal(r.total.puts_paid, 966 + 600 + 585);
  assert.equal(r.total.left, 408 + 600 + sp.left);
  assert.deepEqual(r.total.calls_unknown, ['AMD']);
  assert.equal(nv.put_entries, 4);
  assert.equal(nv.call_entries, 2);
  // His entries show far less in puts than the puts he holds cost (their trades aren't sorted): the held cost counts, and it
  // says so, instead of calling a $2,400 put paid off by $558 of calls.
  const big = await insurance({ now, fx: null, list: [{ symbol: 'NVDA', status: 'open', premium_collected: 0, open_legs: [leg('put', 'long', 150, '2026-12-31', 24, 33)] }] });
  const b = big.stocks.find((x) => x.symbol === 'NVDA');
  assert.equal(b.from, 'held');
  assert.equal(b.puts_paid, 2400);
  assert.equal(b.puts_in_entries, 966);
  assert.equal(b.left, 2400 - 558);
  assert.deepEqual(big.total.puts_from_held, ['NVDA']);
  assert.equal(r.total.put_expiry, '2026-12-31');
});

test('each session\'s earnings (Nov 18, Andrew\'s stock panel: "mix in my previous days earnings"): the shares\' move and that day\'s option entries', async () => {
  const hist = async () => [{ date: '2026-11-03', close: 160 }, { date: '2026-11-04', close: 162.5 }, { date: '2026-11-05', close: 161 }, { date: '2026-11-06', close: 170 }];
  // Nov 6 before the close: its session isn't done, so the newest is Nov 5.
  const rows = await sessionEarnings({ sessions: 2, now: new Date('2026-11-06T18:00:00Z'), fx: null, historyImpl: hist,
    list: [{ symbol: 'NVDA', status: 'open', shares: 105, opened_on: '2026-11-03' }] });
  assert.deepEqual(rows.map((r) => r.date), ['2026-11-05', '2026-11-04']);
  const [n5, n4] = rows;
  assert.equal(n4.shares_change, 262.5); // 105 x 2.50
  assert.equal(n4.calls, 182);
  assert.equal(n4.total, 444.5);
  assert.equal(n5.shares_change, -157.5);
  assert.ok(n5.puts < 0, 'the put bought that day');
  // A position opened after the day earns nothing from its move then.
  const late = await sessionEarnings({ sessions: 1, now: new Date('2026-11-06T18:00:00Z'), fx: null, historyImpl: hist,
    list: [{ symbol: 'NVDA', status: 'open', shares: 105, opened_on: '2026-11-06' }] });
  assert.equal(late[0].shares_change, 0);
});

test('the market calendar for the page clock: holidays, early closes at 1 p.m.', () => {
  const c = marketCalendar();
  assert.equal(c.zone, 'America/New_York');
  assert.ok(c.holidays.some((h) => h.date === '2026-11-26'));
  assert.deepEqual(c.early_closes.map((e) => e.date), ['2026-11-27', '2026-12-24', '2027-11-26']);
  // An option expiring on an early close stops at 1 p.m. New York (18:00 UTC in November).
  assert.equal(expiryClose('2026-11-27').toISOString(), '2026-11-27T18:00:00.000Z');
  assert.equal(expiryClose('2026-11-20').toISOString(), '2026-11-20T21:00:00.000Z');
});
