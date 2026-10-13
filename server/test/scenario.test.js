import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowFor, evaluate, buildTaxFlows, instalmentFor } from '../lib/forecast.js';
import { runScenario, loanSchedule } from '../lib/scenario.js';
import { personalTax } from '../lib/taxRates.js';

const TODAY = '2026-10-03';
function ctxWith(flows, extra = {}) {
  const win = windowFor(12, TODAY);
  const groups = new Map([['canola|bu', { key: 'canola|bu', commodity: 'Canola', unit: 'bu', uncontracted: 10000, avg_price: 14, on_hand: 10000 }]]);
  return {
    win, today: TODAY, flows, groups, known: ['canola'],
    accounts: [{ id: 1, name: 'Ops', balance: 100000, farm: 1 }, { id: 2, name: 'House', balance: 20000, farm: 0 }],
    bills: [], loans: [], contracts: [], estimates: [], inventory: { items: [] }, bufferPct: 0.15,
    tax: { available: true, netY0: 150000, taxY0: personalTax(150000, 2026).total, paidY0: null, priorOwingY0: null, paidPrev: null },
    ...extra,
  };
}
const contract = { key: 'contract:1', kind: 'contract', label: 'Canola — Viterra', date: '2026-11-20', amount: 50000, farm: 1, taxable: 50000, estimate: false, ref: { contract_id: 1, commodity: 'canola' } };
const bins = { key: 'inv:1', kind: 'inventory', label: 'Canola (in inventory)', date: '2027-03-15', amount: 140000, farm: 1, taxable: 140000, estimate: true, ref: { inventory_id: 1, group: 'canola|bu', commodity: 'canola' } };
const mortgage = { key: 'loan:9', kind: 'loan', label: 'House', date: '2026-12-01', amount: -2000, farm: 0, taxable: 0, ref: { interest: 800, rate: 5, rate_type: 'variable' } };

test('scopes: farm sees farm accounts and flows; everything sees all', () => {
  const ctx = ctxWith([contract, mortgage]);
  const farm = evaluate(ctx.flows, ctx, { scope: 'farm' });
  const all = evaluate(ctx.flows, ctx, { scope: 'everything' });
  assert.equal(farm.opening, 100000);
  assert.equal(all.opening, 120000);
  assert.equal(farm.end, 150000);
  assert.equal(all.end, 168000);
});

test('the Dec 31 instalment is two-thirds of the tax, capped by last year’s', () => {
  assert.equal(instalmentFor(2000, null), 0);
  assert.equal(instalmentFor(30000, null), 20000);
  assert.equal(instalmentFor(30000, 15000), 10000);
});

test('plan tax flows: instalment Dec 31 and the balance next April; later years only when changed', () => {
  const ctx = ctxWith([]);
  const t0 = ctx.tax.taxY0;
  const flows = buildTaxFlows(ctx, { 2026: t0, 2027: t0 }, { planTaxes: { 2026: t0, 2027: t0 } });
  const inst = flows.find((f) => f.key === 'tax:inst:2026');
  const bal = flows.find((f) => f.key === 'tax:bal:2026');
  assert.ok(Math.abs(inst.amount + t0 * 2 / 3) < 1);
  assert.ok(Math.abs(inst.amount + bal.amount + t0) < 1);
  assert.ok(!flows.some((f) => f.key.includes('2027')));
});

test('deferring a contract into January moves its tax to next year', () => {
  const ctx = ctxWith([contract]);
  const r = runScenario(ctx, { contract_moves: { 1: '2027-01' } }, { includeTax: true });
  assert.ok(r.scenario.tax_y0 < r.plan.tax_y0);
  assert.ok(r.scenario.tax_y1 > r.plan.tax_y1);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].id, 'timing');
});

test('a lower bin price and a contract from the bins re-value the inventory', () => {
  const ctx = ctxWith([bins]);
  const r = runScenario(ctx, {
    commodities: { 'canola|bu': { price: 12 } },
    contracts_new: [{ commodity: 'Canola', crop: 'bins', group: 'canola|bu', quantity: 4000, unit: 'bu', price: 15, pay_month: '2026-11' }],
  }, { includeTax: false });
  const items = r.scenario.trajectory.months.flatMap((m) => m.items);
  const inv = items.find((i) => i.kind === 'inventory');
  const k = items.find((i) => i.label.startsWith('New contract'));
  assert.equal(inv.amount, 6000 * 12);
  assert.equal(k.amount, 60000);
  assert.equal(r.scenario.end - r.plan.end, 6000 * 12 + 60000 - 140000);
});

test('a new loan: blended payments repay exactly the principal', () => {
  const { payments, payment } = loanSchedule({ amount: 100000, rate: 6, years: 5, per_year: 1, first_month: '2027-11' });
  assert.equal(payments.length, 5);
  assert.ok(Math.abs(payments.reduce((s, p) => s + p.principal, 0) - 100000) < 1);
  assert.ok(Math.abs(payment - 23739.64) < 0.05);
});

test('the operating line draws to keep the minimum and repays from cash', () => {
  const bill = { key: 'bill:1', kind: 'bill', label: 'Fertilizer', date: '2026-11-10', amount: -150000, farm: 1, taxable: -150000, ref: { bill_id: 1, first: true } };
  const ctx = ctxWith([bill, { ...contract, date: '2027-02-10', amount: 200000, taxable: 200000 }]);
  const r = runScenario(ctx, { op_line: { on: true, limit: 100000, rate: 7, keep: 20000 } }, { scope: 'farm', includeTax: false });
  assert.ok(r.scenario.op_peak > 60000 && r.scenario.op_peak <= 100000);
  assert.ok(r.scenario.low >= 19999);
  assert.equal(r.scenario.op_owing_end, 0);
  assert.ok(r.scenario.op_interest > 0);
});

