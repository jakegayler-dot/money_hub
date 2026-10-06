// Every action that moves money goes through here — the UI's pay/record/
// settle buttons and agent statement ingest alike — so a bill paid by
// clicking "Pay" and a bill paid by matching a bank statement line produce
// exactly the same records. All functions take a DB client already inside
// a transaction (withTransaction) and never commit on their own.

import { SEGMENT_COLUMNS, segmentValues, validateSegment, ledgerForSegment } from './segments.js';
import { toISODate, addMonths } from './dates.js';
import { getSetting, pool } from '../db.js';
import { applyActualPayment, learnLoanName } from './loanMatch.js';

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
     UNION ALL SELECT 'contract deposit', c.commodity FROM contract_payments cp JOIN sale_contracts c ON c.id = cp.contract_id
               WHERE cp.transaction_id = $1
     UNION ALL SELECT 'vendor deposit', p.name FROM vendor_credits vc JOIN payees p ON p.id = vc.payee_id
               WHERE vc.transaction_id = $1 OR vc.refund_transaction_id = $1`,
    [txId]
  );
  if (blockers.length) {
    const b = blockers[0];
    if (b.kind === 'vendor deposit') {
      throw new PostingError(`This is a deposit with ${b.label} — remove it on the Bills tab (by vendor) first.`);
    }
    if (b.kind === 'contract deposit') {
      throw new PostingError(`This deposit counts toward the ${b.label} contract — unlink it on the Contracts tab first.`);
    }
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

  // A financed bill is paid at what's owing that day (invoice + interest).
  const paid = Math.abs(Number(amount ?? await billOwing(client, bill.id, date)));
  let tx = null;
  if (account_id || credit_card_id) {
    tx = await insertTransaction(client, {
      account_id, credit_card_id, ledger: bill.ledger, date, amount: -paid,
      description: `Bill paid: ${bill.name}${paid_by_check ? ' (check)' : ''}`,
      category_id: bill.category_id || await categoryIdByName(client, bill.category), payee: bill.name,
      gst_amount: billGst(bill, paid),
      owner: ownerOf(bill), cleared: !paid_by_check, source, external_id, entered_by, awaiting_statement: true,
    });
    await splitFinanceInterest(client, bill, tx);
  }
  await client.query(
    `UPDATE bills SET status = 'paid', paid_date = $1, linked_transaction_id = $2 WHERE id = $3`,
    [date, tx ? tx.id : null, bill.id]
  );
  const nextBill = await rollBillForward(client, bill);
  return { bill: { ...bill, status: 'paid', paid_date: date, linked_transaction_id: tx?.id ?? null }, transaction: tx, nextBill };
}

/** What a bill owes on `date` (a financed bill: plus interest so far) — bill_owing() in schema.sql. */
export async function billOwing(client, billId, date) {
  const { rows: [r] } = await client.query('SELECT bill_owing(b, $2::date) AS owing FROM bills b WHERE b.id = $1', [billId, date]);
  return r ? Number(r.owing) : null;
}

/** The bill is the invoice, so its GST is exact. A financed bill's extra is interest (no GST); anything else scales. */
function billGst(bill, paid) {
  if (!bill.has_gst || !Number(bill.amount)) return null;
  if (bill.is_financed && paid >= Number(bill.amount)) return round2(Number(bill.gst_amount));
  return round2(Number(bill.gst_amount) * paid / Number(bill.amount));
}

/**
 * A financed bill paid for more than the invoice: the payment is split into
 * the invoice (the bill's category) and the finance interest (Interest ›
 * Input financing interest), so the input cost stays the invoice amount.
 */
async function splitFinanceInterest(client, bill, tx) {
  const paid = -Number(tx.amount);
  const cashDue = round2(Number(bill.amount) - await billApplied(client, bill.id));
  const interest = round2(paid - cashDue);
  if (!bill.is_financed || interest < 0.005 || tx.is_split) return;
  const owner = ownerOf(tx);
  const interestCat = await expenseCategoryFor(client, 'Interest › Input financing interest');
  const { splits, error } = normalizeSplits([
    { amount: -cashDue, category_id: tx.category_id || bill.category_id, memo: `Invoice: ${bill.name}` },
    { amount: -interest, category_id: interestCat, memo: `Finance interest on ${bill.name}` },
  ], Number(tx.amount), owner, tx.ledger);
  if (error) return;
  for (const sp of splits) {
    await client.query(
      `INSERT INTO transaction_splits (transaction_id, amount, category_id, memo, ledger, is_capex, ${SEG_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,${SEGMENT_COLUMNS.map((_, i) => `$${7 + i}`).join(',')})`,
      [tx.id, sp.amount, sp.category_id, sp.memo, sp.ledger, sp.is_capex, ...SEGMENT_COLUMNS.map((k) => sp.owner[k])]);
  }
  await client.query('UPDATE transactions SET is_split = true, category_id = NULL WHERE id = $1', [tx.id]);
}

/** Deposits applied to a bill so far. */
export async function billApplied(client, billId) {
  const { rows: [r] } = await client.query('SELECT COALESCE(SUM(amount), 0) AS s FROM credit_applications WHERE bill_id = $1', [billId]);
  return round2(r.s);
}

// ---- Vendors: several bills, one payment; deposits held by a vendor ---------

/**
 * One payment for several of a vendor's bills (what the account says is
 * owing, or the oldest few). Each bill is marked paid by it, and the
 * payment is split into one piece per bill — that bill's category and
 * owner — so the costs still land where they belong. `createdHere`: the
 * payment was made from the Bills tab (undoing it removes it).
 */
export async function linkBillsToTransaction(client, billIds, txId, { createdHere = false } = {}) {
  const ids = [...new Set(billIds.map(Number))];
  if (!ids.length) throw new PostingError('Pick the bills it paid.');
  const tx = await linkableTx(client, txId);
  const { rows: bills } = await client.query('SELECT * FROM bills WHERE id = ANY($1) ORDER BY due_date, id FOR UPDATE', [ids]);
  if (bills.length !== ids.length) throw new PostingError('Bill not found.');
  const paidOne = bills.find((b) => b.status === 'paid');
  if (paidOne) throw new PostingError(`"${paidOne.name}" is already marked paid.`);
  const dues = [];
  for (const b of bills) dues.push(await billOwing(client, b.id, toISODate(tx.date)));
  const total = round2(dues.reduce((a, x) => a + x, 0));
  const paid = round2(-Number(tx.amount));
  if (Math.abs(total - paid) > 0.05) {
    throw new PostingError(`Those bills come to ${total.toFixed(2)}, but the payment is ${paid.toFixed(2)}.`);
  }
  if (bills.length > 1 && !tx.is_split) {
    const pieces = bills.map((b, i) => ({
      amount: -dues[i], category_id: b.category_id || null, memo: `Bill: ${b.name}`, owner: ownerOf(b), ledger: b.ledger,
    }));
    pieces[pieces.length - 1].amount = round2(pieces[pieces.length - 1].amount + (total - paid)); // cents of rounding
    for (const pc of pieces) {
      await client.query(
        `INSERT INTO transaction_splits (transaction_id, amount, category_id, memo, ledger, is_capex, ${SEG_COLS})
         VALUES ($1,$2,$3,$4,$5,false,${SEGMENT_COLUMNS.map((_, i) => `$${6 + i}`).join(',')})`,
        [tx.id, round2(pc.amount), pc.category_id, pc.memo, pc.ledger, ...SEGMENT_COLUMNS.map((k) => pc.owner[k])]);
    }
    await client.query('UPDATE transactions SET is_split = true, category_id = NULL WHERE id = $1', [tx.id]);
  } else if (bills.length === 1 && !tx.category_id && !tx.is_split && bills[0].category_id) {
    await client.query('UPDATE transactions SET category_id = $1 WHERE id = $2', [bills[0].category_id, tx.id]);
  }
  const gst = round2(bills.reduce((a, b) => a + (b.has_gst ? Number(b.gst_amount) : 0), 0));
  const vendor = bills[0].payee_id;
  await client.query(
    `UPDATE transactions SET gst_amount = COALESCE(gst_amount, $2), payee_id = COALESCE(payee_id, $3) WHERE id = $1`,
    [tx.id, gst > 0 ? gst : null, vendor || await payeeId(client, bills[0].name)]);
  for (const b of bills) {
    await client.query(
      `UPDATE bills SET status = 'paid', paid_date = $1, linked_transaction_id = $2, linked_existing = $3 WHERE id = $4`,
      [tx.date, tx.id, !createdHere, b.id]);
    await rollBillForward(client, b);
  }
  return { bills };
}

/** Pays several bills from an account in one payment (the Bills tab's "Pay all"). */
export async function payBills(client, billIds, { account_id, date, paid_by_check = false }) {
  const { rows: bills } = await client.query('SELECT * FROM bills WHERE id = ANY($1) AND status = $2 ORDER BY due_date', [billIds, 'unpaid']);
  if (!bills.length) throw new PostingError('Nothing unpaid to pay.');
  let total = 0;
  for (const b of bills) total += await billOwing(client, b.id, date);
  total = round2(total);
  const { rows: [vendor] } = bills[0].payee_id ? await client.query('SELECT name FROM payees WHERE id = $1', [bills[0].payee_id]) : { rows: [] };
  const tx = await insertTransaction(client, {
    account_id, ledger: bills[0].ledger, date, amount: -total,
    description: `Bills paid: ${vendor?.name || bills[0].name} (${bills.length})${paid_by_check ? ' (check)' : ''}`,
    payee_id: bills[0].payee_id || null, owner: ownerOf(bills[0]), cleared: !paid_by_check, awaiting_statement: true,
  });
  await linkBillsToTransaction(client, bills.map((b) => b.id), tx.id, { createdHere: true });
  return { transaction: tx, bills };
}

/** What a vendor deposit still holds. */
async function creditRemaining(client, creditId) {
  const { rows: [r] } = await client.query(
    `SELECT vc.amount - COALESCE((SELECT SUM(amount) FROM credit_applications WHERE credit_id = vc.id), 0) AS left
     FROM vendor_credits vc WHERE vc.id = $1`, [creditId]);
  return r ? round2(r.left) : 0;
}

/**
 * The deposit payment, re-split from scratch: each part applied to a bill
 * is that bill's expense (its category and owner); the rest is still the
 * vendor holding your money (a transfer) — or an expense if they kept it.
 */
async function rebuildCreditSplits(client, creditId) {
  const { rows: [c] } = await client.query(
    'SELECT vc.*, p.name AS vendor FROM vendor_credits vc JOIN payees p ON p.id = vc.payee_id WHERE vc.id = $1', [creditId]);
  if (!c || !c.transaction_id) return;
  const { rows: [tx] } = await client.query('SELECT * FROM transactions WHERE id = $1', [c.transaction_id]);
  if (!tx || await closedMonth(client, tx.date)) return;
  const { rows: apps } = await client.query(
    `SELECT b.*, ca.amount AS applied FROM credit_applications ca JOIN bills b ON b.id = ca.bill_id WHERE ca.credit_id = $1 ORDER BY ca.id`, [c.id]);
  const pieces = apps.map((a) => ({
    amount: -Number(a.applied), category_id: a.category_id || null, memo: `${c.note === ON_ACCOUNT_NOTE ? 'Paid' : 'Deposit applied'}: ${a.name}`,
    owner: ownerOf(a), ledger: a.ledger, is_transfer: false,
  }));
  const left = round2(-Number(tx.amount) - apps.reduce((s, a) => s + Number(a.applied), 0));
  if (left > 0.005) {
    const kept = c.status === 'kept';
    pieces.push({
      amount: -left, category_id: kept ? c.kept_category_id : null,
      memo: kept ? `Deposit kept by ${c.vendor}` : c.note === ON_ACCOUNT_NOTE ? `Credit with ${c.vendor} for the next bill` : `Deposit held by ${c.vendor}`,
      owner: ownerOf(tx), ledger: tx.ledger, is_transfer: !kept,
    });
  }
  await client.query('DELETE FROM transaction_splits WHERE transaction_id = $1', [tx.id]);
  for (const pc of pieces) {
    await client.query(
      `INSERT INTO transaction_splits (transaction_id, amount, category_id, memo, ledger, is_capex, is_transfer, ${SEG_COLS})
       VALUES ($1,$2,$3,$4,$5,false,$6,${SEGMENT_COLUMNS.map((_, i) => `$${7 + i}`).join(',')})`,
      [tx.id, round2(pc.amount), pc.category_id, pc.memo, pc.ledger, pc.is_transfer, ...SEGMENT_COLUMNS.map((k) => pc.owner[k])]);
  }
  await client.query('UPDATE transactions SET is_split = $2, category_id = NULL, payee_id = COALESCE(payee_id, $3) WHERE id = $1',
    [tx.id, pieces.length > 0, c.payee_id]);
}

/**
 * A deposit paid to a vendor: an existing ledger payment (`transaction_id`)
 * or one recorded now from an account. Held as yours until it's applied to
 * bills (prepayment) or given back (refundable).
 */
export async function recordVendorDeposit(client, { payee_id, kind, transaction_id = null, account_id = null, amount = null, date = null, note = null }) {
  if (!['prepayment', 'refundable'].includes(kind)) throw new PostingError('Kind must be prepayment or refundable.');
  let tx;
  if (transaction_id) {
    tx = await linkableTx(client, Number(transaction_id));
    if (!tx.account_id && !tx.credit_card_id) throw new PostingError('That entry isn\'t a payment.');
  } else {
    if (!account_id || !(Number(amount) > 0) || !date) throw new PostingError('Account, amount and date are needed to record a deposit.');
    tx = await insertTransaction(client, {
      account_id, date, amount: -Math.abs(Number(amount)), description: 'Deposit paid', payee_id, awaiting_statement: 'fed',
    });
  }
  const { rows: [c] } = await client.query(
    `INSERT INTO vendor_credits (payee_id, kind, amount, date, transaction_id, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [payee_id, kind, round2(-Number(tx.amount)), tx.date, tx.id, note]);
  await rebuildCreditSplits(client, c.id);
  return c;
}

