// Read-only data API for Sentinel's voice agent: GET /api/sentinel/read
// (the catalog) and GET /api/sentinel/read/:collection (rows). The same
// contract is implemented by all four of Jake's apps.
//
// Strictly read only. Every collection is a FIXED query (or one of the
// app's own read-only calculations): the request only ever supplies
// parameter VALUES, validated per filter. No SQL, code or column names come
// from the request.
//
// Output is plain JSON for a voice agent: names instead of ids, dates as
// YYYY-MM-DD, money as dollar numbers rounded to cents (CAD). No secrets,
// no images or raw statement payloads, long text trimmed.

import { pool } from '../db.js';
import { toISODate, addDays, addMonths } from './dates.js';
import { reginaToday } from './sentinelSnapshot.js';
import { loadBalanceSheet, inventoryOwnerRow } from './balanceSheet.js';
import { cardBalances, cardAmountsDue } from './cardLedger.js';
import { liquidityFloor, termDebtCoverage, reserveStatus } from './calculations.js';
import { buildSummaryFromDb } from './sentinel.js';
import { occurrences } from './estimates.js';
import { billDates } from './billDates.js';
import { farmIncomeTax, gstReport } from './tax.js';
import { countedLines } from '../routes/expenses.js';

export const APP = 'money_hub';
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
const MAX_BYTES = 190_000; // keep responses under ~200 KB
const TEXT_MAX = 1000;
const CURRENCY = 'CAD';

export class ReadError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- Formatting -------------------------------------------------------------

const money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const day = (v) => (v == null ? null : toISODate(v));
const bool = (v) => (v == null ? null : !!v);
export function text(v, max = TEXT_MAX) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const OWNER_LABEL = { grain: 'Grain', livestock: 'Cattle', jake: 'Jake', ashley: 'Ashley', personal: 'Unassigned' };
const OWNER_PCT = [['grain', 'segment_grain_pct'], ['livestock', 'segment_livestock_pct'], ['jake', 'segment_jake_pct'], ['ashley', 'segment_ashley_pct']];
/** "Grain", "Cattle", "Grain 33% / Cattle 33% / Jake 34%", or "Unassigned". */
export function ownerOf(r = {}) {
  if (r.is_segment_split) {
    const parts = OWNER_PCT.filter(([, c]) => Number(r[c]) > 0).map(([o, c]) => `${OWNER_LABEL[o]} ${Number(r[c])}%`);
    return parts.length ? parts.join(' / ') : 'Unassigned';
  }
  return r.segment ? OWNER_LABEL[r.segment] || String(r.segment) : 'Unassigned';
}
const SEG = (a) => `${a}.segment::text AS segment, ${a}.is_segment_split, ${a}.segment_grain_pct, ${a}.segment_livestock_pct,
  ${a}.segment_jake_pct, ${a}.segment_ashley_pct`;

// ---- Filter types -------------------------------------------------------------

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PARSE = {
  text: (v) => (v.trim() ? v.trim().slice(0, 200) : undefined),
  date: (v) => (DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : undefined),
  month: (v) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : undefined),
  year: (v) => (/^\d{4}$/.test(v) ? Number(v) : undefined),
  number: (v) => { const n = Number(v.replace(/[$,\s]/g, '')); return v.trim() && Number.isFinite(n) ? n : undefined; },
  int: (v) => (/^\d{1,9}$/.test(v) ? Number(v) : undefined),
  bool: (v) => ({ true: true, false: false, 1: true, 0: false, yes: true, no: false }[v.toLowerCase()]),
  enum: (v, spec) => { const s = v.toLowerCase(); return spec.values.includes(s) ? s : undefined; },
};
const HINT = {
  text: 'text', date: 'a date YYYY-MM-DD', month: 'a month YYYY-MM', year: 'a year YYYY', number: 'a number',
  int: 'a whole number', bool: 'true or false',
};

const OWNER_VALUES = ['grain', 'cattle', 'livestock', 'jake', 'ashley'];
const ownerKey = (v) => (v === 'cattle' ? 'livestock' : v);
const PCT_COL = { grain: 'segment_grain_pct', livestock: 'segment_livestock_pct', jake: 'segment_jake_pct', ashley: 'segment_ashley_pct' };

// Like-pattern for a search term (wildcards in the term are literal).
const like = (s) => `%${String(s).replace(/[\\%_]/g, '\\$&')}%`;

// Reusable filter specs. sql(v, p, ctx) returns a condition on the
// subquery alias x; p(value) binds a parameter. test(row, v) is the JS form.
const f = {
  owner: () => ({
    name: 'owner', type: 'enum', values: OWNER_VALUES, doc: 'grain | cattle | jake | ashley (includes split rows with a share)',
    sql: (v, p) => { const o = ownerKey(v); return `(x.segment = ${p(o)} OR (x.is_segment_split AND COALESCE(x.${PCT_COL[o]}, 0) > 0))`; },
  }),
  nameOrId: (name, nameCol, idCol, doc) => ({
    name, type: 'text', doc,
    sql: (v, p) => (/^\d+$/.test(v) ? `x.${idCol} = ${p(Number(v))}` : `x.${nameCol} ILIKE ${p(like(v))}`),
  }),
  textLike: (name, col, doc) => ({ name, type: 'text', doc, sql: (v, p) => `x.${col} ILIKE ${p(like(v))}` }),
  minAbs: (col) => ({ name: 'min_amount', type: 'number', doc: 'size of the amount (ignoring sign) at least this', sql: (v, p) => `abs(x.${col}) >= ${p(v)}` }),
  maxAbs: (col) => ({ name: 'max_amount', type: 'number', doc: 'size of the amount (ignoring sign) at most this', sql: (v, p) => `abs(x.${col}) <= ${p(v)}` }),
  month: (col) => ({ name: 'month', type: 'month', doc: 'YYYY-MM on the main date', sql: (v, p) => `to_char(x.${col}, 'YYYY-MM') = ${p(v)}` }),
  ledger: () => ({ name: 'ledger', type: 'enum', values: ['business', 'personal'], sql: (v, p) => `x.ledger = ${p(v)}` }),
  eq: (name, col, values, doc) => ({ name, type: 'enum', values, doc, sql: (v, p) => `x.${col} = ${p(v)}` }),
  // JS-mode equivalents
  jsEq: (name, field, values, doc) => ({ name, type: 'enum', values, doc, test: (r, v) => String(r[field] ?? '').toLowerCase() === v }),
  jsLike: (name, field, doc) => ({ name, type: 'text', doc, test: (r, v) => String(r[field] ?? '').toLowerCase().includes(v.toLowerCase()) }),
  jsOwner: () => ({
    name: 'owner', type: 'enum', values: OWNER_VALUES, doc: 'grain | cattle | jake | ashley (includes split rows with a share)',
    test: (r, v) => String(r.owner || '').toLowerCase().includes(OWNER_LABEL[ownerKey(v)].toLowerCase()),
  }),
};

// ---- Collections ----------------------------------------------------------------
// Record collections (mode 'sql'): base(p, ctx) is a fixed SELECT; search
// lists its text columns; date is the column from/to apply to; shape()
// turns a row into the output. Summary collections (mode 'js'): load(q, ctx)
// returns the output rows; filters marked param are inputs to the
// calculation rather than row tests.

const collections = [];
const def = (c) => { collections.push(c); return c; };

// ---------- accounts ----------
def({
  name: 'accounts', mode: 'sql',
  description: 'Bank, cash, reserve and investment accounts with today\'s book balance (positive = money in the account, negative = overdrawn), fees and uncleared cheques. Use for "how much is in X".',
  fields: ['id', 'name', 'ledger', 'type', 'balance', 'currency', 'owner', 'last4', 'source_system', 'fee_amount', 'fee_frequency', 'fee_notes',
    'uncleared_count', 'uncleared_total', 'last_transaction_date'],
  search: ['name', 'source_system', 'fee_notes'],
  filters: [f.ledger(), f.eq('type', 'type', ['operating', 'draw', 'reserve', 'personal', 'investment', 'credit'])],
  base: () => `SELECT a.id, a.name, a.ledger::text AS ledger, a.account_type::text AS type, a.opening_balance AS balance, a.last4,
      a.source_system, a.fee_amount, a.fee_frequency::text AS fee_frequency, a.fee_notes, ${SEG('a')},
      (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id AND NOT t.cleared)::int AS uncleared_count,
      (SELECT COALESCE(SUM(t.amount), 0) FROM transactions t WHERE t.account_id = a.id AND NOT t.cleared) AS uncleared_total,
      (SELECT MAX(t.date) FROM transactions t WHERE t.account_id = a.id) AS last_transaction_date
    FROM accounts a`,
  order: 'x.ledger, x.type, lower(x.name)',
  shape: (r) => ({
    id: r.id, name: r.name, ledger: r.ledger, type: r.type, balance: money(r.balance), currency: CURRENCY, owner: ownerOf(r),
    last4: r.last4 ? String(r.last4).slice(-4) : null, source_system: r.source_system,
    fee_amount: money(r.fee_amount), fee_frequency: r.fee_frequency, fee_notes: text(r.fee_notes),
    uncleared_count: r.uncleared_count, uncleared_total: money(r.uncleared_total), last_transaction_date: day(r.last_transaction_date),
  }),
});

