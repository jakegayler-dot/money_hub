// Credit card points (Jake, 2026-10-24: "Credit card points").
//
// A program (Aeroplan, Avion, Scene+, cash back…) holds one balance, which
// can be fed by more than one card. Its ledger is points_entries:
//   balance  — what the program says you have on a date (a statement, the
//              app). Everything is measured from the latest one.
//   earned · bonus · redeemed · expired · adjusted — moves, signed.
// The balance now is the latest balance entry plus every move after it
// (by date, then entry order — a statement's earned line is entered before
// its balance, so it isn't counted twice).
//
// Spending after the last thing a statement or the program told us is
// estimated at the card's earn rates, shown as "on the way" and never added
// to the balance itself.
//
// Points are worth what they redeem for, so each program carries a value
// per point the owner sets (1,000 points for a $10 credit = 1¢). That value
// is shown beside the books, not on the balance sheet: points aren't cash,
// can't pay a bill until redeemed, and can be devalued or expire.
// Redeeming is a saving — money not spent — not income.
import { pool } from '../db.js';
import { todayISO, toISODate } from './dates.js';

const r2 = (n) => Math.round(n * 100) / 100;
// Points keep two decimals so cash-back programs (counted in dollars) keep their cents.
const rp = (n) => Math.round(n * 100) / 100;
export const MOVE_KINDS = ['earned', 'bonus', 'redeemed', 'expired', 'adjusted'];
export const ENTRY_KINDS = ['balance', ...MOVE_KINDS];
export const REDEEMED_FOR = {
  statement_credit: 'Statement credit',
  travel: 'Travel',
  gift_card: 'Gift card',
  merchandise: 'Merchandise',
  transfer: 'Transferred to a partner',
  other: 'Other',
};
export const PROGRAM_OWNERS = ['jake', 'ashley', 'farm'];

/** Whose points a card's points are by default, from the card's owner. */
export function ownerForSegment(segment) {
  if (segment === 'grain' || segment === 'livestock') return 'farm';
  if (segment === 'ashley') return 'ashley';
  return 'jake';
}

/** Sign of a move: redeemed and expired always take points away. */
export function signedPoints(kind, points) {
  const p = Math.abs(Number(points) || 0);
  if (kind === 'redeemed' || kind === 'expired') return -p;
  if (kind === 'adjusted') return Number(points) || 0;
  return p;
}

const after = (e, snap) => {
  if (!snap) return true;
  const a = toISODate(e.date); const b = toISODate(snap.date);
  if (a !== b) return a > b;
  // The same statement's own lines are already in its balance, whatever order they arrived in.
  if (e.source === 'statement' && snap.source === 'statement' && e.credit_card_id === snap.credit_card_id) return false;
  return e.id > snap.id;
};

/** Balance of one program's entries: { balance, as_of, since_snapshot, snapshot }. */
export function balanceOf(entries) {
  const sorted = [...entries].sort((x, y) => toISODate(x.date).localeCompare(toISODate(y.date)) || x.id - y.id);
  let snap = null;
  for (const e of sorted) if (e.kind === 'balance') snap = e;
  let bal = snap ? Number(snap.points) : 0;
  let since = 0;
  for (const e of sorted) {
    if (e.kind === 'balance' || !after(e, snap)) continue;
    bal += Number(e.points);
    since += Number(e.points);
  }
  const last = sorted.length ? toISODate(sorted[sorted.length - 1].date) : null;
  return { balance: rp(bal), as_of: last, snapshot: snap ? { date: toISODate(snap.date), points: Number(snap.points) } : null, since_snapshot: rp(since) };
}

const FALLBACK = /^(everything( else)?|(all )?other( purchases)?|general( purchases)?|base( rate)?|all( purchases)?|purchases)$/i;
// Lower case, letters only, each word singular ("Groceries" and "Grocery" match).
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  .split(' ').map((w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w)).join(' ');

/**
 * The reward category that applies to spending in a ledger category:
 * an exact name match on the category or its parent, then one name
 * containing the other (≥4 letters: "Gas" doesn't catch "Gas & propane"
 * wrongly, "Grocer" catches "Groceries"), then the card's base rate.
 */
