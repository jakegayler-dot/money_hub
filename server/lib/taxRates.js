// Personal income tax parameters by year. Update these each January from
// CRA's payroll deductions tables (T4032SK, "General information") and
// Saskatchewan's personal income tax page.
//
// 2026 sources:
//   https://www.canada.ca/en/revenue-agency/services/forms-publications/payroll/t4032-payroll-deductions-tables/t4032sk-jan/t4032sk-january-general-information.html
//   https://www.saskatchewan.ca/residents/taxes-and-investments/personal-income-tax/personal-income-tax-structure
export const RATES = {
  2026: {
    federal: {
      brackets: [[58523, 0.14], [117045, 0.205], [181440, 0.26], [258482, 0.29], [Infinity, 0.33]],
      creditRate: 0.14,
      // Basic personal amount: full below the 4th bracket, tapering to the
      // minimum across it.
      bpaMax: 16452, bpaMin: 14829, bpaTaperFrom: 181440, bpaTaperTo: 258482,
    },
    sk: {
      brackets: [[54532, 0.105], [155805, 0.125], [Infinity, 0.145]],
      creditRate: 0.105,
      bpa: 20381,
    },
    cpp: {
      ympe: 74600, yampe: 85000, exemption: 3500,
      baseRate: 0.0495,      // per side — the part that earns the tax credit
      firstAdditional: 0.01, // per side — deductible
      cpp2Rate: 0.04,        // per side — deductible
    },
  },
};

/** The rates for `year`, or the latest year on file if it's newer. */
export function ratesFor(year) {
  if (RATES[year]) return { year, ...RATES[year], current: true };
  const latest = Math.max(...Object.keys(RATES).map(Number));
  return { year: latest, ...RATES[latest], current: false };
}

function bracketTax(income, brackets) {
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of brackets) {
    if (income <= lower) break;
    tax += (Math.min(income, upper) - lower) * rate;
    lower = upper;
  }
  return tax;
}

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Tax on self-employment (farm) income alone, for one person: CPP (both
 * halves, plus CPP2), then federal and Saskatchewan tax after the basic
 * personal amounts and the CPP credit/deduction. No other income, credits
 * or deductions.
 */
export function personalTax(netIncome, year) {
  const R = ratesFor(year);
  const ni = Math.max(0, Number(netIncome) || 0);
  const { cpp } = R;
  const pensionable = Math.max(0, Math.min(ni, cpp.ympe) - cpp.exemption);
  const base = pensionable * cpp.baseRate * 2;
  const firstAdd = pensionable * cpp.firstAdditional * 2;
  const cpp2 = Math.max(0, Math.min(ni, cpp.yampe) - cpp.ympe) * cpp.cpp2Rate * 2;
  const cppTotal = base + firstAdd + cpp2;
  // Self-employed: the "employer" half (base + additional) and the
  // employee's additional and CPP2 shares are deductions; the employee's
  // base share earns a non-refundable credit.
  const cppDeduction = base / 2 + firstAdd + cpp2;
  const cppCreditBase = base / 2;
  const taxable = Math.max(0, ni - cppDeduction);

  const F = R.federal;
  let bpa = F.bpaMax;
  if (taxable > F.bpaTaperFrom) {
    const t = Math.min(1, (taxable - F.bpaTaperFrom) / (F.bpaTaperTo - F.bpaTaperFrom));
    bpa = F.bpaMax - (F.bpaMax - F.bpaMin) * t;
  }
  const federal = Math.max(0, bracketTax(taxable, F.brackets) - (bpa + cppCreditBase) * F.creditRate);
  const S = R.sk;
  const sk = Math.max(0, bracketTax(taxable, S.brackets) - (S.bpa + cppCreditBase) * S.creditRate);
  const total = federal + sk + cppTotal;
  const marginal = (() => {
    const f = F.brackets.find(([u]) => taxable < u)?.[1] ?? 0;
    const s = S.brackets.find(([u]) => taxable < u)?.[1] ?? 0;
    return f + s;
  })();
  return {
    rates_year: R.year, rates_current: R.current,
    net_income: r2(ni), taxable_income: r2(taxable),
    cpp: r2(cppTotal), federal: r2(federal), sk: r2(sk), total: r2(total),
    average_rate: ni ? r2((total / ni) * 100) : 0,
    marginal_income_tax_rate: r2(marginal * 100),
  };
}