// ---------- transactions ----------
const CAT_FULL = (c, pc) => `CASE WHEN ${c}.id IS NULL THEN NULL WHEN ${pc}.id IS NULL THEN ${c}.name ELSE ${pc}.name || ' › ' || ${c}.name END`;
def({
  name: 'transactions', mode: 'sql',
  description: 'Every ledger entry (bank account or credit card), most recent first. amount: positive = money in, negative = money out. Split entries list their pieces. Use for "what did I pay X", "spending on Y".',
  fields: ['id', 'date', 'amount', 'currency', 'kind', 'description', 'payee', 'category', 'splits', 'account', 'card', 'ledger', 'owner',
    'is_transfer', 'is_capital_purchase', 'is_loan_payment', 'cleared', 'cleared_date', 'confirmed_by_statement', 'needs_review', 'review_note',
    'gst', 'pays', 'documents'],
  search: ['description', 'payee', 'category', 'split_categories', 'review_note', 'account', 'card'],
  date: 'date',
  filters: [
    f.nameOrId('account', 'account', 'account_id', 'account name (contains) or id'),
    f.nameOrId('card', 'card', 'credit_card_id', 'credit card name (contains) or id'),
    { name: 'category', type: 'text', doc: 'category name (contains), split pieces included', sql: (v, p) => { const s = p(like(v)); return `(x.category ILIKE ${s} OR x.split_categories ILIKE ${s})`; } },
    f.textLike('payee', 'payee', 'payee name (contains)'),
    f.minAbs('amount'), f.maxAbs('amount'),
    { name: 'direction', type: 'enum', values: ['in', 'out'], sql: (v) => (v === 'in' ? 'x.amount > 0' : 'x.amount < 0') },
    {
      name: 'type', type: 'enum', values: ['income', 'expense', 'transfer', 'loan_payment', 'capital_purchase', 'card_purchase'],
      sql: (v) => ({
        income: '(x.amount > 0 AND NOT x.is_transfer)', expense: '(x.amount < 0 AND NOT x.is_transfer)', transfer: 'x.is_transfer',
        loan_payment: 'x.is_debt_service', capital_purchase: 'x.is_capex', card_purchase: 'x.account_id IS NULL',
      }[v]),
    },
    {
      ...f.owner(),
      // A split entry belongs to an owner if any of its pieces does.
      sql: (v, p) => {
        const o = ownerKey(v);
        const s = p(o);
        return `((x.segment = ${s} OR (x.is_segment_split AND COALESCE(x.${PCT_COL[o]}, 0) > 0))
          OR EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = x.id
                     AND (s.segment::text = ${s} OR (s.is_segment_split AND COALESCE(s.${PCT_COL[o]}, 0) > 0))))`;
      },
    },
    f.ledger(), f.month('date'),
    { name: 'needs_review', type: 'bool', sql: (v) => (v ? 'x.needs_review' : 'NOT x.needs_review') },
    { name: 'cleared', type: 'bool', sql: (v) => (v ? 'x.cleared' : 'NOT x.cleared') },
  ],
  base: () => `SELECT t.id, t.date, t.amount, t.description, p.name AS payee,
      CASE WHEN t.is_split THEN 'Split' ELSE ${CAT_FULL('ec', 'pc')} END AS category,
      (SELECT string_agg(${CAT_FULL('sc', 'spc')}, '; ') FROM transaction_splits s
         LEFT JOIN expense_categories sc ON sc.id = s.category_id LEFT JOIN expense_categories spc ON spc.id = sc.parent_id
         WHERE s.transaction_id = t.id) AS split_categories,
      (SELECT json_agg(json_build_object('amount', s.amount, 'category', ${CAT_FULL('sc', 'spc')}, 'memo', s.memo, 'ledger', s.ledger,
           'is_capex', s.is_capex, 'is_transfer', s.is_transfer, 'segment', s.segment, 'is_segment_split', s.is_segment_split,
           'segment_grain_pct', s.segment_grain_pct, 'segment_livestock_pct', s.segment_livestock_pct,
           'segment_jake_pct', s.segment_jake_pct, 'segment_ashley_pct', s.segment_ashley_pct) ORDER BY s.id)
         FROM transaction_splits s LEFT JOIN expense_categories sc ON sc.id = s.category_id
         LEFT JOIN expense_categories spc ON spc.id = sc.parent_id WHERE s.transaction_id = t.id) AS splits,
      t.account_id, a.name AS account, t.credit_card_id, cc.name AS card, t.ledger::text AS ledger, ${SEG('t')},
      t.is_transfer, t.is_capex, t.is_debt_service, t.cleared, t.cleared_date, t.awaiting_statement, t.needs_review, t.review_note,
      t.gst_amount,
      COALESCE(
        (SELECT 'Bill: ' || b.name FROM bills b WHERE b.linked_transaction_id = t.id LIMIT 1),
        (SELECT 'Loan: ' || COALESCE(NULLIF(l.name, ''), l.lender) || ' (due ' || to_char(lp.due_date, 'YYYY-MM-DD') || ')'
           FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id WHERE lp.linked_transaction_id = t.id LIMIT 1),
        (SELECT 'Contract: ' || c.commodity || COALESCE(' — ' || c.counterparty, '') FROM contract_payments cp
           JOIN sale_contracts c ON c.id = cp.contract_id WHERE cp.transaction_id = t.id LIMIT 1),
        CASE WHEN t.account_id IS NOT NULL AND t.credit_card_id IS NOT NULL THEN 'Card payment: ' || cc.name END
      ) AS pays,
      (SELECT COUNT(*) FROM receipts r WHERE r.transaction_id = t.id)::int AS documents
    FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
    LEFT JOIN expense_categories ec ON ec.id = t.category_id
    LEFT JOIN expense_categories pc ON pc.id = ec.parent_id
    LEFT JOIN payees p ON p.id = t.payee_id`,
  order: 'x.date DESC, x.id DESC',
  shape: (r) => ({
    id: r.id, date: day(r.date), amount: money(r.amount), currency: CURRENCY,
    kind: r.is_transfer ? 'transfer' : r.is_debt_service ? 'loan_payment' : r.is_capex ? 'capital_purchase' : Number(r.amount) > 0 ? 'income' : 'expense',
    description: text(r.description), payee: r.payee, category: r.category,
    splits: Array.isArray(r.splits) && r.splits.length
      ? r.splits.map((s) => ({ amount: money(s.amount), category: s.category, memo: text(s.memo, 200), ledger: s.ledger, owner: ownerOf(s),
        is_capital_purchase: !!s.is_capex, is_transfer: !!s.is_transfer }))
      : null,
    account: r.account, card: r.card, ledger: r.ledger, owner: ownerOf(r),
    is_transfer: r.is_transfer, is_capital_purchase: r.is_capex, is_loan_payment: r.is_debt_service,
    cleared: r.cleared, cleared_date: day(r.cleared_date), confirmed_by_statement: !r.awaiting_statement,
    needs_review: r.needs_review, review_note: text(r.review_note), gst: money(r.gst_amount), pays: r.pays, documents: r.documents,
  }),
});

// ---------- categories ----------
def({
  name: 'categories', mode: 'sql',
  description: 'Income and expense categories (two levels: parent › subcategory) with each one\'s annual budget and its monthly budget spread. Use to find category names or budgets.',
  fields: ['id', 'name', 'full_name', 'kind', 'parent', 'class', 'ledger', 'budget_annual', 'budget_monthly', 'subcategories'],
  search: ['name', 'parent'],
  filters: [f.eq('kind', 'kind', ['income', 'expense']), { name: 'top_level', type: 'bool', sql: (v) => (v ? 'x.parent_id IS NULL' : 'x.parent_id IS NOT NULL') }],
  base: () => `SELECT c.id, c.name, c.kind, c.class::text AS class, c.ledger::text AS ledger, c.annual_total, c.monthly_pct, c.parent_id,
      p.name AS parent, (SELECT COUNT(*) FROM expense_categories k WHERE k.parent_id = c.id)::int AS subcategories
    FROM expense_categories c LEFT JOIN expense_categories p ON p.id = c.parent_id`,
  order: 'x.kind DESC, lower(COALESCE(x.parent, x.name)), x.parent_id IS NOT NULL, lower(x.name)',
  shape: (r) => {
    const annual = Number(r.annual_total) || 0;
    const pct = Array.isArray(r.monthly_pct) ? r.monthly_pct : [];
    return {
      id: r.id, name: r.name, full_name: r.parent ? `${r.parent} › ${r.name}` : r.name, kind: r.kind, parent: r.parent, class: r.class,
      ledger: r.ledger, budget_annual: money(annual),
      budget_monthly: annual ? pct.map((x) => money(annual * Number(x || 0))) : null, subcategories: r.subcategories,
    };
  },
});

// ---------- vendors (payees) ----------
def({
  name: 'vendors', mode: 'sql',
  description: 'Payees and vendors (who was paid or who paid), with what is owed to each on unpaid bills, deposits they hold, owner rule and activity. owing/held/net_owing are positive amounts.',
  fields: ['id', 'name', 'owner_rule', 'transactions', 'last_transaction_date', 'unpaid_bills', 'owing', 'deposits_held', 'net_owing',
    'opening_balance', 'opening_date', 'reconciled_to'],
  search: ['name'],
  filters: [{ name: 'has_balance', type: 'bool', doc: 'true = something owed or held', sql: (v) => (v ? '(x.owing > 0 OR x.held > 0)' : '(x.owing = 0 AND x.held = 0)') }],
  base: (p, ctx) => `SELECT v.id, v.name, ${SEG('v')}, v.opening_balance, v.opening_date,
      (SELECT COUNT(*) FROM transactions t WHERE t.payee_id = v.id)::int AS transactions,
      (SELECT MAX(t.date) FROM transactions t WHERE t.payee_id = v.id) AS last_transaction_date,
      (SELECT COUNT(*) FROM bills b WHERE b.payee_id = v.id AND b.status = 'unpaid')::int AS unpaid_bills,
      COALESCE((SELECT SUM(bill_owing(b, ${p(ctx.today)}::date)) FROM bills b WHERE b.payee_id = v.id AND b.status = 'unpaid'), 0) AS owing,
      COALESCE((SELECT SUM(vc.amount - COALESCE((SELECT SUM(ca.amount) FROM credit_applications ca WHERE ca.credit_id = vc.id), 0))
                FROM vendor_credits vc WHERE vc.payee_id = v.id AND vc.status = 'open'), 0) AS held,
      (SELECT MAX(r.statement_date) FROM vendor_reconciliations r WHERE r.payee_id = v.id AND r.status = 'done') AS reconciled_to
    FROM payees v`,
  order: 'lower(x.name)',
  shape: (r) => ({
    id: r.id, name: r.name, owner_rule: r.segment || r.is_segment_split ? ownerOf(r) : null,
    transactions: r.transactions, last_transaction_date: day(r.last_transaction_date), unpaid_bills: r.unpaid_bills,
    owing: money(r.owing), deposits_held: money(r.held), net_owing: money(Number(r.owing) - Number(r.held)),
    opening_balance: money(r.opening_balance), opening_date: day(r.opening_date), reconciled_to: day(r.reconciled_to),
  }),
});

// ---------- bills ----------
const billOrder = (q) => (q.status === 'unpaid' || q.status === 'overdue' ? 'x.due_date ASC, x.id ASC' : 'x.due_date DESC, x.id DESC');
def({
  name: 'bills', mode: 'sql',
  description: 'Bills and invoices (accounts payable), paid and unpaid. amount = invoice total, owing_now = still to pay today (after deposits, plus finance interest); positive numbers. Unpaid/overdue lists are soonest due first, otherwise newest first. Recurring bills show only the current instance (see upcoming for future ones).',
  fields: ['id', 'name', 'vendor', 'category', 'amount', 'owing_now', 'owing_at_due', 'deposit_applied', 'currency', 'status', 'overdue',
    'frequency', 'received_date', 'due_date', 'paid_date', 'paid_from', 'gst', 'subtotal', 'financed', 'ledger', 'owner', 'notes', 'documents'],
  search: ['name', 'vendor', 'category', 'notes'],
  date: 'due_date',
  filters: [
    { name: 'status', type: 'enum', values: ['unpaid', 'paid', 'overdue'], sql: (v, p, ctx) => (v === 'overdue' ? `(x.status = 'unpaid' AND x.due_date < ${p(ctx.today)}::date)` : `x.status = ${p(v)}`) },
    f.textLike('vendor', 'vendor', 'vendor name (contains)'),
    f.textLike('category', 'category', 'category name (contains)'),
    f.minAbs('amount'), f.maxAbs('amount'), f.ledger(), f.owner(), f.month('due_date'),
    f.eq('frequency', 'frequency', ['one_time', 'monthly', 'quarterly']),
  ],
  base: (p, ctx) => `SELECT b.id, b.name, pv.name AS vendor, ${CAT_FULL('ec', 'pc')} AS category, b.amount,
      bill_owing(b, ${p(ctx.today)}::date) AS owing_now, bill_owing(b, b.due_date) AS owing_at_due,
      COALESCE((SELECT SUM(amount) FROM credit_applications WHERE bill_id = b.id), 0) AS deposit_applied,
      b.status::text AS status, b.frequency::text AS frequency, b.received_date, b.due_date, b.paid_date,
      COALESCE(a.name, cc.name || ' (card)') AS paid_from, b.has_gst, b.gst_pct, b.gst_amount, b.subtotal_amount,
      b.is_financed, b.finance_rate_pct, b.interest_free_until, b.balance_amount, b.balance_as_of,
      b.ledger::text AS ledger, ${SEG('b')}, b.notes,
      (SELECT COUNT(*) FROM receipts r WHERE r.bill_id = b.id)::int AS documents
    FROM bills b
    LEFT JOIN expense_categories ec ON ec.id = b.category_id
    LEFT JOIN expense_categories pc ON pc.id = ec.parent_id
    LEFT JOIN payees pv ON pv.id = b.payee_id
    LEFT JOIN transactions t ON t.id = b.linked_transaction_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id`,
  order: billOrder,
  shape: (r, ctx) => ({
    id: r.id, name: r.name, vendor: r.vendor, category: r.category, amount: money(r.amount),
    owing_now: r.status === 'unpaid' ? money(r.owing_now) : 0, owing_at_due: r.status === 'unpaid' ? money(r.owing_at_due) : 0,
    deposit_applied: money(r.deposit_applied), currency: CURRENCY, status: r.status,
    overdue: r.status === 'unpaid' && day(r.due_date) < ctx.today, frequency: r.frequency,
    received_date: day(r.received_date), due_date: day(r.due_date), paid_date: day(r.paid_date), paid_from: r.paid_from,
    gst: r.has_gst ? money(r.gst_amount) : null, subtotal: r.has_gst ? money(r.subtotal_amount) : null,
    financed: r.is_financed ? {
      rate_pct: num(r.finance_rate_pct), interest_free_until: day(r.interest_free_until),
      statement_balance: money(r.balance_amount), statement_date: day(r.balance_as_of),
    } : null,
    ledger: r.ledger, owner: ownerOf(r), notes: text(r.notes), documents: r.documents,
  }),
});

