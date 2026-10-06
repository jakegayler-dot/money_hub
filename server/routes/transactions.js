import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { ah } from '../lib/asyncHandler.js';
import { validateSegment, SEGMENT_COLUMNS } from '../lib/segments.js';
import {
  insertTransaction, removeTransaction, ownerOf, ledgerForOwner, normalizeSplits,
  linkBillToTransaction, linkLoanPaymentToTransaction, linkContractToTransaction, linkCardPaymentToTransaction, payeeId, UNCATEGORIZED_INCOME, cleanGst,
} from '../lib/postings.js';
import { toISODate } from '../lib/dates.js';
import { assertOpen, CONFIRMED_SQL, PASSED_SQL } from '../lib/periods.js';
import { matchPending } from '../lib/receipts.js';
import { autoLinkBillsSoon } from '../lib/billMatch.js';
import { settleVendorAccount } from '../lib/postings.js';
import { loanTerms } from '../lib/loanMatch.js';

/** Vendors whose account a payment sits on (as a payment on account). */
const creditVendors = async (txId) => (await pool.query(
  `SELECT DISTINCT payee_id FROM vendor_credits WHERE transaction_id = $1 OR refund_transaction_id = $1
   UNION SELECT t.payee_id FROM vendor_on_account o JOIN transactions t ON t.id = o.transaction_id WHERE o.transaction_id = $1 AND t.payee_id IS NOT NULL`,
  [txId])).rows.map((r) => r.payee_id);
const resettle = async (payees) => {
  for (const p of new Set(payees)) {
    await withTransaction((c) => settleVendorAccount(c, p)).catch((e) => console.error('Vendor settle failed', p, e.message));
  }
};
import { cardBalances } from '../lib/cardLedger.js';

const router = Router();
const r2 = (n) => Math.round(Number(n) * 100) / 100;

