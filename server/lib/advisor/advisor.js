// Jake's financial advisor: an agent in Money Hub that works for Sentinel
// (Sentinel asks it first about anything money) and for Jake directly (the
// Advisor page here, and its threads in Sentinel). It reads everything in
// Money Hub, works the numbers out with Money Hub's own engines, searches
// the Canadian tax library, and keeps what Jake tells it to remember.
//
// One call = one turn in a thread: the new message in, the advisor's reply
// out, both saved. Claude Opus 5.5 for Jake's own questions and Sentinel's
// "deep" ones; Sonnet 5.5 for Sentinel's quick checks. Its own weekly
// budget (setting advisor_weekly_budget_usd, US$20 by default): over 80% it
// drops to Sonnet; at 100% it stops until the week rolls on.
import { pool, getSetting } from '../../db.js';
import { TOOL_DEFS, runTool, activeNotes, AdvisorToolError } from './tools.js';
import { reginaToday } from '../sentinelSnapshot.js';

export const DEEP_MODEL = process.env.ADVISOR_DEEP_MODEL || 'claude-opus-5-5';
export const QUICK_MODEL = process.env.ADVISOR_MODEL || 'claude-sonnet-5-5';
const MAX_ROUNDS = 16;
const HISTORY = 24; // messages of the thread the advisor sees
export const DEFAULT_WEEKLY_BUDGET = 20;

// US$ per million tokens: [input, output, cache read, cache write] (the same table Sentinel uses, 2026-10-08).
const PRICES = {
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5],
  'claude-opus-5-5': [4, 20, 0.2, 5],
};
const WEB_SEARCH_USD = 0.01;
export function costOf(model, u = {}) {
  const p = PRICES[Object.keys(PRICES).find((k) => String(model).startsWith(k))] || PRICES['claude-opus-5-5'];
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2]
    + (u.cache_creation_input_tokens || 0) * p[3]) / 1e6 + (u.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_USD;
}

export const SYSTEM = `You are Jake Gayler's financial advisor: a chartered accountant, CFA and farm-finance specialist in one, working inside Money Hub, his capital-allocation system. You work for Sentinel (his master system, which asks you first about anything to do with money) and for Jake directly. Everything to do with money is yours: the farm (a grain and a cattle enterprise near Star City, Saskatchewan, both wings of one sole proprietorship, GST-registered and filing quarterly, no employees on payroll), the household (Jake, his wife Ashley and their two young sons), debt, tax, investing, registered plans, insurance-type risks, succession.

YOUR JOB is to tell him the best financial decision, with the numbers behind it. Commit to a position. Jake wants evidence-based answers and is impatient with hedging: lead with the recommendation and why, then the one or two alternatives you weighed, what each costs or earns after tax, the risk, and what would change your mind.

NUMBERS COME FROM THE TOOLS, THIS TURN. Before you state any balance, amount, date, rate, count or projection about his money, look it up (read_money_hub, the statements, run_whatif). Never reuse a figure from earlier in the thread without checking it, and never invent one. For any decision with cash or tax consequences (buy, lease, borrow, prepay, defer a sale, pay down debt, contribute to an RRSP), run it through run_whatif rather than working it out in your head: it moves the money and re-works the income tax. If the data is missing, stale or looks wrong, say so plainly and say what would fix it.

TAX: search tax_library before you say anything about Canadian or Saskatchewan tax, and give the citation ("ITA s.28(1)(c)", "CRA guide T4002") with the rule. If the library doesn't cover it, or an entry is for an older year, proposed, or unverified, check with web_search on canada.ca or laws-lois.justice.gc.ca and say where the figure came from. Never give a rate, limit or threshold from memory. Where the decision is a filing position or a legal structure (incorporating, a rollover to a child, a will), give your analysis and recommendation, then say once that his accountant should sign off on it.

HOW YOU THINK:
- Liquidity first. Money Hub's cash floor at each month-end is what must be paid in the next 60 days (loans, bills, cards, fees, tax and GST, household essentials). A plan that leaves a month short of its floor needs a fix (timing, the operating line, a cash advance) before anything else. Large balances after harvest are not spendable: the forecast's long dry stretches matter more.
- Debt: lenders want term debt coverage of 1.25x or better and 15 to 25% down. Compare every use of cash on its after-tax return: paying down a 7% loan is a risk-free 7% (after the interest deduction, less for farm debt), so an investment has to beat that plus a risk premium. Interest is only deductible when the borrowed money earns income: keep personal and farm debt apart.
- Tax: on the cash method, timing is the lever (when grain is sold, when inputs are prepaid, the optional inventory adjustment), but the goal is the lowest tax over several years, not this year: level his income across brackets, use CCA and the half-year rule deliberately, watch for losing personal credits in a low year. Consider income splitting with Ashley and the children through reasonable wages, the spousal RRSP, AgriInvest, the livestock deferral when it applies, and the capital gains exemption on qualified farm property for the long game. Ashley's paystubs are in the paystubs collection (her gross, tax, CPP, EI, pension and group RRSP, and whether her withholding points to a refund or a balance owing): use them for her income, her RRSP room and any household tax question.
- Household: protect the reserve and the floor, then the highest-interest debt, then registered room (RRSP when his marginal rate now is above what it will be on withdrawal: usually his high-income years; TFSA otherwise; RESP grants for the boys before either when the 20% grant is on offer), then farm investments that beat the hurdle, then taxable investing. Say which and how much.
- Be specific to a Saskatchewan grain and cattle farm: AgriStability, AgriInvest, the Advance Payments Program, crop insurance, input financing (interest-free until a date), grain marketing against cash needs, the herd as capital and as inventory.
- What you don't know about him (RRSP and TFSA room, ages, retirement plans, the accountant's view, risk tolerance), ask, once, when it matters to the answer, and remember what he says.

MEMORY: the notes below are what Jake has told you before. Use them. When he tells you something that will matter later (a fact Money Hub doesn't hold, a goal, a preference, a decision), call remember. When one is wrong, forget it and remember the right one.

WHAT YOU CAN'T DO: move money, pay, file, or change any record. Your one write is save_whatif, a scenario he can open on the Cash Flow page: save one when you recommend something he'll want to look at, and tell him its name. If he asks you to do something else, tell him where to do it.

THE THREAD: messages from Jake are marked "Jake:", from Sentinel "Sentinel:". When Sentinel asks, it relays your answer to Jake (often aloud): answer in at most about 200 words, the answer and the key numbers first, nothing it would have to strip out. When Jake asks directly, be complete but tight. Plain text in short paragraphs; a short list only when he's comparing options; no tables, no headings, no markdown symbols. Canadian dollars. Don't add a disclaimer to every message.`;

