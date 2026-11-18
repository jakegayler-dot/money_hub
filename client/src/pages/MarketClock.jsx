// The US market's hours on the covered-call page (Jake, Nov 18: "add trading hours to the moneyhub covered call page with live
// time, and time till open time till close etc."). The calendar (regular session, pre-market, after hours, the NYSE's holidays
// and early closes) comes from the server (GET /api/options/hours, lib/options/strategy.js marketCalendar); the clock and the
// countdowns tick here every second. Options trade only in the regular session.
import { useEffect, useMemo, useState } from 'react';

const NY = 'America/New_York';
const nyParts = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) + Number(p.second) / 60 };
};
const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
/** The instant a New York wall-clock time on a date happens. */
export function nyInstant(date, time) {
  const [y, mo, d] = date.split('-').map(Number);
  const want = Date.UTC(y, mo - 1, d) + hm(time) * 60e3;
  let t = want + 5 * 3600e3; // New York is 4 or 5 hours behind UTC
  for (let i = 0; i < 2; i++) {
    const p = nyParts(new Date(t));
    const got = Date.UTC(...p.date.split('-').map((v, k) => (k === 1 ? Number(v) - 1 : Number(v)))) + p.minutes * 60e3;
    t += want - got;
  }
  return new Date(Math.round(t / 1000) * 1000);
}
const nextDate = (iso) => new Date(Date.parse(`${iso}T12:00:00Z`) + 86400e3).toISOString().slice(0, 10);
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

/** Where the market stands at `now` (pure): status, the next change and the sessions around it. */
export function marketState(now, cal) {
  const holidays = new Map((cal?.holidays || []).map((h) => [h.date, h.name]));
  const early = new Map((cal?.early_closes || []).map((e) => [e.date, e.close]));
  const reg = cal?.regular || { open: '09:30', close: '16:00' };
  const session = (date) => (weekday(date) === 0 || weekday(date) === 6 || holidays.has(date) ? null
    : { date, open: nyInstant(date, reg.open), close: nyInstant(date, early.get(date) || reg.close), early: early.has(date),
      pre: nyInstant(date, cal?.pre?.open || '04:00'), after: nyInstant(date, early.has(date) ? '17:00' : cal?.after?.close || '20:00') });
  const today = nyParts(now).date;
  const s = session(today);
  let next = null;
  for (let d = s && now < s.open ? today : nextDate(today), i = 0; i < 15 && !next; d = nextDate(d), i++) next = session(d);
  let status = 'closed'; let until = next?.open || null; let label = 'Opens in';
  if (s && now >= s.open && now < s.close) { status = 'open'; until = s.close; label = 'Closes in'; }
  else if (s && now >= s.pre && now < s.open) { status = 'pre'; until = s.open; }
  else if (s && now >= s.close && now < s.after) status = 'after';
  const ahead = []; // closures and early closes in the next three weeks
  for (let d = today, i = 0; i < 21; d = nextDate(d), i++) {
    if (holidays.has(d)) ahead.push({ date: d, what: `closed${holidays.get(d) ? ` (${holidays.get(d)})` : ''}` });
    else if (early.has(d)) ahead.push({ date: d, what: `closes early, at ${early.get(d).replace(/^13:00$/, '1 p.m.')} New York` });
  }
  return { status, until, label, today: s, next, holiday: holidays.get(today) || null, ahead,
    progress: status === 'open' ? (now - s.open) / (s.close - s.open) : null };
}

const span = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(t / 86400); const h = Math.floor((t % 86400) / 3600); const m = Math.floor((t % 3600) / 60); const sec = t % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return d ? `${d}d ${h}h ${pad(m)}m` : `${h}:${pad(m)}:${pad(sec)}`;
};
const clock = (d, zone, sec = true) => d.toLocaleTimeString('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) });
const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const WORDS = { open: 'Market open', pre: 'Pre-market', after: 'After hours', closed: 'Market closed' };

export default function MarketClock() {
  const [cal, setCal] = useState(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { fetch('/api/options/hours').then((r) => (r.ok ? r.json() : null)).then(setCal).catch(() => {}); }, []);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const here = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const m = marketState(now, cal);
  const regOpen = m.today && now < m.today.close ? m.today : m.next;
  const local = (d) => clock(d, here, false);
  const sameZone = regOpen && local(regOpen.open) === clock(regOpen.open, NY, false);
  return (
    <section className="panel cc-clock" aria-label="US market hours">
      <div className="cc-clock-main">
        <span className={`cc-clock-status ${m.status}`}><i />{WORDS[m.status]}{m.holiday ? ` · ${m.holiday}` : ''}</span>
        {m.until && <div className="cc-clock-count"><span className="cc-k">{m.label}</span><b>{span(m.until - now)}</b></div>}
      </div>
      <div className="cc-clock-times">
        <div><span className="cc-k">New York</span><b>{clock(now, NY)}</b></div>
        {here !== NY && <div><span className="cc-k">Your time</span><b>{clock(now, here)}</b></div>}
      </div>
      {m.progress != null && <div className="cc-clock-bar" title={`${Math.round(m.progress * 100)}% of the session gone`}><span style={{ width: `${(m.progress * 100).toFixed(2)}%` }} /></div>}
      <div className="cc-clock-hours">
        {regOpen && <span>{regOpen.date === m.today?.date ? 'Today' : dayName(regOpen.date)}: options and shares {clock(regOpen.open, NY, false)} to {clock(regOpen.close, NY, false)} New York{sameZone ? '' : ` (${local(regOpen.open)} to ${local(regOpen.close)} your time)`}{regOpen.early ? ', an early close' : ''}.</span>}
        <span className="cc-faint"> Pre-market from 4 a.m., after hours to 8 p.m. New York (shares only; options trade only in the session).</span>
        {m.status !== 'open' && m.next && m.next.date !== regOpen?.date && <span> Next session {dayName(m.next.date)}.</span>}
      </div>
      {m.ahead.length > 0 && <div className="cc-clock-ahead">{m.ahead.map((a) => <span key={a.date}><b>{dayName(a.date)}</b> {a.what}</span>)}</div>}
      {!cal && <div className="cc-faint">Holiday calendar not loaded: weekdays shown as sessions.</div>}
    </section>
  );
}
