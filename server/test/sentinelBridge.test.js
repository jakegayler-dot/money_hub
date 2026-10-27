// Sentinel's general bridge into Money Hub (Oct 26: "absolute access to every single piece of information in
// my sites"): it lists the app's routes, takes Sentinel's key, and calls the app's own routes signed in from
// inside the server, even with a password on the app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerBridge, checkRequest, listRoutes } from '../lib/sentinelBridge.js';
import { requireSignIn } from '../lib/appAuth.js';
import { requireActionKey } from '../routes/sentinelRead.js';

let server;
let base;
const KEY = 'bridge-test-key-0123456789';
const saved = {};

before(async () => {
  for (const k of ['SENTINEL_ACTION_KEY', 'APP_PASSWORD']) saved[k] = process.env[k];
  process.env.SENTINEL_ACTION_KEY = KEY;
  process.env.APP_PASSWORD = 'a-password-on-the-app';
  const app = express();
  app.use(express.json());
  registerBridge(app, { port: () => server.address().port, auth: requireActionKey, log: () => {} });
  app.post('/api/auth/login', (req, res) => res.json({ ok: true }));
  app.use('/api', requireSignIn);
  const r = express.Router();
  r.get('/', (req, res) => res.json([{ id: 7, name: 'Visa' }]));
  r.get('/:id', (req, res) => res.json({ id: Number(req.params.id), name: 'Visa', balance: 1234.5 }));
  r.post('/:id/payments', (req, res) => res.status(201).json({ paid: req.body.amount }));
  app.use('/api/credit-cards', r);
  app.post('/api/receipts/upload', (req, res) => res.json({ ok: true }));
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const call = (method, path, body, key = KEY) => fetch(`${base}${path}`, {
  method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test("the bridge lists Money Hub's routes and calls them signed in, password or not", async () => {
  const routes = await call('GET', '/api/sentinel/actions/routes');
  assert.equal(routes.status, 200);
  assert.deepEqual(routes.body.routes.map((r) => `${r.method} ${r.path}`),
    ['GET /api/credit-cards', 'GET /api/credit-cards/:id', 'POST /api/credit-cards/:id/payments']); // no sign-in, uploads or the bridge itself

  // Outside, the app is locked; through the bridge, Sentinel reads it.
  assert.equal((await fetch(`${base}/api/credit-cards/7`)).status, 401);
  const read = await call('POST', '/api/sentinel/actions/api', { method: 'GET', path: '/api/credit-cards/7' });
  assert.deepEqual(read.body, { ok: true, status: 200, body: { id: 7, name: 'Visa', balance: 1234.5 } });
  const write = await call('POST', '/api/sentinel/actions/api', { method: 'POST', path: '/api/credit-cards/7/payments', body: { amount: 50 } });
  assert.deepEqual(write.body.body, { paid: 50 });

  // Not a route, an excluded one, or a bad key: refused.
  assert.equal((await call('POST', '/api/sentinel/actions/api', { method: 'GET', path: '/api/nothing' })).status, 422);
  assert.equal((await call('POST', '/api/sentinel/actions/api', { method: 'POST', path: '/api/receipts/upload' })).status, 422);
  assert.equal((await call('POST', '/api/sentinel/actions/api', { method: 'GET', path: '/api/credit-cards/../auth' })).status, 422);
  assert.equal((await call('GET', '/api/sentinel/actions/routes', null, 'wrong')).status, 401);
  // A forged bridge header from outside doesn't sign anyone in.
  assert.equal((await fetch(`${base}/api/credit-cards/7`, { headers: { 'x-sentinel-bridge': 'guess' } })).status, 401);
  assert.ok(checkRequest(listRoutes({ _router: { stack: [] } }), { method: 'GET', path: '/api/x' }).error);
});