/**
 * Uses a deposit against a bill: up to what the bill still owes. A bill
 * fully covered is marked paid; the applied part becomes its expense.
 */
export async function applyVendorCredit(client, creditId, billId, { on = null, rebuild = true } = {}) {
  const { rows: [c] } = await client.query('SELECT * FROM vendor_credits WHERE id = $1 FOR UPDATE', [creditId]);
  if (!c || c.status !== 'open') throw new PostingError('That deposit isn\'t available to apply.');
  const { rows: [bill] } = await client.query('SELECT * FROM bills WHERE id = $1 FOR UPDATE', [billId]);
  if (!bill || bill.status !== 'unpaid') throw new PostingError('That bill isn\'t unpaid.');
  const at = on || toISODate(new Date()); // the day it's settled: what a financed bill owes then
  const use = Math.min(await creditRemaining(client, c.id), await billOwing(client, bill.id, at));
  if (use <= 0.005) throw new PostingError('Nothing to apply.');
  await client.query('INSERT INTO credit_applications (credit_id, bill_id, amount) VALUES ($1, $2, $3)', [c.id, bill.id, round2(use)]);
  if (await creditRemaining(client, c.id) <= 0.005) await client.query(`UPDATE vendor_credits SET status = 'used' WHERE id = $1`, [c.id]);
  if (await billOwing(client, bill.id, at) <= 0.005) {
    await client.query(`UPDATE bills SET status = 'paid', paid_date = $2, linked_transaction_id = NULL, linked_existing = false WHERE id = $1`, [bill.id, at]);
    await rollBillForward(client, bill);
  }
  if (rebuild) await rebuildCreditSplits(client, c.id);
  return { applied: round2(use) };
}