export async function weeklySpend() {
  const { rows: [r] } = await pool.query(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM advisor_usage WHERE created_at > now() - interval '7 days'`);
  const budget = Number(await getSetting('advisor_weekly_budget_usd', DEFAULT_WEEKLY_BUDGET)) || DEFAULT_WEEKLY_BUDGET;
  const spent = Number(r.spent);
  return { spent: Math.round(spent * 100) / 100, budget, share: budget > 0 ? spent / budget : 1, state: spent >= budget ? 'stopped' : spent >= budget * 0.8 ? 'low' : 'ok' };
}

async function recordUsage(model, u = {}) {
  await pool.query(
    `INSERT INTO advisor_usage (model, input_tokens, output_tokens, cache_read, cache_write, web_searches, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0,
      u.server_tool_use?.web_search_requests || 0, costOf(model, u)],
  ).catch((e) => console.error('advisor usage:', e.message));
}

/** The thread for a key, made if new. */
export async function threadFor(key, title = 'Advisor', kind = 'direct') {
  const k = String(key || 'moneyhub:direct').slice(0, 200);
  const { rows: [t] } = await pool.query(
    `INSERT INTO advisor_threads (key, title, kind) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET title = COALESCE(NULLIF($2, ''), advisor_threads.title), updated_at = now()
     RETURNING *`, [k, String(title || 'Advisor').slice(0, 120), kind === 'group' ? 'group' : 'direct']);
  return t;
}

const LABEL = { jake: 'Jake', sentinel: 'Sentinel' };

/**
 * The conversation for the model. `transcript` (from Sentinel: its thread's
 * recent messages, every voice in it) is used when given; otherwise this
 * thread's own history. The advisor's messages are its turns; everyone
 * else's are labelled user turns. Consecutive turns of one role merge.
 */
export function toMessages(history, incoming) {
  const out = [];
  const push = (role, text) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  };
  for (const m of history) {
    if (!m?.body) continue;
    if (m.author === 'advisor') push('assistant', m.body);
    else push('user', `${LABEL[m.author] || 'Jake'}: ${m.body}`);
  }
  push('user', `${LABEL[incoming.author] || 'Jake'}: ${incoming.body}`);
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function callClaude(body, fetchImpl) {
  const res = await fetchImpl(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `Claude API ${res.status}`);
  return data;
}

function notesBlock(notes) {
  if (!notes.length) return 'NOTES: nothing remembered yet.';
  return `NOTES (what Jake has told you; id in brackets):\n${notes.map((n) => `[${n.id}] ${n.kind}: ${n.text}`).join('\n')}`;
}

/**
 * One turn. opts: { threadKey, threadTitle, kind, author ('jake'|'sentinel'),
 * text, transcript?, depth ('deep'|'quick'), fetchImpl }.
 * Returns { reply, thread, message_id, model, cost_usd, tools, saved, remembered, cites, sources }.
 */
