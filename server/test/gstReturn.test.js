// The GST return (Nov 15: "a gst return system that compiles all eligible expenses, flags if there is no receipt,
// automatically determines the required data points for the gst return for each quarter").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { gstReturn, guessTreatment, cleanGstNumber, claimOf } from '../lib/gstReturn.js';
import { gstReport } from '../lib/tax.js';
import { attachReceipt } from '../lib/receipts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, q, ops, joint;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const Y = new Date().getFullYear() - 1;
const Q1 = `${Y}-01-01`;
const Q2 = `${Y}-04-01`;
const Q3 = `${Y}-07-01`;
const cat = {};
const tx = {};

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  ops = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Ops', 'business', 'operating', 0, 'grain') RETURNING id`)).id;
  joint = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Joint', 'personal', 'personal', 0, 'jake') RETURNING id`)).id;
  for (const n of ['Fuel & oil', 'Repairs & maintenance', 'Seed', 'Insurance', 'Meals']) {
    cat[n] = (await one(`INSERT INTO expense_categories (name, class, ledger, kind) VALUES ($1, 'variable_seasonal', 'business', 'expense') RETURNING id`, [n])).id;
  }
  for (const n of ['Canola sales', 'Custom work income', 'AgriStability']) cat[n] = (await one('SELECT id FROM expense_categories WHERE name = $1', [n])).id;

  const add = async (key, { date = `${Y}-02-10`, amount, category = null, gst = null, account = ops, segment = 'grain', payee = null, split = null }) => {
    const p = payee ? (await one(`INSERT INTO payees (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id`, [payee]))?.id : null;
    tx[key] = (await one(
      `INSERT INTO transactions (account_id, ledger, date, amount, description, category_id, segment, gst_amount, payee_id,
                                 is_segment_split, segment_grain_pct, segment_jake_pct)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [account, account === ops ? 'business' : 'personal', date, amount, key, category, split ? null : segment, gst, p,
        !!split, split ? split[0] : null, split ? split[1] : null])).id;
  };
  const receipt = (key, extracted = {}) => one(
    `INSERT INTO receipts (mime, bytes, image, status, transaction_id, extracted) VALUES ('image/jpeg', 1, '\\x00', 'matched', $1, $2) RETURNING id`,
    [tx[key], extracted]);

  await add('fuel', { amount: -1050, category: cat['Fuel & oil'], gst: 50, payee: 'Co-op' });
  await receipt('fuel', { total: 1050, gst: 50, gst_number: '123456789 RT0001' });
  await add('repairs', { amount: -210, category: cat['Repairs & maintenance'] });                 // taxable, no GST, no receipt
  await add('seed', { amount: -5000, category: cat.Seed });                                        // zero-rated (guessed)
  await add('insurance', { amount: -800, category: cat.Insurance });                               // exempt (guessed)
  await add('shared', { amount: -105, category: cat['Repairs & maintenance'], gst: 5, split: [60, 40] }); // 60% farm
  await receipt('shared', { total: 105, gst: 5 });
  await add('meals', { amount: -52.5, category: cat.Meals, gst: 2.5 });                            // half the credit
  await receipt('meals', { total: 52.5, gst: 2.5 });
  await add('unknown', { amount: -100 });                                                          // no category
  await add('parts', { amount: -525, category: cat['Repairs & maintenance'], gst: 25 });           // GST, no receipt
  await add('household', { amount: -300, category: cat['Fuel & oil'], gst: 14.29, account: joint, segment: 'jake' });
  await add('belts', { amount: -315, category: cat['Repairs & maintenance'], gst: 15, payee: 'Parts Plus' });
  await receipt('belts', { total: 315, gst: 15, gst_number: null });                               // read, no number on it
  await add('canola', { amount: 20000, category: cat['Canola sales'] });
  await add('custom', { amount: 1050, category: cat['Custom work income'], gst: 50 });
  await add('program', { amount: 3000, category: cat.AgriStability });
  await add('later', { date: `${Y}-05-03`, amount: -210, category: cat['Fuel & oil'], gst: 10 });
});
after(async () => { await db?.close(); });

const entry = (r, key) => r.expenses.find((e) => e.transaction_id === tx[key]);

test('guesses and GST numbers', () => {
  assert.equal(guessTreatment('Seed'), 'zero_rated');
  assert.equal(guessTreatment('Fertilizer', 'Crop inputs'), 'zero_rated');
  assert.equal(guessTreatment('Crop insurance premiums'), 'exempt');
  assert.equal(guessTreatment('Interest', 'Bank charges'), 'exempt');
  assert.equal(guessTreatment('Land rent'), 'exempt');
  assert.equal(guessTreatment('Fuel & oil'), null);
  assert.equal(guessTreatment('Meals'), 'taxable');
  assert.equal(cleanGstNumber('GST# 12345 6789 RT 0001'), '123456789 RT0001');
  assert.equal(cleanGstNumber('123456789'), '123456789');
  assert.equal(cleanGstNumber('n/a'), null);
});

test('a quarter: every farm purchase sorted, the credits, the flags and the GST34 lines', async () => {
  const r = await gstReturn(Q1);
  assert.equal(r.period.label, `Q1 ${Y}`);
  assert.equal(r.period.due, `${Y}-04-30`);
  assert.ok(!r.expenses.some((e) => e.transaction_id === tx.household), "the household's own isn't on it");

  assert.deepEqual([entry(r, 'fuel').treatment, entry(r, 'fuel').itc, entry(r, 'fuel').flags], ['taxable', 50, []]);
  assert.equal(entry(r, 'fuel').receipt.gst_number, '123456789 RT0001');
  const rep = entry(r, 'repairs');
  assert.deepEqual([rep.treatment, rep.itc, rep.itc_up_to, rep.flags], ['taxable', 0, 10, ['no_receipt_gst_unknown']]);
  assert.deepEqual([entry(r, 'seed').treatment, entry(r, 'seed').treatment_source, entry(r, 'seed').flags], ['zero_rated', 'guess', []]);
  assert.deepEqual([entry(r, 'insurance').treatment, entry(r, 'insurance').flags], ['exempt', []]);
  assert.deepEqual([entry(r, 'shared').farm_amount, entry(r, 'shared').farm_share, entry(r, 'shared').itc], [-63, 60, 3]);
  assert.deepEqual([entry(r, 'meals').half_itc, entry(r, 'meals').itc], [true, 1.25]);
  assert.deepEqual(entry(r, 'unknown').flags, ['no_receipt_gst_unknown', 'check_treatment']);
  assert.deepEqual([entry(r, 'parts').itc, entry(r, 'parts').flags], [25, ['no_receipt']]);
  assert.deepEqual(entry(r, 'belts').flags, ['no_gst_number'], 'from $100 the supplier GST number must be on it');
  assert.match(entry(r, 'parts').receipt_rules, /From \$500/);

  // Sales: canola and custom work are line 90, the program payment line 91.
  assert.deepEqual(r.lines, {
    90: 21000, 91: 3000, 101: 24000, 103: 50, 104: 0, 105: 50, 106: 94.25, 107: 0, 108: 94.25, 109: -44.25,
    110: 0, 111: 0, 112: 0, '113A': -44.25, 205: 0, 405: 0, '113B': 0, '113C': -44.25, 114: 44.25, 115: 0,
  });
  assert.deepEqual(r.flags.no_receipt, { count: 1, itc: 25 });
  assert.deepEqual([r.flags.gst_missing.count, r.flags.gst_missing.itc_up_to], [2, 14.76]);
  assert.equal(r.flags.check_treatment, 1);
  assert.equal(r.flags.no_gst_number, 1);
  assert.equal(r.ready, false);
  assert.equal(r.period.status, 'overdue');

  // The Tax page's summary is the same return.
  const y = await gstReport(Y);
  const p = y.periods.find((x) => x.start === Q1);
  assert.deepEqual([p.collected, p.itc, p.net, p.purchases_no_gst, p.no_receipt], [50, 94.25, -44.25, 2, 1]);
});

test('Jake sets how GST applies: on an entry, or once for a category', async () => {
  await q(`UPDATE transactions SET gst_treatment = 'exempt' WHERE id = $1`, [tx.unknown]);
  await q(`UPDATE expense_categories SET gst_treatment = 'taxable' WHERE id = $1`, [cat.Seed]);
  let r = await gstReturn(Q1);
  assert.deepEqual([entry(r, 'unknown').treatment, entry(r, 'unknown').flags], ['exempt', []]);
  assert.deepEqual([entry(r, 'seed').treatment_source, entry(r, 'seed').flags], ['category', ['no_receipt_gst_unknown']]);
  await q(`UPDATE expense_categories SET gst_treatment = NULL WHERE id = $1`, [cat.Seed]);
  r = await gstReturn(Q1);
  assert.equal(entry(r, 'seed').treatment, 'zero_rated');
});

test("a receipt's GST number is kept on the supplier", async () => {
  await q(`UPDATE transactions SET gst_amount = NULL WHERE id = $1`, [tx.repairs]);
  const { id } = await one(`INSERT INTO receipts (mime, bytes, image, status, extracted) VALUES ('image/jpeg', 1, '\\x00', 'unmatched', $1) RETURNING id`,
    [{ is_receipt: true, doc_type: 'receipt', total: 210, gst: 10, party: 'Valley Repair', gst_number: '98765 4321 RT0001' }]);
  await attachReceipt(id, tx.repairs);
  const t = await one('SELECT t.gst_amount, p.gst_number FROM transactions t JOIN payees p ON p.id = t.payee_id WHERE t.id = $1', [tx.repairs]);
  assert.deepEqual([Number(t.gst_amount), t.gst_number], [10, '987654321 RT0001']);
  const r = await gstReturn(Q1);
  assert.deepEqual([entry(r, 'repairs').itc, entry(r, 'repairs').flags], [10, []]);
  // Back as it was, for the filing test.
  await q('DELETE FROM receipts WHERE id = $1', [id]);
  await q('UPDATE transactions SET gst_amount = NULL WHERE id = $1', [tx.repairs]);
});

test('filed: what it claimed is kept; a receipt read later goes on the next return, a credit taken back on line 104, never twice', async () => {
  const r1 = await gstReturn(Q1);
  await q(`INSERT INTO gst_returns (period_start, period_end, filed_on, net_amount, lines, claimed, carried) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [Q1, `${Y}-03-31`, `${Y}-04-20`, r1.lines[109], JSON.stringify(r1.lines), JSON.stringify(claimOf(r1)), JSON.stringify(r1.carried)]);
  assert.equal(claimOf(r1)[tx.fuel], 50);

  // After filing: the repairs receipt is read (GST $10), and the fuel turns out to be the household's.
  await q('UPDATE transactions SET gst_amount = 10 WHERE id = $1', [tx.repairs]);
  await q(`UPDATE transactions SET segment = 'jake' WHERE id = $1`, [tx.fuel]);
  const filedQ1 = await gstReturn(Q1);
  assert.equal(filedQ1.period.status, 'filed');
  assert.deepEqual(filedQ1.carried, []);

  const r2 = await gstReturn(Q2);
  assert.deepEqual(r2.carried.map((c) => [c.transaction_id, c.itc]).sort(), [[tx.fuel, -50], [tx.repairs, 10]].sort());
  assert.equal(r2.lines[104], 50, 'the credit taken back');
  assert.equal(r2.lines[106], 20, "Q2's own fuel $10 and Q1's repairs $10");
  assert.equal(r2.lines[109], 30);

  // Q3 before Q2 is filed: nothing carried there (Q2 takes it).
  assert.deepEqual((await gstReturn(Q3)).carried, []);
  // Q2 filed with what it carried: Q3 carries nothing again.
  await q(`INSERT INTO gst_returns (period_start, period_end, filed_on, net_amount, lines, claimed, carried) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [Q2, `${Y}-06-30`, `${Y}-07-15`, r2.lines[109], JSON.stringify(r2.lines), JSON.stringify(claimOf(r2)), JSON.stringify(r2.carried)]);
  assert.deepEqual((await gstReturn(Q3)).carried, []);
  // And a filed Q2 still shows what it carried.
  assert.equal((await gstReturn(Q2)).lines[104], 50);
});