/**
 * A vendor's account settles oldest first, the way the vendor's own
 * statement does. Payments marked "paid on account" are held as credit
 * with the vendor, and every open credit (those, and prepaid deposits) pays
 * the unpaid bills already billed, oldest first; a bill only partly
 * covered keeps owing the rest, and what's left over waits for the next
 * bill. A bill someone took a credit off by hand is left alone. Safe to
 * run any time — it only ever applies what's open to what's unpaid.
 */
export async function settleVendorAccount(client, payeeId, today = toISODate(new Date())) {
  // A payment on account that was edited or deleted since: redo it from the payment as it is now.
  const { rows: stale } = await client.query(
    `SELECT vc.id, vc.transaction_id, t.id AS still FROM vendor_credits vc LEFT JOIN transactions t ON t.id = vc.transaction_id
     WHERE vc.payee_id = $1 AND vc.note = $2
       AND (t.id IS NULL OR t.payee_id IS DISTINCT FROM vc.payee_id OR abs(vc.amount + t.amount) > 0.005 OR t.date <> vc.date)`,
    [payeeId, ON_ACCOUNT_NOTE]);
  for (const c of stale) {
    await removeVendorCredit(client, c.id);
    if (c.still) await client.query('INSERT INTO vendor_on_account (transaction_id) VALUES ($1) ON CONFLICT DO NOTHING', [c.still]);
  }
  // Payments marked on account → credit held with the vendor.
  const { rows: onAccount } = await client.query(
    `SELECT t.id FROM vendor_on_account o JOIN transactions t ON t.id = o.transaction_id
     WHERE t.payee_id = $1 AND t.amount < 0 AND NOT t.is_transfer ORDER BY t.date, t.id`, [payeeId]);
  for (const t of onAccount) {
    try {
      await recordVendorDeposit(client, { payee_id: payeeId, kind: 'prepayment', transaction_id: t.id, note: ON_ACCOUNT_NOTE });
      await client.query('DELETE FROM vendor_on_account WHERE transaction_id = $1', [t.id]);
    } catch (e) {
      if (!(e instanceof PostingError)) throw e; // closed month, or already paying something: stays as it is
    }
  }
  // A deleted bill gives back what was applied to it.
  await client.query(
    `UPDATE vendor_credits vc SET status = 'open' WHERE vc.payee_id = $1 AND vc.status = 'used'
       AND vc.amount - COALESCE((SELECT SUM(amount) FROM credit_applications WHERE credit_id = vc.id), 0) > 0.005`, [payeeId]);
  const { rows: credits } = await client.query(
    `SELECT id, date FROM vendor_credits WHERE payee_id = $1 AND kind = 'prepayment' AND status = 'open' ORDER BY date, id`, [payeeId]);
  if (!credits.length) return { applied: 0 };
  const { rows: bills } = await client.query(
    `SELECT id, received_date, due_date, created_at, frequency, status, paid_date FROM bills
     WHERE payee_id = $1 AND status = 'unpaid' AND NOT COALESCE(no_auto_settle, false)`, [payeeId]);
  const billed = bills.map((b) => ({ ...b, on: billLandsOn(b) })).filter((b) => b.on <= today)
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : a.id - b.id));
  const touched = new Set();
  let applied = 0;
  for (const b of billed) {
    for (const c of credits) {
      if (c.done) continue;
      try {
        // Settled on the later of the bill and the payment: interest stops then.
        const on = [b.on, toISODate(c.date)].sort().pop();
        const r = await applyVendorCredit(client, c.id, b.id, { on: on > today ? today : on, rebuild: false });
        applied += r.applied;
        touched.add(c.id);
      } catch (e) {
        if (!(e instanceof PostingError)) throw e;
      }
      const { rows: [st] } = await client.query('SELECT status FROM vendor_credits WHERE id = $1', [c.id]);
      if (st.status !== 'open') c.done = true;
      const { rows: [bs] } = await client.query('SELECT status FROM bills WHERE id = $1', [b.id]);
      if (bs.status === 'paid') break;
    }
    if (credits.every((c) => c.done)) break;
  }
  for (const id of touched) await rebuildCreditSplits(client, id);
  return { applied: round2(applied) };
}
export const ON_ACCOUNT_NOTE = 'Paid on account';

