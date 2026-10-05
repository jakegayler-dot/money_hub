import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, toCents, reginaToday, computeWindow, statementItems } from '../lib/sentinelSnapshot.js';

// 18:00 UTC = noon in Regina, Sep 30 2026.
const NOON = new Date('2026-09-30T18:00:00Z');
const byId = (snap) => Object.fromEntries(snap.items.map((i) => [i.source_id, i]));

const bill = (over) => ({
  id: 1, name: 'SaskPower', ledger: 'business', category: 'Utilities', amount: '100.00',
  frequency: 'one_time', due_date: '2026-10-15', status: 'unpaid', paid_date: null, notes: null, ...over,
});

test('Regina today: fixed UTC-6, including near midnight UTC', () => {
  assert.equal(reginaToday(new Date('2026-10-01T03:00:00Z')), '2026-09-30'); // 21:00 Sep 30 in Regina
  assert.equal(reginaToday(new Date('2026-10-01T05:59:59Z')), '2026-09-30');
  assert.equal(reginaToday(new Date('2026-10-01T06:00:00Z')), '2026-10-01');
  assert.equal(reginaToday(new Date('2027-01-01T01:00:00Z')), '2026-12-31'); // across a year
  assert.equal(reginaToday(new Date('2026-07-01T05:30:00Z')), '2026-06-30'); // no DST in summer
  const snap = buildSnapshot({}, { now: new Date('2026-10-01T03:00:00Z') });
  assert.equal(snap.from, '2026-08-31');
  assert.equal(snap.to, '2028-03-31'); // Sep 30 2026 + 548 days
});

test('amount rounding parses NUMERIC strings without float drift', () => {
  assert.equal(toCents('1234.57'), 123457);
  assert.equal(toCents('0.10'), 10);
  assert.equal(toCents('1.005'), 101);
  assert.equal(toCents('1.004'), 100);
  assert.equal(toCents('19.9'), 1990);
  assert.equal(toCents('100'), 10000);
  assert.equal(toCents('-12.34'), -1234);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(1.005), 101);
  assert.equal(toCents(null), null);
  assert.throws(() => toCents('abc'));
});

test('bill mapping: open, business → finance, fields and notes', () => {
  const snap = buildSnapshot({ bills: [bill({ amount: '1234.57', notes: 'Acct 42' })] },
    { now: NOON, appUrl: 'https://money.example/' });
  assert.equal(snap.items.length, 1);
  assert.deepEqual(snap.items[0], {
    source_id: 'bill:1:2026-10-15', kind: 'bill', category: 'finance', title: 'SaskPower',
    amount_cents: 123457, currency: 'CAD', deep_link: 'https://money.example/bills',
    notes: 'Category: Utilities · Ledger: business\nAcct 42', starts_at: '2026-10-15',
    status: 'open', all_day: true,
  });
  assert.equal(snap.generated_at, NOON.toISOString());
});

test('personal-ledger bills are house, shared with house; no deep link without APP_URL', () => {
  const [item] = buildSnapshot({ bills: [bill({ ledger: 'personal' })] }, { now: NOON }).items;
  assert.equal(item.category, 'house');
  assert.deepEqual(item.share_scopes, ['house']);
  assert.equal('deep_link' in item, false);
});

test('titles are clipped to 120 chars', () => {
  const [item] = buildSnapshot({ bills: [bill({ name: 'x'.repeat(300) })] }, { now: NOON }).items;
  assert.equal(item.title.length, 120);
});

test('paid bills: in window → done; outside window → omitted', () => {
  const snap = buildSnapshot({
    bills: [
      bill({ id: 1, status: 'paid', due_date: '2026-09-10', paid_date: '2026-09-09' }),
      bill({ id: 2, status: 'paid', due_date: '2026-08-01', paid_date: '2026-08-01' }), // before from
      bill({ id: 3, status: 'paid', due_date: '2028-06-01' }),                         // after to
    ],
  }, { now: NOON });
  assert.deepEqual(snap.items.map((i) => [i.source_id, i.status]), [['bill:1:2026-09-10', 'done']]);
});

