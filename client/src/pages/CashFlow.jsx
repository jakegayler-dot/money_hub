import { useEffect, useState } from 'react';
import MetricCard from '../components/MetricCard.jsx';
import { money, pct } from '../format.js';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Inline SVG line chart: projected balance across the year, with the
// required liquidity floor as a labeled dashed reference line. One data
// series (the title names it, so no legend box); the floor line uses the
// app's reserved negative/status color and carries its own text label, so
// it's never color-alone. Native <title> tooltips on each marker, and the
// full table below is the accessible view of the same numbers.
function TrajectoryChart({ trajectory, requiredFloor }) {
  const W = 720, H = 260;
  const pad = { top: 16, right: 16, bottom: 28, left: 76 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const values = trajectory.map((t) => t.balance).concat([requiredFloor, 0]);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = rawMax - rawMin || 1;
  const yMin = rawMin - span * 0.08;
  const yMax = rawMax + span * 0.08;

  const x = (i) => pad.left + (i / (trajectory.length - 1 || 1)) * innerW;
  const y = (v) => pad.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  const path = trajectory.map((t, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(t.balance).toFixed(1)}`).join(' ');

  // ~4 horizontal gridlines at round intervals
  const gridLines = [];
  const step = span / 4;
  for (let g = 0; g <= 4; g++) {
    const v = rawMin + step * g;
    gridLines.push(v);
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img"
      aria-label="Projected cash balance by month against the required liquidity floor">
      {gridLines.map((v, i) => (
        <g key={i}>
          <line x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
          <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)" fontFamily="var(--font-mono)">
            {money(Math.round(v))}
          </text>
        </g>
      ))}

      {/* Required floor: reserved status color, dashed, directly labeled */}
      <line x1={pad.left} x2={W - pad.right} y1={y(requiredFloor)} y2={y(requiredFloor)}
        stroke="var(--negative)" strokeWidth="1.5" strokeDasharray="6 4" />
      <text x={W - pad.right} y={y(requiredFloor) - 6} textAnchor="end" fontSize="11" fill="var(--negative)">
        Required floor {money(Math.round(requiredFloor))}
      </text>

      {/* Projected balance series */}
      <path d={path} fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {trajectory.map((t, i) => (
        <circle key={t.month} cx={x(i)} cy={y(t.balance)} r="4"
          fill="var(--gold)" stroke="var(--panel)" strokeWidth="2">
          <title>
            {`${MONTH_NAMES[t.month - 1]}: projected ${money(Math.round(t.balance))}
NOI ${money(Math.round(t.noi ?? 0))} · contracts +${money(Math.round(t.contractInflows ?? 0))}
bills −${money(Math.round(t.unpaidBillsDue ?? 0))} · debt −${money(Math.round(t.debtServiceDue ?? 0))} · fees −${money(Math.round(t.accountFees ?? 0))}`}
          </title>
        </circle>
      ))}

      {trajectory.map((t, i) => (
        <text key={t.month} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
          {MONTH_NAMES[t.month - 1]}
        </text>
      ))}
    </svg>
  );
}

export default function CashFlow() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/dashboard')
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok || !body || !body.liquidity) throw new Error((body && body.error) || `Server returned ${r.status}`);
        return body;
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="empty-state">Could not load forecast: {error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  const { liquidity, year } = data;
  const { trajectory, floorMonth, requiredFloor, bufferPct, startingBalance, passes } = liquidity;
  const yearEnd = trajectory[trajectory.length - 1];

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Cash Flow</h1>
        <span className="page-meta">FY {year} projection</span>
      </div>

      <div className="grid">
        <MetricCard
          label="Lowest projected point"
          value={money(floorMonth.balance)}
          sub={`${MONTH_NAMES[floorMonth.month - 1]} — the month that binds`}
          tone={passes ? 'positive' : 'negative'}
        />
        <MetricCard
          label="Required floor"
          value={money(requiredFloor)}
          sub={`${pct(bufferPct)} buffer on avg monthly expenses`}
        />
        <MetricCard
          label="Starting balance"
          value={money(startingBalance)}
          sub="Business operating accounts today"
        />
        <MetricCard
          label="Projected year end"
          value={money(yearEnd.balance)}
          tone={yearEnd.balance >= requiredFloor ? 'positive' : 'negative'}
        />
      </div>

      <div className="panel">
        <div className="panel-header">Projected business cash balance — {year}</div>
        <TrajectoryChart trajectory={trajectory} requiredFloor={requiredFloor} />
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 0' }}>
          Each month starts from actual booked income/expenses (NOI), then adds unsettled contract
          inflows at their expected payment month and subtracts unpaid bills, scheduled loan payments,
          and account fees at their due months. Settling a contract or paying a bill moves it from
          forecast to actuals — the line updates, nothing is counted twice. The liquidity gate binds
          at the lowest point of this line, not at today's balance.
        </p>
      </div>

      <div className="panel">
        <div className="panel-header">Month by month</div>
        <table>
          <thead>
            <tr>
              <th>Month</th><th>NOI (booked)</th><th>Contract inflows</th><th>Bills due</th>
              <th>Debt service</th><th>Fees</th><th>Projected balance</th>
            </tr>
          </thead>
          <tbody>
            {trajectory.map((t) => {
              const isFloor = t.month === floorMonth.month;
              const below = t.balance < requiredFloor;
              return (
                <tr key={t.month} style={isFloor ? { background: 'var(--panel-hover)' } : undefined}>
                  <td>
                    {MONTH_NAMES[t.month - 1]}
                    {isFloor && <> <span className={`badge ${passes ? 'warn' : 'fail'}`}>FLOOR</span></>}
                  </td>
                  <td>{money(Math.round(t.noi ?? 0))}</td>
                  <td>{t.contractInflows ? `+${money(Math.round(t.contractInflows))}` : '—'}</td>
                  <td>{t.unpaidBillsDue ? `−${money(Math.round(t.unpaidBillsDue))}` : '—'}</td>
                  <td>{t.debtServiceDue ? `−${money(Math.round(t.debtServiceDue))}` : '—'}</td>
                  <td>{t.accountFees ? `−${money(Math.round(t.accountFees))}` : '—'}</td>
                  <td style={below ? { color: 'var(--negative)' } : undefined}>{money(Math.round(t.balance))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
