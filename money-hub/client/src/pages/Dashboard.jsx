import { useEffect, useState } from 'react';
import MetricCard from '../components/MetricCard.jsx';
import { money, ratio, pct } from '../format.js';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/dashboard')
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="empty-state">Could not load dashboard: {error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  const { dscr, liquidity, reserve, upcomingDebtService, ownerDrawYTD, year } = data;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <span className="page-meta">FY {year}</span>
      </div>

      <div className="grid">
        <MetricCard
          label="Liquidity floor"
          value={money(liquidity.floorMonth.balance)}
          sub={`Month ${liquidity.floorMonth.month} · required ${money(liquidity.requiredFloor)} (${pct(liquidity.bufferPct)} buffer)`}
          tone={liquidity.passes ? 'positive' : 'negative'}
        />
        <MetricCard
          label="DSCR (worst month)"
          value={dscr.worstMonth ? ratio(dscr.worstMonth.dscr) : '—'}
          sub={`Threshold ${ratio(dscr.threshold)} · month ${dscr.worstMonth?.month ?? '—'}`}
          tone={dscr.passes === false ? 'negative' : dscr.passes ? 'positive' : undefined}
        />
        <MetricCard
          label="Reserve"
          value={money(reserve.currentReserve)}
          sub={`Target ${money(reserve.target)} (${reserve.targetMonths} mo.) · ${pct(reserve.fundedPct)} funded`}
          tone={reserve.passes ? 'positive' : 'negative'}
        />
        <MetricCard
          label="Owner draw YTD"
          value={money(ownerDrawYTD)}
        />
      </div>

      <div className="panel">
        <div className="panel-header">Upcoming debt service</div>
        {upcomingDebtService.length === 0 ? (
          <div className="empty-state">No scheduled payments on file.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Due</th>
                <th>Lender</th>
                <th>Principal</th>
                <th>Interest</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {upcomingDebtService.map((p, i) => (
                <tr key={i}>
                  <td>{p.due_date?.slice(0, 10)}</td>
                  <td>{p.lender}</td>
                  <td>{money(Number(p.principal_amount))}</td>
                  <td>{money(Number(p.interest_amount))}</td>
                  <td>{money(Number(p.principal_amount) + Number(p.interest_amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
