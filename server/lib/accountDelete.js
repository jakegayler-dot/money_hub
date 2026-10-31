// Deleting redundant accounts (Jake, 2026-10-31: "a way to delete redundant accounts" — ones with nothing or
// just a balance in them, and duplicates of a real account).
//
//   Empty account     nothing posted to it: deleted. Anything else pointing at it (a statement import, a
//                     card statement's pay-from, a farm document) is cleared, or moved to the account it
//                     duplicates when one is named.
//   Duplicate         every entry in it is matched to its twin in the real account (same amount, dated within
//                     three days, exact date first). The copy is dropped and whatever pointed at it — a bill
//                     or loan payment it paid, statement lines, receipts — points at the twin instead, so
//                     nothing reopens. Entries with no twin are moved across (the real account's balance
//                     takes them) only when asked; otherwise the delete is refused and lists them.
//                     Statement imports and everything else on the duplicate move to the real account.
//
// The real account's balance only changes by entries moved across. Refused while any month the entries
// touch is closed. All in one database transaction — any conflict and nothing changes.

import { assertNoClosedFrom } from './periods.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const days = (a, b) => Math.abs((new Date(`${iso(a)}T00:00:00Z`) - new Date(`${iso(b)}T00:00:00Z`)) / 86400000);
export const TWIN_DAYS = 3;

export class AccountDeleteError extends Error { constructor(m, extra) { super(m); this.status = 409; this.extra = extra; } }

/** Pair each copy with an unused twin (pure — exported for tests). */
export function pairTwins(copies, reals, window = TWIN_DAYS) {
  const used = new Set();
  const pairs = []; const unmatched = [];
  const sorted = [...copies].sort((a, b) => iso(a.date).localeCompare(iso(b.date)) || a.id - b.id);
  for (const c of sorted) {
    let best = null;
    for (const t of reals) {
      if (used.has(t.id) || r2(t.amount) !== r2(c.amount)) continue;
      const d = days(c.date, t.date);
      if (d > window) continue;
      if (!best || d < best.d || (d === best.d && t.id < best.t.id)) best = { t, d };
    }
    if (best) { used.add(best.t.id); pairs.push({ copy: c, twin: best.t }); } else unmatched.push(c);
  }
  return { pairs, unmatched };
}

