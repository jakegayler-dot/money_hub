// The general bridge for Sentinel (Jake, 2026-10-26: "absolute access to every single piece of information in
// my sites"): Sentinel can do anything Money Hub's own screens can, through one endpoint, as Quarter Section,
// the cattle manager and Self Hub already allow. The bridge calls Money Hub's own /api routes (a call to itself
// on 127.0.0.1, signed in with a per-process key that never leaves the server), so every handler, validation and
// push runs as if Jake had clicked. Sentinel sends every change here (anything but GET) through its approval
// queue first: money writes always need his tap.
//
//   GET  /api/sentinel/actions/routes   → { routes: [{ method, path }] } every /api route, minus the excluded
//   POST /api/sentinel/actions/api      { method, path, query?, body? } → { ok, status, body, truncated? }
//        422 not an allowed route · 504 took over 25 s · 502 the call failed
// Auth: Bearer SENTINEL_ACTION_KEY (requireActionKey).
import crypto from 'node:crypto';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_BODY = 200 * 1024;
const TIMEOUT_MS = 25000;
// The bridge itself and Sentinel's routes, sign-in, the machine ingest routes (their own keys), uploads that take
// raw files, and the Quicken import.
const EXCLUDED = [/^\/api\/sentinel/i, /^\/api\/auth(\/|$)/i, /\/(login|logout|password)(\/|$)/i, /\/ingest(\/|$)/i,
  /^\/api\/receipts\/upload$/i, /^\/api\/paystubs\/upload$/i, /^\/api\/quicken\/import$/i];
const excluded = (p) => EXCLUDED.some((re) => re.test(p));

/** The key a bridge call signs in with: random per process, only ever sent to 127.0.0.1. */
export const INTERNAL_KEY = crypto.randomBytes(32).toString('hex');
export const isInternal = (req) => {
  const sent = req.get('x-sentinel-bridge') || '';
  const a = crypto.createHash('sha256').update(sent).digest();
  const b = crypto.createHash('sha256').update(INTERNAL_KEY).digest();
  return !!sent && crypto.timingSafeEqual(a, b);
};

function mountPath(layer) {
  if (layer.path) return layer.path;
  const src = layer.regexp && layer.regexp.source;
  if (!src || layer.regexp.fast_slash) return '';
  const m = /^\^(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(src);
  return m ? m[1].replace(/\\\//g, '/').replace(/\\(.)/g, '$1') : null;
}

/** Every { method, path } the app serves under /api/, sorted. */
export function listRoutes(app) {
  const out = new Map();
  const walk = (stack, prefix) => {
    for (const layer of stack || []) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const rp of paths) {
          if (typeof rp !== 'string') continue;
          const full = (prefix + rp).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
          if (!full.startsWith('/api/') || excluded(full)) continue;
          for (const m of Object.keys(layer.route.methods)) {
            const method = m.toUpperCase();
            if (METHODS.includes(method)) out.set(`${method} ${full}`, { method, path: full });
          }
        }
      } else if (layer.handle && Array.isArray(layer.handle.stack)) {
        const mp = mountPath(layer);
        if (mp != null) walk(layer.handle.stack, prefix + mp);
      }
    }
  };
  walk(app._router && app._router.stack, '');
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function matches(pattern, path) {
  const ps = pattern.split('/');
  const xs = path.split('/');
  if (ps.length !== xs.length) return false;
  return ps.every((p, i) => (p.startsWith(':') ? xs[i] !== '' : p.toLowerCase() === xs[i].toLowerCase()));
}

export function checkRequest(routes, { method, path } = {}) {
  const m = String(method || '').toUpperCase();
  if (!METHODS.includes(m)) return { error: `method must be one of ${METHODS.join(', ')}` };
  const p = String(path || '');
  if (!p.startsWith('/api/')) return { error: 'path must start with "/api/"' };
  if (p.toLowerCase().startsWith('/api/sentinel')) return { error: "Sentinel's own routes are not available through the bridge" };
  if (p.includes('..') || /%2e|%2f|%5c/i.test(p) || p.includes('//') || !/^\/api\/[A-Za-z0-9_\-.~/:%@+,]+$/.test(p)) {
    return { error: 'path has characters that are not allowed (put the query in `query`)' };
  }
  if (excluded(p)) return { error: 'That route is not available through the bridge' };
  const route = routes.find((r) => r.method === m && matches(r.path, p));
  if (!route) return { error: `No ${m} route matches ${p}: see GET /api/sentinel/actions/routes` };
  return { method: m, path: p, route };
}

function queryString(query) {
  if (!query || typeof query !== 'object') return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    for (const x of Array.isArray(v) ? v : [v]) qs.append(k, typeof x === 'object' ? JSON.stringify(x) : String(x));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export function makeCaller(getPort, timeoutMs = TIMEOUT_MS) {
  return async (method, path, query, body) => {
    const headers = { accept: 'application/json', 'x-sentinel-bridge': INTERNAL_KEY };
    const withBody = method !== 'GET' && method !== 'DELETE' ? true : body != null && method !== 'GET';
    if (withBody) headers['content-type'] = 'application/json';
    const port = typeof getPort === 'function' ? getPort() : getPort;
    const r = await fetch(`http://127.0.0.1:${port}${path}${queryString(query)}`, {
      method, headers, body: withBody ? JSON.stringify(body ?? {}) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    if (text.length > MAX_BODY) return { status: r.status, body: text.slice(0, MAX_BODY), truncated: true };
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON: keep the text */ }
    return { status: r.status, body: parsed };
  };
}

/** Mounts the two routes; auth is Sentinel's action key. */
export function registerBridge(app, { port, auth, log = console.log, timeoutMs } = {}) {
  const call = makeCaller(port, timeoutMs);
  app.get('/api/sentinel/actions/routes', auth, (req, res) => res.json({ routes: listRoutes(app) }));
  app.post('/api/sentinel/actions/api', auth, async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const chk = checkRequest(listRoutes(app), b);
    if (chk.error) return res.status(422).json({ error: chk.error });
    try {
      const out = await call(chk.method, chk.path, b.query, b.body);
      log(`  Sentinel bridge: ${chk.method} ${chk.path} → ${out.status}`);
      res.json({ ok: out.status < 400, ...out });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      log(`  Sentinel bridge: ${chk.method} ${chk.path} → ${timedOut ? 'timeout' : 'failed'}`);
      res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'Money Hub took too long to answer' : 'The call to Money Hub failed' });
    }
  });
}
