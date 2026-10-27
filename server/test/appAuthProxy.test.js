import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireSignIn, authRouter } from '../lib/appAuth.js';

// Money Hub inside Sentinel (Oct 27): Sentinel's proxy is signed in only with both its action key and the proxy header.
const req = (headers = {}) => ({ headers, get: (k) => headers[k.toLowerCase()], ip: '1.2.3.4', secure: true });
const run = (r) => { let passed = false; let status = 200; const res = { status(s) { status = s; return this; }, json() { return this; } }; requireSignIn(r, res, () => { passed = true; }); return { passed, status }; };

test('Sentinel\'s proxy is signed in with its key and header; nothing else gets through (Oct 27)', () => {
  const saved = { p: process.env.APP_PASSWORD, k: process.env.SENTINEL_ACTION_KEY };
  process.env.APP_PASSWORD = 'pw'; process.env.SENTINEL_ACTION_KEY = 'sentinel-key';
  try {
    assert.equal(run(req({ authorization: 'Bearer sentinel-key', 'x-sentinel-proxy': '1' })).passed, true);
    assert.equal(run(req({ authorization: 'Bearer sentinel-key' })).status, 401, 'the key alone is the action API, not a sign-in');
    assert.equal(run(req({ authorization: 'Bearer wrong', 'x-sentinel-proxy': '1' })).status, 401);
    assert.equal(run(req({ 'x-sentinel-proxy': '1' })).status, 401);
    // The status route says signed in for the proxy, so the screens don't show the password page.
    const layer = authRouter.stack.find((l) => l.route?.path === '/status');
    let body; layer.route.stack[0].handle(req({ authorization: 'Bearer sentinel-key', 'x-sentinel-proxy': '1' }), { json: (b) => { body = b; } });
    assert.deepEqual(body, { required: true, signedIn: true });
  } finally {
    process.env.APP_PASSWORD = saved.p ?? ''; process.env.SENTINEL_ACTION_KEY = saved.k ?? '';
    if (saved.p === undefined) delete process.env.APP_PASSWORD;
    if (saved.k === undefined) delete process.env.SENTINEL_ACTION_KEY;
  }
});
