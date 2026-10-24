// Money moving between you and CRA (Jake, 2026-10-24): a GST/HST refund or
// payment, an income tax refund, or an income tax instalment or balance
// payment. None of it is income or spending — a refund is your own money
// back, and income tax isn't deductible — so a transaction marked as one is
// a transfer everywhere: the farm tax estimate, Income & Expenses,
// Financials. A GST one can still be linked to its quarters on the Tax page
// (optional). Interest CRA pays on a late refund IS taxable: it's split off
// as interest income.
import { assertOpen } from './periods.js';
import { ownerOf, soleOwner } from './postings.js';
import { SEGMENT_COLUMNS } from './segments.js';
import { looksLikeCraGst } from './gstMatch.js';

export const TAX_KINDS = {
  gst_refund: { label: 'GST/HST refund', sign: 1 },
  gst_payment: { label: 'GST/HST payment', sign: -1 },
  income_tax_refund: { label: 'Income tax refund', sign: 1 },
  income_tax_payment: { label: 'Income tax instalment or payment', sign: -1 },
};
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const fail = (status, message) => Object.assign(new Error(message), { status });

// Income tax with CRA on a bank line: "CANADA RIT" (refund of income tax),
// "INCOME TAX REFUND", "CRA (REVENUE) - TAX INSTALMENT", "TAX AMOUNT OWING".
// Benefits CRA pays (GST credit, child benefit, carbon rebate) are not it.
const INCOME_TAX = /\bcanada\s*rit\b|\brit\s*canada\b|income\s*tax|\binc\s*tax\b|tax\s*refund|tax\s*instal+ment|\binstal+ment\b.*\b(cra|revenue|tax)\b|\b(cra|revenue)\b.*\binstal+ment\b|tax\s*(amount\s*)?owing|\bt1\b.*\b(cra|revenue|tax)\b/i;
const BENEFIT = /\b(gstc|gsthstc|carbon|climate|ccb|child|cctb|cdb|benefit|credit)\b/i;
const CRA = /\b(cra|canada|revenue|receiver|rec\s*gen|govt|gov|fed|federal)\b/i;

export function looksLikeCraIncomeTax(text) {
  const t = String(text || '');
  if (BENEFIT.test(t) || looksLikeCraGst(t)) return false;
  return INCOME_TAX.test(t);
}

/** What a line with CRA most likely is, by its words and direction (null if it doesn't look like CRA). */
export function guessTaxKind(text, amount) {
  const t = String(text || '');
  const inflow = Number(amount) > 0;
  if (looksLikeCraGst(t)) return inflow ? 'gst_refund' : 'gst_payment';
  if (looksLikeCraIncomeTax(t)) return inflow ? 'income_tax_refund' : 'income_tax_payment';
  if (!BENEFIT.test(t) && /\b(cra|canada revenue|revenue canada|receiver\s*gen(eral)?|rec\s*gen)\b/i.test(t)) return inflow ? 'income_tax_refund' : 'income_tax_payment';
  return null;
}

async function interestCategory(client) {
  const { rows: [c] } = await client.query(`SELECT id FROM expense_categories WHERE lower(name) = 'interest income' AND kind = 'income' LIMIT 1`);
  if (c) return c.id;
  const { rows: [n] } = await client.query(
    `INSERT INTO expense_categories (name, class, ledger, kind) VALUES ('Interest income', 'variable_seasonal', 'personal', 'income') RETURNING id`);
  return n.id;
}

const insertSplit = (client, txId, s) => client.query(
  `INSERT INTO transaction_splits (transaction_id, amount, category_id, memo, ledger, is_capex, is_transfer, ${SEGMENT_COLUMNS.join(', ')})
   VALUES ($1,$2,$3,$4,$5,false,$6,${SEGMENT_COLUMNS.map((_, i) => `$${7 + i}`).join(',')})`,
  [txId, s.amount, s.category_id, s.memo, s.ledger, s.is_transfer, ...SEGMENT_COLUMNS.map((c) => s.owner[c])]);