test('overdue unpaid bill extends from and keeps paid items back to it', () => {
  const snap = buildSnapshot({
    bills: [
      bill({ id: 7, due_date: '2026-03-01' }),                                  // overdue, unpaid
      bill({ id: 8, status: 'paid', due_date: '2026-05-01' }),                  // now inside window
      bill({ id: 9, status: 'paid', due_date: '2026-02-01' }),                  // still before from
    ],
  }, { now: NOON });
  assert.equal(snap.from, '2026-03-01');
  const ids = Object.keys(byId(snap));
  assert.ok(ids.includes('bill:7:2026-03-01'));
  assert.ok(ids.includes('bill:8:2026-05-01'));
  assert.ok(!ids.some((id) => id.startsWith('bill:9:')));
  for (const i of snap.items) assert.ok(i.starts_at >= snap.from && i.starts_at <= snap.to);
});

test('window also extends for overdue loan payments and card statements', () => {
  const today = '2026-09-30';
  assert.equal(computeWindow({ loanPayments: [{ due_date: '2026-01-15', paid: false }] }, today).from, '2026-01-15');
  assert.equal(computeWindow({ loanPayments: [{ due_date: '2026-01-15', paid: false, is_adjustment: true }] }, today).from, '2026-08-31');
  assert.equal(computeWindow({ statements: [{ due_date: '2025-12-20', paid: false }] }, today).from, '2025-12-20');
  assert.equal(computeWindow({ statements: [{ due_date: '2025-12-20', paid: true }] }, today).from, '2026-08-31');
});

