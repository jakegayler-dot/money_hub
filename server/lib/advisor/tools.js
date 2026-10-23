// What the advisor can do: read everything in Money Hub (the same
// collections Sentinel reads), work numbers out with Money Hub's own engines
// (the forecast and what-ifs, the purchase verdict, the financial
// statements, the tax projection), search the tax library, and remember what
// Jake tells it. Its one write is saving a what-if he can open on the Cash
// Flow page. It never moves money, files anything or changes a record.
import { pool } from '../../db.js';
import { catalog, readCollection, ReadError } from '../sentinelRead.js';
import { loadForecast } from '../forecast.js';
import { runAndJudge } from '../purchaseCheck.js';
import { scenarioContext } from '../scenario.js';
import { incomeStatement, cashFlowStatement } from '../financials.js';
import { searchLibrary, libraryTopics } from './library.js';
import { todayISO } from '../dates.js';

export class AdvisorToolError extends Error {}

const SCOPES = ['everything', 'farm', 'personal'];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const TOOL_DEFS = [
  {
    name: 'money_hub_catalog',
    description: 'Every collection in Money Hub you can read with read_money_hub: its name, what it holds, its filters and fields. Call once per conversation before reading.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_money_hub',
    description: 'Read one Money Hub collection (from money_hub_catalog), with filters. SUMMARY collections first: overview, balances, liquidity, cash_flow_forecast, net_worth, balance_sheet, debt_coverage, income_tax_estimate, gst, monthly_income_spending, spending_by_category, budget_vs_actual, upcoming, loans, assets, inventory, contracts. Then the detail (transactions, bills, loan_payments…) where it matters. Use filters and limit rather than pulling everything.',
    input_schema: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        filters: { type: 'object', description: 'Filter name → value as text, e.g. {"year": "2026", "owner": "grain", "limit": "20"}', additionalProperties: { type: 'string' } },
      },
      required: ['collection'],
    },
  },
  {
    name: 'income_statement',
    description: 'The accrual-adjusted income statement by enterprise (Grain, Cattle, Shared and the farm total): revenue and expense lines, the inventory, receivable, payable, interest and depreciation adjustments, net income and the cash-basis figure. A calendar year (with last year beside it) or a date range.',
    input_schema: { type: 'object', properties: { year: { type: 'integer' }, from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' } } },
  },
  {
    name: 'cash_flow_statement',
    description: 'The statement of cash flows (direct method, every bank account): operating, investing and financing activities, cash at the start and end. A calendar year or a date range.',
    input_schema: { type: 'object', properties: { year: { type: 'integer' }, from: { type: 'string' }, to: { type: 'string' } } },
  },
  {
    name: 'whatif_options',
    description: 'What the what-if engine can act on right now: commodities on hand and their prices, open contracts, unpaid bills (financed ones with their free-until dates), estimates, loans, the forecast window and this year\'s tax projection. Use before run_whatif to get ids and keys.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_whatif',
    description: `Run a decision through the live forecast: the money moves AND the income tax re-worked, against the plan. Use it for every decision with cash or tax consequences instead of working it out in your head. Scenario levers (all optional):
  purchases: [{ label, price, trade_in, deposit, fees, gst_pct (5), pst_pct (0 farm machinery; 6 trucks/vehicles), taxes: "financed"|"cash", rate, years, per_year (1,2,4,12), month "YYYY-MM", first_month, owner "farm"|"personal", cca_rate }]
  loans_new: [{ label, amount, rate, years, per_year, start_month, first_month, owner, buy_cost, cca_rate }]
  oneoffs: [{ label, amount (negative = money out), month, treatment: "farm"|"capital"|"personal", cca_rate }]
  prepay: [{ label, amount, month, instead_month }]  (prepaying inputs: deductible in the month paid)
  commodities: { [key from whatif_options]: { price, pct, qty, sell_month } }  (sell later or sooner, at another price)
  contracts_new: [{ commodity, crop: "bins"|"next", group, quantity, unit, price, pay_month }]
  contract_moves: { [contract_id]: "YYYY-MM" },  bill_moves: { [bill_id]: "YYYY-MM-DD" }
  costs_pct (e.g. 10 for input costs up 10%), rate_pts (interest rates up by points), rate_scope "variable"|"all", gst_delay
  tax: { instalment: "plan"|"skip", oia (optional inventory adjustment $), next_year_net }
  op_line: { on: true, limit, rate, keep }
Returns the plan and the scenario side by side (lowest month, tightest month against its cash floor, end balance, income tax this year and next, interest), the effect of each lever, and for a purchase or new loan the lender-style verdict (cash floor, debt coverage 1.25x, money down, cash up front, operating line).`,
    input_schema: {
      type: 'object',
      properties: {
        scenario: { type: 'object' },
        months: { type: 'integer', description: '12 (default), 18 or 24' },
        scope: { type: 'string', enum: SCOPES, description: 'everything (default: farm and household, one pot), farm or personal' },
        include_tax: { type: 'boolean', description: 'default true' },
      },
      required: ['scenario'],
    },
  },
  {
    name: 'save_whatif',
    description: 'Save a scenario as a what-if Jake can open on the Cash Flow page (the same name replaces the earlier one). Your only write. Do it when you recommend something he\'ll want to look at, and tell him its name.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, scenario: { type: 'object' } }, required: ['name', 'scenario'] },
  },
  {
    name: 'tax_library',
    description: 'Search the Canadian tax library (federal and Saskatchewan; the Income Tax Act, CRA guides and folios, AgriInvest, AgriStability, the APP, registered plans, CCA, capital gains, rollovers, GST, payroll). Each entry gives the rule, the figures for the tax year it was checked, its citation and its sources. Search it before you say anything about tax and quote the citation. If an entry is marked unverified, proposed, or for an older year, say so or confirm it with web_search on canada.ca or laws-lois.justice.gc.ca.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        topic: { type: 'string', description: 'Optional: farm-income, inventory, capital-cost, capital-gains, rollovers, registered-plans, personal-tax, payroll-family, gst, programs, loss-rules, instalments-deadlines, deferrals, incorporation, estate-succession' },
      },
      required: ['query'],
    },
  },
  {
    name: 'remember',
    description: 'Keep something Jake told you that will matter later: a fact Money Hub doesn\'t hold (RRSP or TFSA room from his notice of assessment, ages, an accountant\'s advice, an offer on land), a goal (retire at 55, buy the neighbour\'s quarter, the boys\' education), a preference (no new debt over 7 years, wants to stay a sole proprietor) or a decision he made. One short sentence in his terms. Not passing figures that Money Hub already has.',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['fact', 'goal', 'preference', 'decision'] }, text: { type: 'string' } },
      required: ['kind', 'text'],
    },
  },
  {
    name: 'forget',
    description: 'Retire a remembered note (by its id) that is wrong or no longer true. Use when Jake corrects one, then remember the right version.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
];

