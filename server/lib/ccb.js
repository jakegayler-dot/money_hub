// Canada Child Benefit (Jake, Nov 6: "add it to tax and programs and use our income as an estimate for next year['s]
// cash flow, and I'll add this year's actuals").
//
//   Paid on the 20th of each month, tax-free, for each child under 18. A benefit year runs July to June and is worked
//   out from the family's net income the calendar year before (July 2027–June 2028 from 2026 income).
//   This benefit year: the monthly amount Jake enters (tax profile ccb_monthly, from the CRA notice), else worked out
//   from last year's family net income. Next benefit year on: worked out from this year's projected family net income
//   (the Tax tab's farm net income plus Ashley's pay less her pension). Each child's age goes by birth year: the
//   under-6 rate runs to the June after the year they turn 6, and payments stop the June after the year they turn 18
//   (birth months aren't kept, so it changes with the benefit year).
//   Counted in Ashley's name (CRA pays the parent who's the primary caregiver).
import { toISODate } from './dates.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// By the July the benefit year starts. 2026: canada.ca indexation (+2.0%); the second threshold indexed the same way.
export const PARAMS = {
  2025: { under6: 7997, age6to17: 6748, t1: 37487, t2: 81222 },
  2026: { under6: 8157, age6to17: 6883, t1: 38237, t2: 82846 },
};
// Reduction rates by number of children (over the first threshold, over the second).
const RATES = [null, [0.07, 0.032], [0.135, 0.057], [0.19, 0.08], [0.23, 0.095]];
export const paramsFor = (startYear) => {
  const ys = Object.keys(PARAMS).map(Number).sort((a, b) => a - b);
  return PARAMS[ys.filter((y) => y <= startYear).pop() ?? ys[0]];
};
/** The benefit year (its July's year) a month falls in. */
export const benefitYearOf = (ym) => (Number(ym.slice(5, 7)) >= 7 ? Number(ym.slice(0, 4)) : Number(ym.slice(0, 4)) - 1);

/** The yearly benefit for one benefit year (pure). birthYears: the children's; afni: family net income the year before. */
export function ccbYear(startYear, birthYears, afni) {
  const p = paramsFor(startYear);
  const ages = birthYears.map((b) => startYear - Number(b)).filter((a) => a >= 0 && a < 18);
  if (!ages.length) return { annual: 0, monthly: 0, children: 0, base: 0, reduction: 0 };
  const base = ages.reduce((s, a) => s + (a < 6 ? p.under6 : p.age6to17), 0);
  const [r1, r2rate] = RATES[Math.min(ages.length, 4)];
  const inc = Math.max(0, Number(afni) || 0);
  const reduction = inc > p.t1 ? r1 * (Math.min(inc, p.t2) - p.t1) + (inc > p.t2 ? r2rate * (inc - p.t2) : 0) : 0;
  const annual = Math.max(0, base - reduction);
  return { annual: r2(annual), monthly: r2(annual / 12), children: ages.length, base, reduction: r2(Math.min(base, reduction)), params: p };
}

/** The monthly payments from today to endStr. incomeOf(year) → family net income for that calendar year (or null). */
export function ccbFlows({ today, endStr, birthYears, actualMonthly, incomeOf }) {
  if (!birthYears?.length) return [];
  const out = [];
  const nowYear = benefitYearOf(today.slice(0, 7));
  let y = Number(today.slice(0, 4)); let m = Number(today.slice(5, 7));
  for (let i = 0; i < 40; i++) {
    const date = `${y}-${String(m).padStart(2, '0')}-20`;
    if (date >= endStr) break;
    if (date >= today) {
      const by = benefitYearOf(date.slice(0, 7));
      let monthly; let basis;
      if (by === nowYear && Number(actualMonthly) > 0) { monthly = Number(actualMonthly); basis = 'actual'; }
      else {
        const inc = incomeOf(by - 1);
        if (inc != null) { monthly = ccbYear(by, birthYears, inc).monthly; basis = `estimate from ${by - 1} family net income`; }
      }
      if (monthly > 0) out.push({ date: toISODate(date), amount: r2(monthly), benefit_year: by, basis });
    }
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
