import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { ownerWeights, OWNERS, segmentValues, validateSegment, SEGMENT_COLUMNS } from '../lib/segments.js';
import { payeeId, applyVendorOwnerToTransaction, applyVendorOwnerToBill } from '../lib/postings.js';

// Who was paid, or who paid: Cargill, Viterra, the auction mart, Co-op.
const router = Router();

router.get('/', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, COUNT(t.id)::int AS uses, p.segment, p.is_segment_split,
            p.segment_grain_pct, p.segment_livestock_pct, p.segment_jake_pct, p.segment_ashley_pct
     FROM payees p LEFT JOIN transactions t ON t.payee_id = p.id
     GROUP BY p.id ORDER BY lower(p.name)`
  );
  res.json(rows);
}));

// Find-or-create by name (case-insensitive), so "cargill" and "Cargill"
// are one payee.
router.post('/', ah(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = await payeeId(pool, name);
  const { rows } = await pool.query('SELECT id, name FROM payees WHERE id = $1', [id]);
  res.status(201).json(rows[0]);
}));

router.patch('/:id', ah(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows: clash } = await pool.query('SELECT id FROM payees WHERE lower(name) = lower($1) AND id <> $2', [name, req.params.id]);
  if (clash.length) return res.status(409).json({ error: `"${name}" already exists.` });
  const { rows } = await pool.query('UPDATE payees SET name = $1 WHERE id = $2 RETURNING id, name', [name, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

// What deleting a vendor would touch.
async function usage(db, id) {
  const { rows: [u] } = await db.query(
    `SELECT (SELECT COUNT(*) FROM bills WHERE payee_id = $1 AND status = 'unpaid')::int AS unpaid_bills,
            (SELECT COUNT(*) FROM bills WHERE payee_id = $1 AND status <> 'unpaid')::int AS paid_bills,
            (SELECT COUNT(*) FROM transactions WHERE payee_id = $1)::int AS entries,
            (SELECT COUNT(*) FROM vendor_credits WHERE payee_id = $1)::int AS deposits,
            (SELECT COUNT(*) FROM vendor_reconciliations WHERE payee_id = $1)::int AS reconciliations,
            (SELECT COUNT(*) FROM transactions t WHERE t.payee_id = $1 AND NOT t.is_transfer
               AND NOT EXISTS (SELECT 1 FROM closed_periods c WHERE c.month = date_trunc('month', t.date)::date))::int AS open_entries`, [id]);
  return u;
}
router.get('/:id/usage', ah(async (req, res) => {
  const { rows: [p] } = await pool.query(`SELECT id, name, ${SEGMENT_COLUMNS.join(', ')} FROM payees WHERE id = $1`, [req.params.id]);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({ ...p, ...(await usage(pool, p.id)) });
}));

// A vendor's owner split: { segment | is_segment_split + pcts } sets it,
// { clear: true } removes it. With apply_existing, its bills and ledger
// entries already on file are re-split too (closed months left alone).
router.put('/:id/owner', ah(async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const { rows: [p] } = await pool.query('SELECT id FROM payees WHERE id = $1', [id]);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (b.clear) {
    await pool.query(`UPDATE payees SET segment = NULL, is_segment_split = false, segment_grain_pct = NULL, segment_livestock_pct = NULL,
                        segment_jake_pct = NULL, segment_ashley_pct = NULL WHERE id = $1`, [id]);
    return res.json({ ok: true, cleared: true });
  }
  const err = validateSegment(b);
  if (err) return res.status(400).json({ error: err });
  if (!b.is_segment_split && !b.segment) return res.status(400).json({ error: 'Pick an owner or a split.' });
  await pool.query(`UPDATE payees SET ${SEGMENT_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...segmentValues(b)]);
  let bills = 0;
  let entries = 0;
  if (b.apply_existing) {
    await withTransaction(async (client) => {
      const { rows: bl } = await client.query('SELECT id FROM bills WHERE payee_id = $1', [id]);
      for (const r of bl) if (await applyVendorOwnerToBill(client, r.id)) bills++;
      const { rows: tx } = await client.query('SELECT id FROM transactions WHERE payee_id = $1 AND NOT is_transfer', [id]);
      for (const r of tx) if (await applyVendorOwnerToTransaction(client, r.id)) entries++;
    });
  }
  res.json({ ok: true, bills, entries });
}));

