// Pairs the two sides of transfers between your own accounts (Jake, Oct 24:
// the ledger was full of one-sided transfers). Statement lines are only
// paired at ingest when the agent labels them `transfer` and the other side
// is already on file, so most aren't. This pass finds them afterwards.
//
// Two entries pair when:
//   - they're on two different bank accounts, for opposite amounts to the cent;
//   - they're dated within 5 days of each other;
//   - at least one is already a transfer, or one's description reads like a
//     transfer ("Transfer to RBC Personal", "e-Transfer", "TFR");
//   - neither carries a category someone chose (spending or income), a tax
//     marking, a split, or a link to a card;
//   - neither is in a closed month;
//   - the match is unambiguous both ways: each is the other's nearest
//     candidate by date, and no other candidate is as near.
// Paired, both become transfers (not income or spending) and point at each
// other. Returns the pairs made.
import { closedMonth } from './periods.js';
import { toISODate } from './dates.js';

export const TRANSFER_WORDS = /\b(e-?\s?transfer|transfer|xfer|tfr|trsf|funds? (moved|transfer)|between (my|own) accounts?)\b/i;
const MAX_DAYS = 5;
const days = (a, b) => Math.abs(Date.parse(`${toISODate(a)}T00:00:00Z`) - Date.parse(`${toISODate(b)}T00:00:00Z`)) / 86400000;

/** Candidate entries for pairing: one-sided, on a bank account, nothing else decided about them. */
async function candidates(client) {
  const { rows } = await client.query(
    `SELECT t.id, t.account_id, t.date, t.amount, t.description, t.is_transfer, t.category_id
       FROM transactions t
      WHERE t.account_id IS NOT NULL AND t.credit_card_id IS NULL AND t.transfer_peer_id IS NULL
        AND NOT t.is_split AND t.tax_kind IS NULL AND t.amount <> 0
        AND (t.is_transfer OR t.category_id IS NULL)
        AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.transfer_peer_id = t.id)
      ORDER BY t.date, t.id`);
  return rows.map((r) => ({ ...r, amount: Number(r.amount), date: toISODate(r.date) }));
}

/** The pairs to make from a list of candidates (pure — exported for tests). */
export function findPairs(list) {
  const byAmount = new Map();
  for (const t of list) {
    const k = Math.round(Math.abs(t.amount) * 100);
    if (!byAmount.has(k)) byAmount.set(k, []);
    byAmount.get(k).push(t);
  }
  const looks = (t) => t.is_transfer || TRANSFER_WORDS.test(t.description || '');
  const options = (t, pool) => pool
    .filter((o) => o.id !== t.id && o.account_id !== t.account_id && Math.sign(o.amount) === -Math.sign(t.amount)
      && days(o.date, t.date) <= MAX_DAYS && (looks(t) || looks(o)))
    .sort((a, b) => days(a.date, t.date) - days(b.date, t.date) || a.id - b.id);
  const best = (t, pool) => {
    const opts = options(t, pool);
    if (!opts.length) return null;
    if (opts.length > 1 && days(opts[1].date, t.date) === days(opts[0].date, t.date)) return null; // a tie: can't tell
    return opts[0];
  };
  const pairs = [];
  const used = new Set();
  for (const group of byAmount.values()) {
    if (group.length < 2) continue;
    for (const t of group) {
      if (used.has(t.id)) continue;
      const pool = group.filter((x) => !used.has(x.id));
      const o = best(t, pool);
      if (!o || best(o, pool)?.id !== t.id) continue; // must be each other's match
      used.add(t.id); used.add(o.id);
      pairs.push(t.amount < 0 ? [t, o] : [o, t]); // [out, in]
    }
  }
  return pairs;
}

/** Finds and records transfer pairs. Returns [{ out, in, amount, date }]. */
export async function pairTransfers(client) {
  const pairs = findPairs(await candidates(client));
  const made = [];
  for (const [out, inn] of pairs) {
    if (await closedMonth(client, out.date) || await closedMonth(client, inn.date)) continue;
    await client.query(
      `UPDATE transactions SET is_transfer = true, category_id = NULL, transfer_peer_id = $2 WHERE id = $1 AND transfer_peer_id IS NULL`, [out.id, inn.id]);
    await client.query(
      `UPDATE transactions SET is_transfer = true, category_id = NULL, transfer_peer_id = $2 WHERE id = $1 AND transfer_peer_id IS NULL`, [inn.id, out.id]);
    made.push({ out: out.id, in: inn.id, amount: Math.abs(out.amount), date: out.date });
  }
  return made;
}
