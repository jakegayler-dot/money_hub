// A sale contract's life, as the money sees it:
//
//   open        grain still to haul: it's in the bin (inventory, at the
//               contract price) and the money comes at the period's end
//   delivered   hauled — filled in Quarter Section (status "delivered" or
//               "filled", every bushel delivered, or its delivery date has
//               passed): the grain is gone and the money is owed to the
//               farm (a receivable), expected PAYMENT_DAYS after delivery
//   confirmed   the buyer's settlement ticket is in (one per load): its
//               net is what's coming, SETTLEMENT_DAYS after the ticket's date
//   settled     the money is in the bank (deposits linked)
//
// A partly hauled contract is both: the hauled part owed in PAYMENT_DAYS,
// the rest still in the bin.

import { toISODate, addDays, todayISO } from './dates.js';
import { textMatches } from './statementIngest.js';

export const PAYMENT_DAYS = 14;
export const SETTLEMENT_DAYS = 3;

// What a source may call each status.
const STATUS_WORDS = {
  open: ['open', 'active', 'unfilled', 'pending', 'booked', 'priced', 'unpriced', 'partial', 'partially filled', 'partially delivered', 'in progress'],
  delivered: ['delivered', 'filled', 'fulfilled', 'complete', 'completed', 'closed', 'hauled', 'done', 'settled', 'paid', 'awaiting payment'],
  cancelled: ['cancelled', 'canceled', 'void', 'voided', 'rolled', 'bought back'],
};

/** A source's status word as Money Hub's, or null if it isn't one we know. */
export function contractStatus(word) {
  const w = String(word ?? 'open').trim().toLowerCase().replace(/[_-]+/g, ' ');
  for (const [s, words] of Object.entries(STATUS_WORDS)) if (words.includes(w)) return s;
  return null;
}

/**
 * The money still to come on a contract, as dated pieces, earliest first:
 *   ticketed   settlement tickets in: their net, SETTLEMENT_DAYS after the latest
 *   hauled     delivered but no ticket yet: the contract value of those
 *              bushels, PAYMENT_DAYS after delivery
 *   open       still to haul: the rest, at the contract's payment date
 * Money already received comes off the earliest pieces first.
 * Each piece: { amount, date, part }.
 */
export function contractParts(c, today = todayISO()) {
  const total = Number(c.total_value) || 0;
  const q = Number(c.quantity) || 0;
  const ticketNet = c.settlement_net != null ? Number(c.settlement_net) : 0;
  const ticketQty = Number(c.settlement_quantity) || 0;
  const delivered = c.status === 'delivered';
  const pieces = [];
  const ticketDate = c.settlement_date ? maxDate(addDays(toISODate(c.settlement_date), SETTLEMENT_DAYS), today) : null;
  const haulDate = maxDate(addDays(toISODate(c.delivery_date) || toISODate(c.delivered_on) || today, PAYMENT_DAYS), today);
  const due = toISODate(c.expected_payment_date) || today;
  if (q > 0) {
    const hauledQty = Math.min(q, Math.max(Number(c.quantity_delivered) || 0, ticketQty, delivered ? q : 0));
    // A ticket with no quantity on it stands for everything hauled.
    const ticketCovers = ticketNet > 0 ? (ticketQty > 0 ? Math.min(ticketQty, hauledQty || ticketQty) : hauledQty || q) : 0;
    if (ticketNet > 0) pieces.push({ amount: ticketNet, date: ticketDate, part: 'ticketed' });
    const hauledNoTicket = Math.max(0, hauledQty - ticketCovers);
    if (hauledNoTicket > 0) pieces.push({ amount: total * hauledNoTicket / q, date: haulDate, part: 'hauled' });
    const openQty = Math.max(0, q - Math.max(hauledQty, ticketCovers));
    if (openQty > 0) pieces.push({ amount: total * openQty / q, date: due, part: 'open' });
  } else if (ticketNet > 0) {
    pieces.push({ amount: ticketNet, date: ticketDate, part: 'ticketed' });
  } else {
    pieces.push({ amount: total, date: delivered ? haulDate : due, part: delivered ? 'hauled' : 'open' });
  }
  let received = Number(c.received_amount) || 0;
  for (const p of pieces) {
    const take = Math.min(received, p.amount);
    p.amount -= take;
    received -= take;
  }
  return pieces.map((p) => ({ ...p, amount: round2(p.amount) })).filter((p) => p.amount > 0.005);
}

const maxDate = (a, b) => (a > b ? a : b);
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// The payment-date rule for contracts from a source (manual ones keep the
// date a person typed). Delivered: the settlement ticket's date +
// SETTLEMENT_DAYS once it's in, else delivery + PAYMENT_DAYS. Open: the
// scheduled delivery + PAYMENT_DAYS, else the period's last day.
export const PAYMENT_DATE_SQL = `CASE WHEN status = 'delivered'
  THEN COALESCE(settlement_date + ${SETTLEMENT_DAYS}, COALESCE(delivery_date, delivered_on) + ${PAYMENT_DAYS}, contract_period_end)
  ELSE COALESCE(delivery_date + ${PAYMENT_DAYS}, contract_period_end) END`;

