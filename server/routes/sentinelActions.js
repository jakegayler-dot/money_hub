// Actions for Sentinel and other agents (POST), behind the same key as the
// read API: Authorization: Bearer <SENTINEL_ACTION_KEY>. Mounted in
// index.js before the app's sign-in guard.
//
//   GET  /api/sentinel/actions            what's here and what each takes
//   POST /api/sentinel/actions/purchase   can we afford it? optionally saved
//                                         as a what-if on the Cash Flow page
//   POST /api/sentinel/actions/advisor    a turn with Jake's financial advisor
//                                         (lib/advisor): Sentinel's question, or
//                                         Jake's words in a Sentinel thread
//   GET  /api/sentinel/actions/goals      the goals, with their studies
//   POST /api/sentinel/actions/goals      add or change a goal (and save a study)
//   POST /api/sentinel/actions/goals/:id/study  the money side of a goal study
//                                         (lib/goalStudy.js); not saved
import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { requireActionKey } from './sentinelRead.js';
import { runAndJudge, purchaseFromInput, agentAnswer, PURCHASE_FIELDS } from '../lib/purchaseCheck.js';
import { advise } from '../lib/advisor/advisor.js';
import { AdvisorToolError } from '../lib/advisor/tools.js';
import { clean as cleanGoal, COLS as GOAL_COLS, shape as goalShape } from './goals.js';
import { studyGoal, flowsFromInput } from '../lib/goalStudy.js';

const router = Router();
router.use(requireActionKey);
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.get('/', (req, res) => res.json({
  app: 'money_hub',
  actions: [{
    name: 'purchase', method: 'POST', path: '/api/sentinel/actions/purchase',
    description: 'Can the farm afford a capital purchase on a loan? Runs the live cash forecast with the deposit, loan payments, GST back and the change in income tax, then judges it like a farm lender: cash floor, term debt coverage with the new payments (1.25x), money down (15%+), cash up front vs free cash, operating line. Answers viable / tight / not_viable with the reasons and the numbers. With "save": true it is also saved as a what-if the user can open on the Cash Flow page (same "name" replaces the earlier one).',
    body: {
      ...PURCHASE_FIELDS,
      save: 'true to keep it as a what-if on the Cash Flow page (default false)',
      name: 'the saved what-if\'s name (default: the label)',
      months: 'forecast length: 12 (default), 18 or 24',
      scope: '"everything" (default, farm and household), "farm" or "personal"',
    },
    example: { label: 'Used S780 combine', price: 485000, trade_in: 150000, deposit: 40000, rate: 6.9, years: 7, per_year: 1, month: '2027-03', save: true },
  }, {
    name: 'advisor', method: 'POST', path: '/api/sentinel/actions/advisor',
    description: 'One turn with Jake\'s financial advisor, the agent in Money Hub that owns everything to do with money (farm, household, debt, tax, investing). It reads all of Money Hub, runs decisions through the forecast and what-ifs, searches a Canadian tax library and cites it, remembers what Jake tells it, and can save a what-if on the Cash Flow page (its only write). Takes 20 seconds to a couple of minutes. The reply is plain text; when author is "sentinel" it is at most about 200 words, answer first.',
    body: {
      thread: '{ id, title, kind: "direct"|"group" }: the Sentinel thread this turn belongs to',
      author: '"sentinel" (Sentinel asking) or "jake" (Jake\'s words in that thread)',
      text: 'the message',
      transcript: 'optional: the thread\'s recent messages [{ author: "jake"|"sentinel"|"advisor", body }], oldest first, without this one',
      depth: '"quick" (a fast check) or "deep" (default: a decision worth thinking through)',
    },
    example: { thread: { id: '7f1c…', title: 'Money: Sentinel and the advisor', kind: 'group' }, author: 'sentinel', text: 'Jake asks whether to prepay fertilizer before Dec 31 or wait for the spring price.', depth: 'deep' },
  }, {
    name: 'goals', method: 'GET', path: '/api/sentinel/actions/goals',
    description: "Jake's goals (status exploring, active, bought, dropped) with Sentinel's latest study and the weekly re-checks (history).",
  }, {
    name: 'goal', method: 'POST', path: '/api/sentinel/actions/goals',
    description: 'Adds a goal (as "exploring" unless a status is given) or changes one (with id). details (acres, use, buy_month…) are merged; study replaces the saved study; history_add appends one weekly check.',
    body: { id: 'the goal to change (omit to add)', name: 'what it is', kind: 'land|cattle|tractor|combine|machinery|truck|building|other', price: 'price', down_pct: '%', rate: '%', years: 'term', status: 'exploring|active|bought|dropped', details: '{ acres, cultivated_acres, use, buy_month, … }', study: 'object', history_add: 'object' },
  }, {
    name: 'goal_study', method: 'POST', path: '/api/sentinel/actions/goals/:id/study',
    description: 'The money side of a goal study (nothing saved): the 24-month cash forecast with the goal bought, in the bad, normal and good years Sentinel simulated, each judged like a lender; how far sales can fall (break_even_revenue, a share of the normal year’s); the most it could cost (max_price); and the changes tried (more down, longer term, lower price, later, costs trimmed).',
    body: { farm: '{ cases: { bad, base, good }: { flows: [{ label, amount, month: "YYYY-MM", revenue, part: "farm"|"goal", kind?: "rent" }] } }', buy_month: 'YYYY-MM', scope: 'everything (default) or farm' },
  }],
}));

