import { Fragment, useEffect, useRef, useState } from 'react';
import { Pie } from '../components/Pie.jsx';
import { SERIES, OTHER } from '../chartColors.js';
import { uploadBody } from './Receipts.jsx';
import MetricCard from '../components/MetricCard.jsx';
import { money } from '../format.js';
import { cents } from '../components/SplitEditor.jsx';

// Paystubs (Jake, 2026-10-24): its own page. Where each pay goes, what
// every deduction is and what it means for her (CPP and EI against the
// year's maximums, her pension and group RRSP, the summer holdback), her
// next pays estimated deduction by deduction, and every stub on file.
// Stubs come from "Add paystub" (a PDF or photo, read by Claude) or the
// paystub API.

const WHO = [['ashley', 'Ashley'], ['jake', 'Jake']];

// Each part of gross pay: label, colour, and what it is in plain words.
const PARTS = [
  // Fixed per part (validated palette, chartColors.js), so a part keeps its colour across views.
  { key: 'net', label: 'Take-home', color: SERIES[2] },
  { key: 'income_tax', label: 'Income tax', color: SERIES[0] },
  { key: 'cpp', label: 'CPP', color: SERIES[3], types: ['cpp', 'cpp2'] },
  { key: 'ei', label: 'EI', color: SERIES[6] },
  { key: 'pension', label: 'Pension', color: SERIES[1] },
  { key: 'rrsp', label: 'Group RRSP', color: SERIES[5] },
  { key: 'holdback', label: 'Held for summer', color: SERIES[4] },
  { key: 'benefits', label: 'Benefits', color: SERIES[7] },
  { key: 'union_dues', label: 'Union & professional dues', color: '#8b93a1' },
  { key: 'other', label: 'Other', color: OTHER },
];
const TYPE_LABEL = {
  income_tax: 'Income tax', cpp: 'CPP', cpp2: 'CPP2', ei: 'EI', pension: 'Pension', rrsp: 'Group RRSP',
  union_dues: 'Union & professional dues', benefits: 'Benefits', holdback: 'Summer holdback', other: 'Other',
};
const typesOf = (p) => p.types || [p.key];
const sumOf = (s, types) => (s.deductions || []).filter((d) => types.includes(d.type)).reduce((a, d) => a + Number(d.amount), 0);
const thisYear = new Date().getFullYear();
// "Oct 30", with the year when it isn't this one ("Jul 23, 2027").
const shortDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-CA',
  Number(iso.slice(0, 4)) === thisYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const pct = (n, of) => (of ? Math.round((n / of) * 1000) / 10 : 0);

// What a deduction's printed label most likely means.
const GLOSSARY = [
  [/\bltd\b|long.?term dis/i, 'Long-term disability insurance: replaces part of her pay if she can\'t work for months or longer.'],
  [/\bstd\b|short.?term dis|\bwi\b|weekly indemnity/i, 'Short-term disability insurance: pays part of her wage for a short illness or injury.'],
  [/ad&?d|accident/i, 'Accidental death and dismemberment insurance.'],
  [/\blife\b|\bgtl\b|group term/i, 'Group life insurance: a payout to the family if she dies.'],
  [/dental/i, 'Dental plan: her share of the premium.'],
  [/health|\behc\b|\behb\b|extended|medical|drug|vision|blue cross/i, 'Extended health plan (drugs, vision, physio and the like): her share of the premium.'],
  [/\bstf\b|teachers.? federation/i, 'Saskatchewan Teachers\' Federation fees: professional and union dues. Deductible on her return.'],
  [/cupe|sgeu|\bsun\b|\bheu\b|union|dues/i, 'Union dues. Deductible on her tax return (T4 box 44).'],
  [/strp|stsc|teachers.? (superannuation|retirement)/i, 'Saskatchewan Teachers\' Retirement Plan: her pension contribution.'],
  [/shepp/i, 'Saskatchewan Healthcare Employees\' Pension Plan: her pension contribution.'],
  [/mepp/i, 'Municipal Employees\' Pension Plan: her pension contribution.'],
  [/pspp|public service pension/i, 'Public Service Pension Plan: her pension contribution.'],
  [/rrsp/i, 'Group RRSP: savings into her own RRSP through work.'],
  [/hold\s*-?\s*back|defer|summer|10\s*\/\s*12/i, 'Pay held back for July and August.'],
  [/charit|united way|donat/i, 'A charitable donation through payroll: it shows on her T4 for the tax credit.'],
  [/parking/i, 'Parking at work.'],
  [/social|club/i, 'A workplace social fund or club.'],
  [/savings|csb/i, 'Payroll savings.'],
  [/federal|fed\b/i, 'Federal income tax.'],
  [/prov|sask|\bsk\b/i, 'Saskatchewan income tax.'],
];
const meaning = (label) => GLOSSARY.find(([re]) => re.test(label || ''))?.[1] || null;

