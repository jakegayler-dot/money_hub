import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { validateSegment, segmentValues, SEGMENT_COLUMNS } from '../lib/segments.js';
import {
  payBill, removeTransaction, linkBillToTransaction, expenseCategoryFor, linkBillsToTransaction, payBills,
  applyVendorOwnerToBill, recordVendorDeposit, applyVendorCredit, unapplyVendorCredit, refundVendorCredit, keepVendorCredit, removeVendorCredit, payeeId,
  settleVendorAccount,
} from '../lib/postings.js';

/** After a vendor's bills or credits change: settle its account oldest first. */
const settle = (payeeId) => (payeeId ? withTransaction((client) => settleVendorAccount(client, Number(payeeId))).catch((e) => console.error('Vendor settle failed', payeeId, e.message)) : null);

// "JS & CL Gayler — Inv. 0588652" → "JS & CL Gayler" (same rule as the schema backfill).
const vendorFromName = (name) => String(name || '').replace(/\s+(—|–|-|#|inv\.?\s|invoice\s).*$/i, '').trim() || String(name || '').trim();
import { autoLinkBills, autoLinkBillsSoon, billCandidates } from '../lib/billMatch.js';
import { todayISO, toISODate, addMonths } from '../lib/dates.js';
import { matchPending } from '../lib/receipts.js';
import { vendorStatement, billSummary, reconState } from '../lib/vendorAccount.js';

// "$13,$14,..." placeholder run for the segment columns, starting at n.
const segPlaceholders = (n) => SEGMENT_COLUMNS.map((_, i) => `$${n + i}`).join(',');
const SEG_COLS = SEGMENT_COLUMNS.join(', ');

const router = Router();

// Finance terms off a request: interest-free date, annual rate, and the
// latest statement balance (if one has been entered). Empty → null.
const FIN_FIELDS = ['is_financed', 'finance_rate_pct', 'interest_free_until', 'balance_amount', 'balance_as_of'];
function financeFrom(body, current = {}) {
  const pick = (k) => (body[k] !== undefined ? body[k] : current[k]);
  const financed = !!pick('is_financed');
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const day = (v) => (v === '' || v == null ? null : v);
  return {
    is_financed: financed,
    finance_rate_pct: financed ? num(pick('finance_rate_pct')) : null,
    interest_free_until: financed ? day(pick('interest_free_until')) : null,
    balance_amount: financed ? num(pick('balance_amount')) : null,
    balance_as_of: financed ? day(pick('balance_as_of')) : null,
  };
}
// Comparable form of one finance field (dates as YYYY-MM-DD, numbers as numbers, blanks as '').
function finKey(k, v) {
  if (v === '' || v == null) return k === 'is_financed' ? 'false' : '';
  if (k === 'is_financed') return String(!!v);
  if (k === 'interest_free_until' || k === 'balance_as_of') return toISODate(v);
  return String(Number(v));
}
function financeError(f) {
  if (!f.is_financed) return null;
  if (f.finance_rate_pct == null || !(f.finance_rate_pct >= 0 && f.finance_rate_pct < 100)) return 'Enter the interest rate (% per year) for a bill on finance terms.';
  if ((f.balance_amount == null) !== (f.balance_as_of == null)) return 'A statement balance needs both the amount and its date.';
  return null;
}

// `amount` is treated as the GST-inclusive total. Given that total and a
// GST rate, the tax component is amount * pct / (100 + pct) — not
// amount * pct / 100, which would double-count the tax already folded
// into the total. Rounded to cents; subtotal is whatever remains.
function splitGst(amount, hasGst, pct) {
  const total = Number(amount) || 0;
  if (!hasGst) return { gst_amount: 0, subtotal_amount: total };
  const rate = Number(pct) || 0;
  const gst = Math.round((total * rate / (100 + rate)) * 100) / 100;
  return { gst_amount: gst, subtotal_amount: Math.round((total - gst) * 100) / 100 };
}

// A bill's category is one from the shared category list; `category`
// (text) is kept as that category's name for anything still reading it.
async function categoryName(id) {
  if (!id) return null;
  const { rows } = await pool.query('SELECT name FROM expense_categories WHERE id = $1', [id]);
  return rows[0]?.name ?? null;
}

// Each bill with its category, the ledger entry that paid it (and whether a
// statement has confirmed that entry), its invoice photo, and — for unpaid
// bills — payments already in the ledger that look like they paid it.
// Unambiguous payments are linked first, so the list is current.
router.get('/', ah(async (req, res) => {
  try { await autoLinkBills(); } catch (e) { console.error('Bill auto-link failed:', e.message); }
  const status = ['paid', 'unpaid'].includes(req.query.status) ? req.query.status : null;
  const where = status ? 'WHERE b.status = $1' : '';
  const params = status ? [status] : [];
  const { rows } = await pool.query(
    `SELECT b.*,
            CASE WHEN pc.id IS NULL THEN ec.name ELSE pc.name || ' › ' || ec.name END AS category_full,
            t.date AS paid_tx_date, t.amount AS paid_tx_amount, t.description AS paid_tx_description,
            a.name AS paid_account, cc.name AS paid_card,
            bill_owing(b, CURRENT_DATE) AS owing_now, bill_owing(b, b.due_date) AS owing_at_due, pv.name AS vendor,
            COALESCE((SELECT SUM(amount) FROM credit_applications WHERE bill_id = b.id), 0) AS deposit_applied,
            t.awaiting_statement AS paid_awaiting, (t.source IS NOT NULL) AS paid_from_statement,
            (SELECT r.id FROM receipts r
             WHERE r.bill_id = b.id OR (b.linked_transaction_id IS NOT NULL AND r.transaction_id = b.linked_transaction_id)
             ORDER BY (r.bill_id = b.id) DESC, r.id LIMIT 1) AS invoice_receipt_id
     FROM bills b
     LEFT JOIN expense_categories ec ON ec.id = b.category_id
     LEFT JOIN expense_categories pc ON pc.id = ec.parent_id
     LEFT JOIN transactions t ON t.id = b.linked_transaction_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     LEFT JOIN payees pv ON pv.id = b.payee_id
     ${where}
     ORDER BY (b.status = 'unpaid') DESC, b.due_date ASC`,
    params
  );
  const out = [];
  for (const b of rows) {
    out.push({
      ...b,
      paid_tx_date: b.paid_tx_date ? toISODate(b.paid_tx_date) : null,
      paid_tx_amount: b.paid_tx_amount == null ? null : Number(b.paid_tx_amount),
      owing_now: Number(b.owing_now), owing_at_due: Number(b.owing_at_due),
      interest_free_until: b.interest_free_until ? toISODate(b.interest_free_until) : null,
      balance_as_of: b.balance_as_of ? toISODate(b.balance_as_of) : null,
      suggestions: b.status === 'unpaid' ? await billCandidates(pool, b, 4) : [],
    });
  }
  res.json(out);
}));

// "This payment paid this bill" — a ledger entry already there.
router.post('/:id/link', ah(async (req, res) => {
  const txId = Number(req.body?.transaction_id);
  if (!txId) return res.status(400).json({ error: 'transaction_id is required.' });
  const r = await withTransaction((client) => linkBillToTransaction(client, Number(req.params.id), txId));
  setImmediate(() => matchPending().catch(() => {}));
  res.json({ ok: true, nextBill: r.nextBill });
}));

router.post('/', ah(async (req, res) => {
  const {
    name, ledger = 'business', category_id = null, amount, frequency = 'one_time',
    received_date = null, due_date, notes = null,
    has_gst = false, gst_pct = 5,
  } = req.body;

  const segmentError = validateSegment(req.body);
  if (segmentError) return res.status(400).json({ error: segmentError });
  const fin = financeFrom(req.body);
  const finErr = financeError(fin);
  if (finErr) return res.status(400).json({ error: finErr });

  // Empty strings from an optional form field are not valid DATE input —
  // coerce them (and empty text) to NULL rather than letting the insert fail.
  const { gst_amount, subtotal_amount } = splitGst(amount, has_gst, gst_pct);
  // An agent may send a typed category instead of an id — put it on the shared list.
  const catId = category_id || (req.body.category ? await expenseCategoryFor(pool, req.body.category) : null);
  const category = await categoryName(catId);
  const { rows } = await pool.query(
    `INSERT INTO bills
      (name, ledger, category, amount, frequency, received_date, due_date, notes, has_gst, gst_pct, gst_amount, subtotal_amount,
       ${SEG_COLS}, category_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,${segPlaceholders(13)},$${13 + SEGMENT_COLUMNS.length}) RETURNING *`,
    [name, ledger, category, amount, frequency, received_date || null, due_date, notes || null,
     !!has_gst, gst_pct, gst_amount, subtotal_amount,
     ...segmentValues(req.body), catId]
  );
  await pool.query(
    `UPDATE bills SET is_financed = $2, finance_rate_pct = $3, interest_free_until = $4, balance_amount = $5, balance_as_of = $6 WHERE id = $1`,
    [rows[0].id, fin.is_financed, fin.finance_rate_pct, fin.interest_free_until, fin.balance_amount, fin.balance_as_of]);
  // The vendor: picked, or taken from the name ("Nutrien — Inv 4471" → Nutrien).
  const vendor = req.body.payee_id ? Number(req.body.payee_id) : await payeeId(pool, vendorFromName(name));
  await pool.query('UPDATE bills SET payee_id = $2 WHERE id = $1', [rows[0].id, vendor]);
  // The vendor's owner split, when the caller didn't choose an owner (an
  // agent), or the vendor came from the name and the owner was left at the default.
  const noOwner = req.body.segment === undefined && req.body.is_segment_split === undefined;
  const defaultOwner = !req.body.is_segment_split && (req.body.segment || 'grain') === 'grain';
  if (noOwner || (!req.body.payee_id && defaultOwner)) await applyVendorOwnerToBill(pool, rows[0].id);
  autoLinkBillsSoon(); // already paid? find the payment
  await settle(vendor); // credit already held with the vendor pays it
  res.status(201).json({ ...rows[0], ...fin });
}));

// Marking a bill paid moves real money: when account_id is given, this
// creates the actual ledger transaction (negative = outflow, for the full
// invoice total) in that account IN THE SAME DB TRANSACTION as updating the
// account's balance and flipping the bill to paid — so the balance always
// reflects bills that have actually been paid, not just ones logged as
// paid. account_id is optional only for backward compatibility with bills
// paid before this existed; omitting it marks the bill paid without moving
// any balance, which will look wrong on the Accounts page.
// For a recurring bill, this also rolls the due date forward and re-opens
// it as unpaid, so a monthly/quarterly bill doesn't have to be re-entered
// by hand every cycle.
router.post('/:id/pay', ah(async (req, res) => {
  const {
    paid_date = todayISO(),
    account_id = null,
    paid_by_check = false,
  } = req.body;
  const r = await withTransaction((client) => payBill(client, req.params.id, { account_id, date: paid_date, paid_by_check }));
  if (!r) return res.status(404).json({ error: 'not found' });
  setImmediate(() => matchPending().catch(() => {})); // a photographed invoice attaches to this payment
  autoLinkBillsSoon(); // a recurring bill's next cycle may already be paid
  res.json({ paid: r.bill.id, nextBill: r.nextBill });
}));

// Editing an UNPAID bill is always safe — nothing downstream depends on its
// numbers yet. Once a bill is PAID, though, it has a linked transaction
// that already moved real money and already changed an account balance;
// silently changing the bill's amount/due_date/GST after that would leave
// the bill record disagreeing with the transaction it produced, with
// nothing keeping them in sync. So those fields are locked once paid —
// name/category/notes (cosmetic, no side effects) stay editable always.
// To correct a paid bill's amount, reverse the payment (delete the linked
// transaction, which is a separate, deliberate action) and re-enter it.
// Reverses a paid bill back to unpaid: deletes its linked transaction
// (restoring the account balance it deducted) and clears paid_date/
// linked_transaction_id. This is the supported way to fix a paid bill's
// amount or due date — undo the payment, edit the now-unpaid bill, then
// pay it again — rather than editing a paid bill in place and leaving its
// transaction pointing at stale numbers.
router.post('/:id/unpay', ah(async (req, res) => {
  const bill = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM bills WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows.length) return null;
    const bill = rows[0];
    if (bill.status !== 'paid') return bill;
    // Paid by a deposit: take the deposit back off it (it reopens).
    const { rows: apps } = await client.query('SELECT id FROM credit_applications WHERE bill_id = $1', [bill.id]);
    for (const a of apps) await unapplyVendorCredit(client, a.id);
    const txId = bill.linked_transaction_id;
    // One payment may have paid several bills: undoing it reopens them all.
    const { rows: group } = txId
      ? await client.query('SELECT * FROM bills WHERE linked_transaction_id = $1 FOR UPDATE', [txId])
      : { rows: [bill] };
    for (const b of group) {
      await client.query(
        `UPDATE bills SET status = 'unpaid', paid_date = NULL, linked_transaction_id = NULL, linked_existing = false WHERE id = $1`, [b.id]);
      // Paying a recurring bill created next cycle's bill — a duplicate now.
      if (b.frequency === 'monthly' || b.frequency === 'quarterly') {
        const nextDue = addMonths(toISODate(b.due_date), b.frequency === 'monthly' ? 1 : 3);
        await client.query(
          `DELETE FROM bills WHERE id = (
             SELECT id FROM bills WHERE status = 'unpaid' AND name = $1 AND frequency = $2
               AND amount = $3 AND due_date = $4 AND id > $5 ORDER BY id LIMIT 1)`,
          [b.name, b.frequency, b.amount, nextDue, b.id]);
      }
    }
    if (txId) {
      if (!bill.linked_existing) {
        await removeTransaction(client, txId); // paid from this tab: the payment goes too
      } else {
        // A payment already in the ledger: it stays, its bill pieces come off,
        // and it's remembered as not these bills.
        const names = group.flatMap((b) => [`Bill: ${b.name}`, `Invoice: ${b.name}`, `Finance interest on ${b.name}`]);
        const { rowCount } = await client.query(
          'DELETE FROM transaction_splits WHERE transaction_id = $1 AND memo = ANY($2)', [txId, names]);
        if (rowCount) {
          await client.query(
            `UPDATE transactions SET is_split = EXISTS (SELECT 1 FROM transaction_splits WHERE transaction_id = $1),
               category_id = CASE WHEN EXISTS (SELECT 1 FROM transaction_splits WHERE transaction_id = $1) THEN NULL ELSE $2::int END
             WHERE id = $1`, [txId, group.length === 1 ? bill.category_id : null]);
        }
        for (const b of group) {
          await client.query('INSERT INTO bill_link_rejections (bill_id, transaction_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [b.id, txId]);
        }
      }
    }
    const { rows: [after] } = await client.query('SELECT * FROM bills WHERE id = $1', [bill.id]);
    return after;
  });

  if (!bill) return res.status(404).json({ error: 'not found' });
  res.json(bill);
}));

