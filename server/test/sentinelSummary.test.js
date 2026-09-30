import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, forecastSummary, equitySummary, businessAssetsCents, overdueSummary, fmtDollars } from '../lib/sentinelSummary.js';

// 18:00 UTC = noon in Regina, Sep 30 2026.
const NOON = new Date('2026-09-30T18:00:00Z');
const TODAY = '2026-09-30';

const trajectory = (balances, year = 2026, month = 9) => balances.map((balance, i) => {
  const m = month - 1 + i;
  return { year: year + Math.floor(m / 12), month: (m % 12) + 1, balance };
});

const baseInputs = (over = {}) => ({
  cashFlow30: { inflow: '12000.50', outflow: '-4000.25', lastTxDate: '2026-09-28' },
  liquidity: {
    startingBalance: 50000, bufferPct: 0.15, requiredFloor: 3000,
    trajectory: trajectory([48000, 40000, 30000, 20000, 90000, 80000]),
  },
  coverage: { threshold: 1.25, projected: { ratio: 1.8123, termDebtService: 40000, capacity: 72492 } },
  balance: {
    accounts: [{ ledger: 'business', balance: '50000.00' }, { ledger: 'personal', balance: '5000.00' }],
    assets: [
      { value_now: 400000, segment: 'grain' },
      { value_now: 300000, segment: 'jake' }, // the house
    ],
    inventoryRows: [{ counted_value: 100000, segment: 'grain' }],
    loans: [{ outstanding: 250000, segment: 'grain' }],
    creditCards: [{ outstanding: 2000.1, segment: null }],
    needsPrice: 0,
  },
  ytd: { revenue: '200000.00', expenses: '-150000.00' },
  trailing12: { revenue: '300000', expenses: '-220000', interest: 15000, lineCount: 420 },
  overdue: { bills: [], loanPayments: [], cardStatements: [] },
  ...over,
});

test('happy path: shape, cents, performance, nothing needs attention', () => {
  const body = buildSummary(baseInputs(), { now: NOON });
  assert.equal(body.generated_at, NOON.toISOString());
  const s = body.summary;
  assert.equal(s.status_line, 'Nothing needs attention');
  assert.deepEqual(s.cash_flow, { net_30d_cents: 800025, inflow_30d_cents: 1200050, outflow_30d_cents: 400025 });
  // 50,000 + 5,000 + 400,000 + 300,000 + 100,000 = 855,000 assets; 250,000 + 2,000.10 liabilities
  assert.equal(s.equity.assets_cents, 85500000);
  assert.equal(s.equity.liabilities_cents, 25200010);
  assert.equal(s.equity.equity_cents, 85500000 - 25200010);
  assert.deepEqual(s.equity.trend_12m, [{ month: '2026-09', equity_cents: s.equity.equity_cents }]);
  assert.equal(s.performance.op_margin_ytd_pct, 25);
  assert.equal(s.performance.dscr, 1.81);
  assert.equal(s.performance.dscr_threshold, 1.25);
  // (300,000 − 220,000 − 15,000) / (50,000 + 400,000 + 100,000) = 11.8%
  assert.equal(s.performance.roa_pct, 11.8);
  for (const k of ['assets_cents', 'liabilities_cents', 'equity_cents']) assert.ok(Number.isInteger(s.equity[k]));
  assert.ok(s.notes.some((n) => n.startsWith('Equity trend: one point')));
  assert.ok(s.notes.some((n) => n.startsWith('DSCR:') && n.includes('NEXT 12 months')));
});