// Running balance for one account or card, worked back from its balance
// today: the balance after a row is today's balance minus everything
// dated after it (same-day rows in entry order). For an account that's
// its book balance — what the bank shows once outstanding checks clear.
// For a card it's what's owed, counted from its itemizing start date.
async function runningBalances(db, { account_id, credit_card_id }) {
  if (account_id) {
    const { rows: [a] } = await db.query('SELECT id, name, opening_balance FROM accounts WHERE id = $1', [account_id]);
    if (!a) return null;
    const { rows } = await db.query(
      `SELECT t.id, t.amount, ${CONFIRMED_SQL('t')} AS confirmed,
              SUM(t.amount) OVER (ORDER BY t.date DESC, t.id DESC ROWS UNBOUNDED PRECEDING) - t.amount AS later
       FROM transactions t WHERE t.account_id = $1`, [account_id]);
    const now = Number(a.opening_balance);
    const open = rows.filter((t) => !t.confirmed);
    const unconfirmed = r2(open.reduce((s, t) => s + Number(t.amount), 0));
    return {
      summary: {
        kind: 'account', name: a.name, balance_now: r2(now),
        unconfirmed_count: open.length, unconfirmed, confirmed_balance: r2(now - unconfirmed),
      },
      byId: new Map(rows.map((t) => [t.id, r2(now - Number(t.later))])),
    };
  }
  const { rows: [c] } = await db.query('SELECT * FROM credit_cards WHERE id = $1', [credit_card_id]);
  if (!c) return null;
  const owed = (await cardBalances(db, [c])).get(c.id)?.outstanding ?? 0;
  const { rows: [u] } = await db.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN t.account_id IS NULL THEN -t.amount ELSE t.amount END), 0) AS owed
     FROM transactions t WHERE t.credit_card_id = $1 AND t.date >= COALESCE($2, '1900-01-01'::date) AND NOT ${CONFIRMED_SQL('t')}`,
    [c.id, c.ledger_start_date]);
  const summary = {
    kind: 'card', name: c.name, balance_now: r2(owed), itemized_from: c.ledger_start_date ? toISODate(c.ledger_start_date) : null,
    unconfirmed_count: Number(u.n), unconfirmed: r2(u.owed), confirmed_balance: r2(owed - Number(u.owed)),
  };
  if (!c.ledger_start_date) return { summary, byId: new Map() };
  // Effect on what's owed: a purchase on the card (no account) raises it;
  // a payment from an account (both set, negative) lowers it.
  const { rows } = await db.query(
    `SELECT id, SUM(eff) OVER (ORDER BY date DESC, id DESC ROWS UNBOUNDED PRECEDING) - eff AS later
     FROM (SELECT id, date, CASE WHEN account_id IS NULL THEN -amount ELSE amount END AS eff
           FROM transactions WHERE credit_card_id = $1 AND date >= $2) x`, [c.id, c.ledger_start_date]);
  return { summary, byId: new Map(rows.map((t) => [t.id, r2(owed - Number(t.later))])) };
}

// Today's balance for the account or card the ledger is filtered to.
router.get('/balance', ah(async (req, res) => {
  const { account_id, credit_card_id } = req.query;
  if (!account_id && !credit_card_id) return res.status(400).json({ error: 'account_id or credit_card_id is required.' });
  const rb = await runningBalances(pool, { account_id, credit_card_id });
  if (!rb) return res.status(404).json({ error: 'not found' });
  res.json(rb.summary);
}));

// What a payment out of the ledger could be paying: every unpaid bill, and
// every unrecorded scheduled loan payment due within the next 90 days
// (overdue ones included).
router.get('/link-options', ah(async (req, res) => {
  const { rows: bills } = await pool.query(
    `SELECT id, name, due_date, bill_owing(bills, CURRENT_DATE) AS amount, category FROM bills WHERE status = 'unpaid' ORDER BY due_date, id`
  );
  // Each loan's oldest open payment — the only one a payment can be paying.
  const { rows: payments } = await pool.query(
    `SELECT DISTINCT ON (lp.loan_id) lp.id, lp.loan_id, lp.due_date, lp.principal_amount + lp.interest_amount AS amount,
            COALESCE(NULLIF(l.name, ''), l.lender) AS loan_name, l.name, l.lender, l.statement_names, l.payee_id
     FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
     WHERE NOT lp.paid AND NOT COALESCE(lp.is_adjustment, false)
     ORDER BY lp.loan_id, lp.due_date, lp.id`
  );
  for (const p of payments) p.terms = loanTerms(p);
  const { rows: contracts } = await pool.query(
    `SELECT id, commodity, counterparty, GREATEST(total_value - received_amount, 0) AS amount,
            total_value, received_amount, expected_payment_date AS due_date, status
     FROM sale_contracts WHERE status IN ('open', 'delivered') ORDER BY expected_payment_date, id`
  );
  const { rows: cards } = await pool.query(
    `SELECT id, name, issuer, last4 FROM credit_cards WHERE status = 'active' ORDER BY name`);
  res.json({
    cards,
    contracts: contracts.map((c) => ({ ...c, due_date: toISODate(c.due_date), amount: Number(c.amount) })),
    bills: bills.map((b) => ({ ...b, due_date: toISODate(b.due_date), amount: Number(b.amount) })),
    loan_payments: payments.map((p) => ({ ...p, due_date: toISODate(p.due_date), amount: Number(p.amount) })),
  });
}));

router.get('/', ah(async (req, res) => {
  const { ledger, from, to, account_id, credit_card_id, needs_review, q, limit = 200 } = req.query;
  const conditions = [];
  const params = [];
  const add = (sql, v) => { params.push(v); conditions.push(sql.replace('?', `$${params.length}`)); };
  if (ledger) add('t.ledger = ?', ledger);
  if (from) add('t.date >= ?', from);
  if (to) add('t.date <= ?', to);
  if (account_id) add('t.account_id = ?', account_id);
  if (credit_card_id) add('t.credit_card_id = ?', credit_card_id);
  if (needs_review === 'true') conditions.push('t.needs_review = true');
  if (req.query.id) add('t.id = ?', req.query.id);
  if (q) add('(t.description ILIKE ? OR p.name ILIKE $' + (params.length + 1) + ')', `%${q}%`);
  if (req.query.payee_id) add('t.payee_id = ?', req.query.payee_id);
  if (req.query.unconfirmed === 'true') conditions.push(`NOT ${CONFIRMED_SQL('t')}`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(Number(limit) || 200, 2000));

  // Account and card names joined in so the ledger can say where each
  // entry came from (a card purchase has no account), plus split pieces.
  const { rows } = await pool.query(
    `SELECT t.*, a.name AS account_name, cc.name AS card_name, ec.name AS category_name, p.name AS payee_name,
            COALESCE((
              SELECT json_agg(json_build_object(
                'id', s.id, 'amount', s.amount, 'memo', s.memo, 'category_id', s.category_id,
                'category_name', sc.name, 'ledger', s.ledger, 'is_capex', s.is_capex, 'is_transfer', s.is_transfer,
                'segment', s.segment, 'is_segment_split', s.is_segment_split,
                'segment_grain_pct', s.segment_grain_pct, 'segment_livestock_pct', s.segment_livestock_pct,
                'segment_jake_pct', s.segment_jake_pct, 'segment_ashley_pct', s.segment_ashley_pct
              ) ORDER BY s.id)
              FROM transaction_splits s LEFT JOIN expense_categories sc ON sc.id = s.category_id
              WHERE s.transaction_id = t.id
            ), '[]'::json) AS splits,
            COALESCE(
              (SELECT 'Bill: ' || b.name FROM bills b WHERE b.linked_transaction_id = t.id LIMIT 1),
              (SELECT 'Loan: ' || COALESCE(l.name, l.lender) || ' (due ' || to_char(lp.due_date, 'YYYY-MM-DD') || ')'
                 FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id WHERE lp.linked_transaction_id = t.id LIMIT 1),
              (SELECT 'Contract: ' || c.commodity || COALESCE(' — ' || c.counterparty, '') FROM contract_payments cp
                 JOIN sale_contracts c ON c.id = cp.contract_id WHERE cp.transaction_id = t.id LIMIT 1),
              CASE WHEN t.account_id IS NOT NULL AND t.credit_card_id IS NOT NULL THEN 'Card payment: ' || cc.name END
            ) AS pays,
            EXISTS (SELECT 1 FROM closed_periods cp WHERE cp.month = date_trunc('month', t.date)::date) AS in_closed_month,
            (SELECT r.id FROM receipts r WHERE r.transaction_id = t.id ORDER BY r.id LIMIT 1) AS receipt_id,
            (SELECT json_agg(json_build_object('id', r.id, 'mime', r.mime, 'type', COALESCE(r.extracted->>'doc_type', 'receipt')) ORDER BY r.id)
               FROM receipts r WHERE r.transaction_id = t.id) AS documents,
            ${CONFIRMED_SQL('t')} AS confirmed,
            ${PASSED_SQL('t')} AS statement_passed
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     LEFT JOIN expense_categories ec ON ec.id = t.category_id
     LEFT JOIN payees p ON p.id = t.payee_id
     ${where}
     ORDER BY t.date DESC, t.id DESC LIMIT $${params.length}`,
    params
  );
  const rb = (account_id || credit_card_id) ? await runningBalances(pool, { account_id, credit_card_id }) : null;
  res.json(rows.map((r) => ({
    ...r, date: toISODate(r.date), cleared_date: toISODate(r.cleared_date),
    ...(rb ? { running_balance: rb.byId.get(r.id) ?? null } : {}),
  })));
}));

// Manual entry. Either out of/into an account (account_id), or charged to
// a card (credit_card_id, no account — raises the card's balance; the card
// must be itemized, i.e. have a ledger start). `splits` divides one
// transaction into pieces, each with its own amount, category and owner;
// pieces must add up to the total. `is_transfer` marks money moving
// between things Money Hub tracks (not income or expense).
//
// `transfer_account_id` (with is_transfer and account_id) records BOTH
// sides of an account-to-account move in one go: `amount` on account_id
// (negative = money leaving it) and the opposite amount on the other
// account, linked to each other as transfer peers.
router.post('/', ah(async (req, res) => {
  const {
    account_id = null, credit_card_id = null, date, amount, description,
    category_id = null, purchase_class = null,
    is_mixed_use = false, mixed_use_business_pct = null,
    is_capex = false, is_transfer = false, entered_by = 'manual',
    cleared = true, splits: pieces = [], needs_review = false, review_note = null,
    transfer_account_id = null,
  } = req.body;

  if (transfer_account_id) {
    if (!account_id) return res.status(400).json({ error: 'A transfer to another account needs the account it comes from (or goes into).' });
    if (String(transfer_account_id) === String(account_id)) return res.status(400).json({ error: 'Pick two different accounts.' });
    if (!date || !Number(amount)) return res.status(400).json({ error: 'date and a non-zero amount are required.' });
    if (pieces.length) return res.status(400).json({ error: "A transfer can't be split into pieces." });
    const { rows: accts } = await pool.query('SELECT * FROM accounts WHERE id = ANY($1::int[])', [[account_id, transfer_account_id]]);
    const from = accts.find((a) => String(a.id) === String(account_id));
    const other = accts.find((a) => String(a.id) === String(transfer_account_id));
    if (!from || !other) return res.status(400).json({ error: 'account not found' });
    const amt = Number(amount);
    const note = description ? ` — ${description}` : '';
    const side = (acct, value, label) => {
      const owner = ownerOf({}, acct);
      return {
        account_id: acct.id, credit_card_id: null, ledger: ledgerForOwner(owner, acct.ledger || 'business'),
        date, amount: value, description: label, category_id: null, purchase_class: null,
        is_mixed_use: false, mixed_use_business_pct: null, is_capex: false, is_transfer: true, entered_by,
        cleared: true, owner, splits: [], needs_review, review_note,
        awaiting_statement: entered_by === 'manual' ? 'fed' : false,
      };
    };
    const row = await withTransaction(async (client) => {
      const a = await insertTransaction(client, side(from, amt, `Transfer ${amt < 0 ? 'to' : 'from'} ${other.name}${note}`));
      const b = await insertTransaction(client, side(other, -amt, `Transfer ${amt < 0 ? 'from' : 'to'} ${from.name}${note}`));
      await client.query('UPDATE transactions SET transfer_peer_id = $1 WHERE id = $2', [b.id, a.id]);
      await client.query('UPDATE transactions SET transfer_peer_id = $1 WHERE id = $2', [a.id, b.id]);
      return { ...a, transfer_peer_id: b.id };
    });
    return res.status(201).json(row);
  }

  if (!account_id && !credit_card_id) return res.status(400).json({ error: 'Pick an account, or a card for a card purchase.' });
  if (!date || !Number(amount)) return res.status(400).json({ error: 'date and a non-zero amount are required.' });
  const segmentError = validateSegment(req.body);
  if (segmentError) return res.status(400).json({ error: segmentError });

  let card = null;
  if (credit_card_id && !account_id) {
    const { rows } = await pool.query('SELECT * FROM credit_cards WHERE id = $1', [credit_card_id]);
    card = rows[0];
    if (!card) return res.status(400).json({ error: 'card not found' });
    if (!card.ledger_start_date) {
      return res.status(400).json({
        error: `${card.name} isn't itemized yet — set its ledger start (date and balance on that date) on the Credit Cards tab before entering purchases on it.`,
      });
    }
  }

  let fallbackOwner = {};
  if (account_id) fallbackOwner = (await pool.query('SELECT * FROM accounts WHERE id = $1', [account_id])).rows[0] || {};
  else fallbackOwner = card;
  const owner = ownerOf(req.body, fallbackOwner);
  const ledger = req.body.ledger || ledgerForOwner(owner, fallbackOwner.ledger || 'business');
  const { splits, error } = normalizeSplits(pieces, Number(amount), owner, ledger);
  if (error) return res.status(400).json({ error });

  // link_bill_id / link_loan_payment_id: this entry IS that bill's or loan
  // payment's money — the bill is marked paid (or the loan payment
  // recorded) by this transaction instead of creating another one.
  const { link_bill_id = null, link_loan_payment_id = null, link_contract_id = null, link_card_id = null } = req.body;
  const row = await withTransaction(async (client) => {
    const t = await insertTransaction(client, {
      account_id: account_id || null, credit_card_id: credit_card_id || null,
      ledger, date, amount: Number(amount), description, category_id: category_id || null, purchase_class,
      is_mixed_use, mixed_use_business_pct, is_capex, is_transfer, entered_by,
      cleared: account_id ? !!cleared : true, owner, splits, needs_review, review_note,
      payee_id: req.body.payee_id || null, payee: req.body.payee || null,
      gst_amount: req.body.gst_amount ?? null,
      awaiting_statement: entered_by === 'manual' ? 'fed' : false,
    });
    if (link_bill_id) await linkBillToTransaction(client, Number(link_bill_id), t.id);
    if (link_loan_payment_id) await linkLoanPaymentToTransaction(client, Number(link_loan_payment_id), t.id);
    if (link_contract_id) await linkContractToTransaction(client, Number(link_contract_id), t.id);
    if (link_card_id) await linkCardPaymentToTransaction(client, Number(link_card_id), t.id);
    return t;
  });
  setImmediate(() => matchPending().catch(() => {}));
  autoLinkBillsSoon(); // a payment for a bill on file pays that bill
  res.status(201).json(row);
}));