/** The day a bill lands on the vendor's account — billDate() in vendorAccount.js. */
function billLandsOn(b) {
  if (b.received_date) return toISODate(b.received_date);
  if (b.frequency && b.frequency !== 'one_time') return toISODate(b.due_date);
  const made = toISODate(b.created_at) || toISODate(b.due_date);
  return made < toISODate(b.due_date) ? made : toISODate(b.due_date);
}

/** Every vendor with credit to apply or payments marked on account. */
export async function settleAllVendorAccounts(withTx) {
  const { rows } = await pool.query(
    `SELECT DISTINCT payee_id FROM vendor_credits WHERE kind = 'prepayment' AND status IN ('open', 'used')
     UNION SELECT DISTINCT t.payee_id FROM vendor_on_account o JOIN transactions t ON t.id = o.transaction_id WHERE t.payee_id IS NOT NULL`);
  for (const r of rows) {
    try { await withTx((client) => settleVendorAccount(client, r.payee_id)); } catch (e) { console.error('Vendor settle failed', r.payee_id, e.message); }
  }
}

/** Takes a deposit back off a bill (the bill reopens if the deposit had paid it). */
export async function unapplyVendorCredit(client, applicationId, opts = {}) {
  const { rows: [a] } = await client.query('SELECT * FROM credit_applications WHERE id = $1', [applicationId]);
  if (!a) throw new PostingError('Not found.');
  await client.query('DELETE FROM credit_applications WHERE id = $1', [a.id]);
  await client.query(`UPDATE vendor_credits SET status = 'open' WHERE id = $1 AND status = 'used'`, [a.credit_id]);
  // Taken off by hand: the account's oldest-first settling leaves this bill alone from now on.
  if (!opts.auto) await client.query('UPDATE bills SET no_auto_settle = true WHERE id = $1', [a.bill_id]);
  await client.query(
    `UPDATE bills SET status = 'unpaid', paid_date = NULL WHERE id = $1 AND status = 'paid' AND linked_transaction_id IS NULL`, [a.bill_id]);
  await rebuildCreditSplits(client, a.credit_id);
}

/** A refundable deposit came back: the refund is your money returning (a transfer), not income. */
export async function refundVendorCredit(client, creditId, refundTxId) {
  const { rows: [c] } = await client.query('SELECT * FROM vendor_credits WHERE id = $1 FOR UPDATE', [creditId]);
  if (!c || c.status !== 'open') throw new PostingError('That deposit isn\'t open.');
  const tx = await linkableTx(client, Number(refundTxId), 'in');
  await client.query(
    `UPDATE transactions SET is_transfer = true, category_id = NULL, needs_review = false, review_note = NULL,
       payee_id = COALESCE(payee_id, $2) WHERE id = $1`, [tx.id, c.payee_id]);
  await client.query(`UPDATE vendor_credits SET status = 'refunded', refund_transaction_id = $2 WHERE id = $1`, [c.id, tx.id]);
}

/** The vendor kept the deposit: what's left becomes an expense. */
export async function keepVendorCredit(client, creditId, categoryId) {
  await client.query(`UPDATE vendor_credits SET status = 'kept', kept_category_id = $2, closed_date = CURRENT_DATE WHERE id = $1 AND status = 'open'`, [creditId, categoryId || null]);
  await rebuildCreditSplits(client, creditId);
}

/** Removes a deposit record (its payment goes back to an ordinary entry; one recorded here is deleted). */
export async function removeVendorCredit(client, creditId) {
  const { rows: [c] } = await client.query('SELECT * FROM vendor_credits WHERE id = $1 FOR UPDATE', [creditId]);
  if (!c) return;
  const { rows: apps } = await client.query('SELECT id FROM credit_applications WHERE credit_id = $1', [c.id]);
  for (const a of apps) await unapplyVendorCredit(client, a.id, { auto: true });
  if (c.refund_transaction_id) await client.query('UPDATE transactions SET is_transfer = false WHERE id = $1', [c.refund_transaction_id]);
  await client.query('DELETE FROM vendor_credits WHERE id = $1', [c.id]);
  if (c.transaction_id) {
    await client.query('DELETE FROM transaction_splits WHERE transaction_id = $1', [c.transaction_id]);
    await client.query('UPDATE transactions SET is_split = false WHERE id = $1', [c.transaction_id]);
  }
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
     UNION ALL SELECT 'contract (' || c.commodity || ')' FROM contract_payments cp JOIN sale_contracts c ON c.id = cp.contract_id
               WHERE cp.transaction_id = $1
     UNION ALL SELECT 'a deposit with ' || p.name FROM vendor_credits vc JOIN payees p ON p.id = vc.payee_id
               WHERE vc.transaction_id = $1 OR vc.refund_transaction_id = $1
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
    await client.query('UPDATE transactions SET gst_amount = $1 WHERE id = $2', [billGst(bill, Math.abs(Number(tx.amount))), tx.id]);
  }
  const { rows: [fresh] } = await client.query('SELECT * FROM transactions WHERE id = $1', [tx.id]);
  await splitFinanceInterest(client, bill, fresh);
  const nextBill = await rollBillForward(client, bill);
  return { bill, nextBill };
}