const MAX_RESULT = 20000;
function clip(obj) {
  let s = JSON.stringify(obj);
  if (s.length <= MAX_RESULT) return s;
  if (Array.isArray(obj?.rows)) {
    let rows = obj.rows;
    while (rows.length > 1 && s.length > MAX_RESULT) {
      rows = rows.slice(0, Math.floor(rows.length * 0.7));
      s = JSON.stringify({ ...obj, rows, truncated: true, note: 'Cut to fit: filter or lower the limit for the rest.' });
    }
    if (s.length <= MAX_RESULT) return s;
  }
  return `${s.slice(0, MAX_RESULT)}… (cut to fit: ask for less)`;
}

function periodOf(input = {}) {
  if (input.from || input.to) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(String(input.from || '')) || !re.test(String(input.to || ''))) throw new AdvisorToolError('Give both from and to as YYYY-MM-DD, or a year.');
    if (input.from > input.to) throw new AdvisorToolError('"from" is after "to".');
    return { from: input.from, to: input.to };
  }
  const year = Number(input.year) || Number(todayISO().slice(0, 4));
  return { from: `${year}-01-01`, to: `${year}-12-31`, year };
}

const trimTraj = (t) => (t?.months || []).map((m) => ({ month: `${m.year}-${String(m.month).padStart(2, '0')}`, balance: Math.round(m.balance), floor: Math.round(m.floor ?? 0) }));
const side = (s) => s && ({
  lowest: r2(s.low), lowest_month: s.low_month, tightest_month: s.tight_month, tightest_balance: r2(s.tight), floor_then: r2(s.tight_floor),
  headroom: r2(s.tight_headroom), months_below_floor: s.months_below_floor, end: r2(s.end), end_month: s.end_month,
  tax_this_year: s.tax_y0, tax_next_year: s.tax_y1, net_income_this_year: s.net_y0, net_income_next_year: s.net_y1, interest: s.interest,
  operating_line_peak: s.op_peak || undefined,
});

export async function saveWhatIf(name, scenario) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw new AdvisorToolError('Give the what-if a name.');
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) throw new AdvisorToolError('The scenario must be an object of levers.');
  const { rows: [old] } = await pool.query('SELECT id FROM forecast_scenarios WHERE lower(name) = lower($1) ORDER BY id LIMIT 1', [clean]);
  const { rows: [row] } = old
    ? await pool.query('UPDATE forecast_scenarios SET data = $1, updated_at = now() WHERE id = $2 RETURNING id, name', [scenario, old.id])
    : await pool.query('INSERT INTO forecast_scenarios (name, data) VALUES ($1, $2) RETURNING id, name', [clean, scenario]);
  return { id: row.id, name: row.name, replaced: !!old, open: `/cash-flow?whatif=${row.id}` };
}

/**
 * Runs one tool. `run` collects side effects for the reply: saved what-ifs
 * and notes kept. Returns the text the model sees.
 */