// Reconciliation only — flips `cleared` to true once the bank actually
// shows the money moving (e.g. a check finally gets cashed). This never
// touches the account balance a second time: the balance already moved
// when the transaction was recorded, exactly as a real checkbook register
// works.
// What stops a transaction's money (date, amount, account) from being
// edited here, or null if nothing does. Categorizing — description,
// category, owner, splits, capex, the review flag — is always allowed.
async function moneyLock(client, tx) {
  const { rows } = await client.query(
    `SELECT 'bill "' || name || '"' AS what FROM bills WHERE linked_transaction_id = $1
     UNION ALL SELECT 'a scheduled loan payment' FROM loan_payments WHERE linked_transaction_id = $1
     UNION ALL SELECT 'contract (' || c.commodity || ')' FROM contract_payments cp JOIN sale_contracts c ON c.id = cp.contract_id
               WHERE cp.transaction_id = $1`,
    [tx.id]
  );
  if (rows.length) return `It's the payment for ${rows[0].what} — reverse it from there (unpay / unrecord / unsettle) so that item reopens, then re-enter it.`;
  if (tx.credit_card_id && tx.account_id) return 'It\'s a credit card payment — reverse it from the card\'s statement on the Credit Cards tab.';
  if (tx.transfer_peer_id) return 'It\'s one side of a paired transfer — delete it and re-enter both sides.';
  if (tx.source) return 'It came from a bank statement, so its date and amount are what the bank shows — delete it and re-send the statement if it was misread.';
  return null;
}

