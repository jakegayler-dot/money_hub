import { useEffect, useRef, useState } from 'react';
import { money } from '../format.js';

// A 3D donut (Jake, 2026-10-24: "more modern … 3D with some animations"):
// the ring tilted back, with depth, drawn in on load, and the slice under
// the pointer (or its legend row, or picked) lifting out of the ring.
//
// Motion is run from script, not CSS, so the app's calm rules (no CSS
// motion anywhere else) stay as they are; with "reduce motion" set on the
// device it draws straight in and lifts without moving.
//
// Same props as Pie: slices [{ key, label, amount, color }], selected,
// onSelect, highlight, format, centerTitle, label. `size` is the width.

const TAU = Math.PI * 2;
const TILT = 0.52; // how far the ring leans back (1 = flat on, 0 = edge on)

const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
};
const ease = (x) => 1 - (1 - x) ** 3;
const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function Pie3D({ slices, selected, onSelect, size = 340, label, format = money, centerTitle = 'Total', highlight = null }) {
  const [hover, setHover] = useState(null);
  const [draw, setDraw] = useState(reduced() ? 1 : 0); // 0 → 1: the ring drawing itself in
  const [lift, setLift] = useState({}); // key → 0..1
  const liftRef = useRef({});
  const raf = useRef(0);

  const total = slices.reduce((a, s) => a + s.amount, 0);
  const focusKey = hover ?? highlight ?? selected;
  const focus = slices.find((s) => s.key === focusKey) || null;

  // Draw in once, on first show.
  useEffect(() => {
    if (reduced()) return undefined;
    let start = null; let id;
    const step = (t) => {
      if (start == null) start = t;
      const x = Math.min(1, (t - start) / 900);
      setDraw(ease(x));
      if (x < 1) id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, []);

  // Lift toward 1 for the focused slice, 0 for the rest.
  useEffect(() => {
    const target = Object.fromEntries(slices.map((s) => [s.key, s.key === focusKey ? 1 : 0]));
    if (reduced()) { liftRef.current = target; setLift(target); return undefined; }
    cancelAnimationFrame(raf.current);
    const tick = () => {
      let moving = false;
      const next = {};
      for (const [k, to] of Object.entries(target)) {
        const from = liftRef.current[k] ?? 0;
        const v = from + (to - from) * 0.22;
        next[k] = Math.abs(to - v) < 0.01 ? to : v;
        if (next[k] !== to) moving = true;
      }
      liftRef.current = next;
      setLift(next);
      if (moving) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [focusKey, slices]); // eslint-disable-line react-hooks/exhaustive-deps

  const pad = 10;
  const R = size / 2 - pad - 6;
  const ri = R * 0.56;
  const depth = R * 0.17;
  const rise = 12; // how far a slice lifts
  const cx = size / 2;
  const cy = pad + rise + R * TILT;
  const H = Math.ceil(cy + R * TILT + depth + pad + 8);
  const P = (r, a) => [cx + r * Math.sin(a), cy - r * TILT * Math.cos(a)];
  const arc = (r, a0, a1, sweep = 1) => {
    const [x, y] = P(r, a1);
    return `A${r},${r * TILT} 0 ${Math.abs(a1 - a0) > Math.PI ? 1 : 0} ${sweep} ${x},${y}`;
  };
  const face = (a0, a1) => {
    if (a1 - a0 >= TAU - 1e-4) return `${face(a0, a0 + Math.PI)} ${face(a0 + Math.PI, a1 - 1e-4)}`;
    const [x0, y0] = P(R, a0); const [xi, yi] = P(ri, a1);
    return `M${x0},${y0} ${arc(R, a0, a1)} L${xi},${yi} ${arc(ri, a1, a0, 0)} Z`;
  };
  // A side wall along radius r from angle s to e, dropped by depth.
  const wall = (r, s, e) => {
    const [x0, y0] = P(r, s); const [x1, y1] = P(r, e);
    return `M${x0},${y0} ${arc(r, s, e)} L${x1},${y1 + depth} A${r},${r * TILT} 0 0 0 ${x0},${y0 + depth} Z`;
  };
  const clipTo = (a0, a1, lo, hi) => [Math.max(a0, lo), Math.min(a1, hi)];
  // The cut end of a slice at angle a: shown on a lifted slice, so it reads as a solid piece.
  const cap = (a) => {
    const [xo, yo] = P(R, a); const [xi, yi] = P(ri, a);
    return `M${xo},${yo} L${xi},${yi} L${xi},${yi + depth} L${xo},${yo + depth} Z`;
  };

  let acc = 0;
  const parts = slices.map((s) => {
    const a0 = acc * TAU * draw; acc += total ? s.amount / total : 0;
    const a1 = acc * TAU * draw;
    const mid = (a0 + a1) / 2;
    const l = lift[s.key] || 0;
    const dx = Math.sin(mid) * 7 * l;
    const dy = -Math.cos(mid) * 7 * TILT * l - rise * 0.55 * l;
    return { s, a0, a1, mid, l, t: `translate(${dx.toFixed(2)},${dy.toFixed(2)})` };
  });
  const pick = (k) => onSelect?.(selected === k ? null : k);
  const pctText = (v) => { const p = total ? (v / total) * 100 : 0; return p >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`; };
  const handlers = (s) => ({
    onMouseEnter: () => setHover(s.key), onFocus: () => setHover(s.key), onBlur: () => setHover(null),
    onClick: () => pick(s.key),
  });
  const dim = (s) => (focus && focus.key !== s.key ? 0.42 : 1);
  const fs = Math.max(11, Math.round(size / 26));
  const room = ri * 1.5;
  const fit = (text, want) => Math.max(9, Math.min(want, room / (String(text).length * 0.6)));
  // Slices at rest are drawn layer by layer (far inside of the hole, near outside wall, top); a lifted
  // slice is drawn whole, afterwards, so its wall sits over its neighbours' tops.
  const resting = parts.filter((x) => x.l < 0.02);
  const lifted = parts.filter((x) => x.l >= 0.02).sort((a, b) => a.l - b.l);
  const innerOf = ({ s, a0, a1, t }) => {
    const segs = [clipTo(a0, a1, 0, Math.PI / 2), clipTo(a0, a1, Math.PI * 1.5, TAU)].filter(([x, y]) => y > x + 1e-4);
    return <g key={`in-${s.key}`} transform={t} opacity={dim(s)}>{segs.map(([x, y], i) => <path key={i} d={wall(ri, x, y)} fill={shade(s.color, 0.42)} />)}</g>;
  };
  const outerOf = ({ s, a0, a1, t }) => {
    const [x, y] = clipTo(a0, a1, Math.PI / 2, Math.PI * 1.5);
    if (y <= x + 1e-4) return null;
    return <path key={`out-${s.key}`} d={wall(R, x, y)} fill={shade(s.color, 0.62)} transform={t} opacity={dim(s)} {...handlers(s)} className="pie3d-slice" />;
  };
  const topOf = ({ s, a0, a1, t }) => (a1 - a0 > 1e-4) && (
    <g key={`top-${s.key}`} transform={t} opacity={dim(s)}>
      <path d={face(a0, a1)} fill={s.color} stroke="var(--panel)" strokeWidth="1.5" strokeLinejoin="round"
        className="pie3d-slice" tabIndex={onSelect ? 0 : -1} role={onSelect ? 'button' : 'img'}
        aria-pressed={onSelect ? selected === s.key : undefined} aria-label={`${s.label}: ${format(s.amount)}, ${pctText(s.amount)}`}
        {...handlers(s)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(s.key); } }} />
      <path d={face(a0, a1)} fill="url(#p3-gloss)" pointerEvents="none" />
    </g>
  );

  return (
    <svg className="pie3d" width={size} height={H} viewBox={`0 0 ${size} ${H}`} role="group" aria-label={label}
      onMouseLeave={() => setHover(null)}>
      <defs>
        <radialGradient id="p3-shadow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#000" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="p3-gloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="55%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Its shadow on the panel. */}
      <ellipse cx={cx} cy={cy + depth + R * TILT * 0.35} rx={R * 1.04} ry={R * TILT * 0.75} fill="url(#p3-shadow)" />
      {resting.map(innerOf)}
      {resting.map(outerOf)}
      {resting.map(topOf)}
      {lifted.map((x) => (
        <g key={`lift-${x.s.key}`}>
          {innerOf(x)}
          <g transform={x.t} opacity={dim(x.s)}>
            {[x.a0, x.a1].map((a, i) => <path key={i} d={cap(a)} fill={shade(x.s.color, 0.5)} />)}
          </g>
          {outerOf(x)}{topOf(x)}
        </g>
      ))}
      <g className="pie-center" aria-hidden="true">
        {focus ? (
          <>
            <text x={cx} y={cy - fs * 0.35} textAnchor="middle" className="pie-c-label" fontSize={fit(focus.label, fs * 0.85)}>{focus.label}</text>
            <text x={cx} y={cy + fs * 0.95} textAnchor="middle" className="pie-c-value" fontSize={fit(format(focus.amount), fs * 1.15)}>{format(focus.amount)}</text>
          </>
        ) : (
          <>
            <text x={cx} y={cy - fs * 0.35} textAnchor="middle" className="pie-c-label" fontSize={fs * 0.85}>{centerTitle}</text>
            <text x={cx} y={cy + fs * 0.95} textAnchor="middle" className="pie-c-value" fontSize={fit(format(total), fs * 1.2)}>{format(total)}</text>
          </>
        )}
      </g>
      {focus && (
        <text x={cx} y={H - 4} textAnchor="middle" className="pie-c-sub" fontSize={fs * 0.85}>{pctText(focus.amount)} of the total</text>
      )}
    </svg>
  );
}

export default Pie3D;
