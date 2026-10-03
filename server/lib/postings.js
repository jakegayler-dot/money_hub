// Every action that moves money goes through here — the UI's pay/record/
// settle buttons and agent statement ingest alike — so a bill paid by
// clicking "Pay" and a bill paid by matching a bank statement line produce
// exactly the same records. All functions take a DB client already inside
// a transaction (withTransaction) and never commit on their own.

import { SEGMENT_COLUMNS, segmentValues, validateSegment, ledgerForSegment } from './segments.js';
import { toISODate, addMonths } from './dates.js';

const SEG_COLS = SEGMENT_COLUMNS.join(', ');
const round2 = (n) => Math.round(Number(n) * 100) / 100;

import { assertOpen, assertNoClosedFrom, closedMonth } from './periods.js';

export class PostingError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

export const UNCATEGORIZED_INCOME = 'Income with no category — pick one.';

/**
 * GST included in an amount, as a positive number, or null. Refused when
 * it couldn't be part of the amount (more than the whole thing).
 */
export function cleanGst(gst, amount) {
  if (gst === undefined || gst === null || gst === '') return null;
  const g = Math.abs(round2(gst));
  if (Number.isNaN(g)) throw new PostingError('GST must be a number.', 400);
  if (g === 0) return 0;
  if (g > Math.abs(round2(amount))) throw new PostingError(`GST of ${g} is more than the whole amount.`, 400);
  return g;
}

/** The payee/buyer id for a name, creating it the first time it's seen. */
export async function payeeId(client, name) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const { rows } = await client.query(
    `INSERT INTO payees (name) VALUES ($1)
     ON CONFLICT ((lower(name))) DO UPDATE SET name = payees.name
     RETURNING id`,
    [clean]
  );
  return rows[0].id;
}

/** Owner fields as an object keyed by SEGMENT_COLUMNS: src's own if it has any, else fallback's. */
export function ownerOf(src, fallback = {}) {
  const has = src && (src.is_segment_split || src.segment);
  const vals = segmentValues(has ? src : fallback);
  return Object.fromEntries(SEGMENT_COLUMNS.map((c, i) => [c, vals[i]]));
}

/** Business vs personal ledger implied by an owner tag; `fallback` when a split straddles both. */
export function ledgerForOwner(owner, fallback = 'business') {
  if (!owner.is_segment_split) return owner.segment ? ledgerForSegment(owner.segment) : fallback;
  const biz = (Number(owner.segment_grain_pct) || 0) + (Number(owner.segment_livestock_pct) || 0);
  if (biz >= 99.5) return 'business';
  if (biz <= 0.5) return 'personal';
  return fallback;
}

/**
 * Validates and normalizes split pieces against a parent amount. Each piece:
 * { amount, category_id?, memo?, is_capex?, ledger?, segment | is_segment_split + pcts }.
 * Missing owner → parent's owner; missing ledger → implied by the owner.
 * Returns { splits, error }.
 */
export function normalizeSplits(pieces, parentAmount, parentOwner, parentLedger) {
  if (!Array.isArray(pieces) || pieces.length === 0) return { splits: [], error: null };
  if (pieces.length === 1) return { splits: [], error: 'A split needs at least two pieces.' };
  const splits = [];
  for (const [i, p] of pieces.entries()) {
    const amount = Number(p.amount);
    if (!Number.isFinite(amount) || amount === 0) return { splits: [], error: `Split piece ${i + 1} has no amount.` };
    const segErr = validateSegment(p);
    if (segErr) return { splits: [], error: `Split piece ${i + 1}: ${segErr}` };
    const owner = ownerOf(p, parentOwner);
    splits.push({
      amount: round2(amount),
      category_id: p.category_id || null,
      memo: p.memo || p.description || null,
      is_capex: !!p.is_capex,
      ledger: p.ledger || ledgerForOwner(owner, parentLedger),
      owner,
    });
  }
  const sum = round2(splits.reduce((s, x) => s + x.amount, 0));
  if (Math.abs(sum - round2(parentAmount)) > 0.005) {
    return { splits: [], error: `Split pieces add up to ${sum.toFixed(2)}, but the line is ${round2(parentAmount).toFixed(2)}.` };
  }
  return { splits, error: null };
}

/**
 * Inserts one transaction (and its split pieces) and moves the account
 * balance if it came out of / into an account. A card-only purchase
 * (account_id null) moves no account — it raises the card's ledger balance.
 */