// ---- Sale contracts: paid by one or more deposits --------------------------
//
// Grain and cattle get paid per load or per settlement, each deposit net of
// checkoff, levies, freight or dockage. So a contract collects deposits
// (contract_payments) and settles itself once they reach the contract value
// less a deductions allowance (setting contract_deduction_allowance_pct,
// default 3% — covers checkoff and levies). The gap between what arrived and
// the contract value is then booked on the last deposit as gross sale plus a
// deductions piece, so income shows at the contract value (CRA wants farm
// sales gross) and the deductions show as an expense. Below the allowance
// the contract stays partly paid until a person settles it: "the rest was
// deductions" (same booking) or "delivered short" (income stays at what
// arrived). A deposit split by a settlement ticket already carries its gross
// and deductions, and counts at its gross.

export const CONTRACT_DEDUCTIONS_MEMO = 'Deductions — checkoff, levies, freight (difference to contract value)';
const CONTRACT_GROSS_MEMO = 'Gross sale — contract value';
const GROSS_OF = (t) => `CASE WHEN ${t}.is_split
  THEN COALESCE((SELECT SUM(s.amount) FROM transaction_splits s WHERE s.transaction_id = ${t}.id AND s.amount > 0), 0)
  ELSE ${t}.amount END`;

export async function contractAllowancePct() {
  const v = Number(await getSetting('contract_deduction_allowance_pct', 3));
  return Number.isFinite(v) && v >= 0 && v < 50 ? v : 3;
}