// Edit a transaction. Always editable: description, category, owner (or
// split pieces), capital purchase, transfer flag, review flag and note.
// Date, amount and account are editable only on a plain entry (see
// moneyLock); changing them moves the account balances to match.
router.patch('/:id', ah(async (req, res) => {
  const b = req.body || {};
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!rows.length) return { status: 404, body: { error: 'not found' } };
    const tx = rows[0];
    await assertOpen(client, tx.date, b.date);

    const newDate = b.date !== undefined ? b.date : toISODate(tx.date);
    const newAmount = b.amount !== undefined ? Number(b.amount) : Number(tx.amount);
    const newAccount = b.account_id !== undefined ? (b.account_id ? Number(b.account_id) : null) : tx.account_id;
    const moneyChanged = newDate !== toISODate(tx.date) || Math.abs(newAmount - Number(tx.amount)) > 0.001
      || newAccount !== tx.account_id;
    if (moneyChanged) {
      const lock = await moneyLock(client, tx);
      if (lock) return { status: 409, body: { error: `Date, amount and account can't be changed here. ${lock}` } };
      if (!newDate || !newAmount) return { status: 400, body: { error: 'date and a non-zero amount are required.' } };
      if (!tx.account_id && newAccount) return { status: 400, body: { error: 'A card purchase can’t be moved to an account — delete it and re-enter it.' } };
      if (tx.account_id && !newAccount) return { status: 400, body: { error: 'Pick an account.' } };
      if (newAccount && newAccount !== tx.account_id) {
        const { rows: a } = await client.query('SELECT 1 FROM accounts WHERE id = $1', [newAccount]);
        if (!a.length) return { status: 400, body: { error: `Account #${newAccount} doesn't exist.` } };
      }
    }
    if (b.is_transfer !== undefined && !!b.is_transfer !== tx.is_transfer && tx.credit_card_id && tx.account_id) {
      return { status: 409, body: { error: 'Whether a card payment counts as a transfer is set automatically from the card.' } };
    }

    // Owner: new fields if sent, else keep.
    const ownerSent = b.segment !== undefined || b.is_segment_split !== undefined;
    if (ownerSent) {
      const err = validateSegment(b);
      if (err) return { status: 400, body: { error: err } };
    }
    const owner = ownerSent ? ownerOf(b, {}) : ownerOf(tx);
    const ledger = b.ledger || (ownerSent ? ledgerForOwner(owner, tx.ledger) : tx.ledger);

    // Splits: replaced when sent ([] or null = not split any more). If the
    // amount changes on a split transaction, its pieces must be re-sent.
    let splits = null;
    if (b.splits !== undefined) {
      const pieces = Array.isArray(b.splits) ? b.splits : [];
      const n = normalizeSplits(pieces, newAmount, owner, ledger);
      if (n.error) return { status: 400, body: { error: n.error } };
      splits = n.splits;
    } else if (tx.is_split && Math.abs(newAmount - Number(tx.amount)) > 0.001) {
      return { status: 400, body: { error: 'This transaction is split — send its pieces again so they add up to the new amount.' } };
    }

    if (moneyChanged) {
      if (tx.account_id) await client.query('UPDATE accounts SET opening_balance = opening_balance - $1 WHERE id = $2', [tx.amount, tx.account_id]);
      if (newAccount) await client.query('UPDATE accounts SET opening_balance = opening_balance + $1 WHERE id = $2', [newAmount, newAccount]);
    }
    let needsReview = b.needs_review !== undefined ? !!b.needs_review : tx.needs_review;
    const gst = b.gst_amount !== undefined ? cleanGst(b.gst_amount, newAmount) : (tx.gst_amount == null ? null : cleanGst(tx.gst_amount, newAmount));
    let payee = tx.payee_id;
    if (b.payee_id !== undefined) payee = b.payee_id ? Number(b.payee_id) : null;
    else if (b.payee) payee = await payeeId(client, b.payee);
    // Money in must carry an income category before its flag can clear.
    const finalCategory = b.category_id !== undefined ? (b.category_id ? Number(b.category_id) : null) : tx.category_id;
    const finalTransfer = b.is_transfer !== undefined ? !!b.is_transfer : tx.is_transfer;
    const finalSplit = splits !== null ? splits.length > 0 : tx.is_split;
    const uncategorizedIncome = newAmount > 0 && !finalTransfer && !finalSplit && !finalCategory && !tx.is_debt_service
      && !b.transfer_account_id && !b.link_contract_id; // a contract supplies its own income category
    if (uncategorizedIncome && b.needs_review === false) {
      return { status: 400, body: { error: 'This is money in — pick an income category (e.g. Grain sales › Canola sales) before clearing it.' } };
    }
    if (uncategorizedIncome) needsReview = true;
    const { rows: up } = await client.query(
      `UPDATE transactions SET
         date = $1, amount = $2, account_id = $3, description = $4, category_id = $5, ledger = $6,
         is_capex = $7, is_transfer = $8, needs_review = $9, review_note = $10,
         cleared_date = CASE WHEN cleared THEN $1::date ELSE cleared_date END,
         is_split = $11,
         ${SEGMENT_COLUMNS.map((c, i) => `${c} = $${12 + i}`).join(', ')},
         payee_id = $${13 + SEGMENT_COLUMNS.length},
         gst_amount = $${14 + SEGMENT_COLUMNS.length}
       WHERE id = $${12 + SEGMENT_COLUMNS.length} RETURNING *`,
      [newDate, newAmount, newAccount,
       b.description !== undefined ? b.description : tx.description,
       b.category_id !== undefined ? (b.category_id ? Number(b.category_id) : null) : tx.category_id,
       ledger,
       b.is_capex !== undefined ? !!b.is_capex : tx.is_capex,
       b.is_transfer !== undefined ? !!b.is_transfer : tx.is_transfer,
       needsReview,
       needsReview ? ((b.review_note !== undefined ? b.review_note : tx.review_note) || (uncategorizedIncome ? UNCATEGORIZED_INCOME : null)) : null,
       splits !== null ? splits.length > 0 : tx.is_split,
       ...SEGMENT_COLUMNS.map((c) => owner[c]), tx.id, payee, gst]
    );
    if (splits !== null) {
      await client.query('DELETE FROM transaction_splits WHERE transaction_id = $1', [tx.id]);
      for (const s of splits) {
        await client.query(
          `INSERT INTO transaction_splits (transaction_id, amount, category_id, memo, ledger, is_capex, is_transfer, ${SEGMENT_COLUMNS.join(', ')})
           VALUES ($1,$2,$3,$4,$5,$6,$7,${SEGMENT_COLUMNS.map((_, i) => `$${8 + i}`).join(',')})`,
          [tx.id, s.amount, s.category_id, s.memo, s.ledger, s.is_capex, !!s.is_transfer, ...SEGMENT_COLUMNS.map((c) => s.owner[c])]
        );
      }
    }

    if (b.link_bill_id) await linkBillToTransaction(client, Number(b.link_bill_id), tx.id);
    if (b.link_loan_payment_id) await linkLoanPaymentToTransaction(client, Number(b.link_loan_payment_id), tx.id);
    if (b.link_contract_id) await linkContractToTransaction(client, Number(b.link_contract_id), tx.id);
    if (b.link_card_id) await linkCardPaymentToTransaction(client, Number(b.link_card_id), tx.id);

    // Pointing a one-sided transfer at the other account records the
    // matching side there and links the two.
    if (b.transfer_account_id) {
      const t = up[0];
      if (!t.is_transfer || !t.account_id) return { status: 400, body: { error: 'Only a transfer out of or into an account can be paired with another account.' } };
      if (tx.transfer_peer_id) return { status: 409, body: { error: 'This transfer already has its other side recorded.' } };
      if (Number(b.transfer_account_id) === Number(t.account_id)) return { status: 400, body: { error: 'Pick two different accounts.' } };
      const { rows: acc } = await client.query('SELECT * FROM accounts WHERE id = ANY($1::int[])', [[t.account_id, Number(b.transfer_account_id)]]);
      const here = acc.find((a) => a.id === t.account_id);
      const other = acc.find((a) => a.id === Number(b.transfer_account_id));
      if (!other) return { status: 400, body: { error: 'account not found' } };
      const amt = Number(t.amount);
      const o = ownerOf({}, other);
      const peer = await insertTransaction(client, {
        account_id: other.id, credit_card_id: null, ledger: ledgerForOwner(o, other.ledger || 'business'),
        date: toISODate(t.date), amount: -amt, category_id: null, purchase_class: null,
        description: `Transfer ${amt < 0 ? 'from' : 'to'} ${here.name}${t.description ? ` — ${t.description}` : ''}`,
        is_mixed_use: false, mixed_use_business_pct: null, is_capex: false, is_transfer: true, entered_by: 'manual',
        cleared: true, owner: o, splits: [], needs_review: false, review_note: null,
      });
      await client.query('UPDATE transactions SET transfer_peer_id = $1 WHERE id = $2', [peer.id, t.id]);
      await client.query('UPDATE transactions SET transfer_peer_id = $1 WHERE id = $2', [t.id, peer.id]);
      up[0].transfer_peer_id = peer.id;
    }
    return { status: 200, body: up[0] };
  });
  if (result.status < 300) await resettle(await creditVendors(req.params.id)); // a payment on account changed
  res.status(result.status).json(result.body);
}));

