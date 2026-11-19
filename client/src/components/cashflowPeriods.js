// The forecast by day, week, quarter or year, for the Cash Flow chart (Jake, Nov 19: "when i said i wanted the cash flow
// forecast with a day option, i meant the existing chart"). Built from each month's dated items, which add up to its balances
// exactly, so every grain lands on the same month-ends. Each period is shaped like a month of the trajectory (open, inflow,
// outflow, balance, committedBalance, floor, items), so the chart and the month breakdown take it as they are.
//   The household budget is a monthly amount the forecast dates on the 15th; by day or week it's spread over its month's days
//   (from today in this month), since it's spent through the month. An item dated before today that isn't paid yet comes off
//   today's cash.

export const GRAINS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parse = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

function bucketOf(day, grain) {
  const d = parse(day); const y = d.getUTCFullYear(); const m = d.getUTCMonth(); const dd = d.getUTCDate();
  if (grain === 'day') return { key: day, full: `${MON[m]} ${dd}, ${y}`, short: `${MON[m]} ${dd}` };
  if (grain === 'week') {
    const mon = addDays(day, -((d.getUTCDay() + 6) % 7)); const md = parse(mon);
    const sun = parse(addDays(mon, 6));
    // "Dec 21–27 ’26", "Dec 28–Jan 3 ’27": short enough for the figures above the chart.
    const span = md.getUTCMonth() === sun.getUTCMonth() ? `${MON[md.getUTCMonth()]} ${md.getUTCDate()}–${sun.getUTCDate()}` : `${MON[md.getUTCMonth()]} ${md.getUTCDate()}–${MON[sun.getUTCMonth()]} ${sun.getUTCDate()}`;
    return { key: mon, full: `${span} ’${String(sun.getUTCFullYear()).slice(2)}`, short: `${MON[md.getUTCMonth()]} ${md.getUTCDate()}` };
  }
  if (grain === 'quarter') { const q = Math.floor(m / 3) + 1; return { key: `${y}-Q${q}`, full: `Q${q} ${y}`, short: `Q${q} ’${String(y).slice(2)}` }; }
  return { key: String(y), full: String(y), short: String(y) };
}

/** months: a trajectory's months (with items); start: the cash they start from. → periods shaped like months. */
export function periodSeries(months, start, grain, { today, requiredFloor = 0 } = {}) {
  if (!months?.length) return [];
  const floors = new Map(); const byDay = new Map();
  const put = (day, it) => { if (!byDay.has(day)) byDay.set(day, []); byDay.get(day).push(it); };
  for (const t of months) {
    const ym = `${t.year}-${String(t.month).padStart(2, '0')}`;
    floors.set(ym, t.floor ?? requiredFloor);
    const last = ymd(new Date(Date.UTC(t.year, t.month, 0)));
    for (const it of t.items || []) {
      const day = String(it.date).slice(0, 10);
      if (it.kind === 'personal' && grain !== 'quarter' && grain !== 'year') {
        const from = `${ym}-01` < today && today <= last ? today : `${ym}-01`;
        const n = Math.round((parse(last) - parse(from)) / 864e5) + 1;
        for (let i = 0; i < n; i++) put(addDays(from, i), { ...it, amount: it.amount / n, spread: n });
      } else put(day < today ? today : day, day < today ? { ...it, overdue: true } : it);
    }
  }
  const lastMonth = months[months.length - 1];
  const end = ymd(new Date(Date.UTC(lastMonth.year, lastMonth.month, 0)));
  const out = []; let cur = null; let bal = start; let com = start;
  for (let day = today; day <= end; day = addDays(day, 1)) {
    const b = bucketOf(day, grain);
    if (!cur || cur.key !== b.key) {
      cur = { ...b, open: bal, inflow: 0, outflow: 0, balance: bal, committedBalance: com, floor: 0, items: [] };
      out.push(cur);
    }
    for (const it of byDay.get(day) || []) {
      bal += it.amount; if (!it.estimate) com += it.amount;
      if (it.amount > 0) cur.inflow += it.amount; else cur.outflow += it.amount;
      cur.items.push(it);
    }
    cur.balance = bal; cur.committedBalance = com;
    cur.floor = floors.get(day.slice(0, 7)) ?? requiredFloor;
  }
  // The household budget's days in a period are one line in its breakdown.
  for (const p of out) {
    const spread = new Map(); const rest = [];
    for (const it of p.items) {
      if (!it.spread) { rest.push(it); continue; }
      const s = spread.get(it.key) || { ...it, amount: 0, days: 0 };
      s.amount += it.amount; s.days += 1; s.label = `${it.label} (${s.days} day${s.days === 1 ? '' : 's'} of the month's)`;
      spread.set(it.key, s);
    }
    p.items = [...rest, ...spread.values()];
  }
  return out;
}
