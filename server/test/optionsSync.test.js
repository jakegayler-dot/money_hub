// His brokerage account into the covered-call desk (Jake, Nov 17: "build a way to enter my position ... and I'll have grok bot
// enter them properly"). A bot sends the whole account as it stands; the desk follows it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { readSnapshot, newOptionCash, syncPositions, lastSync } from '../lib/options/desk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let db;
before(async () => {
  db = new PGlite({ parsers: { 1082: (s) => s, 1700: (s) => s } });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
});
after(async () => { await db?.close(); });
const rows = async () => (await db.query(`SELECT symbol, shares, cost, legs, premium_collected, status, source, closed_price FROM options_positions ORDER BY id`)).rows;
const priceOf = async () => 160;

test('a snapshot: stock and option lines, by fields or OCC symbol; short = negative', () => {
  const s = readSnapshot({ as_of: '2026-11-17', account: 'Account 9', positions: [
    { symbol: 'NVDA', quantity: 100, avg_cost: 180 },
    { symbol: 'NVDA', quantity: 100, avg_cost: 150 },
    { kind: 'option', underlying: 'NVDA', type: 'call', strike: 167.5, expiry: '2026-11-18', quantity: -2, avg_price: 1.82 },
    { occ: 'NVDA 261231P00140000', quantity: 1, avg_price: 6.65 },
  ] });
  assert.deepEqual(s.errors, []);
  const g = s.groups.get('NVDA');
  assert.equal(g.shares, 200);
  assert.equal(g.cost, 165);
  assert.deepEqual(g.legs, [
    { type: 'call', side: 'short', strike: 167.5, expiry: '2026-11-18', premium: 1.82, contracts: 2 },
    { type: 'put', side: 'long', strike: 140, expiry: '2026-12-31', premium: 6.65, contracts: 1 },
  ]);
  const bad = readSnapshot({ positions: [{ symbol: 'NVDA', quantity: 100 }, { kind: 'option', underlying: 'NVDA', strike: 160, expiry: '2026-11-18', quantity: -1, avg_price: 1 }] });
  assert.match(bad.errors[0], /positions\[0\]: avg_cost/);
  assert.match(bad.errors[1], /positions\[1\]: type/);
  assert.match(readSnapshot({}).errors[0], /positions/);
});

test('option cash: what was opened since last time, sold +, bought −', () => {
  const call = { type: 'call', side: 'short', strike: 167.5, expiry: '2026-11-18', premium: 1.82, contracts: 1 };
  const put = { type: 'put', side: 'long', strike: 140, expiry: '2026-12-31', premium: 6.65, contracts: 1 };
  assert.equal(newOptionCash([], [call, put]), 182 - 665);
  assert.equal(newOptionCash([call, put], [call, put]), 0, 'nothing new');
  assert.equal(newOptionCash([call, put], [{ ...call, expiry: '2026-11-20', premium: 1.5 }, put]), 150, 'rolled to Friday');
  assert.equal(newOptionCash([call], [{ ...call, contracts: 3 }]), 364, 'two more sold');
});

test('the account follows each snapshot; what he entered by hand is left alone; a stock sold is closed', async () => {
  await db.query(`INSERT INTO options_positions (symbol, shares, cost, legs, status) VALUES ('TSLA', 100, 380, '[]', 'open')`);
  const call = { kind: 'option', underlying: 'NVDA', type: 'call', strike: 167.5, expiry: '2026-11-18', quantity: -1, avg_price: 1.82 };
  const now = new Date('2026-11-17T15:00:00Z');
  const first = await syncPositions({ as_of: '2026-11-17', account: 'Account 9', by: 'Data Entry', positions: [{ symbol: 'NVDA', quantity: 100, avg_cost: 153.9 }, call] }, { now, priceOf });
  assert.deepEqual(first.added, ['NVDA']);
  let r = await rows();
  assert.equal(r.length, 2);
  const nv = r.find((x) => x.symbol === 'NVDA');
  assert.equal(nv.source, 'broker');
  assert.equal(Number(nv.premium_collected), 182);
  assert.equal(nv.legs[0].side, 'short');

  // Next day: Wednesday's call expired, Friday's sold.
  await syncPositions({ as_of: '2026-11-19', positions: [{ symbol: 'NVDA', quantity: 100, avg_cost: 153.9 }, { ...call, expiry: '2026-11-20', avg_price: 1.6 }] }, { now, priceOf });
  r = await rows();
  assert.equal(Number(r.find((x) => x.symbol === 'NVDA').premium_collected), 342);

  // His own total wins when the bot sends it.
  await syncPositions({ positions: [{ symbol: 'NVDA', quantity: 100, avg_cost: 153.9 }], premium_collected: { NVDA: 900 } }, { now, priceOf });
  r = await rows();
  assert.equal(Number(r.find((x) => x.symbol === 'NVDA').premium_collected), 900);
  assert.deepEqual(r.find((x) => x.symbol === 'NVDA').legs, []);

  // Sold: closed at the price then; TSLA (his own entry) untouched.
  await assert.rejects(syncPositions({ positions: [] }, { now, priceOf }), /confirm_empty/);
  const out = await syncPositions({ positions: [], confirm_empty: true }, { now, priceOf });
  assert.deepEqual(out.closed, ['NVDA']);
  r = await rows();
  assert.equal(r.find((x) => x.symbol === 'NVDA').status, 'closed');
  assert.equal(Number(r.find((x) => x.symbol === 'NVDA').closed_price), 160);
  assert.equal(r.find((x) => x.symbol === 'TSLA').status, 'open');
  assert.equal((await lastSync()).by, null);

  // A broken line saves nothing.
  await assert.rejects(syncPositions({ positions: [{ symbol: 'NVDA', quantity: 100 }] }, { now, priceOf }), /Nothing saved.*avg_cost/);
});
