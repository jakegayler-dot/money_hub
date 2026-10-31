import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markPaidDeadlines, paysDeadline, deadlineKey, applyPaidDeadlines } from '../lib/deadlinePaid.js';

const item = (key, date, title = 'Crop insurance premium due (SCIC)') => ({ id: `deadline:${key}:${date}`, date, kind: 'program', title, notes: 'Interest is charged on premium unpaid after today.', amount: null });

test('the SCIC premium paid on Oct 13 marks the Oct 31 premium deadline done (Jake, Oct 31)', () => {
  const items = [item('crop_premium', '2026-10-31')];
  markPaidDeadlines(items, [{ date: '2026-10-13', amount: 6553.11, text: 'SCIC', payee: 'SCIC', category: 'Insurance › Crop insurance & AgriStability' }]);
  assert.equal(items[0].done, true);
  assert.deepEqual(items[0].paid, { date: '2026-10-13', amount: 6553.11, what: 'SCIC' });
  assert.match(items[0].title, /— paid 2026-10-13$/);
  assert.match(items[0].notes, /^Already paid: \$6,553\.11 on 2026-10-13/);
});

test('a ledger payment matches by its description or category, not only a bill', () => {
  assert.ok(paysDeadline('crop_premium', '2026-10-31', { date: '2026-10-13', amount: -6553.11, text: '6508 SASK.CROP INSUR (SCIC premium)' }));
  assert.ok(paysDeadline('crop_premium', '2026-10-31', { date: '2026-11-20', amount: -100, text: 'Online payment', category: 'Insurance › Crop insurance & AgriStability' }));
});

test("a payment outside the deadline's season, or to someone else, doesn't count", () => {
  // Spring SCIC payment: the AgriStability fee or last year's premium, not this fall's.
  assert.equal(paysDeadline('crop_premium', '2026-10-31', { date: '2026-04-20', amount: 900, text: 'SCIC' }), false);
  // Next year's premium date isn't paid by this year's payment.
  assert.equal(paysDeadline('crop_premium', '2027-10-31', { date: '2026-10-13', amount: 6553.11, text: 'SCIC' }), false);
  assert.equal(paysDeadline('crop_premium', '2026-10-31', { date: '2026-10-13', amount: 300, text: 'Co-op', category: 'Fuel' }), false);
  // Land rent sits under "Rent & property taxes" but isn't the RM's taxes.
  assert.equal(paysDeadline('property_tax', '2026-12-31', { date: '2026-10-01', amount: 4200, text: 'Glen Dancey', category: 'Rent & property taxes › Land rent' }), false);
  assert.ok(paysDeadline('property_tax', '2026-12-31', { date: '2026-10-01', amount: 3100, text: 'RM of Star City No. 428' }));
  assert.ok(paysDeadline('property_tax', '2026-12-31', { date: '2026-07-01', amount: 3100, text: 'Taxes', category: 'Rent & property taxes › Property taxes' }));
});

test('AgriStability enrolment needs AgriStability named: a crop premium paid to SCIC in spring is not the fee', () => {
  assert.equal(paysDeadline('agristability_enrol', '2026-04-30', { date: '2026-04-10', amount: 6553.11, text: 'SCIC', category: 'Insurance › Crop insurance & AgriStability' }), false);
  assert.ok(paysDeadline('agristability_enrol', '2026-04-30', { date: '2026-04-10', amount: 315, text: 'SCIC AgriStability fee' }));
});

test('dates that are not payments are left alone, as are unpaid ones', () => {
  const items = [item('seeded_acreage', '2026-06-25', 'Seeded acreage report'), item('crop_premium', '2026-10-31')];
  markPaidDeadlines(items, [{ date: '2026-06-20', amount: 10, text: 'SCIC' }]);
  assert.equal(items[0].done, undefined);
  assert.equal(items[1].done, undefined);
  assert.equal(deadlineKey({ id: 'heads:deadline:crop_premium:2026-10-31' }), null);
  assert.equal(deadlineKey(items[1]), 'crop_premium');
});

test('applyPaidDeadlines reads paid bills and ledger payments around the dates', async () => {
  const seen = [];
  const db = {
    query: async (sql, params) => {
      seen.push(params);
      return { rows: sql.includes('FROM bills') ? [{ date: new Date(2026, 9, 13), amount: '6553.11', text: 'SCIC', payee: 'SCIC', category: 'Insurance › Crop insurance & AgriStability' }] : [] };
    },
  };
  const items = await applyPaidDeadlines([item('crop_premium', '2026-10-31'), item('crop_premium', '2027-10-31')], db);
  assert.equal(items[0].done, true);
  assert.equal(items[1].done, undefined);
  assert.deepEqual(seen[0], ['2025-10-31', '2028-01-29']);
  // No payment deadlines in the list: no queries.
  seen.length = 0;
  await applyPaidDeadlines([item('seeded_acreage', '2026-06-25')], db);
  assert.equal(seen.length, 0);
});