export function rateFor(rewards, catName, parentName) {
  const names = [norm(catName), norm(parentName)].filter(Boolean);
  for (const n of names) {
    const hit = rewards.find((r) => norm(r.category) === n);
    if (hit) return hit;
  }
  for (const n of names) {
    const hit = rewards.find((r) => {
      const c = norm(r.category);
      return c.length >= 4 && n.length >= 4 && !FALLBACK.test(c) && (n.includes(c) || c.includes(n));
    });
    if (hit) return hit;
  }
  return rewards.find((r) => FALLBACK.test(norm(r.category))) || null;
}

/** Points a dollar of spending earns at a reward category, for a program. */
export function pointsPerDollar(reward, program) {
  if (!reward) return 0;
  if (reward.points_per_dollar != null && reward.points_per_dollar !== '') return Number(reward.points_per_dollar);
  // A % return: 2% back in a program worth 1¢ a point is 2 points a dollar.
  const pct = Number(reward.rate_pct) || 0;
  const cents = program?.unit === 'dollars' ? 100 : Number(program?.cents_per_point) || 1;
  return pct / cents;
}

/**
 * Spending on cards in a program over a window, with the points it earns:
 * [{ credit_card_id, card, category, parent, amount, points, rate_label, itemized }].
 * Itemized cards use their own purchase lines; a card that isn't itemized
 * only has its payments to go on, at its base rate.
 */
export async function spendingPoints(db, { program, cards, rewards, from, to }) {
  if (!cards.length) return [];
  const ids = cards.map((c) => c.id);
  const { rows: lines } = await db.query(
    `SELECT tl.credit_card_id, tl.account_id, tl.amount, tl.date, c.name AS category, p.name AS parent
       FROM transaction_lines tl
       LEFT JOIN expense_categories c ON c.id = tl.category_id
       LEFT JOIN expense_categories p ON p.id = c.parent_id
      WHERE tl.credit_card_id = ANY($1) AND NOT tl.is_transfer AND tl.date > $2::date AND tl.date <= $3::date
        AND (tl.amount < 0 OR tl.category_id IS NOT NULL)`,
    [ids, from, to]);
  const out = new Map();
  for (const c of cards) {
    const itemized = c.ledger_start_date != null;
    const own = rewards.filter((r) => r.credit_card_id === c.id);
    for (const l of lines) {
      if (l.credit_card_id !== c.id) continue;
      // Itemized: purchases and refunds charged to the card. Otherwise: payments into it.
      if (itemized ? l.account_id != null : (l.account_id == null || Number(l.amount) >= 0)) continue;
      if (itemized && l.date && c.ledger_start_date && toISODate(l.date) < toISODate(c.ledger_start_date)) continue;
      const reward = itemized ? rateFor(own, l.category, l.parent) : rateFor(own, null, null);
      const ppd = pointsPerDollar(reward, program);
      const spend = -Number(l.amount);
      const label = itemized ? (l.parent || l.category || 'Not categorized') : 'Card payments (card not itemized)';
      const key = `${c.id}|${label}`;
      const row = out.get(key) || { credit_card_id: c.id, card: c.name, category: label, amount: 0, points: 0, itemized,
        rate_label: reward ? (reward.points_per_dollar != null && reward.points_per_dollar !== '' ? `${Number(reward.points_per_dollar)} pts/$` : `${Number(reward.rate_pct)}%`) + ` (${reward.category})` : 'no earn rate set' };
      row.amount += spend;
      row.points += spend * ppd;
      out.set(key, row);
    }
  }
  return [...out.values()].map((x) => ({ ...x, amount: r2(x.amount), points: rp(x.points) })).filter((x) => Math.abs(x.amount) >= 0.005);
}

const valueOf = (points, program) => r2((Number(points) || 0) * (program.unit === 'dollars' ? 1 : (Number(program.cents_per_point) || 0) / 100));

/**
 * Everything the Points panel shows: each program with its balance, its
 * value, points on the way since the last statement, what this year's
 * spending earns by category, redemptions (and what they saved), and the
 * ledger; plus totals.
 */