export async function insertTransaction(client, t) {
  await assertOpen(client, t.date);
  const owner = t.owner || ownerOf(t);
  const splits = t.splits || [];
  const cleared = t.cleared !== false;
  // Money in with no category can't be analysed — it waits on Review.
  const uncategorizedIncome = round2(t.amount) > 0 && !t.is_transfer && !splits.length && !t.category_id && !t.is_debt_service;
  const needsReview = !!t.needs_review || uncategorizedIncome;
  const reviewNote = t.needs_review ? (t.review_note || null) : (uncategorizedIncome ? UNCATEGORIZED_INCOME : null);
  const payee = t.payee_id || (t.payee ? await payeeId(client, t.payee) : null);
  const gst = cleanGst(t.gst_amount, t.amount);
  // 'fed': only if this account (or, for a card purchase, the card) gets
  // statements — otherwise nothing will ever confirm it.
  let awaiting = !t.source && !!t.awaiting_statement;
  if (awaiting && t.awaiting_statement === 'fed') {
    const { rows: feed } = await client.query(
      `SELECT 1 FROM statement_imports WHERE ${t.account_id ? 'account_id = $1' : 'credit_card_id = $1'} LIMIT 1`,
      [t.account_id || t.credit_card_id]);
    awaiting = feed.length > 0;
  }
  const { rows } = await client.query(
    `INSERT INTO transactions
      (account_id, credit_card_id, credit_card_statement_id, ledger, date, amount, description, category_id,
       purchase_class, is_mixed_use, mixed_use_business_pct, is_capex, is_debt_service, is_transfer, is_split,
       entered_by, cleared, cleared_date, source, external_id, needs_review, review_note, payee_id, gst_amount, awaiting_statement, ${SEG_COLS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
             ${SEGMENT_COLUMNS.map((_, i) => `$${26 + i}`).join(',')})
     RETURNING *`,
    [t.account_id || null, t.credit_card_id || null, t.credit_card_statement_id || null,
     t.ledger || ledgerForOwner(owner), t.date, round2(t.amount), t.description || null, t.category_id || null,
     t.purchase_class || null, !!t.is_mixed_use, t.mixed_use_business_pct ?? null,
     !!t.is_capex, !!t.is_debt_service, !!t.is_transfer, splits.length > 0,
     t.entered_by || 'manual', cleared, cleared ? t.date : null, t.source || null, t.external_id || null,
     needsReview, reviewNote, payee, gst, awaiting,
     ...SEGMENT_COLUMNS.map((c) => owner[c])]
  );
  const tx = rows[0];
  for (const s of splits) {
    await client.query(
      `INSERT INTO transaction_splits (transaction_id, amount, category_id, memo, ledger, is_capex, is_transfer, ${SEG_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,${SEGMENT_COLUMNS.map((_, i) => `$${8 + i}`).join(',')})`,
      [tx.id, s.amount, s.category_id, s.memo, s.ledger, s.is_capex, !!s.is_transfer, ...SEGMENT_COLUMNS.map((c) => s.owner[c])]
    );
  }
  if (tx.account_id) {
    await client.query('UPDATE accounts SET opening_balance = opening_balance + $1 WHERE id = $2', [tx.amount, tx.account_id]);
  }
  return tx;
}

/**
 * Deletes a transaction and undoes its effect on the account balance.
 * Refuses (409) if a bill, loan payment or contract points at it — those
 * have their own unpay/unrecord/unsettle, which also reopen the item.
 * A card payment is unlinked from its statement, which is then recomputed.
 * Statement lines that produced it go back to the review queue.
 */
export async function removeTransaction(client, txId) {
  const { rows } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
  if (!rows.length) return null;
  const tx = rows[0];
  await assertOpen(client, tx.date, tx.cleared_date);

  const { rows: blockers } = await client.query(
    `SELECT 'bill' AS kind, name AS label FROM bills WHERE linked_transaction_id = $1
     UNION ALL SELECT 'loan payment', due_date::text FROM loan_payments WHERE linked_transaction_id = $1
     UNION ALL SELECT 'contract', commodity FROM sale_contracts WHERE linked_transaction_id = $1`,
    [txId]
  );
  if (blockers.length) {
    const b = blockers[0];
    throw new PostingError(`This transaction is the payment for a ${b.kind} (${b.label}). Reverse it from there (unpay / unrecord / unsettle) so the ${b.kind} reopens too.`);
  }

  const { rows: stmts } = await client.query(
    `SELECT DISTINCT id FROM credit_card_statements WHERE linked_transaction_id = $1 OR id = $2`,
    [txId, tx.credit_card_statement_id]
  );
  // FK references must be cleared before the row they point at is deleted.
  await client.query('UPDATE credit_card_statements SET linked_transaction_id = NULL WHERE linked_transaction_id = $1', [txId]);
  await client.query(
    `UPDATE statement_lines SET status = 'held', transaction_id = NULL, resolved_at = NULL,
       reason = 'The transaction this line created or matched was deleted. Approve to post it again, or reject it.'
     WHERE transaction_id = $1`,
    [txId]
  );
  // Its receipt goes back to waiting (an invoice back to its unpaid bill).
  await client.query(
    `UPDATE receipts SET transaction_id = NULL, matched_at = NULL,
       status = CASE WHEN bill_id IS NOT NULL THEN 'billed' ELSE 'unmatched' END
     WHERE transaction_id = $1`,
    [txId]
  );
  if (tx.account_id) {
    await client.query('UPDATE accounts SET opening_balance = opening_balance - $1 WHERE id = $2', [tx.amount, tx.account_id]);
  }
  await client.query('DELETE FROM transactions WHERE id = $1', [txId]);
  for (const s of stmts) await recomputeCardStatement(client, s.id);
  if (tx.credit_card_id && tx.account_id) await reclassifyCardPayments(client, tx.credit_card_id);
  return tx;
}

