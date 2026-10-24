import { useEffect, useRef, useState } from 'react';
import { uploadBody } from '../pages/Receipts.jsx';
import MetricCard from './MetricCard.jsx';
import { money } from '../format.js';
import { cents } from './SplitEditor.jsx';

// Paystubs, added here (Add paystub: the PDF or a photo, read by Claude — how Ashley's agent files them, at a
// computer like a person) or through the paystub API, analysed:
// what she's earned and kept, whether her withholding points to a refund
// or a balance owing, CPP and EI against the year's maximums, and each stub
// with whether its deposit was found and booked as her wages.
const WHO = [['ashley', 'Ashley'], ['jake', 'Jake']];
const MAIN = ['income_tax', 'cpp', 'ei', 'pension'];
const sumOf = (s, types) => (s.deductions || []).filter((d) => types.includes(d.type)).reduce((a, d) => a + Number(d.amount), 0);
const other = (s) => (s.deductions || []).filter((d) => !MAIN.includes(d.type)).reduce((a, d) => a + Number(d.amount), 0);
const shortDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '');

function MaxRow({ label, m }) {
  if (!m) return null;
  const pctPaid = m.max ? Math.min(100, (m.paid / m.max) * 100) : 0;
  const note = m.reached ? 'maximum reached: no more comes off this year'
    : m.on ? `reaches the maximum on the ${shortDate(m.on)} pay` : 'won\'t reach the maximum this year';
  return (
    <tr>
      <td>{label}</td>
      <td>
        <span className="budget-bar" title={`${cents(m.paid)} of ${cents(m.max)}`}>
          <span className="budget-fill" style={{ width: `${pctPaid}%` }} />
          <span className="budget-label">{money(m.paid)} of {money(m.max)}</span>
        </span>
      </td>
      <td className="split-lines">{note}</td>
    </tr>
  );
}

