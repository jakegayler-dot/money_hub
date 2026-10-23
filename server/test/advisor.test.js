// The financial advisor: its loop (tool calls run, the answer saved in the
// thread), its tools against a real schema (PGlite), memory, the tax
// library and the weekly budget. Claude is faked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../db.js';
import { advise, toMessages, weeklySpend, costOf } from '../lib/advisor/advisor.js';
import { runTool } from '../lib/advisor/tools.js';
import { searchLibrary, setLibraryForTests } from '../lib/advisor/library.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pgLike = { 1082: (s) => new Date(`${s}T00:00:00`), 1700: (s) => s };
let db;

before(async () => {
  db = new PGlite({ parsers: pgLike });
  await db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'));
  const query = (text, params) => (/^\s*SET TRANSACTION/i.test(text) ? { rows: [] } : db.query(text, params));
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  await db.query(`INSERT INTO accounts (name, ledger, account_type, opening_balance) VALUES ('Ops', 'business', 'operating', 80000)`);
  process.env.ANTHROPIC_API_KEY = 'test';
  setLibraryForTests([
    { id: 'rrsp-limit', title: 'RRSP contribution limit', topic: 'registered-plans', tax_year: 2026, cite: 'ITA s.146; CRA RRSP guide', text: 'The RRSP limit is 18% of earned income, net farm income counts as earned income.', sources: [{ title: 'CRA', url: 'https://www.canada.ca/x' }], verified: true, status: 'law' },
    { id: 'cash-method', title: 'Cash method for farmers', topic: 'farm-income', tax_year: 2026, cite: 'ITA s.28', text: 'Farmers may report income when received and expenses when paid.', sources: [], verified: true, status: 'law' },
  ]);
});
after(async () => { await db?.close(); });

// A fake Claude: replies from a script, records what it was sent.
function fakeClaude(script) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const next = script[sent.length - 1];
    return { ok: true, json: async () => ({ ...next, usage: { input_tokens: 1000, output_tokens: 200 } }) };
  };
  return { fetchImpl, sent };
}

test('the thread becomes alternating turns, every voice labelled', () => {
  const m = toMessages([
    { author: 'advisor', body: 'stray opener' },
    { author: 'jake', body: 'Should I buy the quarter?' },
    { author: 'sentinel', body: 'He means the Smith quarter.' },
    { author: 'advisor', body: 'Probably not this year.' },
  ], { author: 'jake', body: 'Why?' });
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user']);
  assert.match(m[0].content, /^Jake: Should I buy the quarter\?\n\nSentinel: He means/);
  assert.equal(m[2].content, 'Jake: Why?');
});

test('a turn: tools run, the answer comes back and both sides are saved', async () => {
  const { fetchImpl, sent } = fakeClaude([
    { stop_reason: 'tool_use', content: [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 't1', name: 'read_money_hub', input: { collection: 'balances' } },
      { type: 'tool_use', id: 't2', name: 'remember', input: { kind: 'goal', text: 'Wants to buy the Smith quarter by 2028' } },
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hold off: cash is $80,000 and the floor needs it.' }] },
  ]);
  const out = await advise({ threadKey: 'moneyhub:direct', threadTitle: 'You and the advisor', author: 'jake', text: 'Can I buy the Smith quarter?', fetchImpl });
  assert.equal(out.reply, 'Hold off: cash is $80,000 and the floor needs it.');
  assert.deepEqual(out.tools, ['read_money_hub', 'remember']);
  assert.equal(out.model, 'claude-opus-5-5');
  assert.equal(out.remembered[0].text, 'Wants to buy the Smith quarter by 2028');
  // The tool results went back to Claude, the balances among them.
  const results = sent[1].messages.at(-1).content;
  assert.ok(results.some((r) => r.tool_use_id === 't1' && /Ops/.test(r.content)));
  const { rows } = await db.query(`SELECT author, body FROM advisor_messages ORDER BY id`);
  assert.deepEqual(rows.map((r) => r.author), ['jake', 'advisor']);
  // Next turn: the note is in the system prompt.
  const again = fakeClaude([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Noted.' }] }]);
  await advise({ threadKey: 'moneyhub:direct', author: 'jake', text: 'Thanks', fetchImpl: again.fetchImpl });
  assert.match(again.sent[0].system[1].text, /goal: Wants to buy the Smith quarter by 2028/);
  assert.equal(again.sent[0].messages.length, 3); // history: jake, advisor, then this turn
});

test('Sentinel’s quick checks run on Sonnet', async () => {
  const { fetchImpl, sent } = fakeClaude([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fine.' }] }]);
  await advise({ threadKey: 'sentinel:abc', threadTitle: 'Money', kind: 'group', author: 'sentinel', text: 'Is the floor OK?', depth: 'quick', fetchImpl });
  assert.equal(sent[0].model, 'claude-sonnet-5-5');
  assert.match(sent[0].messages[0].content, /^Sentinel: Is the floor OK\?/);
});

test('tools: a what-if runs through the forecast and can be saved', async () => {
  const r = JSON.parse(await runTool('run_whatif', { scenario: { oneoffs: [{ label: 'Bin', amount: -30000, month: '2026-12', treatment: 'capital', cca_rate: 10 }] } }));
  assert.equal(r.change.lowest <= 0, true);
  assert.ok(Array.isArray(r.months_plan) && r.months_plan.length === 12);
  const run = {};
  const saved = JSON.parse(await runTool('save_whatif', { name: 'New bin', scenario: { oneoffs: [] } }, run));
  assert.equal(saved.name, 'New bin');
  assert.equal(run.saved.length, 1);
});

test('tax library: best match first, with its citation', () => {
  const hits = searchLibrary('how much can I put in my RRSP');
  assert.equal(hits[0].id, 'rrsp-limit');
  assert.equal(hits[0].cite, 'ITA s.146; CRA RRSP guide');
});

test('weekly budget: low drops to Sonnet, used up stops', async () => {
  await db.query(`INSERT INTO settings (key, value) VALUES ('advisor_weekly_budget_usd', '1') ON CONFLICT (key) DO UPDATE SET value = '1'`);
  await db.query(`DELETE FROM advisor_usage`);
  await db.query(`INSERT INTO advisor_usage (model, cost_usd) VALUES ('claude-opus-5-5', 0.85)`);
  const low = fakeClaude([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }]);
  await advise({ threadKey: 'moneyhub:direct', author: 'jake', text: 'hi', fetchImpl: low.fetchImpl });
  assert.equal(low.sent[0].model, 'claude-sonnet-5-5');
  await db.query(`INSERT INTO advisor_usage (model, cost_usd) VALUES ('claude-opus-5-5', 1)`);
  const s = await weeklySpend();
  assert.equal(s.state, 'stopped');
  const stopped = fakeClaude([]);
  const out = await advise({ threadKey: 'moneyhub:direct', author: 'jake', text: 'hi', fetchImpl: stopped.fetchImpl });
  assert.equal(stopped.sent.length, 0);
  assert.match(out.reply, /budget/);
  assert.ok(Math.abs(costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 }) - 24) < 1e-9);
});
