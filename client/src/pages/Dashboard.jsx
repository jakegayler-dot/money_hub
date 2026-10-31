import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import DueThisWeek from '../components/DueThisWeek.jsx';
import { money, ratio, pct } from '../format.js';
import { OWNER_KEYS, OWNER_LABELS } from '../owners.jsx';
import './dashboard.css';

// The dashboard (Jake, Oct 30: "it looks like a bunch of horribly formatted tables; it's meant to be appealing to
// the eye and easy to quickly see the information that matters"). Top down: cash now and the next 12 months against
// the floor; four health checks at a glance (floor, debt coverage, reserve, overdue); this week, money out and money
// in; where the farm stands (net worth, cards, bills); and the working (coverage build, loan payments, bill list)
// folded away below.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mlabel = (m) => `${MONTHS[m.month - 1]} ${m.year}`;
const mshort = (m) => `${MONTHS[m.month - 1]} ’${String(m.year).slice(2)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const kmoney = (v) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `$${Math.round(a / 1000)}k` : money(a);
  return v < 0 ? `−${s}` : s;
};
function overdueLabel(o) {
  const parts = [
    o.bills ? plural(o.bills, 'bill', 'bills') : null,
    o.loan_payments ? plural(o.loan_payments, 'loan payment', 'loan payments') : null,
    o.card_statements ? plural(o.card_statements, 'card statement', 'card statements') : null,
  ].filter(Boolean);
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// The next 12 months of month-end cash against the floor: an area, the floor as a line, the tightest month marked.
function CashChart({ months, floorMonth }) {
  if (!months?.length) return null;
  const W = 640, H = 150, P = { l: 6, r: 6, t: 14, b: 6 };
  const vals = months.map((m) => m.balance);
  const floors = months.map((m) => m.floor ?? 0);
  const lo = Math.min(0, ...vals, ...floors), hi = Math.max(...vals, ...floors) * 1.08 || 1;
  const x = (i) => P.l + (i / Math.max(1, months.length - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(vals.length - 1).toFixed(1)},${y(lo).toFixed(1)} L${x(0).toFixed(1)},${y(lo).toFixed(1)} Z`;
  const floorLine = floors.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ti = months.findIndex((m) => m.year === floorMonth?.year && m.month === floorMonth?.month);
  return (
    <svg className="dbx-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Month-end cash for the next 12 months against the floor">
      <defs>
        <linearGradient id="dbxArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--gold)" stopOpacity="0.35" /><stop offset="100%" stopColor="var(--gold)" stopOpacity="0" /></linearGradient>
      </defs>
      {lo < 0 && <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} className="dbx-zero" />}
      <path d={area} fill="url(#dbxArea)" />
      <path d={floorLine} className="dbx-floor" />
      <path d={line} className="dbx-line" />
      {vals.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={i === ti ? 5 : 2.5} className={v < floors[i] ? 'dbx-pt bad' : 'dbx-pt'} />)}
    </svg>
  );
}

// A bar from 0 to a scale, with the lender's line marked.
function Gauge({ value, max, mark, tone }) {
  const w = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="dbx-gauge">
      <i className={`dbx-gauge-fill ${tone}`} style={{ width: `${w}%` }} />
      {mark != null && <b className="dbx-gauge-mark" style={{ left: `${Math.min(100, (mark / max) * 100)}%` }} />}
    </div>
  );
}

function Health({ label, value, sub, tone, to, children }) {
  return (
    <Link to={to} className={`dbx-health ${tone}`}>
      <span className="dbx-health-label"><span className={`dbx-dot ${tone}`} />{label}</span>
      <span className="dbx-health-value">{value}</span>
      {children}
      {sub && <span className="dbx-health-sub">{sub}</span>}
    </Link>
  );
}

