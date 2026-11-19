import { Fragment, useMemo, useState } from 'react';
import { money } from '../format.js';

// The forecast by day, week, quarter or year (Jake, Nov 19: "can we show the cash flow forecast by day, week, month etc").
// Built from the same dated items as the month table (each month's items add up to its balances exactly), so every view
// lands on the same month-end figures. The household budget is a monthly amount the forecast dates on the 15th; here it's
// spread over its month's days (from today in this month), since it's spent through the month, not on one day.
//
// Each period: money in and out, the lowest cash in it (with estimates), and its closing balance committed-only and with
// estimates, against the floor of the month it falls in. Click a period for the items behind it.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ymd = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const signed = (v) => (Math.abs(v) < 0.5 ? '—' : `${v > 0 ? '+' : '−'}${money(Math.abs(Math.round(v)))}`);
const KIND = {
  contract: 'Contract', estimate_in: 'Estimated sale', inventory: 'Inventory sale', bill: 'Bill', loan: 'Loan payment', lease: 'Lease payment',
  card: 'Card statement', fee: 'Account fees', tax: 'Income tax', gst: 'GST', estimate_out: 'Estimated cost', personal: 'Personal spending', opline: 'Operating line',
};

export const GRAINS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];

function periodOf(date, grain) {
  const d = parse(date);
  const y = d.getUTCFullYear(); const m = d.getUTCMonth();
  if (grain === 'day') return { key: date, label: `${DOW[d.getUTCDay()]} ${MON[m]} ${d.getUTCDate()}${m === 0 && d.getUTCDate() === 1 ? `, ${y}` : ''}`, sort: date };
  if (grain === 'week') {
    const mon = addDays(date, -((d.getUTCDay() + 6) % 7));
    const md = parse(mon); const sun = parse(addDays(mon, 6));
    return { key: mon, label: `Week of ${MON[md.getUTCMonth()]} ${md.getUTCDate()}${md.getUTCFullYear() !== sun.getUTCFullYear() || (md.getUTCMonth() === 0 && md.getUTCDate() <= 7) ? `, ${md.getUTCFullYear()}` : ''}`, sort: mon };
  }
  if (grain === 'quarter') { const q = Math.floor(m / 3) + 1; return { key: `${y}-Q${q}`, label: `Q${q} ${y} (${MON[(q - 1) * 3]}–${MON[(q - 1) * 3 + 2]})`, sort: `${y}-${q}` }; }
  return { key: String(y), label: String(y), sort: String(y) };
}