// ---------- vendor deposits ----------
def({
  name: 'vendor_deposits', mode: 'sql',
  description: 'Deposits and prepayments a vendor is holding (prepayment = applied to later bills, refundable = given back), with what has been applied and what remains. Positive amounts. Newest first.',
  fields: ['id', 'vendor', 'kind', 'amount', 'applied', 'remaining', 'currency', 'status', 'date', 'closed_date', 'paid_from', 'applied_to', 'note'],
  search: ['vendor', 'note'],
  date: 'date',
  filters: [f.eq('status', 'status', ['open', 'used', 'refunded', 'kept']), f.textLike('vendor', 'vendor', 'vendor name (contains)'), f.eq('kind', 'kind', ['prepayment', 'refundable'])],
  base: () => `SELECT vc.id, p.name AS vendor, vc.kind, vc.amount, vc.status, vc.date, vc.closed_date, vc.note,
      COALESCE((SELECT SUM(ca.amount) FROM credit_applications ca WHERE ca.credit_id = vc.id), 0) AS applied,
      (SELECT string_agg(b.name, '; ' ORDER BY ca.id) FROM credit_applications ca JOIN bills b ON b.id = ca.bill_id WHERE ca.credit_id = vc.id) AS applied_to,
      a.name AS paid_from
    FROM vendor_credits vc JOIN payees p ON p.id = vc.payee_id
    LEFT JOIN transactions t ON t.id = vc.transaction_id LEFT JOIN accounts a ON a.id = t.account_id`,
  order: 'x.date DESC, x.id DESC',
  shape: (r) => ({
    id: r.id, vendor: r.vendor, kind: r.kind, amount: money(r.amount), applied: money(r.applied),
    remaining: r.status === 'open' ? money(Number(r.amount) - Number(r.applied)) : 0, currency: CURRENCY, status: r.status,
    date: day(r.date), closed_date: day(r.closed_date), paid_from: r.paid_from, applied_to: text(r.applied_to), note: text(r.note),
  }),
});

// ---------- loans ----------
def({
  name: 'loans', mode: 'js',
  description: 'Loans and mortgages: lender, rate, outstanding principal today and in 12 months, next payment, overdue unrecorded payments, secured asset and equity, covenant and when last verified. Positive amounts owed. Largest balance first.',
  fields: ['id', 'name', 'lender', 'purpose', 'interest_rate_pct', 'rate_type', 'payment_frequency', 'outstanding_balance',
    'outstanding_in_12_months', 'currency', 'principal_entered', 'term_months', 'start_date', 'first_payment_date', 'next_payment',
    'overdue_unrecorded_payments', 'secured_asset', 'asset_value_now', 'equity', 'covenant_date', 'covenant_notes',
    'last_verified_on', 'days_since_verified', 'verified_payment', 'owner'],
  search: ['name', 'lender', 'secured_asset', 'covenant_notes'],
  filters: [f.jsEq('purpose', 'purpose', ['operating', 'term', 'capital_asset', 'mortgage']), f.jsOwner(),
    { name: 'paid_off', type: 'bool', test: (r, v) => (r.outstanding_balance <= 0.005) === v }],
  load: async (q, ctx) => {
    const [{ loans, assets }, { rows: next }, { rows: overdue }] = await Promise.all([
      loadBalanceSheet(),
      pool.query(`SELECT DISTINCT ON (loan_id) loan_id, principal_amount + interest_amount AS amount, due_date
                  FROM loan_payments WHERE paid = false AND is_adjustment = false AND due_date >= $1
                  ORDER BY loan_id, due_date`, [ctx.today]),
      pool.query(`SELECT loan_id, COUNT(*)::int AS n FROM loan_payments
                  WHERE paid = false AND is_adjustment = false AND due_date < $1 GROUP BY loan_id`, [ctx.today]),
    ]);
    const assetById = new Map(assets.map((a) => [a.id, a]));
    const nextBy = new Map(next.map((n) => [n.loan_id, n]));
    const overdueBy = new Map(overdue.map((o) => [o.loan_id, o.n]));
    return loans.map((l) => {
      const asset = l.asset_id ? assetById.get(l.asset_id) : null;
      const n = nextBy.get(l.id);
      const verified = day(l.last_verified_on);
      return {
        id: l.id, name: l.name || l.lender, lender: l.lender, purpose: l.purpose, interest_rate_pct: num(l.interest_rate_pct), rate_type: l.rate_type,
        payment_frequency: l.payment_frequency, outstanding_balance: money(l.outstanding), outstanding_in_12_months: money(l.outstanding12),
        currency: CURRENCY, principal_entered: money(l.principal), term_months: l.term_months, start_date: day(l.start_date),
        first_payment_date: day(l.first_payment_date), next_payment: n ? { date: day(n.due_date), amount: money(n.amount) } : null,
        overdue_unrecorded_payments: overdueBy.get(l.id) || 0, secured_asset: asset ? asset.name : (l.linked_asset || null),
        asset_value_now: asset ? money(asset.value_now) : null, equity: asset ? money(asset.equity_now) : null,
        covenant_date: day(l.covenant_date), covenant_notes: text(l.covenant_notes), last_verified_on: verified,
        days_since_verified: verified ? Math.floor((Date.parse(ctx.today) - Date.parse(verified)) / 86400000) : null,
        verified_payment: money(l.verified_payment), owner: ownerOf(l),
      };
    }).sort((a, b) => b.outstanding_balance - a.outstanding_balance || a.id - b.id);
  },
});

// ---------- loan payments ----------
const loanPayOrder = (q) => (q.status === 'unpaid' || q.status === 'overdue' ? 'x.due_date ASC, x.id ASC' : 'x.due_date DESC, x.id DESC');
def({
  name: 'loan_payments', mode: 'sql',
  description: 'Scheduled loan payments (the amortization schedule), paid and unpaid, with principal/interest split. Positive amounts. Unpaid/overdue lists are soonest first, otherwise newest due date first. kind "adjustment" rows are balance corrections from a verification, not payments.',
  fields: ['id', 'loan', 'lender', 'due_date', 'principal', 'interest', 'total', 'currency', 'paid', 'paid_date', 'overdue', 'kind', 'paid_from'],
  search: ['loan', 'lender'],
  date: 'due_date',
  filters: [
    f.nameOrId('loan', 'loan', 'loan_id', 'loan name or lender (contains), or loan id'),
    { name: 'status', type: 'enum', values: ['paid', 'unpaid', 'overdue'], sql: (v, p, ctx) => (v === 'paid' ? 'x.paid' : v === 'unpaid' ? 'NOT x.paid' : `(NOT x.paid AND x.due_date < ${p(ctx.today)}::date)`) },
    { name: 'kind', type: 'enum', values: ['payment', 'adjustment'], sql: (v) => (v === 'adjustment' ? 'x.is_adjustment' : 'NOT x.is_adjustment') },
    f.month('due_date'),
  ],
  base: () => `SELECT lp.id, lp.loan_id, COALESCE(NULLIF(l.name, ''), l.lender) || CASE WHEN l.name <> '' AND l.name <> l.lender THEN ' (' || l.lender || ')' ELSE '' END AS loan,
      l.lender, lp.due_date, lp.principal_amount, lp.interest_amount, lp.paid, lp.paid_date, lp.is_adjustment, a.name AS paid_from
    FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
    LEFT JOIN transactions t ON t.id = lp.linked_transaction_id LEFT JOIN accounts a ON a.id = t.account_id`,
  order: loanPayOrder,
  shape: (r, ctx) => ({
    id: r.id, loan: r.loan, lender: r.lender, due_date: day(r.due_date), principal: money(r.principal_amount), interest: money(r.interest_amount),
    total: money(Number(r.principal_amount) + Number(r.interest_amount)), currency: CURRENCY, paid: r.paid, paid_date: day(r.paid_date),
    overdue: !r.paid && !r.is_adjustment && day(r.due_date) < ctx.today, kind: r.is_adjustment ? 'adjustment' : 'payment', paid_from: r.paid_from,
  }),
});

// ---------- loan verifications ----------
def({
  name: 'loan_verifications', mode: 'sql',
  description: 'Each time a loan was checked against a statement or the lender: confirmed balance and rate vs what the schedule expected. Newest first.',
  fields: ['id', 'loan', 'verified_on', 'balance', 'expected_balance', 'difference', 'interest_rate_pct', 'expected_rate_pct', 'payment_amount',
    'currency', 'source', 'note', 'rebased'],
  search: ['loan', 'source', 'note'],
  date: 'verified_on',
  filters: [f.nameOrId('loan', 'loan', 'loan_id', 'loan name or lender (contains), or loan id')],
  base: () => `SELECT v.id, v.loan_id, COALESCE(NULLIF(l.name, ''), l.lender) AS loan, l.lender, v.verified_on, v.balance, v.expected_balance,
      v.interest_rate_pct, v.expected_rate_pct, v.payment_amount, v.source, v.note, v.rebased
    FROM loan_verifications v JOIN loans l ON l.id = v.loan_id`,
  order: 'x.verified_on DESC, x.id DESC',
  shape: (r) => ({
    id: r.id, loan: r.loan, verified_on: day(r.verified_on), balance: money(r.balance), expected_balance: money(r.expected_balance),
    difference: money(Number(r.balance) - Number(r.expected_balance)), interest_rate_pct: num(r.interest_rate_pct),
    expected_rate_pct: num(r.expected_rate_pct), payment_amount: money(r.payment_amount), currency: CURRENCY,
    source: r.source, note: text(r.note), rebased: r.rebased,
  }),
});