export async function pointsSummary({ year, today } = {}, db = pool) {
  const day = today || todayISO();
  const y = Number(year) || Number(day.slice(0, 4));
  const [{ rows: programs }, { rows: cards }, { rows: rewards }, { rows: entries }] = await Promise.all([
    db.query('SELECT * FROM points_programs ORDER BY name'),
    db.query(`SELECT id, name, segment, status, ledger_start_date, points_program_id FROM credit_cards ORDER BY name`),
    db.query('SELECT * FROM credit_card_reward_categories'),
    db.query(`SELECT e.*, c.name AS card FROM points_entries e LEFT JOIN credit_cards c ON c.id = e.credit_card_id ORDER BY e.date DESC, e.id DESC`),
  ]);
  const out = [];
  for (const p of programs) {
    const own = entries.filter((e) => e.program_id === p.id);
    const pc = cards.filter((c) => c.points_program_id === p.id);
    const bal = balanceOf(own);
    // On the way: per card, spending after the latest date a statement or
    // the program accounted for (a balance, or that card's statement points).
    let pending = 0; let pendingSpend = 0; const pendingFrom = {};
    for (const c of pc) {
      const known = own.filter((e) => e.kind === 'balance' || (e.credit_card_id === c.id && e.source === 'statement'))
        .map((e) => toISODate(e.date)).sort().pop();
      if (!known) continue; // nothing to measure from yet
      const rows = await spendingPoints(db, { program: p, cards: [c], rewards, from: known, to: day });
      pending += rows.reduce((a, x) => a + x.points, 0);
      pendingSpend += rows.reduce((a, x) => a + x.amount, 0);
      pendingFrom[c.id] = known;
    }
    const ytd = await spendingPoints(db, { program: p, cards: pc, rewards, from: `${y - 1}-12-31`, to: `${y}-12-31` < day ? `${y}-12-31` : day });
    const yEntries = own.filter((e) => toISODate(e.date).startsWith(String(y)));
    const sum = (k) => yEntries.filter((e) => e.kind === k).reduce((a, e) => a + Number(e.points), 0);
    const redemptions = own.filter((e) => e.kind === 'redeemed');
    const redeemedValue = (list) => r2(list.reduce((a, e) => a + (e.value != null ? Number(e.value) : -valueOf(e.points, p)), 0));
    out.push({
      ...p,
      cents_per_point: Number(p.cents_per_point),
      cards: pc.map((c) => ({ id: c.id, name: c.name, status: c.status, itemized: c.ledger_start_date != null, pending_from: pendingFrom[c.id] || null,
        has_rates: rewards.some((r) => r.credit_card_id === c.id) })),
      balance: bal.balance,
      balance_known: !!bal.snapshot || own.length > 0,
      snapshot: bal.snapshot,
      as_of: bal.as_of,
      value: valueOf(bal.balance, p),
      pending: { points: rp(pending), value: valueOf(pending, p), spending: r2(pendingSpend) },
      year: {
        year: y,
        earned_recorded: rp(sum('earned') + sum('bonus')),
        redeemed: rp(-sum('redeemed')),
        expired: rp(-sum('expired')),
        saved: redeemedValue(redemptions.filter((e) => toISODate(e.date).startsWith(String(y)))),
        spending: r2(ytd.reduce((a, x) => a + x.amount, 0)),
        earned_estimate: rp(ytd.reduce((a, x) => a + x.points, 0)),
        earned_estimate_value: valueOf(ytd.reduce((a, x) => a + x.points, 0), p),
        by_category: ytd.map((x) => ({ ...x, value: valueOf(x.points, p) })).sort((a, b) => b.points - a.points),
      },
      saved_all_time: redeemedValue(redemptions),
      entries: own.map((e) => ({ id: e.id, date: toISODate(e.date), kind: e.kind, points: Number(e.points), value: e.value != null ? Number(e.value) : null,
        redeemed_for: e.redeemed_for, note: e.note, source: e.source, credit_card_id: e.credit_card_id, card: e.card })),
    });
  }
  const tot = (f) => r2(out.reduce((a, p) => a + f(p), 0));
  return {
    year: y,
    programs: out,
    unlinked_cards: cards.filter((c) => !c.points_program_id && c.status === 'active').map((c) => ({ id: c.id, name: c.name, segment: c.segment })),
    totals: {
      value: tot((p) => p.value),
      pending_value: tot((p) => p.pending.value),
      saved_this_year: tot((p) => p.year.saved),
      earned_value_this_year: tot((p) => p.year.earned_estimate_value),
      by_owner: PROGRAM_OWNERS.map((o) => ({ owner: o, value: tot((p) => (p.owner === o ? p.value : 0)) })).filter((x) => x.value),
    },
    redeemed_for: REDEEMED_FOR,
  };
}

