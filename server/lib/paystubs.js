// Paystubs (Jake, 2026-10-24): Ashley's agent sends each paystub through
// the paystub API. A stub is hers (or Jake's), is matched to the deposit of
// its net pay — which then books as her wages, not as uncategorized income —
// and feeds an analysis: year to date, tax withheld against what her pay
// will actually owe, CPP and EI against the year's maximums, pension and
// RRSP taken off, how her pay is moving, and her next pays in the cash
// forecast.
//
// Summer holdback (Jake, 2026-10-24): Ashley is paid ten months of the year.
// Payroll holds part of each September-to-June pay back and pays the held
// amount out half in July and half in August. The holdback is her money, not
// a deduction lost: it's tracked as a balance, the summer payouts are their
// own stubs (holdback_paid, usually with no gross), and the forecast has no
// regular pays in July and August but the two payouts instead.
import { pool } from '../db.js';
import { payeeId } from './postings.js';
import { closedMonth } from './periods.js';
import { employeeTax } from './taxRates.js';
import { toISODate, addDays, todayISO } from './dates.js';

export const OWNERS = ['ashley', 'jake'];
export const DEDUCTION_TYPES = {
  income_tax: 'Income tax', cpp: 'CPP', cpp2: 'CPP2', ei: 'EI', pension: 'Pension (RPP)', rrsp: 'Group RRSP',
  union_dues: 'Union dues', benefits: 'Benefits', holdback: 'Summer holdback', other: 'Other',
};
// Her summer months: no regular pay; the holdback is paid out instead, half in each.
export const SUMMER = [7, 8];
const isSummer = (d) => SUMMER.includes(Number(String(d).slice(5, 7)));
/** The summer (its year) a pay date's holdback is paid out in: September to June builds the next July and August. */
export const holdbackSummerOf = (d) => Number(d.slice(0, 4)) + (Number(d.slice(5, 7)) >= 9 ? 1 : 0);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const money = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : r2(Number(v)));

/** A deduction's type from what an agent calls it ("Federal tax", "CPP2", "Dental"). */
export function deductionType(raw) {
  const s = String(raw || '').toLowerCase();
  if (DEDUCTION_TYPES[s]) return s;
  if (/hold\s*-?\s*back|defer|summer|10\s*(\/|over|-)\s*12|ten\s*-?\s*month/.test(s)) return 'holdback';
  if (/cpp\s*2|second.*cpp|cpp.*additional/.test(s)) return 'cpp2';
  if (/\bcpp\b|canada pension/.test(s)) return 'cpp';
  if (/\bei\b|employment insurance|\buic\b/.test(s)) return 'ei';
  if (/tax|withholding/.test(s)) return 'income_tax';
  if (/rrsp|registered retirement savings/.test(s)) return 'rrsp';
  if (/pension|\brpp\b|lapp|saskatchewan teachers|dbp|dcp/.test(s)) return 'pension';
  if (/union|dues/.test(s)) return 'union_dues';
  if (/benefit|health|dental|life|ltd|disab|insurance|gis/.test(s)) return 'benefits';
  return 'other';
}

/**
 * Checks and tidies one stub from an agent. Returns { stub, warnings } or
 * { error }. Deductions may come as a list [{ type|label, amount }] or as
 * flat fields (income_tax, cpp, cpp2, ei, pension, rrsp, union_dues, benefits).
 */
