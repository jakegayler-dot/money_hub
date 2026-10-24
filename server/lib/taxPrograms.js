// Tax credits and programs that fit this farm family (Jake, 2026-10-24:
// "include tax schemes currently being offered that are relevant to us").
// Each one: what it is, who it's for, what it's worth here (worked out from
// Money Hub's own figures where they exist), how to claim it, and where the
// rule comes from. Checked against the official pages on 2026-10-24 —
// refresh every year (amounts and programs change with each budget).
//
// A household profile (Tax page) fills what the books can't know: the
// children's birth years, whether Ashley is a certified teacher or early
// childhood educator, whether you own your home.
import { pool, getSetting } from '../db.js';
import { todayISO } from './dates.js';

const r0 = (n) => Math.round(Number(n) || 0);
export const VERIFIED = '2026-10-24';

const DEFAULT_PROFILE = { kids_birth_years: [], ashley_educator: null, owns_home: true, childcare: false, jake_tuition: false };

export async function taxProfile() {
  const v = await getSetting('tax_profile', null);
  const p = typeof v === 'string' ? JSON.parse(v) : v;
  return { ...DEFAULT_PROFILE, ...(p || {}) };
}

export async function saveTaxProfile(b = {}) {
  const cur = await taxProfile();
  const next = { ...cur };
  if (Array.isArray(b.kids_birth_years)) next.kids_birth_years = b.kids_birth_years.map(Number).filter((y) => y > 1990 && y <= new Date().getFullYear()).slice(0, 10);
  for (const k of ['ashley_educator', 'owns_home', 'childcare', 'jake_tuition']) if (b[k] !== undefined) next[k] = b[k] === null ? null : !!b[k];
  await pool.query(`INSERT INTO settings (key, value) VALUES ('tax_profile', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(next)]);
  return next;
}

/** The figures the checks use: farm income, expenses and capital purchases, Ashley's pay, the household. */
async function facts(year) {
  const [{ farmIncomeTax }, { paystubSummary }] = await Promise.all([import('./tax.js'), import('./paystubs.js')]);
  const [cur, prev, pay, profile, capex] = await Promise.all([
    farmIncomeTax(year).catch(() => null),
    farmIncomeTax(year - 1).catch(() => null),
    paystubSummary({ owner: 'ashley', year }).catch(() => null),
    taxProfile(),
    pool.query(
      `SELECT EXTRACT(YEAR FROM l.date)::int AS y, SUM(-l.amount * CASE WHEN l.is_segment_split THEN (COALESCE(l.segment_grain_pct, 0) + COALESCE(l.segment_livestock_pct, 0)) / 100
              WHEN l.segment IN ('grain', 'livestock') THEN 1 WHEN l.segment IN ('jake', 'ashley') THEN 0 WHEN l.ledger = 'personal' THEN 0 ELSE 1 END) AS cost
       FROM transaction_lines l WHERE l.is_capex AND NOT l.is_transfer AND l.amount < 0 AND l.date >= '2025-01-01' GROUP BY 1`).then((r) => r.rows),
  ]);
  const { rows: [emp] } = await pool.query(`SELECT employer FROM paystubs WHERE owner = 'ashley' ORDER BY pay_date DESC LIMIT 1`).catch(() => ({ rows: [] }));
  const kidsAges = (profile.kids_birth_years || []).map((b) => year - b);
  const ashleyGross = pay?.tax_outlook?.projected_gross || pay?.totals?.gross || 0;
  const farmNet = cur?.projected?.net_income ?? null;
  return {
    year, profile, kidsAges,
    farm: { netProjected: farmNet, revenuePrev: prev?.actual?.revenue ?? null, expensesPrev: prev?.actual?.expenses ?? null, marginal: cur?.projected?.tax?.marginal_income_tax_rate ?? null },
    capex: Object.fromEntries(capex.map((c) => [c.y, Number(c.cost)])),
    ashley: { gross: ashleyGross, employer: emp?.employer || null, pension: pay?.totals?.pension || 0 },
    familyNet: farmNet != null ? farmNet + ashleyGross - (pay?.totals?.pension || 0) : null,
  };
}

const educatorGuess = (f) => (f.profile.ashley_educator != null ? f.profile.ashley_educator
  : /school|division|\bsd\b|education|board of ed/i.test(f.ashley.employer || '') ? 'likely' : null);

/**
 * The programs, each checked against the family: status 'yes' (worth
 * doing / claim it), 'check' (may fit — needs a look or a detail), 'auto'
 * (happens on the return without doing anything), 'no' (doesn't fit, and
 * why). value: an estimate in dollars where Money Hub can work one out.
 */
export async function taxPrograms(year = Number(todayISO().slice(0, 4))) {
  const f = await facts(year);
  const kids = f.kidsAges.filter((a) => a >= 0 && a <= 18);
  const under7 = f.kidsAges.filter((a) => a >= 0 && a < 7);
  const marginal = f.farm.marginal;
  const capexNow = f.capex[year] || 0;
  const capexAll = Object.values(f.capex).reduce((a, v) => a + v, 0);
  const edu = educatorGuess(f);
  const out = [];
  const add = (p) => out.push({ verified: VERIFIED, ...p });

  // ---- Farm ----
  const extraCca = r0(capexNow * 0.2); // machinery (Class 8, 20%): first year 30% instead of 10%
  add({
    id: 'aii', who: 'farm', level: 'Federal', kind: 'Faster write-off',
    name: 'Accelerated Investment Incentive (reinstated)',
    what: 'Equipment, buildings and other depreciable property bought new after 2024 and in use before 2030 gets a bigger first-year capital cost allowance: three times the usual first year for most classes (no half-year rule). Machinery (Class 8) writes off 30% in year one instead of 10%; trucks and tractors in Class 10, 45% instead of 15%. Phases down for property in use 2030–2033. Law since March 26, 2026 (Bill C-15).',
    status: capexAll > 0 ? 'yes' : 'check',
    value: capexNow > 0 ? extraCca : null,
    value_note: capexNow > 0 ? `About ${extraCca.toLocaleString('en-CA')} more written off this year on ${r0(capexNow).toLocaleString('en-CA')} of capital purchases (at the machinery rate)${marginal ? `, worth roughly ${r0(extraCca * marginal / 100).toLocaleString('en-CA')} in tax at your ${marginal}% marginal rate` : ''}. Same total over the asset's life — it's timing.` : 'Applies to anything bought new from 2025: tell your accountant which purchases qualify.',
    claim: 'Your accountant claims it in the CCA schedule (T2042) for the year the property becomes available for use. Used property bought from a related person doesn\'t qualify.',
    sources: ['https://taxnews.ey.com/news/2025-2564', 'https://taxnews.ey.com/news/2026-0752-canadas-2025-budget-implementation-bill-no-1-receives-royal-assent'],
  });
  const fuelCredit = f.farm.expensesPrev ? r0((f.farm.expensesPrev / 1000) * 2.5) : null;
  add({
    id: 'fuel-charge-farmers', who: 'farm', level: 'Federal', kind: 'Refundable credit',
    name: 'Return of fuel charge proceeds to farmers — last year: 2025',
    what: 'A refundable credit for farms in carbon-tax provinces, paid on eligible farming expenses: $2.50 per $1,000 for Saskatchewan in 2025 ($2.29 in 2024). The consumer carbon price ended April 1, 2025, so 2025 is the last year it can be claimed — nothing for 2026.',
    status: 'yes',
    value: fuelCredit,
    value_note: fuelCredit ? `About ${fuelCredit.toLocaleString('en-CA')} on ${r0(f.farm.expensesPrev).toLocaleString('en-CA')} of 2025 farm expenses in Money Hub (eligible expenses can differ — CCA and some costs are left out).` : 'Worked out from your 2025 eligible farming expenses.',
    claim: 'Form T2043 with the 2025 return. If the 2025 return is already filed without it, ask your accountant to request an adjustment (T1-ADJ).',
    sources: ['https://www.canada.ca/en/department-finance/programs/tax-policy/tax-credit-payment-rates-return-fuel-charge-proceeds-farmers-2024-25-2025-26.html'],
  });
  const agri = f.farm.revenuePrev ? r0(f.farm.revenuePrev * 0.01) : null;
  add({
    id: 'agriinvest', who: 'farm', level: 'Federal–provincial', kind: 'Matched savings (tax-deferred)',
    name: 'AgriInvest',
    what: 'Deposit up to 1% of allowable net sales and the government matches it. The match and the interest are taxed only when withdrawn — a year you choose. From the 2025 program year the match needs an agri-environmental risk assessment in place.',
    status: 'yes',
    value: agri,
    value_note: agri ? `About ${agri.toLocaleString('en-CA')} a year of matching on ${r0(f.farm.revenuePrev).toLocaleString('en-CA')} of last year's farm sales (allowable net sales take off commodity purchases, so it's usually less).` : 'The match is 1% of allowable net sales: free money for a deposit.',
    claim: 'File the AgriInvest form (with your tax return, or through AgriStability), make the deposit when the deposit notice comes, and have the risk assessment done.',
    sources: ['https://agriculture.canada.ca/en/agricultural-programs-and-services/agriinvest'],
  });
  add({
    id: 'lcge-farm', who: 'farm', level: 'Federal', kind: 'Exemption',
    name: 'Lifetime capital gains exemption — qualified farm property',
    what: 'Up to $1.25 million of capital gains on qualified farm property (farmland, farm quota, shares of a family farm corporation) is tax-free per person, indexed to inflation from 2026. Each spouse has their own. Intergenerational transfers to children can use it too.',
    status: 'check',
    value: null,
    value_note: 'Matters when land is sold or passed on. Ownership split between you and Ashley can double it.',
    claim: 'Claimed on the return the year of the sale (T657). Plan land ownership and succession with your accountant well ahead.',
    sources: ['https://www.fcc-fac.ca/en/knowledge/tax-rules-impact-farm-business-transfers', 'https://www.pwc.com/ca/en/services/tax/publications/tax-insights/bill-c-15-implements-changes-2025.html'],
  });
  add({
    id: 'livestock-deferral', who: 'farm', level: 'Federal', kind: 'Deferral',
    name: 'Livestock tax deferral (drought or flood years)',
    what: 'In a year your area is a prescribed region, part of the income from selling breeding livestock because of drought or excess moisture can be deferred to the next year. The list comes out each year.',
    status: 'check',
    value: null,
    value_note: 'Star City (RM 428) and the RMs around Melfort weren\'t on the 2024 list. Check the current year\'s list before selling down the herd.',
    claim: 'Elected on the return (T2042) for the year of the sale.',
    sources: ['https://agriculture.canada.ca/en/agricultural-production/weather/livestock-tax-deferral-provision/2024-list-prescribed-regions'],
  });
  add({
    id: 'family-wages', who: 'farm', level: 'Federal', kind: 'Income splitting',
    name: 'Paying family members for farm work',
    what: 'Reasonable wages paid to Ashley or the children for real farm work are a farm expense, taxed at their lower rates instead of yours. Must be for work actually done, at a fair rate, and paid (not just booked).',
    status: 'check',
    value: null,
    value_note: marginal == null ? 'Pays off in a high-income farm year.' : marginal > 26
      ? `Each $1,000 moved from your ${marginal}% marginal rate to someone at the lowest rate (about 24.5%) saves roughly ${r0(10 * (marginal - 24.5)).toLocaleString('en-CA')}.`
      : `This year you're already in the lowest bracket (${marginal}%), so there's little to gain — it pays in a high-income farm year.`,
    claim: 'Payroll: a T4 for each person paid, source deductions remitted. Keep a record of the work and hours.',
    sources: [],
  });
  add({
    id: 'clean-tech-itc', who: 'farm', level: 'Federal', kind: 'Investment tax credit',
    name: 'Clean technology investment tax credits',
    what: 'Up to 30% on solar, heat pumps and other clean technology — but only for taxable Canadian corporations. A sole proprietorship can\'t claim it.',
    status: 'no', value: null,
    value_note: 'Not available unless the farm incorporates.',
    claim: null,
    sources: [],
  });

  // ---- Household ----
  add({
    id: 'educator-supplies', who: 'ashley', level: 'Federal', kind: 'Refundable credit',
    name: 'Eligible educator school supply tax credit',
    what: '25% back on up to $1,000 a year of classroom supplies a certified teacher or early childhood educator buys with their own money and isn\'t reimbursed for — up to $250 a year.',
    status: edu === false ? 'no' : edu ? 'yes' : 'check',
    value: edu === false ? null : 250,
    value_note: edu === 'likely' ? `Her paystubs are from ${f.ashley.employer}: if she's a certified teacher or ECE, keep her supply receipts.` : edu === true ? 'Keep her supply receipts; up to $250 a year.' : edu === false ? 'Only for certified teachers and early childhood educators.' : 'If Ashley is a certified teacher or early childhood educator.',
    claim: 'Line 46900 of her return. Her employer may be asked to confirm the expenses.',
    sources: ['https://laws-lois.justice.gc.ca/eng/acts/i-3.3/section-122.9.html'],
  });
  add({
    id: 'sk-active-families', who: 'household', level: 'Saskatchewan', kind: 'Refundable benefit',
    name: 'Saskatchewan Active Families Benefit',
    what: 'Up to $300 a year per child 18 and under ($400 with a disability) for sport, culture and recreation fees, for families with adjusted net income of $120,000 or less (from the 2025 tax year).',
    status: !kids.length ? 'check' : f.familyNet == null ? 'check' : f.familyNet <= 120000 ? 'yes' : 'no',
    value: kids.length && f.familyNet != null && f.familyNet <= 120000 ? kids.length * 300 : null,
    value_note: !kids.length ? 'Add the children\'s birth years below.' : f.familyNet == null ? 'Depends on family net income.'
      : f.familyNet <= 120000 ? `Family net income looks like about ${r0(f.familyNet).toLocaleString('en-CA')} this year: under the $120,000 limit.`
        : `Family net income looks like about ${r0(f.familyNet).toLocaleString('en-CA')} this year: over the $120,000 limit.`,
    claim: 'On the Saskatchewan part of the return (form SK479). Keep the activity receipts.',
    sources: ['https://saskatchewan.ca/residents/parks-culture-heritage-and-sport/sport-and-recreation/programs-and-supports/active-families-benefit'],
  });
  add({
    id: 'sk-home-renovation', who: 'household', level: 'Saskatchewan', kind: 'Non-refundable credit',
    name: 'Saskatchewan Home Renovation Tax Credit',
    what: '10.5% of renovation costs on your principal residence between $1,000 and $5,000 a year — up to $420 ($525 for seniors). Back for 2025 and later years; expenses from October 1, 2024. Most lasting work counts: windows, flooring, roofing, decks, garages, wells and septic, landscaping.',
    status: f.profile.owns_home === false ? 'no' : 'check',
    value: f.profile.owns_home === false ? null : 420,
    value_note: 'Up to $420 a year when you renovate the house. Farm buildings don\'t count; your own labour doesn\'t.',
    claim: 'On the Saskatchewan part of the return. Keep paid invoices.',
    sources: ['https://www.saskatchewan.ca/en/Residents/Taxes-and-Investments/Tax-Credits/Home-Renovation-Tax-Credit'],
  });
  add({
    id: 'child-care-deduction', who: 'household', level: 'Federal', kind: 'Deduction',
    name: 'Child care expenses deduction',
    what: 'Daycare, day camps and babysitting so you can work are deductible: up to $8,000 a year per child under 7 and $5,000 for ages 7 to 16. Usually claimed by the lower-income spouse.',
    status: under7.length || kids.length ? (f.profile.childcare ? 'yes' : 'check') : 'check',
    value: null,
    value_note: under7.length ? `${under7.length} child${under7.length === 1 ? '' : 'ren'} under 7: up to ${(under7.length * 8000).toLocaleString('en-CA')} a year can be deducted.` : 'Add the children\'s birth years below.',
    claim: 'Form T778, on the return of whichever of you has the lower income. Receipts with the provider\'s name and SIN or business number.',
    sources: [],
  });
  add({
    id: 'ccb', who: 'household', level: 'Federal', kind: 'Tax-free benefit',
    name: 'Canada Child Benefit',
    what: 'A tax-free monthly payment for each child under 18, larger under 6, reduced as family net income rises. Every deduction that lowers family net income (RRSP, child care, AgriInvest timing) raises it.',
    status: kids.length ? 'auto' : 'check',
    value: null,
    value_note: 'Paid automatically when you both file on time. A low-income farm year raises next year\'s payments.',
    claim: 'Both of you file every year, on time.',
    sources: [],
  });
  add({
    id: 'rrsp-spousal', who: 'household', level: 'Federal', kind: 'Deduction',
    name: 'RRSP and spousal RRSP',
    what: 'Contributions come off taxable income at your marginal rate. A spousal RRSP puts the savings in Ashley\'s name, so withdrawals in retirement are taxed at her rate. Ashley\'s pension lowers her own RRSP room (pension adjustment).',
    status: marginal && marginal >= 33 ? 'yes' : 'check',
    value: null,
    value_note: marginal ? `At your ${marginal}% marginal rate, each $1,000 in saves about ${r0(10 * marginal).toLocaleString('en-CA')} this year. Room is on your notice of assessment.` : 'Worth most in a high-income farm year.',
    claim: 'Contribute by 60 days after year end; claim on Schedule 7.',
    sources: [],
  });
  add({
    id: 'training-credit', who: 'jake', level: 'Federal', kind: 'Refundable credit',
    name: 'Canada Training Credit and tuition credit',
    what: 'Tuition at a university or college earns a 15% federal credit, and the Canada Training Credit refunds half of tuition up to the $250 a year each of you builds up (ages 26–65 with $10,000+ of earnings).',
    status: f.profile.jake_tuition ? 'yes' : 'check',
    value: null,
    value_note: 'For courses at a recognized school with a T2202 slip.',
    claim: 'T2202 from the school; Schedule 11 on the return.',
    sources: [],
  });
  add({
    id: 'union-dues', who: 'ashley', level: 'Federal', kind: 'Deduction',
    name: 'Union and professional dues',
    what: 'Union and professional dues (like Teachers\' Federation fees) are deductible. They\'re on her T4 (box 44).',
    status: 'auto', value: null,
    value_note: 'Check they\'re on her return each year — tax software picks them up from the T4.',
    claim: 'Line 21200.',
    sources: [],
  });
  add({
    id: 'sk-2026-exemptions', who: 'household', level: 'Saskatchewan', kind: 'Automatic',
    name: 'Saskatchewan Affordability Act: higher exemptions',
    what: 'Saskatchewan\'s basic personal and spousal amounts are $20,381 in 2026 and each dependent child adds $8,358, all rising $500 a year to 2028.',
    status: 'auto', value: kids.length ? r0(kids.length * 8358 * 0.105) : null,
    value_note: kids.length ? `The child amounts save about ${r0(kids.length * 8358 * 0.105).toLocaleString('en-CA')} of Saskatchewan tax this year.` : null,
    claim: 'Automatic on the return; the child amount needs the children listed.',
    sources: ['https://www.cifinancial.com/ci-gam/ca/en/expert-insights/articles/tax-highlights-from-the-2026-saskatchewan-budget.html'],
  });
  add({
    id: 'top-up-credit', who: 'household', level: 'Federal', kind: 'Automatic',
    name: 'Top-up tax credit (2025–2030)',
    what: 'Keeps non-refundable credits worth 15% even though the lowest federal rate dropped to 14% — matters when credits (tuition, medical, donations) exceed the first bracket.',
    status: 'auto', value: null, value_note: 'Nothing to do.', claim: 'Automatic.',
    sources: ['https://taxnews.ey.com/news/2026-0752-canadas-2025-budget-implementation-bill-no-1-receives-royal-assent'],
  });

  const order = { yes: 0, check: 1, auto: 2, no: 3 };
  out.sort((a, b) => order[a.status] - order[b.status] || (b.value || 0) - (a.value || 0));
  return {
    year, verified: VERIFIED, profile: f.profile,
    basis: { farm_net_projected: f.farm.netProjected, family_net: f.familyNet, marginal_rate: marginal, capex: f.capex, ashley_employer: f.ashley.employer },
    programs: out,
  };
}