async function contractReceived(client, contractId) {
  const { rows: [r] } = await client.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(${GROSS_OF('t')}), 0) AS gross, COALESCE(SUM(t.amount), 0) AS net
     FROM contract_payments cp JOIN transactions t ON t.id = cp.transaction_id WHERE cp.contract_id = $1`, [contractId]);
  return { n: r.n, gross: round2(r.gross), net: round2(r.net) };
}

/** Books (gross − received) as deductions on the contract's latest plain deposit. Returns the amount booked. */
async function bookContractDeductions(client, c) {
  const got = await contractReceived(client, c.id);
  const gap = round2(Number(c.total_value) - got.gross);
  if (gap <= 0.005) return 0;
  const { rows: [tx] } = await client.query(
    `SELECT t.* FROM contract_payments cp JOIN transactions t ON t.id = cp.transaction_id
     WHERE cp.contract_id = $1 AND NOT t.is_split ORDER BY t.date DESC, t.id DESC LIMIT 1`, [c.id]);
  if (!tx || await closedMonth(client, tx.date)) return 0;
  const incomeCat = tx.category_id || await incomeCategoryFor(client, c.commodity);
  const dedCat = await expenseCategoryFor(client, 'Marketing & sales costs › Levies & checkoff');
  const owner = ownerOf(tx);
  const { splits, error } = normalizeSplits([
    { amount: round2(Number(tx.amount) + gap), category_id: incomeCat, memo: CONTRACT_GROSS_MEMO },
    { amount: -gap, category_id: dedCat, memo: CONTRACT_DEDUCTIONS_MEMO },
  ], Number(tx.amount), owner, tx.ledger);
  if (error) return 0;
  await client.query('DELETE FROM transaction_splits WHERE transaction_id = $1', [tx.id]);
  for (const sp of splits) {
    await client.query(
      `INSERT INTO transaction_splits (transaction_id, amount, category_id, memo, ledger, is_capex, ${SEG_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,${SEGMENT_COLUMNS.map((_, i) => `$${7 + i}`).join(',')})`,
      [tx.id, sp.amount, sp.category_id, sp.memo, sp.ledger, sp.is_capex, ...SEGMENT_COLUMNS.map((k) => sp.owner[k])]);
  }
  await client.query('UPDATE transactions SET is_split = true, category_id = NULL WHERE id = $1', [tx.id]);
  return gap;
}

/** Takes the deductions booking back off the contract's deposits (back to one income line each). */
async function undoContractDeductions(client, contractId) {
  const { rows } = await client.query(
    `SELECT DISTINCT s.transaction_id FROM transaction_splits s JOIN contract_payments cp ON cp.transaction_id = s.transaction_id
     WHERE cp.contract_id = $1 AND s.memo = $2`, [contractId, CONTRACT_DEDUCTIONS_MEMO]);
  for (const { transaction_id: txId } of rows) {
    const { rows: [gross] } = await client.query(
      'SELECT category_id FROM transaction_splits WHERE transaction_id = $1 AND memo = $2 LIMIT 1', [txId, CONTRACT_GROSS_MEMO]);
    await client.query('DELETE FROM transaction_splits WHERE transaction_id = $1', [txId]);
    await client.query('UPDATE transactions SET is_split = false, category_id = $2 WHERE id = $1', [txId, gross?.category_id || null]);
  }
}

/**
 * Brings a contract up to date with its deposits: received_amount, and
 * settles it when they reach the value less the allowance. Settled
 * contracts stay settled (unlinking a deposit reopens them first).
 */
export async function refreshContract(client, contractId) {
  const { rows: [c] } = await client.query('SELECT * FROM sale_contracts WHERE id = $1 FOR UPDATE', [contractId]);
  if (!c) return null;
  let got = await contractReceived(client, c.id);
  const sets = { status: c.status, deductions_amount: Number(c.deductions_amount), settle_note: c.settle_note };
  if (!['settled', 'cancelled'].includes(c.status) && got.n > 0) {
    const allow = await contractAllowancePct();
    const value = Number(c.total_value);
    if (got.gross >= round2(value * (1 - allow / 100)) - 0.005) {
      const booked = await bookContractDeductions(client, c);
      sets.status = 'settled';
      sets.deductions_amount = booked;
      sets.settle_note = booked > 0
        ? `Settled: deposits came to ${got.net.toFixed(2)}; the ${booked.toFixed(2)} difference to the contract value is booked as deductions.`
        : (got.gross > value + 0.005 ? `Settled: received ${got.gross.toFixed(2)}, more than the contract value.` : 'Settled: received in full.');
      got = await contractReceived(client, c.id);
    }
  }
  const { rows: [out] } = await client.query(
    `UPDATE sale_contracts SET received_amount = $2, status = $3::contract_status, deductions_amount = $4, settle_note = $5
     WHERE id = $1 RETURNING *`,
    [c.id, got.gross, sets.status, sets.deductions_amount, sets.settle_note]);
  return out;
}

/**
 * Counts a deposit already in the ledger toward a contract — no new money
 * moves. Fills the income category from the commodity ("Canola" → Canola
 * sales) and the buyer as payee when the deposit has neither; the contract
 * settles itself once its deposits reach the value (refreshContract).
 */
export async function linkContractToTransaction(client, contractId, txId, { createdHere = false } = {}) {
  const tx = await linkableTx(client, txId, 'in');
  if (!tx.account_id) throw new PostingError('A contract payment lands in a bank account.');
  const { rows } = await client.query('SELECT * FROM sale_contracts WHERE id = $1 FOR UPDATE', [contractId]);
  const c = rows[0];
  if (!c) throw new PostingError('Contract not found.');
  if (c.status === 'settled') throw new PostingError(`That ${c.commodity} contract is already settled — reopen it on the Contracts tab to add another deposit.`);
  if (c.status === 'cancelled') throw new PostingError(`That ${c.commodity} contract is cancelled.`);
  await client.query('INSERT INTO contract_payments (contract_id, transaction_id, created_here) VALUES ($1, $2, $3)', [c.id, tx.id, createdHere]);
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
  return { contract: await refreshContract(client, c.id) };
}

/** A settled contract back to collecting deposits (its deductions booking undone). */
async function reopenContract(client, c) {
  await undoContractDeductions(client, c.id);
  await client.query(
    `UPDATE sale_contracts SET status = CASE WHEN delivery_date IS NOT NULL AND delivery_date <= CURRENT_DATE THEN 'delivered'::contract_status ELSE 'open'::contract_status END,
       deductions_amount = 0, settle_note = NULL WHERE id = $1`, [c.id]);
}

/**
 * Takes a deposit off its contract. A deposit recorded from the Contracts
 * tab is removed with it; a real one (statement, ledger) stays in the
 * ledger and is remembered as "not this contract" so it isn't matched back.
 */
export async function unlinkContractPayment(client, txId) {
  const { rows: [cp] } = await client.query('SELECT * FROM contract_payments WHERE transaction_id = $1', [txId]);
  if (!cp) throw new PostingError('That deposit isn\'t linked to a contract.');
  const { rows: [c] } = await client.query('SELECT * FROM sale_contracts WHERE id = $1 FOR UPDATE', [cp.contract_id]);
  if (c.status === 'settled') await reopenContract(client, c);
  await client.query('DELETE FROM contract_payments WHERE id = $1', [cp.id]);
  if (cp.created_here) await removeTransaction(client, txId);
  else {
    await client.query('INSERT INTO contract_link_rejections (contract_id, transaction_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [c.id, txId]);
  }
  return refreshContract(client, c.id);
}

/**
 * A person settling a contract whose deposits fell short of the allowance:
 * 'deductions' — the rest was checkoff, freight, dockage (booked as such);
 * 'short' — less was delivered (income stays at what arrived).
 */
export async function settleContractByHand(client, contractId, mode) {
  const { rows: [c] } = await client.query('SELECT * FROM sale_contracts WHERE id = $1 FOR UPDATE', [contractId]);
  if (!c) return null;
  if (c.status === 'settled') return c;
  const got = await contractReceived(client, c.id);
  if (!got.n) throw new PostingError('No deposits are linked to this contract yet — link the deposits first.');
  let booked = 0;
  let note;
  if (mode === 'deductions') {
    booked = await bookContractDeductions(client, c);
    note = `Settled by hand: deposits came to ${got.net.toFixed(2)}; the ${booked.toFixed(2)} difference is booked as deductions.`;
  } else {
    note = `Settled by hand as delivered short: received ${got.gross.toFixed(2)} of ${Number(c.total_value).toFixed(2)}.`;
  }
  const after = await contractReceived(client, c.id);
  const { rows: [out] } = await client.query(
    `UPDATE sale_contracts SET status = 'settled', received_amount = $2, deductions_amount = $3, settle_note = $4 WHERE id = $1 RETURNING *`,
    [c.id, after.gross, booked, note]);
  return out;
}

/** Reopens a settled contract, keeping its deposits linked (it won't re-settle on its own until more arrive). */
export async function reopenContractByHand(client, contractId) {
  const { rows: [c] } = await client.query('SELECT * FROM sale_contracts WHERE id = $1 FOR UPDATE', [contractId]);
  if (!c) return null;
  if (c.status !== 'settled') return c;
  await reopenContract(client, c);
  const got = await contractReceived(client, c.id);
  const { rows: [out] } = await client.query(
    `UPDATE sale_contracts SET received_amount = $2, settle_note = 'Reopened by hand.' WHERE id = $1 RETURNING *`, [c.id, got.gross]);
  return out;
}

/** Marks a scheduled loan payment made BY a transaction already in the ledger. */
export async function linkLoanPaymentToTransaction(client, paymentId, txId) {
  const tx = await linkableTx(client, txId);
  if (!tx.account_id) throw new PostingError('A loan payment comes out of a bank account, not a card.');
  const { rows } = await client.query('SELECT * FROM loan_payments WHERE id = $1 FOR UPDATE', [paymentId]);
  const payment = rows[0];
  if (!payment || payment.is_adjustment) throw new PostingError('Loan payment not found.');
  if (payment.paid) throw new PostingError('That loan payment is already recorded.');
  // Never past an older payment on the same loan that's still open: the oldest open one is what was paid.
  const { rows: [older] } = await client.query(
    `SELECT id, due_date FROM loan_payments WHERE loan_id = $1 AND NOT paid AND NOT is_adjustment AND (due_date, id) < ($2::date, $3)
     ORDER BY due_date, id LIMIT 1`, [payment.loan_id, payment.due_date, payment.id]);
  const target = older ? (await client.query('SELECT * FROM loan_payments WHERE id = $1 FOR UPDATE', [older.id])).rows[0] : payment;
  await client.query(
    `UPDATE loan_payments SET paid = true, paid_date = $1, linked_transaction_id = $2, linked_existing = true WHERE id = $3`,
    [tx.date, tx.id, target.id]
  );
  await client.query('UPDATE transactions SET is_debt_service = true WHERE id = $1', [tx.id]);
  await applyActualPayment(client, target.id, -Number(tx.amount), toISODate(tx.date)); // what it really was; the rest re-priced
  await learnLoanName(client, target.loan_id, tx);
  await splitLoanPayment(client, tx.id, target.id);
  if (!tx.payee_id) {
    const { rows: l } = await client.query('SELECT COALESCE(lender, name) AS who FROM loans WHERE id = $1', [target.loan_id]);
    if (l[0]?.who) await client.query('UPDATE transactions SET payee_id = $1 WHERE id = $2', [await payeeId(client, l[0].who), tx.id]);
  }
  return { payment: target };
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
  let payment = rows[0];
  if (payment.paid || payment.is_adjustment) return { payment, alreadyPaid: true, transaction: null };
  // The oldest open payment on the loan is the one being paid — never a later one while it's still open.
  const { rows: [older] } = await client.query(
    `SELECT lp.*, l.name AS loan_name, l.lender, l.segment FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
     WHERE lp.loan_id = $1 AND NOT lp.paid AND NOT lp.is_adjustment AND (lp.due_date, lp.id) < ($2::date, $3)
     ORDER BY lp.due_date, lp.id LIMIT 1 FOR UPDATE OF lp`, [payment.loan_id, payment.due_date, payment.id]);
  if (older) payment = older;

  const total = Math.abs(Number(amount ?? (Number(payment.principal_amount) + Number(payment.interest_amount))));
  const tx = await insertTransaction(client, {
    account_id, ledger: ledgerForSegment(payment.segment), date, amount: -total,
    description: `Loan payment: ${payment.loan_name || payment.lender}${paid_by_check ? ' (check)' : ''}`,
    is_debt_service: true, owner: ownerOf({ segment: payment.segment }), payee: payment.lender || payment.loan_name,
    cleared: !paid_by_check, source, external_id, entered_by, awaiting_statement: true,
  });
  await client.query(
    `UPDATE loan_payments SET paid = true, paid_date = $1, linked_transaction_id = $2 WHERE id = $3`,
    [date, tx.id, payment.id]
  );
  await applyActualPayment(client, payment.id, total, toISODate(date)); // what it really was; the rest re-priced
  await splitLoanPayment(client, tx.id, payment.id);
  const { rows: updated } = await client.query('SELECT * FROM loan_payments WHERE id = $1', [payment.id]);
  return { payment: updated[0], transaction: tx };
}

// ---- Loan payments: interest vs principal in the ledger ---------------------
//
// A loan payment is two different things: interest (a cost — deductible,
// in profit and costings) and principal (paying down the loan — not a
// cost). The entry is split into those two pieces from the loan's
// schedule: interest under Interest › Loan interest, principal as a
// transfer to the loan. Every report reads the pieces like any other
// split. The schedule's interest is used; if the bank took a different
// total, the difference goes to principal. Pieces carry these memo
// prefixes so unlinking can take them back off.
export const LOAN_INTEREST_MEMO = 'Loan interest — ';
export const LOAN_PRINCIPAL_MEMO = 'Loan principal — ';

export async function splitLoanPayment(client, txId, paymentId) {
  const { rows: [tx] } = await client.query('SELECT * FROM transactions WHERE id = $1', [txId]);
  const { rows: [p] } = await client.query(
    `SELECT lp.*, COALESCE(l.name, l.lender) AS loan_name, l.segment AS loan_segment, l.is_segment_split AS loan_split,
            l.segment_grain_pct, l.segment_livestock_pct, l.segment_jake_pct, l.segment_ashley_pct
     FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id WHERE lp.id = $1`, [paymentId]);
  if (!tx || !p || tx.is_split || Number(tx.amount) >= 0) return false;
  if (await closedMonth(client, tx.date)) return false;
  const paid = -Number(tx.amount);
  const interest = Math.min(round2(Number(p.interest_amount) || 0), paid);
  const principal = round2(paid - interest);
  const interestCat = interest > 0 ? await expenseCategoryFor(client, 'Interest › Loan interest') : null;
  const owner = loanOwner(p) || ownerOf(tx); // the loan's owner split decides, not the payment entry's tag
  const pieces = [];
  if (interest > 0.005) pieces.push({ amount: -interest, category_id: interestCat, memo: `${LOAN_INTEREST_MEMO}${p.loan_name}`, is_transfer: false });
  if (principal > 0.005) pieces.push({ amount: -principal, category_id: null, memo: `${LOAN_PRINCIPAL_MEMO}${p.loan_name}`, is_transfer: true });
  if (!pieces.length) return false;
  for (const pc of pieces) {
    await client.query(
      `INSERT INTO transaction_splits (transaction_id, amount, category_id, memo, ledger, is_capex, is_transfer, ${SEG_COLS})
       VALUES ($1,$2,$3,$4,$5,false,$6,${SEGMENT_COLUMNS.map((_, i) => `$${7 + i}`).join(',')})`,
      [tx.id, pc.amount, pc.category_id, pc.memo, tx.ledger, pc.is_transfer, ...SEGMENT_COLUMNS.map((k) => owner[k])]);
  }
  await client.query('UPDATE transactions SET is_split = true, category_id = NULL WHERE id = $1', [tx.id]);
  return true;
}

// ---- Vendor owner rules -------------------------------------------------------

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A vendor's owner split, or null when it has none. */
export async function vendorOwner(client, payeeId) {
  if (!payeeId) return null;
  const { rows: [p] } = await client.query('SELECT * FROM payees WHERE id = $1', [payeeId]);
  if (!p || !(p.segment || p.is_segment_split)) return null;
  return ownerOf(p);
}

/** The vendor with an owner rule whose name appears in `text` (longest match), for bank lines that name it. */
export async function ruledVendorIn(client, text) {
  const t = normName(text);
  if (!t) return null;
  const { rows } = await client.query('SELECT id, name FROM payees WHERE segment IS NOT NULL OR is_segment_split');
  const hits = rows.filter((r) => normName(r.name).length >= 4 && t.includes(normName(r.name)))
    .sort((a, b) => normName(b.name).length - normName(a.name).length);
  return hits[0]?.id || null;
}

/**
 * Puts a transaction on its vendor's owner split: the entry itself, or —
 * if it's split by category — each piece that isn't a transfer. Transfers
 * and closed months are left alone. With `matchDescription`, an entry with
 * no vendor takes the ruled vendor its description names (a statement line
 * like "SASKPOWER PREAUTH"). Returns true if it changed anything.
 */
export async function applyVendorOwnerToTransaction(client, txId, { matchDescription = false } = {}) {
  const { rows: [tx] } = await client.query('SELECT * FROM transactions WHERE id = $1', [txId]);
  if (!tx || tx.is_transfer) return false;
  let payee = tx.payee_id;
  if (!payee && matchDescription) {
    payee = await ruledVendorIn(client, tx.description);
    if (payee) await client.query('UPDATE transactions SET payee_id = $2 WHERE id = $1', [tx.id, payee]);
  }
  const owner = await vendorOwner(client, payee);
  if (!owner || await closedMonth(client, tx.date)) return false;
  const ledger = ledgerForOwner(owner, tx.ledger || 'business');
  const cols = SEGMENT_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const vals = SEGMENT_COLUMNS.map((c) => owner[c]);
  await client.query(`UPDATE transactions SET ${cols}, ledger = $${vals.length + 2} WHERE id = $1`, [tx.id, ...vals, ledger]);
  if (tx.is_split) {
    await client.query(`UPDATE transaction_splits SET ${cols}, ledger = $${vals.length + 2} WHERE transaction_id = $1 AND NOT is_transfer`, [tx.id, ...vals, ledger]);
  }
  return true;
}

/** Puts a bill on its vendor's owner split. */
export async function applyVendorOwnerToBill(client, billId) {
  const { rows: [b] } = await client.query('SELECT id, payee_id, ledger FROM bills WHERE id = $1', [billId]);
  const owner = b && await vendorOwner(client, b.payee_id);
  if (!owner) return false;
  await client.query(
    `UPDATE bills SET ${SEGMENT_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ')}, ledger = $${SEGMENT_COLUMNS.length + 2} WHERE id = $1`,
    [b.id, ...SEGMENT_COLUMNS.map((c) => owner[c]), ledgerForOwner(owner, b.ledger || 'business')]);
  return true;
}