export async function runTool(name, input = {}, run = {}) {
  switch (name) {
    case 'money_hub_catalog':
      return clip(catalog().collections.map((c) => ({ name: c.name, description: c.description, filters: c.filters })));
    case 'read_money_hub': {
      const filters = {};
      for (const [k, v] of Object.entries(input.filters || {})) if (v != null && v !== '') filters[k] = String(v);
      try {
        return clip(await readCollection(String(input.collection || ''), filters));
      } catch (err) {
        if (err instanceof ReadError) throw new AdvisorToolError(err.message);
        throw err;
      }
    }
    case 'income_statement': {
      const p = periodOf(input);
      const s = await incomeStatement(p);
      const prior = p.year ? await incomeStatement({ from: `${p.year - 1}-01-01`, to: `${p.year - 1}-12-31` }).catch(() => null) : null;
      return clip({ ...s, prior_year: prior ? { net_income: prior.net_income, cash_net_income: prior.cash_net_income, revenue: prior.revenue.total, expenses: prior.expenses.total } : undefined });
    }
    case 'cash_flow_statement':
      return clip(await cashFlowStatement(periodOf(input)));
    case 'whatif_options':
      return clip(scenarioContext(await loadForecast({ months: 12 })));
    case 'run_whatif': {
      const sc = input.scenario;
      if (!sc || typeof sc !== 'object' || Array.isArray(sc)) throw new AdvisorToolError('The scenario must be an object of levers.');
      const months = [12, 18, 24].includes(Number(input.months)) ? Number(input.months) : 12;
      const scope = SCOPES.includes(input.scope) ? input.scope : 'everything';
      const r = await runAndJudge(sc, { months, scope, includeTax: input.include_tax !== false });
      return clip({
        window: r.window, scope: r.scope, floor_today: r.floor, tax_worked_out: r.tax_available && r.include_tax,
        plan: side(r.plan), scenario: side(r.scenario),
        change: { end: r2(r.scenario.end - r.plan.end), lowest: r2(r.scenario.low - r.plan.low),
          tax_this_year: r.scenario.tax_y0 != null && r.plan.tax_y0 != null ? r2(r.scenario.tax_y0 - r.plan.tax_y0) : null,
          tax_next_year: r.scenario.tax_y1 != null && r.plan.tax_y1 != null ? r2(r.scenario.tax_y1 - r.plan.tax_y1) : null },
        by_lever: r.steps, purchases: r.purchases, new_debt_annual: r.new_debt_annual, warnings: r.warnings,
        verdict: r.verdict ? { verdict: r.verdict.verdict, headline: r.verdict.headline, tests: r.verdict.tests.map((t) => ({ test: t.label, status: t.status, detail: t.detail })) } : undefined,
        months_plan: trimTraj(r.plan.trajectory), months_scenario: trimTraj(r.scenario.trajectory),
      });
    }
    case 'save_whatif': {
      const saved = await saveWhatIf(input.name, input.scenario);
      (run.saved ||= []).push(saved);
      return JSON.stringify(saved);
    }
    case 'tax_library': {
      const hits = searchLibrary(String(input.query || ''), { topic: input.topic || null });
      if (!hits.length) return JSON.stringify({ hits: [], topics: libraryTopics(), note: 'Nothing in the library on that. Use web_search on canada.ca or laws-lois.justice.gc.ca, and say where the figure came from.' });
      (run.cites ||= []).push(...hits.map((h) => h.id));
      return clip({ hits });
    }
    case 'remember': {
      const kind = ['fact', 'goal', 'preference', 'decision'].includes(input.kind) ? input.kind : 'fact';
      const text = String(input.text || '').trim().slice(0, 400);
      if (!text) throw new AdvisorToolError('Nothing to remember.');
      const { rows: [dup] } = await pool.query('SELECT id FROM advisor_notes WHERE retired_at IS NULL AND lower(text) = lower($1)', [text]);
      if (dup) return JSON.stringify({ kept: dup.id, already: true });
      const { rows: [row] } = await pool.query('INSERT INTO advisor_notes (kind, text, message_id) VALUES ($1, $2, $3) RETURNING id', [kind, text, run.messageId || null]);
      (run.remembered ||= []).push({ id: row.id, kind, text });
      return JSON.stringify({ kept: row.id });
    }
    case 'forget': {
      const { rowCount } = await pool.query('UPDATE advisor_notes SET retired_at = now() WHERE id = $1 AND retired_at IS NULL', [Number(input.id)]);
      if (!rowCount) throw new AdvisorToolError('No such note.');
      return JSON.stringify({ retired: Number(input.id) });
    }
    default:
      throw new AdvisorToolError(`No tool called ${name}.`);
  }
}

/** What the advisor has been told to remember, for its system prompt. */
export async function activeNotes() {
  const { rows } = await pool.query(
    `SELECT id, kind, text, created_at FROM advisor_notes WHERE retired_at IS NULL ORDER BY kind, id`);
  return rows;
}