// ---- Capital purchases ------------------------------------------------------------

import { purchaseTerms } from '../lib/scenario.js';
import { purchaseVerdict } from '../lib/purchaseCheck.js';

test('a financed purchase: taxes on the loan, GST back on the next return, PST and fees depreciated', () => {
  const t = purchaseTerms({ label: 'Combine', price: 500000, trade_in: 100000, deposit: 60000, fees: 1000, gst_pct: 5, pst_pct: 6,
    rate: 7, years: 5, per_year: 1, month: '2026-11' }, { today: TODAY, gstFreq: 'quarterly' });
  assert.equal(t.base, 400000);
  assert.equal(t.gst, 20000);
  assert.equal(t.pst, 24000);
  assert.equal(t.financed, 400000 + 20000 + 24000 - 60000);
  assert.equal(t.cash_up_front, 61000);
  assert.equal(t.gst_refund_date, '2027-02-14'); // Q4 return due Jan 31, refund two weeks later
  assert.equal(t.cca_cost, 425000);
  assert.equal(t.first_payment.slice(0, 7), '2027-11');
  assert.ok(Math.abs(t.equity_pct - (1 - 384000 / 544000) * 100) < 0.01);
  const cash = purchaseTerms({ price: 100000, deposit: 20000, gst_pct: 5, taxes: 'cash', month: '2026-11', rate: 6, years: 5 }, { today: TODAY });
  assert.equal(cash.financed, 80000);
  assert.equal(cash.cash_up_front, 25000);
  const home = purchaseTerms({ price: 50000, owner: 'personal', month: '2026-11' }, { today: TODAY });
  assert.equal(home.gst_refund, 0);
  assert.equal(home.cca_cost, 0);
});

test('a purchase moves cash, lowers tax through interest and CCA, and gets a verdict', () => {
  const ctx = ctxWith([contract], { gstFreq: 'quarterly' });
  const sc = { purchases: [{ label: 'Tractor', price: 300000, deposit: 60000, gst_pct: 5, rate: 6.5, years: 5, per_year: 1, month: '2026-11', cca_rate: 30 }] };
  const r = runScenario(ctx, sc, { includeTax: true, floor: 20000 });
  assert.equal(r.steps[0].id, 'purchases');
  const items = r.scenario.trajectory.months.flatMap((m) => m.items);
  assert.equal(items.find((i) => i.label === 'Tractor — deposit').amount, -60000);
  assert.equal(items.find((i) => i.label === 'Tractor — GST back').amount, 15000);
  assert.ok(r.scenario.tax_y0 < r.plan.tax_y0, 'CCA lowers this year’s tax');
  assert.equal(r.purchases[0].financed, 300000 + 15000 - 60000);
  assert.ok(r.new_debt_annual.farm > 55000 && r.new_debt_annual.farm < 65000);
  const coverage = { threshold: 1.25, projected: { capacity: 200000, termDebtService: 50000, ratio: 4 } };
  const v = purchaseVerdict(r, { coverage, reserveTarget: 10000 });
  assert.equal(v.tests.find((t) => t.id === 'coverage').status, 'pass');
  assert.equal(v.verdict, 'viable');
  const weak = purchaseVerdict(r, { coverage: { ...coverage, projected: { capacity: 130000, termDebtService: 50000, ratio: 2.6 } }, reserveTarget: 10000 });
  assert.equal(weak.verdict, 'tight');
  const broke = purchaseVerdict(r, { coverage: { ...coverage, projected: { capacity: 50000, termDebtService: 50000, ratio: 1 } }, reserveTarget: 10000 });
  assert.equal(broke.verdict, 'not_viable');
  assert.match(broke.headline, /^Not viable/);
});

// ---- Balance sheet: loans --------------------------------------------------------

import { loanPosition } from '../lib/statement.js';

test('a loan on the balance sheet: owed until paid, current portion, accrued interest', () => {
  const loan = { principal: 120000, interest_rate_pct: 6, start_date: '2025-01-01', purpose: 'term', created_at: '2025-06-01' };
  const pay = (due, principal, interest, paid) => ({ due_date: due, principal_amount: principal, interest_amount: interest, paid, is_adjustment: false, is_extra: false });
  const p = loanPosition(loan, [pay('2025-11-01', 20000, 7200, true), pay('2026-09-01', 20000, 6000, false), pay('2027-09-01', 20000, 4800, false), pay('2028-09-01', 20000, 3600, false)], '2026-10-12');
  assert.equal(p.owing, 100000);             // only the paid payment came off
  assert.equal(p.current, 40000);            // past due + due within 12 months
  assert.equal(p.longterm, 60000);
  assert.equal(p.overdue_count, 1);
  assert.ok(Math.abs(p.accrued_interest - (6000 + 100000 * 0.06 * 41 / 365)) < 0.01); // past-due interest + since Sep 1
  // Entered after the Sep payment: that one is history, counted as paid.
  const late = loanPosition({ ...loan, created_at: '2026-09-20' }, [pay('2025-11-01', 20000, 7200, true), pay('2026-09-01', 20000, 6000, false), pay('2027-09-01', 20000, 4800, false)], '2026-10-12');
  assert.equal(late.owing, 80000);
  assert.equal(late.overdue_count, 0);
  const op = loanPosition({ ...loan, purpose: 'operating' }, [], '2026-10-12');
  assert.equal(op.current, 120000);
});
