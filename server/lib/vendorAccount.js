// Vendor accounts: each vendor as a payable account with a running balance.
//
// Bills (and finance interest) raise the balance; payments, deposits paid
// ahead and refunds-received move it the other way. A positive balance is
// what you owe the vendor; negative means they're holding your money.
//
// This is a view built from bills, their payments and vendor deposits — it
// books nothing. Expenses for profit and tax still come from the payment
// (cash method), exactly as before.
import { toISODate, todayISO, addDays } from './dates.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const dayNum = (d) => { const [y, m, dd] = toISODate(d).split('-').map(Number); return Date.UTC(y, m - 1, dd) / 86400000; };
const maxDate = (...ds) => ds.filter(Boolean).map(toISODate).sort().pop() || null;
const ordinal = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthEnd = (d) => {
  const [y, m] = toISODate(d).split('-').map(Number);
  const t = new Date(Date.UTC(y, m, 0));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

/** The day a bill lands on the account: the invoice date, else (recurring) its due date, else when it was entered. */
export function billDate(b) {
  if (b.received_date) return toISODate(b.received_date);
  if (b.frequency && b.frequency !== 'one_time') {
    // A recurring charge lands when it's due — or when it was paid, if that was earlier.
    const paid = b.status === 'paid' ? toISODate(b.tx_date || b.paid_date) : null;
    return paid && paid < toISODate(b.due_date) ? paid : toISODate(b.due_date);
  }
  const made = toISODate(b.created_at) || toISODate(b.due_date);
  return made < toISODate(b.due_date) ? made : toISODate(b.due_date);
}

// Same terms as bill_owing() in schema.sql, before deposits: the base
// (invoice, or the latest vendor statement balance) plus simple daily
// interest from the later of the interest-free date and that statement.
const interestStart = (b) => maxDate(b.balance_as_of, b.interest_free_until) || toISODate(b.received_date) || toISODate(b.created_at);
export function rawOwing(b, d) {
  if (!b.is_financed) return Number(b.amount);
  const base = Number(b.balance_amount ?? b.amount);
  const start = interestStart(b) || toISODate(d);
  const days = Math.max(dayNum(d) - dayNum(start), 0);
  return round2(base * (1 + Number(b.finance_rate_pct || 0) / 100 * days / 365));
}

/** Interest on `base` from `start` to `end`, one line per month end (and `end`), summing to `total`. */
function monthlyInterest(b, base, start, end, total, keyPrefix) {
  const out = [];
  if (!start || !end || end <= start || Math.abs(total) < 0.005) return out;
  const rate = Number(b.finance_rate_pct || 0) / 100;
  const cum = (d) => round2(base * rate * (dayNum(d) - dayNum(start)) / 365);
  let prev = 0;
  let at = start;
  while (at <= end) {
    const me = monthEnd(at);
    const stop = me < end ? me : end;
    const c = stop === end ? total : cum(stop);
    const amt = round2(c - prev);
    if (Math.abs(amt) >= 0.005) {
      const [y, m] = stop.split('-').map(Number);
      out.push({
        key: `${keyPrefix}:${b.id}:${stop.slice(0, 7)}`, date: stop, kind: 'interest', amount: amt, bill_id: b.id,
        label: `Interest — ${b.name} (${MONTHS[m - 1]} ${y}${stop === end && stop !== me ? `, to the ${Number(stop.slice(8))}${ordinal(Number(stop.slice(8)))}` : ''})`,
      });
    }
    prev = c;
    at = addDays(stop, 1);
  }
  return out;
}

/** The bill's charge lines up to `end`: the invoice, any vendor-statement adjustment, and monthly interest. Sums to rawOwing(b, end). */
function chargeLines(b, end) {
  const lines = [{ key: `bill:${b.id}`, date: billDate(b), kind: 'bill', amount: round2(b.amount), bill_id: b.id, label: b.name, due_date: toISODate(b.due_date),
    gst: b.has_gst ? round2(b.gst_amount || 0) : null, has_gst: !!b.has_gst, paid: b.status === 'paid' }];
  if (!b.is_financed) return lines;
  const total = round2(rawOwing(b, end) - Number(b.amount));
  if (b.balance_as_of && b.balance_amount != null) {
    // Before the vendor's statement: interest on the invoice, then whatever
    // the statement says on top of that, then interest on the statement balance.
    const asOf = toISODate(b.balance_as_of);
    const s1 = toISODate(b.interest_free_until) || toISODate(b.received_date) || toISODate(b.created_at);
    const e1 = asOf < end ? asOf : end;
    const i1Total = s1 && e1 > s1 ? round2(Number(b.amount) * Number(b.finance_rate_pct || 0) / 100 * (dayNum(e1) - dayNum(s1)) / 365) : 0;
    lines.push(...monthlyInterest(b, Number(b.amount), s1, e1, i1Total, 'int1'));
    if (asOf <= end) {
      const adj = round2(Number(b.balance_amount) - Number(b.amount) - i1Total);
      if (Math.abs(adj) >= 0.005) lines.push({ key: `adj:${b.id}`, date: asOf, kind: 'adjust', amount: adj, bill_id: b.id, label: `Balance per vendor statement — ${b.name}` });
      const s2 = interestStart(b);
      lines.push(...monthlyInterest(b, Number(b.balance_amount), s2, end, round2(total - i1Total - adj), 'int'));
    }
    return lines;
  }
  lines.push(...monthlyInterest(b, Number(b.amount), interestStart(b), end, total, 'int'));
  return lines;
}

const ORDER = { opening: -1, spot: 4, received: 4, onaccount: 4, bill: 0, adjust: 1, interest: 2, deposit: 3, payment: 4, diff: 5, marked: 5, refund: 6, kept: 7 };

/**
 * The vendor's account: every line with its running balance, plus bills
 * scheduled but not billed yet (recurring ones with a future date).
 */
export async function vendorStatement(db, payeeId, today = todayISO()) {
  const { rows: bills } = await db.query(
    `SELECT b.*, COALESCE((SELECT SUM(amount) FROM credit_applications WHERE bill_id = b.id), 0) AS applied,
            t.date AS tx_date, t.amount AS tx_amount, t.description AS tx_description, t.awaiting_statement AS tx_awaiting, t.gst_amount AS tx_gst,
            COALESCE(a.name, cc.name) AS tx_account
     FROM bills b
     LEFT JOIN transactions t ON t.id = b.linked_transaction_id
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     WHERE b.payee_id = $1 ORDER BY b.id`, [payeeId]);
  const { rows: credits } = await db.query(
    `SELECT vc.*, vc.amount - COALESCE((SELECT SUM(amount) FROM credit_applications WHERE credit_id = vc.id), 0) AS remaining,
            rt.date AS refund_date, rt.amount AS refund_amount, dt.gst_amount AS tx_gst, dt.description AS tx_description,
            dt.awaiting_statement AS tx_awaiting, COALESCE(da.name, dc.name) AS tx_account,
            (SELECT json_agg(b.name ORDER BY ca.id) FROM credit_applications ca JOIN bills b ON b.id = ca.bill_id WHERE ca.credit_id = vc.id) AS applied_to
     FROM vendor_credits vc LEFT JOIN transactions rt ON rt.id = vc.refund_transaction_id
     LEFT JOIN transactions dt ON dt.id = vc.transaction_id
     LEFT JOIN accounts da ON da.id = dt.account_id
     LEFT JOIN credit_cards dc ON dc.id = dt.credit_card_id
     WHERE vc.payee_id = $1 ORDER BY vc.id`, [payeeId]);

  const { rows: [payee] } = await db.query('SELECT opening_balance, opening_date FROM payees WHERE id = $1', [payeeId]);
  // Every other entry paid to (or received from) this vendor: no bill behind it.
  const { rows: loose } = await db.query(
    `SELECT t.id, t.date, t.amount, t.description, t.gst_amount, t.awaiting_statement, COALESCE(a.name, cc.name) AS account,
            EXISTS (SELECT 1 FROM vendor_on_account o WHERE o.transaction_id = t.id) AS on_account
     FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
     WHERE t.payee_id = $1 AND NOT t.is_transfer
       AND NOT EXISTS (SELECT 1 FROM bills x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM vendor_credits x WHERE x.transaction_id = t.id OR x.refund_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM loan_payments x WHERE x.linked_transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM contract_payments x WHERE x.transaction_id = t.id)
     ORDER BY t.date, t.id`, [payeeId]);

  const lines = [];
  const upcoming = [];
  const byTx = new Map();
  const opening = payee?.opening_date ? { amount: round2(payee.opening_balance || 0), date: toISODate(payee.opening_date) } : null;
  if (opening) lines.push({ key: 'open', date: opening.date, kind: 'opening', amount: opening.amount, label: 'Opening balance' });
  for (const t of loose) {
    const base = { date: toISODate(t.date), transaction_id: t.id, label: t.description || 'Entry', account: t.account,
      gst: t.gst_amount == null ? null : round2(t.gst_amount), awaiting: !!t.awaiting_statement };
    if (t.on_account) lines.push({ ...base, key: `acct:${t.id}`, kind: 'onaccount', amount: round2(t.amount) });
    // Money in from them (wages, a rebate cheque) is income to you, not a
    // charge on the account: shown, but it doesn't move the balance.
    else if (Number(t.amount) > 0) lines.push({ ...base, key: `spot:${t.id}`, kind: 'received', amount: 0, received: round2(t.amount) });
    else lines.push({ ...base, key: `spot:${t.id}`, kind: 'spot', amount: 0, spot: round2(t.amount) });
  }
  for (const b of bills) {
    const applied = Number(b.applied);
    if (b.status === 'unpaid') {
      if (billDate(b) > today) {
        upcoming.push({ bill_id: b.id, name: b.name, date: billDate(b), due_date: toISODate(b.due_date), amount: round2(b.amount) });
        continue;
      }
      lines.push(...chargeLines(b, today));
      continue;
    }
    if (b.linked_transaction_id) {
      const end = toISODate(b.tx_date);
      lines.push(...chargeLines(b, end));
      const g = byTx.get(b.linked_transaction_id) || { b, owed: 0, names: [] };
      g.owed += rawOwing(b, end) - applied;
      g.names.push(b.name);
      byTx.set(b.linked_transaction_id, g);
    } else {
      // Paid with no payment on file — by a deposit, or marked paid before payments were linked.
      const end = toISODate(b.paid_date) || billDate(b);
      lines.push(...chargeLines(b, end));
      const left = round2(rawOwing(b, end) - applied);
      if (left > 0.005) lines.push({ key: `mp:${b.id}`, date: end, kind: 'marked', amount: -left, bill_id: b.id, label: `Marked paid — no payment on file (${b.name})` });
    }
  }
  for (const [txId, g] of byTx) {
    const paid = round2(-Number(g.b.tx_amount));
    lines.push({
      key: `pay:${txId}`, date: toISODate(g.b.tx_date), kind: 'payment', amount: -paid, transaction_id: txId,
      gst: g.b.tx_gst == null ? null : round2(g.b.tx_gst),
      label: g.b.tx_description || 'Payment', account: g.b.tx_account, awaiting: !!g.b.tx_awaiting,
      pays: g.names,
    });
    const diff = round2(paid - g.owed);
    if (Math.abs(diff) >= 0.005) {
      lines.push({
        key: `diff:${txId}`, date: toISODate(g.b.tx_date), kind: 'diff', amount: diff, transaction_id: txId,
        label: Math.abs(diff) < 1 ? 'Rounding on payment' : diff > 0 ? 'Paid more than the bills' : 'Paid less than the bills (discount or short-pay)',
      });
    }
  }
  for (const c of credits) {
    const kind = c.kind === 'refundable' ? 'refundable deposit' : 'prepayment';
    const left = round2(Number(c.remaining ?? 0));
    const applies = Array.isArray(c.applied_to) ? c.applied_to : [];
    if (c.note === 'Paid on account') {
      // A payment on account: it pays the oldest bills; any rest is credit for the next one.
      lines.push({ key: c.transaction_id ? `acct:${c.transaction_id}` : `dep:${c.id}`, date: toISODate(c.date), kind: 'onaccount', amount: -round2(c.amount), credit_id: c.id, transaction_id: c.transaction_id,
        label: c.tx_description || 'Payment', account: c.tx_account, awaiting: !!c.tx_awaiting, gst: c.tx_gst == null ? null : round2(c.tx_gst),
        applies, credit_left: c.status === 'open' && left > 0.005 ? left : 0 });
    } else {
      lines.push({ key: `dep:${c.id}`, date: toISODate(c.date), kind: 'deposit', amount: -round2(c.amount), credit_id: c.id, transaction_id: c.transaction_id, label: `Deposit paid — ${kind}`,
        gst: c.tx_gst == null ? null : round2(c.tx_gst), applies, credit_left: c.status === 'open' && left > 0.005 ? left : 0 });
    }
    if (c.status === 'refunded' && c.refund_date) {
      lines.push({ key: `ref:${c.id}`, date: toISODate(c.refund_date), kind: 'refund', amount: round2(c.refund_amount), credit_id: c.id, transaction_id: c.refund_transaction_id, label: 'Deposit refunded to you' });
    }
    if (c.status === 'kept' && Number(c.remaining) > 0.005) {
      lines.push({ key: `kept:${c.id}`, date: toISODate(c.closed_date || c.date), kind: 'kept', amount: round2(c.remaining), credit_id: c.id, label: 'Deposit kept by the vendor' });
    }
  }

  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (ORDER[a.kind] - ORDER[b.kind]) || a.key.localeCompare(b.key)));
  // With an opening balance, it replaces everything before its date.
  let bal = 0;
  for (const l of lines) {
    if (opening && l.date < opening.date) { l.before_opening = true; l.balance = null; continue; }
    bal = round2(bal + l.amount);
    l.balance = bal;
  }
  upcoming.sort((a, b) => (a.date < b.date ? -1 : 1));
  await attachDocuments(db, lines);
  return { lines, upcoming, balance: bal, bills, credits, opening };
}