/** Every item, dated, the household budget spread over its month's days; with the floor of each month. */
export function flatten(data, today) {
  const out = [];
  const floors = new Map();
  for (const t of data.trajectory) {
    const ym = `${t.year}-${String(t.month).padStart(2, '0')}`;
    floors.set(ym, t.floor ?? data.requiredFloor ?? 0);
    const last = ymd(new Date(Date.UTC(t.year, t.month, 0)));
    for (const it of t.items || []) {
      if (it.kind === 'personal') {
        const from = `${ym}-01` < today && today <= last ? today : `${ym}-01`;
        const days = Math.round((parse(last) - parse(from)) / 864e5) + 1;
        for (let i = 0; i < days; i++) out.push({ ...it, date: addDays(from, i), amount: it.amount / days, spread: days });
      } else if (String(it.date).slice(0, 10) < today) out.push({ ...it, date: today, overdue: String(it.date).slice(0, 10) }); // not paid yet: it goes from today's cash
      else out.push(it);
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { items: out, floorOn: (date) => floors.get(String(date).slice(0, 7)) ?? data.requiredFloor ?? 0 };
}

/** The periods: in, out, lowest cash, closing balances, floor. */
export function periodsOf(data, grain, today) {
  const { items, floorOn } = flatten(data, today);
  const map = new Map();
  let bal = data.startingBalance; let com = data.startingBalance;
  // Day by day, so a period's low is its lowest closing day.
  const byDay = new Map();
  for (const it of items) { const k = String(it.date).slice(0, 10); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(it); }
  for (const [day, list] of byDay) {
    const p = periodOf(day, grain);
    let row = map.get(p.key);
    if (!row) { row = { ...p, in: 0, out: 0, low: Infinity, lowOn: null, items: [], floor: floorOn(day), opening: bal }; map.set(p.key, row); }
    for (const it of list) {
      bal += it.amount; if (!it.estimate) com += it.amount;
      if (it.amount > 0) row.in += it.amount; else row.out += it.amount;
      row.items.push(it);
    }
    if (bal < row.low) { row.low = bal; row.lowOn = day; }
    row.floor = Math.max(row.floor, floorOn(day));
    row.balance = bal; row.committed = com;
  }
  return [...map.values()].sort((a, b) => (a.sort < b.sort ? -1 : 1));
}

/** The daily path, for the chart: each day's closing balance with estimates and committed only. */
function dailyPath(data, today) {
  const { items, floorOn } = flatten(data, today);
  const pts = []; let bal = data.startingBalance; let com = data.startingBalance;
  const end = items.length ? String(items.at(-1).date).slice(0, 10) : today;
  let i = 0;
  for (let d = today; d <= end; d = addDays(d, 1)) {
    while (i < items.length && String(items[i].date).slice(0, 10) <= d) { bal += items[i].amount; if (!items[i].estimate) com += items[i].amount; i++; }
    pts.push({ d, bal, com, floor: floorOn(d) });
  }
  return pts;
}

function PathChart({ data, today }) {
  const pts = useMemo(() => dailyPath(data, today), [data, today]);
  const [hover, setHover] = useState(null);
  if (pts.length < 2) return null;
  const W = 1000; const H = 220; const pad = { l: 64, r: 12, t: 12, b: 24 };
  const vals = pts.flatMap((p) => [p.bal, p.com, p.floor]);
  const lo = Math.min(...vals); const hi = Math.max(...vals);
  const span = hi - lo || 1; const yMin = lo - span * 0.06; const yMax = hi + span * 0.06;
  const x = (i) => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  const line = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));
  const kfmt = (v) => { const a = Math.abs(v); return `${v < 0 ? '−' : ''}$${a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : Math.round(a)}`; };
  const months = pts.map((p, i) => [p, i]).filter(([p]) => p.d.endsWith('-01'));
  const lowI = pts.reduce((m, p, i) => (p.bal < pts[m].bal ? i : m), 0);
  const h = hover != null ? pts[hover] : null;
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(pts.length - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (pts.length - 1)))));
  };
  return (
    <div className="cfp-chart">
      <div className="cfp-legend">
        <span><i style={{ background: 'var(--cft-est)' }} />With estimates</span>
        <span><i style={{ background: 'var(--cft-com)' }} />Committed only</span>
        <span><i className="cfp-dash" />Floor</span>
        <span className="cfp-read">{h ? `${parse(h.d).toUTCString().slice(0, 11)} · ${money(Math.round(h.bal))} with estimates · ${money(Math.round(h.com))} committed` : `Lowest: ${money(Math.round(pts[lowI].bal))} on ${parse(pts[lowI].d).toUTCString().slice(5, 11)}`}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cash balance day by day" onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {ticks.map((v) => <g key={v}><line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border)" /><text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="cfp-ax">{kfmt(v)}</text></g>)}
        {yMin < 0 && yMax > 0 && <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" />}
        {months.map(([p, i]) => <text key={p.d} x={x(i)} y={H - 6} textAnchor="middle" className="cfp-ax">{MON[parse(p.d).getUTCMonth()]}</text>)}
        <path d={line('floor')} fill="none" stroke="var(--text-faint)" strokeDasharray="4 4" strokeWidth="1.5" />
        <path d={line('com')} fill="none" stroke="var(--cft-com)" strokeWidth="2" />
        <path d={line('bal')} fill="none" stroke="var(--cft-est)" strokeWidth="2" />
        <circle cx={x(lowI)} cy={y(pts[lowI].bal)} r="4.5" fill="var(--cft-est)" stroke="var(--panel)" strokeWidth="2" />
        {h && <><line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--border-strong)" />
          <circle cx={x(hover)} cy={y(h.bal)} r="4" fill="var(--cft-est)" stroke="var(--panel)" strokeWidth="2" />
          <circle cx={x(hover)} cy={y(h.com)} r="4" fill="var(--cft-com)" stroke="var(--panel)" strokeWidth="2" /></>}
      </svg>
    </div>
  );
}