// ---- By vendor ------------------------------------------------------------
// One line per vendor: what's owed across its unpaid bills, deposits it's
// holding, and the net — plus the bills and deposits behind it.
router.get('/vendors', ah(async (req, res) => {
  try { await autoLinkBills(); } catch (e) { console.error('Bill auto-link failed:', e.message); }
  const { rows: bills } = await pool.query(
    `SELECT b.id, b.payee_id, b.name, b.due_date, b.amount, b.status, bill_owing(b, CURRENT_DATE) AS owing,
            COALESCE((SELECT SUM(amount) FROM credit_applications WHERE bill_id = b.id), 0) AS applied
     FROM bills b WHERE b.status = 'unpaid' ORDER BY b.due_date, b.id`);
  const { rows: credits } = await pool.query(
    `SELECT vc.*, vc.amount - COALESCE((SELECT SUM(amount) FROM credit_applications WHERE credit_id = vc.id), 0) AS remaining,
            t.description AS tx_description, a.name AS account,
            COALESCE((SELECT json_agg(json_build_object('id', ca.id, 'bill_id', ca.bill_id, 'bill', b.name, 'amount', ca.amount) ORDER BY ca.id)
                      FROM credit_applications ca JOIN bills b ON b.id = ca.bill_id WHERE ca.credit_id = vc.id), '[]'::json) AS applications
     FROM vendor_credits vc LEFT JOIN transactions t ON t.id = vc.transaction_id LEFT JOIN accounts a ON a.id = t.account_id
     ORDER BY vc.date, vc.id`);
  const { rows: payees } = await pool.query('SELECT id, name FROM payees');
  const nameOf = new Map(payees.map((p) => [p.id, p.name]));
  const by = new Map();
  const get = (id) => {
    const k = id ?? 0;
    if (!by.has(k)) by.set(k, { payee_id: id, name: id ? nameOf.get(id) : 'No vendor set', owing: 0, held: 0, bills: [], credits: [] });
    return by.get(k);
  };
  for (const b of bills) {
    const v = get(b.payee_id);
    v.owing += Number(b.owing);
    v.bills.push({ ...b, due_date: toISODate(b.due_date), amount: Number(b.amount), owing: Number(b.owing), applied: Number(b.applied) });
  }
  for (const c of credits) {
    const v = get(c.payee_id);
    const open = c.status === 'open';
    if (open) v.held += Number(c.remaining);
    if (open || c.date >= new Date(Date.now() - 365 * 86400000)) {
      v.credits.push({ ...c, date: toISODate(c.date), amount: Number(c.amount), remaining: Number(c.remaining) });
    }
  }
  const out = [...by.values()]
    .map((v) => ({ ...v, owing: Math.round(v.owing * 100) / 100, held: Math.round(v.held * 100) / 100,
      net: Math.round((v.owing - v.held) * 100) / 100, oldest_due: v.bills[0]?.due_date || null }))
    .filter((v) => v.bills.length || v.credits.length)
    .sort((a, b) => (b.owing - a.owing));
  res.json(out);
}));