export function normalizeStub(b = {}) {
  const owner = OWNERS.includes(String(b.owner || '').toLowerCase()) ? String(b.owner).toLowerCase() : 'ashley';
  const employer = String(b.employer || '').trim().slice(0, 120);
  if (!employer) return { error: 'employer is required.' };
  if (!isDate(b.pay_date)) return { error: 'pay_date is required, YYYY-MM-DD.' };
  for (const k of ['period_start', 'period_end']) if (b[k] != null && b[k] !== '' && !isDate(b[k])) return { error: `${k} must be YYYY-MM-DD.` };
  let gross = money(b.gross) ?? 0;
  const net = money(b.net);
  let holdbackPaid = money(b.holdback_paid ?? b.holdback_payout) ?? 0;
  // A summer stub with no earnings is the holdback being paid out.
  if (!(gross > 0) && !(holdbackPaid > 0) && net > 0 && isSummer(b.pay_date)) holdbackPaid = net;
  if (gross < 0 || holdbackPaid < 0) return { error: 'gross and holdback_paid can\'t be negative.' };
  if (!(gross > 0) && !(holdbackPaid > 0)) return { error: 'gross is required: the pay before deductions (or holdback_paid, for a summer payout of held-back pay).' };
  gross = r2(gross);
  if (net == null || !(net >= 0)) return { error: 'net is required: the pay deposited.' }; // null >= 0 is true in JS
  const list = [];
  if (Array.isArray(b.deductions)) {
    for (const d of b.deductions) {
      const amount = money(d?.amount);
      if (amount == null) continue;
      const label = String(d.label || d.name || DEDUCTION_TYPES[d.type] || d.type || 'Deduction').trim().slice(0, 80);
      list.push({ type: d.type && DEDUCTION_TYPES[d.type] ? d.type : deductionType(d.type || label), label, amount });
    }
  }
  for (const k of Object.keys(DEDUCTION_TYPES)) {
    const amount = money(b[k]);
    if (amount != null && amount !== 0 && !list.some((d) => d.type === k)) list.push({ type: k, label: DEDUCTION_TYPES[k], amount });
  }
  const warnings = [];
  const taken = r2(list.reduce((s, d) => s + d.amount, 0));
  const expected = r2(gross + holdbackPaid - taken);
  if (Math.abs(expected - net) > 1) {
    warnings.push(`Gross ${gross}${holdbackPaid ? ` plus holdback paid out ${holdbackPaid}` : ''} less deductions ${taken} is ${expected}, not the net ${net}: a deduction may be missing (or a non-cash benefit included).`);
  }
  const ytd = b.ytd && typeof b.ytd === 'object' && !Array.isArray(b.ytd)
    ? Object.fromEntries(Object.entries(b.ytd).map(([k, v]) => [k === 'gross' || k === 'net' ? k : deductionType(k), money(v)]).filter(([, v]) => v != null))
    : null;
  return {
    stub: {
      owner, employer, pay_date: b.pay_date, period_start: b.period_start || null, period_end: b.period_end || null,
      gross, net, holdback_paid: holdbackPaid, deductions: list, ytd, hours: money(b.hours), hourly_rate: money(b.hourly_rate),
      source: String(b.source || 'agent').slice(0, 40), external_id: b.external_id != null ? String(b.external_id).slice(0, 120) : null,
      notes: b.notes ? String(b.notes).slice(0, 500) : null,
    },
    warnings,
  };
}

