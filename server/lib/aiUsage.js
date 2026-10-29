// Every Claude call this app makes, recorded with what it cost (Jake, 2026-10-29: Sentinel's AI usage window
// tracks every driver, "I want everything included"). It watches the app's own requests to the Messages API,
// reads the usage from each answer and records the model, the tokens and the list-price cost under the
// feature that made the call (told apart by the file that called it), so no call site changes. Sentinel reads
// it per day (GET /api/sentinel/actions/ai-usage).
import { pool } from '../db.js';

// US$ per million tokens: [input, output, cache read, cache write] (Anthropic list prices; Sentinel's usage.js too).
const PRICES = {
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5],
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
  'claude-sonnet-4': [3, 15, 0.3, 3.75],
  'claude-opus-4-1': [15, 75, 1.5, 18.75],
  'claude-opus-4': [5, 25, 0.5, 6.25],
};
const priceOf = (model) => PRICES[Object.keys(PRICES).find((k) => String(model || '').startsWith(k))] || PRICES['claude-sonnet-5-5'];
export function costOf(model, u = {}) {
  const [i, o, cr, cw] = priceOf(model);
  const long = String(model || '').startsWith('claude-haiku-5-5') && (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) > 100000 ? 5 : 1;
  return (((u.input_tokens || 0) * i + (u.output_tokens || 0) * o + (u.cache_read_input_tokens || 0) * cr + (u.cache_creation_input_tokens || 0) * cw) * long) / 1e6
    + (u.server_tool_use?.web_search_requests || 0) * 0.01;
}

// Which feature made the call: the first of these files on the call's stack.
const FEATURES = [
  ['/advisor/', 'advisor'], ['receipts.js', 'receipts'], ['paystubRead.js', 'paystubs'], ['groceries.js', 'groceries'],
];
export const featureOf = (stack = '') => {
  const s = String(stack).replace(/\\/g, '/');
  return (FEATURES.find(([f]) => s.includes(f)) || [null, 'other'])[1];
};

let started = false;
/** Wraps fetch once: each Messages API answer is recorded (in the background; a failure never touches the call). */
export function trackClaude({ record = recordUsage, fetchImpl = globalThis.fetch } = {}) {
  if (started) return;
  started = true;
  const real = fetchImpl.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!/\/v1\/messages(\?|$)/.test(url)) return real(input, init);
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40; // deep enough to reach the calling file through helpers
    const feature = featureOf(new Error().stack);
    Error.stackTraceLimit = limit;
    const res = await real(input, init);
    // The advisor records its own (advisor_usage), with its budget.
    if (res.ok && feature !== 'advisor') res.clone().json().then((j) => { if (j?.usage) return record({ feature, model: j.model, usage: j.usage }); }).catch(() => {});
    return res;
  };
}

export async function recordUsage({ feature, model, usage }) {
  await pool.query(
    `INSERT INTO ai_usage (feature, model, input_tokens, output_tokens, cache_read, cache_write, web_searches, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [feature, model || null, usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_read_input_tokens || 0,
      usage.cache_creation_input_tokens || 0, usage.server_tool_use?.web_search_requests || 0, costOf(model, usage)]);
}
