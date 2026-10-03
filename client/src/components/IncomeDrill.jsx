import { useEffect, useRef, useState } from 'react';
import { money } from '../format.js';
import { cents } from './SplitEditor.jsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Income up, spending down, one pair of bars per month, with the month's
 * net as a marker. Same encoding as the Cash Flow flow strip. Click a
 * month (or Enter on it) to list everything behind it.
 */
export function MonthlyBars({ year, owner, selected, onPick }) {
  const [data, setData] = useState(null);
  const [hover, setHover] = useState(null);
  const boxRef = useRef(null);
  const [W, setW] = useState(820);
  useEffect(() => {
    fetch(`/api/expenses/monthly?year=${year}&owner=${owner}`).then((r) => r.json()).then(setData);
  }, [year, owner]);
  useEffect(() => {
    if (!boxRef.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, []);
  if (!data) return <div className="empty-state">Loading…</div>;

  const H = 200;
  const pad = { top: 14, bottom: 24, left: W < 560 ? 44 : 62, right: 12 };
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;
  const max = Math.max(1, ...data.months.map((m) => Math.max(m.income, m.spending)));
  const y0 = pad.top + ih / 2;
  const k = (ih / 2) / max;
  const slot = iw / 12;
  const bw = Math.min(26, slot * 0.5);
  const cx = (i) => pad.left + slot * (i + 0.5);
  const kf = (v) => `$${Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`}`;
  const at = hover ?? (selected ? selected - 1 : null);
  const m = at != null ? data.months[at] : null;
  const totals = data.months.reduce((t, x) => ({ income: t.income + x.income, spending: t.spending + x.spending }), { income: 0, spending: 0 });

  return (
    <div className="mbars" ref={boxRef}>
      <div className="cft-legend" aria-hidden="true">
        <span><i className="sw mb-in" />Income</span>
        <span><i className="sw mb-out" />Spending</span>
        <span><i className="sw mb-net" />Net for the month</span>
        <span className="mbars-total">Year to date: in {money(totals.income)} · out {money(totals.spending)} · net {money(totals.income - totals.spending)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="cft-svg" role="img"
        aria-label={`Income and spending by month for ${year}. Click a month to list its entries.`}
        onPointerLeave={() => setHover(null)}>
        <line x1={pad.left} x2={pad.left + iw} y1={y0} y2={y0} className="cft-zero" />
        <text x={pad.left - 8} y={pad.top + 9} textAnchor="end" className="cft-axis">{kf(max)}</text>
        <text x={pad.left - 8} y={y0 + 4} textAnchor="end" className="cft-axis">0</text>
        <text x={pad.left - 8} y={pad.top + ih} textAnchor="end" className="cft-axis">−{kf(max)}</text>
        {data.months.map((mm, i) => {
          const sel = selected === mm.month;
          return (
            <g key={mm.month} className={`cft-bar mb${sel || hover === i ? ' sel' : ''}`} tabIndex={0} role="button"
              aria-label={`${MONTHS_FULL[i]}: income ${money(mm.income)}, spending ${money(mm.spending)}`}
              onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              onClick={() => onPick(sel ? null : mm.month)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(sel ? null : mm.month); } }}>
              <rect x={cx(i) - slot / 2} y={pad.top} width={slot} height={ih} className="hit" />
              {sel && <rect x={cx(i) - slot / 2} y={pad.top} width={slot} height={ih} className="cft-band" />}
              <rect x={cx(i) - bw / 2} y={y0 - mm.income * k} width={bw} height={Math.max(0, mm.income * k - 1)} rx="2" className="in" />
              <rect x={cx(i) - bw / 2} y={y0 + 1} width={bw} height={Math.max(0, mm.spending * k - 1)} rx="2" className="out" />
              {(mm.income || mm.spending) ? <line x1={cx(i) - bw / 2 - 3} x2={cx(i) + bw / 2 + 3} y1={y0 - mm.net * k} y2={y0 - mm.net * k} className="mb-net" /> : null}
              <text x={cx(i)} y={H - 6} textAnchor="middle" className={`cft-axis${sel || hover === i ? ' on' : ''}`}>{MONTHS[i]}</text>
            </g>
          );
        })}
      </svg>
      {m && (
        <div className="cft-readout">
          <strong>{MONTHS_FULL[at]} {year}</strong>
          <span>In <b className="pos">{money(m.income)}</b></span>
          <span>Out <b className="neg">{money(m.spending)}</b></span>
          <span>Net <b>{money(m.net)}</b></span>
          {selected !== m.month && <em>Click to list the entries</em>}
        </div>
      )}
    </div>
  );
}

/**
 * The entries behind a pick: one category (and its subcategories), the
 * uncategorized pile, or a whole month — for income, spending or both.
 * Each opens in the ledger.
 */
export function EntriesPanel({ year, owner, pick, onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    setRows(null);
    const q = (kind) => {
      const p = new URLSearchParams({ year, owner, kind });
      if (pick.category_id != null) p.set('category_id', pick.category_id);
      if (pick.exact) p.set('exact', '1');
      if (pick.month) p.set('month', pick.month);
      return fetch(`/api/expenses/lines?${p}`).then((r) => r.json()).then((d) => (d.lines || []).map((l) => ({ ...l, kind })));
    };
    const kinds = pick.kind === 'both' ? ['income', 'expense'] : [pick.kind];
    Promise.all(kinds.map(q)).then((parts) => setRows(parts.flat()));
  }, [year, owner, pick]);

  const groups = rows ? rows.reduce((g, l) => {
    const key = `${l.kind}|${l.category || 'Uncategorized'}`;
    (g[key] = g[key] || { kind: l.kind, name: l.category || 'Uncategorized', lines: [], total: 0 }).lines.push(l);
    g[key].total += l.amount;
    return g;
  }, {}) : {};
  const list = Object.values(groups).sort((a, b) => (a.kind === b.kind ? b.total - a.total : a.kind === 'income' ? -1 : 1));
  const inc = rows ? rows.filter((l) => l.kind === 'income').reduce((s, l) => s + l.amount, 0) : 0;
  const out = rows ? rows.filter((l) => l.kind === 'expense').reduce((s, l) => s + l.amount, 0) : 0;

  return (
    <section className="panel cft-ledger" aria-label={`Entries: ${pick.label}`}>
      <div className="panel-header cft-ledger-head">
        <span>{pick.label}</span>
        <button type="button" className="small secondary" onClick={onClose}>Close</button>
      </div>
      {!rows ? <div className="empty-state">Loading…</div> : rows.length === 0 ? <div className="empty-state">No entries.</div> : (
        <>
          <div className="cft-ledger-sum">
            <span>{rows.length} entr{rows.length === 1 ? 'y' : 'ies'}</span>
            {inc > 0 && <span>Income <b className="pos">{money(inc)}</b></span>}
            {out !== 0 && <span>Spending <b className="neg">{money(out)}</b></span>}
            {pick.kind === 'both' && <span>Net <b>{money(inc - out)}</b></span>}
          </div>
          <table>
            <tbody>
              {list.map((g) => (
                <GroupRows key={`${g.kind}${g.name}`} g={g} showGroup={list.length > 1} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function GroupRows({ g, showGroup }) {
  return (
    <>
      {showGroup && (
        <tr className="entries-group">
          <td colSpan={3}>{g.kind === 'income' ? 'Income' : 'Spending'} · {g.name}</td>
          <td className="num nowrap">{cents(g.total)}</td>
        </tr>
      )}
      {g.lines.map((l, i) => (
        <tr key={`${l.transaction_id}-${i}`}>
          <td className="nowrap">{l.date}</td>
          <td>
            <a href={`/ledgers?edit=${l.transaction_id}`}>{l.description || l.payee || 'Entry'}</a>
            {l.payee && l.description && <div className="split-lines">{l.payee}</div>}
          </td>
          <td className="split-lines">{l.account}</td>
          <td className={`num nowrap ${l.kind === 'income' ? 'pos' : ''}`}>{cents(l.amount)}</td>
        </tr>
      ))}
    </>
  );
}
