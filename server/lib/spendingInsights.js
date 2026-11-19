// Spending insights (Jake, Nov 19: "show some spending insights on wasteful purchases or savings opportunities" — read by
// Claude once a month). On the first run of a new month, the month just ended is read: every purchase in the budget
// (lib/householdBudget.js: what the cash flow forecast doesn't already plan), what each line spent against its budget, and
// the three months before by line and by payee, so a habit or a creeping cost shows. Claude names up to six findings —
// wasteful purchases or savings — each with the purchases behind it and what it would save a month. Kept per month
// (spending_insights); never re-read unless Jake asks for it again.
import { pool } from '../db.js';
import { todayISO } from './dates.js';
import { budgetView, lineEntries, LINES } from './householdBudget.js';

const MODEL = process.env.INSIGHTS_MODEL || process.env.RECEIPT_MODEL || 'claude-sonnet-5-5';
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
export const prevMonth = (ym, n = 1) => { const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 - n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const nameOf = (e) => String(e.payee || e.description || '').trim().slice(0, 60) || '(no name)';

/** What Claude is given for a month (each purchase, line totals, the three months before). */
export async function monthFacts(month, today = todayISO()) {
  const view = await budgetView({ month, today });
  const purchases = [];
  for (const l of view.lines.filter((x) => x.spent > 0.005)) {
    const rows = await lineEntries({ month, line: l.key, today }).catch(() => []);
    for (const e of rows) purchases.push({ id: e.id, date: e.date, name: nameOf(e), category: e.category, line: l.label, amount: r2(e.amount), whose: e.whose });
  }
  const before = [];
  for (let i = 1; i <= 3; i++) {
    const m = prevMonth(month, i);
    const v = await budgetView({ month: m, today }).catch(() => null);
    if (v) before.push({ month: m, lines: v.lines.filter((x) => x.spent > 0.005).map((x) => ({ line: x.label, spent: r2(x.spent) })) });
    const ps = [];
    for (const l of (v?.lines || []).filter((x) => x.spent > 0.005)) {
      for (const e of await lineEntries({ month: m, line: l.key, today }).catch(() => [])) ps.push(e);
    }
    const byName = new Map();
    for (const e of ps) { const k = nameOf(e); const x = byName.get(k) || { name: k, count: 0, total: 0 }; x.count += 1; x.total = r2(x.total + e.amount); byName.set(k, x); }
    if (before.at(-1)?.month === m) before.at(-1).payees = [...byName.values()].sort((a, b) => b.total - a.total).slice(0, 25);
  }
  return {
    month, label: view.label,
    lines: view.lines.filter((x) => x.spent > 0.005 || x.budget > 0).map((x) => ({ line: x.label, budget: x.budget, spent: r2(x.spent) })),
    total: view.total, purchases: purchases.sort((a, b) => b.amount - a.amount).slice(0, 250), before,
  };
}

const PROMPT = `You are a frank household and small-farm financial advisor in Saskatchewan reading one month of a family's spending (Canadian dollars). The purchases are only what isn't already a planned bill, loan payment or forecast cost; some are the farm's share.
Find what a good advisor would raise: wasteful purchases (frequent small habits like fast food, coffee, convenience stores; impulse or duplicate buys; fees, interest and penalties; overlapping subscriptions; paying retail for things bought often) and savings opportunities (a cheaper store or bulk buying for repeat items, a category running well above its budget or its usual, a cost creeping up month over month).
Rules: up to 6 findings, most money first. Each must rest on the purchases given — name the payees and the counts or amounts. Estimate a realistic saving a month (not the whole spend). No generic advice, no lecturing, nothing about bills or loans. If the month is reasonable, say less, not more.`;

async function claude(body) {
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(out?.error?.message || `Claude API ${res.status}`);
  return out;
}

/** Cleans what Claude returned (pure): the findings, each tied to purchases that exist. */
export function cleanFindings(raw, facts) {
  const byId = new Map(facts.purchases.map((p) => [p.id, p]));
  const kinds = new Set(['waste', 'saving']);
  return (Array.isArray(raw) ? raw : []).slice(0, 6).map((f) => ({
    kind: kinds.has(f?.kind) ? f.kind : 'saving',
    title: String(f?.title || '').trim().slice(0, 120),
    detail: String(f?.detail || '').trim().slice(0, 600),
    line: LINES.some((l) => l.label === f?.line) ? f.line : null,
    save_per_month: Number(f?.save_per_month) > 0 ? Math.round(Number(f.save_per_month)) : null,
    spent: Number(f?.spent) > 0 ? r2(Number(f.spent)) : null,
    purchases: [...new Set((Array.isArray(f?.purchase_ids) ? f.purchase_ids : []).map(Number))].filter((id) => byId.has(id)).slice(0, 40)
      .map((id) => { const p = byId.get(id); return { id, date: p.date, name: p.name, category: p.category, amount: p.amount }; }),
  })).filter((f) => f.title && f.detail);
}

/** Reads a month (the one just ended by default) and keeps what was found. */
export async function readMonth(month, { today = todayISO() } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('No Claude key is set for Money Hub.'), { status: 503 });
  const facts = await monthFacts(month, today);
  if (!facts.purchases.length) {
    await save(month, { findings: [], summary: 'Nothing in the budget was spent this month.', spent: 0 }, null);
    return get(month);
  }
  const tools = [{
    name: 'record_findings', description: 'Record the month\'s findings.',
    input_schema: {
      type: 'object', required: ['summary', 'findings'],
      properties: {
        summary: { type: 'string', description: 'One or two plain sentences on the month.' },
        findings: { type: 'array', items: { type: 'object', required: ['kind', 'title', 'detail', 'purchase_ids'], properties: {
          kind: { type: 'string', enum: ['waste', 'saving'] }, title: { type: 'string' }, detail: { type: 'string' },
          line: { type: 'string', enum: LINES.map((l) => l.label) }, spent: { type: 'number', description: 'what these purchases cost this month' },
          save_per_month: { type: 'number' }, purchase_ids: { type: 'array', items: { type: 'integer' } },
        } } },
      },
    },
  }];
  const out = await claude({
    model: MODEL, max_tokens: 4000, system: PROMPT, tools, tool_choice: { type: 'tool', name: 'record_findings' },
    messages: [{ role: 'user', content: `The month: ${facts.label}.\n${JSON.stringify(facts)}` }],
  });
  const input = out.content?.find((c) => c.type === 'tool_use')?.input || {};
  await save(month, { summary: String(input.summary || '').slice(0, 600), findings: cleanFindings(input.findings, facts), spent: facts.total.spent }, out.model || MODEL);
  return get(month);
}

async function save(month, body, model) {
  await pool.query(
    `INSERT INTO spending_insights (month, body, model, created_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (month) DO UPDATE SET body = EXCLUDED.body, model = EXCLUDED.model, created_at = now()`,
    [month, JSON.stringify(body), model]);
}

/** A month's findings (null if it hasn't been read). */
export async function get(month) {
  const { rows } = await pool.query('SELECT month, body, model, created_at FROM spending_insights WHERE month = $1', [month]);
  if (!rows[0]) return null;
  const b = typeof rows[0].body === 'string' ? JSON.parse(rows[0].body) : rows[0].body;
  return { month: rows[0].month, ...b, model: rows[0].model, read_at: rows[0].created_at };
}
/** The newest month read, at or before `month`. */
export async function latest(month) {
  const { rows } = await pool.query('SELECT month FROM spending_insights WHERE month <= $1 ORDER BY month DESC LIMIT 1', [month]);
  return rows[0] ? get(rows[0].month) : null;
}

/** Once a month: the month just ended, if it hasn't been read. */
export async function monthlyRead(today = todayISO()) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const month = prevMonth(today.slice(0, 7));
  if (await get(month)) return null;
  return readMonth(month, { today });
}
