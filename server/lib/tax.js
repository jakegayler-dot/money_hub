// GST returns and the farm income tax estimate.
//
// Both read the ledger the way the rest of Money Hub does (transaction
// lines: split pieces under their own owner; transfers excluded) and only
// the FARM's share — Grain + Cattle — of every line.
import { pool, getSetting } from '../db.js';
import { businessShare } from './segments.js';
import { toISODate, todayISO, addMonths } from './dates.js';
import { occurrences, signedAmount } from './estimates.js';
import { forecastEstimates } from './inventoryForecast.js';
import { billDates } from './calculations.js';
import { assetValueAt } from './balanceSheet.js';
import { personalTax } from './taxRates.js';

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12

/** Reporting periods for a year at the filing frequency. */
export function gstPeriods(year, frequency = 'quarterly') {
  const len = frequency === 'monthly' ? 1 : frequency === 'annual' ? 12 : 3;
  const out = [];
  for (let m = 1; m <= 12; m += len) {
    const endM = m + len - 1;
    const start = `${year}-${String(m).padStart(2, '0')}-01`;
    const end = `${year}-${String(endM).padStart(2, '0')}-${lastDay(year, endM)}`;
    // Monthly and quarterly filers: due one month after the period ends.
    // Annual filers (individuals with business income): June 15 — but the
    // GST owing is still due April 30.
    let due;
    if (len === 12) due = `${year + 1}-06-15`;
    else {
      const dueStart = addMonths(`${end.slice(0, 7)}-01`, 1);
      const [dy, dm] = dueStart.split('-').map(Number);
      due = `${dueStart.slice(0, 7)}-${lastDay(dy, dm)}`;
    }
    out.push({ start, end, due, label: len === 12 ? `${year}` : len === 3 ? `Q${(m + 2) / 3} ${year}` : start.slice(0, 7) });
  }
  return out;
}

/**
 * GST for one year by period: collected on farm sales, input tax credits
 * on farm purchases (the farm share of any GST recorded), and the net —
 * negative is a refund to the farm. Also counts farm purchases with no GST
 * recorded, so missing receipts are visible.
 */
export async function gstReport(year) {
  const frequency = String(await getSetting('gst_filing_frequency', 'quarterly'));
  const periods = gstPeriods(year, frequency);
  const [{ rows }, { rows: returns }] = await Promise.all([
    pool.query(
      `SELECT t.id, t.date, t.amount, t.gst_amount, t.ledger, t.segment, t.is_segment_split,
              t.segment_grain_pct, t.segment_livestock_pct, t.segment_jake_pct, t.segment_ashley_pct
       FROM transactions t
       WHERE NOT t.is_transfer AND NOT t.is_debt_service AND EXTRACT(YEAR FROM t.date) = $1`,
      [year]
    ),
    pool.query(`SELECT * FROM gst_returns WHERE EXTRACT(YEAR FROM period_start) = $1`, [year]),
  ]);
  const byStart = new Map(returns.map((r) => [toISODate(r.period_start), r]));
  const today = todayISO();
  const out = periods.map((p) => ({ ...p, collected: 0, itc: 0, purchases: 0, purchases_no_gst: 0, purchases_no_gst_amount: 0 }));
  for (const t of rows) {
    const d = toISODate(t.date);
    const p = out.find((x) => d >= x.start && d <= x.end);
    if (!p) continue;
    const share = businessShare(t);
    if (!share) continue;
    const amt = Number(t.amount);
    const gst = t.gst_amount == null ? null : Number(t.gst_amount);
    if (amt < 0) {
      p.purchases += 1;
      if (gst == null) { p.purchases_no_gst += 1; p.purchases_no_gst_amount += -amt * share; }
      else p.itc += gst * share;
    } else if (gst) {
      p.collected += gst * share;
    }
  }
  return {
    year, frequency,
    periods: out.map((p) => {
      const ret = byStart.get(p.start);
      const net = r2(p.collected - p.itc);
      return {
        ...p,
        collected: r2(p.collected), itc: r2(p.itc), net,
        purchases_no_gst_amount: r2(p.purchases_no_gst_amount),
        status: ret?.settlement_transaction_id ? 'settled' : ret?.filed_on ? 'filed' : p.end >= today ? 'current' : p.due < today ? 'overdue' : 'to_file',
        filed_on: ret?.filed_on ? toISODate(ret.filed_on) : null,
        filed_net: ret?.net_amount != null ? Number(ret.net_amount) : null,
        settlement_transaction_id: ret?.settlement_transaction_id || null,
        notes: ret?.notes || null,
      };
    }),
  };
}

