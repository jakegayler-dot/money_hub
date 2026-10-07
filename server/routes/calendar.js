import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { calendarItems, recurringSuggestions, describeRule } from '../lib/calendar.js';
import { todayISO, addMonths, addDays } from '../lib/dates.js';
import { SEGMENT_COLUMNS, segmentValues, validateSegment } from '../lib/segments.js';

const router = Router();

// The calendar from the start of this month for `months` months (default 12),
// plus what the ledger suggests are recurring bills, and the deadline list.
router.get('/', ah(async (req, res) => {
  const today = todayISO();
  const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 24);
  const from = req.query.from || `${today.slice(0, 7)}-01`;
  const to = addDays(addMonths(from, months), -1);
  const [items, suggestions, { rows: deadlines }] = await Promise.all([
    calendarItems({ from, to, today }),
    recurringSuggestions(today),
    pool.query('SELECT * FROM calendar_deadlines ORDER BY month, COALESCE(day, nth * 7), id'),
  ]);
  res.json({ today, from, to, items, suggestions, deadlines: deadlines.map((d) => ({ ...d, rule: describeRule(d) })) });
}));

// Confirm a suggested recurring payment: it becomes a recurring bill on that vendor.
router.post('/recurring', ah(async (req, res) => {
  const b = req.body || {};
  const payeeId = Number(b.payee_id);
  const freq = ['monthly', 'quarterly', 'annual'].includes(b.frequency) ? b.frequency : null;
  if (!payeeId || !freq || !(Number(b.amount) > 0) || !b.next_date) return res.status(400).json({ error: 'Vendor, frequency, amount and next date are needed.' });
  const bill = await withTransaction(async (client) => {
    const { rows: [p] } = await client.query('SELECT name FROM payees WHERE id = $1', [payeeId]);
    if (!p) return null;
    // The owner the vendor's recent payments were tagged with.
    const o = b.owner && !validateSegment(b.owner) ? b.owner : { segment: 'grain' };
    const { rows: [row] } = await client.query(
      `INSERT INTO bills (name, ledger, amount, frequency, due_date, payee_id, category_id, notes, ${SEGMENT_COLUMNS.join(', ')})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${SEGMENT_COLUMNS.map((_, i) => `$${9 + i}`).join(', ')}) RETURNING *`,
      [b.name || p.name, b.ledger || 'business', Number(b.amount), freq, b.next_date, payeeId, b.category_id || null,
       'Recurring — learned from the ledger.', ...segmentValues(o)]);
    return row;
  });
  if (!bill) return res.status(404).json({ error: 'Vendor not found.' });
  res.status(201).json(bill);
}));

// Not a recurring bill: don't suggest this vendor again.
router.post('/recurring/dismiss', ah(async (req, res) => {
  await pool.query('INSERT INTO recurring_dismissals (payee_id) VALUES ($1) ON CONFLICT DO NOTHING', [Number(req.body?.payee_id)]);
  res.json({ ok: true });
}));

const deadlineFields = (b) => {
  const month = Number(b.month);
  if (!(month >= 1 && month <= 12)) return { error: 'Pick a month.' };
  const byWeekday = b.nth != null && b.nth !== '' && b.weekday != null && b.weekday !== '';
  const day = byWeekday ? null : Number(b.day);
  if (!byWeekday && !(day >= 1 && day <= 31)) return { error: 'Pick a day of the month.' };
  return { month, day, nth: byWeekday ? Number(b.nth) : null, weekday: byWeekday ? Number(b.weekday) : null };
};

// Change a deadline's date, title, note, or turn it on or off.
router.put('/deadlines/:id', ah(async (req, res) => {
  const b = req.body || {};
  const { rows: [cur] } = await pool.query('SELECT * FROM calendar_deadlines WHERE id = $1', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const when = b.month !== undefined ? deadlineFields(b) : { month: cur.month, day: cur.day, nth: cur.nth, weekday: cur.weekday };
  if (when.error) return res.status(400).json({ error: when.error });
  const { rows: [row] } = await pool.query(
    `UPDATE calendar_deadlines SET month = $2, day = $3, nth = $4, weekday = $5, title = $6, notes = $7, enabled = $8 WHERE id = $1 RETURNING *`,
    [cur.id, when.month, when.day, when.nth, when.weekday, b.title?.trim() || cur.title, b.notes !== undefined ? (b.notes || null) : cur.notes,
     b.enabled !== undefined ? !!b.enabled : cur.enabled]);
  res.json({ ...row, rule: describeRule(row) });
}));

// Add a yearly deadline of your own.
router.post('/deadlines', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.title?.trim()) return res.status(400).json({ error: 'What is it?' });
  const when = deadlineFields(b);
  if (when.error) return res.status(400).json({ error: when.error });
  const { rows: [row] } = await pool.query(
    `INSERT INTO calendar_deadlines (key, kind, title, month, day, nth, weekday, notes, custom)
     VALUES ($1, 'custom', $2, $3, $4, $5, $6, $7, true) RETURNING *`,
    [`custom:${Date.now()}`, b.title.trim(), when.month, when.day, when.nth, when.weekday, b.notes || null]);
  res.status(201).json({ ...row, rule: describeRule(row) });
}));

router.delete('/deadlines/:id', ah(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM calendar_deadlines WHERE id = $1 AND custom', [req.params.id]);
  if (!rowCount) return res.status(400).json({ error: 'Only deadlines you added can be deleted — turn the others off.' });
  res.status(204).end();
}));

export default router;