/** Saves a stub (an existing one with the same source + external_id, or the same employer, date and net, is updated). */
export async function saveStub(stub, warnings = [], doc = null, db = pool) {
  let { rows: [old] } = stub.external_id
    ? await db.query('SELECT id FROM paystubs WHERE source = $1 AND external_id = $2', [stub.source, stub.external_id])
    : { rows: [] };
  if (!old) {
    ({ rows: [old] } = await db.query(
      'SELECT id FROM paystubs WHERE owner = $1 AND lower(employer) = lower($2) AND pay_date = $3 AND net = $4', [stub.owner, stub.employer, stub.pay_date, stub.net]));
  }
  const vals = [stub.owner, stub.employer, stub.pay_date, stub.period_start, stub.period_end, stub.gross, stub.net,
    JSON.stringify(stub.deductions), stub.ytd ? JSON.stringify(stub.ytd) : null, stub.hours, stub.hourly_rate, stub.source, stub.external_id,
    stub.notes, JSON.stringify(warnings), stub.holdback_paid || 0];
  let id;
  if (old) {
    await db.query(
      `UPDATE paystubs SET owner=$1, employer=$2, pay_date=$3, period_start=$4, period_end=$5, gross=$6, net=$7, deductions=$8, ytd=$9,
         hours=$10, hourly_rate=$11, source=$12, external_id=COALESCE($13, external_id), notes=$14, warnings=$15, holdback_paid=$16, updated_at=now() WHERE id=$17`, [...vals, old.id]);
    id = old.id;
  } else {
    const { rows: [r] } = await db.query(
      `INSERT INTO paystubs (owner, employer, pay_date, period_start, period_end, gross, net, deductions, ytd, hours, hourly_rate, source, external_id, notes, warnings, holdback_paid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, vals);
    id = r.id;
  }
  if (doc) await db.query('UPDATE paystubs SET doc = $2, doc_mime = $3 WHERE id = $1', [id, doc.bytes, doc.mime]);
  const matched = await matchStub(id, db);
  return { id, updated: !!old, matched_transaction_id: matched };
}

const ownerAccountPref = (owner) => `CASE WHEN a.segment::text = '${owner}' AND NOT a.is_segment_split THEN 0 WHEN a.ledger = 'personal' THEN 1 ELSE 2 END`;

/**
 * Finds the deposit of a stub's net pay (the same amount, from 3 days before
 * the pay date to 7 after; the owner's own accounts first) and books it as
 * the owner's wages. Returns the transaction id, or null.
 */
export async function matchStub(id, db = pool) {
  const { rows: [s] } = await db.query('SELECT * FROM paystubs WHERE id = $1', [id]);
  if (!s || s.transaction_id || !(Number(s.net) > 0)) return s?.transaction_id || null;
  const pay = toISODate(s.pay_date);
  const { rows: [t] } = await db.query(
    `SELECT t.id, t.date FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.account_id IS NOT NULL AND abs(t.amount - $1) < 0.005 AND t.date BETWEEN $2::date AND $3::date
       AND NOT t.is_transfer AND NOT t.is_split
       AND NOT EXISTS (SELECT 1 FROM paystubs p WHERE p.transaction_id = t.id)
     ORDER BY ${ownerAccountPref(s.owner)}, abs(t.date - $4::date), t.id LIMIT 1`,
    [s.net, addDays(pay, -3), addDays(pay, 7), pay]);
  if (!t) return null;
  if (await closedMonth(db, toISODate(t.date))) return null;
  const { rows: [cat] } = await db.query(`SELECT id FROM expense_categories WHERE lower(name) = 'wages & salary' LIMIT 1`);
  const payee = await payeeId(db, s.employer);
  await db.query(
    `UPDATE transactions SET category_id = $2, ledger = 'personal', segment = $3, is_segment_split = false,
       segment_grain_pct = NULL, segment_livestock_pct = NULL, segment_jake_pct = NULL, segment_ashley_pct = NULL,
       payee_id = COALESCE(payee_id, $4), needs_review = false, review_note = NULL WHERE id = $1`,
    [t.id, cat?.id || null, s.owner, payee]);
  await db.query('UPDATE paystubs SET transaction_id = $2 WHERE id = $1', [s.id, t.id]);
  return t.id;
}

/** Every stub still without its deposit (run after statements arrive, and every six hours). */
export async function matchAllStubs(db = pool) {
  const { rows } = await db.query(`SELECT id FROM paystubs WHERE transaction_id IS NULL AND pay_date > CURRENT_DATE - 120 ORDER BY pay_date`);
  let n = 0;
  for (const r of rows) if (await matchStub(r.id, db)) n++;
  return n;
}

const sumType = (stubs, type) => r2(stubs.reduce((s, st) => s + (st.deductions || []).filter((d) => d.type === type).reduce((a, d) => a + Number(d.amount), 0), 0));
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

/** How often she's paid, from the gaps between pay dates. */
export function payFrequency(dates) {
  const ds = [...new Set(dates)].sort();
  const gaps = ds.slice(1).map((d, i) => Math.round((Date.parse(d) - Date.parse(ds[i])) / 86400000));
  const g = median(gaps);
  if (g == null) return null;
  if (g <= 9) return { label: 'weekly', days: 7, per_year: 52 };
  if (g <= 14.5) return { label: 'every two weeks', days: 14, per_year: 26 };
  if (g <= 17) return { label: 'twice a month', days: 15, per_year: 24 };
  return { label: 'monthly', days: 30, per_year: 12 };
}

/** Next pay dates after `from` through `until`, from the last pay date and the frequency. */
export function nextPayDates(last, freq, until) {
  const out = [];
  let d = last;
  for (let k = 0; k < 60; k++) {
    if (freq.label === 'twice a month') {
      const [y, m, day] = d.split('-').map(Number);
      d = day < 15 ? `${y}-${String(m).padStart(2, '0')}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`
        : toISODate(new Date(Date.UTC(y, m, 15)));
    } else if (freq.label === 'monthly') {
      const [y, m, day] = d.split('-').map(Number);
      const last2 = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      d = toISODate(new Date(Date.UTC(y, m, Math.min(day, last2))));
    } else d = addDays(d, freq.days);
    if (d >= until) break;
    out.push(d);
  }
  return out;
}

/** Regular pay dates after `last` through `until`: none in July and August when she's on a holdback. */
export function regularPayDates(last, freq, until, holdback) {
  return nextPayDates(last, freq, until).filter((d) => !holdback || !isSummer(d));
}

/** The day her summer payout lands in a month: her last usual payday in it (her schedule run on), else the month end. */
function payoutDate(month, lastRegular, freq) {
  const end = toISODate(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)));
  if (!freq || !lastRegular || lastRegular > end) return end;
  const ds = nextPayDates(lastRegular, freq, addDays(end, 1)).filter((d) => d.startsWith(month));
  return ds.length ? ds[ds.length - 1] : end;
}

const stubRow = (r) => ({ ...r, pay_date: toISODate(r.pay_date), period_start: r.period_start ? toISODate(r.period_start) : null,
  period_end: r.period_end ? toISODate(r.period_end) : null, gross: Number(r.gross), net: Number(r.net), holdback_paid: Number(r.holdback_paid || 0) });
const isRegular = (x) => x.gross > 0;

/**
 * The holdback for one summer: saved from the September before to June
 * (stubs on file, then the average holdback for each pay still to come),
 * paid out so far, and the July and August payouts still to come (half
 * each; August is whatever July left).
 */
export async function holdbackPlan(owner, summer, { today = todayISO() } = {}, db = pool) {
  const from = `${summer - 1}-09-01`;
  const juneEnd = `${summer}-06-30`;
  const { rows } = await db.query(
    `SELECT pay_date, gross, net, holdback_paid, deductions FROM paystubs WHERE owner = $1 AND pay_date >= $2 AND pay_date <= $3 ORDER BY pay_date, id`,
    [owner, addDays(from, -400), `${summer}-08-31`]);
  const all = rows.map(stubRow);
  const regular = all.filter(isRegular);
  const inCycle = regular.filter((x) => x.pay_date >= from && x.pay_date <= juneEnd);
  const saved = sumType(inCycle, 'holdback');
  const recent = regular.slice(-3);
  const perPay = recent.length ? r2(recent.reduce((a, x) => a + sumType([x], 'holdback'), 0) / recent.length) : 0;
  const freq = payFrequency(regular.map((x) => x.pay_date));
  const lastRegular = regular.length ? regular[regular.length - 1].pay_date : null;
  const toCome = freq && lastRegular && perPay > 0
    ? regularPayDates(lastRegular, freq, addDays(juneEnd, 1), true).filter((d) => d >= from && d >= today) : [];
  const projected = r2(saved + perPay * toCome.length);
  const paid = { 7: 0, 8: 0 };
  for (const x of all) if (x.holdback_paid > 0 && x.pay_date > juneEnd) paid[Number(x.pay_date.slice(5, 7))] += x.holdback_paid;
  const paidOut = r2(paid[7] + paid[8]);
  const payouts = [];
  const july = `${summer}-07`;
  const aug = `${summer}-08`;
  if (!(paid[7] > 0)) payouts.push({ month: july, date: payoutDate(july, lastRegular, freq), amount: r2(projected / 2) });
  if (!(paid[8] > 0)) payouts.push({ month: aug, date: payoutDate(aug, lastRegular, freq), amount: r2(paid[7] > 0 ? projected - paid[7] : projected / 2) });
  return {
    summer, school_year: `${summer - 1}–${String(summer).slice(2)}`, saved, per_pay: perPay, pays_to_come: toCome.length,
    projected_by_june: projected, paid_out: paidOut, balance: r2(saved - paidOut),
    payouts: payouts.filter((p) => p.amount > 0.005),
  };
}

/** Whether she's on a summer holdback: any held back in the last 400 days, or a payout. */
async function onHoldback(owner, today, db) {
  const { rows } = await db.query(
    `SELECT 1 FROM paystubs WHERE owner = $1 AND pay_date > $2::date - 400 AND pay_date <= $2::date
       AND (holdback_paid > 0 OR deductions @> '[{"type":"holdback"}]') LIMIT 1`, [owner, today]);
  return rows.length > 0;
}

/**
 * The analysis for one owner and year: totals, the tax outlook (withheld vs
 * what the year's pay will owe), CPP and EI against their maximums, pension
 * and RRSP, the summer holdback, the pay trend, and the next pay dates.
 */
export async function paystubSummary({ owner = 'ashley', year = Number(todayISO().slice(0, 4)), today = todayISO() } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT id, owner, employer, pay_date, period_start, period_end, gross, net, holdback_paid, deductions, ytd, hours, hourly_rate, transaction_id, warnings,
            doc_mime IS NOT NULL AS has_doc
     FROM paystubs WHERE owner = $1 AND EXTRACT(YEAR FROM pay_date) = $2 ORDER BY pay_date, id`, [owner, year]);
  const stubs = rows.map(stubRow);
  if (!stubs.length) return { owner, year, stubs: [], totals: null };
  const regular = stubs.filter(isRegular);
  const holdback = await onHoldback(owner, year < Number(today.slice(0, 4)) ? `${year}-12-31` : today, db);
  const gross = r2(stubs.reduce((s, x) => s + x.gross, 0));
  const net = r2(stubs.reduce((s, x) => s + x.net, 0));
  const t = Object.fromEntries(Object.keys(DEDUCTION_TYPES).map((k) => [k, sumType(stubs, k)]));
  const holdbackPaid = r2(stubs.reduce((s, x) => s + x.holdback_paid, 0));
  const freq = payFrequency(regular.map((s) => s.pay_date));
  const last = stubs[stubs.length - 1];
  const lastRegular = regular.length ? regular[regular.length - 1] : last;
  const yearEnd = `${year + 1}-01-01`;
  const left = freq && year >= Number(today.slice(0, 4)) ? regularPayDates(lastRegular.pay_date, freq, yearEnd, holdback) : [];
  const recent = (regular.length ? regular : stubs).slice(-3);
  const avg = (f) => r2(recent.reduce((s, x) => s + f(x), 0) / recent.length);
  const perPay = { gross: avg((x) => x.gross), net: avg((x) => x.net), income_tax: avg((x) => sumType([x], 'income_tax')) };
  const share = regular.length ? left.length / regular.length : 0;
  const projected = {
    gross: r2(gross + perPay.gross * left.length),
    income_tax_withheld: r2(t.income_tax + perPay.income_tax * left.length),
    rpp: r2(t.pension * (1 + share)), rrsp: r2(t.rrsp * (1 + share)), union: r2(t.union_dues * (1 + share)),
  };
  const due = employeeTax(projected.gross, { rpp: projected.rpp, rrsp: projected.rrsp, union: projected.union }, year);
  const diff = r2(projected.income_tax_withheld - due.income_tax);
  // CPP and EI: when the year's maximum is reached, they stop coming off.
  const maxOut = (type, max) => {
    const sofar = t[type];
    const perStub = avg((x) => sumType([x], type));
    if (!max) return null;
    if (sofar >= max - 0.5) return { paid: sofar, max, reached: true, on: null };
    if (!(perStub > 0) || !left.length) return { paid: sofar, max, reached: false, on: null };
    let acc = sofar;
    for (const d of left) { acc += perStub; if (acc >= max - 0.5) return { paid: sofar, max, reached: false, on: d }; }
    return { paid: sofar, max, reached: false, on: null };
  };
  // The summer it's building toward: this year's while it's still to be paid (to August), else next year's.
  let plan = null;
  if (holdback) {
    const y = Number(today.slice(0, 4));
    const summer = year < y ? year : Number(today.slice(5, 7)) >= 9 ? y + 1 : y;
    plan = await holdbackPlan(owner, summer, { today }, db);
  }
  // The stub's own year-to-date figures, when it prints them, are the check on ours.
  const ytdCheck = last.ytd && last.ytd.gross != null && Math.abs(Number(last.ytd.gross) - gross) > 1 && Math.abs(Number(last.ytd.gross) - gross - holdbackPaid) > 1
    ? `The latest stub shows ${r2(last.ytd.gross)} gross year to date; the stubs on file add up to ${gross}. Some stubs this year may be missing.`
    : null;
  return {
    owner, year, employers: [...new Set(stubs.map((s) => s.employer))],
    frequency: freq?.label || null, pays_on_file: stubs.length, pays_left: left.length, next_pays: left.slice(0, 3),
    totals: { gross, net, ...t, holdback_paid: holdbackPaid, take_home_pct: gross ? r2(((net - holdbackPaid) / gross) * 100) : null },
    per_pay: perPay,
    tax_outlook: {
      projected_gross: projected.gross, withheld: projected.income_tax_withheld, owed: due.income_tax,
      difference: diff, result: Math.abs(diff) < 100 ? 'about even' : diff > 0 ? 'refund' : 'owing',
      rates_year: due.rates_year, note: 'Her pay alone: no other income, credits or deductions (RRSP contributions outside work, childcare, medical, donations) — those would move it.'
        + (holdback ? ' The holdback is counted in the year it\'s earned, as payroll withholds tax on it then.' : ''),
    },
    cpp: maxOut('cpp', due.max.cpp), cpp2: due.max.cpp2 ? { paid: t.cpp2, max: due.max.cpp2 } : null, ei: maxOut('ei', due.max.ei),
    retirement: { pension: t.pension, group_rrsp: t.rrsp, note: 'A pension adjustment (on her T4) lowers next year\'s RRSP room; group RRSP contributions use this year\'s.' },
    holdback: plan,
    trend: stubs.map((s) => ({ pay_date: s.pay_date, gross: s.gross, net: s.net, hours: s.hours != null ? Number(s.hours) : null })),
    check: ytdCheck,
    stubs: stubs.map((s) => ({ ...s, has_doc: !!s.has_doc, matched: !!s.transaction_id })),
  };
}

/** Days of July and August between two dates (her summer, when no regular pay is due). */
function summerDays(from, to) {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (isSummer(d)) n++;
  return n;
}

/**
 * Her next pays as expected income in the cash forecast (estimates,
 * personal): regular pays at her recent take-home from the last stub and the
 * frequency — none in July and August when she's on a holdback, but the
 * holdback paid out half in each instead. Skipped when an active estimate
 * already looks like her pay, so it isn't counted twice.
 */
export async function paystubForecastFlows({ today, endStr }, db = pool) {
  const out = [];
  for (const owner of OWNERS) {
    const { rows } = await db.query(
      `SELECT pay_date, gross, net, holdback_paid, deductions, employer FROM paystubs WHERE owner = $1 AND pay_date > $2::date - 150 AND pay_date <= $2::date
       ORDER BY pay_date`, [owner, today]);
    const regular = rows.map(stubRow).filter(isRegular);
    if (regular.length < 2) continue;
    const holdback = await onHoldback(owner, today, db);
    const dates = regular.map((r) => r.pay_date);
    const freq = payFrequency(dates);
    if (!freq) continue;
    const last = dates[dates.length - 1];
    const gap = (Date.parse(today) - Date.parse(last)) / 86400000 - (holdback ? summerDays(last, today) : 0);
    if (gap > freq.days * 3) continue; // stopped: no recent pay
    const recent = regular.slice(-3);
    const net = r2(recent.reduce((s, r) => s + r.net, 0) / recent.length);
    const name = owner === 'ashley' ? 'Ashley' : 'Jake';
    const her = owner === 'ashley' ? 'her' : 'his';
    const { rows: dup } = await db.query(
      `SELECT 1 FROM cash_estimates WHERE status = 'active' AND direction = 'inflow'
         AND (name ~* '(pay|wage|salary|paycheque|paycheck)') AND (segment::text = $1 OR name ~* $2) LIMIT 1`, [owner, name]);
    if (dup.length) continue;
    for (const d of regularPayDates(last, freq, endStr, holdback)) {
      if (d < today) continue;
      out.push({ key: `pay:${owner}:${d}`, kind: 'estimate_in', label: `${name}'s pay (from ${her} paystubs)`,
        date: d, amount: net, farm: 0, taxable: 0, estimate: true, ref: { paystub: true, owner } });
    }
    if (!holdback) continue;
    // Each summer in the window: the holdback paid out in July and August.
    const firstSummer = Number(today.slice(0, 4)) + (Number(today.slice(5, 7)) >= 9 ? 1 : 0);
    for (let summer = firstSummer; `${summer}-07-01` < endStr; summer++) {
      const plan = await holdbackPlan(owner, summer, { today }, db);
      for (const p of plan.payouts) {
        if (p.date < today || p.date >= endStr) continue;
        out.push({ key: `holdback:${owner}:${p.month}`, kind: 'estimate_in', label: `${name}'s summer pay (half ${her} holdback)`,
          date: p.date, amount: p.amount, farm: 0, taxable: 0, estimate: true, ref: { paystub: true, owner, holdback: true } });
      }
    }
  }
  return out;
}