router.post('/advisor', ah(async (req, res) => {
  const b = req.body || {};
  const t = b.thread || {};
  if (!t.id || !/^[\w-]{1,80}$/.test(String(t.id))) return res.status(422).json({ error: 'thread.id is required (the Sentinel thread\'s id).' });
  const author = b.author === 'jake' ? 'jake' : 'sentinel';
  const text = String(b.text || '').trim();
  if (!text) return res.status(422).json({ error: 'text is required.' });
  if (text.length > 8000) return res.status(422).json({ error: 'text is too long (8,000 characters at most).' });
  try {
    const out = await advise({
      threadKey: `sentinel:${t.id}`, threadTitle: String(t.title || 'Sentinel').slice(0, 120), kind: t.kind === 'group' ? 'group' : 'direct',
      author, text, transcript: Array.isArray(b.transcript) ? b.transcript : null, depth: b.depth === 'quick' ? 'quick' : 'deep',
    });
    res.json({ reply: out.reply, model: out.model, cost_usd: out.cost_usd, tools: out.tools, saved: out.saved, remembered: out.remembered,
      cites: out.cites, sources: out.sources, budget_stopped: !!out.budget });
  } catch (err) {
    if (err instanceof AdvisorToolError) return res.status(422).json({ error: err.message });
    console.error('advisor (Sentinel):', err.message);
    res.status(502).json({ error: `The advisor couldn't answer: ${err.message}` });
  }
}));

// The advisor's spend by day and model (Oct 29: Sentinel's AI usage window tracks every driver over time).
router.get('/advisor/usage', ah(async (req, res) => {
  const days = Math.min(400, Math.max(1, Number(req.query.days) || 30));
  const { rows } = await pool.query(
    `SELECT to_char((created_at AT TIME ZONE 'America/Regina')::date, 'YYYY-MM-DD') AS day, model,
            COUNT(*)::int AS calls, ROUND(SUM(cost_usd)::numeric, 4)::float AS usd
       FROM advisor_usage WHERE created_at > now() - make_interval(days => $1)
      GROUP BY 1, 2 ORDER BY 1, 2`, [days]);
  res.json({ days, rows });
}));