// Pay several bills (a vendor's whole balance, or the ones picked) in one payment.
router.post('/pay-many', ah(async (req, res) => {
  const { bill_ids = [], account_id, paid_date = todayISO(), paid_by_check = false } = req.body || {};
  if (!account_id) return res.status(400).json({ error: 'Which account did it come out of?' });
  const r = await withTransaction((client) => payBills(client, bill_ids.map(Number), { account_id, date: paid_date, paid_by_check }));
  autoLinkBillsSoon();
  res.json({ transaction_id: r.transaction.id, paid: r.bills.length });
}));

// One payment already in the ledger paid these bills.
router.post('/link-many', ah(async (req, res) => {
  const { bill_ids = [], transaction_id } = req.body || {};
  await withTransaction((client) => linkBillsToTransaction(client, bill_ids.map(Number), Number(transaction_id)));
  setImmediate(() => matchPending().catch(() => {}));
  res.json({ ok: true });
}));

// Deposits held by a vendor.
router.post('/credits', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.payee_id) return res.status(400).json({ error: 'Which vendor is holding it?' });
  const c = await withTransaction((client) => recordVendorDeposit(client, {
    payee_id: Number(b.payee_id), kind: b.kind, transaction_id: b.transaction_id || null,
    account_id: b.account_id || null, amount: b.amount, date: b.date, note: b.note || null,
  }));
  autoLinkBillsSoon();
  if (c.kind === 'prepayment') await settle(c.payee_id);
  res.status(201).json(c);
}));
router.post('/credits/:id/apply', ah(async (req, res) => {
  const r = await withTransaction((client) => applyVendorCredit(client, Number(req.params.id), Number(req.body?.bill_id)));
  res.json(r);
}));
router.post('/credits/applications/:id/remove', ah(async (req, res) => {
  await withTransaction((client) => unapplyVendorCredit(client, Number(req.params.id)));
  res.json({ ok: true });
}));
router.post('/credits/:id/refund', ah(async (req, res) => {
  await withTransaction((client) => refundVendorCredit(client, Number(req.params.id), Number(req.body?.transaction_id)));
  res.json({ ok: true });
}));
router.post('/credits/:id/keep', ah(async (req, res) => {
  await withTransaction((client) => keepVendorCredit(client, Number(req.params.id), req.body?.category_id ? Number(req.body.category_id) : null));
  res.json({ ok: true });
}));
router.delete('/credits/:id', ah(async (req, res) => {
  await withTransaction((client) => removeVendorCredit(client, Number(req.params.id)));
  res.status(204).end();
}));
// Payments to (or refunds from) this vendor not tied to anything yet — to pick from.
router.get('/vendors/:payeeId/payments', ah(async (req, res) => {
  const incoming = req.query.direction === 'in';
  const { rows: [p] } = await pool.query('SELECT name FROM payees WHERE id = $1', [req.params.payeeId]);
  const words = String(p?.name || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const { rows } = await pool.query(
    `SELECT t.id, t.date, t.amount, t.description, a.name AS account FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
     WHERE ${incoming ? 't.amount > 0' : 't.amount < 0'} AND NOT t.is_transfer AND t.date > CURRENT_DATE - 400
       AND (t.payee_id = $1 OR lower(t.description) ~ $2)
       AND NOT EXISTS (SELECT 1 FROM bills x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM loan_payments x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM vendor_credits x WHERE x.transaction_id = t.id OR x.refund_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM contract_payments x WHERE x.transaction_id = t.id)
     ORDER BY t.date DESC LIMIT 20`,
    [req.params.payeeId, words.length ? `(${words.map((w) => w.replace(/[^a-z0-9]/g, '')).join('|')})` : '^$']);
  res.json(rows.map((t) => ({ ...t, date: toISODate(t.date), amount: Number(t.amount) })));
}));

// ---- Vendor accounts ------------------------------------------------------
// Headline figures across every vendor, and the vendors to pick from (any
// with a bill or deposit on file, paid or not).
router.get('/summary', ah(async (req, res) => {
  const { rows: bills } = await pool.query(
    `SELECT b.*, p.name AS payee_name, COALESCE((SELECT SUM(amount) FROM credit_applications WHERE bill_id = b.id), 0) AS applied
     FROM bills b LEFT JOIN payees p ON p.id = b.payee_id WHERE b.status = 'unpaid'`);
  const { rows: credits } = await pool.query(
    `SELECT vc.*, p.name AS payee_name, vc.amount - COALESCE((SELECT SUM(amount) FROM credit_applications WHERE credit_id = vc.id), 0) AS remaining
     FROM vendor_credits vc LEFT JOIN payees p ON p.id = vc.payee_id WHERE vc.status = 'open'`);
  const { rows: vendors } = await pool.query(
    `SELECT p.id AS payee_id, p.name,
            (SELECT max(statement_date) FROM vendor_reconciliations r WHERE r.payee_id = p.id AND r.status = 'done') AS reconciled_to
     FROM payees p
     WHERE EXISTS (SELECT 1 FROM bills b WHERE b.payee_id = p.id) OR EXISTS (SELECT 1 FROM vendor_credits c WHERE c.payee_id = p.id)
        OR EXISTS (SELECT 1 FROM transactions t WHERE t.payee_id = p.id) OR p.segment IS NOT NULL OR p.is_segment_split
     ORDER BY lower(p.name)`);
  res.json({
    summary: billSummary(bills, credits),
    no_vendor: bills.filter((b) => !b.payee_id).length,
    vendors: vendors.map((v) => ({ ...v, reconciled_to: v.reconciled_to ? toISODate(v.reconciled_to) : null })),
  });
}));

// One vendor's account: running balance, what's scheduled, its headline
// figures, and the reconciliation against the vendor's statement.
async function statementFor(payeeId) {
  const { rows: [p] } = await pool.query(`SELECT id, name, ${SEG_COLS} FROM payees WHERE id = $1`, [payeeId]);
  if (!p) return null;
  const st = await vendorStatement(pool, payeeId);
  const rec = await reconState(pool, payeeId);
  const lines = st.lines.map((l) => {
    const c = rec.cleared.get(l.key);
    return c ? { ...l, cleared: { done: c.status === 'done', amount: c.amount, changed: Math.abs(c.amount - l.amount) >= 0.005 } } : l;
  });
  const present = new Set(st.lines.map((l) => l.key));
  const missing = [...rec.cleared.values()].filter((c) => !present.has(c.line_key))
    .map((c) => ({ key: c.line_key, label: c.label, amount: c.amount, done: c.status === 'done' }));
  const credits = st.credits.map((c) => ({ ...c, remaining: Number(c.remaining) }));
  return {
    payee_id: p.id, name: p.name, lines, upcoming: st.upcoming, balance: st.balance,
    owner_rule: p.segment || p.is_segment_split ? Object.fromEntries(SEGMENT_COLUMNS.map((c) => [c, p[c]])) : null,
    opening: st.opening,
    summary: billSummary(st.bills, credits),
    reconciliation: { open: rec.open || null, last: rec.last || null, cleared_total: rec.cleared_total, difference: rec.difference, missing },
  };
}
router.get('/vendors/:payeeId/statement', ah(async (req, res) => {
  const out = await statementFor(Number(req.params.payeeId));
  if (!out) return res.status(404).json({ error: 'Vendor not found.' });
  res.json(out);
}));

// The account's opening balance: { amount, date } (amount positive = you
// owed them, negative = they held a credit), or { clear: true }.
router.put('/vendors/:payeeId/opening', ah(async (req, res) => {
  const payeeId = Number(req.params.payeeId);
  const { amount, date, clear } = req.body || {};
  if (clear) {
    await pool.query('UPDATE payees SET opening_balance = NULL, opening_date = NULL WHERE id = $1', [payeeId]);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return res.status(400).json({ error: 'Enter the date the opening balance is as of.' });
    if (amount === '' || amount == null || !Number.isFinite(Number(amount))) return res.status(400).json({ error: 'Enter the opening balance (negative if they owed you).' });
    await pool.query('UPDATE payees SET opening_balance = $2, opening_date = $3 WHERE id = $1', [payeeId, Number(amount), date]);
  }
  const out = await statementFor(payeeId);
  if (!out) return res.status(404).json({ error: 'Vendor not found.' });
  res.json(out);
}));

// An entry with no bill: paid at purchase (default) or paid on account.
router.post('/vendors/:payeeId/on-account', ah(async (req, res) => {
  const payeeId = Number(req.params.payeeId);
  const txId = Number(req.body?.transaction_id);
  const { rows: [t] } = await pool.query('SELECT id FROM transactions WHERE id = $1 AND payee_id = $2', [txId, payeeId]);
  if (!t) return res.status(404).json({ error: 'That entry isn’t this vendor’s.' });
  await withTransaction(async (client) => {
    if (req.body?.on) {
      await client.query('INSERT INTO vendor_on_account (transaction_id) VALUES ($1) ON CONFLICT DO NOTHING', [txId]);
    } else {
      // Back to paid at purchase: the credit it became comes off the bills it paid.
      const { rows: held } = await client.query(
        `SELECT id FROM vendor_credits WHERE transaction_id = $1 AND kind = 'prepayment'`, [txId]);
      for (const c of held) await removeVendorCredit(client, c.id);
      await client.query('DELETE FROM vendor_on_account WHERE transaction_id = $1', [txId]);
    }
    await settleVendorAccount(client, payeeId);
  });
  res.json(await statementFor(payeeId));
}));

// Start (or change) a reconciliation: the vendor statement's date and closing balance.
router.post('/vendors/:payeeId/reconcile', ah(async (req, res) => {
  const payeeId = Number(req.params.payeeId);
  const { statement_date, statement_balance } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(statement_date || ''))) return res.status(400).json({ error: 'Enter the statement date.' });
  if (statement_balance === '' || statement_balance == null || !Number.isFinite(Number(statement_balance))) {
    return res.status(400).json({ error: 'Enter the balance the statement shows (negative if they owe you).' });
  }
  const { rows: [last] } = await pool.query(
    `SELECT max(statement_date) AS d FROM vendor_reconciliations WHERE payee_id = $1 AND status = 'done'`, [payeeId]);
  if (last?.d && toISODate(last.d) >= statement_date) {
    return res.status(400).json({ error: `This vendor is already reconciled to ${toISODate(last.d)} — use a later statement.` });
  }
  await pool.query(
    `INSERT INTO vendor_reconciliations (payee_id, statement_date, statement_balance) VALUES ($1, $2, $3)
     ON CONFLICT (payee_id) WHERE status = 'open' DO UPDATE SET statement_date = EXCLUDED.statement_date, statement_balance = EXCLUDED.statement_balance`,
    [payeeId, statement_date, Number(statement_balance)]);
  res.json(await statementFor(payeeId));
}));

