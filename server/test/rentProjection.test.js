import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectRent } from '../lib/rentProjection.js';

// Rent comes round every year (Oct 30: "December rents to Dancey, spring rents to Fennell"). Jake's rent bills as they stand.
const bills = [
  { id: 1, name: '101260740 SK Ltd — Land Rent', vendor: '101260740 SK Ltd', amount: 45832.5, due_date: '2026-04-01' },
  { id: 2, name: '101260740 SK Ltd — Land Rent', vendor: '101260740 SK Ltd', amount: 45832.5, due_date: '2027-04-01' },
  { id: 3, name: 'Glen Dancey — Land Rent (110ac)', vendor: 'Glen Dancey', amount: 4908.75, due_date: '2026-05-06' },
  { id: 4, name: 'Grain Land Rent 110ac', vendor: 'Glen Dancey', amount: 4908.75, due_date: '2026-12-01' },
  { id: 5, name: 'Glen Dancey — Land Rent (110ac)', vendor: 'Glen Dancey', amount: 4908.75, due_date: '2027-05-06' },
  { id: 6, name: 'Glen Dancey — Pasture Rent', vendor: 'Glen Dancey', amount: 4200, due_date: '2026-12-03' },
  { id: 7, name: 'Glen Dancey — Pasture Rent', vendor: 'Glen Dancey', amount: 4200, due_date: '2027-12-03' },
  { id: 8, name: 'Randy Jacklin', vendor: 'Randy Jacklin', amount: 8400, due_date: '2026-12-01' },
];

test('each landlord\'s rent comes round a year later unless a bill already covers it; land, pasture and bales apart', () => {
  const p = projectRent(bills, '2026-10-30', '2028-10-01').map((x) => `${x.date} ${x.bill.name}`);
  assert.deepEqual(p.sort(), [
    '2027-12-01 Grain Land Rent 110ac', // Dancey's December grain rent: no bill for 2027 yet
    '2027-12-01 Randy Jacklin',
    '2028-04-01 101260740 SK Ltd — Land Rent', // spring rent the year after the bill on file
    '2028-05-06 Glen Dancey — Land Rent (110ac)',
  ].sort());
  assert.ok(!p.some((x) => x.startsWith('2027-04') || x.startsWith('2027-05')), 'a bill on file already covers those');
  assert.ok(!p.some((x) => /Pasture/.test(x) && x.startsWith('2027-12')), 'December pasture rent is billed already');
  assert.deepEqual(projectRent(bills, '2026-10-30', '2027-06-01'), [], 'nothing past the end of the window');
});
