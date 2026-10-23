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
import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { requireActionKey } from './sentinelRead.js';
import { runAndJudge, purchaseFromInput, agentAnswer, PURCHASE_FIELDS } from '../lib/purchaseCheck.js';
import { advise } from '../lib/advisor/advisor.js';
import { AdvisorToolError } from '../lib/advisor/tools.js';

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

router.post('/purchase', ah(async (req, res) => {
  const b = req.body || {};
  const { purchase, error } = purchaseFromInput(b);
  if (error) return res.status(422).json({ error });
  const months = [12, 18, 24].includes(Number(b.months)) ? Number(b.months) : 12;
  const scope = ['everything', 'farm', 'personal'].includes(b.scope) ? b.scope : 'everything';
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