// ---------- credit cards ----------
def({
  name: 'credit_cards', mode: 'js',
  description: 'Credit cards: balance owed now (positive), limit and utilization, rates and fee, next statement amount due, grace-period status and reward rates. Card numbers are never stored beyond the last 4.',
  fields: ['id', 'name', 'issuer', 'last4', 'status', 'balance_owed', 'currency', 'credit_limit', 'utilization_pct', 'apr_purchase', 'apr_cash_advance',
    'annual_fee', 'annual_fee_month', 'grace_period_days', 'grace_period_intact', 'itemized', 'next_due', 'last_statement', 'rewards', 'owner', 'notes'],
  search: ['name', 'issuer', 'notes'],
  filters: [f.jsEq('status', 'status', ['active', 'closed']), f.jsOwner()],
  load: async (q, ctx) => {
    const [{ rows: cards }, { rows: statements }, { rows: rewards }] = await Promise.all([
      pool.query(`SELECT * FROM credit_cards ORDER BY (status = 'active') DESC, name`),
      pool.query(`SELECT id, credit_card_id, statement_date, due_date, statement_balance, minimum_payment, paid, paid_in_full, paid_amount
                  FROM credit_card_statements`),
      pool.query(`SELECT credit_card_id, category, rate_pct FROM credit_card_reward_categories ORDER BY category`),
    ]);
    const balances = await cardBalances(pool, cards);
    const cycle = (s) => toISODate(s.statement_date || s.due_date);
    return cards.map((c) => {
      const own = statements.filter((s) => s.credit_card_id === c.id).sort((a, b) => cycle(b).localeCompare(cycle(a)) || b.id - a.id);
      const latest = own[0] || null;
      const nextDue = latest && !latest.paid ? latest : null;
      const decided = own.find((s) => s.paid || day(s.due_date) < ctx.today) || null;
      const { outstanding, itemized } = balances.get(c.id) || { outstanding: 0, itemized: false };
      return {
        id: c.id, name: c.name, issuer: c.issuer, last4: c.last4 ? String(c.last4).slice(-4) : null, status: c.status,
        balance_owed: money(outstanding), currency: CURRENCY, credit_limit: money(c.credit_limit),
        utilization_pct: c.credit_limit ? Math.round((outstanding / Number(c.credit_limit)) * 10000) / 100 : null,
        apr_purchase: num(c.apr_purchase), apr_cash_advance: num(c.apr_cash_advance), annual_fee: money(c.annual_fee),
        annual_fee_month: c.annual_fee_month, grace_period_days: c.grace_period_days,
        grace_period_intact: decided ? decided.paid_in_full === true : null, itemized,
        next_due: nextDue ? {
          due_date: day(nextDue.due_date), amount: money(Number(nextDue.statement_balance) - Number(nextDue.paid_amount || 0)),
          minimum_payment: money(nextDue.minimum_payment), overdue: day(nextDue.due_date) < ctx.today,
        } : null,
        last_statement: latest ? { statement_date: day(latest.statement_date), due_date: day(latest.due_date), balance: money(latest.statement_balance), paid: latest.paid } : null,
        rewards: rewards.filter((r) => r.credit_card_id === c.id).map((r) => ({ category: r.category, rate_pct: num(r.rate_pct) })),
        owner: ownerOf(c), notes: text(c.notes),
      };
    });
  },
});

// ---------- card statements ----------
def({
  name: 'card_statements', mode: 'sql',
  description: 'Credit card statements (billing cycles): balance, minimum, interest charged, due date and whether/how it was paid. Positive amounts. Newest due date first.',
  fields: ['id', 'card', 'statement_date', 'due_date', 'statement_balance', 'minimum_payment', 'interest_charged', 'currency', 'paid', 'paid_in_full',
    'paid_date', 'paid_amount', 'paid_from', 'notes'],
  search: ['card', 'notes'],
  date: 'due_date',
  filters: [f.nameOrId('card', 'card', 'credit_card_id', 'card name (contains) or id'), { name: 'status', type: 'enum', values: ['paid', 'unpaid'], sql: (v) => (v === 'paid' ? 'x.paid' : 'NOT x.paid') }],
  base: () => `SELECT s.id, s.credit_card_id, c.name AS card, s.statement_date, s.due_date, s.statement_balance, s.minimum_payment, s.interest_amount,
      s.paid, s.paid_in_full, s.paid_date, s.paid_amount, a.name AS paid_from, s.notes
    FROM credit_card_statements s JOIN credit_cards c ON c.id = s.credit_card_id LEFT JOIN accounts a ON a.id = s.account_id`,
  order: 'x.due_date DESC, x.id DESC',
  shape: (r) => ({
    id: r.id, card: r.card, statement_date: day(r.statement_date), due_date: day(r.due_date), statement_balance: money(r.statement_balance),
    minimum_payment: money(r.minimum_payment), interest_charged: money(r.interest_amount), currency: CURRENCY, paid: r.paid,
    paid_in_full: r.paid_in_full, paid_date: day(r.paid_date), paid_amount: money(r.paid_amount), paid_from: r.paid_from, notes: text(r.notes),
  }),
});

// ---------- sale contracts ----------
def({
  name: 'contracts', mode: 'sql',
  description: 'Sale contracts (grain, cattle): money owed TO the farm. total_value, received, remaining are positive amounts; deposits lists the payments received. Open/delivered lists are soonest expected payment first, otherwise newest first.',
  fields: ['id', 'commodity', 'counterparty', 'quantity', 'unit', 'price_per_unit', 'total_value', 'received', 'remaining', 'deductions', 'currency',
    'status', 'delivery_date', 'contract_period_end', 'expected_payment_date', 'owner', 'source', 'deposits', 'documents', 'notes', 'settle_note'],
  search: ['commodity', 'counterparty', 'notes'],
  date: 'expected_payment_date',
  filters: [
    { name: 'status', type: 'enum', values: ['open', 'delivered', 'settled', 'cancelled', 'unsettled'], sql: (v, p) => (v === 'unsettled' ? `x.status IN ('open', 'delivered')` : `x.status = ${p(v)}`) },
    f.textLike('commodity', 'commodity', 'commodity (contains)'), f.textLike('counterparty', 'counterparty', 'buyer (contains)'), f.owner(),
  ],
  base: () => `SELECT c.id, c.commodity, c.counterparty, c.quantity, c.unit, c.price_per_unit, c.total_value, c.received_amount, c.deductions_amount,
      c.status::text AS status, c.delivery_date, c.contract_period_end, c.expected_payment_date, c.segment::text AS segment,
      false AS is_segment_split, NULL::numeric AS segment_grain_pct, NULL::numeric AS segment_livestock_pct,
      NULL::numeric AS segment_jake_pct, NULL::numeric AS segment_ashley_pct, c.source, c.notes, c.settle_note,
      (SELECT json_agg(json_build_object('date', t.date, 'amount', t.amount, 'account', a.name) ORDER BY t.date, t.id)
         FROM contract_payments cp JOIN transactions t ON t.id = cp.transaction_id LEFT JOIN accounts a ON a.id = t.account_id
         WHERE cp.contract_id = c.id) AS deposits,
      (SELECT COUNT(*) FROM receipts r WHERE r.contract_id = c.id)::int AS documents
    FROM sale_contracts c`,
  order: (q) => (q.status === 'open' || q.status === 'delivered' || q.status === 'unsettled' ? 'x.expected_payment_date ASC, x.id' : 'x.expected_payment_date DESC, x.id DESC'),
  shape: (r) => ({
    id: r.id, commodity: r.commodity, counterparty: r.counterparty, quantity: num(r.quantity), unit: r.unit, price_per_unit: money(r.price_per_unit),
    total_value: money(r.total_value), received: money(r.received_amount),
    remaining: ['open', 'delivered'].includes(r.status) ? money(Math.max(Number(r.total_value) - Number(r.received_amount), 0)) : 0,
    deductions: money(r.deductions_amount), currency: CURRENCY, status: r.status, delivery_date: day(r.delivery_date),
    contract_period_end: day(r.contract_period_end), expected_payment_date: day(r.expected_payment_date), owner: ownerOf(r), source: r.source,
    deposits: (r.deposits || []).map((d) => ({ date: day(d.date), amount: money(d.amount), account: d.account })),
    documents: r.documents, notes: text(r.notes), settle_note: text(r.settle_note),
  }),
});

// ---------- cash estimates ----------
def({
  name: 'estimates', mode: 'js',
  description: 'Jake\'s own cash-flow estimates (expected income and costs not yet backed by a bill or contract), one-off or recurring. amount is per occurrence and positive; direction says in or out. Includes the next 12 months of occurrences.',
  fields: ['id', 'name', 'category', 'commodity', 'direction', 'amount', 'currency', 'frequency', 'start_date', 'end_date', 'status',
    'next_occurrences', 'next_12_months_total', 'stale', 'owner', 'source', 'notes'],
  search: ['name', 'category', 'commodity', 'notes'],
  date: 'start_date',
  filters: [f.jsEq('direction', 'direction', ['inflow', 'outflow']), f.jsEq('status', 'status', ['active', 'retired']), f.jsOwner()],
  load: async (q, ctx) => {
    const { rows } = await pool.query(`SELECT * FROM cash_estimates ORDER BY status, start_date, id`);
    const horizon = addMonths(ctx.today, 12);
    return rows.map((e) => {
      const next = occurrences(e, ctx.today, horizon);
      return {
        id: e.id, name: e.name, category: e.category, commodity: e.commodity, direction: e.direction, amount: money(e.amount), currency: CURRENCY,
        frequency: e.frequency, start_date: day(e.start_date), end_date: day(e.end_date), status: e.status,
        next_occurrences: next.slice(0, 12), next_12_months_total: money(next.length * Number(e.amount)),
        stale: e.status === 'active' && next.length === 0, owner: ownerOf(e), source: e.source, notes: text(e.notes),
      };
    });
  },
});

// ---------- capital assets ----------
def({
  name: 'assets', mode: 'js',
  description: 'Capital assets (land, buildings, machinery, vehicles, breeding stock, investments) valued today by their appreciation/depreciation rate, with loans secured on them and equity. Positive amounts.',
  fields: ['id', 'name', 'category', 'value_now', 'value_in_12_months', 'recorded_value', 'value_date', 'annual_change_pct', 'cca_class', 'currency',
    'loans', 'loan_balance', 'equity_now', 'owner', 'notes'],
  search: ['name', 'category', 'notes'],
  filters: [f.jsEq('category', 'category', ['land', 'buildings', 'machinery', 'vehicles', 'breeding_livestock', 'investments', 'other']), f.jsOwner()],
  load: async () => {
    const { assets } = await loadBalanceSheet();
    return assets.map((a) => ({
      id: a.id, name: a.name, category: a.category, value_now: money(a.value_now), value_in_12_months: money(a.value_12mo),
      recorded_value: money(a.value), value_date: day(a.value_date), annual_change_pct: num(a.annual_change_pct), cca_class: a.cca_class,
      currency: CURRENCY, loans: a.loans.map((l) => ({ name: l.name, outstanding: money(l.outstanding) })), loan_balance: money(a.loan_balance),
      equity_now: money(a.equity_now), owner: ownerOf(a), notes: text(a.notes),
    }));
  },
});

