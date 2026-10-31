import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { calendarItems, recurringSuggestions, describeRule, setTaskDone } from '../lib/calendar.js';
import { payBill, recordLoanPayment, payCard } from '../lib/postings.js';
import { toISODate } from '../lib/dates.js';
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

// Tick a task off (tax, GST, program, year-end or statement date), or reopen it: { done: true|false }.
router.put('/tasks/:id', ah(async (req, res) => {
  await setTaskDone(String(req.params.id), req.body?.done !== false);
  res.json({ ok: true });
}));

// ---- Due this week (Jake, Oct 30) ---------------------------------------------
// Every bill, loan payment, card statement, and tax or GST payment due today through six days out (and
// anything overdue), each ready to tick off as paid: ticking it books the payment from an account now —
// in the balances and Cash Flow straight away — as unconfirmed until the bank statement the agent sends
// in shows it (statement ingest matches it then). Also what's been ticked off and is still waiting.
const PAYABLE = { bill: 'bill', loan: 'loan', card: 'card' };
const refOf = (i) => {
  const [kind, id] = String(i.id).split(':');
  return PAYABLE[kind] ? { type: kind, id: Number(id) } : null;
};

router.get('/week', ah(async (req, res) => {
  const today = todayISO();
  const end = addDays(today, 6);
  const items = (await calendarItems({ from: today, to: end, today }))
    .filter((i) => ['bill', 'loan', 'card', 'tax', 'gst'].includes(i.kind) && !i.done && i.amount != null && i.amount < 0 && (i.due || i.date) <= end)
    .map((i) => ({ ...i, pay: refOf(i) }))
    .sort((a, b) => ((a.due || a.date) < (b.due || b.date) ? -1 : (a.due || a.date) > (b.due || b.date) ? 1 : a.amount - b.amount));
  // The account each one was last paid from, to start the tick-off with.
  const lastFrom = async (sql, id) => (id ? (await pool.query(sql, [id])).rows[0]?.account_id || null : null);
  for (const i of items) {
    if (!i.pay) continue;
    if (i.pay.type === 'bill') {
      i.pay.account_id = await lastFrom(`SELECT t.account_id FROM bills b JOIN bills x ON x.status = 'paid' AND (x.id = b.id OR (x.payee_id IS NOT NULL AND x.payee_id = b.payee_id) OR x.name = b.name)
        JOIN transactions t ON t.id = x.linked_transaction_id WHERE b.id = $1 AND t.account_id IS NOT NULL ORDER BY x.paid_date DESC NULLS LAST LIMIT 1`, i.pay.id);
    } else if (i.pay.type === 'loan') {
      i.pay.account_id = await lastFrom(`SELECT t.account_id FROM loan_payments p JOIN loan_payments x ON x.loan_id = p.loan_id AND x.paid
        JOIN transactions t ON t.id = x.linked_transaction_id WHERE p.id = $1 AND t.account_id IS NOT NULL ORDER BY x.paid_date DESC NULLS LAST LIMIT 1`, i.pay.id);
    } else if (i.pay.type === 'card') {
      i.pay.account_id = await lastFrom(`SELECT t.account_id FROM credit_card_statements s JOIN transactions t ON t.credit_card_id = s.credit_card_id
        AND t.account_id IS NOT NULL WHERE s.id = $1 ORDER BY t.date DESC LIMIT 1`, i.pay.id);
    }
  }
  // Ticked off (or paid from these screens) in the last 60 days and not yet on a statement.
  const { rows: waiting } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, a.name AS account,
            (SELECT b.id FROM bills b WHERE b.linked_transaction_id = t.id LIMIT 1) AS bill_id,
            (SELECT p.id FROM loan_payments p WHERE p.linked_transaction_id = t.id LIMIT 1) AS loan_payment_id,
            CASE WHEN t.credit_card_id IS NOT NULL THEN t.credit_card_id END AS card_id
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.awaiting_statement AND t.amount < 0 AND t.date >= CURRENT_DATE - 60
       AND (EXISTS (SELECT 1 FROM bills b WHERE b.linked_transaction_id = t.id)
            OR EXISTS (SELECT 1 FROM loan_payments p WHERE p.linked_transaction_id = t.id)
            OR t.credit_card_id IS NOT NULL)
     ORDER BY t.date DESC, t.id DESC`);
  const { rows: accounts } = await pool.query(`SELECT id, name FROM accounts ORDER BY account_type = 'operating' DESC, name`);
  res.json({
    today, end, items, accounts,
    waiting: waiting.map((t) => ({ ...t, date: toISODate(t.date), amount: Number(t.amount) })),
    total: Math.round(items.reduce((a, i) => a + i.amount, 0) * 100) / 100,
  });
}));

// Tick one off: { type: bill|loan|card, id, account_id, date?, amount? } — booked from that account now,
// unconfirmed until the statement shows it.
router.post('/week/pay', ah(async (req, res) => {
  const { type, id, account_id, date = todayISO(), amount = null } = req.body || {};
  if (!account_id) return res.status(400).json({ error: 'Which account was it paid from?' });
  const amt = amount === '' || amount == null ? null : Math.abs(Number(amount));
  if (amt != null && !(amt > 0)) return res.status(400).json({ error: 'The amount must be more than zero.' });
  const out = await withTransaction(async (client) => {
    if (type === 'bill') return payBill(client, Number(id), { account_id: Number(account_id), date, amount: amt });
    if (type === 'loan') return recordLoanPayment(client, Number(id), { account_id: Number(account_id), date, amount: amt });
    if (type === 'card') {
      const { rows: [st] } = await client.query('SELECT * FROM credit_card_statements WHERE id = $1', [id]);
      if (!st) return null;
      const left = Number(st.statement_balance) - Number(st.paid_amount || 0);
      return payCard(client, st.credit_card_id, { account_id: Number(account_id), date, amount: amt ?? left, statement_id: st.id });
    }
    const e = new Error('type is bill, loan or card'); e.status = 400; throw e;
  });
  if (!out) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
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