router.post('/:id/clear', ah(async (req, res) => {
  const { cleared_date = new Date().toISOString().slice(0, 10) } = req.body;
  await assertOpen(pool, cleared_date);
  const { rows } = await pool.query(
    `UPDATE transactions SET cleared = true, cleared_date = $1 WHERE id = $2 RETURNING *`,
    [cleared_date, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

router.post('/:id/unclear', ah(async (req, res) => {
  const { rows: cur } = await pool.query('SELECT cleared_date FROM transactions WHERE id = $1', [req.params.id]);
  if (cur[0]?.cleared_date) await assertOpen(pool, cur[0].cleared_date);
  const { rows } = await pool.query(
    `UPDATE transactions SET cleared = false, cleared_date = NULL WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
}));

// Deleting a transaction reverses its effect on the account balance. A
// bill/loan/contract payment must be reversed from its own tab (so the
// item reopens); a statement line that produced it returns to the review
// queue.
// Deleting one side of a hand-entered transfer deletes the other side too,
// so neither account is left with half a move. (Sides that came from bank
// statements are left alone — each belongs to its own statement.)
router.delete('/:id', ah(async (req, res) => {
  const vendors = await creditVendors(req.params.id);
  const tx = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT transfer_peer_id, source FROM transactions WHERE id = $1', [req.params.id]);
    const peerId = rows[0]?.transfer_peer_id;
    const removed = await removeTransaction(client, req.params.id);
    if (removed && peerId && !rows[0].source) {
      const { rows: peer } = await client.query('SELECT source FROM transactions WHERE id = $1', [peerId]);
      if (peer.length && !peer[0].source) await removeTransaction(client, peerId);
    }
    return removed;
  });
  if (!tx) return res.status(404).json({ error: 'not found' });
  await resettle(vendors); // what it paid goes back to owing
  res.status(204).end();
}));

export default router;
