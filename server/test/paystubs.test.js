// Paystubs from Ashley's agent: checking a stub, matching its deposit and
// booking it as her wages, the year's analysis (tax outlook, CPP and EI
// maximums), and her next pays in the forecast. Real schema (PGlite).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { normalizeStub, saveStub, paystubSummary, paystubForecastFlows, deductionType, matchAllStubs } from '../lib/paystubs.js';
import { employeeTax } from '../lib/taxRates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => s, 1700: (s) => s };
let db, joint, hers;
const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000));

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const q = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = q;
  pool.connect = async () => ({ query: q, release() {} });
  joint = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('Joint', 'personal', 'personal', 0) RETURNING id`)).id;
  hers = (await one(`INSERT INTO accounts (name, ledger, account_type, opening_balance, segment) VALUES ('Ashley chequing', 'personal', 'personal', 0, 'ashley') RETURNING id`)).id;
});
after(async () => { await db?.close(); });

const deposit = (account, date, amount, description = 'PAYROLL DEP') => one(
  `INSERT INTO transactions (account_id, ledger, date, amount, description, segment) VALUES ($1, 'personal', $2, $3, $4, 'jake') RETURNING id`,
  [account, date, amount, description]);

test('deduction names from an agent map to types', () => {
  assert.equal(deductionType('Federal Income Tax'), 'income_tax');
  assert.equal(deductionType('CPP2'), 'cpp2');
  assert.equal(deductionType('Canada Pension Plan'), 'cpp');
  assert.equal(deductionType('EI Premium'), 'ei');
  assert.equal(deductionType('SHEPP pension'), 'pension');
  assert.equal(deductionType('Group RRSP'), 'rrsp');
  assert.equal(deductionType('Dental'), 'benefits');
  assert.equal(deductionType('Parking'), 'other');
});

test('a stub is checked: required fields, flat deductions, and a warning when it does not add up', () => {
  assert.match(normalizeStub({ pay_date: '2026-10-16', gross: 100, net: 80 }).error, /employer/);
  assert.match(normalizeStub({ employer: 'X', pay_date: '16/10/2026', gross: 100, net: 80 }).error, /pay_date/);
  const ok = normalizeStub({ employer: 'Health Region', pay_date: '2026-10-16', gross: 2000, net: 1500, income_tax: 300, cpp: 110, ei: 32.6, pension: 57.4 });
  assert.equal(ok.stub.owner, 'ashley');
  assert.equal(ok.stub.deductions.length, 4);
  assert.deepEqual(ok.warnings, []);
  const off = normalizeStub({ employer: 'Health Region', pay_date: '2026-10-16', gross: 2000, net: 1500, deductions: [{ label: 'Income tax', amount: 300 }] });
  assert.equal(off.stub.deductions[0].type, 'income_tax');
  assert.equal(off.warnings.length, 1);
});

test('the deposit is found and booked as her wages, preferring her own account', async () => {
  const date = daysAgo(10);
  const inJoint = await deposit(joint, date, 1987.42);
  const inHers = await deposit(hers, daysAgo(9), 1987.42);
  const { stub, warnings } = normalizeStub({ employer: 'Prairie Health', pay_date: date, gross: 2650, net: 1987.42, external_id: 'a1',
    deductions: [{ type: 'income_tax', amount: 351.2 }, { type: 'cpp', amount: 152.85 }, { type: 'ei', amount: 43.2 }, { type: 'pension', amount: 115.33 }] });
  const r = await saveStub(stub, warnings);
  assert.equal(r.matched_transaction_id, inHers.id);
  const t = await one(`SELECT t.ledger, t.segment::text AS segment, c.name AS cat, p.name AS payee FROM transactions t
    LEFT JOIN expense_categories c ON c.id = t.category_id LEFT JOIN payees p ON p.id = t.payee_id WHERE t.id = $1`, [inHers.id]);
  assert.deepEqual(t, { ledger: 'personal', segment: 'ashley', cat: 'Wages & salary', payee: 'Prairie Health' });
  const untouched = await one('SELECT category_id FROM transactions WHERE id = $1', [inJoint.id]);
  assert.equal(untouched.category_id, null);
  // Re-sending the same external_id updates it rather than adding another.
  const again = await saveStub(stub, warnings);
  assert.equal(again.id, r.id);
  assert.equal(again.updated, true);
});

test('a stub whose deposit arrives later is matched on the next pass', async () => {
  const date = daysAgo(24);
  const { stub } = normalizeStub({ employer: 'Prairie Health', pay_date: date, gross: 2650, net: 1990.1, external_id: 'a0',
    income_tax: 351.2, cpp: 152.85, ei: 43.2, pension: 112.65 });
  const r = await saveStub(stub);
  assert.equal(r.matched_transaction_id, null);
  const dep = await deposit(joint, daysAgo(23), 1990.1);
  assert.equal(await matchAllStubs(), 1);
  const s = await one('SELECT transaction_id FROM paystubs WHERE id = $1', [r.id]);
  assert.equal(s.transaction_id, dep.id);
});

test('the year analysis: totals, frequency, tax outlook and CPP/EI maximums', async () => {
  const year = Number(daysAgo(0).slice(0, 4));
  const s = await paystubSummary({ owner: 'ashley', year: Number(daysAgo(10).slice(0, 4)) });
  assert.equal(s.pays_on_file, Number(daysAgo(24).slice(0, 4)) === s.year ? 2 : 1);
  if (s.pays_on_file === 2) {
    assert.equal(s.totals.gross, 5300);
    assert.equal(s.frequency, 'every two weeks');
  }
  assert.ok(['refund', 'owing', 'about even'].includes(s.tax_outlook.result));
  assert.equal(s.cpp.max, 4230.45);
  assert.equal(s.ei.max, 1123.07);
  assert.ok(s.stubs.every((x) => x.matched));
  assert.ok(year >= 2026);
});

test('her next pays go into the forecast at net, with no farm share', async () => {
  const end = iso(new Date(Date.now() + 60 * 86400000));
  const flows = await paystubForecastFlows({ today: daysAgo(0), endStr: end });
  assert.ok(flows.length >= 3);
  assert.ok(flows.every((f) => f.farm === 0 && f.kind === 'estimate_in' && f.ref.owner === 'ashley'));
  assert.equal(flows[0].amount, 1988.76);
  // An estimate already standing in for her pay means none are added.
  await db.query(`INSERT INTO cash_estimates (name, direction, amount, frequency, start_date, segment, status)
    VALUES ('Ashley pay', 'inflow', 1990, 'one_time', $1, 'ashley', 'active')`, [daysAgo(0)]);
  assert.equal((await paystubForecastFlows({ today: daysAgo(0), endStr: end })).length, 0);
});

test('employee tax for 2026: CPP, EI and income tax on a $68,900 salary', () => {
  const t = employeeTax(68900, {}, 2026);
  assert.equal(t.ei, 1123.07);
  assert.equal(t.max.cpp, 4230.45);
  assert.ok(t.cpp > 3500 && t.cpp <= 4230.45);
  assert.ok(t.income_tax > 9000 && t.income_tax < 13000, `income tax ${t.income_tax}`);
  const withPension = employeeTax(68900, { rpp: 3000 }, 2026);
  assert.ok(withPension.income_tax < t.income_tax);
});
