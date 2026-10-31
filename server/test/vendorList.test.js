import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vendorRows } from '../lib/vendorList.js';

const now = new Date('2026-10-31T12:00:00Z');
const payees = [
  { id: 1, name: 'SCIC', has_account: true, last_paid: '2026-10-13' },
  { id: 2, name: 'JS & CL Gayler', has_account: true, last_paid: '2026-10-16' },
  { id: 3, name: 'C and E Transport', has_account: true, last_paid: '2026-10-13' },
  { id: 4, name: 'Co-op (ledger only)', has_account: false },
  { id: 5, name: 'Agro Supply', has_account: true },
];
const bill = (o) => ({ id: 1, name: 'Inv', amount: 100, owing: 100, applied: 0, due_date: '2026-12-31', received_date: '2026-10-03', created_at: '2026-10-03', ...o });

test('settled vendor accounts stay on the list at $0 (Jake, Oct 31), after the ones owing', () => {
  const rows = vendorRows(
    [bill({ id: 29, payee_id: 2, amount: 68020, owing: 70293.55 })],
    [{ id: 7, payee_id: 5, status: 'open', amount: 500, remaining: 500, date: '2026-09-01' }],
    payees, { now });
  assert.deepEqual(rows.map((v) => v.name), ['JS & CL Gayler', 'Agro Supply', 'C and E Transport', 'SCIC']);
  const scic = rows.find((v) => v.name === 'SCIC');
  assert.equal(scic.owing, 0);
  assert.equal(scic.net, 0);
  assert.equal(scic.last_paid, '2026-10-13');
  assert.deepEqual(scic.bills, []);
  assert.equal(rows.find((v) => v.name === 'Agro Supply').net, -500);
  // A payee with only ledger entries isn't a vendor account.
  assert.ok(!rows.some((v) => v.payee_id === 4));
});

test('unpaid bills with no vendor show as "No vendor set" only while there are some', () => {
  assert.ok(vendorRows([bill({ payee_id: null })], [], payees, { now }).some((v) => v.name === 'No vendor set'));
  assert.ok(!vendorRows([], [], payees, { now }).some((v) => v.name === 'No vendor set'));
});

test('owing and net are rounded to cents; credits closed over a year ago are not listed', () => {
  const rows = vendorRows(
    [bill({ id: 1, payee_id: 3, owing: 0.1 }), bill({ id: 2, payee_id: 3, owing: 0.2 })],
    [{ id: 8, payee_id: 3, status: 'used', amount: 50, remaining: 0, date: '2025-01-01' }],
    payees, { now });
  const ce = rows.find((v) => v.payee_id === 3);
  assert.equal(ce.owing, 0.3);
  assert.deepEqual(ce.credits, []);
});