/** Records one entry. Throws an Error with .status 400 on bad input. */
export async function addEntry(db, programId, body) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const kind = String(body.kind || '');
  if (!ENTRY_KINDS.includes(kind)) throw bad(`kind must be one of ${ENTRY_KINDS.join(', ')}`);
  const date = body.date || todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('date must be YYYY-MM-DD');
  if (body.points == null || body.points === '' || Number.isNaN(Number(body.points))) throw bad('points is required');
  const points = kind === 'balance' ? Number(body.points) : signedPoints(kind, body.points);
  if (kind === 'redeemed' && body.redeemed_for && !REDEEMED_FOR[body.redeemed_for]) throw bad('redeemed_for is not one of the options');
  const value = kind === 'redeemed' && body.value !== '' && body.value != null ? Math.abs(Number(body.value)) : null;
  const params = [programId, body.credit_card_id || null, date, kind, points, value, kind === 'redeemed' ? body.redeemed_for || null : null,
    body.note || null, body.source || 'hand', body.source_key || null];
  if (body.source_key) {
    const { rows } = await db.query(
      `INSERT INTO points_entries (program_id, credit_card_id, date, kind, points, value, redeemed_for, note, source, source_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (source_key) DO UPDATE SET points = EXCLUDED.points, date = EXCLUDED.date, program_id = EXCLUDED.program_id
       RETURNING *`, params);
    return rows[0];
  }
  const { rows } = await db.query(
    `INSERT INTO points_entries (program_id, credit_card_id, date, kind, points, value, redeemed_for, note, source, source_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, params);
  return rows[0];
}

/**
 * Points printed on a card statement: earned, redeemed and the closing
 * balance, at the statement's period end. Re-sending the statement replaces
 * them. A card with no program gets one, named from `points_program` or the
 * card. Returns what was recorded, or null if the statement had no points.
 */
export async function recordStatementPoints(db, card, statement) {
  const has = (k) => statement[k] != null && statement[k] !== '' && !Number.isNaN(Number(statement[k]));
  if (!['points_earned', 'points_redeemed', 'points_balance', 'points_bonus', 'points_expired'].some(has)) return null;
  const date = statement.period_end || statement.statement_date || todayISO();
  const { rows: [fresh] } = await db.query('SELECT points_program_id FROM credit_cards WHERE id = $1', [card.id]);
  let programId = fresh?.points_program_id ?? card.points_program_id;
  if (!programId) {
    const name = String(statement.points_program || `${card.name} points`).trim();
    const { rows: [p] } = await db.query(
      `INSERT INTO points_programs (name, owner) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name, ownerForSegment(card.segment)]);
    programId = p.id;
    await db.query('UPDATE credit_cards SET points_program_id = $1 WHERE id = $2', [programId, card.id]);
  }
  const recorded = {};
  // Moves first, then the balance — so the balance includes them, and they aren't counted again.
  for (const [field, kind] of [['points_earned', 'earned'], ['points_bonus', 'bonus'], ['points_redeemed', 'redeemed'], ['points_expired', 'expired'], ['points_balance', 'balance']]) {
    if (!has(field)) continue;
    await addEntry(db, programId, { kind, date, points: statement[field], credit_card_id: card.id, source: 'statement',
      source_key: `stmt:${card.id}:${date}:${kind}`, note: 'From the card statement' });
    recorded[kind] = Number(statement[field]);
  }
  return { program_id: programId, date, ...recorded };
}