/** "Canola" / "CWRS wheat" -> the matching "... sales" income category, if there is one. */
export async function incomeCategoryFor(client, commodity) {
  if (!commodity) return null;
  const { rows } = await client.query(
    `SELECT id FROM expense_categories
     WHERE kind = 'income' AND parent_id IS NOT NULL
       AND $1 ILIKE '%' || regexp_replace(lower(name), ' *sales$', '') || '%'
     ORDER BY length(name) DESC LIMIT 1`,
    [commodity]
  );
  return rows[0]?.id || null;
}

/**
 * The shared category for a bill's text category ("Utilities", "Fuel:
 * Diesel"), created if there isn't one — so bills sent in by an agent with
 * a typed category land on the same list the ledger uses. Same rule as the
 * migration in schema.sql.
 */
export async function expenseCategoryFor(client, text) {
  const cat = String(text || '').trim();
  if (!cat) return null;
  const find = async (name, parent) => (await client.query(
    `SELECT id FROM expense_categories WHERE kind = 'expense' AND lower(name) = lower($1)
       AND ($2::int IS NULL OR parent_id = $2) ORDER BY parent_id NULLS FIRST, id LIMIT 1`, [name, parent])).rows[0]?.id || null;
  const make = async (name, parent) => (await client.query(
    `INSERT INTO expense_categories (name, class, ledger, kind, parent_id) VALUES ($1, 'variable_seasonal', 'business', 'expense', $2) RETURNING id`,
    [name, parent])).rows[0].id;
  const exact = await find(cat, null);
  if (exact) return exact;
  const m = cat.match(/^(.*?)\s*(?:›|:| - | — | – )\s*(.*)$/);
  if (!m || !m[1] || !m[2]) return make(cat, null);
  const { rows: [top] } = await client.query(
    `SELECT id FROM expense_categories WHERE kind = 'expense' AND parent_id IS NULL AND lower(name) = lower($1) ORDER BY id LIMIT 1`, [m[1]]);
  const parent = top?.id || await make(m[1], null);
  return (await find(m[2], parent)) || make(m[2], parent);
}

async function categoryIdByName(client, name) {
  if (!name) return null;
  const { rows } = await client.query('SELECT id FROM expense_categories WHERE lower(name) = lower($1) LIMIT 1', [name]);
  return rows[0]?.id || null;
}

/**
 * Pays a bill from an account, or charges it to a card (credit_card_id) —
 * e.g. a utility on autopay to a card. `amount` overrides the bill amount
 * when the real charge differed. Recurring bills roll forward to the next
 * cycle in the same DB transaction.
 */
export async function payBill(client, billId, {
  account_id = null, credit_card_id = null, date, amount = null, paid_by_check = false,
  source = null, external_id = null, entered_by = 'manual',
}) {
  const { rows } = await client.query('SELECT * FROM bills WHERE id = $1 FOR UPDATE', [billId]);
  if (!rows.length) return null;
  const bill = rows[0];
  if (bill.status === 'paid') return { bill, alreadyPaid: true, transaction: null, nextBill: null };

  const paid = Math.abs(Number(amount ?? bill.amount));
  let tx = null;
  if (account_id || credit_card_id) {
    tx = await insertTransaction(client, {
      account_id, credit_card_id, ledger: bill.ledger, date, amount: -paid,
      description: `Bill paid: ${bill.name}${paid_by_check ? ' (check)' : ''}`,
      category_id: bill.category_id || await categoryIdByName(client, bill.category), payee: bill.name,
      // The bill is the invoice, so its GST is exact; scaled if a different amount was paid.
      gst_amount: bill.has_gst && Number(bill.amount) ? round2(Number(bill.gst_amount) * paid / Number(bill.amount)) : null,
      owner: ownerOf(bill), cleared: !paid_by_check, source, external_id, entered_by, awaiting_statement: true,
    });
  }
  await client.query(
    `UPDATE bills SET status = 'paid', paid_date = $1, linked_transaction_id = $2 WHERE id = $3`,
    [date, tx ? tx.id : null, bill.id]
  );
  const nextBill = await rollBillForward(client, bill);
  return { bill: { ...bill, status: 'paid', paid_date: date, linked_transaction_id: tx?.id ?? null }, transaction: tx, nextBill };
}