// ---------- inventory ----------
def({
  name: 'inventory', mode: 'js',
  description: 'Inventory on hand: grain in bins, forage, market and breeding livestock, at the managers\' estimated prices. counted_value is the uncontracted share (contracted grain counts once, as the contract). Positive amounts.',
  fields: ['id', 'commodity', 'class', 'quantity', 'unit', 'quantity_contracted_reported', 'price_per_unit', 'price_basis', 'gross_value',
    'counted_value', 'currency', 'location', 'as_of', 'expected_sale_date', 'owner', 'source', 'notes'],
  search: ['commodity', 'location', 'notes'],
  date: 'as_of',
  filters: [f.jsEq('class', 'class', ['crop', 'forage', 'market_livestock', 'breeding_livestock', 'other']), f.jsLike('commodity', 'commodity', 'commodity (contains)'), f.jsOwner()],
  load: async () => {
    const { inventoryRows } = await loadBalanceSheet();
    return inventoryRows.map((i) => ({
      id: i.id, commodity: i.commodity, class: i.item_class, quantity: num(i.quantity), unit: i.unit,
      quantity_contracted_reported: num(i.quantity_contracted), price_per_unit: num(i.effective_price), price_basis: i.price_basis,
      gross_value: money(i.effective_price == null ? 0 : Number(i.quantity) * i.effective_price), counted_value: money(i.counted_value),
      currency: CURRENCY, location: i.location, as_of: day(i.as_of), expected_sale_date: day(i.expected_sale_date),
      owner: ownerOf({ ...i, ...inventoryOwnerRow(i) }), source: i.source, notes: text(i.notes),
    }));
  },
});

// ---------- owner draws / reserve transfers ----------
def({
  name: 'owner_draws', mode: 'sql',
  description: 'Owner draws (money taken out of the farm for family living). Positive amounts. Newest first.',
  fields: ['id', 'date', 'amount', 'currency', 'note'],
  search: ['note'], date: 'date',
  filters: [f.month('date')],
  base: () => 'SELECT id, date, amount, note FROM owner_draws',
  order: 'x.date DESC, x.id DESC',
  shape: (r) => ({ id: r.id, date: day(r.date), amount: money(r.amount), currency: CURRENCY, note: text(r.note) }),
});
def({
  name: 'reserve_transfers', mode: 'sql',
  description: 'Moves into (sweep_in) or out of (draw_out) the cash reserve. Positive amounts; direction says which way. Newest first.',
  fields: ['id', 'date', 'amount', 'currency', 'direction', 'note'],
  search: ['note'], date: 'date',
  filters: [f.eq('direction', 'direction', ['sweep_in', 'draw_out'])],
  base: () => 'SELECT id, date, amount, direction::text AS direction, note FROM reserve_transfers',
  order: 'x.date DESC, x.id DESC',
  shape: (r) => ({ id: r.id, date: day(r.date), amount: money(r.amount), currency: CURRENCY, direction: r.direction, note: text(r.note) }),
});

// ---------- purchase evaluations ----------
def({
  name: 'purchase_evaluations', mode: 'sql',
  description: 'Purchases Jake ran through the Purchase Evaluator: price, whether it passed the liquidity floor and debt-coverage tests, and the decision. Newest first.',
  fields: ['id', 'name', 'price', 'currency', 'purchase_class', 'mixed_use_business_pct', 'liquidity_pass', 'dscr_pass', 'opportunity_cost_units',
    'reversibility_score', 'decision', 'evaluated_on', 'notes'],
  search: ['name', 'notes'], date: 'evaluated_on',
  filters: [f.eq('decision', 'decision', ['pass', 'fail', 'pending'])],
  base: () => `SELECT id, name, price, purchase_class::text AS purchase_class, is_mixed_use, mixed_use_business_pct, liquidity_pass, dscr_pass,
      opportunity_cost_units, reversibility_score, decision::text AS decision, evaluated_at::date AS evaluated_on, notes FROM purchase_evaluations`,
  order: 'x.evaluated_on DESC, x.id DESC',
  shape: (r) => ({
    id: r.id, name: r.name, price: money(r.price), currency: CURRENCY, purchase_class: r.purchase_class,
    mixed_use_business_pct: r.is_mixed_use ? num(r.mixed_use_business_pct) : null, liquidity_pass: r.liquidity_pass, dscr_pass: r.dscr_pass,
    opportunity_cost_units: num(r.opportunity_cost_units), reversibility_score: r.reversibility_score, decision: r.decision,
    evaluated_on: day(r.evaluated_on), notes: text(r.notes),
  }),
});

// ---------- statements ----------
def({
  name: 'statement_imports', mode: 'sql',
  description: 'Bank and card statements loaded (and hand balance checks): period, opening/closing balance and what happened to their lines. Newest period first.',
  fields: ['id', 'account', 'card', 'kind', 'period_start', 'period_end', 'opening_balance', 'closing_balance', 'currency', 'due_date',
    'minimum_payment', 'interest_charged', 'historical', 'lines_posted', 'lines_matched', 'lines_held', 'lines_rejected'],
  search: ['account', 'card'], date: 'period_end',
  filters: [f.nameOrId('account', 'account', 'account_id', 'account name (contains) or id'), f.nameOrId('card', 'card', 'credit_card_id', 'card name (contains) or id')],
  base: () => `SELECT si.id, si.account_id, a.name AS account, si.credit_card_id, cc.name AS card, si.source, si.period_start, si.period_end,
      si.opening_balance, si.closing_balance, si.due_date, si.minimum_payment, si.interest_charged, si.historical,
      (SELECT COUNT(*) FROM statement_lines sl WHERE sl.import_id = si.id AND sl.status = 'posted')::int AS posted,
      (SELECT COUNT(*) FROM statement_lines sl WHERE sl.import_id = si.id AND sl.status = 'matched')::int AS matched,
      (SELECT COUNT(*) FROM statement_lines sl WHERE sl.import_id = si.id AND sl.status = 'held')::int AS held,
      (SELECT COUNT(*) FROM statement_lines sl WHERE sl.import_id = si.id AND sl.status = 'rejected')::int AS rejected
    FROM statement_imports si LEFT JOIN accounts a ON a.id = si.account_id LEFT JOIN credit_cards cc ON cc.id = si.credit_card_id`,
  order: 'x.period_end DESC NULLS LAST, x.id DESC',
  shape: (r) => ({
    id: r.id, account: r.account, card: r.card, kind: r.source === 'manual-check' ? 'balance check' : 'statement',
    period_start: day(r.period_start), period_end: day(r.period_end), opening_balance: money(r.opening_balance), closing_balance: money(r.closing_balance),
    currency: CURRENCY, due_date: day(r.due_date), minimum_payment: money(r.minimum_payment), interest_charged: money(r.interest_charged),
    historical: r.historical, lines_posted: r.posted, lines_matched: r.matched, lines_held: r.held, lines_rejected: r.rejected,
  }),
});
def({
  name: 'statement_lines', mode: 'sql',
  description: 'Individual bank/card statement lines and what became of each: posted (new entry), matched (to money already on file), held (waiting for Jake on the Review tab) or rejected. amount: + in, − out. Newest first.',
  fields: ['id', 'date', 'amount', 'currency', 'description', 'account', 'card', 'kind', 'status', 'reason', 'transaction_id', 'resolved_on'],
  search: ['description', 'reason', 'account', 'card'], date: 'date',
  filters: [f.eq('status', 'status', ['posted', 'matched', 'held', 'rejected']), f.nameOrId('account', 'account', 'account_id', 'account name (contains) or id'),
    f.nameOrId('card', 'card', 'credit_card_id', 'card name (contains) or id'), f.minAbs('amount'), f.maxAbs('amount')],
  base: () => `SELECT sl.id, sl.date, sl.amount, sl.description, sl.account_id, a.name AS account, sl.credit_card_id, cc.name AS card, sl.kind,
      sl.status::text AS status, sl.reason, sl.transaction_id, sl.resolved_at
    FROM statement_lines sl LEFT JOIN accounts a ON a.id = sl.account_id LEFT JOIN credit_cards cc ON cc.id = sl.credit_card_id`,
  order: 'x.date DESC, x.id DESC',
  shape: (r) => ({
    id: r.id, date: day(r.date), amount: money(r.amount), currency: CURRENCY, description: text(r.description), account: r.account, card: r.card,
    kind: r.kind, status: r.status, reason: text(r.reason), transaction_id: r.transaction_id, resolved_on: r.resolved_at ? day(new Date(r.resolved_at)) : null,
  }),
});

// ---------- receipts (no images) ----------
def({
  name: 'receipts', mode: 'sql',
  description: 'Receipt, invoice and sales-ticket photos (details read from them, never the image): who, total, GST, and the entry, bill or contract they belong to. Newest upload first.',
  fields: ['id', 'uploaded_on', 'status', 'doc_type', 'document_date', 'party', 'total', 'gst', 'currency', 'invoice_number', 'category', 'items',
    'reader_notes', 'error', 'size_kb', 'transaction', 'bill', 'contract'],
  search: ['party', 'invoice_number', 'category', 'reader_notes', 'tx_description', 'bill'], date: 'uploaded_on',
  filters: [f.eq('status', 'status', ['reading', 'unmatched', 'matched', 'review', 'failed', 'not_receipt', 'unread']),
    f.eq('doc_type', 'doc_type', ['receipt', 'invoice', 'sales_ticket'])],
  base: () => `SELECT r.id, r.uploaded_at::date AS uploaded_on, r.status, r.bytes, r.error,
      COALESCE(r.extracted->>'doc_type', 'receipt') AS doc_type, r.extracted->>'date' AS document_date, r.extracted->>'party' AS party,
      r.extracted->>'total' AS total, r.extracted->>'gst' AS gst, r.extracted->>'invoice_number' AS invoice_number,
      r.extracted->>'category' AS category, r.extracted->>'notes' AS reader_notes,
      CASE WHEN jsonb_typeof(r.extracted->'items') = 'array' THEN jsonb_array_length(r.extracted->'items') ELSE 0 END AS items,
      t.id AS tx_id, t.date AS tx_date, t.amount AS tx_amount, t.description AS tx_description, b.name AS bill, c.commodity AS contract
    FROM receipts r LEFT JOIN transactions t ON t.id = r.transaction_id LEFT JOIN bills b ON b.id = r.bill_id
    LEFT JOIN sale_contracts c ON c.id = r.contract_id`,
  order: 'x.uploaded_on DESC, x.id DESC',
  shape: (r) => ({
    id: r.id, uploaded_on: day(r.uploaded_on), status: r.status, doc_type: r.doc_type,
    document_date: PARSE.date(String(r.document_date || '')) || null, party: text(r.party, 200), total: money(r.total), gst: money(r.gst),
    currency: CURRENCY, invoice_number: text(r.invoice_number, 100), category: text(r.category, 200), items: r.items,
    reader_notes: text(r.reader_notes), error: text(r.error, 300), size_kb: Math.round(Number(r.bytes || 0) / 1024),
    transaction: r.tx_id ? { id: r.tx_id, date: day(r.tx_date), amount: money(r.tx_amount), description: text(r.tx_description, 200) } : null,
    bill: r.bill, contract: r.contract,
  }),
});