// Every Claude call this app makes, by day, feature and model: the advisor (advisor_usage) and the rest (ai_usage).
router.get('/ai-usage', ah(async (req, res) => {
  const days = Math.min(400, Math.max(1, Number(req.query.days) || 30));
  const { rows } = await pool.query(
    `SELECT day, feature, model, SUM(calls)::int AS calls, ROUND(SUM(usd)::numeric, 4)::float AS usd FROM (
       SELECT to_char((created_at AT TIME ZONE 'America/Regina')::date, 'YYYY-MM-DD') AS day, 'advisor' AS feature, model, 1 AS calls, cost_usd AS usd
         FROM advisor_usage WHERE created_at > now() - make_interval(days => $1)
       UNION ALL
       SELECT to_char((created_at AT TIME ZONE 'America/Regina')::date, 'YYYY-MM-DD'), feature, model, 1, cost_usd
         FROM ai_usage WHERE created_at > now() - make_interval(days => $1)) x
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [days]);
  res.json({ app: 'money_hub', days, rows });
}));

// ---- Goals and their studies (Oct 27) ----
const goalOut = (g) => ({ ...goalShape(g), history: (g.history || []).slice(-26) });
router.get('/goals', ah(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM goals ORDER BY CASE status WHEN 'exploring' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, priority, id");
  res.json({ goals: rows.map(goalOut) });
}));

router.post('/goals', ah(async (req, res) => {
  const b = req.body || {};
  let cur = null;
  if (b.id != null) {
    ({ rows: [cur] } = await pool.query('SELECT * FROM goals WHERE id = $1', [Number(b.id)]));
    if (!cur) return res.status(404).json({ error: `No goal ${b.id}.` });
  }
  let v;
  try { v = cleanGoal({ status: 'exploring', ...b }, cur ? goalShape(cur) : {}); } catch (err) { return res.status(422).json({ error: err.message }); }
  if (!cur && !b.status) v.status = 'exploring';
  const details = b.details && typeof b.details === 'object' ? { ...(cur?.details || {}), ...b.details } : (cur?.details || {});
  const vals = GOAL_COLS.map((k) => v[k]);
  const { rows: [g] } = cur
    ? await pool.query(`UPDATE goals SET ${GOAL_COLS.map((k, i) => `${k} = $${i + 1}`).join(', ')}, details = $${GOAL_COLS.length + 1} WHERE id = $${GOAL_COLS.length + 2} RETURNING *`, [...vals, details, cur.id])
    : await pool.query(`INSERT INTO goals (${GOAL_COLS.join(', ')}, details) VALUES (${GOAL_COLS.map((_, i) => `$${i + 1}`).join(', ')}, $${GOAL_COLS.length + 1}) RETURNING *`, [...vals, details]);
  let out = g;
  if (b.study && typeof b.study === 'object') {
    ({ rows: [out] } = await pool.query('UPDATE goals SET study = $1, studied_at = now() WHERE id = $2 RETURNING *', [b.study, g.id]));
  }
  if (b.history_add && typeof b.history_add === 'object') {
    ({ rows: [out] } = await pool.query("UPDATE goals SET history = (COALESCE(history, '[]'::jsonb) || $1::jsonb) WHERE id = $2 RETURNING *", [JSON.stringify([b.history_add]), g.id]));
  }
  res.status(cur ? 200 : 201).json({ goal: goalOut(out), created: !cur });
}));

router.post('/goals/:id/study', ah(async (req, res) => {
  const { rows: [g] } = await pool.query('SELECT * FROM goals WHERE id = $1', [Number(req.params.id)]);
  if (!g) return res.status(404).json({ error: `No goal ${req.params.id}.` });
  const b = req.body || {};
  const cases = {};
  for (const k of ['bad', 'base', 'good']) {
    if (!b.farm?.cases?.[k]) continue;
    const { flows, error } = flowsFromInput(b.farm.cases[k].flows || []);
    if (error) return res.status(422).json({ error: `${k}: ${error}` });
    cases[k] = { flows };
  }
  const goal = { ...goalShape(g), buy_month: b.buy_month || g.details?.buy_month || null };
  const scope = ['everything', 'farm'].includes(b.scope) ? b.scope : 'everything';
  res.json(await studyGoal(goal, { cases }, { scope }));
}));

router.post('/purchase', ah(async (req, res) => {
  const b = req.body || {};
  const { purchase, error } = purchaseFromInput(b);
  if (error) return res.status(422).json({ error });
  const months = [12, 18, 24].includes(Number(b.months)) ? Number(b.months) : 12;
  const scope = ['everything', 'farm', 'personal', 'grain', 'livestock', 'jake', 'ashley'].includes(b.scope) ? b.scope : 'everything';
  const scenario = { purchases: [purchase] };
  const result = await runAndJudge(scenario, { months, scope, includeTax: true });
  const answer = agentAnswer(result);
  if (b.save === true || b.save === 'true') {
    const name = String(b.name || purchase.label || 'Capital purchase').trim().slice(0, 120);
    const { rows: [old] } = await pool.query('SELECT id FROM forecast_scenarios WHERE lower(name) = lower($1) ORDER BY id LIMIT 1', [name]);
    const { rows: [row] } = old
      ? await pool.query('UPDATE forecast_scenarios SET data = $1, updated_at = now() WHERE id = $2 RETURNING id, name', [scenario, old.id])
      : await pool.query('INSERT INTO forecast_scenarios (name, data) VALUES ($1, $2) RETURNING id, name', [name, scenario]);
    answer.saved = { id: row.id, name: row.name, replaced: !!old, open: `/cash-flow?whatif=${row.id}` };
  }
  res.json(answer);
}));

export default router;
