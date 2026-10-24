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
import { normalizeStub, saveStub, paystubSummary, paystubForecastFlows, deductionType, matchAllStubs, holdbackPlan, estimateStubs, setLabelType } from '../lib/paystubs.js';
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

test("an uploaded paystub is read and filed like the agent's (Oct 24: her agent works at a computer, so it adds stubs on the page)", async () => {
  const { fileUploadedPaystub } = await import('../lib/paystubRead.js');
  const pay = daysAgo(1);
  await deposit(hers, pay, 1404.18);
  const reply = (input) => async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'record_paystub', input }] });
  const read = { is_paystub: true, employer: 'Melfort Union Hospital', pay_date: pay, period_start: daysAgo(15), period_end: daysAgo(2), gross: 1900,
    net: 1404.18, deductions: [{ type: 'income_tax', label: 'Federal tax', amount: 210.5 }, { type: 'income_tax', label: 'Provincial tax', amount: 120.1 },
      { type: 'cpp', label: 'CPP', amount: 107.4 }, { type: 'ei', label: 'EI', amount: 31.16 }, { type: 'pension', label: 'SHEPP', amount: 26.66 }], ytd: null };
  const pdf = { bytes: Buffer.from('%PDF-1.4 stub'), mime: 'application/pdf' };
  const r = await fileUploadedPaystub({ ...pdf, owner: 'ashley' }, { send: reply(read) });
  assert.equal(r.matched_deposit, true);
  assert.deepEqual(r.warnings, []);
  const row = await one('SELECT source, doc_mime, transaction_id FROM paystubs WHERE id = $1', [r.id]);
  assert.equal(row.source, 'upload');
  assert.equal(row.doc_mime, 'application/pdf');
  assert.ok(row.transaction_id);
  // The same stub added again updates it.
  assert.equal((await fileUploadedPaystub({ ...pdf, owner: 'ashley' }, { send: reply(read) })).updated, true);
  // Not a paystub, or no net pay readable: refused with a reason, nothing filed.
  await assert.rejects(fileUploadedPaystub({ ...pdf, owner: 'ashley' }, { send: reply({ is_paystub: false, notes: 'a grocery receipt' }) }),
    (e) => e.status === 422 && /grocery receipt/.test(e.message));
  await assert.rejects(fileUploadedPaystub({ ...pdf, owner: 'ashley' }, { send: reply({ ...read, net: null }) }), (e) => e.status === 422 && /net/.test(e.message));
});

// Summer holdback (Oct 24): paid ten months; pay held back September to June
// is paid out half in July and half in August. Jake's stubs here, with fixed
// dates, so they don't mix with the tests above.
const fileStub = (pay_date, extra = {}) => {
  const { stub, warnings, error } = normalizeStub({ owner: 'jake', employer: 'North East School Division', pay_date, gross: 2000, net: 1450,
    deductions: [{ type: 'income_tax', amount: 250 }, { label: 'Summer holdback', amount: 300 }], ...extra });
  assert.equal(error, undefined);
  return saveStub(stub, warnings);
};
const biweekly = (from, to) => { const out = []; for (let d = from; d <= to; d = iso(new Date(Date.parse(d) + 14 * 86400000))) out.push(d); return out; };

test('holdback: names map to it, and a summer stub with no gross is a payout', () => {
  assert.equal(deductionType('Summer holdback'), 'holdback');
  assert.equal(deductionType('Deferred salary 10/12'), 'holdback');
  const pay = normalizeStub({ employer: 'NESD', pay_date: '2026-07-24', net: 3300 });
  assert.equal(pay.error, undefined);
  assert.equal(pay.stub.holdback_paid, 3300);
  assert.deepEqual(pay.warnings, []);
  assert.match(normalizeStub({ employer: 'NESD', pay_date: '2026-03-13', net: 3300 }).error, /gross/);
});

test('holdback: saved through June, half paid in July and half in August, and no regular summer pays', async () => {
  for (const d of biweekly('2025-09-05', '2026-04-17')) await fileStub(d);
  const plan = await holdbackPlan('jake', 2026, { today: '2026-05-01' });
  assert.equal(plan.saved, 5100); // 17 pays
  assert.equal(plan.pays_to_come, 5); // May 1 to June 26
  assert.equal(plan.projected_by_june, 6600);
  assert.deepEqual(plan.payouts, [{ month: '2026-07', date: '2026-07-24', amount: 3300 }, { month: '2026-08', date: '2026-08-21', amount: 3300 }]);

  const flows = (await paystubForecastFlows({ today: '2026-05-01', endStr: '2026-10-01' })).filter((f) => f.ref.owner === 'jake');
  const regular = flows.filter((f) => !f.ref.holdback).map((f) => f.date);
  assert.deepEqual(regular, ['2026-05-01', '2026-05-15', '2026-05-29', '2026-06-12', '2026-06-26', '2026-09-04', '2026-09-18']);
  assert.ok(flows.filter((f) => !f.ref.holdback).every((f) => f.amount === 1450));
  assert.deepEqual(flows.filter((f) => f.ref.holdback).map((f) => [f.date, f.amount]), [['2026-07-24', 3300], ['2026-08-21', 3300]]);
});