// ---------- GST returns / closed months / reconciliations / scenarios ----------
def({
  name: 'gst_returns', mode: 'sql', idType: 'text',
  description: 'GST returns filed, one per period (id = period start date). net_amount as filed: negative = refund to the farm, positive = GST owed. See gst for the period-by-period figures.',
  fields: ['id', 'period_start', 'period_end', 'filed_on', 'net_amount', 'currency', 'settled', 'notes'],
  search: ['notes'], date: 'period_start', filters: [],
  base: () => `SELECT to_char(period_start, 'YYYY-MM-DD') AS id, period_start, period_end, filed_on, net_amount, settlement_transaction_id, notes FROM gst_returns`,
  order: 'x.period_start DESC',
  shape: (r) => ({
    id: r.id, period_start: day(r.period_start), period_end: day(r.period_end), filed_on: day(r.filed_on), net_amount: money(r.net_amount),
    currency: CURRENCY, settled: r.settlement_transaction_id != null, notes: text(r.notes),
  }),
});
def({
  name: 'closed_months', mode: 'sql', idType: 'text',
  description: 'Months closed in the books (id = YYYY-MM): entries in a closed month cannot change until it is reopened.',
  fields: ['id', 'month', 'closed_on', 'forced', 'note'],
  search: ['note'], date: 'month', filters: [],
  base: () => `SELECT to_char(month, 'YYYY-MM') AS id, month, closed_at, forced, note FROM closed_periods`,
  order: 'x.month DESC',
  shape: (r) => ({ id: r.id, month: r.id, closed_on: r.closed_at ? day(new Date(r.closed_at)) : null, forced: r.forced, note: text(r.note) }),
});
def({
  name: 'vendor_reconciliations', mode: 'sql',
  description: 'Vendor-account reconciliations against the vendor\'s own statement (statement balance positive = owed to the vendor). Newest first.',
  fields: ['id', 'vendor', 'statement_date', 'statement_balance', 'currency', 'status', 'finished_on'],
  search: ['vendor'], date: 'statement_date',
  filters: [f.eq('status', 'status', ['open', 'done']), f.textLike('vendor', 'vendor', 'vendor name (contains)')],
  base: () => `SELECT r.id, p.name AS vendor, r.statement_date, r.statement_balance, r.status, r.finished_at
    FROM vendor_reconciliations r JOIN payees p ON p.id = r.payee_id`,
  order: 'x.statement_date DESC, x.id DESC',
  shape: (r) => ({
    id: r.id, vendor: r.vendor, statement_date: day(r.statement_date), statement_balance: money(r.statement_balance), currency: CURRENCY,
    status: r.status, finished_on: r.finished_at ? day(new Date(r.finished_at)) : null,
  }),
});
def({
  name: 'forecast_scenarios', mode: 'sql',
  description: 'Saved what-if scenarios for the cash forecast (their settings only; results are re-run in the app).',
  fields: ['id', 'name', 'updated_on', 'settings'],
  search: ['name'], filters: [],
  base: () => 'SELECT id, name, data, updated_at FROM forecast_scenarios',
  order: 'lower(x.name)',
  shape: (r) => {
    const json = JSON.stringify(r.data ?? {});
    return { id: r.id, name: r.name, updated_on: r.updated_at ? day(new Date(r.updated_at)) : null, settings: json.length <= TEXT_MAX ? r.data : text(json) };
  },
});

// ================= Summary collections =================

// ---------- balances ----------
def({
  name: 'balances', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY. Current balance of every account and credit card plus totals (kind "total": total_cash, business_cash, personal_cash, credit_card_debt, net_liquidity). Sign: positive = money Jake has, negative = owed (cards, overdrawn). Use for "how much money do I have".',
  fields: ['id', 'name', 'kind', 'ledger', 'type', 'balance', 'currency'],
  search: ['name'],
  filters: [f.jsEq('kind', 'kind', ['total', 'account', 'credit_card'])],
  load: async () => {
    const [{ rows: accts }, { rows: cards }] = await Promise.all([
      pool.query(`SELECT id, name, ledger::text AS ledger, account_type::text AS type, opening_balance FROM accounts ORDER BY ledger, account_type, name`),
      pool.query(`SELECT * FROM credit_cards WHERE status = 'active' ORDER BY name`),
    ]);
    const bal = await cardBalances(pool, cards);
    const sum = (rows, pred = () => true) => rows.filter(pred).reduce((s, a) => s + Number(a.opening_balance), 0);
    const cardDebt = cards.reduce((s, c) => s + (bal.get(c.id)?.outstanding || 0), 0);
    const cash = sum(accts);
    const t = (id, name, v) => ({ id, name, kind: 'total', ledger: null, type: null, balance: money(v), currency: CURRENCY });
    return [
      t('total_cash', 'Total in all accounts', cash),
      t('business_cash', 'Business (farm) accounts', sum(accts, (a) => a.ledger === 'business')),
      t('personal_cash', 'Personal accounts', sum(accts, (a) => a.ledger === 'personal')),
      t('credit_card_debt', 'Owed on credit cards', -cardDebt),
      t('net_liquidity', 'Cash minus credit card debt', cash - cardDebt),
      ...accts.map((a) => ({ id: `account-${a.id}`, name: a.name, kind: 'account', ledger: a.ledger, type: a.type, balance: money(a.opening_balance), currency: CURRENCY })),
      ...cards.map((c) => ({ id: `card-${c.id}`, name: c.name, kind: 'credit_card', ledger: null, type: 'credit_card', balance: money(-(bal.get(c.id)?.outstanding || 0)), currency: CURRENCY })),
    ];
  },
});

// Shared: the app's own Income & Expenses lines (routes/expenses.js countedLines).
const OWNER_VIEWS = ['all', 'farm', 'household', 'grain', 'cattle', 'jake', 'ashley'];
const viewOf = (v) => (v === 'cattle' ? 'livestock' : v || 'all');
function periodOf(q, ctx) {
  if (q.month) return { year: Number(q.month.slice(0, 4)), month: Number(q.month.slice(5, 7)), label: q.month };
  if (q.year) return { year: q.year, month: null, label: String(q.year) };
  return { year: Number(ctx.today.slice(0, 4)), month: Number(ctx.today.slice(5, 7)), label: ctx.today.slice(0, 7) };
}
const periodFilters = (defaultDoc) => [
  { name: 'month', type: 'month', param: true, doc: `YYYY-MM (${defaultDoc})` },
  { name: 'year', type: 'year', param: true, doc: 'YYYY: the whole year instead of a month' },
  { name: 'kind', type: 'enum', values: ['expense', 'income'], param: true, doc: 'expense (default) or income' },
];
const ownerView = { name: 'owner', type: 'enum', values: OWNER_VIEWS, param: true, doc: 'all (default; farm share without GST + household as paid), farm, household, grain, cattle, jake, ashley' };

// ---------- spending by category ----------
def({
  name: 'spending_by_category', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY. Spending (or income with kind=income) by parent category for a month (default: this month) or a year, same rules as the Income & Expenses page: transfers, loan principal and capital purchases excluded; farm share counted without GST. Amounts positive (a refund reduces spending). First row is the total. id = category id, "uncategorized" or "total".',
  fields: ['id', 'name', 'period', 'kind', 'total', 'share_pct', 'subcategories', 'currency'],
  search: ['name'],
  filters: [...periodFilters('default: this month'), ownerView],
  load: async (q, ctx) => {
    const per = periodOf(q, ctx);
    const kind = q.kind || 'expense';
    const [lines, { rows: cats }] = await Promise.all([
      countedLines(per.year, viewOf(q.owner), kind),
      pool.query('SELECT id, name, parent_id FROM expense_categories'),
    ]);
    const byId = new Map(cats.map((c) => [c.id, c]));
    const groups = new Map();
    let total = 0;
    for (const l of lines) {
      if (per.month && l.month !== per.month) continue;
      total += l.amount;
      const pid = l.parent_id ?? 'uncategorized';
      if (!groups.has(pid)) groups.set(pid, { id: String(pid), name: pid === 'uncategorized' ? 'Uncategorized' : byId.get(pid)?.name || 'Unknown', total: 0, subs: new Map() });
      const g = groups.get(pid);
      g.total += l.amount;
      if (l.category_id && l.category_id !== l.parent_id) {
        const n = byId.get(l.category_id)?.name || 'Other';
        g.subs.set(n, (g.subs.get(n) || 0) + l.amount);
      }
    }
    const rows = [...groups.values()].filter((g) => Math.abs(g.total) >= 0.005).sort((a, b) => b.total - a.total).map((g) => ({
      id: g.id, name: g.name, period: per.label, kind, total: money(g.total),
      share_pct: total ? Math.round((g.total / total) * 1000) / 10 : null,
      subcategories: g.subs.size ? [...g.subs].map(([name, v]) => ({ name, total: money(v) })).sort((a, b) => b.total - a.total) : null,
      currency: CURRENCY,
    }));
    return [{ id: 'total', name: `Total ${kind === 'income' ? 'income' : 'spending'}`, period: per.label, kind, total: money(total), share_pct: 100, subcategories: null, currency: CURRENCY }, ...rows];
  },
});