/**
 * The invoices and receipts filed on each line: a bill's own documents on
 * its bill line, an entry's on the entry. A document filed on a bill that
 * also sits on the bill's payment shows once, on the bill.
 */
async function attachDocuments(db, lines) {
  const billIds = [...new Set(lines.filter((l) => l.kind === 'bill').map((l) => l.bill_id))];
  const txIds = [...new Set(lines.filter((l) => l.transaction_id && l.kind !== 'diff').map((l) => l.transaction_id))];
  for (const l of lines) if (l.kind === 'bill' || (l.transaction_id && l.kind !== 'diff')) l.docs = [];
  if (!billIds.length && !txIds.length) return;
  const { rows } = await db.query(
    `SELECT id, mime, bill_id, transaction_id FROM receipts WHERE bill_id = ANY($1::int[]) OR transaction_id = ANY($2::int[]) ORDER BY id`,
    [billIds, txIds]);
  const onBill = new Set(billIds);
  for (const r of rows) {
    const doc = { id: r.id, mime: r.mime };
    const target = r.bill_id && onBill.has(r.bill_id)
      ? lines.find((l) => l.kind === 'bill' && l.bill_id === r.bill_id)
      : lines.find((l) => l.docs && l.kind !== 'bill' && l.transaction_id === r.transaction_id);
    if (target) target.docs.push(doc);
  }
}

