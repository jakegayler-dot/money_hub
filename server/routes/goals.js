import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { loadBase, planGoals, explain, monthLabel, KIND_DEFAULTS } from '../lib/goals.js';
import { toISODate } from '../lib/dates.js';

// Long-term goals and when each can be bought (lib/goals.js).
const router = Router();
const NUM = ['price', 'trade_in', 'fees', 'down_pct', 'rate', 'years', 'per_year', 'gst_pct', 'pst_pct', 'cca_rate', 'priority'];
const shape = (g) => ({
  ...g, want_by: g.want_by ? toISODate(g.want_by) : null,
  ...Object.fromEntries(NUM.map((k) => [k, g[k] == null ? null : Number(g[k])])),
});

function clean(b, cur = {}) {
  const v = { ...cur, ...b };
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (!String(v.name || '').trim()) bad('Give the goal a name.');
  if (!(Number(v.price) > 0)) bad('The price must be more than zero.');
  if (!KIND_DEFAULTS[v.kind || 'other']) bad('Unknown kind.');
  if (!['cash', 'financed'].includes(v.funding || 'financed')) bad('Funding is cash or financed.');
  if (v.funding !== 'cash') {
    if (!(Number(v.down_pct) >= 0 && Number(v.down_pct) <= 100)) bad('The down payment is a percent, 0–100.');
    if (!(Number(v.years) >= 0.5 && Number(v.years) <= 40)) bad('The term is 0.5 to 40 years.');
    if (![1, 2, 4, 12].includes(Number(v.per_year))) bad('Payments a year: 1, 2, 4 or 12.');
  }
  const n = (k) => (v[k] === '' || v[k] == null ? null : Number(v[k]));
  return {
    name: String(v.name).trim().slice(0, 120), kind: v.kind || 'other', price: Number(v.price), trade_in: n('trade_in') || 0, fees: n('fees') || 0,
    funding: v.funding || 'financed', down_pct: n('down_pct') ?? 25, rate: n('rate') ?? 7, years: n('years') ?? 7, per_year: n('per_year') ?? 1,
    gst_pct: n('gst_pct'), pst_pct: n('pst_pct'), cca_rate: n('cca_rate'), owner: v.owner === 'personal' ? 'personal' : 'farm',
    want_by: v.want_by || null, notes: String(v.notes || '').trim() || null, status: ['active', 'bought', 'dropped'].includes(v.status) ? v.status : 'active',
    priority: n('priority') ?? 0,
  };
}
const COLS = ['name', 'kind', 'price', 'trade_in', 'fees', 'funding', 'down_pct', 'rate', 'years', 'per_year', 'gst_pct', 'pst_pct', 'cca_rate', 'owner', 'want_by', 'notes', 'status', 'priority'];

router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM goals ORDER BY status, priority, id');
  res.json({ goals: rows.map(shape), kinds: KIND_DEFAULTS });
}));

router.post('/', ah(async (req, res) => {
  const v = clean(req.body || {});
  const { rows: [top] } = await pool.query('SELECT COALESCE(MAX(priority), 0) + 1 AS p FROM goals');
  v.priority = top.p;
  const { rows: [g] } = await pool.query(
    `INSERT INTO goals (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, COLS.map((k) => v[k]));
  res.status(201).json(shape(g));
}));

router.patch('/:id', ah(async (req, res) => {
  const { rows: [cur] } = await pool.query('SELECT * FROM goals WHERE id = $1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const v = clean(req.body || {}, shape(cur));
  const { rows: [g] } = await pool.query(
    `UPDATE goals SET ${COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [cur.id, ...COLS.map((k) => v[k])]);
  res.json(shape(g));
}));

// The order goals are planned in: { ids: [...] }.
router.put('/order', ah(async (req, res) => {
  const ids = (req.body?.ids || []).map(Number).filter(Boolean);
  for (const [i, id] of ids.entries()) await pool.query('UPDATE goals SET priority = $2 WHERE id = $1', [id, i + 1]);
  res.json({ ok: true });
}));

router.delete('/:id', ah(async (req, res) => {
  await pool.query('DELETE FROM goals WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

/**
 * The plan: ?ids=1,3 (in that order; default every active goal by priority).
 * Each goal's month, the conditions, what's holding it; the cash path with
 * them bought; and the same plan with the household budget smaller.
 */
router.get('/plan', ah(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM goals WHERE status = 'active' ORDER BY priority, id`);
  const all = rows.map(shape);
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  const goals = ids.length ? ids.map((id) => all.find((g) => g.id === id)).filter(Boolean) : all;
  if (!goals.length) return res.json({ goals: [], months: [], budget: null });
  const base = await loadBase();
  const plan = planGoals(base, goals);
  // Cash above the floor each month-end with the goals bought where planned.
  const H = base.meta.length;
  const net = [...base.net]; const floor = [...base.floor];
  const { goalEffect } = await import('../lib/goals.js');
  for (const r of plan) {
    if (r.month_index == null) continue;
    const eff = goalEffect(r.goal, r.month_index, base.meta, base.floorDays);
    for (let i = 0; i < H; i++) { net[i] += eff.net[i]; floor[i] += eff.due[i]; }
  }
  // Months short of the floor even with no goal bought (the plan itself).
  let b0 = base.opening; let short = null;
  base.meta.forEach((m, i) => { b0 += base.net[i]; const h = b0 - base.floor[i]; if (h < 0 && (!short || h < short.amount)) short = { month: monthLabel(m), amount: Math.round(h) }; });
  let bal = base.opening;
  const months = base.meta.map((m, i) => { bal += net[i]; return { month: monthLabel(m), balance: Math.round(bal), floor: Math.round(floor[i]), headroom: Math.round(bal - floor[i]) }; });
  // Spending less at home: the same goals with the household budget at smaller shares of the room.
  const shares = [0.75, 0.5, 0.25].filter((s) => s < base.budget.share - 0.01);
  const alt = [];
  for (const s of shares) {
    const b2 = await loadBase({ budgetShare: s });
    alt.push({ share: s, per_month: b2.budget.per_month, goals: planGoals(b2, goals).map((r) => ({ id: r.goal.id, when: r.month_index == null ? null : monthLabel(b2.meta[r.month_index]), months: r.month_index })) });
  }
  res.json({
    today: base.today, reserve: base.reserve, dscr: { now: base.dscr.now, threshold: base.dscr.threshold },
    budget: base.budget, short_without_goals: short,
    goals: plan.map((r) => {
      const m = r.month_index == null ? null : base.meta[r.month_index];
      const key = m ? `${m.year}-${String(m.month).padStart(2, '0')}` : null;
      return { id: r.goal.id, name: r.goal.name, want_by: r.goal.want_by, late: !!r.goal.want_by && (key == null || key > r.goal.want_by.slice(0, 7)), ...explain(base, r) };
    }),
    months, alternatives: alt,
  });
}));

export default router;
