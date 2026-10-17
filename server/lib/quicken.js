// The Quicken feed: a Quicken export (QIF or CSV, any edition) or lines an
// agent read off Quicken, sent daily, become Money Hub transactions through
// the same statement ingest the bank-statement agent uses — so bills,
// loan payments, card payments, transfers and duplicates are handled the
// same way, and the review queue catches anything uncertain.
//
//   1. Each Quicken account is linked once to a Money Hub account or card
//      (matched by name or last 4 digits when that's unambiguous; otherwise
//      waiting on the Quicken page). Unlinked and ignored accounts are skipped.
//   2. Lines before the account's import_from date are skipped — they're
//      already on file.
//   3. Each line gets a stable id from account, date, amount and its order
//      among same-day same-amount lines — so sending overlapping exports
//      every day never enters anything twice, and renaming a payee in
//      Quicken doesn't create a copy.
//   4. Quicken categories are learned: each maps once to a Money Hub
//      category and owner. Until it's mapped, the line posts uncategorized;
//      setting the mapping fills in every line already posted under it.
//   5. A line that was in an earlier export but is gone from this one, for
//      dates this export covers, was deleted or changed in Quicken: its
//      transaction is flagged for review (never deleted).

import { pool, getSetting, withTransaction } from '../db.js';
import { SEGMENT_COLUMNS } from './segments.js';
import { ownerOf, ledgerForOwner, UNCATEGORIZED_INCOME } from './postings.js';
import { textMatches } from './statementIngest.js';
import { toISODate, addDays, todayISO } from './dates.js';
import { parseQuicken } from './quickenParse.js';
import { ingestStatement } from '../routes/statements.js';

export const SOURCE = 'quicken';
const LIABILITY = /^(oth l|liab|liability|loan|mortgage)$/i;

async function setSetting(key, value) {
  await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
}

/** Links a newly seen Quicken account when exactly one account or card has its name or last 4 digits. */
async function autoMatchAccount(name, mhAccounts, mhCards) {
  const n = name.toLowerCase().trim();
  const digits = name.match(/\d{4}/g) || [];
  const hits = [
    ...mhAccounts.filter((a) => a.name.toLowerCase().trim() === n || (a.last4 && digits.includes(a.last4))).map((a) => ({ account_id: a.id })),
    ...mhCards.filter((c) => c.name.toLowerCase().trim() === n || (c.last4 && digits.includes(c.last4))).map((c) => ({ credit_card_id: c.id })),
  ];
  return hits.length === 1 ? hits[0] : null;
}

/** Where a newly linked account starts: a week before the last transaction already on file, so the overlap is checked for duplicates. */
export async function defaultImportFrom(link, firstDate = null) {
  const { rows: [r] } = link.account_id
    ? await pool.query('SELECT max(date) AS d FROM transactions WHERE account_id = $1 AND date <= CURRENT_DATE', [link.account_id])
    : await pool.query('SELECT max(date) AS d FROM transactions WHERE credit_card_id = $1 AND account_id IS NULL AND date <= CURRENT_DATE', [link.credit_card_id]);
  return r?.d ? addDays(toISODate(r.d), -7) : firstDate;
}

/** Category leaf names that match exactly one Money Hub category. */
function autoMatchCategory(name, categories) {
  const leaf = name.split(':').pop().trim().toLowerCase();
  const full = name.toLowerCase().replace(/:/g, ' › ');
  const hit = categories.filter((c) => c.name.toLowerCase() === leaf || (c.full && c.full.toLowerCase() === full));
  return hit.length === 1 ? hit[0].id : null;
}

/** The Money Hub fields a mapped category contributes to a line. */
const mapFields = (m) => (m ? { ...(m.category_id ? { category_id: m.category_id } : {}), ...(m.owner || {}) } : {});

/**
 * Imports a Quicken export. input: { content (text, or an array of agent
 * lines), filename, account (for a single-account file), date_order, label }.
 */