/**
 * Headline figures for a set of bills and deposits (one vendor's, or all):
 * what's owed on bills now, overdue, due soon, deposits held, the interest
 * financed bills are running up, and interest-free periods ending soon.
 */
export function billSummary(bills, credits, today = todayISO()) {
  const soon = addDays(today, 30);
  const s = {
    owing: 0, bills: 0, overdue: 0, overdue_count: 0, due_30: 0, due_30_count: 0, held: 0,
    interest_month: 0, financed: 0, free_ending: 0, free_ending_count: 0, free_ending_first: null,
    scheduled: 0, scheduled_count: 0, oldest_due: null,
  };
  // The bills (and deposits) behind each figure, so a card can list them.
  const items = { owing: [], overdue: [], due_30: [], scheduled: [], financed: [], free_ending: [], held: [] };
  for (const b of bills) {
    if (b.status !== 'unpaid') continue;
    const due = toISODate(b.due_date);
    const owing = Math.max(0, rawOwing(b, today) - Number(b.applied || 0));
    const item = { bill_id: b.id, payee_id: b.payee_id ?? null, vendor: b.payee_name || null, name: b.name, date: billDate(b), due_date: due, amount: round2(owing),
      interest_free_until: b.is_financed ? toISODate(b.interest_free_until) : null, rate: b.is_financed ? Number(b.finance_rate_pct || 0) : null };
    if (billDate(b) > today) { s.scheduled += owing; s.scheduled_count += 1; items.scheduled.push(item); }
    else { s.owing += owing; s.bills += 1; items.owing.push(item); if (!s.oldest_due || due < s.oldest_due) s.oldest_due = due; }
    if (due < today) { s.overdue += owing; s.overdue_count += 1; items.overdue.push(item); }
    else if (due <= soon) { s.due_30 += owing; s.due_30_count += 1; items.due_30.push(item); }
    if (b.is_financed) {
      s.financed += owing;
      items.financed.push(item);
      const free = toISODate(b.interest_free_until);
      if (!free || free <= today) s.interest_month += Number(b.balance_amount ?? b.amount) * Number(b.finance_rate_pct || 0) / 100 / 12;
      else if (free <= soon) {
        s.free_ending += owing; s.free_ending_count += 1; items.free_ending.push(item);
        if (!s.free_ending_first || free < s.free_ending_first) s.free_ending_first = free;
      }
    }
  }
  for (const c of credits) {
    if (c.status !== 'open') continue;
    s.held += Number(c.remaining);
    items.held.push({ credit_id: c.id, payee_id: c.payee_id ?? null, vendor: c.payee_name || null, name: c.kind === 'refundable' ? 'Refundable deposit' : c.note === 'Paid on account' ? 'Paid on account — not used yet' : 'Prepayment',
      date: toISODate(c.date), amount: round2(c.remaining) });
  }
  for (const list of Object.values(items)) list.sort((a, b) => ((a.due_date || a.date) < (b.due_date || b.date) ? -1 : 1));
  s.items = items;
  for (const k of ['owing', 'overdue', 'due_30', 'held', 'interest_month', 'financed', 'free_ending', 'scheduled']) s[k] = round2(s[k]);
  s.net = round2(s.owing - s.held);
  return s;
}

/** Reconciliation state for a vendor: the open one (if any), the last finished, and what's ticked. */
export async function reconState(db, payeeId) {
  const { rows: recs } = await db.query(
    `SELECT * FROM vendor_reconciliations WHERE payee_id = $1 ORDER BY (status = 'open') DESC, statement_date DESC, id DESC`, [payeeId]);
  const { rows: cleared } = await db.query(
    `SELECT vc.*, r.status FROM vendor_cleared vc JOIN vendor_reconciliations r ON r.id = vc.reconciliation_id WHERE vc.payee_id = $1`, [payeeId]);
  const fix = (r) => r && ({ ...r, statement_date: toISODate(r.statement_date), statement_balance: Number(r.statement_balance) });
  const open = fix(recs.find((r) => r.status === 'open'));
  const last = fix(recs.find((r) => r.status === 'done'));
  const clearedTotal = round2(cleared.reduce((s, c) => s + Number(c.amount), 0));
  return {
    open, last, cleared: new Map(cleared.map((c) => [c.line_key, { ...c, amount: Number(c.amount) }])),
    cleared_total: clearedTotal,
    difference: open ? round2(open.statement_balance - clearedTotal) : null,
  };
}
