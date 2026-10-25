// Credit card points (Oct 24): balance from the latest reported balance plus
// moves after it, statement points not counted twice, spending turned into
// points at the card's earn rates, redemptions valued as savings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { balanceOf, rateFor, pointsPerDollar, signedPoints, pointsSummary, addEntry, recordStatementPoints } from '../lib/points.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, card, groceries, grocSub, fuel;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  groceries = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Groceries', 'variable_seasonal', 'personal', 'expense') RETURNING id`)).id;
  grocSub = (await one(`INSERT INTO expense_categories (name, class, ledger, kind, parent_id) VALUES ('Costco food', 'variable_seasonal', 'personal', 'expense', $1) RETURNING id`, [groceries])).id;
  fuel = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Gasoline', 'variable_seasonal', 'personal', 'expense') RETURNING id`)).id;
  card = (await one(`INSERT INTO credit_cards (name, issuer, last4, apr_purchase, segment, ledger_start_date, ledger_opening_balance)
    VALUES ('Jake Aeroplan Visa', 'TD', '1111', 20.99, 'jake', '2026-01-01', 0) RETURNING *`));
  await db.query(`INSERT INTO credit_card_reward_categories (credit_card_id, category, rate_pct, points_per_dollar) VALUES
    ($1, 'Groceries', 0, 1.5), ($1, 'Everything else', 0, 1)`, [card.id]);
});
after(async () => { await db?.close(); });

const e = (id, date, kind, points, extra = {}) => ({ id, date, kind, points, ...extra });

test('balance is the latest reported balance plus the moves after it', () => {
  const b = balanceOf([
    e(1, '2026-01-10', 'earned', 500),
    e(2, '2026-02-01', 'balance', 10000),
    e(3, '2026-03-01', 'earned', 800),
    e(4, '2026-03-05', 'redeemed', -2000),
  ]);
  assert.equal(b.balance, 8800);
  assert.equal(b.snapshot.points, 10000);
  assert.equal(b.since_snapshot, -1200);
});

test('a statement\'s own earned line is not added on top of its balance, whatever order it arrived in', () => {
  const b = balanceOf([
    e(1, '2026-03-31', 'balance', 12000, { source: 'statement', credit_card_id: 7 }),
    e(2, '2026-03-31', 'earned', 900, { source: 'statement', credit_card_id: 7 }),
    e(3, '2026-03-31', 'redeemed', -1000, { source: 'hand' }),
  ]);
  assert.equal(b.balance, 11000);
});

test('redemptions and expiries always subtract', () => {
  assert.equal(signedPoints('redeemed', 500), -500);
  assert.equal(signedPoints('expired', -500), -500);
  assert.equal(signedPoints('earned', 500), 500);
  assert.equal(signedPoints('adjusted', -40), -40);
});

test('earn rates match the category, then its parent, then the base rate', () => {
  const rewards = [{ category: 'Groceries', rate_pct: 3 }, { category: 'Gas', rate_pct: 2 }, { category: 'Everything else', rate_pct: 1 }];
  assert.equal(rateFor(rewards, 'Costco food', 'Groceries').category, 'Groceries');
  assert.equal(rateFor(rewards, 'Restaurants', null).category, 'Everything else');
  // "Gas" is too short to match by containment: it would catch "Gas & propane" or "Natural gas" wrongly.
  assert.equal(rateFor(rewards, 'Gasoline', null).category, 'Everything else');
  assert.equal(rateFor([{ category: 'Grocery', rate_pct: 3 }], 'Groceries', null).category, 'Grocery');
  assert.equal(rateFor([{ category: 'Groceries', rate_pct: 3 }], 'Fuel', null), null);
});

test('a % back rate becomes points at the program\'s value per point', () => {
  assert.equal(pointsPerDollar({ rate_pct: 2 }, { unit: 'points', cents_per_point: 1 }), 2);
  assert.equal(pointsPerDollar({ rate_pct: 2 }, { unit: 'points', cents_per_point: 2 }), 1);
  assert.equal(pointsPerDollar({ rate_pct: 2 }, { unit: 'dollars' }), 0.02);
  assert.equal(pointsPerDollar({ rate_pct: 0, points_per_dollar: 1.5 }, { unit: 'points', cents_per_point: 2 }), 1.5);
});

