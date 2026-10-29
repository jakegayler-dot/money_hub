import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featureOf, costOf, trackClaude } from '../lib/aiUsage.js';

// Every Claude call recorded with its cost (Oct 29): Sentinel's AI usage window includes this app's receipts, paystubs, groceries.
test('each Claude call is recorded under the feature that made it, at list price; other requests and the advisor are left alone', async () => {
  assert.equal(featureOf('at read (C:\\money-hub\\server\\lib\\receipts.js:183:5)'), 'receipts');
  assert.equal(featureOf('at readStub (/app/server/lib/paystubRead.js:28:9)'), 'paystubs');
  assert.equal(featureOf('at advise (/app/server/lib/advisor/advisor.js:111:3)'), 'advisor');
  assert.equal(featureOf('at x (/app/server/lib/other.js:1:1)'), 'other');
  assert.equal(costOf('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e5 }).toFixed(2), '3.00');
  assert.equal(costOf('claude-haiku-5-5', { input_tokens: 2e5 }).toFixed(2), '0.10', 'Haiku 5.5 over 100,000 tokens is 5x');
  assert.equal(costOf('claude-sonnet-4-6', { input_tokens: 1e6 }).toFixed(2), '3.00');

  const recorded = [];
  const fake = async (url) => (String(url).endsWith('/v1/messages')
    ? new Response(JSON.stringify({ model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 200 } }), { status: 200 })
    : new Response('{}', { status: 200 }));
  trackClaude({ record: (r) => recorded.push(r), fetchImpl: fake });
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' });
  assert.equal((await r.json()).model, 'claude-sonnet-5-5', 'the caller still gets the whole answer');
  await fetch('https://example.com/other');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].model, 'claude-sonnet-5-5');
  assert.equal(recorded[0].usage.output_tokens, 200);
});
