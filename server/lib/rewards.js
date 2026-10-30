// Gift cards, card points and rebates (Jake, 2026-10-29: "tracks the value of
// gift cards I've been given or gifted, the accumulated credit card points,
// and any rebate programs I enter and track"). Points live in lib/points.js;
// this is gift cards and rebates, and the one summary of all three.
import { pool } from '../db.js';
import { insertTransaction, removeTransaction, ownerOf } from './postings.js';
import { pointsSummary } from './points.js';
import { toISODate, todayISO } from './dates.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const bad = (m) => { const e = new Error(m); e.status = 400; return e; };
const d = (v) => (v ? toISODate(v) : null);

// ---- Gift cards --------------------------------------------------------------

/** Every card with what's been used and what's left (pure over rows — exported for tests). */
export function cardBalances(cards, uses, today = todayISO()) {
  return cards.map((c) => {
    const mine = uses.filter((u) => u.card_id === c.id).map((u) => ({ ...u, date: d(u.date), amount: Number(u.amount) }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const used = r2(mine.reduce((a, u) => a + u.amount, 0));
    const value = Number(c.value);
    const left = c.direction === 'received' && c.status === 'active' ? r2(Math.max(0, value - used)) : 0;
    const exp = d(c.expires);
    const days = exp ? Math.round((Date.parse(exp) - Date.parse(today)) / 86400000) : null;
    return {
      ...c, value, date: d(c.date), expires: exp, used, balance: left, uses: mine,
      expiring: left > 0 && days != null && days >= 0 && days <= 60, expired: left > 0 && days != null && days < 0,
    };
  });
}

export async function giftCards(db = pool) {
  const [{ rows: cards }, { rows: uses }] = await Promise.all([
    db.query('SELECT * FROM gift_cards ORDER BY date DESC, id DESC'),
    db.query('SELECT * FROM gift_card_uses ORDER BY date DESC, id DESC'),
  ]);
  return cardBalances(cards, uses);
}

/** Logs a use; the card is marked used once nothing's left. */
export async function useCard(client, cardId, { date, amount, description = null, transaction_id = null }) {
  const { rows: [c] } = await client.query('SELECT * FROM gift_cards WHERE id = $1 FOR UPDATE', [cardId]);
  if (!c) return null;
  if (c.direction !== 'received') throw bad('A card you gave away has no balance to spend.');
  const a = r2(amount);
  if (!(a > 0)) throw bad('The amount used must be more than zero.');
  const { rows: [u] } = await client.query('SELECT COALESCE(SUM(amount), 0) AS used FROM gift_card_uses WHERE card_id = $1', [cardId]);
  const left = r2(Number(c.value) - Number(u.used));
  if (a > left + 0.005) throw bad(`Only ${left.toFixed(2)} is left on it.`);
  await client.query('INSERT INTO gift_card_uses (card_id, date, amount, description, transaction_id) VALUES ($1,$2,$3,$4,$5)',
    [cardId, date || todayISO(), a, description || null, transaction_id || null]);
  if (left - a < 0.005) await client.query(`UPDATE gift_cards SET status = 'used' WHERE id = $1`, [cardId]);
  return true;
}

// ---- Rebates -------------------------------------------------------------------

/** What a rebate is expected to pay: the amount given, else spend × rate. */
export const rebateExpected = (r) => {
  if (r.amount != null && r.amount !== '') return r2(r.amount);
  if (r.qualifying_spend != null && r.rate_pct != null) return r2(Number(r.qualifying_spend) * Number(r.rate_pct) / 100);
  return null;
};

export async function rebates(db = pool) {
  const { rows } = await db.query(
    `SELECT r.*, a.name AS account, CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' › ' || c.name END AS category
     FROM rebates r LEFT JOIN accounts a ON a.id = r.account_id
     LEFT JOIN expense_categories c ON c.id = r.category_id LEFT JOIN expense_categories p ON p.id = c.parent_id
     ORDER BY (r.status IN ('received', 'lost')), COALESCE(r.expected_date, r.claim_by, '9999-12-31'), r.id`);
  const today = todayISO();
  return rows.map((r) => ({
    ...r, qualifying_spend: r.qualifying_spend == null ? null : Number(r.qualifying_spend), rate_pct: r.rate_pct == null ? null : Number(r.rate_pct),
    amount: r.amount == null ? null : Number(r.amount), received_amount: r.received_amount == null ? null : Number(r.received_amount),
    claim_by: d(r.claim_by), expected_date: d(r.expected_date), received_date: d(r.received_date),
    expected: rebateExpected(r),
    claim_soon: r.status === 'earning' && r.claim_by && d(r.claim_by) >= today && (Date.parse(d(r.claim_by)) - Date.parse(today)) / 86400000 <= 30,
    claim_missed: r.status === 'earning' && r.claim_by && d(r.claim_by) < today,
    overdue: ['claimed', 'approved'].includes(r.status) && r.expected_date && d(r.expected_date) < today,
  }));
}

/**
 * Received: books the deposit (or links `transaction_id`, an entry already in
 * the ledger) under the rebate's category — by default the input it came off,
 * so the rebate lowers that cost.
 */
export async function receiveRebate(client, id, { account_id, date, amount, transaction_id = null } = {}) {
  const { rows: [r] } = await client.query('SELECT * FROM rebates WHERE id = $1 FOR UPDATE', [id]);
  if (!r) return null;
  if (r.status === 'received') throw bad('Already marked received.');
  let tx;
  if (transaction_id) {
    const { rows: [t] } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [transaction_id]);
    if (!t) throw bad('That ledger entry is not on file.');
    if (Number(t.amount) <= 0) throw bad('Pick money coming in.');
    const { rows: [used] } = await client.query('SELECT program FROM rebates WHERE transaction_id = $1', [t.id]);
    if (used) throw bad(`That deposit is already the payment for ${used.program}.`);
    if (!t.category_id && !t.is_split && r.category_id) await client.query('UPDATE transactions SET category_id = $1 WHERE id = $2', [r.category_id, t.id]);
    tx = t;
  } else {
    const amt = r2(amount ?? rebateExpected(r));
    if (!(amt > 0)) throw bad('How much came in?');
    if (!account_id) throw bad('Which account did it go into?');
    tx = await insertTransaction(client, {
      account_id: Number(account_id), date: date || todayISO(), amount: amt, description: `Rebate: ${r.program}`,
      category_id: r.category_id || null, payee: r.sponsor || null, owner: ownerOf({ segment: r.segment || 'grain' }), awaiting_statement: 'fed',
    });
  }
  await client.query(
    `UPDATE rebates SET status = 'received', received_date = $2, received_amount = $3, account_id = $4, transaction_id = $5, linked_existing = $6 WHERE id = $1`,
    [id, d(tx.date), r2(tx.amount), tx.account_id || null, tx.id, !!transaction_id]);
  return true;
}

/** Undoes receiving: a deposit booked here goes; one already in the ledger stays, unlinked. */
export async function unreceiveRebate(client, id) {
  const { rows: [r] } = await client.query('SELECT * FROM rebates WHERE id = $1 FOR UPDATE', [id]);
  if (!r || r.status !== 'received') return r || null;
  await client.query(
    `UPDATE rebates SET status = 'approved', received_date = NULL, received_amount = NULL, account_id = NULL, transaction_id = NULL, linked_existing = false WHERE id = $1`, [id]);
  if (r.transaction_id && !r.linked_existing) await removeTransaction(client, r.transaction_id);
  return true;
}

// ---- All three -----------------------------------------------------------------

/** What it's all worth today, by kind, for the summary and the pie. */
export async function rewardsSummary(db = pool) {
  const [cards, rbs, points] = await Promise.all([giftCards(db), rebates(db), pointsSummary({}, db).catch(() => ({ programs: [] }))]);
  const programs = Array.isArray(points) ? points : points.programs || [];
  const giftValue = r2(cards.filter((c) => !c.expired).reduce((a, c) => a + c.balance, 0));
  const pointsValue = r2(programs.reduce((a, p) => a + (Number(p.value) || 0), 0));
  const open = rbs.filter((r) => !['received', 'lost'].includes(r.status));
  const rebateValue = r2(open.reduce((a, r) => a + (r.expected || 0), 0));
  const year = Number(todayISO().slice(0, 4));
  const receivedThisYear = r2(rbs.filter((r) => r.status === 'received' && String(r.received_date || '').startsWith(String(year))).reduce((a, r) => a + (r.received_amount || 0), 0));
  const givenThisYear = r2(cards.filter((c) => c.direction === 'given' && String(c.date).startsWith(String(year))).reduce((a, c) => a + c.value, 0));
  return {
    total: r2(giftValue + pointsValue + rebateValue),
    gift_cards: { value: giftValue, count: cards.filter((c) => c.balance > 0).length, expiring: cards.filter((c) => c.expiring).length, given_this_year: givenThisYear },
    points: { value: pointsValue, programs: programs.map((p) => ({ id: p.id, name: p.name, balance: p.balance, value: Number(p.value) || 0, unit: p.unit })) },
    rebates: { value: rebateValue, count: open.length, received_this_year: receivedThisYear, claims_due: rbs.filter((r) => r.claim_soon).length },
  };
}