// ---------- budget vs actual ----------
def({
  name: 'budget_vs_actual', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY. Budget (each category\'s annual budget, spread by its monthly percentages) against actual spending, per parent category, for a month (month=YYYY-MM) or a year (default: this year; budget_to_date = budget through the current month). remaining = budget − actual; positive amounts. First row is the total.',
  fields: ['id', 'name', 'period', 'kind', 'budget', 'budget_to_date', 'actual', 'remaining', 'used_pct', 'over_budget', 'currency'],
  search: ['name'],
  filters: [
    { name: 'month', type: 'month', param: true, doc: 'YYYY-MM: one month' },
    { name: 'year', type: 'year', param: true, doc: 'YYYY (default: this year)' },
    { name: 'kind', type: 'enum', values: ['expense', 'income'], param: true, doc: 'expense (default) or income' },
    { name: 'over_budget', type: 'bool', test: (r, v) => r.over_budget === v },
  ],
  load: async (q, ctx) => {
    const per = q.month ? periodOf(q, ctx) : { year: q.year || Number(ctx.today.slice(0, 4)), month: null, label: String(q.year || ctx.today.slice(0, 4)) };
    const kind = q.kind || 'expense';
    const [lines, { rows: cats }] = await Promise.all([
      countedLines(per.year, 'all', kind),
      pool.query(`SELECT id, name, parent_id, kind, annual_total, monthly_pct FROM expense_categories WHERE kind = $1`, [kind]),
    ]);
    const thisYear = per.year === Number(ctx.today.slice(0, 4));
    const toMonth = per.year < Number(ctx.today.slice(0, 4)) ? 12 : thisYear ? Number(ctx.today.slice(5, 7)) : 0;
    const groups = new Map();
    const parentOf = (c) => (c.parent_id && cats.some((p) => p.id === c.parent_id) ? c.parent_id : c.id);
    const g = (id) => {
      if (!groups.has(id)) groups.set(id, { id: String(id), name: cats.find((c) => c.id === id)?.name || 'Uncategorized', budget: 0, toDate: 0, actual: 0 });
      return groups.get(id);
    };
    for (const c of cats) {
      const annual = Number(c.annual_total) || 0;
      if (!annual) continue;
      const pct = Array.isArray(c.monthly_pct) ? c.monthly_pct.map(Number) : Array(12).fill(1 / 12);
      const e = g(parentOf(c));
      e.budget += per.month ? annual * (pct[per.month - 1] || 0) : annual;
      e.toDate += per.month ? annual * (pct[per.month - 1] || 0) : annual * pct.slice(0, toMonth).reduce((s, x) => s + (x || 0), 0);
    }
    for (const l of lines) {
      if (per.month && l.month !== per.month) continue;
      g(l.parent_id ?? 'uncategorized').actual += l.amount;
    }
    const shape = (e) => ({
      id: e.id, name: e.name, period: per.label, kind, budget: money(e.budget), budget_to_date: money(e.toDate), actual: money(e.actual),
      remaining: money(e.budget - e.actual), used_pct: e.budget ? Math.round((e.actual / e.budget) * 1000) / 10 : null,
      over_budget: e.budget > 0 ? e.actual > e.budget + 0.005 : e.actual > 0.005, currency: CURRENCY,
    });
    const rows = [...groups.values()].filter((e) => e.budget || Math.abs(e.actual) >= 0.005).sort((a, b) => b.budget - a.budget || b.actual - a.actual);
    const tot = rows.reduce((t, e) => ({ budget: t.budget + e.budget, toDate: t.toDate + e.toDate, actual: t.actual + e.actual }), { budget: 0, toDate: 0, actual: 0 });
    return [shape({ id: 'total', name: 'Total', ...tot }), ...rows.map(shape)];
  },
});

// ---------- income and spending by month ----------
def({
  name: 'monthly_income_spending', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY. Income, spending and net for each month of a year (default: this year), same rules as the Income & Expenses page. id = YYYY-MM. income and spending positive; net = income − spending.',
  fields: ['id', 'month', 'income', 'spending', 'net', 'currency'],
  search: [], date: 'date',
  filters: [{ name: 'year', type: 'year', param: true, doc: 'YYYY (default: this year)' }, ownerView],
  load: async (q, ctx) => {
    const year = q.year || Number(ctx.today.slice(0, 4));
    const [inc, exp] = await Promise.all([countedLines(year, viewOf(q.owner), 'income'), countedLines(year, viewOf(q.owner), 'expense')]);
    const m = Array.from({ length: 12 }, (_, i) => ({ income: 0, spending: 0, i }));
    for (const l of inc) m[l.month - 1].income += l.amount;
    for (const l of exp) m[l.month - 1].spending += l.amount;
    return m.map((x) => {
      const id = `${year}-${String(x.i + 1).padStart(2, '0')}`;
      return { id, month: id, date: `${id}-01`, income: money(x.income), spending: money(x.spending), net: money(x.income - x.spending), currency: CURRENCY };
    }).reverse();
  },
  hidden: ['date'],
});

// ---------- upcoming ----------
def({
  name: 'upcoming', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY. What money is due in and out: unpaid bills (with future instances of recurring bills), scheduled loan payments, credit card payments due and expected contract payments, from today to 30 days out by default (from/to to change the window), plus anything overdue (overdue=true). amount: negative = money out, positive = money in. Soonest first.',
  fields: ['id', 'date', 'type', 'name', 'amount', 'currency', 'overdue', 'recurring_instance', 'detail'],
  search: ['name', 'detail'], date: 'date', ownDates: true,
  filters: [
    f.jsEq('type', 'type', ['bill', 'loan_payment', 'card_payment', 'contract_payment']),
    { name: 'direction', type: 'enum', values: ['in', 'out'], test: (r, v) => (v === 'in' ? r.amount > 0 : r.amount < 0) },
    { name: 'include_overdue', type: 'bool', param: true, doc: 'default true' },
  ],
  load: async (q, ctx) => {
    const from = q.from || ctx.today;
    const to = q.to || addDays(from, 30);
    const toExcl = addDays(to, 1);
    const withOverdue = q.include_overdue !== false;
    const [{ rows: bills }, { rows: pays }, cardsDue, { rows: contracts }] = await Promise.all([
      pool.query(`SELECT b.id, b.name, b.frequency, b.due_date, bill_owing(b, b.due_date) AS owing, p.name AS vendor
                  FROM bills b LEFT JOIN payees p ON p.id = b.payee_id WHERE b.status = 'unpaid' AND b.due_date < $1`, [toExcl]),
      pool.query(`SELECT lp.id, lp.due_date, lp.principal_amount + lp.interest_amount AS amount, lp.interest_amount,
                         COALESCE(NULLIF(l.name, ''), l.lender) AS loan, l.lender
                  FROM loan_payments lp JOIN loans l ON l.id = lp.loan_id
                  WHERE NOT lp.paid AND NOT lp.is_adjustment AND lp.due_date < $1`, [toExcl]),
      cardAmountsDue(pool, { dueBefore: toExcl }),
      pool.query(`SELECT id, commodity, counterparty, expected_payment_date, GREATEST(total_value - received_amount, 0) AS amount
                  FROM sale_contracts WHERE status IN ('open', 'delivered') AND expected_payment_date < $1`, [toExcl]),
    ]);
    const out = [];
    const push = (r) => {
      const overdue = r.date < ctx.today;
      if (r.date > to) return;
      if (r.date < from && !(overdue && withOverdue)) return;
      out.push({ ...r, amount: money(r.amount), currency: CURRENCY, overdue, recurring_instance: !!r.recurring_instance });
    };
    for (const b of bills) {
      const dates = billDates(b, ctx.today, toExcl);
      dates.forEach((d, i) => push({ id: `bill-${b.id}${i ? `-${d}` : ''}`, date: d, type: 'bill', name: b.name, amount: -Number(b.owing),
        recurring_instance: i > 0, detail: [b.vendor, b.frequency !== 'one_time' ? b.frequency : null].filter(Boolean).join(', ') || null }));
    }
    for (const p of pays) {
      push({ id: `loan_payment-${p.id}`, date: day(p.due_date), type: 'loan_payment', name: p.loan, amount: -Number(p.amount),
        detail: `${p.lender}; interest ${money(p.interest_amount)}` });
    }
    for (const c of cardsDue) {
      push({ id: `card_payment-${c.id}`, date: day(c.due_date), type: 'card_payment', name: `${c.name} statement`, amount: -Number(c.amount), detail: null });
    }
    for (const c of contracts) {
      if (!(Number(c.amount) > 0)) continue;
      push({ id: `contract_payment-${c.id}`, date: day(c.expected_payment_date), type: 'contract_payment',
        name: [c.commodity, c.counterparty].filter(Boolean).join(' — '), amount: Number(c.amount), detail: 'expected payment on a sale contract' });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  },
});

// ---------- cash-flow forecast ----------
const fcFilters = [
  { name: 'months', type: 'enum', values: ['12', '18', '24'], param: true, doc: 'forecast length, default 12' },
  { name: 'scope', type: 'enum', values: ['everything', 'farm', 'personal'], param: true, doc: 'default everything (farm + household)' },
  { name: 'include_tax', type: 'bool', param: true, doc: 'income tax instalments, default true' },
];
const fcOptions = (q) => ({ months: Number(q.months || 12), scope: q.scope || 'everything', includeTax: q.include_tax !== false });
def({
  name: 'cash_flow_forecast', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY. The app\'s month-by-month cash forecast (same as its Cash Flow page): starting from today\'s balances, each month\'s money in (+), money out (−), closing balance with estimates, and the committed-only balance. First row (kind "summary") has the required floor and lowest month. id = YYYY-MM.',
  fields: ['id', 'kind', 'month', 'opening', 'inflow', 'outflow', 'closing_balance', 'committed_only_balance', 'below_floor', 'breakdown', 'largest_items',
    'starting_balance', 'required_floor', 'buffer_pct', 'lowest_month', 'lowest_balance', 'passes', 'scope', 'currency'],
  search: ['month'], date: 'date',
  filters: fcFilters,
  hidden: ['date'],
  load: async (q) => {
    const opts = fcOptions(q);
    const lf = await liquidityFloor(opts);
    const ym = (m) => `${m.year}-${String(m.month).padStart(2, '0')}`;
    const summary = {
      id: 'summary', kind: 'summary', scope: opts.scope, starting_balance: money(lf.startingBalance), required_floor: money(lf.requiredFloor),
      buffer_pct: num(lf.bufferPct), lowest_month: ym(lf.floorMonth), lowest_balance: money(lf.floorMonth.balance), passes: lf.passes, currency: CURRENCY,
    };
    return [summary, ...lf.trajectory.map((m) => ({
      id: ym(m), kind: 'month', month: ym(m), date: `${ym(m)}-01`, opening: money(m.open), inflow: money(m.inflow), outflow: money(m.outflow),
      closing_balance: money(m.balance), committed_only_balance: money(m.committedBalance), below_floor: m.balance < lf.requiredFloor,
      breakdown: {
        contracts: money(m.contractInflows), estimated_inflows: money(m.estimatedInflows), bills: money(-m.unpaidBillsDue), loan_payments: money(-m.debtServiceDue),
        card_payments: money(-m.creditCardDue), account_fees: money(-m.accountFees), estimated_outflows: money(-m.estimatedOutflows),
        income_tax: money(-m.taxInstalment), gst: money(m.gst), other: money(m.other),
      },
      largest_items: m.items.slice(0, 5).map((i) => ({ label: text(i.label, 200), date: day(i.date), amount: money(i.amount), estimate: !!i.estimate })),
      currency: CURRENCY,
    }))];
  },
});

// ---------- liquidity ----------
def({
  name: 'liquidity', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY (one row). Liquidity position: cash today, the required cash floor (buffer % of average monthly outflow), the lowest forecast month-end with and without estimates, whether the floor holds, the reserve vs its target, and deployable cash (cash − floor − reserve target).',
  fields: ['id', 'cash_today', 'required_floor', 'buffer_pct', 'lowest_month', 'lowest_balance', 'committed_lowest_month', 'committed_lowest_balance',
    'passes', 'reserve', 'reserve_target', 'reserve_target_months', 'reserve_funded_pct', 'deployable_cash', 'currency'],
  search: [], filters: [],
  load: async (q, ctx) => {
    const [lf, rs] = await Promise.all([liquidityFloor(), reserveStatus(Number(ctx.today.slice(0, 4)))]);
    const ym = (m) => `${m.year}-${String(m.month).padStart(2, '0')}`;
    return [{
      id: 'liquidity', cash_today: money(lf.startingBalance), required_floor: money(lf.requiredFloor), buffer_pct: num(lf.bufferPct),
      lowest_month: ym(lf.floorMonth), lowest_balance: money(lf.floorMonth.balance),
      committed_lowest_month: ym(lf.committedFloorMonth), committed_lowest_balance: money(lf.committedFloorMonth.balance), passes: lf.passes,
      reserve: money(rs.currentReserve), reserve_target: money(rs.target), reserve_target_months: num(rs.targetMonths),
      reserve_funded_pct: rs.fundedPct == null ? null : Math.round(rs.fundedPct * 1000) / 10,
      deployable_cash: money(lf.startingBalance - lf.requiredFloor - rs.target), currency: CURRENCY,
    }];
  },
});

// ---------- net worth ----------
def({
  name: 'net_worth', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY (one row). Net worth / equity, the same valuation as the dashboard: all account balances + capital assets valued today + uncontracted inventory − loan principal − credit card balances. Liabilities shown as positive amounts; net_worth can be negative.',
  fields: ['id', 'cash', 'capital_assets', 'inventory', 'total_assets', 'loans_outstanding', 'credit_card_debt', 'total_liabilities', 'net_worth',
    'net_worth_in_12_months', 'assets_by_category', 'inventory_items_without_price', 'currency'],
  search: [], filters: [],
  load: async () => {
    const [{ rows: [cashRow] }, sheet] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(opening_balance), 0) AS total FROM accounts'), loadBalanceSheet(),
    ]);
    const cash = Number(cashRow.total);
    const capital = sheet.assets.reduce((s, a) => s + a.value_now, 0);
    const capital12 = sheet.assets.reduce((s, a) => s + a.value_12mo, 0);
    const inv = sheet.inventoryRows.reduce((s, i) => s + i.counted_value, 0);
    const loans = sheet.loans.reduce((s, l) => s + l.outstanding, 0);
    const loans12 = sheet.loans.reduce((s, l) => s + l.outstanding12, 0);
    const cards = sheet.creditCards.reduce((s, c) => s + c.outstanding, 0);
    const byCat = {};
    for (const a of sheet.assets) byCat[a.category] = (byCat[a.category] || 0) + a.value_now;
    return [{
      id: 'net_worth', cash: money(cash), capital_assets: money(capital), inventory: money(inv), total_assets: money(cash + capital + inv),
      loans_outstanding: money(loans), credit_card_debt: money(cards), total_liabilities: money(loans + cards),
      net_worth: money(cash + capital + inv - loans - cards),
      net_worth_in_12_months: money(cash + capital12 + inv - loans12 - cards),
      assets_by_category: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, money(v)])),
      inventory_items_without_price: sheet.inventoryGroups.reduce((s, g) => s + (g.needs_price || 0), 0), currency: CURRENCY,
    }];
  },
});

