// Finds the deposits that pay each open sale contract.
//
// A deposit is a candidate for a contract when it's money into a bank
// account (not a transfer), isn't already counted toward any contract, is
// no more than what's left on the contract (plus a little for rounding),
// and lands after the delivery (from 3 days before a known delivery date;
// with none, from ~6 months before the expected payment date) and up to
// ~5 months after the expected payment date.
//
// It's linked AUTOMATICALLY only when the deposit names the buyer
// ("VITERRA DEP", payee Viterra) and that leaves exactly one contract —
// narrowed, when the buyer has several open contracts, by the commodity
// (the deposit's income category or description: "Canola sales") and then
// by the deposit covering what's left on just one of them. Everything else
// is offered on the Contracts tab as "looks like this contract" to confirm
// with one tap. Deposits are taken oldest first, so a contract fills in
// delivery order and settles once it reaches its value (refreshContract).
import { pool, withTransaction } from '../db.js';
import { linkContractToTransaction, PostingError } from './postings.js';
import { toISODate } from './dates.js';
import { closedMonth } from './periods.js';

const GENERIC = new Set(['grain', 'grains', 'ltd', 'inc', 'corp', 'canada', 'company', 'the', 'and', 'limited', 'agri',
  'farms', 'farm', 'sask', 'saskatchewan', 'deposit', 'dep', 'payment', 'cattle', 'livestock']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(w) && !/^\d+$/.test(w));
const stem = (w) => w.replace(/s$/, '');

const OPEN = `status IN ('open', 'delivered')`;
const remainingOf = (c) => Math.max(Number(c.total_value) - Number(c.received_amount || 0), 0);

/** Unlinked deposits in a contract's window that fit what's left on it, best first. */
export async function contractCandidates(db, c, limit = 30) {
  const remaining = remainingOf(c);
  const { rows } = await db.query(
    `SELECT t.id, t.date, t.amount, t.description, p.name AS payee, ec.name AS category, a.name AS account
     FROM transactions t
     LEFT JOIN payees p ON p.id = t.payee_id
     LEFT JOIN expense_categories ec ON ec.id = t.category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.amount > 0 AND t.account_id IS NOT NULL AND t.credit_card_id IS NULL
       AND NOT t.is_transfer AND NOT t.is_debt_service
       AND t.amount <= $1 * 1.03 + 1
       AND t.date BETWEEN COALESCE($5::date - 3, $2::date - 180) AND $2::date + 150
       AND NOT EXISTS (SELECT 1 FROM contract_payments x WHERE x.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM contract_link_rejections x WHERE x.transaction_id = t.id AND x.contract_id = $3)
     ORDER BY t.date, t.id
     LIMIT $4`,
    [remaining, toISODate(c.expected_payment_date), c.id, limit, c.delivery_date ? toISODate(c.delivery_date) : null]
  );
  const buyer = words(c.counterparty);
  const crop = words(c.commodity).map(stem);
  return rows.map((t) => {
    const text = `${t.description || ''} ${t.payee || ''}`.toLowerCase();
    const catWords = words(t.category).map(stem);
    return {
      id: t.id, date: toISODate(t.date), amount: Number(t.amount), description: t.description, payee: t.payee,
      account: t.account, category: t.category,
      names_buyer: buyer.some((w) => text.includes(w)),
      names_crop: crop.some((w) => catWords.includes(w) || text.includes(w)),
      covers_rest: remaining > 0 && Number(t.amount) >= remaining * 0.97 && Number(t.amount) <= remaining * 1.03 + 1,
    };
  });
}

/** Links every deposit it can be sure of. Returns the links made. */
export async function autoLinkContracts() {
  const made = [];
  for (let pass = 0; pass < 100; pass++) {
    const { rows: contracts } = await pool.query(`SELECT * FROM sale_contracts WHERE ${OPEN} ORDER BY expected_payment_date, id`);
    if (!contracts.length) break;
    // deposit id → the contracts it could pay
    const fits = new Map();
    for (const c of contracts) {
      for (const t of await contractCandidates(pool, c)) {
        if (!t.names_buyer) continue;
        const list = fits.get(t.id) || { t, cands: [] };
        list.cands.push({ c, t });
        fits.set(t.id, list);
      }
    }
    // Oldest deposit first; one link per pass, then recompute (what's left changes).
    const ordered = [...fits.values()].sort((a, b) => a.t.date.localeCompare(b.t.date) || a.t.id - b.t.id);
    let linked = false;
    for (const { t, cands } of ordered) {
      let list = cands;
      if (list.length > 1) { const x = list.filter((k) => k.t.names_crop); if (x.length) list = x; }
      if (list.length > 1) { const x = list.filter((k) => k.t.covers_rest); if (x.length === 1) list = x; }
      if (list.length !== 1) continue;
      if (await closedMonth(pool, t.date)) continue;
      try {
        await withTransaction((client) => linkContractToTransaction(client, list[0].c.id, t.id));
        made.push({ contract_id: list[0].c.id, transaction_id: t.id });
        linked = true;
        break;
      } catch (e) {
        if (!(e instanceof PostingError) && e.status !== 409) throw e;
      }
    }
    if (!linked) break;
  }
  return made;
}

let running = null;
/** Fire-and-forget version for after statements and entries arrive. */
export function autoLinkContractsSoon() {
  if (running) return running;
  running = autoLinkContracts()
    .catch((e) => console.error('Contract auto-link failed:', e.message))
    .finally(() => { running = null; });
  return running;
}