/** A loan's owner split as segment columns, or null when the loan has no owner set. */
function loanOwner(row) {
  const split = !!(row.loan_split ?? row.is_segment_split);
  const seg = row.loan_segment !== undefined ? row.loan_segment : row.segment;
  if (!split && !seg) return null;
  return ownerOf({ ...row, segment: seg, is_segment_split: split });
}

/**
 * Re-tags the interest and principal pieces of recorded loan payments with
 * their loan's owner split (after a loan's owner changes, and once at
 * startup for payments split before loans carried a split). Closed months
 * are left as filed.
 */
export async function syncLoanPieceOwners(client, loanId = null) {
  const { rows } = await client.query(
    `SELECT s.id, t.date, l.segment AS loan_segment, l.is_segment_split AS loan_split,
            l.segment_grain_pct, l.segment_livestock_pct, l.segment_jake_pct, l.segment_ashley_pct,
            s.segment, s.is_segment_split, s.segment_grain_pct AS s_g, s.segment_livestock_pct AS s_l,
            s.segment_jake_pct AS s_j, s.segment_ashley_pct AS s_a
     FROM transaction_splits s
     JOIN transactions t ON t.id = s.transaction_id
     JOIN loan_payments lp ON lp.linked_transaction_id = t.id
     JOIN loans l ON l.id = lp.loan_id
     WHERE (s.memo LIKE $1 OR s.memo LIKE $2) AND (l.segment IS NOT NULL OR l.is_segment_split)
       AND ($3::int IS NULL OR l.id = $3)`,
    [`${LOAN_INTEREST_MEMO}%`, `${LOAN_PRINCIPAL_MEMO}%`, loanId]);
  let n = 0;
  const closed = new Map();
  for (const r of rows) {
    const o = loanOwner(r);
    const same = (o.segment || null) === (r.segment || null) && !!o.is_segment_split === !!r.is_segment_split
      && [['segment_grain_pct', 's_g'], ['segment_livestock_pct', 's_l'], ['segment_jake_pct', 's_j'], ['segment_ashley_pct', 's_a']]
        .every(([k, c]) => Number(o[k] ?? -1) === Number(r[c] ?? -1));
    if (same) continue;
    const key = toISODate(r.date).slice(0, 7);
    if (!closed.has(key)) closed.set(key, !!(await closedMonth(client, r.date)));
    if (closed.get(key)) continue;
    await client.query(
      `UPDATE transaction_splits SET ${SEGMENT_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [r.id, ...SEGMENT_COLUMNS.map((c) => o[c])]);
    n++;
  }
  return n;
}

/** Takes the interest/principal pieces back off (the entry stops being a loan payment). */
export async function unsplitLoanPayment(client, txId) {
  await client.query(
    `DELETE FROM transaction_splits WHERE transaction_id = $1 AND (memo LIKE $2 OR memo LIKE $3)`,
    [txId, `${LOAN_INTEREST_MEMO}%`, `${LOAN_PRINCIPAL_MEMO}%`]);
  await client.query(
    `UPDATE transactions SET is_split = EXISTS (SELECT 1 FROM transaction_splits WHERE transaction_id = $1) WHERE id = $1`, [txId]);
}

/** Splits every recorded loan payment that isn't split yet (payments recorded before this existed). */
export async function splitAllLoanPayments(client) {
  const { rows } = await client.query(
    `SELECT lp.id, lp.linked_transaction_id FROM loan_payments lp JOIN transactions t ON t.id = lp.linked_transaction_id
     WHERE lp.paid AND NOT t.is_split`);
  let n = 0;
  for (const r of rows) if (await splitLoanPayment(client, r.linked_transaction_id, r.id)) n++;
  return n;
}

/**
 * Records money arriving for a contract (the Contracts tab's "Record
 * deposit", or a statement line the agent marked as this contract's
 * payment): a deposit into the account, counted toward the contract.
 * `amount` defaults to what's still to come.
 */
export async function settleContract(client, contractId, {
  account_id, date, amount = null, source = null, external_id = null, entered_by = 'manual', description = null,
}) {
  const { rows } = await client.query('SELECT * FROM sale_contracts WHERE id = $1 FOR UPDATE', [contractId]);
  if (!rows.length) return null;
  const contract = rows[0];
  if (contract.status === 'settled') return { contract, alreadyPaid: true, transaction: null };
  const remaining = Math.max(round2(Number(contract.total_value) - Number(contract.received_amount || 0)), 0);
  const received = Math.abs(Number(amount ?? remaining));
  if (!received) throw new PostingError('Nothing left to receive on this contract — enter the amount that arrived.');
  const tx = await insertTransaction(client, {
    account_id, ledger: ledgerForSegment(contract.segment), date, amount: received,
    description: description || `Contract payment: ${contract.commodity}${contract.counterparty ? ` — ${contract.counterparty}` : ''}`,
    owner: ownerOf({ segment: contract.segment }), source, external_id, entered_by, awaiting_statement: true,
    category_id: await incomeCategoryFor(client, contract.commodity), payee: contract.counterparty,
  });
  const r = await linkContractToTransaction(client, contract.id, tx.id, { createdHere: !source });
  return { contract: r.contract, transaction: tx };
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