/** Recurring bills: paying one cycle creates the next. */
async function rollBillForward(client, bill) {
  let nextBill = null;
  if (bill.frequency === 'monthly' || bill.frequency === 'quarterly') {
    const nextDue = addMonths(toISODate(bill.due_date), bill.frequency === 'monthly' ? 1 : 3);
    const { rows: next } = await client.query(
      `INSERT INTO bills
        (name, ledger, category, amount, frequency, due_date, status, notes, has_gst, gst_pct, gst_amount, subtotal_amount, category_id, ${SEG_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,'unpaid',$7,$8,$9,$10,$11,$12,${SEGMENT_COLUMNS.map((_, i) => `$${13 + i}`).join(',')}) RETURNING *`,
      [bill.name, bill.ledger, bill.category, bill.amount, bill.frequency, nextDue, bill.notes,
       bill.has_gst, bill.gst_pct, bill.gst_amount, bill.subtotal_amount, bill.category_id || null, ...segmentValues(bill)]
    );
    nextBill = next[0];
  }
  return nextBill;
}

/** What a transaction already pays, or null. */
async function existingLink(client, txId) {
  const { rows } = await client.query(
    `SELECT 'bill "' || name || '"' AS what FROM bills WHERE linked_transaction_id = $1
     UNION ALL SELECT 'a loan payment' FROM loan_payments WHERE linked_transaction_id = $1
     UNION ALL SELECT 'contract (' || commodity || ')' FROM sale_contracts WHERE linked_transaction_id = $1
     UNION ALL SELECT 'a card payment' FROM transactions WHERE id = $1 AND credit_card_id IS NOT NULL AND account_id IS NOT NULL`,
    [txId]
  );
  return rows[0]?.what || null;
}

async function linkableTx(client, txId, direction = 'out') {
  const { rows } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
  const tx = rows[0];
  if (!tx) throw new PostingError('Transaction not found.');
  await assertOpen(client, tx.date);
  if (direction === 'out' && Number(tx.amount) >= 0) throw new PostingError('Only money going out can pay a bill or loan.');
  if (direction === 'in' && Number(tx.amount) <= 0) throw new PostingError('Only money coming in can settle a contract.');
  if (tx.is_transfer) throw new PostingError('This is marked as a transfer — untick Transfer first.');
  const already = await existingLink(client, tx.id);
  if (already) throw new PostingError(`This transaction is already the payment for ${already}.`);
  return tx;
}

/**
 * Marks a bill paid BY a transaction already in the ledger — no new money
 * movement. The bill's category fills in if the transaction has none.
 */
export async function linkBillToTransaction(client, billId, txId) {
  const tx = await linkableTx(client, txId);
  const { rows } = await client.query('SELECT * FROM bills WHERE id = $1 FOR UPDATE', [billId]);
  const bill = rows[0];
  if (!bill) throw new PostingError('Bill not found.');
  if (bill.status === 'paid') throw new PostingError(`"${bill.name}" is already marked paid.`);
  await client.query(
    `UPDATE bills SET status = 'paid', paid_date = $1, linked_transaction_id = $2, linked_existing = true WHERE id = $3`,
    [tx.date, tx.id, bill.id]
  );
  if (!tx.category_id && !tx.is_split) {
    const cat = bill.category_id || await categoryIdByName(client, bill.category);
    if (cat) await client.query('UPDATE transactions SET category_id = $1 WHERE id = $2', [cat, tx.id]);
  }
  if (!tx.payee_id) await client.query('UPDATE transactions SET payee_id = $1 WHERE id = $2', [await payeeId(client, bill.name), tx.id]);
  if (bill.has_gst && tx.gst_amount == null && Number(bill.amount)) {
    const g = round2(Number(bill.gst_amount) * Math.abs(Number(tx.amount)) / Number(bill.amount));
    await client.query('UPDATE transactions SET gst_amount = $1 WHERE id = $2', [g, tx.id]);
  }
  const nextBill = await rollBillForward(client, bill);
  return { bill, nextBill };
}

/**
 * Settles a sale contract WITH a deposit already in the ledger — no new
 * money movement. Fills the income category from the commodity ("Canola"
 * → Canola sales) and the buyer as payee when the deposit has neither.
 */
