import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import MetricCard from '../components/MetricCard.jsx';
import { money, localToday } from '../format.js';
import { cents } from '../components/SplitEditor.jsx';
import OwnerCheck from '../components/OwnerCheck.jsx';
import BudgetFit from '../components/BudgetFit.jsx';
import { Pie } from '../components/Pie.jsx';
import { SERIES, OTHER, foldSlices } from '../chartColors.js';

// Personal spending (Jake, 2026-10-24: rebuilt around where the money
// actually goes). Household spending — Jake, Ashley and unassigned —
// by category as a pie (click a slice for its subcategories and who was
// paid), month by month as bars with the next three months forecast, by
// person and by essential vs discretionary. The forecast is what you
// actually spend unless you set a budget; the profit-and-tax plan is
// opt-in.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (key) => MONTHS[Number(key.slice(5, 7)) - 1];
const ESS = SERIES[0];
const DISC = SERIES[1];

const today = localToday();
const shift = (ymd, months) => { const d = new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString().slice(0, 10); };
const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const PERIODS = [
  ['month', 'This month', `${today.slice(0, 7)}-01`],
  ['3m', 'Last 3 months', shift(today, -2)],
  ['year', 'This year', `${today.slice(0, 4)}-01-01`],
  ['12m', 'Last 12 months', shift(today, -11)],
];

