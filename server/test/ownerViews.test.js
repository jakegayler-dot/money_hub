// One owner's cash flow (Oct 24): Ashley's view starts from her own
// accounts, carries what's tagged to her and her share of household
// spending by who actually spends it — and leaves out what the farm pays
// for her (her card paid from the farm account).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { shareFor, ownersOf, ownerSplits, windowFor, evaluate } from '../lib/forecast.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const TODAY = '2026-10-24';

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
});
after(async () => { await db?.close(); });

test('shares: farm and personal by farm share; one owner by its tags; farm-paid stays out of Jake and Ashley', () => {
  const bill = { farm: 0, owners: { grain: 0, livestock: 0, jake: 0, ashley: 1 } };
  assert.equal(shareFor('ashley', bill), 1);
  assert.equal(shareFor('jake', bill), 0);
  assert.equal(shareFor('personal', bill), 1);
  const card = { ...bill, ref: { paid_from_farm: true } };
  assert.equal(shareFor('ashley', card), 0);
  assert.equal(shareFor('personal', card), 1);
  assert.equal(shareFor('everything', card), 1);
  const split = ownersOf({ is_segment_split: true, segment_grain_pct: 60, segment_livestock_pct: 40 });
  assert.equal(shareFor('grain', { farm: 1, owners: split }), 0.6);
  // A farm-wide flow with no tags splits by the enterprise split.
  assert.equal(shareFor('livestock', { farm: 1 }, { farm: { grain: 0.7, livestock: 0.3 }, household: { jake: 0.5, ashley: 0.5, farm: 0 } }), 0.3);
});

test('household split: by who spends it, with what the farm account pays kept apart', async () => {
  const farmAcct = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('RBC Farm', 'business', 'operating', 50000, 'grain') RETURNING id`)).id;
  const hers = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Ashley RBC', 'personal', 'personal', 3000, 'ashley') RETURNING id`)).id;
  const his = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Jake RBC', 'personal', 'personal', 1000, 'jake') RETURNING id`)).id;
  const tx = (acct, amount, segment, ledger = 'personal') => db.query(
    `INSERT INTO transactions (account_id, ledger, date, amount, description, segment) VALUES ($1, $2, '2026-09-10', $3, 'x', $4)`, [acct, ledger, amount, segment]);
  await tx(hers, -600, 'ashley');
  await tx(his, -200, 'jake');
  await tx(farmAcct, -200, 'ashley'); // the farm paying for her: farm-funded
  await tx(farmAcct, -3000, 'grain', 'business');
  await tx(farmAcct, -1000, 'livestock', 'business');
  const s = await ownerSplits(TODAY);
  assert.equal(Math.round(s.household.ashley * 100), 60);
  assert.equal(Math.round(s.household.jake * 100), 20);
  assert.equal(Math.round(s.household.farm * 100), 20);
  assert.equal(Math.round(s.farm.grain * 100), 75);

  // Her view: her account's cash, her bill, 60% of household spending, not the farm-paid card.
  const splits = s;
  const accounts = [
    { id: farmAcct, balance: 50000, farm: 1, owners: ownersOf({ segment: 'grain' }, splits) },
    { id: hers, balance: 3000, farm: 0, owners: ownersOf({ segment: 'ashley' }, splits) },
    { id: his, balance: 1000, farm: 0, owners: ownersOf({ segment: 'jake' }, splits) },
  ];
  const f = (kind, amount, extra = {}) => ({ key: `${kind}${amount}`, kind, label: kind, date: '2026-11-15', amount, taxable: 0, estimate: false, ref: {}, ...extra });
  const flows = [
    f('bill', -100, { farm: 0, owners: ownersOf({ segment: 'ashley' }, splits) }),
    f('card', -1731.94, { farm: 0, owners: ownersOf({ segment: 'ashley' }, splits), ref: { paid_from_farm: true } }),
    f('personal', -1000, { farm: 0, ref: { bucket: 'essential' } }),
    f('estimate_in', 1500, { farm: 0, owners: ownersOf({ segment: 'ashley' }, splits), ref: { paystub: true, owner: 'ashley' } }),
    f('contract', 20000, { farm: 1, owners: ownersOf({ segment: 'grain' }, splits) }),
  ];
  const ctx = { win: windowFor(12, TODAY), today: TODAY, flows, lookahead: [], accounts, splits, floorDays: 60 };
  const ev = evaluate(flows, ctx, { scope: 'ashley' });
  assert.equal(ev.opening, 3000);
  const nov = ev.trajectory[1];
  assert.deepEqual(nov.items.map((x) => [x.kind, x.amount]).sort(), [['bill', -100], ['estimate_in', 1500], ['personal', -600]].sort());
  // Everything is unchanged: every flow in full.
  const all = evaluate(flows, ctx, { scope: 'everything' });
  assert.equal(all.trajectory[1].items.length, 5);
});