/**
 * Keeps every source contract's status and payment date on the rule: an
 * open one whose delivery date has passed (or every bushel hauled) is
 * delivered. Run after each push and on startup. Returns rows changed.
 */
export async function applyContractRules(db) {
  const a = await db.query(
    `UPDATE sale_contracts SET status = 'delivered', delivered_on = COALESCE(delivered_on, delivery_date, CURRENT_DATE)
     WHERE source != 'manual' AND status = 'open'
       AND ((delivery_date IS NOT NULL AND delivery_date <= CURRENT_DATE)
            OR (quantity > 0 AND quantity_delivered >= quantity * 0.995))`);
  const b = await db.query(
    `UPDATE sale_contracts SET expected_payment_date = ${PAYMENT_DATE_SQL}
     WHERE source != 'manual' AND status IN ('open', 'delivered') AND ${PAYMENT_DATE_SQL} IS NOT NULL
       AND expected_payment_date IS DISTINCT FROM ${PAYMENT_DATE_SQL}`);
  return a.rowCount + b.rowCount;
}

/**
 * A settlement ticket read before its money arrives confirms its contract:
 * the contract is delivered, the ticket's net is what's coming, and it's
 * expected SETTLEMENT_DAYS after the ticket's date. One clear contract or
 * nothing (same commodity, from the contract's time, no bigger than what's
 * left on it; then the buyer named, if it's printed; then the quantity
 * within 10% when both have one). Returns the contract id or null.
 */
export async function confirmFromTicket(db, receiptId, ex) {
  if (!ex?.commodity || ex.total == null || !ex.date) return null;
  const { rows: cs } = await db.query(
    // Same commodity; a ticket from around this contract's time (not last
    // year's); and no more than what's left on it (a ticket bigger than the
    // contract is some other sale, or several).
    `SELECT * FROM sale_contracts
     WHERE status IN ('open', 'delivered') AND NOT ($2 = ANY(settlement_receipts))
       AND (commodity ILIKE '%' || $1 || '%' OR $1 ILIKE '%' || commodity || '%')
       AND $3::date >= created_at::date - 60 AND $3::date >= CURRENT_DATE - 180
       AND $4 <= (total_value - received_amount - COALESCE(settlement_net, 0)) * 1.05 + 1`,
    [String(ex.commodity).trim(), receiptId, toISODate(ex.date), Number(ex.total)]);
  let pick = cs;
  if (ex.party && pick.length > 1) {
    const named = pick.filter((c) => c.counterparty && textMatches(ex.party, c.counterparty));
    if (named.length) pick = named;
  }
  if (ex.quantity && pick.length > 1) {
    const near = pick.filter((c) => {
      const left = Number(c.quantity) - (Number(c.quantity_delivered) || 0);
      return Number(c.quantity) > 0 && (Math.abs(Number(c.quantity) - Number(ex.quantity)) <= Number(c.quantity) * 0.1
        || Math.abs(left - Number(ex.quantity)) <= Math.max(1, left * 0.1));
    });
    if (near.length) pick = near;
  }
  if (pick.length !== 1) return null;
  const c = pick[0];
  const date = toISODate(ex.date);
  // Tickets add up: a contract hauled in several loads gets one per load.
  const qty = Number(ex.quantity) > 0 ? Number(ex.quantity) : null;
  const all = Number(c.quantity) > 0 && qty != null
    ? (Number(c.settlement_quantity) || 0) + qty >= Number(c.quantity) * 0.995
    : qty == null; // a ticket with no quantity is taken as the whole contract
  await db.query(
    `UPDATE sale_contracts SET
       settlement_net = COALESCE(settlement_net, 0) + $3,
       settlement_quantity = CASE WHEN $5::numeric IS NULL THEN settlement_quantity ELSE COALESCE(settlement_quantity, 0) + $5 END,
       settlement_date = GREATEST(COALESCE(settlement_date, $2::date), $2::date),
       settlement_receipts = array_append(settlement_receipts, $4),
       delivered_on = COALESCE(delivered_on, delivery_date, $2::date),
       status = CASE WHEN $6 THEN 'delivered'::contract_status ELSE status END,
       expected_payment_date = CASE WHEN $6 THEN GREATEST($2::date + ${SETTLEMENT_DAYS}, CURRENT_DATE) ELSE expected_payment_date END
     WHERE id = $1`,
    [c.id, date, round2(ex.total), receiptId, qty, all]);
  await db.query('UPDATE receipts SET contract_id = COALESCE(contract_id, $2) WHERE id = $1', [receiptId, c.id]);
  return c.id;
}