export default function CashFlowPeriods({ data, grain }) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Regina' }).format(new Date());
  const rows = useMemo(() => periodsOf(data, grain, today), [data, grain, today]);
  const [open, setOpen] = useState(null);
  const tight = rows.reduce((m, r, i) => (r.low - r.floor < rows[m].low - rows[m].floor ? i : m), 0);
  // By day, a day where only the spread household budget moves is left out (the tightest day always stays).
  const shown = grain === 'day' ? rows.filter((r, i) => i === tight || r.items.some((x) => !x.spread)) : rows;
  const tightest = shown.indexOf(rows[tight]);
  return (
    <>
      {(grain === 'day' || grain === 'week') && <PathChart data={data} today={today} />}
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>{grain === 'day' ? 'Day' : grain === 'week' ? 'Week (Mon–Sun)' : grain === 'quarter' ? 'Quarter' : 'Year'}</th>
              <th>Money in</th><th>Money out</th><th>Net</th>
              <th title="The least cash on any day in it, with estimates">Lowest</th>
              <th>Committed bal.</th><th>With estimates</th>
              <th title={`What must be paid in the ${data.floorDays || 60} days after the month-end it falls in`}>Floor</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const isOpen = open === r.key;
              const net = r.in + r.out;
              return (
                <Fragment key={r.key}>
                  <tr className={`cf-month-row${isOpen ? ' open' : ''}`} style={i === tightest ? { background: 'var(--panel-hover)' } : undefined}
                    onClick={() => setOpen(isOpen ? null : r.key)} tabIndex={0} aria-expanded={isOpen}
                    onKeyDown={(e) => { if (e.key === 'Enter') setOpen(isOpen ? null : r.key); }}>
                    <td className="nowrap"><span className="cf-month-chev" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>{r.label}{i === tightest && <> <span className="badge warn" title="Least cash over the floor">TIGHTEST</span></>}</td>
                    <td>{signed(r.in)}</td>
                    <td>{signed(r.out)}</td>
                    <td style={{ color: net < -0.5 ? 'var(--negative)' : net > 0.5 ? 'var(--positive)' : undefined }}>{signed(net)}</td>
                    <td className="nowrap" style={r.low < r.floor ? { color: 'var(--negative)' } : undefined}>{money(Math.round(r.low))}{grain !== 'day' && r.lowOn ? <span className="split-lines" style={{ display: 'block' }}>{MON[parse(r.lowOn).getUTCMonth()]} {parse(r.lowOn).getUTCDate()}</span> : null}</td>
                    <td style={r.committed < r.floor ? { color: 'var(--negative)' } : undefined}>{money(Math.round(r.committed))}</td>
                    <td style={r.balance < r.floor ? { color: 'var(--negative)' } : { fontWeight: 500 }}>{money(Math.round(r.balance))}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{money(Math.round(r.floor))}</td>
                  </tr>
                  {isOpen && (
                    <tr className="cf-month-detail"><td colSpan={8}><PeriodItems items={r.items} grain={grain} /></td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="split-lines" style={{ margin: '8px 2px 0' }}>{grain === 'day' ? 'Days where only the household budget moves are left out; their balances carry on into the next day shown. ' : ''}The household budget is spread over its month's days; every month still ends where the month table does.</p>
    </>
  );
}

// The items behind a period: the household budget as one line (its days summed), everything else as dated.
function PeriodItems({ items, grain }) {
  const rows = [];
  const spread = new Map();
  for (const it of items) {
    if (it.spread) { const k = it.key; const s = spread.get(k) || { ...it, amount: 0, days: 0, from: it.date }; s.amount += it.amount; s.days += 1; s.to = it.date; spread.set(k, s); }
    else rows.push(it);
  }
  const all = [...rows, ...spread.values()].sort((a, b) => (a.amount < b.amount ? -1 : 1));
  return (
    <table className="cfp-items">
      <tbody>
        {all.map((it, i) => (
          <tr key={`${it.key}-${i}`}>
            <td className="nowrap" style={{ color: 'var(--text-muted)' }}>{it.spread ? (it.days > 1 ? `${MON[parse(it.from).getUTCMonth()]} ${parse(it.from).getUTCDate()}–${parse(it.to).getUTCDate()}` : `${MON[parse(it.from).getUTCMonth()]} ${parse(it.from).getUTCDate()}`) : `${MON[parse(it.date).getUTCMonth()]} ${parse(it.date).getUTCDate()}`}</td>
            <td>{it.label}{it.overdue ? <span className="split-lines" style={{ color: 'var(--negative)' }}> overdue since {MON[parse(it.overdue).getUTCMonth()]} {parse(it.overdue).getUTCDate()}</span> : null}{it.spread && grain !== 'day' ? <span className="split-lines"> {it.days} day{it.days === 1 ? '' : 's'} of the month's budget</span> : null}</td>
            <td style={{ color: 'var(--text-muted)' }}>{KIND[it.kind] || it.kind}{it.estimate ? ' · estimate' : ''}</td>
            <td className="nowrap" style={{ textAlign: 'right', color: it.amount < 0 ? 'var(--negative)' : 'var(--positive)' }}>{signed(it.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