export async function linkContractToTransaction(client, contractId, txId) {
  const tx = await linkableTx(client, txId, 'in');
  if (!tx.account_id) throw new PostingError('A contract payment lands in a bank account.');
  const { rows } = await client.query('SELECT * FROM sale_contracts WHERE id = $1 FOR UPDATE', [contractId]);
  const c = rows[0];
  if (!c) throw new PostingError('Contract not found.');
  if (c.status === 'settled') throw new PostingError(`That ${c.commodity} contract is already settled.`);
  if (c.status === 'cancelled') throw new PostingError(`That ${c.commodity} contract is cancelled.`);
  await client.query(
    `UPDATE sale_contracts SET status = 'settled', linked_transaction_id = $1, linked_existing = true WHERE id = $2`,
    [tx.id, c.id]
  );
  const cat = !tx.category_id && !tx.is_split ? await incomeCategoryFor(client, c.commodity) : null;
  const payee = !tx.payee_id && c.counterparty ? await payeeId(client, c.counterparty) : null;
  await client.query(
    `UPDATE transactions SET
       category_id = COALESCE(category_id, $1),
       payee_id = COALESCE(payee_id, $2),
       needs_review = CASE WHEN $1::int IS NOT NULL AND review_note = $4 THEN false ELSE needs_review END,
       review_note = CASE WHEN $1::int IS NOT NULL AND review_note = $4 THEN NULL ELSE review_note END
     WHERE id = $3`,
    [cat, payee, tx.id, UNCATEGORIZED_INCOME]
  );
  return { contract: c };
}

/** Marks a scheduled loan payment made BY a transaction already in the ledger. */
export async function linkLoanPaymentToTransaction(client, paymentId, txId) {
  const tx = await linkableTx(client, txId);
  if (!tx.account_id) throw new PostingError('A loan payment comes out of a bank account, not a card.');
  const { rows } = await client.query('SELECT * FROM loan_payments WHERE id = $1 FOR UPDATE', [paymentId]);
  const payment = rows[0];
  if (!payment || payment.is_adjustment) throw new PostingError('Loan payment not found.');
  if (payment.paid) throw new PostingError('That loan payment is already recorded.');
  await client.query(
    `UPDATE loan_payments SET paid = true, paid_date = $1, linked_transaction_id = $2, linked_existing = true WHERE id = $3`,
    [tx.date, tx.id, payment.id]
  );
  await client.query('UPDATE transactions SET is_debt_service = true WHERE id = $1', [tx.id]);
  if (!tx.payee_id) {
    const { rows: l } = await client.query('SELECT COALESCE(lender, name) AS who FROM loans WHERE id = $1', [payment.loan_id]);
    if (l[0]?.who) await client.query('UPDATE transactions SET payee_id = $1 WHERE id = $2', [await payeeId(client, l[0].who), tx.id]);
  }
  return { payment };
}

/**
 * Records a scheduled loan payment as made. Flagged is_debt_service so
 * NOI/coverage don't double-count it. `amount` overrides the scheduled
 * total when the lender actually took a slightly different amount.
 */
export async function recordLoanPayment(client, paymentId, {
  account_id, date, amount = null, paid_by_check = false, source = null, external_id = null, entered_by = 'manual',
}) {
  const { rows } = await client.query(
    `SELECT lp.*, l.name AS loan_name, l.lender, l.segment FROM loan_payments lp
     JOIN loans l ON l.id = lp.loan_id WHERE lp.id = $1 FOR UPDATE OF lp`,
    [paymentId]
  );
  if (!rows.length) return null;
  const payment = rows[0];
  if (payment.paid || payment.is_adjustment) return { payment, alreadyPaid: true, transaction: null };

  const total = Math.abs(Number(amount ?? (Number(payment.principal_amount) + Number(payment.interest_amount))));
  const tx = await insertTransaction(client, {
    account_id, ledger: ledgerForSegment(payment.segment), date, amount: -total,
    description: `Loan payment: ${payment.loan_name || payment.lender}${paid_by_check ? ' (check)' : ''}`,
    is_debt_service: true, owner: ownerOf({ segment: payment.segment }), payee: payment.lender || payment.loan_name,
    cleared: !paid_by_check, source, external_id, entered_by, awaiting_statement: true,
  });
  const { rows: updated } = await client.query(
    `UPDATE loan_payments SET paid = true, paid_date = $1, linked_transaction_id = $2 WHERE id = $3 RETURNING *`,
    [date, tx.id, payment.id]
  );
  return { payment: updated[0], transaction: tx };
}

/** Settles a sale contract: money in, contract closed. `amount` = what actually arrived. */
export async function settleContract(client, contractId, {
  account_id, date, amount = null, source = null, external_id = null, entered_by = 'manual',
}) {
  const { rows } = await client.query('SELECT * FROM sale_contracts WHERE id = $1 FOR UPDATE', [contractId]);
  if (!rows.length) return null;
  const contract = rows[0];
  if (contract.status === 'settled') return { contract, alreadyPaid: true, transaction: null };

  const received = Math.abs(Number(amount ?? contract.total_value));
  const tx = await insertTransaction(client, {
    account_id, ledger: ledgerForSegment(contract.segment), date, amount: received,
    description: `Contract settled: ${contract.commodity}${contract.counterparty ? ` — ${contract.counterparty}` : ''}`,
    owner: ownerOf({ segment: contract.segment }), source, external_id, entered_by, awaiting_statement: true,
    category_id: await incomeCategoryFor(client, contract.commodity), payee: contract.counterparty,
  });
  const { rows: updated } = await client.query(
    `UPDATE sale_contracts SET status = 'settled', linked_transaction_id = $1 WHERE id = $2 RETURNING *`,
    [tx.id, contract.id]
  );
  return { contract: updated[0], transaction: tx };
}

