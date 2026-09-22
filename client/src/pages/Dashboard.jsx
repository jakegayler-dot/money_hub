import { useEffect, useState } from 'react';
import MetricCard from '../components/MetricCard.jsx';
import { money, ratio, pct } from '../format.js';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/dashboard')
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok || !body || !body.liquidity || !body.dscr || !body.reserve) {
          throw new Error((body && body.error) || `Server returned ${r.status}`);
        }
        return body;
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="empty-state">Could not load dashboard: {error}. Try refreshing — if it persists, check the server's deploy logs.</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  const { dscr, liquidity, reserve, upcomingDebtService, ownerDrawYTD, bills, annualAccountFees, outstandingChecks, contractedInflows, netWorth, year } = data;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <span className="page-meta">FY {year}</span>
      </div>

      <div className="grid">
        {netWorth && (
          <MetricCard
            label="Net worth"
            value={money(netWorth.total)}
            sub={`Cash ${money(netWorth.cash)} + assets ${money(netWorth.assetValues)} − loans ${money(netWorth.outstandingPrincipal)}`}
            tone={netWorth.total >= 0 ? 'positive' : 'negative'}
          />
        )}
        <MetricCard
          label="Liquidity floor"
          value={money(liquidity.floorMonth.balance)}
          sub={`${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][liquidity.floorMonth.month - 1]} ${liquidity.floorMonth.year || ''} · required ${money(liquidity.requiredFloor)} (${pct(liquidity.bufferPct)} buffer)`}
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
          label="Unpaid bills"
          value={money(bills.totalUnpaid)}
          sub={bills.overdueCount > 0 ? `${bills.overdueCount} overdue` : 'None overdue'}
          tone={bills.overdueCount > 0 ? 'negative' : undefined}
        />
        <MetricCard
          label="Owner draw YTD"
          value={money(ownerDrawYTD)}
        />
        <MetricCard
          label="Account fees (annual)"
          value={money(annualAccountFees)}
          sub="Recurring cost of holding accounts"
        />
        {contractedInflows && (
          <MetricCard
            label="Contracted inflows"
            value={money(contractedInflows.total)}
            sub={contractedInflows.count > 0
              ? `${contractedInflows.count} unsettled contract${contractedInflows.count === 1 ? '' : 's'} — already in the forecast`
              : 'No open contracts'}
            tone={contractedInflows.total > 0 ? 'positive' : undefined}
          />
        )}
        <MetricCard
          label="Outstanding checks"
          value={money(outstandingChecks.total)}
          sub={outstandingChecks.count > 0
            ? `${outstandingChecks.count} not yet cleared — already deducted from balance`
            : 'None outstanding'}
          tone={outstandingChecks.count > 0 ? 'negative' : undefined}
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

      <div className="panel">
        <div className="panel-header">Unpaid bills — soonest due first</div>
        {bills.upcoming.length === 0 ? (
          <div className="empty-state">Nothing outstanding.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Due</th><th>Name</th><th>Category</th><th>Amount</th><th>Status</th></tr>
            </thead>
            <tbody>
              {bills.upcoming.map((b) => {
                const overdue = new Date(b.due_date) < new Date();
                return (
                  <tr key={b.id}>
                    <td>{b.due_date?.slice(0, 10)}</td>
                    <td>{b.name}</td>
                    <td>{b.category || '—'}</td>
                    <td>{money(Number(b.amount))}</td>
                    <td>{overdue ? <span className="badge fail">OVERDUE</span> : <span className="badge warn">DUE</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