// One line per label inside a part (e.g. Benefits: LTD, Group life), from the stubs given or a typical pay.
const labelsIn = (rows, types) => {
  const m = new Map();
  for (const x of rows) for (const d of x.deductions || []) {
    if (!types.includes(d.type)) continue;
    m.set(d.label, (m.get(d.label) || 0) + Number(d.amount));
  }
  return [...m.entries()].map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);
};

// What each part is, in a line, for the pie's detail box.
const ABOUT = {
  net: 'What lands in the bank account.',
  income_tax: 'Federal and Saskatchewan tax withheld toward the year\'s bill.',
  cpp: 'Canada Pension Plan: builds a pension for life; the employer matches it.',
  ei: 'Employment Insurance: covers parental and sick leave and layoffs; the employer pays 1.4× on top.',
  pension: 'The workplace pension plan: retirement savings, deducted before tax.',
  rrsp: 'Group RRSP: savings into an RRSP through work, deductible this year.',
  holdback: 'Pay held back from September to June, paid out in July and August.',
  benefits: 'Premiums for workplace insurance (health, dental, life, disability).',
  union_dues: 'Union and professional dues: deductible on the tax return.',
  other: 'Deductions not yet identified: say what each is under "What comes off".',
};


/** Where gross pay goes, as a pie: take-home and each deduction. Click a slice (or its row) for what's in it. */
function WhereItGoes({ parts, gross, caption, perPays, labelRows }) {
  const shown = parts.filter((p) => p.amount > 0.005);
  const [sel, setSel] = useState(null);
  useEffect(() => { setSel(null); }, [caption]);
  const [hl, setHl] = useState(null);
  const pick = (k) => setSel(sel === k ? null : k);
  const cur = shown.find((p) => p.key === sel);
  const inside = cur && cur.key !== 'net' ? labelRows(typesOf(cur)) : [];
  return (
    <div className="ps-pie-wrap">
      <Pie slices={shown.map((p) => ({ key: p.key, label: p.label, amount: p.amount, color: p.color }))} selected={sel} onSelect={setSel}
        size={240} label={`${caption}: where the pay goes`} centerTitle="Gross pay" format={(v) => cents(v)} highlight={hl} />
      <div className="ps-pie-side">
        {cur ? (
          <div className="ps-detail">
            <div className="ps-detail-head"><span className="ps-swatch" style={{ background: cur.color }} />{cur.label}</div>
            <div className="ps-detail-big">{cents(cur.amount)} <span>{pct(cur.amount, gross)}% of gross</span></div>
            <p>{ABOUT[cur.key]}</p>
            {perPays?.[cur.key] != null && <div className="split-lines">About {cents(perPays[cur.key])} on a typical pay.</div>}
            {inside.length > 0 && (
              <ul className="ps-lines">
                {inside.map((l) => <li key={l.label}><span>{l.label}</span><span>{cents(l.amount)}</span></li>)}
              </ul>
            )}
            <button type="button" className="small-link" onClick={() => setSel(null)}>Back to all</button>
          </div>
        ) : (
          <table className="ps-legend" data-nostack="">
            <tbody>
              {shown.map((p) => (
                <tr key={p.key} className="ps-legend-row" tabIndex={0} onClick={() => pick(p.key)}
                  onMouseEnter={() => setHl(p.key)} onMouseLeave={() => setHl(null)}
                  onKeyDown={(e) => { if (e.key === 'Enter') pick(p.key); }}>
                  <td><span className="ps-swatch" style={{ background: p.color }} />{p.label}</td>
                  <td className="num">{cents(p.amount)}</td>
                  <td className="num ps-pct">{pct(p.amount, gross)}%</td>
                </tr>
              ))}
              <tr className="ps-legend-total"><td>Gross pay</td><td className="num">{cents(gross)}</td><td className="num ps-pct">100%</td></tr>
            </tbody>
          </table>
        )}
        {!cur && <div className="split-lines">Click a slice or a row for what's in it.</div>}
      </div>
    </div>
  );
}

/** Paid so far, the rest of the year (estimated), and the year's maximum, on one scale. */
function TowardMax({ m, color }) {
  const ytd = Math.min(100, pct(m.paid, m.max));
  const rest = Math.max(0, Math.min(100, pct(m.year_end, m.max)) - ytd);
  return (
    <div className="ps-max">
      <div className="ps-max-bar" aria-hidden="true">
        <span style={{ width: `${ytd}%`, background: color }} />
        <span className="ps-max-est" style={{ width: `${rest}%`, borderColor: color, background: `${color}33` }} />
      </div>
      <div className="ps-max-scale">
        <span>{money(m.paid)} so far</span>
        <span>{m.year_end > m.paid + 0.5 ? `about ${money(m.year_end)} by December` : ''}</span>
        <span>maximum {money(m.max)}</span>
      </div>
    </div>
  );
}

function LabelRow({ l, onType }) {
  const [editing, setEditing] = useState(false);
  const why = meaning(l.label);
  return (
    <li className="ps-label">
      <div className="ps-label-head">
        <span>{l.label}</span>
        <span className="ps-label-nums">{cents(l.ytd)} this year{l.per_pay ? ` · ${cents(l.per_pay)} a pay` : ''}</span>
      </div>
      <div className="split-lines">
        {why || (l.type === 'other' ? 'Not recognised from its label.' : '')}{' '}
        {editing ? (
          <select autoFocus aria-label={`What ${l.label} is`} defaultValue={l.type}
            onChange={(e) => { setEditing(false); onType(l.label, e.target.value); }} onBlur={() => setEditing(false)}>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        ) : <button type="button" className="small-link" onClick={() => setEditing(true)}>{l.type === 'other' ? 'Say what this is' : 'Not right?'}</button>}
      </div>
    </li>
  );
}

export default function Paystubs() {
  const [owner, setOwner] = useState('ashley');
  const [year, setYear] = useState(new Date().getFullYear());
  const [view, setView] = useState('ytd');
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const fileRef = useRef(null);

  const load = () => {
    setError(null);
    fetch(`/api/paystubs?owner=${owner}&year=${year}`).then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setS(d))).catch((e) => setError(e.message));
  };
  useEffect(load, [owner, year]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each file is read and filed in turn; a stub already on file (same employer, date and net) is updated.
  const add = async (files) => {
    const list = [...files];
    setError(null); setNote(null);
    const done = [];
    for (let i = 0; i < list.length; i++) {
      setBusy(list.length > 1 ? `Reading ${i + 1} of ${list.length}…` : 'Reading the paystub…');
      try {
        const { body, type } = await uploadBody(list[i]);
        const r = await fetch(`/api/paystubs/upload?owner=${owner}`, { method: 'POST', headers: { 'Content-Type': type }, body });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) { setError(`${list[i].name}: ${b.error || `HTTP ${r.status}`}`); continue; }
        done.push(`${b.employer} ${b.pay_date}, net ${cents(b.net)}${b.matched_deposit ? ' (deposit found and booked)' : ' (no deposit yet: it matches when the statement comes in)'}${b.warnings?.length ? ', check it' : ''}`);
      } catch {
        setError(`Couldn't open ${list[i].name}: PDFs and photos only.`);
      }
    }
    setBusy(null);
    if (fileRef.current) fileRef.current.value = '';
    if (done.length) setNote(`Added: ${done.join('; ')}.`);
    load();
  };

  const remove = async (stub) => {
    if (!window.confirm(`Delete the ${stub.employer} paystub of ${stub.pay_date}? Its deposit stays in the books.`)) return;
    const r = await fetch(`/api/paystubs/${stub.id}`, { method: 'DELETE' });
    if (!r.ok) setError(`Could not delete it (HTTP ${r.status}).`); else load();
  };

  const setType = async (label, type) => {
    const r = await fetch('/api/paystubs/label-type', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, type }) });
    if (!r.ok) { const b = await r.json().catch(() => ({})); setError(b.error || `HTTP ${r.status}`); return; }
    setNote(`"${label}" is now ${TYPE_LABEL[type]}, on every stub and from now on.`);
    load();
  };

  const name = WHO.find(([k]) => k === owner)[1];
  const her = owner === 'ashley' ? 'her' : 'his';
  const she = owner === 'ashley' ? 'she' : 'he';
  const t = s?.totals;
  const o = s?.tax_outlook;
  const h = s?.holdback;
  const regular = (s?.stubs || []).filter((x) => x.gross > 0);
  const lines = s?.lines || [];
  const ahead = s?.ahead || [];

  // The bar: this year so far, a typical pay, or the whole year with the rest estimated.
  const views = {
    ytd: () => {
      const g = regular.reduce((a, x) => a + x.gross, 0);
      return { gross: g, parts: PARTS.map((p) => ({ ...p, amount: p.key === 'net' ? regular.reduce((a, x) => a + x.net, 0) : regular.reduce((a, x) => a + sumOf(x, typesOf(p)), 0) })), caption: `${year} so far`,
        labelRows: (types) => labelsIn(regular, types) };
    },
    pay: () => {
      const g = s.per_pay.gross;
      const by = (types) => lines.filter((l) => types.includes(l.type)).reduce((a, l) => a + (l.per_pay || 0), 0);
      const taken = PARTS.filter((p) => p.key !== 'net').reduce((a, p) => a + by(typesOf(p)), 0);
      return { gross: g, parts: PARTS.map((p) => ({ ...p, amount: p.key === 'net' ? g - taken : by(typesOf(p)) })), caption: 'A typical pay',
        labelRows: (types) => lines.filter((l) => types.includes(l.type) && l.per_pay).map((l) => ({ label: l.label, amount: l.per_pay })) };
    },
    year: () => {
      const est = ahead.filter((x) => x.gross > 0);
      const all2 = [...regular, ...est];
      const g = all2.reduce((a, x) => a + x.gross, 0);
      return { gross: g, parts: PARTS.map((p) => ({ ...p, amount: p.key === 'net' ? all2.reduce((a, x) => a + x.net, 0) : all2.reduce((a, x) => a + sumOf(x, typesOf(p)), 0) })), caption: `All of ${year}, the rest estimated`,
        labelRows: (types) => labelsIn(all2, types) };
    },
  };
  const bar = t && regular.length ? views[view]() : null;
  // A typical pay, part by part, for the pie's detail box.
  const perPays = s && regular.length ? Object.fromEntries(views.pay().parts.map((p) => [p.key, p.amount])) : null;

  // Columns for the stub tables: the main deductions, then any other type that appears.
  const present = new Set([...(s?.stubs || []), ...ahead].flatMap((x) => (x.deductions || []).map((d) => d.type)));
  const cols = PARTS.filter((p) => p.key !== 'net' && typesOf(p).some((k) => present.has(k)));
  const hasPayouts = [...(s?.stubs || []), ...ahead].some((x) => x.holdback_paid > 0);

  const byType = (types) => lines.filter((l) => types.includes(l.type));
  const limits = s?.limits || {};
  const projGross = o?.projected_gross || 0;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Paystubs</h1>
        <span className="paystub-controls">
          <span className="seg-toggle" role="group" aria-label="Whose paystubs">
            {WHO.map(([k, l]) => (
              <button key={k} type="button" aria-pressed={owner === k} className={owner === k ? 'on' : ''} onClick={() => setOwner(k)}>{l}</button>
            ))}
          </span>
          <select aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[0, 1, 2].map((i) => new Date().getFullYear() - i).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <input ref={fileRef} type="file" accept="application/pdf,.pdf,image/*" multiple hidden onChange={(e) => add(e.target.files)} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={!!busy}>{busy || 'Add paystub'}</button>
        </span>
      </div>
      {error && <p className="review-error" style={{ margin: '0 0 12px' }}>{error}</p>}
      {note && <p className="page-meta" style={{ margin: '0 0 12px', display: 'block' }}>{note}</p>}

      {!s ? <div className="empty-state">Loading…</div> : !t ? (
        <div className="empty-state">No paystubs for {name} in {year}. Add paystub takes the PDF or a photo and reads it.</div>
      ) : (
        <>
          <div className="grid personal-cards">
            <MetricCard label={`Gross pay, ${year} so far`} value={money(t.gross)}
              sub={`${s.pays_on_file} pay${s.pays_on_file === 1 ? '' : 's'} · ${s.frequency || 'one so far'} · about ${money(projGross)} for the year`} />
            <MetricCard label="Take-home" value={money(t.net)}
              sub={[t.take_home_pct != null && `${t.take_home_pct}% of gross`, t.holdback_paid > 0 && `incl. ${money(t.holdback_paid)} summer pay`].filter(Boolean).join(' · ')} />
            <MetricCard label={`Tax for ${year}`}
              value={o.result === 'about even' ? 'About even' : `${o.result === 'refund' ? 'Refund' : 'Owing'} about ${money(Math.abs(o.difference))}`}
              tone={o.result === 'owing' ? 'negative' : o.result === 'refund' ? 'positive' : undefined}
              sub={`${money(o.withheld)} withheld vs ${money(o.owed)} owed on ${her} pay`} />
            {h && (
              <MetricCard label="Held for summer" value={money(h.balance)}
                sub={h.payouts.length ? `Comes back ${h.payouts.map((p) => `${money(p.amount)} ${shortDate(p.date)}`).join(' and ')} (est.)` : `${h.school_year} school year${h.paid_out ? `, ${money(h.paid_out)} paid out` : ''}`} />
            )}
          </div>

          {bar && (
            <div className="panel">
              <div className="panel-header spend-header">
                <span>Where {her} pay goes</span>
                <span className="seg-toggle" role="group" aria-label="Which pay">
                  {[['ytd', 'So far this year'], ['pay', 'A typical pay'], ['year', 'Whole year']].map(([k, l]) => (
                    <button key={k} type="button" aria-pressed={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>
                  ))}
                </span>
              </div>
              <WhereItGoes {...bar} perPays={perPays} />
              {view === 'year' && <p>The rest of the year is estimated from {her} last three pays, with CPP and EI stopping if they reach the year's maximum.</p>}
            </div>
          )}

          <div className="panel">
            <div className="panel-header">What comes off, and what it means</div>
            <div className="ps-explain">
              {byType(['income_tax']).length > 0 && (
                <section className="ps-item">
                  <h3><span className="ps-swatch" style={{ background: PARTS[1].color }} />Income tax</h3>
                  <p>Federal and Saskatchewan tax, withheld from each pay so {she} doesn't owe it all in April. Payroll works it out per pay, so it rarely matches the year exactly.</p>
                  <div className="ps-figs"><span>{cents(t.income_tax)} so far</span><span>{cents(s.per_pay.income_tax)} a pay</span><span>about {money(o.withheld)} for the year</span></div>
                  <p className="ps-verdict">
                    On about {money(o.projected_gross)} of pay, {her} tax for {year} comes to about {money(o.owed)}.{' '}
                    {o.result === 'about even' ? 'Withholding is about right.' : o.result === 'refund'
                      ? `Withholding is about ${money(o.difference)} more than that: a refund in the spring.`
                      : `Withholding is about ${money(-o.difference)} short: that would be owing in April.`}
                    {' '}{o.note}
                  </p>
                </section>
              )}
              {s.cpp && (t.cpp > 0 || t.cpp2 > 0) && (
                <section className="ps-item">
                  <h3><span className="ps-swatch" style={{ background: PARTS[2].color }} />CPP — Canada Pension Plan</h3>
                  <p>
                    Builds {her} CPP pension, paid for life from as early as 60. {name === 'Ashley' ? 'Her' : 'His'} employer pays the same amount again on top.
                    It's {limits.cpp_rate ? `${Math.round(limits.cpp_rate * 10000) / 100}% ` : ''}of pay above {money(limits.cpp_exemption)} a year, on earnings up to {money(limits.ympe)}, so
                    the most anyone pays in {limits.rates_year} is {money(s.cpp.max)}.
                  </p>
                  <TowardMax m={s.cpp} color={PARTS[2].color} />
                  <p className="ps-verdict">
                    {s.cpp.reached ? `${name} has paid the maximum: no CPP comes off for the rest of ${year}, so take-home is higher until January.`
                      : s.cpp.on ? `Reaches the maximum on the ${shortDate(s.cpp.on)} pay. After that no CPP comes off, so take-home rises by about ${cents(s.cpp.per_pay)} a pay until January.`
                        : `${her[0].toUpperCase() + her.slice(1)} pay for the year (about ${money(projGross)}) is under the ${money(limits.ympe)} ceiling, so ${she} won't reach the maximum: CPP comes off every pay, about ${money(s.cpp.year_end)} for the year. That's normal, not a shortfall: ${she}'s paying the full rate on everything ${she} earns.`}
                    {' '}Contributions also cut {her} income tax (a credit, plus a deduction for the enhanced part), counted in the tax figure above.
                    {t.cpp2 > 0 && ` CPP2 (${cents(t.cpp2)} so far) is the second tier, on earnings between ${money(limits.ympe)} and ${money(limits.yampe)}.`}
                  </p>
                </section>
              )}
              {s.ei && t.ei > 0 && (
                <section className="ps-item">
                  <h3><span className="ps-swatch" style={{ background: PARTS[3].color }} />EI — Employment Insurance</h3>
                  <p>
                    Insurance on {her} pay: it's what pays maternity and parental leave, sickness leave and a layoff. {name === 'Ashley' ? 'Her' : 'His'} employer pays 1.4 times as much on top.
                    It's {limits.ei_rate ? `${Math.round(limits.ei_rate * 10000) / 100}% ` : ''}of pay up to {money(limits.mie)} a year, so at most {money(s.ei.max)} in {limits.rates_year}.
                  </p>
                  <TowardMax m={s.ei} color={PARTS[3].color} />
                  <p className="ps-verdict">
                    {s.ei.reached ? `${name} has paid the year's maximum: no more EI comes off until January.`
                      : s.ei.on ? `Reaches the maximum on the ${shortDate(s.ei.on)} pay; after that take-home rises by about ${cents(s.ei.per_pay)} a pay until January.`
                        : `About ${money(projGross)} of pay this year is under the ${money(limits.mie)} limit, so EI comes off every pay: about ${money(s.ei.year_end)} for the year.`}
                    {' '}Premiums also earn a tax credit, counted in the tax figure above.
                  </p>
                </section>
              )}
              {(t.pension > 0 || t.rrsp > 0) && (
                <section className="ps-item">
                  <h3><span className="ps-swatch" style={{ background: PARTS[4].color }} />Retirement savings</h3>
                  {t.pension > 0 && (
                    <>
                      <p>
                        <strong>Pension{byType(['pension']).length ? ` (${byType(['pension']).map((l) => l.label).join(', ')})` : ''}.</strong>{' '}
                        {her[0].toUpperCase() + her.slice(1)} workplace pension plan. What {she} puts in comes off {her} taxable income, so each dollar costs {her} less than a dollar of take-home;
                        the employer contributes too (that part isn't on the stub). It's locked in until retirement.
                      </p>
                      <div className="ps-figs"><span>{cents(t.pension)} so far</span><span>{cents(byType(['pension']).reduce((a, l) => a + (l.per_pay || 0), 0))} a pay</span><span>about {money(s.year_end?.pension)} for the year</span></div>
                      <p className="ps-verdict">Next year {her} T4 shows a pension adjustment for this, which lowers how much {she} can put in an RRSP. Check {her} CRA notice of assessment for the exact room.</p>
                    </>
                  )}
                  {t.rrsp > 0 && (
                    <>
                      <p><strong>Group RRSP.</strong> Goes into {her} own RRSP through work: deductible this year, and it uses this year's RRSP room.</p>
                      <div className="ps-figs"><span>{cents(t.rrsp)} so far</span><span>about {money(s.year_end?.rrsp)} for the year</span></div>
                    </>
                  )}
                </section>
              )}
              {h && (
                <section className="ps-item">
                  <h3><span className="ps-swatch" style={{ background: PARTS[6].color }} />Held for summer</h3>
                  <p>{name} is paid ten months of the year. Part of each September-to-June pay is held back and paid out half in July and half in August. It's {her} pay, saved, not money lost.</p>
                  <div className="ps-figs">
                    <span>{money(h.balance)} held now</span>
                    <span>{money(h.saved)} held this {h.school_year} school year</span>
                    {h.pays_to_come > 0 && <span>about {money(h.projected_by_june)} by June</span>}
                  </div>
                  <p className="ps-verdict">
                    {h.paid_out > 0 && `${money(h.paid_out)} of it has been paid out this summer. `}
                    {h.payouts.length > 0 && `Comes back as ${h.payouts.map((p) => `${money(p.amount)} on ${shortDate(p.date)}`).join(' and ')} (estimated: half of what's held by June each month; Cash Flow expects it then).`}
                  </p>
                </section>
              )}
              {['benefits', 'union_dues', 'other'].filter((k) => t[k] > 0).map((k) => {
                const part = PARTS.find((p) => p.key === k);
                const intro = {
                  benefits: `Premiums for workplace insurance: what ${she} pays to be covered. Not savings.`,
                  union_dues: `Union and professional dues. Deductible on ${her} tax return, counted in the tax figure above.`,
                  other: 'Deductions Money Hub couldn\'t place from their label. Say what each one is and it\'s sorted from then on.',
                }[k];
                return (
                  <section className="ps-item" key={k}>
                    <h3><span className="ps-swatch" style={{ background: part.color }} />{part.label} <span className="ps-h-sum">{cents(t[k])} so far</span></h3>
                    <p>{intro}</p>
                    <ul className="ps-labels">{byType([k]).map((l) => <LabelRow key={l.label} l={l} onType={setType} />)}</ul>
                  </section>
                );
              })}
            </div>
          </div>

          {ahead.length > 0 && (
            <div className="panel">
              <div className="panel-header">Next pays (estimated)</div>
              <p>From {her} last three pays. CPP and EI stop once the year's maximum is reached{h ? ', and there are no regular pays in July and August: the holdback is paid out instead' : ''}.</p>
              <StubTable rows={ahead} cols={cols} hasPayouts={hasPayouts} estimated />
            </div>
          )}

          <div className="panel">
            <div className="panel-header">Stubs on file</div>
            <StubTable rows={s.stubs.slice().reverse().slice(0, all ? undefined : 8)} cols={cols} hasPayouts={hasPayouts}
              open={open} setOpen={setOpen} onDelete={remove} />
            {s.stubs.length > 8 && (
              <div className="paystub-more">
                <button type="button" className="small-link" onClick={() => setAll(!all)}>{all ? 'Show the latest 8' : `Show all ${s.stubs.length} stubs`}</button>
              </div>
            )}
            <p>
              Click a stub to see every line on it. Each stub's take-home is matched to the deposit of the same amount near its pay date and
              booked as {name}'s wages; the deductions stay here, not as spending.
              {s.check && <strong> {s.check}</strong>}
            </p>
          </div>
        </>
      )}
    </>
  );
}

function StubTable({ rows, cols, hasPayouts, estimated = false, open, setOpen, onDelete }) {
  return (
    <div className="table-scroll">
      <table className="personal-months paystub-table">
        <thead>
          <tr>
            <th>Paid</th>
            {!estimated && <th>Employer</th>}
            <th className="num">Gross</th>
            {cols.map((c) => <th key={c.key} className="num">{c.label === 'Union & professional dues' ? 'Dues' : c.label === 'Held for summer' ? 'Holdback' : c.label}</th>)}
            {hasPayouts && <th className="num">Summer pay</th>}
            <th className="num">Take-home</th>
            {!estimated && <th>Deposit</th>}
            {!estimated && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => {
            const isOpen = !estimated && x.id != null && open === x.id;
            return (
              <Fragment key={x.id || x.pay_date}>
                <tr className={estimated ? 'ps-est' : 'ps-row'} onClick={estimated ? undefined : () => setOpen(isOpen ? null : x.id)}>
                  <td>{shortDate(x.pay_date)}{estimated && <span className="tag">estimate</span>}</td>
                  {!estimated && <td>{x.employer}{x.warnings?.length > 0 && <span className="tag" title={x.warnings.join(' ')}>check</span>}</td>}
                  <td className="num">{x.gross > 0 ? cents(x.gross) : '—'}</td>
                  {cols.map((c) => { const v = sumOf(x, typesOf(c)); return <td key={c.key} className="num">{v ? cents(v) : '—'}</td>; })}
                  {hasPayouts && <td className="num">{x.holdback_paid > 0 ? cents(x.holdback_paid) : '—'}</td>}
                  <td className="num">{cents(x.net)}</td>
                  {!estimated && <td>{x.matched ? <span className="tag tag-link">booked</span> : <span className="split-lines">no deposit found</span>}</td>}
                  {!estimated && (
                    <td className="paystub-actions" onClick={(e) => e.stopPropagation()}>
                      {x.has_doc && <a className="small-link" href={`/api/paystubs/${x.id}/document`} target="_blank" rel="noreferrer">Stub</a>}
                      <button type="button" className="small-link" aria-label={`Delete the ${x.pay_date} paystub`} onClick={() => onDelete(x)}>Delete</button>
                    </td>
                  )}
                </tr>
                {isOpen && (
                  <tr className="ps-lines-row">
                    <td colSpan={99}>
                      <ul className="ps-lines">
                        <li><span>Gross pay</span><span>{cents(x.gross)}</span></li>
                        {x.holdback_paid > 0 && <li><span>Summer pay (held back earlier)</span><span>+{cents(x.holdback_paid)}</span></li>}
                        {(x.deductions || []).map((d, i) => (
                          <li key={i}><span>{d.label} <span className="split-lines">· {TYPE_LABEL[d.type] || d.type}</span></span><span>−{cents(d.amount)}</span></li>
                        ))}
                        <li className="ps-lines-total"><span>Take-home</span><span>{cents(x.net)}</span></li>
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