/**
 * Marks a transaction as money with CRA. `interest`: the part of an income
 * tax refund that is refund interest (taxable; booked as interest income to
 * Jake, or Ashley when the line is hers). Returns the updated transaction.
 */
export async function markTaxMove(client, txId, { kind, interest = 0 } = {}) {
  const k = TAX_KINDS[kind];
  if (!k) throw fail(400, `kind must be one of ${Object.keys(TAX_KINDS).join(', ')}.`);
  const { rows: [tx] } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
  if (!tx) throw fail(404, 'Transaction not found.');
  if (!tx.account_id || tx.credit_card_id) throw fail(400, 'Only money in or out of a bank account can be a refund or payment with CRA.');
  const amount = Number(tx.amount);
  if (Math.sign(amount) !== k.sign) throw fail(400, `${k.label} is money ${k.sign > 0 ? 'in' : 'out'}; this transaction is money ${amount > 0 ? 'in' : 'out'}.`);
  if (tx.is_debt_service) throw fail(409, 'This is a loan payment.');
  const { rows: linked } = await client.query(
    `SELECT 'bill' AS what FROM bills WHERE linked_transaction_id = $1
     UNION ALL SELECT 'loan' FROM loan_payments WHERE linked_transaction_id = $1
     UNION ALL SELECT 'contract' FROM contract_payments WHERE transaction_id = $1 LIMIT 1`, [txId]);
  if (linked.length) throw fail(409, `This is linked as a ${linked[0].what} payment — unlink it first.`);
  const int = r2(Number(interest) || 0);
  if (int < 0 || (int > 0 && kind !== 'income_tax_refund')) throw fail(400, 'Only an income tax refund can include refund interest.');
  if (int >= Math.abs(amount)) throw fail(400, 'The interest must be less than the refund.');
  await assertOpen(client, tx.date);

  // A transfer keeps one owner: the line's own, else its account's.
  const { rows: [acct] } = await client.query('SELECT * FROM accounts WHERE id = $1', [tx.account_id]);
  const owner = soleOwner(ownerOf(tx, acct || {}));
  await client.query('DELETE FROM transaction_splits WHERE transaction_id = $1', [txId]);
  if (int > 0) {
    const person = ['jake', 'ashley'].includes(owner.segment) ? owner.segment : 'jake';
    await insertSplit(client, txId, { amount: r2(amount - int), category_id: null, memo: k.label, ledger: tx.ledger, is_transfer: true, owner });
    await insertSplit(client, txId, { amount: int, category_id: await interestCategory(client), memo: 'Refund interest from CRA (taxable)',
      ledger: 'personal', is_transfer: false, owner: ownerOf({ segment: person }) });
  }
  const { rows: [up] } = await client.query(
    `UPDATE transactions SET tax_kind = $2, is_transfer = $3, is_split = $4, category_id = NULL, gst_amount = NULL,
       needs_review = false, review_note = NULL,
       ${SEGMENT_COLUMNS.map((c, i) => `${c} = $${5 + i}`).join(', ')}
     WHERE id = $1 RETURNING *`,
    [txId, kind, int === 0, int > 0, ...SEGMENT_COLUMNS.map((c) => owner[c])]);
  return up;
}

/**
 * Undoes the mark: the line is ordinary money in or out again, flagged so a
 * category is picked. A GST one is unlinked from its quarters too.
 */
export async function unmarkTaxMove(client, txId) {
  const { rows: [tx] } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [txId]);
  if (!tx) throw fail(404, 'Transaction not found.');
  if (!tx.tax_kind) throw fail(404, 'This isn\'t marked as a refund or payment with CRA.');
  await assertOpen(client, tx.date);
  await client.query('UPDATE gst_returns SET settlement_transaction_id = NULL WHERE settlement_transaction_id = $1', [txId]);
  await client.query('DELETE FROM transaction_splits WHERE transaction_id = $1', [txId]);
  const { rows: [up] } = await client.query(
    `UPDATE transactions SET tax_kind = NULL, is_transfer = false, is_split = false, needs_review = true,
       review_note = 'Was marked as a refund or payment with CRA: pick what it is.' WHERE id = $1 RETURNING *`, [txId]);
  return up;
}