export default function Paystubs() {
  const [owner, setOwner] = useState('ashley');
  const [year, setYear] = useState(new Date().getFullYear());
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const fileRef = useRef(null);

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
        done.push(`${b.employer} ${b.pay_date}, net ${cents(b.net)}${b.matched_deposit ? ' (deposit found and booked)' : ' (no deposit yet: it matches when the statement comes in)'}${b.warnings?.length ? ' — check it' : ''}`);
      } catch {
        setError(`Couldn't open ${list[i].name}: PDFs and photos only.`);
      }
    }
    setBusy(null);
    if (fileRef.current) fileRef.current.value = '';
    if (done.length) setNote(`Added: ${done.join('; ')}.`);
    load();
  };

  const load = () => {
    setError(null);
    fetch(`/api/paystubs?owner=${owner}&year=${year}`).then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setS(d))).catch((e) => setError(e.message));
  };
  useEffect(load, [owner, year]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (stub) => {
    if (!window.confirm(`Delete the ${stub.employer} paystub of ${stub.pay_date}? Its deposit stays in the books.`)) return;
    const r = await fetch(`/api/paystubs/${stub.id}`, { method: 'DELETE' });
    if (!r.ok) setError(`Could not delete it (HTTP ${r.status}).`); else load();
  };

  const name = WHO.find(([k]) => k === owner)[1];
  const t = s?.totals;
  const o = s?.tax_outlook;

  return (
    <div className="panel paystubs">
      <div className="panel-header personal-cats-head">
        <span>Paystubs</span>
        <span className="paystub-controls">
          <span className="seg-toggle" role="group" aria-label="Whose paystubs">
            {WHO.map(([k, l]) => (
              <button key={k} type="button" aria-pressed={owner === k} className={owner === k ? 'on' : ''} onClick={() => setOwner(k)}>{l}</button>
            ))}
          </span>
          <input ref={fileRef} type="file" accept="application/pdf,.pdf,image/*" multiple hidden onChange={(e) => add(e.target.files)} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={!!busy}>{busy || 'Add paystub'}</button>
          <select aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[0, 1, 2].map((i) => new Date().getFullYear() - i).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </span>
      </div>
      {error && <p className="review-error" style={{ margin: '8px 16px' }}>{error}</p>}
      {note && <p className="page-meta" style={{ margin: '8px 16px' }}>{note}</p>}
      {!s ? <div className="empty-state">Loading…</div> : !t ? (
        <div className="empty-state">
          No paystubs for {name} in {year}. Add paystub takes the PDF or a photo and reads it.
        </div>
      ) : (
        <>
          <div className="grid personal-cards paystub-cards">
            <MetricCard label="Gross pay this year" value={money(t.gross)}
              sub={`${s.pays_on_file} pay${s.pays_on_file === 1 ? '' : 's'} · ${s.frequency || 'one so far'}${s.employers.length > 1 ? ` · ${s.employers.length} employers` : ''}`} />
            <MetricCard label="Take-home" value={money(t.net)} sub={t.take_home_pct != null ? `${t.take_home_pct}% of gross` : undefined} />
            <MetricCard label="Income tax withheld" value={money(t.income_tax)} sub={`${money(s.per_pay.income_tax)} a pay lately`} />
            <MetricCard label={`Tax outlook for ${year}`}
              value={o.result === 'about even' ? 'About even' : `${o.result === 'refund' ? 'Refund' : 'Owing'} ${money(Math.abs(o.difference))}`}
              tone={o.result === 'owing' ? 'negative' : o.result === 'refund' ? 'positive' : undefined}
              sub={`${money(o.withheld)} withheld vs ${money(o.owed)} owed on ${money(o.projected_gross)}`} />
          </div>
          <p>{o.note}{o.rates_year !== year ? ` Worked out with ${o.rates_year} rates.` : ''}</p>
          {s.check && <p className="pace-warn" role="status" style={{ margin: '0 16px 10px' }}>{s.check}</p>}

          <table className="plan-steps paystub-max" data-nostack="">
            <tbody>
              <MaxRow label="CPP" m={s.cpp} />
              {s.cpp2 && s.cpp2.paid > 0 && <MaxRow label="CPP2" m={{ ...s.cpp2, reached: s.cpp2.paid >= s.cpp2.max - 0.5 }} />}
              <MaxRow label="EI" m={s.ei} />
              {(s.retirement.pension > 0 || s.retirement.group_rrsp > 0) && (
                <tr>
                  <td>Retirement</td>
                  <td className="num">{s.retirement.pension > 0 && <>{cents(s.retirement.pension)} pension</>}{s.retirement.pension > 0 && s.retirement.group_rrsp > 0 && ', '}{s.retirement.group_rrsp > 0 && <>{cents(s.retirement.group_rrsp)} group RRSP</>}</td>
                  <td className="split-lines">{s.retirement.note}</td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="table-scroll">
            <table className="personal-months paystub-table">
              <thead>
                <tr>
                  <th>Paid</th><th>Employer</th><th className="num">Gross</th><th className="num">Tax</th><th className="num">CPP</th>
                  <th className="num">EI</th><th className="num">Pension</th><th className="num">Other</th><th className="num">Net</th><th>Deposit</th><th />
                </tr>
              </thead>
              <tbody>
                {s.stubs.slice().reverse().slice(0, all ? undefined : 6).map((x) => (
                  <tr key={x.id}>
                    <td>{shortDate(x.pay_date)}</td>
                    <td>{x.employer}{x.warnings?.length > 0 && <span className="tag" title={x.warnings.join(' ')}>check</span>}</td>
                    <td className="num">{cents(x.gross)}</td>
                    <td className="num">{cents(sumOf(x, ['income_tax']))}</td>
                    <td className="num">{cents(sumOf(x, ['cpp', 'cpp2']))}</td>
                    <td className="num">{cents(sumOf(x, ['ei']))}</td>
                    <td className="num">{sumOf(x, ['pension']) ? cents(sumOf(x, ['pension'])) : '—'}</td>
                    <td className="num" title={(x.deductions || []).filter((d) => !MAIN.includes(d.type)).map((d) => `${d.label || d.type}: ${cents(d.amount)}`).join('\n')}>
                      {other(x) ? cents(other(x)) : '—'}
                    </td>
                    <td className="num">{cents(x.net)}</td>
                    <td>{x.matched ? <span className="tag tag-link">booked</span> : <span className="split-lines">no deposit found</span>}</td>
                    <td className="paystub-actions">
                      {x.has_doc && <a className="small-link" href={`/api/paystubs/${x.id}/document`} target="_blank" rel="noreferrer">Stub</a>}
                      <button type="button" className="small-link" aria-label={`Delete the ${x.pay_date} paystub`} onClick={() => remove(x)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.stubs.length > 6 && (
            <div className="paystub-more">
              <button type="button" className="small-link" onClick={() => setAll(!all)}>{all ? 'Show the latest 6' : `Show all ${s.stubs.length} stubs`}</button>
            </div>
          )}
          <p>Each stub's net pay is matched to the deposit of the same amount near its pay date and booked as {name}'s wages. The deductions stay here, not as spending.</p>
        </>
      )}
    </div>
  );
}
