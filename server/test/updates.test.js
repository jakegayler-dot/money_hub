// Leases and promotional 0% financing in what-ifs, the crop-year window,
// and transfers kept to one owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaseFlows, loanSchedule } from '../lib/scenario.js';
import { scheduleFromTerms } from '../lib/amortization.js';
import { cropYearMonths } from '../routes/forecast.js';
import { soleOwner, ownerOf } from '../lib/postings.js';

test('lease: monthly payments for the term, farm pays PST but gets GST back, deductible as paid', () => {
  const { flows, annual } = leaseFlows({ label: 'Telehandler', payment: 2000, per_year: 12, years: 2, start_month: '2026-11', pst_pct: 6 }, 0, '2026-10-23');
  assert.equal(flows.length, 24);
  assert.equal(flows[0].kind, 'lease');
  assert.equal(flows[0].date, '2026-11-15');
  assert.equal(flows[23].date, '2028-10-15');
  assert.equal(flows[0].amount, -2120);
  assert.equal(flows[0].taxable, -2120);
  assert.equal(annual, 25440);
  const personal = leaseFlows({ payment: 500, years: 1, start_month: '2026-11', owner: 'personal' }, 1, '2026-10-23');
  assert.equal(personal.flows[0].amount, -525); // GST paid, nothing deducted
  assert.equal(personal.flows[0].taxable, 0);
  const buy = leaseFlows({ payment: 1000, years: 1, start_month: '2026-11', buyout: 10000, down: 1200 }, 2, '2026-10-23');
  assert.equal(buy.flows[0].label, 'Lease — money down');
  assert.equal(buy.flows.at(-1).amount, -10000);
  assert.ok(Math.abs(buy.flows[1].taxable - -(1000 + 100)) < 0.01); // the down payment deducted across the year
  assert.equal(buy.cca.cost, 10000);
});

test('promotional 0%: no interest through the promo month, the term still pays it off', () => {
  const s = loanSchedule({ amount: 12000, rate: 12, years: 2, per_year: 12, first_month: '2026-11', promo_until: '2027-04' });
  assert.equal(s.payments.length, 24);
  assert.ok(s.payments.slice(0, 6).every((p) => p.interest === 0));
  assert.ok(s.payments[6].interest > 0);
  const paid = s.payments.reduce((a, p) => a + p.principal, 0);
  assert.ok(Math.abs(paid - 12000) < 1);
  const inside = scheduleFromTerms({ principal: 6000, interest_rate_pct: 29.99, term_months: 12, start_date: '2026-10-01', payment_frequency: 'monthly', promo_until: '2027-10-15', promo_retro: true });
  assert.ok(inside.every((r) => r.interest_amount === 0), 'paid off inside the promotion: no interest, nothing charged back');
  // Same-as-cash with payments running past the promotion: the waived interest comes back.
  const past = scheduleFromTerms({ principal: 6000, interest_rate_pct: 29.99, term_months: 12, start_date: '2026-10-01', payment_frequency: 'monthly', promo_until: '2027-06-30', promo_retro: true });
  const flat = scheduleFromTerms({ principal: 6000, interest_rate_pct: 29.99, term_months: 12, start_date: '2026-10-01', payment_frequency: 'monthly', promo_until: '2027-06-30' });
  assert.ok(past[8].interest_amount > flat[8].interest_amount + 500, 'charged back in the first payment after the promotion');
});

test('crop-year window: through the August of the crop being marketed', () => {
  assert.equal(cropYearMonths('2026-09-01'), 12);
  assert.equal(cropYearMonths('2026-10-23'), 11);
  assert.equal(cropYearMonths('2027-01-10'), 20);
  assert.equal(cropYearMonths('2027-08-31'), 13);
});

test('a transfer is never split: a 60/40 owner gives the 60 side alone', () => {
  const o = soleOwner(ownerOf({ is_segment_split: true, segment_grain_pct: 60, segment_livestock_pct: 40 }));
  assert.equal(o.segment, 'grain');
  assert.equal(o.is_segment_split, false);
  const single = ownerOf({ segment: 'jake' });
  assert.deepEqual(soleOwner(single), single);
});