// Tick or untick a line as on the vendor's statement.
router.post('/vendors/:payeeId/reconcile/tick', ah(async (req, res) => {
  const payeeId = Number(req.params.payeeId);
  const { key, on } = req.body || {};
  const { rows: [open] } = await pool.query(`SELECT id FROM vendor_reconciliations WHERE payee_id = $1 AND status = 'open'`, [payeeId]);
  if (!open) return res.status(400).json({ error: 'Start a reconciliation first.' });
  const { rows: [have] } = await pool.query('SELECT reconciliation_id FROM vendor_cleared WHERE payee_id = $1 AND line_key = $2', [payeeId, key]);
  if (have && have.reconciliation_id !== open.id) return res.status(400).json({ error: 'That line was reconciled on an earlier statement.' });
  if (!on) {
    await pool.query('DELETE FROM vendor_cleared WHERE payee_id = $1 AND line_key = $2', [payeeId, key]);
  } else {
    const st = await vendorStatement(pool, payeeId);
    const line = st.lines.find((l) => l.key === key);
    if (!line) return res.status(404).json({ error: 'That line is no longer on the account.' });
    await pool.query(
      `INSERT INTO vendor_cleared (payee_id, line_key, reconciliation_id, amount, label) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (payee_id, line_key) DO UPDATE SET amount = EXCLUDED.amount, label = EXCLUDED.label`,
      [payeeId, key, open.id, line.amount, line.label]);
  }
  res.json(await statementFor(payeeId));
}));