// Earnings this year, by owner (what the old owner bar on top showed, folded in here).
const VIEWS = [{ key: 'all', label: 'Combined' }, ...OWNER_KEYS.map((k) => ({ key: k, label: OWNER_LABELS[k] }))];
const signed = (n) => `${n >= 0 ? '+' : '−'}${money(Math.abs(Math.round(n)))}`;
function Earnings() {
  const [entity, setEntity] = useState(() => { try { const v = localStorage.getItem('moneyhub.entity'); return VIEWS.some((x) => x.key === v) ? v : 'all'; } catch { return 'all'; } });
  const [d, setD] = useState(null);
  useEffect(() => {
    try { localStorage.setItem('moneyhub.entity', entity); } catch { /* fine */ }
    let off = false;
    fetch(`/api/entity-summary?entity=${entity}`).then((r) => r.json()).then((x) => { if (!off && x?.earningsYTD) setD(x); }).catch(() => {});
    return () => { off = true; };
  }, [entity]);
  const e = d?.earningsYTD;
  return (
    <div className="dbx-card dbx-earn">
      <div className="dbx-card-head"><span>{e?.kind === 'personal' ? 'Net personal cash' : 'Farm earnings'}, {new Date().getFullYear()} to date</span><Link className="small-link" to={`/expenses${entity === 'all' ? '' : `?owner=${entity}`}`}>Expenses</Link></div>
      <div className="dbx-seg" role="tablist" aria-label="Whose">
        {VIEWS.map((v) => <button key={v.key} type="button" role="tab" aria-selected={entity === v.key} className={entity === v.key ? 'on' : ''} onClick={() => setEntity(v.key)}>{v.label}</button>)}
      </div>
      {!e ? <span className="dbx-s">Loading…</span> : (
        <>
          <span className={`dbx-v ${e.total < 0 ? 'neg' : 'pos'}`}>{signed(e.total)}</span>
          <div className="dbx-split" aria-hidden="true"><i className="in" style={{ flex: Math.max(1, e.revenue) }} /><i className="out" style={{ flex: Math.max(0, e.costs) }} /></div>
          <span className="dbx-s">In {money(e.revenue)} · out {money(e.costs)}{e.household != null ? ` · household ${signed(e.household)}` : ''}</span>
          {e.no_owner?.count > 0 && <Link className="dbx-s neg" to="/ledgers">{e.no_owner.count} entr{e.no_owner.count === 1 ? 'y' : 'ies'} ({money(e.no_owner.amount)}) with no owner</Link>}
          {entity === 'all' && Math.abs(d.unassignedCash || 0) >= 1 && <Link className="dbx-s" to="/accounts">{money(d.unassignedCash)} of cash isn't tagged to an owner yet</Link>}
        </>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    fetch('/api/dashboard')
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok || !body || !body.liquidity || !body.coverage || !body.reserve) {
          throw new Error((body && body.error) || `Server returned ${r.status}`);
        }
        return body;
      })
      .then(setData)
      .catch((e) => setError(e.message));
  };
  useEffect(() => { load(); }, []);

  if (error) return <div className="empty-state">Could not load dashboard: {error}. Try refreshing — if it persists, check the server's deploy logs.</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  const { coverage, liquidity, reserve, upcomingDebtService, ownerDrawYTD, bills, overdue, annualAccountFees, outstandingChecks, contractedInflows, creditCards, netWorth, year } = data;
  const months = (liquidity.trajectory || []).slice(0, 12);
  const fm = liquidity.floorMonth;
  const floor = liquidity.requiredFloor ?? fm?.floor ?? 0;
  const short = fm ? Math.round((fm.floor ?? floor) - fm.balance) : 0;
  const cash = liquidity.startingBalance;
  const free = cash - (liquidity.floorNow ?? floor);
  const covTone = coverage.passes === false ? 'bad' : coverage.passes ? 'good' : 'quiet';
  const inNext = months.slice(0, 3).reduce((t, m) => t + (m.contractInflows || 0) + (m.estimatedInflows || 0), 0);

  return (
    <div className="dbx">
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <span className="page-meta">FY {year}</span>
      </div>

      {/* Cash: now, and the year ahead against the floor */}
      <section className={`dbx-hero ${liquidity.passes ? '' : 'tight'}`}>
        <div className="dbx-hero-figs">
          <Link to="/accounts" className="dbx-big"><span className="dbx-k">Cash today</span><span className="dbx-v">{money(cash)}</span></Link>
          <div className="dbx-big"><span className="dbx-k">Free over the floor</span><span className={`dbx-v ${free < 0 ? 'neg' : ''}`}>{money(free)}</span><span className="dbx-s">floor {money(floor)}{liquidity.floorCap != null ? ' (capped)' : ''}</span></div>
          <Link to="/cash-flow" className={`dbx-callout ${liquidity.passes ? 'ok' : 'bad'}`}>
            {liquidity.passes
              ? <>Every month-end stays over the floor. Lowest: <b>{mlabel(liquidity.lowestMonth)}</b>, {money(liquidity.lowestMonth.balance)}.</>
              : <><b>{mlabel(fm)}</b> ends at {money(fm.balance)}, {money(short)} under the floor.</>}
          </Link>
        </div>
        <Link to="/cash-flow" className="dbx-chart-wrap">
          <CashChart months={months} floorMonth={fm} />
          <div className="dbx-axis-row" aria-hidden="true">
            {months.map((m, i) => (i % 2 === 0 ? <span key={i} style={{ left: `${(i / Math.max(1, months.length - 1)) * 100}%` }} className={i === 0 ? 'first' : ''}>{mshort(m)}</span> : null))}
          </div>
          <span className="dbx-legend"><i className="l-cash" />Month-end cash <i className="l-floor" />Floor</span>
        </Link>
      </section>

      {/* Discretionary spending this month against the budget (Jake, Oct 31) */}
      {liquidity.personal?.per_month > 0 && (() => {
        const p = liquidity.personal;
        const spent = p.spent_this_month || 0; const left = p.per_month - spent; const over = left < 0;
        const now = new Date(); const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(); const daysLeft = dim - now.getDate() + 1;
        const pace = (spent / Math.max(1, now.getDate())) * dim;
        return (
          <Link to="/personal" className={`dbx-spend ${over ? 'over' : ''}`}>
            <div className="dbx-spend-figs">
              <span className="dbx-k">Spending this month</span>
              <span className={`dbx-v ${over ? 'neg' : ''}`}>{over ? `${money(-left)} over` : `${money(left)} left`}</span>
              <span className="dbx-s">{money(spent)} of {money(p.per_month)} · {daysLeft} day{daysLeft === 1 ? '' : 's'} to go{!over && daysLeft > 1 ? ` · ${money(left / daysLeft)} a day` : ''}</span>
            </div>
            <span className="dbx-spend-bar" role="img" aria-label={`${money(spent)} of ${money(p.per_month)} spent`}>
              <span style={{ width: `${Math.min(100, (spent / p.per_month) * 100)}%` }} />
              {pace > spent && pace > 0 && <i style={{ left: `${Math.min(100, (pace / p.per_month) * 100)}%` }} title={`At this pace: ${money(pace)} by month-end`} />}
            </span>
            <span className="dbx-s">Discretionary: everything but bills and loan payments already planned. {p.binding?.until ? `Budget = cash at ${new Date(`${p.binding.until}T12:00:00`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })} ÷ ${p.binding.months_to_it} months.` : ''}</span>
          </Link>
        );
      })()}

      {/* Health at a glance */}
      <section className="dbx-healths">
        <Health label="Cash floor" to="/cash-flow" tone={liquidity.passes ? 'good' : 'bad'}
          value={liquidity.passes ? 'Holding' : `${money(short)} short`}
          sub={liquidity.passes ? `Tightest ${mlabel(fm)} · ${money(fm.balance)}` : `${mlabel(fm)} · ${money(fm.balance)} vs ${money(fm.floor ?? floor)}`} />
        <Health label="Debt coverage" to="/loans" tone={covTone}
          value={coverage.projected.ratio != null ? ratio(coverage.projected.ratio) : 'No term debt'}
          sub={`Lenders want ${ratio(coverage.threshold)} · last 12 mo ${coverage.historical.ratio != null ? ratio(coverage.historical.ratio) : '—'}`}>
          {coverage.projected.ratio != null && <Gauge value={coverage.projected.ratio} max={Math.max(3, coverage.threshold * 2)} mark={coverage.threshold} tone={covTone} />}
        </Health>
        <Health label="Reserve" to="/accounts" tone={reserve.passes ? 'good' : reserve.fundedPct > 0.5 ? 'warn' : 'bad'}
          value={money(reserve.currentReserve)}
          sub={`${pct(reserve.fundedPct)} of ${money(reserve.target)} (${reserve.targetMonths} months)`}>
          <Gauge value={reserve.fundedPct} max={1} tone={reserve.passes ? 'good' : 'warn'} />
        </Health>
        <Health label="Overdue" to="/calendar" tone={overdue?.count ? 'bad' : 'good'}
          value={overdue?.count ? money(overdue.total) : 'Nothing'}
          sub={overdue?.count ? overdueLabel(overdue) : 'Bills, loans and cards all current'} />
      </section>

      {/* This week */}
      <section className="dbx-week">
        <div className="dbx-week-out"><DueThisWeek compact onChanged={load} /></div>
        <div className="dbx-card dbx-in">
          <div className="dbx-card-head"><span>Money coming in</span><Link className="small-link" to="/contracts">Contracts</Link></div>
          <div className="dbx-in-figs">
            <div><span className="dbx-k">Contracted, unpaid</span><span className="dbx-v sm pos">{money(contractedInflows?.total || 0)}</span><span className="dbx-s">{contractedInflows?.count ? plural(contractedInflows.count, 'open contract', 'open contracts') : 'No open contracts'}</span></div>
            <div><span className="dbx-k">Next 3 months</span><span className="dbx-v sm">{money(inNext)}</span><span className="dbx-s">contracts and estimates in the forecast</span></div>
          </div>
          <div className="dbx-bars">
            {months.slice(0, 6).map((m) => {
              const max = Math.max(1, ...months.slice(0, 6).flatMap((x) => [x.inflow || 0, -(x.outflow || 0)]));
              return (
                <div key={`${m.year}-${m.month}`} className="dbx-bar" title={`${mlabel(m)}: in ${money(m.inflow || 0)}, out ${money(-(m.outflow || 0))}`}>
                  <div className="dbx-bar-pair"><i className="in" style={{ height: `${((m.inflow || 0) / max) * 100}%` }} /><i className="out" style={{ height: `${(-(m.outflow || 0) / max) * 100}%` }} /></div>
                  <span>{MONTHS[m.month - 1]}</span>
                </div>
              );
            })}
          </div>
          <span className="dbx-legend"><i className="l-in" />In <i className="l-out" />Out</span>
        </div>
      </section>

      {/* Where the farm stands */}
      <section className="dbx-stand">
        <Earnings />
        {netWorth && (
          <Link to="/financials?tab=balance" className="dbx-card">
            <div className="dbx-card-head"><span>Net worth</span></div>
            <span className={`dbx-v ${netWorth.total < 0 ? 'neg' : ''}`}>{money(netWorth.total)}</span>
            <div className="dbx-split" aria-hidden="true"><i style={{ flex: Math.max(0, netWorth.total) }} className="eq" /><i style={{ flex: netWorth.liabilities }} className="debt" /></div>
            <span className="dbx-s">Assets {kmoney(netWorth.assets)} · owed {kmoney(netWorth.liabilities)} · {pct(netWorth.assets ? netWorth.total / netWorth.assets : 0)} yours</span>
          </Link>
        )}
        <Link to="/bills" className="dbx-card">
          <div className="dbx-card-head"><span>Unpaid bills</span></div>
          <span className="dbx-v">{money(bills.totalUnpaid)}</span>
          <span className={`dbx-s ${bills.overdueCount ? 'neg' : ''}`}>{bills.overdueCount ? `${plural(bills.overdueCount, 'bill', 'bills')} overdue` : 'None overdue'}</span>
        </Link>
        {creditCards && (
          <Link to="/credit-cards" className="dbx-card">
            <div className="dbx-card-head"><span>Credit cards</span></div>
            <span className="dbx-v">{money(creditCards.totalBalance)}</span>
            <span className={`dbx-s ${creditCards.gracePeriodLost ? 'neg' : ''}`}>{creditCards.gracePeriodLost > 0 ? `${creditCards.gracePeriodLost} of ${creditCards.count} carrying interest` : `${plural(creditCards.count, 'card', 'cards')} · no interest`}</span>
          </Link>
        )}
        {(ownerDrawYTD > 0 || annualAccountFees > 0 || outstandingChecks.count > 0) && (
          <div className="dbx-card dbx-minor">
            {ownerDrawYTD > 0 && <Link to="/personal"><span>Owner draw YTD</span><b>{money(ownerDrawYTD)}</b></Link>}
            {annualAccountFees > 0 && <Link to="/accounts"><span>Account fees a year</span><b>{money(annualAccountFees)}</b></Link>}
            {outstandingChecks.count > 0 && <Link to="/ledgers?outstanding=1"><span>{plural(outstandingChecks.count, 'cheque', 'cheques')} not cleared</span><b>{money(outstandingChecks.total)}</b></Link>}
          </div>
        )}
      </section>

      {/* The working, out of the way */}
      <details className="dbx-details">
        <summary>The details: debt coverage, loan payments, unpaid bills</summary>
        <div className="dbx-details-body">
          <div className="panel">
            <div className="panel-header spend-header"><span>Term debt coverage — ag lender standard</span><Link className="small-link" to="/loans">Loans</Link></div>
            <div className="coverage-grid">
              <CoverageBuild title="Last 12 months (actual)" period={coverage.historical} threshold={coverage.threshold} />
              <CoverageBuild title="Next 12 months (projected)" period={coverage.projected} threshold={coverage.threshold} />
            </div>
            <p className="coverage-note">
              Cash available for term debt ÷ scheduled principal + interest on term loans. Operating lines are an
              expense here (interest only), not term debt. Personal loans are excluded. Seasonal dips are covered by
              the liquidity floor, not this ratio.
            </p>
          </div>
          <div className="dbx-two">
            <div className="dbx-card">
              <div className="dbx-card-head"><span>Upcoming loan payments</span><Link className="small-link" to="/loans">Loans</Link></div>
              {upcomingDebtService.length === 0 ? <span className="dbx-s">No scheduled payments on file.</span> : upcomingDebtService.map((p, i) => (
                <div key={i} className="dbx-row"><span>{p.lender}<em>{p.due_date?.slice(0, 10)} · interest {money(Number(p.interest_amount))}</em></span><b>{money(Number(p.principal_amount) + Number(p.interest_amount))}</b></div>
              ))}
            </div>
            <div className="dbx-card">
              <div className="dbx-card-head"><span>Unpaid bills, soonest first</span><Link className="small-link" to="/bills">Bills</Link></div>
              {bills.upcoming.length === 0 ? <span className="dbx-s">Nothing outstanding.</span> : bills.upcoming.map((b) => {
                const late = String(b.due_date).slice(0, 10) < new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
                return <div key={b.id} className="dbx-row"><span className={late ? 'neg' : ''}>{b.name}<em>{late ? 'overdue · ' : ''}{b.due_date?.slice(0, 10)}{b.category ? ` · ${b.category}` : ''}</em></span><b>{money(Number(b.amount))}</b></div>;
              })}
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}

function CoverageBuild({ title, period, threshold }) {
  const passes = period.ratio == null ? null : period.ratio >= threshold;
  return (
    <table className="coverage-build">
      <thead>
        <tr><th>{title}</th><th className="num">{period.from} → {period.to}</th></tr>
      </thead>
      <tbody>
        {period.lines.map((l) => (
          <tr key={l.label}><td>{l.label}</td><td className="num">{money(l.amount)}</td></tr>
        ))}
        <tr className="subtotal"><td>Available for term debt</td><td className="num">{money(period.capacity)}</td></tr>
        <tr><td>Term principal</td><td className="num">{money(period.termPrincipal)}</td></tr>
        <tr><td>Term interest</td><td className="num">{money(period.termInterest)}</td></tr>
        <tr className="subtotal"><td>Term payments</td><td className="num">{money(period.termDebtService)}</td></tr>
        <tr className="subtotal">
          <td>Coverage</td>
          <td className="num">
            {period.ratio == null ? 'No term debt' : ratio(period.ratio)}{' '}
            {passes != null && <span className={`badge ${passes ? 'pass' : 'fail'}`}>{passes ? 'MEETS' : 'BELOW'} {ratio(threshold)}</span>}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