async function fks(db, table) {
  const { rows } = await db.query(
    `SELECT tc.table_name AS tbl, kcu.column_name AS col, c.is_nullable = 'YES' AS nullable, rc.delete_rule
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
     JOIN information_schema.columns c ON c.table_name = tc.table_name AND c.column_name = kcu.column_name AND c.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = $1 AND ccu.column_name = 'id' AND tc.table_schema = current_schema()`,
    [table]);
  // One row per referencing column.
  const seen = new Set();
  return rows.filter((r) => { const k = `${r.tbl}.${r.col}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const LABEL = {
  statement_imports: 'statement import', statement_lines: 'statement line', credit_card_statements: 'card statement',
  quicken_accounts: 'Quicken account link', farm_documents: 'invoice or receipt', rebates: 'rebate',
};

/** What's in an account and what deleting it would do. `target` = the account it duplicates. */
export async function accountUsage(db, id, target = null) {
  const { rows: [acct] } = await db.query('SELECT * FROM accounts WHERE id = $1', [id]);
  if (!acct) return null;
  const { rows: txs } = await db.query('SELECT id, date, amount, description FROM transactions WHERE account_id = $1 ORDER BY date, id', [id]);
  const refs = [];
  for (const f of await fks(db, 'accounts')) {
    if (f.tbl === 'transactions') continue;
    const { rows: [n] } = await db.query(`SELECT COUNT(*)::int AS n FROM ${f.tbl} WHERE ${f.col} = $1`, [id]);
    if (n.n) refs.push({ table: f.tbl, column: f.col, label: LABEL[f.tbl] || f.tbl.replace(/_/g, ' '), count: n.n, nullable: f.nullable });
  }
  const out = {
    account: { id: acct.id, name: acct.name, balance: r2(acct.opening_balance) },
    transactions: txs.length, references: refs,
    empty: txs.length === 0,
  };
  if (target != null) {
    const { rows: [t] } = await db.query('SELECT id, name, opening_balance FROM accounts WHERE id = $1', [target]);
    if (!t) throw new AccountDeleteError('The account it duplicates wasn’t found.');
    if (Number(t.id) === Number(id)) throw new AccountDeleteError('An account can’t duplicate itself.');
    const { rows: reals } = await db.query('SELECT id, date, amount, description FROM transactions WHERE account_id = $1', [target]);
    const { pairs, unmatched } = pairTwins(txs, reals);
    const moved = r2(unmatched.reduce((s, x) => s + Number(x.amount), 0));
    out.target = { id: t.id, name: t.name, balance: r2(t.opening_balance) };
    out.matched = pairs.length;
    out.unmatched = unmatched.map((x) => ({ id: x.id, date: iso(x.date), amount: r2(x.amount), description: x.description }));
    out.unmatched_total = moved;
  }
  return out;
}

/** Deletes the account (see the top of the file). Returns what was done. */
export async function deleteAccount(client, id, { target = null, moveUnmatched = false } = {}) {
  const { rows: [acct] } = await client.query('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [id]);
  if (!acct) return null;
  if (target != null) await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [target]);
  const u = await accountUsage(client, id, target);

  if (!u.empty && target == null) {
    throw new AccountDeleteError(`${acct.name} has ${u.transactions} transaction${u.transactions === 1 ? '' : 's'} in it. Choose the account it duplicates, so they can be matched up.`);
  }
  if (target != null && u.unmatched.length && !moveUnmatched) {
    throw new AccountDeleteError(`${u.unmatched.length} entr${u.unmatched.length === 1 ? 'y has' : 'ies have'} no copy in ${u.target.name}. Move them across, or sort them out first.`, { unmatched: u.unmatched });
  }
  if (!u.empty) {
    const { rows: [lo] } = await client.query('SELECT MIN(date) AS d FROM transactions WHERE account_id = $1', [id]);
    await assertNoClosedFrom(client, lo.d, `${acct.name}'s entries`);
  }

  let matched = 0; let moved = 0; let movedTotal = 0;
  if (target != null && !u.empty) {
    const { rows: copies } = await client.query('SELECT * FROM transactions WHERE account_id = $1', [id]);
    const { rows: reals } = await client.query('SELECT * FROM transactions WHERE account_id = $1', [target]);
    const { pairs, unmatched } = pairTwins(copies, reals);
    const txRefs = (await fks(client, 'transactions')).filter((f) => !(f.tbl === 'transaction_splits'));
    for (const { copy, twin } of pairs) {
      for (const f of txRefs) {
        if (f.tbl === 'transactions' && f.col === 'transfer_peer_id') continue;
        // Repoint unless the twin already has one of its own (then the copy's goes with it).
        await client.query(
          `UPDATE ${f.tbl} SET ${f.col} = $2 WHERE ${f.col} = $1
             AND NOT EXISTS (SELECT 1 FROM ${f.tbl} x WHERE x.${f.col} = $2 AND $3)`,
          [copy.id, twin.id, ['bills', 'loan_payments', 'sale_contracts', 'credit_card_statements', 'farm_documents', 'owner_draws', 'gst_returns'].includes(f.tbl)]);
      }
      // A transfer's other half points at the twin if the twin has no partner yet.
      if (copy.transfer_peer_id && !twin.transfer_peer_id) {
        await client.query('UPDATE transactions SET transfer_peer_id = $2 WHERE id = $1', [twin.id, copy.transfer_peer_id]);
        await client.query('UPDATE transactions SET transfer_peer_id = $2 WHERE id = $1', [copy.transfer_peer_id, twin.id]);
      }
      // Linked to a statement line now, so no longer waiting on one.
      if (copy.awaiting_statement === false && twin.awaiting_statement) {
        await client.query('UPDATE transactions SET awaiting_statement = false WHERE id = $1', [twin.id]);
      }
      // Anything still pointing at the copy that can't be moved and wouldn't be cleared stops the delete.
      for (const f of txRefs) {
        if (f.delete_rule !== 'NO ACTION' && f.delete_rule !== 'RESTRICT') continue;
        const { rows: [n] } = await client.query(`SELECT COUNT(*)::int AS n FROM ${f.tbl} WHERE ${f.col} = $1`, [copy.id]);
        if (n.n) throw new AccountDeleteError(`The ${iso(copy.date)} entry of ${r2(copy.amount)} pays a ${f.tbl.replace(/_/g, ' ').replace(/s$/, '')} that its twin in ${u.target.name} already pays. Sort that one out first.`);
      }
      await client.query('DELETE FROM transactions WHERE id = $1', [copy.id]);
      matched += 1;
    }
    for (const x of unmatched) {
      await client.query('UPDATE transactions SET account_id = $2 WHERE id = $1', [x.id, target]);
      await client.query('UPDATE accounts SET opening_balance = opening_balance + $1 WHERE id = $2', [x.amount, target]);
      moved += 1; movedTotal += Number(x.amount);
    }
  }

  // Everything else that names the account: moved to the real one, or cleared.
  for (const r of u.references) {
    if (target != null) await client.query(`UPDATE ${r.table} SET ${r.column} = $2 WHERE ${r.column} = $1`, [id, target]);
    else if (r.nullable) await client.query(`UPDATE ${r.table} SET ${r.column} = NULL WHERE ${r.column} = $1`, [id]);
    else throw new AccountDeleteError(`${r.count} ${r.label}${r.count === 1 ? '' : 's'} belong to ${acct.name}. Choose the account it duplicates to move them.`);
  }
  await client.query('DELETE FROM accounts WHERE id = $1', [id]);
  return {
    deleted: { id: acct.id, name: acct.name }, matched, moved, moved_total: r2(movedTotal),
    into: u.target || null, references: u.references.map((r) => ({ label: r.label, count: r.count, moved: target != null })),
  };
}