// Finish: only when the ticked lines come to the statement balance.
router.post('/vendors/:payeeId/reconcile/finish', ah(async (req, res) => {
  const payeeId = Number(req.params.payeeId);
  const rec = await reconState(pool, payeeId);
  if (!rec.open) return res.status(400).json({ error: 'No reconciliation is open.' });
  if (Math.abs(rec.difference) >= 0.005) {
    return res.status(400).json({ error: `Ticked lines are ${rec.difference > 0 ? 'short of' : 'over'} the statement by ${Math.abs(rec.difference).toFixed(2)}.` });
  }
  await pool.query(`UPDATE vendor_reconciliations SET status = 'done', finished_at = now() WHERE id = $1`, [rec.open.id]);
  res.json(await statementFor(payeeId));
}));

// Cancel the open reconciliation (its ticks go with it).
router.delete('/vendors/:payeeId/reconcile', ah(async (req, res) => {
  const payeeId = Number(req.params.payeeId);
  await pool.query(`DELETE FROM vendor_reconciliations WHERE payee_id = $1 AND status = 'open'`, [payeeId]);
  res.json(await statementFor(payeeId));
}));

// Undo the latest finished reconciliation (only if none is open).
router.post('/vendors/:payeeId/reconcile/undo', ah(async (req, res) => {
  const payeeId = Number(req.params.payeeId);
  const rec = await reconState(pool, payeeId);
  if (rec.open) return res.status(400).json({ error: 'Finish or cancel the open reconciliation first.' });
  if (!rec.last) return res.status(400).json({ error: 'Nothing to undo.' });
  await pool.query('DELETE FROM vendor_reconciliations WHERE id = $1', [rec.last.id]);
  res.json(await statementFor(payeeId));
}));