test('monthly projections are anchored: Jan 31 → Feb 28 → Mar 31 (and Feb 29 in leap years)', () => {
  const now = new Date('2027-01-20T18:00:00Z');
  const snap = buildSnapshot({ bills: [bill({ id: 5, frequency: 'monthly', due_date: '2027-01-31', amount: '55.10' })] }, { now });
  const dates = snap.items.map((i) => i.starts_at);
  assert.deepEqual(dates.slice(0, 5), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  assert.ok(dates.includes('2028-02-29'));
  assert.ok(dates.includes('2028-03-31'));
  assert.ok(dates.every((d) => d <= snap.to));
  assert.equal(dates.at(-1) <= snap.to && dates.at(-1) > '2028-06-01', true);
  const [real, ...projected] = snap.items;
  assert.equal(real.status, 'open');
  for (const p of projected) {
    assert.equal(p.status, 'scheduled');
    assert.equal(p.amount_cents, 5510);
    assert.equal(p.source_id, `bill:5:${p.starts_at}`);
    assert.match(p.notes, /Projected from the monthly schedule/);
  }
});

test('quarterly projections step 3 months from the anchor and stop at to', () => {
  const snap = buildSnapshot({ bills: [bill({ id: 6, frequency: 'quarterly', due_date: '2026-11-30' })] }, { now: NOON });
  assert.deepEqual(snap.items.map((i) => i.starts_at), [
    '2026-11-30', '2027-02-28', '2027-05-30', '2027-08-30', '2027-11-30', '2028-02-29',
  ]);
});

test('paid recurring bills are not projected; one_time bills never are', () => {
  const snap = buildSnapshot({
    bills: [
      bill({ id: 1, frequency: 'monthly', status: 'paid', due_date: '2026-09-15' }),
      bill({ id: 2, frequency: 'one_time', due_date: '2026-10-15' }),
    ],
  }, { now: NOON });
  assert.equal(snap.items.length, 2);
});

test('loan payments: principal + interest summed in cents, paid window, adjustments skipped', () => {
  const snap = buildSnapshot({
    loanPayments: [
      { id: 11, loan_id: 3, loan_name: 'Grain truck', lender: 'FCC', due_date: '2026-10-01', principal_amount: '0.1', interest_amount: '0.2', paid: false },
      { id: 12, loan_id: 3, loan_name: 'Grain truck', lender: 'FCC', due_date: '2026-09-01', principal_amount: '1000.05', interest_amount: '250.10', paid: true },
      { id: 13, loan_id: 3, loan_name: 'Grain truck', lender: 'FCC', due_date: '2026-06-01', principal_amount: '1', interest_amount: '1', paid: true },
      { id: 14, loan_id: 3, loan_name: 'Grain truck', lender: 'FCC', due_date: '2026-10-01', principal_amount: '500', interest_amount: '0', paid: true, is_adjustment: true },
    ],
  }, { now: NOON });
  const items = byId(snap);
  assert.deepEqual(Object.keys(items).sort(), ['loan-payment:11', 'loan-payment:12']);
  assert.equal(items['loan-payment:11'].amount_cents, 30);
  assert.equal(items['loan-payment:11'].status, 'open');
  assert.equal(items['loan-payment:11'].title, 'Loan payment: Grain truck');
  assert.equal(items['loan-payment:12'].amount_cents, 125015);
  assert.equal(items['loan-payment:12'].status, 'done');
});

test('card statements: remaining balance while open, full balance once paid', () => {
  const snap = buildSnapshot({
    statements: [
      { id: 21, credit_card_id: 2, card_name: 'Visa Infinite', due_date: '2026-10-20', statement_balance: '812.40', minimum_payment: '10.00', paid_amount: '300.00', paid: false },
      { id: 22, credit_card_id: 2, card_name: 'Visa Infinite', due_date: '2026-09-20', statement_balance: '450.00', paid_amount: '450.00', paid: true },
    ],
  }, { now: NOON });
  const items = byId(snap);
  assert.equal(items['card-statement:21'].amount_cents, 51240);
  assert.equal(items['card-statement:21'].status, 'open');
  assert.equal(items['card-statement:21'].title, 'Visa Infinite statement due');
  assert.match(items['card-statement:21'].notes, /Minimum payment \$10\.00/);
  assert.equal(items['card-statement:22'].amount_cents, 45000);
  assert.equal(items['card-statement:22'].status, 'done');
});

test('covenant dates and contract payments are all-day events, windowed, no amounts', () => {
  const snap = buildSnapshot({
    loans: [
      { id: 3, name: 'Operating line', lender: 'Affinity', covenant_date: '2026-12-31', covenant_notes: 'Annual financials' },
      { id: 4, name: 'Old', lender: 'X', covenant_date: '2025-01-01' },
    ],
    contracts: [
      { id: 31, commodity: 'canola', counterparty: 'Cargill', total_value: '52000.00', expected_payment_date: '2026-11-07', status: 'open', quantity: '100.000', unit: 'tonnes' },
      { id: 32, commodity: 'wheat', counterparty: 'Viterra', total_value: '1', expected_payment_date: '2026-09-15', status: 'settled' },
      { id: 33, commodity: 'barley', total_value: '1', expected_payment_date: '2026-10-15', status: 'cancelled' },
    ],
  }, { now: NOON });
  const items = byId(snap);
  assert.deepEqual(Object.keys(items).sort(), ['contract-payment:31', 'contract-payment:32', 'loan-covenant:3:2026-12-31']);
  const cov = items['loan-covenant:3:2026-12-31'];
  assert.equal(cov.kind, 'event');
  assert.equal(cov.title, 'Covenant date: Operating line');
  assert.equal(cov.status, 'scheduled');
  const c = items['contract-payment:31'];
  assert.equal(c.title, 'Payment expected: canola — Cargill');
  assert.equal(c.category, 'finance');
  assert.equal('amount_cents' in c, false);
  assert.equal(items['contract-payment:32'].status, 'done');
});

test('node-pg Date objects for DATE columns map to the stored calendar date', () => {
  const [item] = buildSnapshot({ bills: [bill({ due_date: new Date(2026, 9, 15) })] }, { now: NOON }).items;
  assert.equal(item.starts_at, '2026-10-15');
  assert.equal(item.source_id, 'bill:1:2026-10-15');
});

test('a card statement replaced by a newer one is not pushed, and does not stretch the window', () => {
  const today = '2026-10-05';
  const statements = [
    { id: 30, credit_card_id: 4, card_name: 'Capital One', statement_date: '2026-08-10', due_date: '2026-09-05', statement_balance: '900.00', paid: false },
    { id: 31, credit_card_id: 4, card_name: 'Capital One', statement_date: '2026-09-10', due_date: '2026-10-05', statement_balance: '1400.00', paid: false },
  ];
  const ids = statementItems(statements, { from: '2026-01-01', to: '2027-12-31' }).map((i) => i.source_id);
  assert.deepEqual(ids, ['card-statement:31']);
  assert.equal(computeWindow({ statements }, today).from, computeWindow({}, today).from);
});

