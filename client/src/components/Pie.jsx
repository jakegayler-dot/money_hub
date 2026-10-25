import { useState } from 'react';
import { money } from '../format.js';

// The app's part-to-whole chart: a donut, so the total and whichever slice
// you point at or pick read in the middle instead of in a tooltip. Slices
// sit on a 2px panel-coloured gap; the one under the pointer (or picked)
// stands a few pixels proud of the ring, the rest dim — nothing moves out
// of place. Click or Enter picks a slice; again un-picks it.
//
// slices: [{ key, label, amount (positive), color }]

const TAU = Math.PI * 2;
const pt = (c, r, a) => [c + r * Math.sin(a), c - r * Math.cos(a)];

/** An annular sector from angle a0 to a1 (clockwise from 12 o'clock). */
function ring(c, r0, r1, a0, a1) {
  if (a1 - a0 >= TAU - 1e-6) {
    // A whole ring: two halves, so the path closes.
    return `${ring(c, r0, r1, 0, Math.PI)} ${ring(c, r0, r1, Math.PI, TAU - 1e-6)}`;
  }
  const big = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(c, r1, a0); const [x1, y1] = pt(c, r1, a1);
  const [x2, y2] = pt(c, r0, a1); const [x3, y3] = pt(c, r0, a0);
  return `M${x0},${y0} A${r1},${r1} 0 ${big} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${big} 0 ${x3},${y3} Z`;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function Pie({ slices, selected, onSelect, size = 200, label, format = money, centerTitle = 'Total', highlight = null }) {
  const [hover, setHover] = useState(null);
  const total = slices.reduce((a, s) => a + s.amount, 0);
  const c = size / 2;
  const grow = 4;
  const outer = c - grow - 1;
  const inner = outer * 0.6;
  // `highlight`: a slice pointed at outside the chart (its legend row).
  const focus = slices.find((s) => s.key === (hover ?? highlight ?? selected)) || null;
  let a = 0;
  const arcs = slices.map((s) => {
    const a0 = a; a += total ? (s.amount / total) * TAU : 0;
    return { s, a0, a1: a };
  });
  const pick = (k) => onSelect?.(selected === k ? null : k);
  const pctOf = (v) => (total ? (v / total) * 100 : 0);
  const pctText = (v) => { const p = pctOf(v); return p >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`; };
  const fs = Math.max(11, Math.round(size / 15));
  // Centre text sized to fit the hole: a monospace digit is about 0.6em wide, a sans letter about 0.55em.
  const room = inner * 1.5;
  const fit = (text, want, em = 0.6) => Math.max(9, Math.min(want, room / (String(text).length * em)));

  return (
    <svg className="pie" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="group" aria-label={label}
      onMouseLeave={() => setHover(null)}>
      {arcs.map(({ s, a0, a1 }) => {
        const on = focus?.key === s.key;
        const dim = focus && !on;
        return (
          <path key={s.key} d={ring(c, inner, on ? outer + grow : outer, a0, a1)} fill={s.color}
            className={`pie-slice${dim ? ' dim' : ''}${selected === s.key ? ' picked' : ''}`}
            stroke="var(--panel)" strokeWidth="2" strokeLinejoin="round"
            tabIndex={onSelect ? 0 : -1} role={onSelect ? 'button' : 'img'} aria-pressed={onSelect ? selected === s.key : undefined}
            aria-label={`${s.label}: ${format(s.amount)}, ${pctText(s.amount)}`}
            onMouseEnter={() => setHover(s.key)} onFocus={() => setHover(s.key)} onBlur={() => setHover(null)}
            onClick={() => pick(s.key)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(s.key); } }} />
        );
      })}
      <g className="pie-center" aria-hidden="true">
        {focus ? (
          <>
            <text x={c} y={c - fs * 1.15} textAnchor="middle" className="pie-c-label" fontSize={fs * 0.85}>{clip(focus.label, Math.max(10, Math.round(room / (fs * 0.85 * 0.55))))}</text>
            <text x={c} y={c + fs * 0.35} textAnchor="middle" className="pie-c-value" fontSize={fit(format(focus.amount), fs * 1.25)}>{format(focus.amount)}</text>
            <text x={c} y={c + fs * 1.55} textAnchor="middle" className="pie-c-sub" fontSize={fit(`${pctText(focus.amount)} of total`, fs * 0.8, 0.62)}>{pctText(focus.amount)} of total</text>
          </>
        ) : (
          <>
            <text x={c} y={c - fs * 0.6} textAnchor="middle" className="pie-c-label" fontSize={fs * 0.85}>{centerTitle}</text>
            <text x={c} y={c + fs * 0.75} textAnchor="middle" className="pie-c-value" fontSize={fit(format(total), fs * 1.3)}>{format(total)}</text>
          </>
        )}
      </g>
    </svg>
  );
}

export default Pie;