/**
 * Re-derives a statement's paid status from the payments linked to it —
 * the single source of truth, so partial payments add up and deleting a
 * payment reopens the statement automatically.
 */
export async function recomputeCardStatement(client, statementId) {
  if (!statementId) return null;
  const { rows: sRows } = await client.query('SELECT * FROM credit_card_statements WHERE id = $1', [statementId]);
  if (!sRows.length) return null;
  const s = sRows[0];
  const { rows: [agg] } = await client.query(
    `SELECT COALESCE(SUM(-amount), 0) AS paid, MAX(date) AS last_date,
            (array_agg(id ORDER BY date DESC, id DESC))[1] AS last_id,
            (array_agg(account_id ORDER BY date DESC, id DESC))[1] AS last_account
     FROM transactions WHERE credit_card_statement_id = $1 AND account_id IS NOT NULL`,
    [statementId]
  );
  const paidAmt = round2(agg.paid);
  const isPaid = paidAmt > 0 && paidAmt >= Number(s.statement_balance) - 0.005;
  const lastDate = agg.last_date ? toISODate(agg.last_date) : null;
  const { rows } = await client.query(
    `UPDATE credit_card_statements SET
       paid = $1, paid_amount = $2, paid_date = $3, paid_in_full = $4,
       account_id = COALESCE($5, account_id), linked_transaction_id = $6
     WHERE id = $7 RETURNING *`,
    [isPaid, paidAmt > 0 ? paidAmt : null, isPaid ? lastDate : null,
     isPaid ? lastDate <= toISODate(s.due_date) : null,
     agg.last_account, agg.last_id, statementId]
  );
  return rows[0];
}

/**
 * Pays down a card from an account. Applies to `statement_id` if given,
 * else to the card's latest statement closed on or before the payment
 * date (statements are cumulative — the latest one is what's due). With no
 * statement on file yet it still lowers the card balance; a statement
 * logged later picks it up. Whether it counts as expense or transfer is
 * decided by reclassifyCardPayments.
 */
export async function payCard(client, cardId, {
  account_id, date, amount, statement_id = null, paid_by_check = false,
  source = null, external_id = null, entered_by = 'manual',
}) {
  const { rows: cRows } = await client.query('SELECT * FROM credit_cards WHERE id = $1', [cardId]);
  if (!cRows.length) return null;
  const card = cRows[0];
  const pay = Math.abs(Number(amount));
  if (!pay) throw new PostingError('Payment amount is required.', 400);

  const stmtId = statement_id || await openStatementFor(client, cardId, date);

  const tx = await insertTransaction(client, {
    account_id, credit_card_id: card.id, credit_card_statement_id: stmtId,
    ledger: ledgerForSegment(card.segment), date, amount: -pay,
    description: `Credit card payment: ${card.name}${paid_by_check ? ' (check)' : ''}`,
    owner: ownerOf({ segment: card.segment }),
    cleared: !paid_by_check, source, external_id, entered_by, awaiting_statement: true,
  });
  await reclassifyCardPayments(client, card.id);
  await pairCardPayments(client, card.id); // its card-side line may already be on file
  const statement = stmtId ? await recomputeCardStatement(client, stmtId) : null;
  return { transaction: tx, statement };
}


/**
 * One payment, two statements: the bank shows it going out ("Online
 * banking payment — Capital One") and the card shows it arriving
 * ("PAYMENT — THANK YOU"). The bank side is THE payment; the card side
 * only confirms it. A card-side line that got posted as its own entry
 * (money in on the card, no bank account) is folded into the bank-side
 * payment of the same amount within ~10 days: its statement line is
 * re-pointed there and the duplicate is removed, so what the card owes
 * drops once, not twice. Card-side payments with no bank side on file
 * (paid from an account Money Hub doesn't track, or that statement isn't
 * in yet) stay, and are folded in whenever the bank side arrives.
 */
