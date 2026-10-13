// Actions for Sentinel and other agents (POST), behind the same key as the
// read API: Authorization: Bearer <SENTINEL_ACTION_KEY>. Mounted in
// index.js before the app's sign-in guard.
//
//   GET  /api/sentinel/actions            what's here and what each takes
//   POST /api/sentinel/actions/purchase   can we afford it? optionally saved
//                                         as a what-if on the Cash Flow page
import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { requireActionKey } from './sentinelRead.js';
import { runAndJudge, purchaseFromInput, agentAnswer, PURCHASE_FIELDS } from '../lib/purchaseCheck.js';

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
  }],
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
