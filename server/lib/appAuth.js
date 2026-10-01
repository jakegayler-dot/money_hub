// Password protection for the whole app. One shared password, APP_PASSWORD,
// set as a Railway variable. Signing in sets a cookie that lasts 30 days on
// that device. The cookie is signed with a key derived from the password,
// so changing APP_PASSWORD signs every device out at once.
//
// Outside systems (Quarter Section, the statement agent's API calls) keep
// working with their X-Api-Key header — a valid INGEST_API_KEY passes too.
//
// Until APP_PASSWORD is set the app stays open, so deploying this never
// locks anyone out before the variable exists.
import crypto from 'node:crypto';
import { Router } from 'express';

const COOKIE = 'mh_session';
const MAX_AGE_S = 30 * 24 * 60 * 60;

const password = () => process.env.APP_PASSWORD || '';
const signingKey = () => crypto.createHash('sha256').update(`money-hub-session:${password()}`).digest();

function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function sign(expires) {
  return crypto.createHmac('sha256', signingKey()).update(String(expires)).digest('base64url');
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

function validSession(req) {
  const raw = readCookie(req);
  if (!raw) return false;
  const [expires, mac] = raw.split('.');
  if (!expires || !mac || !(Number(expires) > Date.now())) return false;
  return sameText(mac, sign(expires));
}

function validKey(req) {
  const key = process.env.INGEST_API_KEY;
  const sent = req.get('x-api-key');
  return !!key && !!sent && sameText(sent, key);
}

function setCookie(req, res, value, maxAge) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

export const authEnabled = () => !!password();

/** Guards every /api route except sign-in and the health check. */
export function requireSignIn(req, res, next) {
  if (!authEnabled() || validSession(req) || validKey(req)) return next();
  res.status(401).json({ error: 'Sign in required.', signIn: true });
}

// Failed sign-ins per address: 10 tries, then a 15-minute wait.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRIES = 10;

export const authRouter = Router();

authRouter.get('/status', (req, res) => {
  res.json({ required: authEnabled(), signedIn: !authEnabled() || validSession(req) });
});

authRouter.post('/login', (req, res) => {
  if (!authEnabled()) return res.json({ ok: true });
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const f = failures.get(ip);
  if (f && now - f.first < WINDOW_MS && f.count >= MAX_TRIES) {
    const mins = Math.ceil((WINDOW_MS - (now - f.first)) / 60000);
    return res.status(429).json({ error: `Too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
  }
  if (!sameText(req.body?.password || '', password())) {
    if (!f || now - f.first >= WINDOW_MS) failures.set(ip, { first: now, count: 1 });
    else f.count += 1;
    return res.status(401).json({ error: 'Wrong password.' });
  }
  failures.delete(ip);
  const expires = now + MAX_AGE_S * 1000;
  setCookie(req, res, `${expires}.${sign(expires)}`, MAX_AGE_S);
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});