export async function pairCardPayments(client, cardId) {
  const { rows: sides } = await client.query(
    `SELECT * FROM transactions
     WHERE credit_card_id = $1 AND account_id IS NULL AND amount > 0 AND NOT is_split
       AND (is_transfer OR description ~* '(^|[^a-z])(payment|paiement|pymt|pmt)([^a-z]|$)')
     ORDER BY date, id`, [cardId]);
  let merged = 0;
  for (const s of sides) {
    const { rows: [bank] } = await client.query(
      `SELECT t.* FROM transactions t
       WHERE t.credit_card_id = $1 AND t.account_id IS NOT NULL AND abs(t.amount + $2) < 0.005
         AND t.date BETWEEN $3::date - 10 AND $3::date + 3
         AND NOT EXISTS (SELECT 1 FROM statement_lines sl WHERE sl.transaction_id = t.id AND sl.credit_card_id IS NOT NULL)
       ORDER BY abs(t.date - $3::date), t.id LIMIT 1`,
      [cardId, s.amount, s.date]);
    if (!bank) continue;
    if (await closedMonth(client, s.date)) continue; // a closed month stays as it was closed
    await client.query(
      `UPDATE statement_lines SET transaction_id = $1, status = 'matched',
         reason = 'Payment received on the card — the payment itself is recorded from the bank side'
       WHERE transaction_id = $2`, [bank.id, s.id]);
    await client.query('UPDATE receipts SET transaction_id = $1 WHERE transaction_id = $2', [bank.id, s.id]);
    await client.query('UPDATE transactions SET awaiting_statement = false WHERE id = $1', [bank.id]);
    await removeTransaction(client, s.id);
    merged++;
  }
  if (merged) await reclassifyCardPayments(client, cardId);
  return merged;
}

/** pairCardPayments for every card. */
export async function pairAllCardPayments(client) {
  const { rows } = await client.query('SELECT id FROM credit_cards');
  let n = 0;
  for (const c of rows) n += await pairCardPayments(client, c.id);
  return n;
}

/** The card's latest statement on or before `date`, if that cycle is still unpaid. */
async function openStatementFor(client, cardId, date) {
  const { rows } = await client.query(
    `SELECT id, paid FROM credit_card_statements
     WHERE credit_card_id = $1 AND COALESCE(statement_date, due_date) <= $2
     ORDER BY COALESCE(statement_date, due_date) DESC, id DESC LIMIT 1`,
    [cardId, date]
  );
  return rows.length && !rows[0].paid ? rows[0].id : null;
}

/**
 * Makes a payment already in the ledger (money out of a bank account —
 * e.g. "Online banking payment — Capital One" posted as plain spending)
 * the payment ON a card: it lowers what the card owes and pays its
 * statement, and stops counting as spending wherever the card's purchases
 * are itemized (reclassifyCardPayments decides). No new money moves.
 */
export async function linkCardPaymentToTransaction(client, cardId, txId) {
  const tx = await linkableTx(client, txId);
  if (!tx.account_id || tx.credit_card_id) throw new PostingError('A card payment comes out of a bank account.');
  const { rows: [card] } = await client.query('SELECT * FROM credit_cards WHERE id = $1', [cardId]);
  if (!card) throw new PostingError('Card not found.');
  const stmtId = await openStatementFor(client, card.id, toISODate(tx.date));
  await client.query(
    `UPDATE transactions SET credit_card_id = $1, credit_card_statement_id = $2,
       payee_id = COALESCE(payee_id, $3) WHERE id = $4`,
    [card.id, stmtId, await payeeId(client, card.issuer || card.name), tx.id]
  );
  await reclassifyCardPayments(client, card.id);
  await pairCardPayments(client, card.id);
  if (stmtId) await recomputeCardStatement(client, stmtId);
  return { card };
}

/**
 * Sets an account's balance as it stood at the START of `as_of` (what the
 * bank showed that morning — a statement's opening balance) and rebuilds
 * today's balance from it: that balance, plus cheques already written but
 * not yet cleared by then, plus every transaction dated on or after it.
 * This is how history gets loaded without throwing today's balance off:
 * anchor at the start date, then send statements oldest to newest. Safe to
 * repeat — it recomputes from scratch each time.
 */
export async function anchorAccount(client, accountId, { as_of, balance }) {
  const { rows } = await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
  if (!rows.length) return null;
  await assertNoClosedFrom(client, null, `${rows[0].name}'s balance`);
  const { rows: [agg] } = await client.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE date >= $2), 0) AS after,
            COALESCE(SUM(amount) FILTER (WHERE date < $2 AND (cleared = false OR cleared_date >= $2)), 0) AS outstanding
     FROM transactions WHERE account_id = $1`,
    [accountId, as_of]
  );
  const now = round2(Number(balance) + Number(agg.outstanding) + Number(agg.after));
  const { rows: updated } = await client.query(
    'UPDATE accounts SET opening_balance = $1 WHERE id = $2 RETURNING *', [now, accountId]
  );
  return { account: updated[0], previous_balance: Number(rows[0].opening_balance), balance_now: now };
}

/**
 * Card equivalent: itemize from `start_date` with `opening_balance` owed
 * that day. Moving the start EARLIER is allowed (loading older statements
 * once a recent one is in); moving it later isn't, since purchases already
 * entered before the new start would silently drop out of the balance.
 */
export async function anchorCard(client, card, { start_date, opening_balance }) {
  await assertNoClosedFrom(client, start_date, `${card.name}'s starting balance`);
  if (card.ledger_start_date && toISODate(start_date) > toISODate(card.ledger_start_date)) {
    throw new PostingError(`${card.name} is already itemized from ${toISODate(card.ledger_start_date)}. Its start can only move earlier, not later.`);
  }
  const { rows } = await client.query(
    `UPDATE credit_cards SET ledger_start_date = $1, ledger_opening_balance = $2 WHERE id = $3 RETURNING *`,
    [start_date, round2(opening_balance), card.id]
  );
  await reclassifyCardPayments(client, card.id);
  return rows[0];
}

