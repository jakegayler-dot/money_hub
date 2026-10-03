// Decides what one statement line means and records it. Order matters:
//
//   1. Validate. Anything unusable or uncertain is HELD for review, never
//      guessed at — an agent that sent a bad category or a split that
//      doesn't add up gets told why, and nothing touches a balance.
//   2. Is this money already on file? An uncleared check it clears, or a
//      manual entry it duplicates, is MATCHED (claimed) — never posted twice.
//      This runs before bill/loan matching on purpose: a bill paid by hand
//      last week must not make its bank line pay next month's bill.
//   3. By kind: bill / loan / card / contract payments are linked to the
//      scheduled item through the same functions the UI buttons use, so the
//      item closes (and a recurring bill rolls forward). Transfers pair
//      with their other side. One clear match proceeds; zero or several
//      are held with the candidates listed.
//   4. Otherwise post it as a plain transaction (with its split pieces).

import { validateSegment } from './segments.js';
import { toISODate } from './dates.js';
import { closedMonth, monthLabel } from './periods.js';
import {
  insertTransaction, ownerOf, ledgerForOwner, normalizeSplits, payBill, recordLoanPayment,
  settleContract, payCard, PostingError, payeeId, cleanGst,
} from './postings.js';

export const KINDS = ['standard', 'bill_payment', 'loan_payment', 'card_payment', 'contract_payment', 'transfer', 'owner_draw'];

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const fmt = (n) => `$${Math.abs(Number(n)).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Loose name match between an agent's payee/description and a record's name fields. */
export function textMatches(hint, ...fields) {
  const h = norm(hint);
  if (!h) return false;
  const tokens = h.split(' ').filter((t) => t.length >= 4);
  return fields.some((f) => {
    const n = norm(f);
    if (!n) return false;
    if (n.includes(h) || h.includes(n)) return true;
    const nt = new Set(n.split(' '));
    return tokens.some((t) => nt.has(t));
  });
}

/** Narrows candidates to those named in the line; returns { list, byName } (byName = the name actually matched). */
function narrow(cands, hint, fields) {
  if (!cands.length || !hint) return { list: cands, byName: false };
  const hit = cands.filter((c) => textMatches(hint, ...fields(c)));
  return hit.length ? { list: hit, byName: true } : { list: cands, byName: false };
}

async function categoryId(client, name, cache) {
  const key = String(name).trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const { rows } = await client.query('SELECT id FROM expense_categories WHERE lower(name) = $1 LIMIT 1', [key]);
  const id = rows[0]?.id || null;
  cache.set(key, id);
  return id;
}

async function claim(client, txId, { source, external_id }, { clearOn = null } = {}) {
  await client.query(
    `UPDATE transactions SET
       source = COALESCE(source, $1),
       external_id = COALESCE(external_id, $2),
       awaiting_statement = false,
       cleared = CASE WHEN $3::date IS NOT NULL THEN true ELSE cleared END,
       cleared_date = CASE WHEN $3::date IS NOT NULL THEN $3::date ELSE cleared_date END
     WHERE id = $4`,
    [source, external_id, clearOn, txId]
  );
}

const txCandidate = (t) => ({
  type: 'transaction', id: t.id, date: toISODate(t.date), amount: Number(t.amount), label: t.description || `Transaction #${t.id}`,
});

/**
 * Processes one line. `target` = { type: 'account' | 'card', row }.
 * `payload` is the line as the agent sent it, merged with any reviewer
 * overrides; `approved` = a human approved it (skips the agent's own
 * needs_review flag). Returns { status: posted|matched|held, reason,
 * candidates, transaction_id, note }.
 */
