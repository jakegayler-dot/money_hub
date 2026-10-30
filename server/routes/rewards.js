import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { giftCards, useCard, rebates, receiveRebate, unreceiveRebate, rewardsSummary, rebateExpected } from '../lib/rewards.js';
import { toISODate } from '../lib/dates.js';

// Gift cards, card points and rebates (lib/rewards.js; points: /api/credit-cards/points).
const router = Router();
const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
const num = (v) => (v === '' || v == null ? null : Number(v));

router.get('/', ah(async (req, res) => {
  const [summary, cards, rbs] = await Promise.all([rewardsSummary(), giftCards(), rebates()]);
  res.json({ summary, gift_cards: cards, rebates: rbs });
}));

// ---- Gift cards
function cardFields(b) {
  const merchant = String(b.merchant || '').trim();
  if (!merchant) bad('Where is the card for?');
  const value = num(b.value);
  if (!(value >= 0)) bad('Its value must be a number.');
  return {
    direction: b.direction === 'given' ? 'given' : 'received', merchant: merchant.slice(0, 120), person: String(b.person || '').trim() || null,
    value, date: b.date || toISODate(new Date()), expires: b.expires || null,
    owner: ['jake', 'ashley', 'farm', 'family'].includes(b.owner) ? b.owner : 'jake',
    occasion: String(b.occasion || '').trim() || null, notes: String(b.notes || '').trim() || null,
    status: ['active', 'used', 'lost'].includes(b.status) ? b.status : 'active',
  };
}
const CARD_COLS = ['direction', 'merchant', 'person', 'value', 'date', 'expires', 'owner', 'occasion', 'notes', 'status'];

router.post('/gift-cards', ah(async (req, res) => {
  const v = cardFields(req.body || {});
  await pool.query(`INSERT INTO gift_cards (${CARD_COLS.join(', ')}) VALUES (${CARD_COLS.map((_, i) => `$${i + 1}`).join(', ')})`, CARD_COLS.map((k) => v[k]));
  res.status(201).json({ gift_cards: await giftCards() });
}));
router.patch('/gift-cards/:id', ah(async (req, res) => {
  const { rows: [cur] } = await pool.query('SELECT * FROM gift_cards WHERE id = $1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const v = cardFields({ ...cur, date: toISODate(cur.date), expires: cur.expires ? toISODate(cur.expires) : null, ...req.body });
  await pool.query(`UPDATE gift_cards SET ${CARD_COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [cur.id, ...CARD_COLS.map((k) => v[k])]);
  res.json({ gift_cards: await giftCards() });
}));
router.delete('/gift-cards/:id', ah(async (req, res) => {
  await pool.query('DELETE FROM gift_cards WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));
router.post('/gift-cards/:id/use', ah(async (req, res) => {
  const ok = await withTransaction((c) => useCard(c, Number(req.params.id), { ...req.body, amount: Number(req.body?.amount) }));
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ gift_cards: await giftCards() });
}));
router.delete('/gift-cards/uses/:id', ah(async (req, res) => {
  const { rows: [u] } = await pool.query('DELETE FROM gift_card_uses WHERE id = $1 RETURNING card_id', [req.params.id]);
  if (u) await pool.query(`UPDATE gift_cards SET status = 'active' WHERE id = $1 AND status = 'used'`, [u.card_id]);
  res.json({ gift_cards: await giftCards() });
}));

// ---- Rebates
function rebateFields(b) {
  const program = String(b.program || '').trim();
  if (!program) bad('Name the program.');
  const v = {
    program: program.slice(0, 160), sponsor: String(b.sponsor || '').trim() || null, season: num(b.season),
    qualifying_spend: num(b.qualifying_spend), rate_pct: num(b.rate_pct), amount: num(b.amount),
    status: ['earning', 'claimed', 'approved', 'lost'].includes(b.status) ? b.status : 'earning',
    claim_by: b.claim_by || null, expected_date: b.expected_date || null,
    category_id: b.category_id ? Number(b.category_id) : null,
    segment: ['grain', 'livestock', 'jake', 'ashley'].includes(b.segment) ? b.segment : 'grain', notes: String(b.notes || '').trim() || null,
  };
  for (const k of ['qualifying_spend', 'rate_pct', 'amount']) if (v[k] != null && !(v[k] >= 0)) bad(`${k.replace('_', ' ')} must be a number, zero or more.`);
  if (rebateExpected(v) == null) bad('Enter what you expect back, or the qualifying spend and % back.');
  return v;
}
const RB_COLS = ['program', 'sponsor', 'season', 'qualifying_spend', 'rate_pct', 'amount', 'status', 'claim_by', 'expected_date', 'category_id', 'segment', 'notes'];

router.post('/rebates', ah(async (req, res) => {
  const v = rebateFields(req.body || {});
  await pool.query(`INSERT INTO rebates (${RB_COLS.join(', ')}) VALUES (${RB_COLS.map((_, i) => `$${i + 1}`).join(', ')})`, RB_COLS.map((k) => v[k]));
  res.status(201).json({ rebates: await rebates() });
}));
router.patch('/rebates/:id', ah(async (req, res) => {
  const { rows: [cur] } = await pool.query('SELECT * FROM rebates WHERE id = $1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  if (cur.status === 'received') return res.status(400).json({ error: 'Undo receiving it first to change it.' });
  const dates = { claim_by: cur.claim_by ? toISODate(cur.claim_by) : null, expected_date: cur.expected_date ? toISODate(cur.expected_date) : null };
  const v = rebateFields({ ...cur, ...dates, ...req.body });
  await pool.query(`UPDATE rebates SET ${RB_COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [cur.id, ...RB_COLS.map((k) => v[k])]);
  res.json({ rebates: await rebates() });
}));
router.delete('/rebates/:id', ah(async (req, res) => {
  const { rows: [r] } = await pool.query('SELECT status FROM rebates WHERE id = $1', [req.params.id]);
  if (r?.status === 'received') return res.status(400).json({ error: 'Undo receiving it first.' });
  await pool.query('DELETE FROM rebates WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));
router.post('/rebates/:id/receive', ah(async (req, res) => {
  const ok = await withTransaction((c) => receiveRebate(c, Number(req.params.id), req.body || {}));
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ rebates: await rebates() });
}));
router.post('/rebates/:id/unreceive', ah(async (req, res) => {
  await withTransaction((c) => unreceiveRebate(c, Number(req.params.id)));
  res.json({ rebates: await rebates() });
}));
// Deposits that could be this rebate: money in near the amount, not paying anything else.
router.get('/rebates/:id/candidates', ah(async (req, res) => {
  const [r] = (await rebates()).filter((x) => x.id === Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'not found' });
  const amt = r.expected || 0;
  const { rows } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, a.name AS account FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.amount > 0 AND NOT t.is_transfer AND t.date >= CURRENT_DATE - 365
       AND ($1 = 0 OR abs(t.amount - $1) <= greatest(5, $1 * 0.15))
       AND NOT EXISTS (SELECT 1 FROM rebates x WHERE x.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM contract_payments x WHERE x.transaction_id = t.id)
     ORDER BY abs(t.amount - $1), t.date DESC LIMIT 6`, [amt]);
  res.json(rows.map((t) => ({ ...t, date: toISODate(t.date), amount: Number(t.amount) })));
}));

export default router;
