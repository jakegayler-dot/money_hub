// Every action that moves money goes through here — the UI's pay/record/
// settle buttons and agent statement ingest alike — so a bill paid by
// clicking "Pay" and a bill paid by matching a bank statement line produce
// exactly the same records. All functions take a DB client already inside
// a transaction (withTransaction) and never commit on their own.

import { SEGMENT_COLUMNS, segmentValues, validateSegment, ledgerForSegment } from './segments.js';
import { toISODate, addMonths } from './dates.js';

const SEG_COLS = SEGMENT_COLUMNS.join(', ');
const round2 = (n) => Math.round(Number(n) * 100) / 100;

export class PostingError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
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
  const owner = t.owner || ownerOf(t);
  const splits = t.splits || [];
  const cleared = t.cleared !== false;
  const { rows } = await client.query(
    `INSERT INTO transactions
      (account_id, credit_card_id, credit_card_statement_id, ledger, date, amount, description, category_id,
       purchase_class, is_mixed_use, mixed_use_business_pct, is_capex, is_debt_service, is_transfer, is_split,
       entered_by, cleared, cleared_date, source, external_id, needs_review, review_note, ${SEG_COLS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
             ${SEGMENT_COLUMNS.map((_, i) => `$${23 + i}`).join(',')})
     RETURNING *`,
    [t.account_id || null, t.credit_card_id || null, t.credit_card_statement_id || null,
     t.ledger || ledgerForOwner(owner), t.date, round2(t.amount), t.description || null, t.category_id || null,
     t.purchase_class || null, !!t.is_mixed_use, t.mixed_use_business_pct ?? null,
     !!t.is_capex, !!t.is_debt_service, !!t.is_transfer, splits.length > 0,
     t.entered_by || 'manual', cleared, cleared ? t.date : null, t.source || null, t.external_id || null,
     !!t.needs_review, t.needs_review ? (t.review_note || null) : null,
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
  if (tx.account_id) {
    await client.query('UPDATE accounts SET opening_balance = opening_balance - $1 WHERE id = $2', [tx.amount, tx.account_id]);
  }
  await client.query('DELETE FROM transactions WHERE id = $1', [txId]);
  for (const s of stmts) await recomputeCardStatement(client, s.id);
  if (tx.credit_card_id && tx.account_id) await reclassifyCardPayments(client, tx.credit_card_id);
  return tx;
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
      category_id: await categoryIdByName(client, bill.category),
      owner: ownerOf(bill), cleared: !paid_by_check, source, external_id, entered_by,
    });
  }
  await client.query(
    `UPDATE bills SET status = 'paid', paid_date = $1, linked_transaction_id = $2 WHERE id = $3`,
    [date, tx ? tx.id : null, bill.id]
  );

  let nextBill = null;
  if (bill.frequency === 'monthly' || bill.frequency === 'quarterly') {
    const nextDue = addMonths(toISODate(bill.due_date), bill.frequency === 'monthly' ? 1 : 3);
    const { rows: next } = await client.query(
      `INSERT INTO bills
        (name, ledger, category, amount, frequency, due_date, status, notes, has_gst, gst_pct, gst_amount, subtotal_amount, ${SEG_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,'unpaid',$7,$8,$9,$10,$11,${SEGMENT_COLUMNS.map((_, i) => `$${12 + i}`).join(',')}) RETURNING *`,
      [bill.name, bill.ledger, bill.category, bill.amount, bill.frequency, nextDue, bill.notes,
       bill.has_gst, bill.gst_pct, bill.gst_amount, bill.subtotal_amount, ...segmentValues(bill)]
    );
    nextBill = next[0];
  }
  return { bill: { ...bill, status: 'paid', paid_date: date, linked_transaction_id: tx?.id ?? null }, transaction: tx, nextBill };
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
    is_debt_service: true, owner: ownerOf({ segment: payment.segment }),
    cleared: !paid_by_check, source, external_id, entered_by,
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
    owner: ownerOf({ segment: contract.segment }), source, external_id, entered_by,
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

  let stmtId = statement_id;
  if (!stmtId) {
    const { rows } = await client.query(
      `SELECT id FROM credit_card_statements
       WHERE credit_card_id = $1 AND COALESCE(statement_date, due_date) <= $2
       ORDER BY COALESCE(statement_date, due_date) DESC, id DESC LIMIT 1`,
      [cardId, date]
    );
    // Only attach to it if that latest cycle is still open.
    if (rows.length) {
      const { rows: open } = await client.query('SELECT paid FROM credit_card_statements WHERE id = $1', [rows[0].id]);
      if (!open[0].paid) stmtId = rows[0].id;
    }
  }

  const tx = await insertTransaction(client, {
    account_id, credit_card_id: card.id, credit_card_statement_id: stmtId,
    ledger: ledgerForSegment(card.segment), date, amount: -pay,
    description: `Credit card payment: ${card.name}${paid_by_check ? ' (check)' : ''}`,
    owner: ownerOf({ segment: card.segment }),
    cleared: !paid_by_check, source, external_id, entered_by,
  });
  await reclassifyCardPayments(client, card.id);
  const statement = stmtId ? await recomputeCardStatement(client, stmtId) : null;
  return { transaction: tx, statement };
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