export async function processLine(client, args) {
  const out = await processLineInner(client, args);
  // Who was paid / who paid: the agent's `party` (or `payee`) goes on the
  // transaction the line posted or matched, unless it already has one.
  const p = args.payload || {};
  // GST from the receipt fills in on a transaction that has none recorded.
  if (p.gst != null && out.transaction_id && (out.status === 'posted' || out.status === 'matched')) {
    await client.query('UPDATE transactions SET gst_amount = COALESCE(gst_amount, $1) WHERE id = $2',
      [cleanGst(p.gst, p.amount), out.transaction_id]);
  }
  const party = p.party || p.payee;
  if ((p.payee_id || party) && out.transaction_id && (out.status === 'posted' || out.status === 'matched')) {
    // A reviewer's pick (payee_id) replaces whatever was there; the agent's name only fills a blank.
    if (p.payee_id) {
      await client.query('UPDATE transactions SET payee_id = $1 WHERE id = $2', [Number(p.payee_id), out.transaction_id]);
    } else {
      await client.query('UPDATE transactions SET payee_id = COALESCE(payee_id, $1) WHERE id = $2',
        [await payeeId(client, party), out.transaction_id]);
    }
  }
  return out;
}

async function processLineInner(client, { target, source, external_id, payload: p, approved = false, historical = false, categoryCache = new Map() }) {
  const isCard = target.type === 'card';
  const T = target.row;
  const date = toISODate(p.date);
  const amount = round2(p.amount);
  let kind = p.kind || 'standard';
  const hint = p.payee || p.description || '';
  // On a card statement, "PAYMENT — THANK YOU" (money in) is the card side
  // of a payment from the bank, whatever kind the agent tagged it.
  if (target.type === 'card' && Number(p.amount) > 0 && ['standard', 'transfer'].includes(kind)
      && /(^|[^a-z])(payment|paiement|pymt|pmt)([^a-z]|$)/i.test(`${p.description || ''} ${p.payee || ''}`)) {
    kind = 'card_payment';
  }
  const stamp = { source, external_id, entered_by: 'agent' };
  const hold = (reason, candidates = null) => ({ status: 'held', reason, candidates });
  const posted = (tx, note) => ({ status: 'posted', transaction_id: tx.id, note });
  const matched = (txId, note) => ({ status: 'matched', transaction_id: txId, note });

  // ---- 1. Validate ----------------------------------------------------------
  if (!KINDS.includes(kind)) return hold(`Unknown kind "${kind}". Use one of: ${KINDS.join(', ')}.`);
  const segErr = validateSegment(p);
  if (segErr) return hold(segErr);
  const owner = ownerOf(p, T);
  const ledger = p.ledger || ledgerForOwner(owner, T.ledger || 'business');

  let category_id = p.category_id || null;
  if (!category_id && p.category) {
    category_id = await categoryId(client, p.category, categoryCache);
    if (!category_id) return hold(`Unknown category "${p.category}". Create it on the Expenses tab, or approve with an existing category.`);
  }
  let pieces = [];
  if (Array.isArray(p.splits) && p.splits.length) {
    pieces = [];
    for (const [i, s] of p.splits.entries()) {
      let cid = s.category_id || null;
      if (!cid && s.category) {
        cid = await categoryId(client, s.category, categoryCache);
        if (!cid) return hold(`Split piece ${i + 1}: unknown category "${s.category}".`);
      }
      pieces.push({ ...s, category_id: cid });
    }
  }
  const { splits, error: splitErr } = normalizeSplits(pieces, amount, owner, ledger);
  if (splitErr) return hold(splitErr);

  // A closed month takes nothing new — not even from a re-sent statement.
  const closed = await closedMonth(client, date);
  if (closed) return hold(`${monthLabel(closed)} is closed on the Books tab. Reopen it to post this line, or reject it.`);

  if (p.needs_review && !approved) {
    return hold(p.review_note ? `Flagged by the agent: ${p.review_note}` : 'Flagged by the agent for review.');
  }

  // Reviewer said: this line IS that existing transaction.
  if (p.match_transaction_id) {
    const { rows } = await client.query('SELECT * FROM transactions WHERE id = $1', [p.match_transaction_id]);
    const tx = rows[0];
    if (!tx) return hold(`Transaction #${p.match_transaction_id} doesn't exist.`);
    if (tx.external_id && !(tx.source === source && tx.external_id === external_id)) {
      return hold(`Transaction #${tx.id} is already matched to a different statement line.`);
    }
    await claim(client, tx.id, stamp, { clearOn: !tx.cleared ? date : null });
    return matched(tx.id, `Linked to existing transaction #${tx.id}`);
  }

  const cardSidePayment = isCard && kind === 'card_payment';

  // ---- 2. Already on file? ---------------------------------------------------
  if (!p.post_as_new && !cardSidePayment) {
    if (!isCard) {
      const { rows: checks } = await client.query(
        `SELECT * FROM transactions
         WHERE account_id = $1 AND cleared = false AND external_id IS NULL
           AND abs(amount - $2) < 0.005 AND date BETWEEN $3::date - 180 AND $3::date + 3
         ORDER BY date`,
        [T.id, amount, date]
      );
      if (checks.length === 1) {
        await claim(client, checks[0].id, stamp, { clearOn: date });
        return matched(checks[0].id, `Cleared outstanding check: ${checks[0].description || `#${checks[0].id}`}`);
      }
      if (checks.length > 1) {
        return hold(`${checks.length} outstanding checks for ${fmt(amount)} — which one cleared?`, checks.map(txCandidate));
      }
    }
    const { rows: dups } = await client.query(
      `SELECT * FROM transactions
       WHERE ${isCard ? 'credit_card_id = $1 AND account_id IS NULL' : 'account_id = $1'}
         AND external_id IS NULL AND abs(amount - $2) < 0.005
         AND date BETWEEN $3::date - 7 AND $3::date + 7
       ORDER BY abs(date - $3::date)`,
      [T.id, amount, date]
    );
    if (dups.length === 1) {
      await claim(client, dups[0].id, stamp);
      return matched(dups[0].id, `Already on file: ${dups[0].description || `transaction #${dups[0].id}`}`);
    }
    if (dups.length > 1) {
      return hold(`${dups.length} transactions for ${fmt(amount)} already on file near ${date} — which one is this, or is it new?`, dups.map(txCandidate));
    }
  }

  const where = isCard ? { credit_card_id: T.id } : { account_id: T.id };
  const plain = { ...stamp, ...where, date, amount, description: p.description, category_id, owner, ledger, splits, is_capex: !!p.is_capex,
    gst_amount: p.gst ?? null };

  // ---- 3. By kind -------------------------------------------------------------
  try {
    switch (kind) {
      case 'standard':
        // "ONLINE BANKING PAYMENT — CAPITAL ONE" sent as plain spending:
        // money out of a bank account naming exactly one of your cards is a
        // payment on that card, not an expense (unless a person approving
        // it chose plain spending).
        if (!isCard && amount < 0 && !approved && !p.category && !p.category_id && !splits.length) {
          const { rows: cards } = await client.query(`SELECT * FROM credit_cards WHERE status = 'active'`);
          // Strict: the card's whole name or issuer (or its last 4) AND a
          // payment word — "FARM STORE" must not pay a card called Farm Visa.
          const h = ` ${norm(`${p.description || ''} ${p.payee || ''}`)} `;
          const paying = /\b(payment|pmt|pymt|paymt|bill pay)\b/.test(h);
          const named = !paying ? [] : cards.filter((c) => [c.name, c.issuer].some((f) => norm(f) && h.includes(` ${norm(f)} `))
            || (c.last4 && h.includes(` ${c.last4} `)));
          if (named.length === 1) {
            const r = await payCard(client, named[0].id, { account_id: T.id, date, amount: -amount, ...stamp });
            return posted(r.transaction, `Card payment to ${named[0].name} (recognized from the description)`);
          }
          if (named.length > 1) {
            return hold(`Looks like a payment to a credit card, but ${named.length} cards fit "${hint}" — which one?`,
              named.map((c) => ({ type: 'card', id: c.id, label: `${c.name}${c.last4 ? ` ••${c.last4}` : ''}` })));
          }
        }
        // A person approving money in must say what kind of income it is.
        if (approved && amount > 0 && !category_id && !splits.length) {
          return hold('Pick an income category for this deposit (e.g. Grain sales › Canola sales).');
        }
        return posted(await insertTransaction(client, plain));

      case 'bill_payment': {
        if (amount >= 0) return hold('A bill payment should be money going out (a negative amount).');
        const pay = (id) => payBill(client, id, { ...where, date, amount: -amount, ...stamp });
        if (p.bill_id) {
          const r = await pay(p.bill_id);
          if (!r) return hold(`Bill #${p.bill_id} doesn't exist.`);
          if (r.alreadyPaid) return hold(`Bill "${r.bill.name}" is already paid.`);
          return posted(r.transaction, `Paid bill: ${r.bill.name}${r.nextBill ? ` (next due ${toISODate(r.nextBill.due_date)})` : ''}`);
        }
        const { rows } = await client.query(
          `SELECT * FROM bills WHERE status = 'unpaid'
             AND (abs(amount - $1) < 0.005 OR (is_financed AND $1 BETWEEN amount - 1 AND bill_owing(bills, $2::date) * 1.02 + 5))
             AND (due_date BETWEEN $2::date - 45 AND $2::date + 45
                  OR (is_financed AND $2::date BETWEEN COALESCE(received_date, due_date - 365) AND due_date + 180))
           ORDER BY due_date`,
          [-amount, date]
        );
        const { list } = narrow(rows, hint, (b) => [b.name, b.category]);
        const billCand = (b) => ({ type: 'bill', id: b.id, label: b.name, amount: -Number(b.amount), date: toISODate(b.due_date) });
        if (list.length === 1) {
          const r = await pay(list[0].id);
          return posted(r.transaction, `Paid bill: ${r.bill.name}${r.nextBill ? ` (next due ${toISODate(r.nextBill.due_date)})` : ''}`);
        }
        if (list.length > 1) return hold(`${list.length} unpaid bills for ${fmt(amount)} — which one was paid?`, list.map(billCand));
        if (historical) return posted(await insertTransaction(client, plain), 'Historical bill payment — no bill on file, posted as an expense');
        const { rows: near } = await client.query(
          `SELECT * FROM bills WHERE status = 'unpaid' AND due_date BETWEEN $1::date - 45 AND $1::date + 45
           ORDER BY abs(amount - $2) LIMIT 5`,
          [date, -amount]
        );
        return hold(`No unpaid bill for ${fmt(amount)} due within 45 days of ${date}. Pick the bill it paid, or post it as a plain expense.`, near.map(billCand));
      }

      case 'loan_payment': {
        if (isCard) return hold('Loan payments are recorded from the bank account that made them, not a card.');
        if (amount >= 0) return hold('A loan payment should be money going out (a negative amount).');
        const rec = (id) => recordLoanPayment(client, id, { account_id: T.id, date, amount: -amount, ...stamp });
        if (p.loan_payment_id) {
          const r = await rec(p.loan_payment_id);
          if (!r) return hold(`Loan payment #${p.loan_payment_id} doesn't exist.`);
          if (r.alreadyPaid) return hold('That scheduled loan payment is already recorded.');
          return posted(r.transaction, 'Recorded loan payment');
        }
        const sql = `SELECT lp.*, l.name AS loan_name, l.lender FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
                     WHERE lp.paid = false AND lp.is_adjustment = false`;
        const { rows } = await client.query(
          `${sql} AND abs(lp.principal_amount + lp.interest_amount - $1) < 0.005
             AND lp.due_date BETWEEN $2::date - 20 AND $2::date + 20 ORDER BY lp.due_date`,
          [-amount, date]
        );
        const { list } = narrow(rows, hint, (x) => [x.loan_name, x.lender]);
        const loanCand = (x) => ({
          type: 'loan_payment', id: x.id, label: x.loan_name || x.lender, date: toISODate(x.due_date),
          amount: -(Number(x.principal_amount) + Number(x.interest_amount)),
        });
        if (list.length === 1) {
          const r = await rec(list[0].id);
          return posted(r.transaction, `Recorded loan payment: ${list[0].loan_name || list[0].lender}`);
        }
        if (list.length > 1) return hold(`${list.length} scheduled loan payments for ${fmt(amount)} — which loan?`, list.map(loanCand));
        if (historical) {
          return posted(
            await insertTransaction(client, { ...plain, splits: [], category_id: null, is_debt_service: true }),
            'Historical loan payment — no schedule entry on file, recorded as debt service'
          );
        }
        const { rows: near } = await client.query(
          `${sql} AND lp.due_date BETWEEN $1::date - 20 AND $1::date + 20
           ORDER BY abs(lp.principal_amount + lp.interest_amount - $2) LIMIT 5`,
          [date, -amount]
        );
        return hold(`No scheduled loan payment for ${fmt(amount)} due within 20 days of ${date}. Pick the payment it was (the actual amount is used), or post it another way.`, near.map(loanCand));
      }

      case 'contract_payment': {
        if (isCard) return hold('Contract payments land in a bank account, not a card.');
        if (amount <= 0) return hold('A contract payment should be money coming in (a positive amount).');
        const settle = (id) => settleContract(client, id, { account_id: T.id, date, amount, description: p.description || null, ...stamp });
        if (p.contract_id) {
          const r = await settle(p.contract_id);
          if (!r) return hold(`Contract #${p.contract_id} doesn't exist.`);
          if (r.alreadyPaid) return hold('That contract is already settled.');
          return posted(r.transaction, `Payment toward contract: ${r.contract.commodity}${r.contract.status === 'settled' ? ' — now settled' : ''}`);
        }
        // A contract is often paid in several deposits, each net of
        // checkoff — so any deposit up to what's left on a contract is a
        // candidate. The buyer named in the line (or an exact match to
        // what's left) decides on its own; otherwise a person picks.
        const { rows } = await client.query(
          `SELECT *, GREATEST(total_value - received_amount, 0) AS remaining FROM sale_contracts WHERE status IN ('open', 'delivered')
             AND expected_payment_date BETWEEN $1::date - 150 AND $1::date + 180
             AND $2 <= GREATEST(total_value - received_amount, 0) * 1.03 + 1
           ORDER BY abs(GREATEST(total_value - received_amount, 0) - $2)`,
          [date, amount]
        );
        const contractCand = (c) => ({
          type: 'contract', id: c.id, label: `${c.commodity}${c.counterparty ? ` — ${c.counterparty}` : ''}`,
          amount: Number(c.remaining), date: toISODate(c.expected_payment_date),
        });
        const exact = rows.filter((c) => Math.abs(Number(c.remaining) - amount) < 0.005);
        const { list, byName } = narrow(rows, hint, (c) => [c.counterparty, c.commodity]);
        const pick = exact.length === 1 ? exact[0] : (byName && list.length === 1 ? list[0] : null);
        if (pick) {
          const r = await settle(pick.id);
          return posted(r.transaction, `Payment toward contract: ${pick.commodity}${pick.counterparty ? ` — ${pick.counterparty}` : ''}${r.contract.status === 'settled' ? ' — now settled' : ''}`);
        }
        if (rows.length) return hold(`Deposit of ${fmt(amount)} looks like a contract payment — which contract is it toward?`, rows.slice(0, 5).map(contractCand));
        if (historical) return posted(await insertTransaction(client, plain), 'Historical settlement — no contract on file, posted as income');
        return hold(`No open contract near ${fmt(amount)} expected around ${date}. Post it as plain income if it wasn't under contract.`);
      }

      case 'card_payment': {
        if (!isCard) {
          if (amount >= 0) return hold('A card payment from a bank account should be money going out (a negative amount).');
          const { rows: cards } = await client.query(`SELECT * FROM credit_cards WHERE status = 'active' ORDER BY id`);
          let found = [];
          if (p.credit_card_id) found = cards.filter((c) => c.id === Number(p.credit_card_id));
          else if (p.card_last4) found = cards.filter((c) => c.last4 && c.last4 === String(p.card_last4));
          else {
            found = cards.filter((c) => textMatches(hint, c.name, c.issuer)
              || (c.last4 && String(hint).includes(c.last4)));
          }
          if (found.length === 1) {
            const r = await payCard(client, found[0].id, { account_id: T.id, date, amount: -amount, ...stamp });
            return posted(r.transaction, `Paid ${found[0].name}${r.statement ? (r.statement.paid ? ' — statement paid' : ` — ${fmt(Number(r.statement.statement_balance) - Number(r.statement.paid_amount || 0))} still due`) : ''}`);
          }
          const pool_ = found.length ? found : cards;
          return hold(
            found.length ? `Several cards match "${hint}" — which one was paid?` : `Couldn't tell which card was paid from "${hint}". Send card_last4, or pick the card.`,
            pool_.map((c) => ({ type: 'card', id: c.id, label: `${c.name}${c.last4 ? ` ••${c.last4}` : ''}` }))
          );
        }
        // Card side: "PAYMENT — THANK YOU". The money is recorded from the
        // bank side; this line only confirms it arrived.
        if (amount <= 0) return hold('A payment received on a card should be a positive amount (it lowers the balance).');
        const { rows } = await client.query(
          `SELECT t.* FROM transactions t
           WHERE t.credit_card_id = $1 AND t.account_id IS NOT NULL AND abs(t.amount + $2) < 0.005
             AND t.date BETWEEN $3::date - 10 AND $3::date + 3
             AND NOT EXISTS (SELECT 1 FROM statement_lines sl
                             WHERE sl.transaction_id = t.id AND sl.credit_card_id IS NOT NULL
                               AND NOT (sl.source = $4 AND sl.external_id = $5))
           ORDER BY abs(t.date - $3::date)`,
          [T.id, amount, date, source, external_id]
        );
        if (rows.length >= 1) return matched(rows[0].id, 'Payment already recorded from the bank side');
        if (p.from_account_id) {
          const r = await payCard(client, T.id, { account_id: Number(p.from_account_id), date, amount, ...stamp });
          if (!r) return hold('Card not found.');
          return posted(r.transaction, 'Recorded payment from the paying account');
        }
        // No bank side yet: record it on the card so what's owed is right
        // now; it folds into the bank-side payment when that statement
        // arrives (pairCardPayments).
        return posted(await insertTransaction(client, { ...plain, splits: [], category_id: null, is_transfer: true }),
          'Payment received on the card — pairs with the bank-side payment when that statement comes in');
      }

      case 'transfer':
      case 'owner_draw': {
        if (isCard) return hold('Transfers are recorded from the bank-account side.');
        if (kind === 'owner_draw' && amount >= 0) return hold('An owner draw should be money going out of the business account (a negative amount).');
        let cp = null;
        if (p.counterparty_account_id || p.counterparty_last4) {
          const { rows } = p.counterparty_account_id
            ? await client.query('SELECT * FROM accounts WHERE id = $1', [p.counterparty_account_id])
            : await client.query('SELECT * FROM accounts WHERE last4 = $1', [String(p.counterparty_last4)]);
          if (rows.length !== 1) return hold(`Couldn't identify the other account (${p.counterparty_account_id ? `#${p.counterparty_account_id}` : `ending ${p.counterparty_last4}`}).`);
          cp = rows[0];
          if (cp.id === T.id) return hold('A transfer needs two different accounts.');
        }
        const { rows: peers } = await client.query(
          `SELECT t.* FROM transactions t
           WHERE t.account_id IS NOT NULL AND t.account_id <> $1 ${cp ? 'AND t.account_id = $4' : ''}
             AND t.is_transfer AND t.transfer_peer_id IS NULL AND abs(t.amount + $2) < 0.005
             AND t.date BETWEEN $3::date - 5 AND $3::date + 5
             AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.transfer_peer_id = t.id)`,
          cp ? [T.id, amount, date, cp.id] : [T.id, amount, date]
        );
        if (peers.length > 1) return hold(`${peers.length} unpaired transfers for ${fmt(amount)} could be the other side — which one?`, peers.map(txCandidate));
        const side = await insertTransaction(client, { ...plain, splits: [], category_id: null, is_transfer: true });
        let note = 'Transfer recorded';
        if (peers.length === 1) {
          await client.query('UPDATE transactions SET transfer_peer_id = $1 WHERE id = $2', [peers[0].id, side.id]);
          await client.query('UPDATE transactions SET transfer_peer_id = $1 WHERE id = $2', [side.id, peers[0].id]);
          note = 'Transfer paired with its other side already on file';
        } else if (cp) {
          const other = await insertTransaction(client, {
            account_id: cp.id, date, amount: -amount, is_transfer: true, entered_by: 'agent',
            description: `${amount < 0 ? 'Transfer from' : 'Transfer to'} ${T.name}${p.description ? ` — ${p.description}` : ''}`,
            owner: ownerOf({}, cp), ledger: cp.ledger,
          });
          await client.query('UPDATE transactions SET transfer_peer_id = $1 WHERE id = $2', [other.id, side.id]);
          await client.query('UPDATE transactions SET transfer_peer_id = $1 WHERE id = $2', [side.id, other.id]);
          note = `Transfer recorded on both ${T.name} and ${cp.name}`;
        }
        if (kind === 'owner_draw') {
          await client.query(
            'INSERT INTO owner_draws (date, amount, note, linked_transaction_id) VALUES ($1, $2, $3, $4)',
            [date, -amount, p.description || null, side.id]
          );
          note = `Owner draw — ${note.charAt(0).toLowerCase()}${note.slice(1)}`;
        }
        return posted(side, note);
      }
      default:
        return hold(`Unhandled kind ${kind}.`);
    }
  } catch (err) {
    if (err instanceof PostingError || err.status === 409) return hold(err.message);
    throw err;
  }
}

/**
 * Reconciliation for one import: does Money Hub's balance at the
 * statement's closing date equal the statement's closing balance? A gap
 * equal to the held lines' total means everything else is in and approving
 * the queue closes it.
 */
export async function reconcileImport(db, imp) {
  if (imp.closing_balance == null || !imp.period_end) return null;
  const end = toISODate(imp.period_end);
  let computed = null;
  if (imp.account_id) {
    const { rows: [r] } = await db.query(
      `SELECT a.opening_balance
              - COALESCE((SELECT SUM(amount) FROM transactions WHERE account_id = a.id AND date > $2), 0)
              - COALESCE((SELECT SUM(amount) FROM transactions WHERE account_id = a.id AND date <= $2
                            AND (cleared = false OR cleared_date > $2)), 0)
              AS balance
       FROM accounts a WHERE a.id = $1`,
      [imp.account_id, end]
    );
    computed = r ? Number(r.balance) : null;
  } else if (imp.credit_card_id) {
    const { rows: [r] } = await db.query(
      `SELECT c.ledger_start_date, c.ledger_opening_balance
              + COALESCE((SELECT SUM(CASE WHEN t.account_id IS NULL THEN -t.amount ELSE t.amount END)
                          FROM transactions t
                          WHERE t.credit_card_id = c.id AND t.date >= c.ledger_start_date AND t.date <= $2), 0) AS balance
       FROM credit_cards c WHERE c.id = $1`,
      [imp.credit_card_id, end]
    );
    if (r && r.ledger_start_date && toISODate(r.ledger_start_date) <= end) computed = Number(r.balance);
  }
  if (computed == null) return null;

  const { rows: [h] } = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM statement_lines WHERE import_id = $1 AND status = 'held'`,
    [imp.id]
  );
  // A held card purchase (negative) would RAISE the card balance once posted.
  const heldEffect = round2(imp.credit_card_id ? -Number(h.total) : Number(h.total));
  const difference = round2(Number(imp.closing_balance) - computed);
  return {
    statement_closing: Number(imp.closing_balance),
    money_hub_balance: round2(computed),
    difference,
    reconciled: Math.abs(difference) < 0.01,
    held_count: Number(h.n),
    held_effect: heldEffect,
    explained_by_held: Number(h.n) > 0 && Math.abs(difference - heldEffect) < 0.01,
  };
}