/**
 * Logs a billing cycle from a card statement's header (deduped on card +
 * statement date) and attaches payments already on file that were made
 * after it closed and by its due date.
 */
export async function upsertCardStatement(client, cardId, {
  statement_date, due_date, statement_balance, minimum_payment = null, interest_amount = null,
}) {
  const { rows: existing } = await client.query(
    'SELECT * FROM credit_card_statements WHERE credit_card_id = $1 AND statement_date = $2', [cardId, statement_date]
  );
  let stmt = existing[0];
  if (!stmt) {
    const { rows } = await client.query(
      `INSERT INTO credit_card_statements
        (credit_card_id, statement_date, due_date, statement_balance, minimum_payment, interest_amount)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [cardId, statement_date, due_date, round2(statement_balance), minimum_payment, interest_amount]
    );
    stmt = rows[0];
  }
  await client.query(
    `UPDATE transactions SET credit_card_statement_id = $1
     WHERE credit_card_id = $2 AND account_id IS NOT NULL AND credit_card_statement_id IS NULL
       AND date > $3 AND date <= $4`,
    [stmt.id, cardId, statement_date, due_date]
  );
  return recomputeCardStatement(client, stmt.id);
}

/**
 * Expense or transfer, for every payment on a card. Not itemized, or paid
 * before itemization began: the payment IS the expense (the purchases were
 * never entered). Itemized: the purchases are the expenses, so a payment is
 * a transfer — except the part paying off the opening balance, whose
 * purchases predate itemization and were never expensed. Payments pay the
 * oldest balance first, so the first payments after ledger start, up to
 * the opening balance, stay expense; a payment straddling that line is
 * split in two. Recomputed from scratch each time, so it can't drift.
 */
export async function reclassifyCardPayments(client, cardId) {
  const { rows: cRows } = await client.query('SELECT * FROM credit_cards WHERE id = $1', [cardId]);
  if (!cRows.length) return;
  const card = cRows[0];
  const { rows: pays } = await client.query(
    `SELECT * FROM transactions WHERE credit_card_id = $1 AND account_id IS NOT NULL ORDER BY date, id`, [cardId]
  );
  const start = card.ledger_start_date ? toISODate(card.ledger_start_date) : null;
  let preLedgerLeft = start ? Math.max(Number(card.ledger_opening_balance) || 0, 0) : 0;
  for (const t of pays) {
    const paid = -Number(t.amount); // positive = money paid to the card
    let expensePart;
    if (!start || toISODate(t.date) < start) expensePart = paid;
    else {
      expensePart = Math.max(0, Math.min(paid, preLedgerLeft));
      preLedgerLeft = round2(preLedgerLeft - expensePart);
    }
    expensePart = round2(expensePart);
    const transferPart = round2(paid - expensePart);
    await client.query('DELETE FROM transaction_splits WHERE transaction_id = $1', [t.id]);
    if (expensePart > 0.005 && transferPart > 0.005) {
      await client.query('UPDATE transactions SET is_transfer = false, is_split = true WHERE id = $1', [t.id]);
      const owner = ownerOf(t);
      for (const [amt, isTransfer, memo] of [
        [-expensePart, false, `${t.description || 'Card payment'} — pays balance from before itemizing`],
        [-transferPart, true, `${t.description || 'Card payment'} — pays itemized purchases`],
      ]) {
        await client.query(
          `INSERT INTO transaction_splits (transaction_id, amount, memo, ledger, is_transfer, ${SEG_COLS})
           VALUES ($1,$2,$3,$4,$5,${SEGMENT_COLUMNS.map((_, i) => `$${6 + i}`).join(',')})`,
          [t.id, amt, memo, t.ledger, isTransfer, ...SEGMENT_COLUMNS.map((c) => owner[c])]
        );
      }
    } else {
      await client.query(
        'UPDATE transactions SET is_transfer = $1, is_split = false WHERE id = $2',
        [transferPart > 0.005 || paid <= 0, t.id]
      );
    }
  }
}