// ---------- debt coverage ----------
def({
  name: 'debt_coverage', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY. Term debt coverage ratio (FFSC, what ag lenders test; minimum usually 1.25×), historical (last 12 months) and projected (next 12 months — the gating figure), with the lines that build each. ratio null = no term debt scheduled.',
  fields: ['id', 'from', 'to', 'ratio', 'threshold', 'passes', 'capacity', 'term_principal', 'term_interest', 'term_debt_service', 'lines', 'currency'],
  search: [], filters: [],
  load: async () => {
    const c = await termDebtCoverage();
    return ['projected', 'historical'].map((k) => ({
      id: k, from: day(c[k].from), to: day(c[k].to), ratio: c[k].ratio == null ? null : Math.round(c[k].ratio * 100) / 100, threshold: num(c.threshold),
      passes: c[k].passes, capacity: money(c[k].capacity), term_principal: money(c[k].termPrincipal), term_interest: money(c[k].termInterest),
      term_debt_service: money(c[k].termDebtService), lines: c[k].lines.map((l) => ({ label: l.label, amount: money(l.amount) })), currency: CURRENCY,
    }));
  },
});

// ---------- overview (the Sentinel Money tile) ----------
/** Integer-cents fields from the Money tile summary → dollars (…_cents → …). */
export function centsToDollars(v) {
  if (Array.isArray(v)) return v.map(centsToDollars);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.endsWith('_cents') && typeof x === 'number') out[k.slice(0, -6)] = Math.round(x) / 100;
      else out[k] = centsToDollars(x);
    }
    return out;
  }
  return v;
}
def({
  name: 'overview', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY (one row). The headline the Sentinel Money tile shows, built by the same code: status line, last-30-day cash flow, 90-day forecast vs floor, equity, operating margin, debt coverage and ROA, with notes on how each was worked out. Start here for "how are the finances".',
  fields: ['id', 'generated_at', 'status_line', 'cash_flow', 'forecast_90d', 'equity', 'performance', 'notes', 'currency'],
  search: [], filters: [],
  load: async () => {
    const s = await buildSummaryFromDb(new Date());
    return [{ id: 'overview', generated_at: s.generated_at, ...centsToDollars(s.summary), currency: CURRENCY }];
  },
});

// ---------- income tax ----------
def({
  name: 'income_tax_estimate', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY (one row). Farm income tax estimate for a year (default this year) from the Tax tab: actual income and costs to date, forecast to Dec 31, CCA, projected net income and tax, and the Dec 31 instalment. Positive amounts.',
  fields: ['id', 'year', 'as_of', 'actual', 'forecast', 'cca', 'projected', 'instalment', 'gst_gap', 'currency'],
  search: [], filters: [{ name: 'year', type: 'year', param: true, doc: 'YYYY (default: this year)' }],
  load: async (q, ctx) => {
    const year = q.year || Number(ctx.today.slice(0, 4));
    const t = await farmIncomeTax(year);
    return [{
      id: String(year), year, as_of: t.as_of, actual: t.actual,
      forecast: { revenue: t.forecast.revenue, expenses: t.forecast.expenses, items: t.forecast.items.slice(0, 20) },
      cca: { amount: t.cca.amount, estimate: t.cca.estimate, accountant_figure: t.cca.override }, projected: t.projected,
      instalment: t.instalment, gst_gap: t.gst_gap, currency: CURRENCY,
    }];
  },
});

// ---------- GST by period ----------
def({
  name: 'gst', mode: 'js', idType: 'text', summary: true,
  description: 'SUMMARY. GST by reporting period for a year (default this year): GST collected, input tax credits, net (negative = refund to the farm), filing status and farm purchases with no GST recorded. id = period start.',
  fields: ['id', 'label', 'start', 'end', 'due', 'collected', 'itc', 'net', 'status', 'filed_on', 'filed_net', 'purchases', 'purchases_no_gst',
    'purchases_no_gst_amount', 'currency'],
  search: ['label', 'status'], date: 'start',
  filters: [{ name: 'year', type: 'year', param: true, doc: 'YYYY (default: this year)' }, f.jsEq('status', 'status', ['current', 'to_file', 'overdue', 'filed', 'settled'])],
  load: async (q, ctx) => {
    const g = await gstReport(q.year || Number(ctx.today.slice(0, 4)));
    return g.periods.map((p) => ({
      id: p.start, label: p.label ?? null, start: p.start, end: p.end, due: p.due ?? null, collected: p.collected, itc: p.itc, net: p.net,
      status: p.status, filed_on: p.filed_on, filed_net: p.filed_net, purchases: p.purchases, purchases_no_gst: p.purchases_no_gst,
      purchases_no_gst_amount: p.purchases_no_gst_amount, currency: CURRENCY,
    }));
  },
});

// ================= Engine =================

const byName = new Map(collections.map((c) => [c.name, c]));

/** Filter names a collection accepts, in catalog order. */
function filterNames(c) {
  return ['search', 'id', ...(c.date ? ['from', 'to'] : []), ...c.filters.map((x) => x.name)].filter((n, i, a) => a.indexOf(n) === i)
    .filter((n) => n !== 'search' || (c.search && c.search.length));
}

export function catalog() {
  return {
    app: APP,
    collections: collections.map((c) => ({
      name: c.name, description: c.description, filters: filterNames(c), fields: c.fields,
    })),
  };
}

function badFilter(msg) { return new ReadError(422, msg); }

/** Validates the query string against a collection's filters. */
export function parseQuery(c, query) {
  const allowed = new Set([...filterNames(c), 'limit']);
  const specs = new Map(c.filters.map((s) => [s.name, s]));
  const q = {};
  for (const [k, raw] of Object.entries(query || {})) {
    if (!allowed.has(k)) {
      throw badFilter(`Unknown filter "${k}" for ${c.name}. Allowed: ${[...allowed].join(', ')}.`);
    }
    if (typeof raw !== 'string') throw badFilter(`Filter "${k}" must be given once, as plain text.`);
    if (raw === '') continue;
    let spec = specs.get(k);
    if (!spec) {
      if (k === 'search') spec = { type: 'text' };
      else if (k === 'from' || k === 'to') spec = { type: 'date' };
      else if (k === 'limit') spec = { type: 'int' };
      else if (k === 'id') spec = { type: c.idType === 'text' ? 'text' : 'int' };
    }
    const v = PARSE[spec.type](raw, spec);
    if (v === undefined) {
      const hint = spec.type === 'enum' ? `one of ${spec.values.join(', ')}` : HINT[spec.type];
      throw badFilter(`Filter "${k}" must be ${hint} (got "${raw.slice(0, 50)}").`);
    }
    q[k] = v;
  }
  if (q.limit !== undefined && q.limit < 1) throw badFilter('Filter "limit" must be at least 1.');
  if (q.from && q.to && q.from > q.to) throw badFilter('"from" is after "to".');
  return q;
}

async function runSql(c, q, ctx, limit) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const base = c.base(p, ctx);
  const where = [];
  if (q.id !== undefined) where.push(`x.id = ${p(q.id)}`);
  if (q.search) {
    const s = p(like(q.search));
    where.push(`(${c.search.map((col) => `x.${col}::text ILIKE ${s}`).join(' OR ')})`);
  }
  if (q.from) where.push(`x.${c.date} >= ${p(q.from)}::date`);
  if (q.to) where.push(`x.${c.date} <= ${p(q.to)}::date`);
  for (const spec of c.filters) {
    if (q[spec.name] !== undefined) where.push(spec.sql(q[spec.name], p, ctx));
  }
  const order = typeof c.order === 'function' ? c.order(q) : c.order;
  const sql = `SELECT x.*, COUNT(*) OVER () AS _total FROM (${base}) x
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${p(limit)}`;
  const { rows } = await pool.query(sql, params);
  return { rows: rows.map((r) => c.shape(r, ctx)), total: rows.length ? Number(rows[0]._total) : 0 };
}

async function runJs(c, q, ctx, limit) {
  let rows = await c.load(q, ctx);
  if (q.id !== undefined) rows = rows.filter((r) => String(r.id) === String(q.id));
  if (q.search) {
    const s = q.search.toLowerCase();
    rows = rows.filter((r) => c.search.some((k) => r[k] != null && String(r[k]).toLowerCase().includes(s)));
  }
  if (!c.ownDates && (q.from || q.to)) {
    rows = rows.filter((r) => {
      const d = r[c.date];
      if (d == null) return true; // undated summary rows always stay
      return (!q.from || d >= q.from) && (!q.to || d <= q.to);
    });
  }
  for (const spec of c.filters) {
    if (!spec.param && spec.test && q[spec.name] !== undefined) rows = rows.filter((r) => spec.test(r, q[spec.name], ctx));
  }
  const total = rows.length;
  rows = rows.slice(0, limit);
  if (c.hidden) rows = rows.map((r) => { const o = { ...r }; for (const h of c.hidden) delete o[h]; return o; });
  return { rows, total };
}

/** GET /api/sentinel/read/:collection */
export async function readCollection(name, query, { now = new Date() } = {}) {
  const c = byName.get(name);
  if (!c) throw new ReadError(404, `Unknown collection "${name}". GET /api/sentinel/read lists them.`);
  const q = parseQuery(c, query);
  const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const ctx = { today: reginaToday(now) };
  const { rows, total } = c.mode === 'sql' ? await runSql(c, q, ctx, limit) : await runJs(c, q, ctx, limit);
  // Keep the response under ~200 KB: drop rows from the end if needed.
  let out = rows;
  while (out.length > 1 && Buffer.byteLength(JSON.stringify(out)) > MAX_BYTES) out = out.slice(0, Math.max(1, Math.floor(out.length * 0.8)));
  return { collection: c.name, rows: out, count: out.length, total, truncated: out.length < total };
}

export const COLLECTION_NAMES = collections.map((c) => c.name);