test('holdback: after the July payout, August is what is left; the summer gap is not her pay stopping', async () => {
  for (const d of biweekly('2026-05-01', '2026-06-26')) await fileStub(d);
  await fileStub('2026-07-24', { gross: 0, net: 3300, deductions: [] });
  const plan = await holdbackPlan('jake', 2026, { today: '2026-08-10' });
  assert.equal(plan.saved, 6600);
  assert.equal(plan.paid_out, 3300);
  assert.equal(plan.balance, 3300);
  assert.deepEqual(plan.payouts.map((p) => [p.month, p.amount]), [['2026-08', 3300]]);

  const flows = (await paystubForecastFlows({ today: '2026-08-10', endStr: '2026-10-01' })).filter((f) => f.ref.owner === 'jake');
  assert.deepEqual(flows.map((f) => [f.date, f.amount, !!f.ref.holdback]),
    [['2026-09-04', 1450, false], ['2026-09-18', 1450, false], ['2026-08-21', 3300, true]]);

  const s = await paystubSummary({ owner: 'jake', year: 2026, today: '2026-08-10' });
  assert.equal(s.holdback.summer, 2026);
  assert.equal(s.holdback.balance, 3300);
  assert.equal(s.totals.holdback_paid, 3300);
  assert.equal(s.frequency, 'every two weeks');
  assert.ok(s.next_pays.every((d) => !['07', '08'].includes(d.slice(5, 7))));
  // From September it builds toward next summer.
  const sept = await paystubSummary({ owner: 'jake', year: 2026, today: '2026-09-20' });
  assert.equal(sept.holdback.summer, 2027);
});

test('estimated pays: CPP and EI stop at the year\'s maximum, so take-home rises, and start again in January', () => {
  const stub = (d) => ({ pay_date: d, gross: 4000, net: 3000, deductions: [
    { type: 'income_tax', label: 'Tax', amount: 700 }, { type: 'cpp', label: 'CPP', amount: 230 }, { type: 'ei', label: 'EI', amount: 65.2 }, { type: 'benefits', label: 'LTD', amount: 4.8 }] });
  const regular = [stub('2026-10-02'), stub('2026-10-16'), stub('2026-10-30')];
  const est = estimateStubs(regular, ['2026-11-13', '2026-11-27', '2026-12-11', '2027-01-08'], { 2026: { cpp: 3900, ei: 1100, cpp2: 0 } });
  const cpp = (x) => x.deductions.find((d) => d.type === 'cpp')?.amount || 0;
  const ei = (x) => x.deductions.find((d) => d.type === 'ei')?.amount || 0;
  assert.deepEqual(est.map(cpp), [230, 100.45, 0, 230]);
  assert.deepEqual(est.map(ei), [23.07, 0, 0, 65.2]);
  assert.equal(est[0].net, 3042.13);
  assert.equal(est[2].net, 4000 - 700 - 4.8);
  assert.ok(est.every((x) => x.estimated));
});

test('a deduction\'s type can be set by its label, on every stub and from then on', async () => {
  const { stub } = normalizeStub({ owner: 'jake', employer: 'NESD', pay_date: '2026-03-13', gross: 100, net: 90, deductions: [{ label: 'Social Fund', amount: 10 }] });
  assert.equal(stub.deductions[0].type, 'other');
  const r = await saveStub(stub);
  assert.equal(await setLabelType('social fund', 'union_dues'), 1);
  const row = await one('SELECT deductions FROM paystubs WHERE id = $1', [r.id]);
  assert.equal(row.deductions[0].type, 'union_dues');
  const next = normalizeStub({ owner: 'jake', employer: 'NESD', pay_date: '2026-03-27', gross: 100, net: 90, deductions: [{ label: 'SOCIAL FUND', amount: 10 }] }).stub;
  const r2 = await saveStub(next);
  assert.equal((await one('SELECT deductions FROM paystubs WHERE id = $1', [r2.id])).deductions[0].type, 'union_dues');
});