/** Months as stacked bars: essentials and discretionary, the forecast months hatched. */
function MonthBars({ months }) {
  const W = 760; const H = 220; const P = { l: 54, r: 8, t: 10, b: 26 };
  const max = Math.max(1, ...months.map((m) => m.essential + m.discretionary));
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / nice) * nice;
  const bw = (W - P.l - P.r) / months.length;
  const y = (v) => P.t + (1 - v / top) * (H - P.t - P.b);
  const ticks = [0, top / 2, top];
  return (
    <svg className="pp-bars" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Household spending by month, essentials and discretionary">
      <defs>
        <pattern id="pp-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--panel)" /><line x1="0" y1="0" x2="0" y2="6" stroke="var(--text-faint)" strokeWidth="2" />
        </pattern>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--border)" />
          <text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="pp-axis">{money(t)}</text>
        </g>
      ))}
      {months.map((m, i) => {
        const x = P.l + i * bw + bw * 0.18;
        const w = bw * 0.64;
        const e = m.essential; const d = m.discretionary;
        return (
          <g key={m.month}>
            <title>{`${monthName(m.month)} ${m.month.slice(0, 4)}${m.forecast ? ' (forecast)' : m.partial ? ' (so far)' : ''}: essentials ${money(e)}, discretionary ${money(d)}, total ${money(e + d)}`}</title>
            <rect x={x} y={y(e)} width={w} height={Math.max(0, y(0) - y(e))} rx="2" fill={m.forecast ? 'url(#pp-hatch)' : ESS} stroke={m.forecast ? ESS : 'none'} />
            <rect x={x} y={y(e + d)} width={w} height={Math.max(0, y(e) - y(e + d) - 2)} rx="2" fill={m.forecast ? 'url(#pp-hatch)' : DISC} stroke={m.forecast ? DISC : 'none'} />
            <text x={x + w / 2} y={H - 8} textAnchor="middle" className={`pp-axis${m.forecast ? ' est' : ''}`}>{monthName(m.month)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** The ledger entries behind a subcategory, newest first; each opens in the ledger. */
function Entries({ entries, showCategory = false }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, 50);
  return (
    <div className="ps-entries">
      <table data-nostack="">
        <tbody>
          {shown.map((e, i) => (
            <tr key={`${e.id}-${i}`}>
              <td className="ps-e-date">{e.date}</td>
              <td>
                <Link to={`/ledgers?edit=${e.id}`} className="ps-e-link">{e.payee || e.description || 'Entry'}</Link>
                <div className="split-lines">{[showCategory ? e.category : null, e.payee && e.description !== e.payee ? e.description : null, e.paid_with, e.whose, e.split ? 'part of a split' : null].filter(Boolean).join(' · ')}</div>
              </td>
              <td className="num">{cents(e.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entries.length > 50 && <button type="button" className="small-link" onClick={() => setAll(!all)}>{all ? 'Show the latest 50' : `Show all ${entries.length}`}</button>}
    </div>
  );
}

function Legend({ items, total, selected, onSelect, onHover }) {
  return (
    <table className="ps-legend" data-nostack="">
      <tbody>
        {items.map((s) => (
          <tr key={s.key} className={`ps-legend-row${selected === s.key ? ' on' : ''}`} tabIndex={0} onClick={() => onSelect?.(selected === s.key ? null : s.key)}
            onMouseEnter={() => onHover?.(s.key)} onMouseLeave={() => onHover?.(null)} onFocus={() => onHover?.(s.key)} onBlur={() => onHover?.(null)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSelect?.(selected === s.key ? null : s.key); }}>
            <td><span className="ps-swatch" style={{ background: s.color }} />{s.label}</td>
            <td className="num">{money(Math.round(s.amount))}</td>
            <td className="num ps-pct">{total ? Math.round((s.amount / total) * 100) : 0}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Personal() {
  const [period, setPeriod] = useState('3m');
  const [b, setB] = useState(null);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(null);
  const [hl, setHl] = useState(null); // legend row pointed at
  const [budget, setBudget] = useState(null); // monthly budget being edited
  const [showCats, setShowCats] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [openSub, setOpenSub] = useState(null); // which subcategory's entries are showing
  const [catOpen, setCatOpen] = useState(null); // { id, entries } — a "Which spending is which" row opened
  const openCat = async (c) => {
    if (catOpen?.id === c.id) { setCatOpen(null); return; }
    setCatOpen({ id: c.id, entries: null });
    const r = await fetch(`/api/personal/entries?category_id=${c.id}`).then((x) => x.json()).catch(() => []);
    setCatOpen((cur) => (cur?.id === c.id ? { id: c.id, entries: Array.isArray(r) ? r : [] } : cur));
  };

  const from = PERIODS.find(([k]) => k === period)[2];
  const loadPlan = () => fetch('/api/personal').then((r) => r.json()).then((d) => (d.error ? setError(d.error) : setPlan(d))).catch((e) => setError(e.message));
  const loadB = () => fetch(`/api/personal/breakdown?from=${from}&to=${tomorrow}`).then((r) => r.json()).then((d) => (d.error ? setError(d.error) : setB(d))).catch((e) => setError(e.message));
  useEffect(() => { loadPlan(); }, []);
  useEffect(() => { setSel(null); setOpenSub(null); loadB(); }, [period]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setOpenSub(null); }, [sel]);

  const send = async (method, url, body) => {
    setError(null);
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setError(d.error || `HTTP ${r.status}`); return false; }
    setPlan(d);
    loadB();
    return true;
  };

  if (error && !plan) return <div className="empty-state">Could not load personal spending: {error}</div>;
  if (!plan || !b) return <div className="empty-state">Loading…</div>;

  // Eight categories in the palette's fixed order, the rest folded into one neutral slice.
  const cats = b.categories.map((c, i) => ({ key: c.name, label: c.name, amount: c.amount, color: i < SERIES.length ? SERIES[i] : OTHER, c }));
  const slices = foldSlices(cats, { otherLabel: (n) => `${n} smaller categories` });
  const cur = slices.find((s) => s.key === sel) || cats.find((c) => c.key === sel);
  // Every entry behind the period's spending, labelled with its category; narrowed by what's picked.
  const allEntries = b.categories.flatMap((g) => g.children.flatMap((ch) => (ch.entries || []).map((e) => ({
    ...e, top: g.name, sub: ch.name, category: ch.name === g.name ? g.name : `${g.name} › ${ch.name}` }))));
  const entriesShown = allEntries
    .filter((e) => !cur || cur.rest || e.top === cur.label)
    .filter((e) => !openSub || !cur || `${cur.label}|${e.sub}` === openSub)
    .sort((a, b2) => (a.date < b2.date ? 1 : a.date > b2.date ? -1 : b2.id - a.id));
  const entriesTotal = entriesShown.reduce((a, e) => a + e.amount, 0);
  // Months before the records start are gaps, not months of no spending.
  const firstSpent = b.months.findIndex((m) => m.essential + m.discretionary > 0.5);
  const months = firstSpent < 0 ? b.months.filter((m) => m.forecast) : b.months.slice(firstSpent);
  const past = months.filter((m) => !m.forecast && !m.partial);
  const typical = past.length ? [...past.map((m) => m.essential + m.discretionary)].sort((x, y) => x - y)[Math.floor(past.length / 2)] : 0;
  const next = b.months.find((m) => m.forecast);
  const nMonths = Math.max(1, Math.round((Date.parse(tomorrow) - Date.parse(from)) / (30.44 * 86400000)));
  const people = [
    { key: 'jake', label: 'Jake', amount: b.people.jake, color: SERIES[0] },
    { key: 'ashley', label: 'Ashley', amount: b.people.ashley, color: SERIES[4] },
    { key: 'unassigned', label: 'Not tagged to anyone', amount: b.people.unassigned, color: OTHER },
  ].filter((p) => p.amount > 0.5);
  const kinds = [
    { key: 'essential', label: 'Essentials', amount: b.buckets.essential, color: ESS },
    { key: 'discretionary', label: 'Discretionary', amount: b.buckets.discretionary, color: DISC },
  ].filter((p) => p.amount > 0.5);
  const used = plan.categories.filter((c) => c.spent > 0.005);
  const shown = showAll ? plan.categories : used;
  const periodLabel = PERIODS.find(([k]) => k === period)[1].toLowerCase();

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Personal spending</h1>
        <span className="seg-toggle" role="group" aria-label="Period" style={{ marginLeft: 'auto' }}>
          {PERIODS.map(([k, l]) => <button key={k} type="button" aria-pressed={period === k} className={period === k ? 'on' : ''} onClick={() => setPeriod(k)}>{l}</button>)}
        </span>
      </div>
      {error && <p className="review-error" style={{ margin: '0 0 12px' }}>{error}</p>}

      <div className="grid personal-cards">
        <MetricCard label={`Spent, ${periodLabel}`} value={money(b.total)} sub={`about ${money(b.total / nMonths)} a month · Jake, Ashley and untagged`} />
        <MetricCard label="A typical month" value={money(typical)} sub={past.length ? `median of the last ${past.length} full months` : 'not enough history yet'} />
        <MetricCard label={`Forecast for ${next ? monthName(next.month) : 'next month'}`} value={next ? money(next.essential + next.discretionary) : '—'}
          sub={next ? `${money(next.essential)} essentials + ${money(next.discretionary)} discretionary` : ''} />
        <MetricCard label="Discretionary a month" value={money(plan.discretionary.per_month)}
          sub={plan.mode === 'plan' ? 'from the farm-profit plan' : plan.monthly_budget != null ? 'your budget' : 'what you actually spend (median of 6 months)'} />
      </div>

      {plan.pace?.over && (
        <p className="pace-warn" role="status">
          Discretionary spending has run {plan.pace.over_pct}% over {money(plan.pace.budget_month)} a month two months running
          ({plan.pace.last_two.map((m) => `${monthName(m.month)} ${money(m.spent)}`).join(', ')}).
        </p>
      )}

      <div className="panel">
        <div className="panel-header spend-header"><span>Where it goes — {periodLabel}</span><span className="split-lines">Click a slice or a row</span></div>
        {!cats.length ? <div className="empty-state">No household spending in this period.</div> : (
          <div className="ps-pie-wrap">
            <Pie slices={slices} selected={sel} onSelect={setSel} size={260} label="Household spending by category" centerTitle={periodLabel === 'this year' ? 'Spent this year' : 'Spent'} highlight={hl} />
            <div className="ps-pie-side">
              {cur ? (
                <div className="ps-detail">
                  <div className="ps-detail-head"><span className="ps-swatch" style={{ background: cur.color }} />{cur.label}</div>
                  <div className="ps-detail-big">{cents(cur.amount)} <span>{b.total ? Math.round((cur.amount / b.total) * 1000) / 10 : 0}% · about {money(cur.amount / nMonths)} a month</span></div>
                  {cur.rest ? (
                    <ul className="ps-lines">{cur.rest.map((r) => (
                      <li key={r.key} className="ps-line-pick" tabIndex={0} onClick={() => setSel(r.key)} onKeyDown={(e) => { if (e.key === 'Enter') setSel(r.key); }}>
                        <span>{r.label}</span><span>{cents(r.amount)}</span>
                      </li>
                    ))}</ul>
                  ) : (
                    <>
                      {cur.c.discretionary > 0.5 && cur.c.essential > 0.5 && (
                        <p>{money(cur.c.essential)} essential, {money(cur.c.discretionary)} discretionary.</p>
                      )}
                      <ul className="pp-subs">
                        {cur.c.children.map((ch) => {
                          const key = `${cur.label}|${ch.name}`;
                          const on = openSub === key;
                          return (
                            <li key={ch.name} className={`pp-sub-pick${on ? ' on' : ''}`} tabIndex={0} aria-pressed={on}
                              onClick={() => setOpenSub(on ? null : key)} onKeyDown={(e) => { if (e.key === 'Enter') setOpenSub(on ? null : key); }}>
                              <div className="pp-sub-head"><span>{ch.name === cur.label ? 'Directly under it' : ch.name} <span className="split-lines">· {ch.count}</span></span><b>{cents(ch.amount)}</b></div>
                              <div className="pp-sub-bar"><span style={{ width: `${Math.max(2, (ch.amount / cur.amount) * 100)}%`, background: cur.color }} /></div>
                              <div className="split-lines">{ch.payees.map((p) => `${p.name} ${money(p.amount)}`).join(' · ')}</div>
                            </li>
                          );
                        })}
                      </ul>
                      {cur.label === 'Card payments (not itemized)' && (
                        <p>Payments on cards whose purchases aren't entered: Money Hub can't see what was bought. Give the card a "Payments count as" category on Credit Cards, or itemize it.</p>
                      )}
                      {cur.label === 'Uncategorized' && <p>Spending with no category. <a className="small-link" href="/ledgers">Categorize it in Ledgers</a>.</p>}
                    </>
                  )}
                  <button type="button" className="small-link" onClick={() => setSel(null)}>Back to all</button>
                </div>
              ) : <Legend items={slices} total={b.total} selected={sel} onSelect={(k) => { setSel(k); setHl(null); }} onHover={setHl} />}
            </div>
          </div>
        )}
      </div>

      <div className="panel" id="ps-entries">
        <div className="panel-header spend-header">
          <span>Entries — {cur && !cur.rest ? (openSub ? openSub.split('|').join(' › ').replace(/^(.+) › \1$/, '$1') : cur.label) : 'all household spending'}, {periodLabel}</span>
          <span className="split-lines">{entriesShown.length} · {cents(entriesTotal)}</span>
        </div>
        <p>{cur && !cur.rest ? 'Click a subcategory above to narrow it; ' : 'Click a category above to narrow it; '}click an entry to open it in the ledger.
          {(cur && !cur.rest) && <> <button type="button" className="small-link" onClick={() => setSel(null)}>Show everything</button></>}</p>
        {entriesShown.length ? <div className="ps-entries-panel"><Entries entries={entriesShown} showCategory={!cur || cur.rest || cur.c?.children.length > 1} /></div>
          : <div className="empty-state">No entries.</div>}
      </div>

      <div className="panel">
        <div className="panel-header spend-header">
          <span>Month by month</span>
          <span className="pp-key"><span className="ps-swatch" style={{ background: ESS }} />Essentials<span className="ps-swatch" style={{ background: DISC, marginLeft: 12 }} />Discretionary<span className="ps-swatch pp-hatch-swatch" style={{ marginLeft: 12 }} />Forecast</span>
        </div>
        <div className="pp-bars-wrap"><MonthBars months={months} /></div>
        <p>
          The last three bars are the forecast Cash Flow uses: essentials from what you spend
          ({plan.essentials.basis}), less the bills, card statements and loan interest already in the forecast that month;
          discretionary at {money(plan.discretionary.per_month)} a month.
        </p>
      </div>

      <div className="pp-two">
        <div className="panel">
          <div className="panel-header">Who spent it — {periodLabel}</div>
          <div className="ps-pie-wrap">
            {people.length ? <Pie slices={people} size={170} label="Spending by person" /> : null}
            <div className="ps-pie-side"><Legend items={people} total={b.total} /></div>
          </div>
          {b.people.unassigned > 0.5 && <p>Untagged personal spending counts for both of you in the forecast. Tag it in Ledgers to see it here.</p>}
        </div>
        <div className="panel">
          <div className="panel-header">Essential or discretionary — {periodLabel}</div>
          <div className="ps-pie-wrap">
            {kinds.length ? <Pie slices={kinds} size={170} label="Essential or discretionary" /> : null}
            <div className="ps-pie-side"><Legend items={kinds} total={b.total} /></div>
          </div>
          <p>Each category's bucket is set below under "Which spending is which".</p>
        </div>
      </div>

      <BudgetFit onChanged={loadPlan} />

      <div className="panel">
        <div className="panel-header">Discretionary in the forecast</div>
        <div className="pp-budget">
          <span className="seg-toggle" role="group" aria-label="How discretionary is forecast">
            {[['actual', 'What we actually spend'], ['plan', 'Plan from farm profit']].map(([k, l]) => (
              <button key={k} type="button" aria-pressed={plan.mode === k} className={plan.mode === k ? 'on' : ''}
                onClick={() => plan.mode !== k && send('PUT', '/api/personal/settings', { mode: k })}>{l}</button>
            ))}
          </span>
          {plan.mode === 'actual' && (
            <span className="pp-budget-set">
              {budget == null ? (
                <>
                  <span>{plan.monthly_budget != null ? `Budget ${money(plan.monthly_budget)} a month` : `Median of the last 6 months: ${money(plan.typical_discretionary)} a month`}</span>
                  <button type="button" className="small secondary" onClick={() => setBudget(plan.monthly_budget ?? '')}>{plan.monthly_budget != null ? 'Change budget' : 'Set a budget'}</button>
                  {plan.monthly_budget != null && <button type="button" className="small-link" onClick={() => send('PUT', '/api/personal/settings', { monthly_budget: null })}>Use what we spend</button>}
                </>
              ) : (
                <>
                  <input type="number" min="0" step="50" aria-label="Monthly discretionary budget" value={budget} onChange={(e) => setBudget(e.target.value)} />
                  <button type="button" className="small" onClick={() => send('PUT', '/api/personal/settings', { monthly_budget: budget === '' ? null : Number(budget) }).then((ok) => ok && setBudget(null))}>Save</button>
                  <button type="button" className="small-link" onClick={() => setBudget(null)}>Cancel</button>
                </>
              )}
            </span>
          )}
        </div>
        {plan.mode === 'actual' ? (
          <p>
            No farm profit or tax in it: the forecast assumes discretionary spending carries on at {money(plan.discretionary.per_month)} a month.
            {plan.discretionary_history?.length > 0 && ` Last months: ${plan.discretionary_history.map((m) => `${monthName(m.month)} ${money(m.amount)}`).join(', ')}.`}
          </p>
        ) : (
          <>
            <p>The yearly limit worked out from the farm's projected profit, after tax, savings and essentials. Uses the tax projection.</p>
            <table className="plan-steps" data-nostack="">
              <tbody>
                {plan.steps.map((s) => (
                  <tr key={s.key}><td>{s.label}</td><td className={`num ${s.amount < 0 ? 'out' : ''}`}>{s.amount < 0 ? '−' : s.key === 'profit' ? '' : '+'}{cents(Math.abs(s.amount))}</td></tr>
                ))}
                <tr className="plan-total"><td>Discretionary limit for {plan.year}</td><td className="num">{cents(plan.limit)}</td></tr>
              </tbody>
            </table>
          </>
        )}
      </div>

      <OwnerCheck onChanged={() => { loadPlan(); loadB(); }} />

      <div className="panel">
        <div className="panel-header personal-cats-head">
          <span>Which spending is which <span className="split-lines">— spent so far in {plan.year}; click a category for its entries</span></span>
          <span>
            {showCats && <button type="button" className="small-link" onClick={() => setShowAll(!showAll)} style={{ marginRight: 12 }}>{showAll ? 'Only categories you spent in' : 'All categories'}</button>}
            <button type="button" className="small-link" onClick={() => setShowCats(!showCats)}>{showCats ? 'Hide' : 'Show'}</button>
          </span>
        </div>
        {showCats && (shown.length === 0 ? <div className="empty-state">No personal spending recorded this year yet.</div> : (
          <table className="personal-cats">
            <tbody>
              {shown.map((c) => (
                <Fragment key={c.id}>
                <tr>
                  <td>
                    {c.spent > 0.005 ? (
                      <button type="button" className="pc-open" aria-expanded={catOpen?.id === c.id} onClick={() => openCat(c)}>
                        <span className="pc-caret" aria-hidden="true">{catOpen?.id === c.id ? '▾' : '▸'}</span>{c.full}
                      </button>
                    ) : c.full}
                    {!c.set && <span className="split-lines"> · default</span>}
                  </td>
                  <td className="num">{c.spent > 0.005 ? cents(c.spent) : ''}</td>
                  <td>
                    <span className="seg-toggle" role="group" aria-label={`Bucket for ${c.full}`}>
                      {[['essential', 'Essential'], ['discretionary', 'Discretionary']].map(([k, l]) => (
                        <button key={k} type="button" aria-pressed={c.bucket === k} className={c.bucket === k ? 'on' : ''}
                          onClick={() => c.bucket !== k && send('PUT', `/api/personal/categories/${c.id}`, { bucket: k })}>{l}</button>
                      ))}
                    </span>
                  </td>
                </tr>
                {catOpen?.id === c.id && (
                  <tr className="pc-entries-row">
                    <td colSpan={3}>
                      {!catOpen.entries ? <span className="split-lines">Loading…</span>
                        : catOpen.entries.length ? <Entries entries={catOpen.entries} />
                        : <span className="split-lines">No entries this year.</span>}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </>
  );
}