test('forecast: today + month-ends through the month holding day 90, monthly resolution', () => {
  const { forecast } = forecastSummary(baseInputs().liquidity, TODAY);
  // Sep month-end is today, so it's skipped; Dec 1 ≤ Dec 29 (day 90) so Dec is in; Jan isn't.
  assert.deepEqual(forecast.points.map((p) => p.date), ['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);
  assert.deepEqual(forecast.points.map((p) => p.balance_cents), [5000000, 4000000, 3000000, 2000000]);
  assert.equal(forecast.floor_cents, 300000);
  assert.equal(forecast.floor_rule, '15% buffer');
  assert.equal(forecast.min_balance_cents, 2000000);
  assert.equal(forecast.min_date, '2026-12-31');
  assert.equal(forecast.breaches_floor, false);
});

test('forecast floor breach drives the status line (first month below floor)', () => {
  const inputs = baseInputs({
    liquidity: { startingBalance: 10000, bufferPct: 0.15, requiredFloor: 3000,
      trajectory: trajectory([9000, 5000, 2500, -1000, 50000]) },
  });
  const s = buildSummary(inputs, { now: NOON }).summary;
  assert.equal(s.forecast_90d.breaches_floor, true);
  assert.equal(s.forecast_90d.min_balance_cents, -100000);
  assert.equal(s.forecast_90d.min_date, '2026-12-31');
  assert.equal(s.status_line, 'Cash dips below the floor in November 2026');
});

test('floor breach across a year boundary names the year; below now says so', () => {
  const dec = new Date('2026-12-15T18:00:00Z');
  const s = buildSummary(baseInputs({
    liquidity: { startingBalance: 10000, bufferPct: 0.15, requiredFloor: 3000,
      trajectory: trajectory([9000, 1000, 8000], 2026, 12) },
  }), { now: dec }).summary;
  assert.equal(s.status_line, 'Cash dips below the floor in January 2027');

  const s2 = buildSummary(baseInputs({
    liquidity: { startingBalance: 1000, bufferPct: 0.15, requiredFloor: 3000, trajectory: trajectory([9000, 9000]) },
  }), { now: NOON }).summary;
  assert.equal(s2.status_line, 'Cash is below the floor now');
});

test('overdue bills, loan payments and card statements outrank a floor breach', () => {
  const inputs = baseInputs({
    liquidity: { startingBalance: 100, bufferPct: 0.15, requiredFloor: 3000, trajectory: trajectory([0, 0]) },
    overdue: {
      bills: [
        { status: 'unpaid', due_date: '2026-09-20', amount: '740.00' },
        { status: 'unpaid', due_date: TODAY, amount: '999.00' }, // due today: not overdue
        { status: 'paid', due_date: '2026-09-01', amount: '50.00' },
      ],
      loanPayments: [
        { paid: false, is_adjustment: false, due_date: new Date(2026, 8, 1), principal_amount: '400.00', interest_amount: '100.00' },
        { paid: true, is_adjustment: false, due_date: '2026-08-01', principal_amount: '400.00', interest_amount: '100.00' },
      ],
      cardStatements: [{ due_date: '2026-10-05', amount: '300.00' }],
    },
  });
  const s = buildSummary(inputs, { now: NOON }).summary;
  assert.equal(s.status_line, '2 bills overdue ($1,240)');
  assert.deepEqual(overdueSummary({ cardStatements: [{ due_date: '2026-09-29', amount: '12.50' }] }, TODAY),
    { count: 1, total_cents: 1250 });
  assert.equal(buildSummary(baseInputs({ overdue: { bills: [{ status: 'unpaid', due_date: '2026-09-01', amount: '5' }] } }),
    { now: NOON }).summary.status_line, '1 bill overdue ($5)');
});

test('no transactions: zero cash flow with a note; margin and ROA null with notes; floor $0 noted', () => {
  const inputs = baseInputs({
    cashFlow30: { inflow: '0', outflow: '0', lastTxDate: null },
    liquidity: { startingBalance: 1000, bufferPct: 0.15, requiredFloor: 0, trajectory: trajectory([1000, 1000]) },
    ytd: { revenue: '0', expenses: '0' },
    trailing12: { revenue: '0', expenses: '0', interest: 0, lineCount: 0 },
  });
  const s = buildSummary(inputs, { now: NOON }).summary;
  assert.deepEqual(s.cash_flow, { net_30d_cents: 0, inflow_30d_cents: 0, outflow_30d_cents: 0 });
  assert.equal(s.performance.op_margin_ytd_pct, null);
  assert.equal(s.performance.roa_pct, null);
  assert.ok(s.notes.some((n) => n.startsWith('Cash flow: no business transactions recorded yet')));
  assert.ok(s.notes.some((n) => n.startsWith('Operating margin: null')));
  assert.ok(s.notes.some((n) => n.startsWith('ROA: null')));
  assert.ok(s.notes.some((n) => n.startsWith('Forecast floor is $0')));
  assert.equal(s.forecast_90d.breaches_floor, false);
});

test('stale transactions: note names the latest date', () => {
  const s = buildSummary(baseInputs({ cashFlow30: { inflow: 0, outflow: 0, lastTxDate: new Date(2026, 5, 30) } }),
    { now: NOON }).summary;
  assert.ok(s.notes.some((n) => n.includes('latest is 2026-06-30')));
});

test('no loans: DSCR null with a note, no coverage status', () => {
  const inputs = baseInputs({
    coverage: { threshold: 1.25, projected: { ratio: null, termDebtService: 0, capacity: 50000 } },
    balance: { ...baseInputs().balance, loans: [] },
    trailing12: { revenue: '300000', expenses: '-220000', interest: 0, lineCount: 10 },
  });
  const s = buildSummary(inputs, { now: NOON }).summary;
  assert.equal(s.performance.dscr, null);
  assert.equal(s.performance.dscr_threshold, 1.25);
  assert.ok(s.notes.some((n) => n.startsWith('DSCR: null')));
  assert.equal(s.equity.liabilities_cents, 200010);
  assert.equal(s.status_line, 'Nothing needs attention');
});

test('DSCR below threshold is flagged (threshold from settings)', () => {
  const s = buildSummary(baseInputs({ coverage: { threshold: 1.3, projected: { ratio: 1.1 } } }), { now: NOON }).summary;
  assert.equal(s.performance.dscr_threshold, 1.3);
  assert.equal(s.status_line, 'Debt coverage 1.10× — below 1.3×');
});

test('negative equity: overdrawn account is a liability; status says so', () => {
  const bal = {
    accounts: [{ ledger: 'business', balance: '-1500.00' }],
    assets: [{ value_now: 10000 }],
    inventoryRows: [],
    loans: [{ outstanding: 30000 }],
    creditCards: [],
  };
  assert.deepEqual(equitySummary(bal), { assets_cents: 1000000, liabilities_cents: 3150000, equity_cents: -2150000 });
  const s = buildSummary(baseInputs({ balance: bal }), { now: NOON }).summary;
  assert.equal(s.equity.equity_cents, -2150000);
  assert.equal(s.status_line, 'Liabilities exceed assets by $21,500');
  assert.equal(s.equity.trend_12m[0].equity_cents, -2150000);
});

test('ROA uses farm-business assets only (splits honoured, personal excluded)', () => {
  const cents = businessAssetsCents({
    accounts: [{ ledger: 'business', balance: '100.00' }, { ledger: 'personal', balance: '999.00' }],
    assets: [
      { value_now: 1000, is_segment_split: true, segment_grain_pct: 50, segment_jake_pct: 50 },
      { value_now: 500, segment: 'personal' },
      { value_now: 200, segment: null },
    ],
    inventoryRows: [{ counted_value: 300, segment: 'livestock' }],
  });
  assert.equal(cents, 10000 + 50000 + 20000 + 30000);
});

test('unpriced inventory gets a note', () => {
  const s = buildSummary(baseInputs({ balance: { ...baseInputs().balance, needsPrice: 2 } }), { now: NOON }).summary;
  assert.ok(s.notes.includes('Equity: 2 inventory items have no price and count as $0.'));
});

test('status uses the dashboard 12-month floor check even when the 90-day chart is clear', () => {
  const inputs = baseInputs({
    liquidity: { startingBalance: 50000, bufferPct: 0.15, requiredFloor: 3000, passes: false,
      trajectory: trajectory([48000, 40000, 30000, 20000, 10000, 5000, 2999.99, 1000, 60000]) },
  });
  const s = buildSummary(inputs, { now: NOON }).summary;
  assert.equal(s.forecast_90d.breaches_floor, false); // chart stays 90 days
  assert.equal(s.forecast_90d.points.at(-1).date, '2026-12-31');
  assert.equal(s.status_line, 'Cash dips below the floor in March 2027'); // earliest breach, not the lowest month
});

test('coverage fails on the unrounded ratio, like the dashboard', () => {
  const s = buildSummary(baseInputs({ coverage: { threshold: 1.25, projected: { ratio: 1.2496, passes: false } } }),
    { now: NOON }).summary;
  assert.equal(s.performance.dscr, 1.25);
  assert.equal(s.status_line, 'Debt coverage 1.25× — below 1.25×');
});

test('op margin not meaningful: YTD revenue under 10% of trailing 12 months, or |margin| > 100%', () => {
  // 1,000 YTD vs 300,000 trailing: null even though the margin itself is sane.
  let s = buildSummary(baseInputs({ ytd: { revenue: '1000', expenses: '-900' } }), { now: NOON }).summary;
  assert.equal(s.performance.op_margin_ytd_pct, null);
  assert.ok(s.notes.includes('Operating margin: not meaningful yet — only $1,000 of revenue so far this year (cash basis).'));
  // Live case: −1,102.9% with revenue above the 10% line still goes null.
  s = buildSummary(baseInputs({ ytd: { revenue: '40000', expenses: '-481160' } }), { now: NOON }).summary;
  assert.equal(s.performance.op_margin_ytd_pct, null);
  assert.ok(s.notes.some((n) => n.startsWith('Operating margin: not meaningful yet — only $40,000')));
  // Exactly 10% of trailing revenue and a margin of −100% are still shown.
  s = buildSummary(baseInputs({ ytd: { revenue: '30000', expenses: '-60000' } }), { now: NOON }).summary;
  assert.equal(s.performance.op_margin_ytd_pct, -100);
});

test('ROA over |100|% is null with a note; within range is kept', () => {
  const tiny = { ...baseInputs().balance, accounts: [{ ledger: 'business', balance: '1000' }], assets: [], inventoryRows: [] };
  let s = buildSummary(baseInputs({ balance: tiny }), { now: NOON }).summary;
  assert.equal(s.performance.roa_pct, null);
  assert.ok(s.notes.some((n) => n.startsWith('ROA: not meaningful')));
  s = buildSummary(baseInputs({ trailing12: { revenue: '0', expenses: '-400000', interest: 0, lineCount: 5 } }), { now: NOON }).summary;
  assert.equal(s.performance.roa_pct, -72.7); // −400,000 / 550,000
});

test('fmtDollars rounds to whole dollars with separators', () => {
  assert.equal(fmtDollars(124037), '$1,240');
  assert.equal(fmtDollars(-50), '-$1');
  assert.equal(fmtDollars(0), '$0');
});