// Delete a vendor. With ?merge_into=ID its bills, ledger entries, deposits
// and reconciliations move to that vendor first (for duplicates). Without
// it, bills and entries keep everything but the vendor; a vendor holding
// deposits can only be merged, so the deposit records aren't lost.
router.delete('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const into = req.query.merge_into ? Number(req.query.merge_into) : null;
  if (into === id) return res.status(400).json({ error: 'Pick a different vendor to merge into.' });
  const out = await withTransaction(async (client) => {
    const { rows: [p] } = await client.query('SELECT id, name FROM payees WHERE id = $1 FOR UPDATE', [id]);
    if (!p) return { status: 404, body: { error: 'Vendor not found.' } };
    const u = await usage(client, id);
    if (into) {
      const { rows: [t] } = await client.query('SELECT id, name FROM payees WHERE id = $1', [into]);
      if (!t) return { status: 404, body: { error: 'The vendor to merge into was not found.' } };
      await client.query('UPDATE bills SET payee_id = $2 WHERE payee_id = $1', [id, into]);
      await client.query('UPDATE transactions SET payee_id = $2 WHERE payee_id = $1', [id, into]);
      await client.query('UPDATE vendor_credits SET payee_id = $2 WHERE payee_id = $1', [id, into]);
      // Reconciliations: the merged account's balance changes, so an open
      // one on either side is dropped; finished ones and their ticks move.
      await client.query(`DELETE FROM vendor_reconciliations WHERE payee_id IN ($1, $2) AND status = 'open'`, [id, into]);
      await client.query(
        `INSERT INTO vendor_cleared (payee_id, line_key, reconciliation_id, amount, label)
         SELECT $2, line_key, reconciliation_id, amount, label FROM vendor_cleared WHERE payee_id = $1
         ON CONFLICT (payee_id, line_key) DO NOTHING`, [id, into]);
      await client.query('DELETE FROM vendor_cleared WHERE payee_id = $1', [id]);
      await client.query('UPDATE vendor_reconciliations SET payee_id = $2 WHERE payee_id = $1', [id, into]);
      // Opening balances add together, as of the earlier date.
      await client.query(
        `UPDATE payees t SET opening_balance = COALESCE(t.opening_balance, 0) + COALESCE(s.opening_balance, 0),
                             opening_date = LEAST(t.opening_date, s.opening_date)
         FROM payees s WHERE s.id = $1 AND t.id = $2 AND s.opening_date IS NOT NULL`, [id, into]);
      await client.query('DELETE FROM payees WHERE id = $1', [id]);
      return { status: 200, body: { deleted: p.name, merged_into: t.name, moved: u } };
    }
    if (u.deposits) {
      return { status: 409, body: { error: `${p.name} has ${u.deposits} deposit record${u.deposits === 1 ? '' : 's'} — merge it into another vendor, or remove the deposits first.` } };
    }
    await client.query('DELETE FROM payees WHERE id = $1', [id]); // bills and entries keep their details, vendor cleared
    return { status: 200, body: { deleted: p.name, cleared: u } };
  });
  res.status(out.status).json(out.body);
}));

// Totals by payee for one year: kind=expense (default) is money paid out,
// kind=income money received. Split pieces count at their own amounts and
// owners; transfers and loan payments are left out, like every other
// income/expense figure.
router.get('/totals', ah(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const owner = String(req.query.owner || 'all');
  if (owner !== 'all' && !OWNERS.includes(owner)) return res.status(400).json({ error: `owner must be all, ${OWNERS.join(', ')}` });
  const income = req.query.kind === 'income';
  const { rows } = await pool.query(
    `SELECT l.amount, l.segment, l.is_segment_split, l.segment_grain_pct, l.segment_livestock_pct,
            l.segment_jake_pct, l.segment_ashley_pct, t.payee_id, p.name AS payee
     FROM transaction_lines l
     JOIN transactions t ON t.id = l.transaction_id
     LEFT JOIN payees p ON p.id = t.payee_id
     WHERE l.is_transfer = false AND (l.is_debt_service = false OR l.split_id IS NOT NULL) AND EXTRACT(YEAR FROM l.date) = $1
       AND ${income ? 'l.amount > 0' : 'l.amount < 0'}`,
    [year]
  );
  const by = new Map();
  for (const r of rows) {
    const w = owner === 'all' ? 1 : ownerWeights(r)[owner];
    if (!w) continue;
    const key = r.payee_id || 0;
    if (!by.has(key)) by.set(key, { payee_id: r.payee_id, name: r.payee || 'No payee recorded', total: 0, count: 0 });
    const e = by.get(key);
    e.total += Math.abs(Number(r.amount)) * w;
    e.count += 1;
  }
  const list = [...by.values()].map((e) => ({ ...e, total: Math.round(e.total * 100) / 100 }))
    .sort((a, b) => (!a.payee_id - !b.payee_id) || (b.total - a.total)); // "No payee recorded" last
  res.json({ year, owner, kind: income ? 'income' : 'expense', total: Math.round(list.reduce((s, e) => s + e.total, 0) * 100) / 100, payees: list });
}));

export default router;