/**
 * The farm's net income for the year on the cash method, and the tax on
 * it. Actual = Jan 1 to today from the ledger. Projected adds what's
 * forecast to land by Dec 31: open contracts, uncontracted inventory sales,
 * cash estimates, unpaid bills and loan interest — all at the farm's share.
 * Amounts are net of GST (it's neither income nor expense). Capital
 * purchases are replaced by CCA. `whatIf` adjusts the projection.
 */
export async function farmIncomeTax(year, whatIf = {}) {
  const today = todayISO();
  const yStart = `${year}-01-01`;
  const yEnd = `${year}-12-31`;
  const yEndExcl = `${year + 1}-01-01`;
  const asOf = today < yEnd ? today : yEnd;

  const [{ rows: lines }, { rows: contracts }, { rows: bills }, { rows: loanPays }, { rows: accounts }, { rows: assets }, estimates,
    ccaOverride, priorYear, paid] = await Promise.all([
    // Each line with its transaction's GST spread across split pieces by size.
    pool.query(
      `SELECT l.amount, l.split_id, l.is_capex, l.is_debt_service, l.ledger, l.segment, l.is_segment_split,
              l.segment_grain_pct, l.segment_livestock_pct, l.segment_jake_pct, l.segment_ashley_pct,
              t.amount AS tx_amount, t.gst_amount, lp.interest_amount, t.amount AS paid_amount
       FROM transaction_lines l
       JOIN transactions t ON t.id = l.transaction_id
       LEFT JOIN loan_payments lp ON lp.linked_transaction_id = l.transaction_id
       WHERE NOT l.is_transfer AND l.date >= $1 AND l.date <= $2`,
      [yStart, asOf]
    ),
    pool.query(
      `SELECT GREATEST(total_value - received_amount, 0) AS amount, expected_payment_date AS d, segment FROM sale_contracts
       WHERE status IN ('open', 'delivered') AND expected_payment_date >= $1 AND expected_payment_date < $2`,
      [today, yEndExcl]
    ),
    pool.query(
      `SELECT due_date, bill_owing(bills, due_date) AS amount, frequency, gst_amount, has_gst, ledger, segment, is_segment_split,
              segment_grain_pct, segment_livestock_pct, segment_jake_pct, segment_ashley_pct
       FROM bills WHERE status = 'unpaid' AND due_date < $1`,
      [yEndExcl]
    ),
    pool.query(
      `SELECT lp.due_date, lp.interest_amount, l.segment FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
       WHERE NOT lp.paid AND NOT lp.is_adjustment AND lp.due_date < $1`,
      [yEndExcl]
    ),
    pool.query(`SELECT fee_amount, fee_frequency, ledger, segment, is_segment_split, segment_grain_pct, segment_livestock_pct,
                       segment_jake_pct, segment_ashley_pct FROM accounts`),
    pool.query(`SELECT * FROM assets`),
    forecastEstimates(),
    getSetting(`tax_cca_${year}`, null),
    getSetting(`tax_prior_year_owing_${year}`, null),
    getSetting(`tax_instalment_paid_${year}`, null),
  ]);

  // ---- Actual, Jan 1 to today ----
  const actual = { revenue: 0, expenses: 0, interest: 0, capex: 0 };
  for (const l of lines) {
    const share = businessShare(l);
    if (!share) continue;
    const amt = Number(l.amount);
    if (l.is_capex) { actual.capex += -amt * share; continue; }
    // A loan payment: its interest piece (principal pieces are transfers,
    // filtered out above); one recorded before the split, the schedule's interest.
    if (l.is_debt_service) { actual.interest += (l.split_id != null ? -amt : Number(l.interest_amount || 0)) * share; continue; }
    // GST on this line: the transaction's GST in proportion to this piece.
    const gst = l.gst_amount == null || !Number(l.tx_amount) ? 0 : Number(l.gst_amount) * (amt / Number(l.tx_amount));
    const net = amt - Math.sign(amt) * Math.abs(gst);
    if (net >= 0) actual.revenue += net * share;
    else actual.expenses += -net * share;
  }

  // ---- Forecast, today to Dec 31 ----
  const fc = { revenue: 0, expenses: 0, interest: 0, items: [] };
  const addFc = (label, amount) => {
    if (!amount) return;
    if (amount > 0) fc.revenue += amount; else fc.expenses += -amount;
    fc.items.push({ label, amount: r2(amount) });
  };
  let contractsIn = 0;
  for (const c of contracts) contractsIn += Number(c.amount) * businessShare({ segment: c.segment });
  addFc('Open contracts paid by Dec 31', contractsIn);
  let estIn = 0;
  let estOut = 0;
  for (const e of estimates) {
    const share = businessShare(e);
    if (!share) continue;
    for (const _ of occurrences(e, today, yEndExcl)) {
      const v = signedAmount(e) * share;
      if (v > 0) estIn += v; else estOut += v;
    }
  }
  addFc('Estimated income incl. inventory sales by Dec 31', estIn);
  addFc('Estimated costs by Dec 31', estOut);
  let billsOut = 0;
  for (const b of bills) {
    const share = businessShare(b);
    if (!share) continue;
    const perBill = Number(b.amount) - (b.has_gst ? Number(b.gst_amount || 0) : 0);
    billsOut -= billDates(b, today, yEndExcl).length * perBill * share;
  }
  addFc('Unpaid bills due by Dec 31 (before GST)', billsOut);
  let interest = 0;
  for (const p of loanPays) interest += Number(p.interest_amount) * businessShare({ segment: p.segment });
  if (interest) { fc.interest += interest; fc.items.push({ label: 'Loan interest due by Dec 31', amount: r2(-interest) }); }
  const monthsLeft = today >= yEnd ? 0 : 12 - Number(today.slice(5, 7));
  let fees = 0;
  for (const a of accounts) {
    const amt = Number(a.fee_amount) || 0;
    const monthly = a.fee_frequency === 'monthly' ? amt : a.fee_frequency === 'annual' ? amt / 12 : 0;
    fees += monthly * monthsLeft * businessShare(a);
  }
  addFc('Account fees to Dec 31', -fees);

  // ---- CCA ----
  // Estimate: each depreciating farm asset's value on Jan 1 × its rate.
  // Book value, not the CRA's undepreciated capital cost — replace it with
  // your accountant's figure when you have it.
  let ccaEstimate = 0;
  const ccaAssets = [];
  for (const a of assets) {
    const rate = Number(a.annual_change_pct);
    const share = businessShare(a);
    if (rate >= 0 || !share) continue;
    const start = assetValueAt(a, yStart > toISODate(a.value_date) ? yStart : toISODate(a.value_date));
    const amount = start * (-rate / 100) * share;
    ccaEstimate += amount;
    ccaAssets.push({ name: a.name, cca_class: a.cca_class, value: r2(start), rate: -rate, amount: r2(amount) });
  }
  const cca = ccaOverride != null ? Number(ccaOverride) : ccaEstimate;

  const deferSales = Math.max(0, Number(whatIf.defer_sales) || 0);
  const prepay = Math.max(0, Number(whatIf.prepay_inputs) || 0);
  const oia = Math.max(0, Number(whatIf.oia) || 0);

  const build = (adjust) => {
    const revenue = actual.revenue + fc.revenue - (adjust ? deferSales : 0);
    const expenses = actual.expenses + fc.expenses + actual.interest + fc.interest + (adjust ? prepay : 0);
    const net = revenue - expenses - cca + (adjust ? oia : 0);
    return { revenue: r2(revenue), expenses: r2(expenses), cca: r2(cca), oia: adjust ? r2(oia) : 0, net_income: r2(net), tax: personalTax(net, year) };
  };
  const actualOnly = (() => {
    const net = actual.revenue - actual.expenses - actual.interest;
    return { revenue: r2(actual.revenue), expenses: r2(actual.expenses + actual.interest), net_income: r2(net) };
  })();
  const projected = build(false);
  const scenario = (deferSales || prepay || oia) ? build(true) : null;

  // ---- Dec 31 instalment ----
  // Farmers pay one instalment, by Dec 31, when tax owing is over $3,000
  // this year and in either of the two previous years: two-thirds of this
  // year's estimated tax, or two-thirds of last year's — whichever is less.
  const basis = scenario || projected;
  const estimateMethod = basis.tax.total * 2 / 3;
  const priorMethod = priorYear != null ? Number(priorYear) * 2 / 3 : null;
  const amount = priorMethod != null ? Math.min(estimateMethod, priorMethod) : estimateMethod;
  const instalment = {
    due: `${year}-12-31`,
    required: basis.tax.total > 3000,
    estimate_method: r2(estimateMethod),
    prior_year_method: priorMethod == null ? null : r2(priorMethod),
    amount: basis.tax.total > 3000 ? r2(amount) : 0,
    prior_year_owing: priorYear != null ? Number(priorYear) : null,
    paid: paid || null,
  };

  return {
    year, as_of: asOf,
    actual: { ...actualOnly, capex: r2(actual.capex) },
    forecast: { revenue: r2(fc.revenue), expenses: r2(fc.expenses + fc.interest), items: fc.items },
    cca: { amount: r2(cca), estimate: r2(ccaEstimate), override: ccaOverride != null ? Number(ccaOverride) : null, assets: ccaAssets },
    projected, scenario,
    what_if: { defer_sales: deferSales, prepay_inputs: prepay, oia },
    instalment,
  };
}
