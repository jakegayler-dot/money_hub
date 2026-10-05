import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vendorStatement, billSummary, rawOwing, billDate } from '../lib/vendorAccount.js';

const fakeDb = (bills, credits = [], { payee = null, loose = [], docs = [] } = {}) => ({
  query: async (sql) => {
    if (sql.includes('FROM payees')) return { rows: payee ? [payee] : [] };
    if (sql.includes('FROM receipts')) return { rows: docs };
    if (sql.includes('FROM transactions t')) return { rows: loose };
    return { rows: sql.includes('FROM bills') ? bills : credits };
  },
});
const bill = (o) => ({
  id: 1, name: 'Inv', amount: 1000, status: 'unpaid', frequency: 'one_time', received_date: '2026-01-10', due_date: '2026-02-10',
  created_at: '2026-01-10', is_financed: false, applied: 0, linked_transaction_id: null, ...o,
});

test('financed bill: monthly interest lines add up to what bill_owing says is owed', async () => {
  const b = bill({ is_financed: true, finance_rate_pct: 7.5, interest_free_until: '2026-03-15', amount: 50000 });
  const st = await vendorStatement(fakeDb([b]), 1, '2026-06-20');
  assert.equal(st.balance, rawOwing(b, '2026-06-20'));
  const months = st.lines.filter((l) => l.kind === 'interest').map((l) => l.date);
  assert.deepEqual(months, ['2026-03-31', '2026-04-30', '2026-05-31', '2026-06-20']);
});

test('vendor statement balance replaces the invoice from its date, with an adjustment line', async () => {
  const b = bill({ is_financed: true, finance_rate_pct: 6, interest_free_until: '2026-02-01', amount: 10000, balance_amount: 10100, balance_as_of: '2026-04-01' });
  const st = await vendorStatement(fakeDb([b]), 1, '2026-05-15');
  assert.equal(st.balance, rawOwing(b, '2026-05-15'));
  assert.ok(st.lines.some((l) => l.kind === 'adjust'));
});

test('paid bills net to zero; deposits held show as a negative balance', async () => {
  const paid = bill({ id: 2, status: 'paid', linked_transaction_id: 9, tx_date: '2026-02-01', tx_amount: -400, applied: 600 });
  const credits = [{ id: 5, kind: 'prepayment', amount: 1000, date: '2026-01-01', status: 'open', remaining: 400 }];
  const st = await vendorStatement(fakeDb([paid], credits), 1, '2026-03-01');
  assert.equal(st.balance, -400);
  const s = billSummary([paid], credits, '2026-03-01');
  assert.equal(s.net, -400);
});

test('a recurring bill lands on its due date, or the earlier payment date', () => {
  assert.equal(billDate(bill({ frequency: 'monthly', received_date: null, due_date: '2026-10-10' })), '2026-10-10');
  assert.equal(billDate(bill({ frequency: 'monthly', received_date: null, due_date: '2026-10-10', status: 'paid', tx_date: '2026-09-25' })), '2026-09-25');
});

test('future recurring bills are scheduled, not on the balance', async () => {
  const b = bill({ frequency: 'monthly', received_date: null, due_date: '2026-12-01' });
  const st = await vendorStatement(fakeDb([b]), 1, '2026-10-03');
  assert.equal(st.balance, 0);
  assert.equal(st.upcoming.length, 1);
});

test('entries with no bill: paid at purchase leaves the balance; on account pays it down; opening balance replaces earlier history', async () => {
  const loose = [
    { id: 70, date: '2026-02-01', amount: -500, description: 'Counter purchase', on_account: false },
    { id: 71, date: '2026-03-01', amount: -1200, description: 'Paid on statement', on_account: true },
    { id: 72, date: '2025-12-01', amount: -900, description: 'Before opening', on_account: true },
  ];
  const st = await vendorStatement(fakeDb([], [], { payee: { opening_balance: 3000, opening_date: '2026-01-01' }, loose }), 1, '2026-04-01');
  assert.equal(st.balance, 1800);
  assert.equal(st.lines.find((l) => l.key === 'spot:70').amount, 0);
  assert.equal(st.lines.find((l) => l.key === 'acct:72').before_opening, true);
});

test('money in from a vendor is income, not a charge; documents land on their lines', async () => {
  const b = bill({ id: 3, amount: 200, received_date: '2026-03-01', due_date: '2026-03-31' });
  const loose = [{ id: 80, date: '2026-03-15', amount: 1500, description: 'e-Transfer — wages', on_account: false }];
  const docs = [{ id: 501, mime: 'application/pdf', bill_id: 3, transaction_id: null }, { id: 502, mime: 'image/jpeg', bill_id: null, transaction_id: 80 }];
  const st = await vendorStatement(fakeDb([b], [], { loose, docs }), 1, '2026-04-01');
  const wage = st.lines.find((l) => l.key === 'spot:80');
  assert.equal(wage.kind, 'received');
  assert.equal(wage.amount, 0);
  assert.equal(st.balance, 200);
  assert.deepEqual(st.lines.find((l) => l.kind === 'bill').docs.map((d) => d.id), [501]);
  assert.deepEqual(wage.docs.map((d) => d.id), [502]);
});
