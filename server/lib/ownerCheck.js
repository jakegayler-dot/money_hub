// Spending counted as the farm's that probably isn't: the lines worth a
// person's look, so household spending (and the personal forecast built
// from it) isn't quietly understated.
//
// A line is listed when it's money out in the last 90 days, counted 100%
// farm, not a transfer, capital purchase or hand-made split, not already
// confirmed by a person, and any of:
//   - its category is a household one (Groceries on the farm Visa)
//   - it has no owner and no farm category (so it counts as farm by default)
//   - its business has gone mostly (60%+) to the household this past year
//   - its category has gone mostly (60%+) to the household this past year
// Confirming a line (any owner, or "farm is right") takes it off the list.

import { pool } from '../db.js';
import { businessShare } from './segments.js';
import { toISODate, todayISO, addDays } from './dates.js';

const HOUSEHOLD = 0.6;
const MIN_HISTORY = 3;
const r2 = (n) => Math.round(Number(n) * 100) / 100;

/** Household share (0–1) and line count per key, from the last year's spending. */
function shares(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (k == null) continue;
    const amt = Math.abs(Number(r.amount));
    const o = m.get(k) || { total: 0, household: 0, n: 0 };
    o.total += amt; o.household += amt * (1 - businessShare(r)); o.n += 1;
    m.set(k, o);
  }
  return m;
}

export async function ownerCheck(today = todayISO()) {
  const since = addDays(today, -90);
  const yearAgo = addDays(today, -365);
  const [{ rows: history }, { rows: lines }] = await Promise.all([
    pool.query(
      `SELECT t.payee_id, l.category_id, l.amount, l.segment, l.is_segment_split, l.segment_grain_pct, l.segment_livestock_pct,
              l.segment_jake_pct, l.segment_ashley_pct, l.ledger
       FROM transaction_lines l JOIN transactions t ON t.id = l.transaction_id
       WHERE l.amount < 0 AND l.is_transfer = false AND l.is_capex = false AND l.date >= $1 AND l.date <= $2
         AND (t.owner_confirmed OR t.segment IS NOT NULL OR t.is_segment_split)`,
      [yearAgo, today]),
    pool.query(
      `SELECT t.id, t.date, t.amount, t.description, t.payee_id, t.category_id, t.segment, t.is_segment_split,
              t.segment_grain_pct, t.segment_livestock_pct, t.segment_jake_pct, t.segment_ashley_pct, t.ledger,
              p.name AS payee, CASE WHEN pc.id IS NULL THEN c.name ELSE pc.name || ' › ' || c.name END AS category,
              COALESCE(a.name, cc.name) AS account, p.segment AS payee_rule, p.is_segment_split AS payee_rule_split,
              COALESCE(c.ledger, pc.ledger)::text AS category_ledger
       FROM transactions t
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN expense_categories c ON c.id = t.category_id LEFT JOIN expense_categories pc ON pc.id = c.parent_id
       LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id AND t.account_id IS NULL
       WHERE t.amount < 0 AND t.date >= $1 AND t.date <= $2 AND NOT t.is_transfer AND NOT t.is_capex AND NOT t.is_split
         AND NOT t.owner_confirmed AND NOT t.is_debt_service
         AND NOT (t.credit_card_id IS NOT NULL AND t.account_id IS NOT NULL)
       ORDER BY t.date DESC, t.id DESC`,
      [since, today]),
  ]);
  const byPayee = shares(history, 'payee_id');
  const byCategory = shares(history, 'category_id');
  const items = [];
  for (const t of lines) {
    if (businessShare(t) < 0.999) continue; // already partly household
    // A vendor with an owner rule was decided on purpose.
    if (t.payee_rule || t.payee_rule_split) continue;
    const reasons = [];
    // A farm category with no owner is a farm cost either way — not this list's question.
    const farmCategory = t.category_ledger === 'business';
    if (t.category_ledger === 'personal') reasons.push(`${t.category} is a household category`);
    else if (!t.segment && !t.is_segment_split && !farmCategory) reasons.push(t.category ? 'No owner — counted as farm' : 'No owner or category — counted as farm');
    const p = t.payee_id != null ? byPayee.get(t.payee_id) : null;
    if (p && p.n >= MIN_HISTORY && p.household / p.total >= HOUSEHOLD) reasons.push(`${t.payee} is usually household (${Math.round((p.household / p.total) * 100)}%)`);
    const c = t.category_id != null ? byCategory.get(t.category_id) : null;
    if (c && t.category_ledger !== 'personal' && c.n >= MIN_HISTORY && c.household / c.total >= HOUSEHOLD) reasons.push(`${t.category} is usually household (${Math.round((c.household / c.total) * 100)}%)`);
    if (!reasons.length) continue;
    items.push({
      id: t.id, date: toISODate(t.date), amount: r2(t.amount), description: t.description, payee_id: t.payee_id, payee: t.payee,
      category: t.category, account: t.account, owner: t.segment, reasons,
    });
  }
  return { since, count: items.length, total: r2(items.reduce((s, i) => s - i.amount, 0)), items };
}
