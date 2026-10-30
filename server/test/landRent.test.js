import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLandRent, matchLandlord } from '../lib/landRent.js';

// Oct 30: "a land rent tab on moneyhub that shows all the rent payments, their cost per acre, their due dates etc"
const bills = [
  { id: 1, name: '101260740 SK Ltd — Land Rent', vendor: '101260740 SK Ltd', amount: 45832.5, due_date: '2026-04-01', status: 'paid' },
  { id: 2, name: '101260740 SK Ltd — Land Rent', vendor: '101260740 SK Ltd', amount: 45832.5, due_date: '2027-04-01', status: 'unpaid' },
  { id: 3, name: 'Grain Land Rent 110ac', vendor: 'Glen Dancey', amount: 4908.75, due_date: '2026-12-01', status: 'unpaid' },
  { id: 4, name: 'Glen Dancey — Pasture Rent', vendor: 'Glen Dancey', amount: 4200, due_date: '2026-12-03', status: 'unpaid' },
  { id: 5, name: 'Randy Jacklin', vendor: 'Randy Jacklin', amount: 7700, due_date: '2026-12-01', status: 'unpaid' },
];
const land = [
  { field: 'Nikkik', farm: 'Leather River Cattle', landlord: 'Matt Fennell', tenure: 'rented', acres: 134, rent_per_acre: 90 },
  { field: 'Glens South', farm: 'Leather River Cattle', landlord: 'Glen Dancey', tenure: 'rented', acres: 107, rent_per_acre: 90 },
  { field: 'Mcveighs', farm: 'Leather River Cattle', landlord: 'Randy Jacklin', tenure: 'rented', acres: 90, rent_per_acre: 70 },
  { field: "Randy's Triangle", farm: 'Leather River Cattle', landlord: 'Randy Jacklin', tenure: 'rented', acres: 20, rent_per_acre: 70 },
  { field: 'Davids East', farm: 'Leather River Cattle', landlord: 'David Reinhart', tenure: 'cropshare', acres: 140, crop_share_pct: 25 },
  { field: 'Joe\'s', farm: 'J&C Gayler', landlord: 'Randy Jacklin', tenure: 'rented', acres: 95, rent_per_acre: 75, included: false },
];

test('landlords matched by name word or by hand; $/acre from the land rent a year; expected payments carried forward', () => {
  const r = buildLandRent({ bills, land, alias: { '101260740 SK Ltd': 'Matt Fennell' }, today: '2026-10-30', endStr: '2028-10-30' });
  const by = Object.fromEntries(r.landlords.map((l) => [l.payee, l]));
  assert.equal(by['101260740 SK Ltd'].landlord, 'Matt Fennell');
  assert.equal(by['101260740 SK Ltd'].acres, 134);
  assert.equal(by['Glen Dancey'].landlord, 'Glen Dancey');
  assert.equal(by['Glen Dancey'].per_acre, 45.88, 'land rent only, pasture apart: 4,908.75 / 107');
  assert.equal(by['Randy Jacklin'].acres, 110, "the other farm's field is left out");
  assert.equal(by['Randy Jacklin'].per_acre, 70);
  assert.equal(by['Randy Jacklin'].by_lease, 7700);
  assert.ok(by['Glen Dancey'].payments.some((p) => p.status === 'expected' && p.date === '2027-12-01'), 'next December carried forward');
  assert.equal(by['101260740 SK Ltd'].next.date, '2027-04-01');
  assert.deepEqual(r.unbilled.map((u) => [u.landlord, u.crop_share]), [['David Reinhart', true]]);
});

test('a payee is matched only on one landlord sharing a name word', () => {
  assert.equal(matchLandlord('Glen Dancey', ['Glen Dancey', 'Matt Fennell']), 'Glen Dancey');
  assert.equal(matchLandlord('101260740 SK Ltd', ['Glen Dancey', 'Matt Fennell']), null);
  assert.equal(matchLandlord('X', ['Glen Dancey'], { X: '' }), null);
});
