// Paystubs (Jake, 2026-10-24): Ashley's agent sends each paystub through
// the paystub API. A stub is hers (or Jake's), is matched to the deposit of
// its net pay — which then books as her wages, not as uncategorized income —
// and feeds an analysis: year to date, tax withheld against what her pay
// will actually owe, CPP and EI against the year's maximums, pension and
// RRSP taken off, how her pay is moving, and her next pays in the cash
// forecast.
import { pool } from '../db.js';
import { payeeId } from './postings.js';
import { closedMonth } from './periods.js';
import { employeeTax } from './taxRates.js';
import { toISODate, addDays, todayISO } from './dates.js';

export const OWNERS = ['ashley', 'jake'];
export const DEDUCTION_TYPES = {
  income_tax: 'Income tax', cpp: 'CPP', cpp2: 'CPP2', ei: 'EI', pension: 'Pension (RPP)', rrsp: 'Group RRSP',
  union_dues: 'Union dues', benefits: 'Benefits', other: 'Other',
};
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const money = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : r2(Number(v)));

/** A deduction's type from what an agent calls it ("Federal tax", "CPP2", "Dental"). */
export function deductionType(raw) {
  const s = String(raw || '').toLowerCase();
  if (DEDUCTION_TYPES[s]) return s;
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
  const gross = money(b.gross);
  const net = money(b.net);
  if (!(gross > 0)) return { error: 'gross is required: the pay before deductions.' };
  if (!(net >= 0)) return { error: 'net is required: the pay deposited.' };
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
  if (Math.abs(r2(gross - taken) - net) > 1) {
    warnings.push(`Gross ${gross} less deductions ${taken} is ${r2(gross - taken)}, not the net ${net}: a deduction may be missing (or a non-cash benefit included).`);
  }
  const ytd = b.ytd && typeof b.ytd === 'object' && !Array.isArray(b.ytd)
    ? Object.fromEntries(Object.entries(b.ytd).map(([k, v]) => [k === 'gross' || k === 'net' ? k : deductionType(k), money(v)]).filter(([, v]) => v != null))
    : null;
  return {
    stub: {
      owner, employer, pay_date: b.pay_date, period_start: b.period_start || null, period_end: b.period_end || null,
      gross, net, deductions: list, ytd, hours: money(b.hours), hourly_rate: money(b.hourly_rate),
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
    stub.notes, JSON.stringify(warnings)];
  let id;
  if (old) {
    await db.query(
      `UPDATE paystubs SET owner=$1, employer=$2, pay_date=$3, period_start=$4, period_end=$5, gross=$6, net=$7, deductions=$8, ytd=$9,
         hours=$10, hourly_rate=$11, source=$12, external_id=COALESCE($13, external_id), notes=$14, warnings=$15, updated_at=now() WHERE id=$16`, [...vals, old.id]);
    id = old.id;
  } else {
    const { rows: [r] } = await db.query(
      `INSERT INTO paystubs (owner, employer, pay_date, period_start, period_end, gross, net, deductions, ytd, hours, hourly_rate, source, external_id, notes, warnings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, vals);
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

/**
 * The analysis for one owner and year: totals, the tax outlook (withheld vs
 * what the year's pay will owe), CPP and EI against their maximums, pension
 * and RRSP, the pay trend, and the next pay dates.
 */
export async function paystubSummary({ owner = 'ashley', year = Number(todayISO().slice(0, 4)), today = todayISO() } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT id, owner, employer, pay_date, period_start, period_end, gross, net, deductions, ytd, hours, hourly_rate, transaction_id, warnings,
            doc_mime IS NOT NULL AS has_doc
     FROM paystubs WHERE owner = $1 AND EXTRACT(YEAR FROM pay_date) = $2 ORDER BY pay_date, id`, [owner, year]);
  const stubs = rows.map((r) => ({ ...r, pay_date: toISODate(r.pay_date), period_start: r.period_start ? toISODate(r.period_start) : null,
    period_end: r.period_end ? toISODate(r.period_end) : null, gross: Number(r.gross), net: Number(r.net) }));
  if (!stubs.length) return { owner, year, stubs: [], totals: null };
  const gross = r2(stubs.reduce((s, x) => s + x.gross, 0));
  const net = r2(stubs.reduce((s, x) => s + x.net, 0));
  const t = Object.fromEntries(Object.keys(DEDUCTION_TYPES).map((k) => [k, sumType(stubs, k)]));
  const freq = payFrequency(stubs.map((s) => s.pay_date));
  const last = stubs[stubs.length - 1];
  const yearEnd = `${year + 1}-01-01`;
  const left = freq && year >= Number(today.slice(0, 4)) ? nextPayDates(last.pay_date, freq, yearEnd) : [];
  const recent = stubs.slice(-3);
  const avg = (f) => r2(recent.reduce((s, x) => s + f(x), 0) / recent.length);
  const perPay = { gross: avg((x) => x.gross), net: avg((x) => x.net), income_tax: avg((x) => sumType([x], 'income_tax')) };
  const projected = {
    gross: r2(gross + perPay.gross * left.length),
    income_tax_withheld: r2(t.income_tax + perPay.income_tax * left.length),
    rpp: r2(t.pension * (1 + left.length / stubs.length)), rrsp: r2(t.rrsp * (1 + left.length / stubs.length)),
    union: r2(t.union_dues * (1 + left.length / stubs.length)),
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
  // The stub's own year-to-date figures, when it prints them, are the check on ours.
  const ytdCheck = last.ytd && last.ytd.gross != null && Math.abs(Number(last.ytd.gross) - gross) > 1
    ? `The latest stub shows ${r2(last.ytd.gross)} gross year to date; the stubs on file add up to ${gross}. Some stubs this year may be missing.`
    : null;
  return {
    owner, year, employers: [...new Set(stubs.map((s) => s.employer))],
    frequency: freq?.label || null, pays_on_file: stubs.length, pays_left: left.length, next_pays: left.slice(0, 3),
    totals: { gross, net, ...t, take_home_pct: gross ? r2((net / gross) * 100) : null },
    per_pay: perPay,
    tax_outlook: {
      projected_gross: projected.gross, withheld: projected.income_tax_withheld, owed: due.income_tax,
      difference: diff, result: Math.abs(diff) < 100 ? 'about even' : diff > 0 ? 'refund' : 'owing',
      rates_year: due.rates_year, note: 'Her pay alone: no other income, credits or deductions (RRSP contributions outside work, childcare, medical, donations) — those would move it.',
    },
    cpp: maxOut('cpp', due.max.cpp), cpp2: due.max.cpp2 ? { paid: t.cpp2, max: due.max.cpp2 } : null, ei: maxOut('ei', due.max.ei),
    retirement: { pension: t.pension, group_rrsp: t.rrsp, note: 'A pension adjustment (on her T4) lowers next year\'s RRSP room; group RRSP contributions use this year\'s.' },
    trend: stubs.map((s) => ({ pay_date: s.pay_date, gross: s.gross, net: s.net, hours: s.hours != null ? Number(s.hours) : null })),
    check: ytdCheck,
    stubs: stubs.map((s) => ({ ...s, has_doc: !!s.has_doc, matched: !!s.transaction_id })),
  };
}

/**
 * Her next net pays as expected income in the cash forecast (estimates,
 * personal), from the last stub and the frequency. Skipped when an active
 * estimate already looks like her pay, so it isn't counted twice.
 */
export async function paystubForecastFlows({ today, endStr }, db = pool) {
  const out = [];
  for (const owner of OWNERS) {
    const { rows } = await db.query(
      `SELECT pay_date, net, employer FROM paystubs WHERE owner = $1 AND pay_date > CURRENT_DATE - 120 ORDER BY pay_date`, [owner]);
    if (rows.length < 2) continue;
    const dates = rows.map((r) => toISODate(r.pay_date));
    const freq = payFrequency(dates);
    if (!freq) continue;
    const last = dates[dates.length - 1];
    if (Date.parse(today) - Date.parse(last) > freq.days * 3 * 86400000) continue; // stopped: no recent pay
    const recent = rows.slice(-3);
    const net = r2(recent.reduce((s, r) => s + Number(r.net), 0) / recent.length);
    const name = owner === 'ashley' ? 'Ashley' : 'Jake';
    const { rows: dup } = await db.query(
      `SELECT 1 FROM cash_estimates WHERE status = 'active' AND direction = 'inflow'
         AND (name ~* '(pay|wage|salary|paycheque|paycheck)') AND (segment::text = $1 OR name ~* $2) LIMIT 1`, [owner, name]);
    if (dup.length) continue;
    for (const d of nextPayDates(last, freq, endStr)) {
      if (d < today) continue;
      out.push({ key: `pay:${owner}:${d}`, kind: 'estimate_in', label: `${name}'s pay (from her paystubs)`.replace('her', owner === 'ashley' ? 'her' : 'his'),
        date: d, amount: net, farm: 0, taxable: 0, estimate: true, ref: { paystub: true, owner } });
    }
  }
  return out;
}
