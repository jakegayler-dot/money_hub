// A bill can be paid from a credit card (Jake, Nov 8: "On moneyhub you haven't given an option to pay from credit card
// accounts"): Due this week and the Bills page list the cards, and a bill paid that way is a charge on the card.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import calendarRoute from '../routes/calendar.js';
import billsRoute from '../routes/bills.js';
import cardsRoute from '../routes/credit-cards.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, server, base, card, bank;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  bank = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('RBC Personal - Jake', 'personal', 'operating', 0) RETURNING id`)).id;
  card = (await one(`INSERT INTO credit_cards (name, last4, apr_purchase, segment) VALUES ('Ashley Visa', '4411', 20.99, 'ashley') RETURNING id`)).id;
  const app = express();
  app.use(express.json());
  app.use('/api/calendar', calendarRoute);
  app.use('/api/bills', billsRoute);
  app.use('/api/credit-cards', cardsRoute);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await db?.close(); });

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const bill = async (name) => (await one(`INSERT INTO bills (name, ledger, amount, frequency, due_date, segment) VALUES ($1, 'personal', 31.08, 'monthly', CURRENT_DATE, 'ashley') RETURNING id`, [name])).id;

test('the cards are offered, and a bill paid from one is a charge on that card', async () => {
  const list = await (await fetch(`${base}/api/credit-cards/list`)).json();
  assert.deepEqual(list.map((c) => c.name), ['Ashley Visa']);
  const week = await (await fetch(`${base}/api/calendar/week`)).json();
  assert.deepEqual(week.cards.map((c) => c.name), ['Ashley Visa']);

  const a = await bill('Anthropic Claude (Ashley Visa)');
  const r = await post('/api/calendar/week/pay', { type: 'bill', id: a, credit_card_id: card });
  assert.equal(r.status, 200, await r.text());
  const tx = await one(`SELECT t.account_id, t.credit_card_id, t.amount FROM bills b JOIN transactions t ON t.id = b.linked_transaction_id WHERE b.id = $1`, [a]);
  assert.deepEqual([tx.account_id, tx.credit_card_id, Number(tx.amount)], [null, card, -31.08]);

  const b2 = await bill('Starlink');
  assert.equal((await post(`/api/bills/${b2}/pay`, { credit_card_id: card })).status, 200);
  assert.equal((await one(`SELECT t.credit_card_id FROM bills b JOIN transactions t ON t.id = b.linked_transaction_id WHERE b.id = $1`, [b2])).credit_card_id, card);

  const b3 = await bill('Hydro');
  assert.equal((await post(`/api/bills/${b3}/pay`, { account_id: bank })).status, 200, 'a bank account as before');
  assert.equal((await post('/api/calendar/week/pay', { type: 'loan', id: 1, credit_card_id: card })).status, 400, 'only a bill goes on a card');
});
