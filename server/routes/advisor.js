// The Advisor page: Jake's chat with his financial advisor, the threads it
// has had with Sentinel (read here too), what it remembers, and its spend.
//
//   GET    /api/advisor                 threads, notes, this week's spend
//   GET    /api/advisor/threads/:id     a thread's messages
//   POST   /api/advisor/ask             { text, thread_id? }  (default: the chat here)
//   DELETE /api/advisor/notes/:id       forget a note
//   PUT    /api/advisor/budget          { usd }  the weekly cap
import { Router } from 'express';
import { pool } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { advise, weeklySpend, threadFor } from '../lib/advisor/advisor.js';
import { activeNotes, AdvisorToolError } from '../lib/advisor/tools.js';

const router = Router();
export const DIRECT_KEY = 'moneyhub:direct';

router.get('/', ah(async (req, res) => {
  await threadFor(DIRECT_KEY, 'You and the advisor');
  const { rows: threads } = await pool.query(
    `SELECT t.id, t.key, t.title, t.kind, t.updated_at,
            (SELECT COUNT(*)::int FROM advisor_messages m WHERE m.thread_id = t.id) AS messages
     FROM advisor_threads t ORDER BY (t.key = $1) DESC, t.updated_at DESC`, [DIRECT_KEY]);
  res.json({
    threads: threads.map((t) => ({ ...t, where: t.key.startsWith('sentinel:') ? 'sentinel' : 'money_hub' })),
    notes: await activeNotes(),
    spend: await weeklySpend(),
  });
}));

router.get('/threads/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [t] } = await pool.query('SELECT * FROM advisor_threads WHERE id = $1', [id]);
  if (!t) return res.status(404).json({ error: 'No such thread' });
  const { rows } = await pool.query(
    'SELECT id, author, body, meta, created_at FROM advisor_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT 200', [id]);
  res.json({ thread: t, messages: rows.reverse() });
}));

router.post('/ask', ah(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(422).json({ error: 'Type a question.' });
  if (text.length > 8000) return res.status(422).json({ error: 'That message is too long (8,000 characters at most).' });
  let key = DIRECT_KEY;
  let title = 'You and the advisor';
  let kind = 'direct';
  if (req.body?.thread_id) {
    const { rows: [t] } = await pool.query('SELECT key, title, kind FROM advisor_threads WHERE id = $1', [Number(req.body.thread_id)]);
    if (!t) return res.status(404).json({ error: 'No such thread' });
    if (t.key.startsWith('sentinel:')) return res.status(422).json({ error: 'Reply to a Sentinel thread in Sentinel, so Sentinel sees it too.' });
    ({ key, title, kind } = t);
  }
  try {
    const out = await advise({ threadKey: key, threadTitle: title, kind, author: 'jake', text, depth: 'deep' });
    res.json(out);
  } catch (err) {
    if (err instanceof AdvisorToolError) return res.status(422).json({ error: err.message });
    console.error('advisor:', err.message);
    res.status(502).json({ error: `The advisor couldn't answer: ${err.message}` });
  }
}));

router.delete('/notes/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('UPDATE advisor_notes SET retired_at = now() WHERE id = $1 AND retired_at IS NULL', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'No such note' });
  res.json({ ok: true });
}));

router.put('/budget', ah(async (req, res) => {
  const usd = Number(req.body?.usd);
  if (!Number.isFinite(usd) || usd < 0 || usd > 1000) return res.status(422).json({ error: 'A weekly budget in US dollars, 0 to 1,000.' });
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('advisor_weekly_budget_usd', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [JSON.stringify(usd)]);
  res.json({ spend: await weeklySpend() });
}));

export default router;