export async function importQuicken(input) {
  const fallbackOrder = input.date_order || await getSetting('quicken_date_order', null);
  const parsed = parseQuicken(input.content, { account: input.account || null, fallbackOrder: typeof fallbackOrder === 'string' ? fallbackOrder.replace(/"/g, '') : null });
  if (parsed.error) return { status: 400, body: { error: parsed.error, warnings: parsed.warnings } };
  if (!parsed.accounts.length) return { status: 400, body: { error: 'No transactions found in that file.', warnings: parsed.warnings } };
  // Remember the order only when the file proved it, so later ambiguous files read the same way.
  if (parsed.date_evidence && !input.date_order) await setSetting('quicken_date_order', parsed.date_order);

  const [{ rows: mhAccounts }, { rows: mhCards }, { rows: cats }, { rows: loans }] = await Promise.all([
    pool.query('SELECT id, name, last4 FROM accounts'),
    pool.query(`SELECT id, name, last4, ledger_start_date FROM credit_cards WHERE status = 'active'`),
    pool.query(`SELECT c.id, c.name, CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' › ' || c.name END AS full
                FROM expense_categories c LEFT JOIN expense_categories p ON p.id = c.parent_id`),
    pool.query('SELECT id, name, lender FROM loans'),
  ]);

  // ---- Accounts: record what was seen, link what can be linked ----
  const links = new Map();
  for (const a of parsed.accounts) {
    const first = a.lines.map((l) => l.date).sort()[0] || todayISO();
    let { rows: [row] } = await pool.query('SELECT * FROM quicken_accounts WHERE lower(name) = lower($1)', [a.name]);
    if (!row) {
      // Loans, assets and investments live elsewhere in Money Hub: set aside, not linked.
      const elsewhere = /^(oth l|oth a|liab|asset|invst|port|401k)/i.test(a.qtype || '');
      const hit = elsewhere ? null : await autoMatchAccount(a.name, mhAccounts, mhCards);
      const from = hit ? await defaultImportFrom(hit, first) : null;
      ({ rows: [row] } = await pool.query(
        `INSERT INTO quicken_accounts (name, qtype, account_id, credit_card_id, auto_matched, import_from, ignored)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [a.name, a.qtype, hit?.account_id || null, hit?.credit_card_id || null, !!hit, from, elsewhere]));
    }
    await pool.query('UPDATE quicken_accounts SET lines_seen = lines_seen + $1, last_seen = now(), qtype = COALESCE(qtype, $2) WHERE id = $3',
      [a.lines.length, a.qtype, row.id]);
    links.set(a.name.toLowerCase(), row);
  }
  const { rows: allLinks } = await pool.query('SELECT * FROM quicken_accounts');
  for (const l of allLinks) if (!links.has(l.name.toLowerCase())) links.set(l.name.toLowerCase(), l);

  // ---- Categories: record what was seen, learn exact name matches ----
  const catNames = new Map();
  for (const a of parsed.accounts) {
    for (const l of a.lines) {
      const names = l.splits.length ? l.splits.map((s) => s.category) : [l.category];
      for (const n of names) if (n) catNames.set(n, (catNames.get(n) || 0) + 1);
    }
  }
  const maps = new Map();
  for (const [name, count] of catNames) {
    let { rows: [m] } = await pool.query('SELECT * FROM quicken_categories WHERE lower(name) = lower($1)', [name]);
    if (!m) {
      const id = autoMatchCategory(name, cats);
      ({ rows: [m] } = await pool.query(
        'INSERT INTO quicken_categories (name, category_id, auto_matched) VALUES ($1, $2, $3) RETURNING *', [name, id, !!id]));
    }
    await pool.query('UPDATE quicken_categories SET lines_seen = lines_seen + $1, last_seen = now() WHERE id = $2', [count, m.id]);
    maps.set(name.toLowerCase(), m);
  }
  const mapOf = (name) => (name ? maps.get(name.toLowerCase()) : null);

  // ---- Lines, account by account ----
  const accountsOut = [];
  const totals = { posted: 0, matched: 0, held: 0, errors: 0, already: 0, skipped_before: 0, flagged_gone: 0 };
  for (const a of parsed.accounts) {
    const link = links.get(a.name.toLowerCase());
    const out = { quicken_account: a.name, lines: a.lines.length };
    accountsOut.push(out);
    if (!a.lines.length) { out.skipped = 'no lines'; continue; }
    if (link.ignored) { out.skipped = 'ignored'; continue; }
    if (!link.account_id && !link.credit_card_id) { out.skipped = 'not linked'; continue; }
    const isCard = !link.account_id;
    const target = isCard ? { type: 'card', id: link.credit_card_id } : { type: 'account', id: link.account_id };
    out.linked_to = isCard ? mhCards.find((c) => c.id === link.credit_card_id)?.name : mhAccounts.find((x) => x.id === link.account_id)?.name;
    const card = isCard ? mhCards.find((c) => c.id === link.credit_card_id) : null;
    if (card && !card.ledger_start_date && (link.card_opening_balance == null || !link.import_from)) {
      out.skipped = 'card needs a starting balance';
      continue;
    }
    const from = link.import_from ? toISODate(link.import_from) : null;
    const lines = a.lines.filter((l) => !from || l.date >= from);
    out.skipped_before = a.lines.length - lines.length;
    totals.skipped_before += out.skipped_before;
    if (!lines.length) continue;

    const seen = new Map();
    const built = lines.map((l) => {
      const k = `${l.date}|${l.amount.toFixed(2)}`;
      const occ = (seen.get(k) || 0) + 1;
      seen.set(k, occ);
      return buildLine(l, { target, isCard, occ, mapOf, links, loans, mhAccounts });
    });
    const dates = lines.map((l) => l.date).sort();
    const statement = isCard ? { credit_card_id: target.id } : { account_id: target.id };
    statement.period_start = dates[0];
    statement.period_end = dates[dates.length - 1];
    if (card && !card.ledger_start_date) {
      statement.period_start = from;
      statement.opening_balance = Number(link.card_opening_balance);
    }
    const res = await ingestStatement({ source: SOURCE, statement, lines: built });
    if (res.status !== 200) { out.error = res.body.error; totals.errors += lines.length; continue; }
    // New this time vs already imported from an earlier export.
    const fresh = res.body.results.filter((r) => !r.already_processed);
    const count = (st) => fresh.filter((r) => r.ok && r.status === st).length;
    const already = res.body.results.length - fresh.length;
    Object.assign(out, { posted: count('posted'), matched: count('matched'), held: count('held'), errors: fresh.filter((r) => !r.ok).length, already_imported: already });
    for (const k of ['posted', 'matched', 'held', 'errors']) totals[k] += out[k];
    totals.already += already;

    // Gone from Quicken: earlier lines for these dates that this export no longer has.
    const ids = built.map((b) => b.external_id);
    const { rows: gone } = await pool.query(
      `SELECT sl.id, sl.transaction_id, sl.date, sl.amount, sl.description FROM statement_lines sl
       WHERE sl.source = $1 AND ${isCard ? 'sl.credit_card_id' : 'sl.account_id'} = $2
         AND sl.date BETWEEN $3 AND $4 AND sl.status IN ('posted', 'matched') AND NOT (sl.external_id = ANY($5::text[]))`,
      [SOURCE, target.id, dates[0], dates[dates.length - 1], ids]);
    for (const g of gone) {
      if (!g.transaction_id) continue;
      const { rowCount } = await pool.query(
        `UPDATE transactions SET needs_review = true, review_note = $2 WHERE id = $1 AND needs_review = false`,
        [g.transaction_id, 'Not in the latest Quicken export — deleted or changed in Quicken? Delete it here if it’s gone, or edit it to match.']);
      totals.flagged_gone += rowCount;
    }
    out.flagged_gone = gone.length;
  }

  const unlinked = accountsOut.filter((x) => x.skipped === 'not linked' || x.skipped === 'card needs a starting balance');
  const unmapped = [...maps.values()].filter((m) => !m.category_id && m.kind === 'standard').map((m) => m.name);
  const linesRead = parsed.accounts.reduce((t, a) => t + a.lines.length, 0);
  const { rows: [log] } = await pool.query(
    `INSERT INTO quicken_imports (source_label, format, filename, date_order, lines_read, summary, accounts, warnings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, received_at`,
    [input.label || null, parsed.format, input.filename || null, parsed.date_order || null, linesRead,
     JSON.stringify(totals), JSON.stringify(accountsOut), JSON.stringify(parsed.warnings)]);
  return {
    status: 200,
    body: {
      import_id: log.id, format: parsed.format, date_order: parsed.date_order, lines_read: linesRead, summary: totals,
      accounts: accountsOut,
      needs_linking: unlinked.map((x) => ({ quicken_account: x.quicken_account, why: x.skipped })),
      unmapped_categories: unmapped,
      warnings: parsed.warnings,
    },
  };
}

/** One Quicken line as a statement line. */
function buildLine(l, { target, isCard, occ, mapOf, links, loans, mhAccounts }) {
  const description = [l.payee, l.memo].filter(Boolean).join(' — ') || (l.transfer ? `Transfer ${l.amount < 0 ? 'to' : 'from'} ${l.transfer}` : 'Quicken');
  const base = {
    external_id: `q:${target.type}:${target.id}:${l.date}:${l.amount.toFixed(2)}:${occ}`,
    date: l.date, amount: l.amount, description, payee: l.payee || undefined,
    quicken_category: l.category || null, quicken_class: l.cls || null, quicken_num: l.num || null, quicken_status: l.status,
  };
  // Transfers: to the other Quicken account, as Money Hub knows it.
  if (l.transfer !== null && l.transfer !== undefined) {
    const other = l.transfer ? links.get(l.transfer.toLowerCase()) : null;
    const otherAccount = other?.account_id || (l.transfer && mhAccounts.find((x) => x.name.toLowerCase() === l.transfer.toLowerCase())?.id) || null;
    if (!isCard && other?.credit_card_id && l.amount < 0) return { ...base, kind: 'card_payment', credit_card_id: other.credit_card_id };
    if (isCard && otherAccount && l.amount > 0) return { ...base, kind: 'card_payment', from_account_id: otherAccount };
    const loanName = l.transfer && (LIABILITY.test(other?.qtype || '') || loans.some((x) => textMatches(l.transfer, x.name, x.lender)));
    if (!isCard && loanName && l.amount < 0) return { ...base, kind: 'loan_payment', payee: l.transfer, description: `${l.transfer}${l.payee ? ` — ${l.payee}` : ''}` };
    if (!isCard && otherAccount && otherAccount !== target.id) return { ...base, kind: 'transfer', counterparty_account_id: otherAccount };
    return { ...base, kind: 'transfer' };
  }
  // Splits: kept when every piece has a mapped category.
  if (l.splits.length > 1) {
    const pieces = l.splits.map((s) => ({ s, m: mapOf(s.category) }));
    if (pieces.every(({ s, m }) => !s.transfer && m?.category_id && m.kind === 'standard')) {
      return { ...base, kind: 'standard', splits: pieces.map(({ s, m }) => ({ amount: s.amount, memo: s.memo || s.category, ...mapFields(m) })) };
    }
    return { ...base, kind: 'standard', quicken_category: l.splits.map((s) => s.category || `[${s.transfer}]`).join(' + ') };
  }
  const m = mapOf(l.category);
  if (m?.kind === 'owner_draw' && !isCard && l.amount < 0) return { ...base, kind: 'owner_draw', ...(m.owner || {}) };
  if (m?.kind === 'transfer') return { ...base, kind: 'transfer' };
  return { ...base, kind: 'standard', ...mapFields(m) };
}

/**
 * After a category mapping is set: fills in every Quicken line already
 * posted under it that's still uncategorized (and its owner, if the line
 * has none). Returns how many transactions changed.
 */
export async function applyCategoryMapping(id) {
  return withTransaction(async (client) => {
    const { rows: [m] } = await client.query('SELECT * FROM quicken_categories WHERE id = $1', [id]);
    if (!m || !m.category_id || m.kind !== 'standard') return 0;
    const { rows: txs } = await client.query(
      `SELECT t.* FROM transactions t JOIN statement_lines sl ON sl.transaction_id = t.id
       WHERE sl.source = $1 AND lower(sl.payload->>'quicken_category') = lower($2)
         AND t.category_id IS NULL AND NOT t.is_split AND NOT t.is_transfer AND sl.status = 'posted'`,
      [SOURCE, m.name]);
    for (const t of txs) {
      const hasOwner = t.segment || t.is_segment_split;
      if (m.owner && !hasOwner) {
        const owner = ownerOf(m.owner);
        await client.query(
          `UPDATE transactions SET category_id = $1, ledger = $2, ${SEGMENT_COLUMNS.map((c, i) => `${c} = $${3 + i}`).join(', ')}
           WHERE id = $${3 + SEGMENT_COLUMNS.length}`,
          [m.category_id, ledgerForOwner(owner, t.ledger), ...SEGMENT_COLUMNS.map((c) => owner[c]), t.id]);
      } else {
        await client.query('UPDATE transactions SET category_id = $1 WHERE id = $2', [m.category_id, t.id]);
      }
      // Income only needed review for want of a category.
      if (Number(t.amount) > 0) await client.query('UPDATE transactions SET needs_review = false, review_note = NULL WHERE id = $1 AND review_note = $2', [t.id, UNCATEGORIZED_INCOME]);
    }
    return txs.length;
  });
}