test('statement points create the program, record at period end, and replace on re-send', async () => {
  const stmt = { period_end: '2026-09-30', points_program: 'Aeroplan', points_earned: 1200, points_balance: 41200 };
  const r = await recordStatementPoints(pool, card, stmt);
  assert.equal(r.earned, 1200);
  await recordStatementPoints(pool, card, { ...stmt, points_earned: 1250, points_balance: 41250 });
  const { rows } = await db.query('SELECT kind, points FROM points_entries WHERE program_id = $1 ORDER BY kind', [r.program_id]);
  assert.deepEqual(rows.map((x) => [x.kind, Number(x.points)]), [['balance', 41250], ['earned', 1250]]);
  const linked = await one('SELECT points_program_id FROM credit_cards WHERE id = $1', [card.id]);
  assert.equal(linked.points_program_id, r.program_id);
  const p = await one('SELECT owner FROM points_programs WHERE id = $1', [r.program_id]);
  assert.equal(p.owner, 'jake');
  assert.equal(await recordStatementPoints(pool, card, { period_end: '2026-09-30' }), null);
});

test('summary: balance, value, points on the way since the statement, this year by category, savings', async () => {
  const { id: prog } = await one('SELECT id FROM points_programs WHERE name = $1', ['Aeroplan']);
  await db.query('UPDATE points_programs SET cents_per_point = 2 WHERE id = $1', [prog]);
  const tx = (date, amount, cat) => db.query(
    `INSERT INTO transactions (credit_card_id, ledger, date, amount, description, category_id, segment) VALUES ($1, 'personal', $2, $3, 'x', $4, 'jake')`,
    [card.id, date, amount, cat]);
  await tx('2026-09-12', -200, grocSub); // before the statement: in its points already
  await tx('2026-10-05', -100, grocSub); // after: 150 pts on the way
  await tx('2026-10-06', -50, fuel);     // after: 50 pts at the base rate
  await tx('2026-10-07', 20, grocSub);   // a refund takes 30 back
  await addEntry(pool, prog, { kind: 'redeemed', date: '2026-10-10', points: 25000, value: 600, redeemed_for: 'travel' });

  const s = await pointsSummary({ today: '2026-10-24' });
  const p = s.programs.find((x) => x.id === prog);
  assert.equal(p.balance, 41250 - 25000);
  assert.equal(p.value, 325);
  assert.equal(p.pending.points, 150 + 50 - 30);
  assert.equal(p.pending.spending, 130);
  assert.equal(p.year.spending, 330);
  assert.equal(p.year.earned_estimate, 300 + 150 + 50 - 30);
  const groc = p.year.by_category.find((x) => x.category === 'Groceries');
  assert.equal(groc.points, 420);
  assert.equal(p.year.saved, 600);
  assert.equal(p.year.redeemed, 25000);
  assert.equal(s.totals.value, 325);
  assert.equal(s.totals.saved_this_year, 600);
});

test('a redemption with no value entered is worth the program\'s value per point', async () => {
  const { id: prog } = await one('SELECT id FROM points_programs WHERE name = $1', ['Aeroplan']);
  await addEntry(pool, prog, { kind: 'redeemed', date: '2026-10-20', points: 1000 });
  const s = await pointsSummary({ today: '2026-10-24' });
  assert.equal(s.programs.find((x) => x.id === prog).year.saved, 620);
});

test('bad entries are refused', async () => {
  const { id: prog } = await one('SELECT id FROM points_programs WHERE name = $1', ['Aeroplan']);
  await assert.rejects(addEntry(pool, prog, { kind: 'spent', points: 5 }), /kind must be/);
  await assert.rejects(addEntry(pool, prog, { kind: 'earned' }), /points is required/);
  await assert.rejects(addEntry(pool, prog, { kind: 'earned', points: 5, date: '10/24/2026' }), /YYYY-MM-DD/);
});
