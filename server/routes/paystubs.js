// Paystubs (lib/paystubs.js).
//
// For Ashley's agent — its own key, PAYSTUB_API_KEY, in the X-Api-Key
// header: it can file paystubs and read the paystub analysis, nothing else
// in Money Hub. Mounted before the app's sign-in guard.
//   GET  /api/paystubs/ingest            what to send (the fields)
//   POST /api/paystubs/ingest            { stubs: [...] } or one stub
//   GET  /api/paystubs/ingest/summary    ?owner=ashley&year=2026 — the analysis
//
// For the app (signed in):
//   GET    /api/paystubs                 ?owner=&year= — the analysis with every stub
//   GET    /api/paystubs/:id/document    the stub's PDF or photo, if one was sent
//   DELETE /api/paystubs/:id
//   POST   /api/paystubs/match           look for deposits again
//   POST   /api/paystubs/upload          ?owner= — the stub's PDF or photo as the body: read by Claude and filed
//                                         (how Ashley's agent files one: it works at a computer, like a person)
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { normalizeStub, saveStub, paystubSummary, matchAllStubs, DEDUCTION_TYPES, OWNERS } from '../lib/paystubs.js';
import { todayISO } from '../lib/dates.js';
import { fileUploadedPaystub } from '../lib/paystubRead.js';

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
function requirePaystubKey(req, res, next) {
  const key = process.env.PAYSTUB_API_KEY;
  if (!key) return res.status(503).json({ error: 'Paystub filing is not enabled: set PAYSTUB_API_KEY on the server first.' });
  const sent = req.get('x-api-key') || '';
  if (!crypto.timingSafeEqual(digest(sent), digest(key))) return res.status(401).json({ error: 'Invalid or missing X-Api-Key header.' });
  next();
}

const MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'];
function docFrom(d) {
  if (!d || typeof d !== 'object') return null;
  const mime = String(d.mime || '').toLowerCase();
  if (!MIMES.includes(mime) || typeof d.base64 !== 'string') return { error: `document needs mime (${MIMES.join(', ')}) and base64.` };
  const bytes = Buffer.from(d.base64, 'base64');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) return { error: 'document must be under 10 MB.' };
  return { bytes, mime };
}
const query = (q) => ({
  owner: OWNERS.includes(q.owner) ? q.owner : 'ashley',
  year: Number(q.year) >= 2000 && Number(q.year) <= 2100 ? Number(q.year) : Number(todayISO().slice(0, 4)),
});

export const FIELDS = {
  owner: '"ashley" (default) or "jake"',
  employer: 'who paid it (required)',
  pay_date: 'the date paid, YYYY-MM-DD (required)',
  period_start: 'pay period start, YYYY-MM-DD',
  period_end: 'pay period end, YYYY-MM-DD',
  gross: 'pay before deductions (required)',
  net: 'pay deposited (required): it is matched to the deposit of this amount',
  deductions: `[{ type, label, amount }] — type one of ${Object.keys(DEDUCTION_TYPES).join(', ')}; or send them as flat fields with those names`,
  ytd: '{ gross, net, income_tax, cpp, ei, … } — the stub\'s own year-to-date column, if it prints one',
  hours: 'hours paid', hourly_rate: 'rate per hour',
  external_id: 'your stable id for this stub (re-sending it updates it)',
  source: 'your system\'s name, kept the same (default "agent")',
  document: '{ mime: "application/pdf"|"image/jpeg"|"image/png", base64 } — the stub itself, optional',
  notes: 'anything worth keeping',
};

export const ingestRouter = Router();
ingestRouter.use(express.json({ limit: '25mb' }));
ingestRouter.use(requirePaystubKey);
ingestRouter.get('/', (req, res) => res.json({
  what: 'File paystubs into Money Hub. Each is matched to the deposit of its net pay, booked as wages for its owner, and analysed.',
  post: 'POST /api/paystubs/ingest with { stubs: [ … ] } (or one stub as the body). Never guess a figure: leave out what the stub doesn\'t show.',
  fields: FIELDS,
  example: { employer: 'Prairie Health Region', pay_date: '2026-10-16', period_start: '2026-09-27', period_end: '2026-10-10', gross: 2650,
    net: 1987.42, deductions: [{ type: 'income_tax', amount: 351.2 }, { type: 'cpp', amount: 152.85 }, { type: 'ei', amount: 43.2 }, { type: 'pension', label: 'SHEPP', amount: 115.33 }],
    ytd: { gross: 55650, income_tax: 7375.2 }, external_id: 'stub-2026-10-16' },
}));
ingestRouter.post('/', ah(async (req, res) => {
  const list = Array.isArray(req.body?.stubs) ? req.body.stubs : [req.body];
  if (!list.length || list.length > 100) return res.status(400).json({ error: 'Send 1 to 100 stubs.' });
  const results = [];
  for (const raw of list) {
    const { stub, warnings, error } = normalizeStub(raw || {});
    if (error) { results.push({ external_id: raw?.external_id ?? null, ok: false, error }); continue; }
    const doc = docFrom(raw.document);
    if (doc?.error) { results.push({ external_id: stub.external_id, ok: false, error: doc.error }); continue; }
    const r = await saveStub(stub, warnings, doc);
    results.push({ external_id: stub.external_id, ok: true, id: r.id, updated: r.updated, matched_deposit: !!r.matched_transaction_id, warnings });
  }
  res.json({ received: list.length, results });
}));
ingestRouter.get('/summary', ah(async (req, res) => {
  const s = await paystubSummary(query(req.query));
  res.json({ ...s, stubs: (s.stubs || []).map(({ doc, ...x }) => x) });
}));

const router = Router();
router.get('/', ah(async (req, res) => {
  await matchAllStubs().catch((e) => console.error('Paystub matching failed:', e.message));
  res.json(await paystubSummary(query(req.query)));
}));
router.post('/match', ah(async (req, res) => res.json({ matched: await matchAllStubs() })));
// What the bytes are (a phone's Content-Type isn't always right). Claude reads PDF, JPEG, PNG and WebP.
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf.slice(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
router.post('/upload', express.raw({ type: () => true, limit: '15mb' }), ah(async (req, res) => {
  const bytes = Buffer.isBuffer(req.body) ? req.body : null;
  const mime = bytes && sniff(bytes);
  if (!mime) return res.status(415).json({ error: 'Send the paystub as a PDF or a photo (JPEG, PNG or WebP).' });
  try {
    res.json(await fileUploadedPaystub({ bytes, mime, owner: query(req.query).owner }));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));
router.get('/:id/document', ah(async (req, res) => {
  const { rows: [r] } = await pool.query('SELECT doc, doc_mime FROM paystubs WHERE id = $1', [Number(req.params.id)]);
  if (!r?.doc) return res.status(404).json({ error: 'No document on this stub.' });
  res.set('Content-Type', r.doc_mime).set('Cache-Control', 'private, max-age=3600').send(r.doc);
}));
router.delete('/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM paystubs WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
}));
export default router;