router.patch('/:id', ah(async (req, res) => {
  const { name, amount, due_date, notes, has_gst, gst_pct } = req.body;
  if (req.body.category_id === undefined && req.body.category) req.body.category_id = await expenseCategoryFor(pool, req.body.category);
  const setsCategory = req.body.category_id !== undefined;
  const category = setsCategory ? await categoryName(req.body.category_id) : undefined;

  const { rows: currentRows } = await pool.query('SELECT * FROM bills WHERE id = $1', [req.params.id]);
  if (!currentRows.length) return res.status(404).json({ error: 'not found' });
  const current = currentRows[0];

  const touchesFinancials =
    amount !== undefined || due_date !== undefined || has_gst !== undefined || gst_pct !== undefined
    || FIN_FIELDS.some((k) => req.body[k] !== undefined && finKey(k, req.body[k]) !== finKey(k, current[k]));
  const fin = financeFrom(req.body, current);
  const finErr = financeError(fin);
  if (finErr && current.status !== 'paid') return res.status(400).json({ error: finErr });
  if (current.status === 'paid' && touchesFinancials) {
    return res.status(409).json({
      error: 'This bill is already paid — its amount, due date, and GST are locked because a transaction already moved money based on them. Only name, category, notes, and owner can still be edited. To fix an amount, reverse the payment first.',
    });
  }

  // Owner tagging is categorization, not money — safe to change even on a
  // paid bill. But it's copied onto the linked transaction at pay time, so
  // an edit here is propagated there too, or the bill and its own
  // transaction would disagree about whose spend it is.
  const touchesSegment = SEGMENT_COLUMNS.some((c) => req.body[c] !== undefined);
  const effectiveSeg = {};
  for (const c of SEGMENT_COLUMNS) effectiveSeg[c] = req.body[c] !== undefined ? req.body[c] : current[c];
  if (touchesSegment) {
    const segmentError = validateSegment(effectiveSeg);
    if (segmentError) return res.status(400).json({ error: segmentError });
  }
  const segVals = segmentValues(effectiveSeg);
  const segSet = (start) => SEGMENT_COLUMNS.map((c, i) => `${c} = $${start + i}`).join(', ');

  const effectiveAmount = amount ?? current.amount;
  const effectiveHasGst = has_gst ?? current.has_gst;
  const effectiveGstPct = gst_pct ?? current.gst_pct;
  const { gst_amount, subtotal_amount } = splitGst(effectiveAmount, effectiveHasGst, effectiveGstPct);

  const bill = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE bills SET
         name = COALESCE($1, name),
         amount = COALESCE($2, amount),
         due_date = COALESCE($3, due_date),
         category = CASE WHEN $${11 + SEGMENT_COLUMNS.length} THEN $4 ELSE category END,
         category_id = CASE WHEN $${11 + SEGMENT_COLUMNS.length} THEN $${12 + SEGMENT_COLUMNS.length}::int ELSE category_id END,
         notes = COALESCE($5, notes),
         has_gst = $6,
         gst_pct = $7,
         gst_amount = $8,
         subtotal_amount = $9,
         ${segSet(10)}
       WHERE id = $${10 + SEGMENT_COLUMNS.length} RETURNING *`,
      [name, amount, due_date, category, notes, effectiveHasGst, effectiveGstPct, gst_amount, subtotal_amount,
       ...segVals, req.params.id, setsCategory, req.body.category_id || null]
    );
    const updated = rows[0];
    // The invoice date: where the charge lands on the vendor's account.
    if (req.body.received_date !== undefined) {
      await client.query('UPDATE bills SET received_date = $2 WHERE id = $1', [updated.id, req.body.received_date || null]);
      updated.received_date = req.body.received_date || null;
    }
    if (req.body.payee_id !== undefined) {
      await client.query('UPDATE bills SET payee_id = $2 WHERE id = $1', [updated.id, req.body.payee_id ? Number(req.body.payee_id) : null]);
      updated.payee_id = req.body.payee_id ? Number(req.body.payee_id) : null;
    }
    if (current.status !== 'paid' && FIN_FIELDS.some((k) => req.body[k] !== undefined)) {
      await client.query(
        `UPDATE bills SET is_financed = $2, finance_rate_pct = $3, interest_free_until = $4, balance_amount = $5, balance_as_of = $6 WHERE id = $1`,
        [updated.id, fin.is_financed, fin.finance_rate_pct, fin.interest_free_until, fin.balance_amount, fin.balance_as_of]);
      Object.assign(updated, fin);
    }
    // The payment carries the bill's category when it had none of its own.
    if (setsCategory && updated.linked_transaction_id && req.body.category_id) {
      await client.query('UPDATE transactions SET category_id = $1 WHERE id = $2 AND category_id IS NULL AND NOT is_split',
        [req.body.category_id, updated.linked_transaction_id]);
    }

    if (touchesSegment && updated.linked_transaction_id) {
      await client.query(
        `UPDATE transactions SET ${segSet(1)} WHERE id = $${1 + SEGMENT_COLUMNS.length}`,
        [...segVals, updated.linked_transaction_id]
      );
    }
    return updated;
  });

  if (bill.status === 'unpaid') autoLinkBillsSoon();
  await settle(bill.payee_id);
  if (current.payee_id && current.payee_id !== bill.payee_id) await settle(current.payee_id);
  res.json(bill);
}));

router.delete('/:id', ah(async (req, res) => {
  const { rows: [gone] } = await pool.query('DELETE FROM bills WHERE id = $1 RETURNING payee_id', [req.params.id]);
  if (!gone) return res.status(404).json({ error: 'not found' });
  await settle(gone.payee_id); // what was applied to it goes back to the account
  res.status(204).end();
}));

export default router;