export async function advise(opts) {
  const { threadKey, threadTitle, kind = 'direct', author = 'jake', text, transcript = null, depth = 'deep', fetchImpl = fetch } = opts;
  const body = String(text || '').trim();
  if (!body) throw new AdvisorToolError('Nothing was asked.');
  if (!process.env.ANTHROPIC_API_KEY) throw new AdvisorToolError('The advisor needs ANTHROPIC_API_KEY set in Railway.');
  const thread = await threadFor(threadKey, threadTitle, kind);
  const { rows: hist } = await pool.query(
    'SELECT author, body FROM (SELECT id, author, body FROM advisor_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT $2) x ORDER BY id', [thread.id, HISTORY]);
  const history = Array.isArray(transcript) && transcript.length
    ? transcript.slice(-HISTORY).map((m) => ({ author: ['jake', 'sentinel', 'advisor'].includes(m.author) ? m.author : 'jake', body: String(m.body || '').slice(0, 8000) }))
    : hist;
  const { rows: [inMsg] } = await pool.query(
    'INSERT INTO advisor_messages (thread_id, author, body, meta) VALUES ($1, $2, $3, $4) RETURNING id',
    [thread.id, ['jake', 'sentinel'].includes(author) ? author : 'jake', body, JSON.stringify({ depth })]);

  const spend = await weeklySpend();
  if (spend.state === 'stopped') {
    const reply = `I've used this week's advisor budget (US$${spend.spent.toFixed(2)} of US$${spend.budget.toFixed(2)}), so I'm stopped until it rolls over. The budget is the advisor_weekly_budget_usd setting in Money Hub.`;
    const { rows: [out] } = await pool.query("INSERT INTO advisor_messages (thread_id, author, body, meta) VALUES ($1, 'advisor', $2, $3) RETURNING id", [thread.id, reply, JSON.stringify({ budget_stopped: true })]);
    return { reply, thread, message_id: out.id, model: null, cost_usd: 0, tools: [], saved: [], remembered: [], cites: [], sources: [], budget: spend };
  }
  const model = depth === 'quick' || spend.state === 'low' ? QUICK_MODEL : DEEP_MODEL;
  const notes = await activeNotes();
  const system = [
    { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Today is ${reginaToday()} (Saskatchewan).\n\n${notesBlock(notes)}` },
  ];
  const tools = [...TOOL_DEFS, { type: 'web_search_20260209', name: 'web_search', max_uses: 3,
    user_location: { type: 'approximate', city: 'Star City', region: 'Saskatchewan', country: 'CA', timezone: 'America/Regina' } }];
  const messages = toMessages(history, { author, body });
  const run = { messageId: inMsg.id };
  const used = [];
  const sources = [];
  let cost = 0;
  let reply = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const data = await callClaude({
      model, max_tokens: 16000, system, tools, messages,
      output_config: { effort: depth === 'quick' ? 'medium' : 'high' },
    }, fetchImpl);
    await recordUsage(model, data.usage);
    cost += costOf(model, data.usage);
    for (const b of data.content || []) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url && !sources.some((s) => s.url === r.url)) sources.push({ title: r.title, url: r.url });
      }
      for (const c of b.citations || []) if (c.url && !sources.some((s) => s.url === c.url)) sources.push({ title: c.title, url: c.url });
    }
    if (data.stop_reason === 'refusal') { reply = "I can't help with that one."; break; }
    const uses = (data.content || []).filter((b) => b.type === 'tool_use');
    if (data.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: data.content }); continue; }
    if (data.stop_reason !== 'tool_use' || !uses.length) {
      // The answer is the text after the last tool step; text before it was working notes.
      const content = data.content || [];
      const lastTool = content.map((b) => b.type).findLastIndex((t) => t !== 'text');
      reply = content.slice(lastTool + 1).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      break;
    }
    messages.push({ role: 'assistant', content: data.content });
    const results = await Promise.all(uses.map(async (tu) => {
      used.push(tu.name);
      try {
        return { type: 'tool_result', tool_use_id: tu.id, content: await runTool(tu.name, tu.input || {}, run) };
      } catch (err) {
        if (!(err instanceof AdvisorToolError)) console.error(`advisor tool ${tu.name}:`, err.message);
        return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: err instanceof AdvisorToolError ? err.message : 'That lookup failed.' };
      }
    }));
    messages.push({ role: 'user', content: results });
  }
  if (!reply) reply = 'That took more working out than I could finish in one go. Ask me about one part of it at a time.';
  const meta = { model, cost_usd: Math.round(cost * 10000) / 10000, tools: used, saved: run.saved || [], remembered: run.remembered || [], cites: [...new Set(run.cites || [])], sources: sources.slice(0, 6) };
  const { rows: [out] } = await pool.query(
    "INSERT INTO advisor_messages (thread_id, author, body, meta) VALUES ($1, 'advisor', $2, $3) RETURNING id", [thread.id, reply, JSON.stringify(meta)]);
  await pool.query('UPDATE advisor_threads SET updated_at = now() WHERE id = $1', [thread.id]);
  return { reply, thread, message_id: out.id, ...meta };
}
