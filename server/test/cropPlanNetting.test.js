import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netting, costType } from '../lib/cropPlanNetting.js';

// Quarter Section's crop plan without counting anything twice (Oct 30).
const P = 'quarter-section-plan';
const plan = [
  { source: P, external_id: 'plan:2027:sale:canola:9', direction: 'inflow', commodity: 'canola', amount: 160000 },
  { source: P, external_id: 'plan:2027:sale:canola:10', direction: 'inflow', commodity: 'canola', amount: 160000 },
  { source: P, external_id: 'plan:2027:sale:wheat:9', direction: 'inflow', commodity: 'wheat', amount: 100000 },
  { source: P, external_id: 'plan:2027:cost:rent', direction: 'outflow', amount: 90855 },
  { source: P, external_id: 'plan:2027:cost:fertilizer', direction: 'outflow', amount: 349371 },
  { source: P, external_id: 'plan:2027:cost:seed', direction: 'outflow', amount: 48205 },
  { source: 'quarter-section', external_id: 'canola-2026', direction: 'inflow', commodity: 'canola', amount: 50000 },
];
const bills = [
  { name: '101260740 SK Ltd — Land Rent', category: 'Rent & property taxes › Land rent', amount: 45832.5, due_date: '2027-04-01' },
  { name: 'Glen Dancey — Land Rent (110ac)', category: 'Rent & property taxes › Land rent', amount: 4908.75, due_date: '2027-05-06' },
  { name: 'Glen Dancey — Pasture Rent', category: 'Rent & property taxes › Land rent', amount: 4200, due_date: '2027-12-03' },
  { name: 'J & C Gayler — Fertilizer — N', category: 'Fertilizer › Nitrogen', amount: 68020, due_date: '2026-12-31' }, // the 2026 crop's
  { name: 'J & C Gayler — Seed', category: 'Seed', amount: 60000, due_date: '2027-12-31' },
];
const contracts = [
  { commodity: 'Canola', total_value: 80000, delivery_date: '2027-10-15', status: 'open' },
  { commodity: 'Canola', total_value: 31688, delivery_date: '2026-12-10', status: 'open' }, // old crop
  { commodity: 'Wheat (HRS)', total_value: 9000, delivery_date: '2027-11-01', status: 'cancelled' },
];

test('a crop plan less what is already billed (by type, its crop year) and contracted (new crop, by commodity)', () => {
  const n = netting(plan, { bills, contracts });
  const amt = (id) => n.amountOf(plan.find((e) => e.external_id === id));
  assert.equal(Math.round(amt('plan:2027:cost:rent')), Math.round(90855 - 45832.5 - 4908.75), 'pasture rent is not crop rent');
  assert.equal(amt('plan:2027:cost:fertilizer'), 349371, "last December's fertilizer bill is the 2026 crop's");
  assert.equal(amt('plan:2027:cost:seed'), 0, 'seed billed in full: gone');
  assert.equal(amt('plan:2027:sale:canola:9'), 160000 * (1 - 80000 / 320000), 'a quarter of the canola is already contracted');
  assert.equal(amt('plan:2027:sale:wheat:9'), 100000, 'a cancelled contract takes nothing off');
  assert.equal(amt('canola-2026'), 50000, "Quarter Section's in-field estimates are left alone");
  assert.equal(costType('Chemicals › Herbicide'), 'chemical');
  assert.equal(costType('Land Rent › Greenfeed', 'Land Rent ( 120 ac)'), 'rent');
});

test('dates straight from the database (Date objects) net the same as text dates', () => {
  const asDates = bills.map((b) => ({ ...b, due_date: new Date(`${b.due_date}T00:00:00Z`) }));
  const cs = contracts.map((c) => ({ ...c, delivery_date: new Date(`${c.delivery_date}T00:00:00Z`) }));
  const n = netting(plan, { bills: asDates, contracts: cs });
  assert.equal(Math.round(n.amountOf(plan.find((e) => e.external_id === 'plan:2027:cost:rent'))), Math.round(90855 - 45832.5 - 4908.75));
  assert.equal(n.amountOf(plan.find((e) => e.external_id === 'plan:2027:sale:canola:9')), 120000);
});
