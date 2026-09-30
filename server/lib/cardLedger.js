// Credit card balances and amounts due — the one place both are defined.
//
// A statement's balance is CUMULATIVE: this month's "new balance" already
// includes anything unpaid from last month. So only a card's LATEST
// statement says what is owed and due; older unpaid statements are
// superseded by it, never added to it (adding them would double-count any
// carried balance).
//
// Balance owed right now:
//   - itemized card (purchases entered line by line): the ledger —
//     opening balance + every purchase/refund/payment since ledger start.
//   - otherwise: current_balance if entered by hand, else what's left
//     unpaid on the latest statement.

const round2 = (n) => Math.round(n * 100) / 100;

/** Latest statement per card (DISTINCT ON), as a SQL subquery body. */
export const LATEST_STATEMENTS_SQL = `
  SELECT DISTINCT ON (credit_card_id) *
  FROM credit_card_statements
  ORDER BY credit_card_id, COALESCE(statement_date, due_date) DESC, due_date DESC, id DESC`;

/**
 * Amount still due per card, from its latest statement only, for cards
 * matching `cardFilterSql` (a condition on alias cc). Rows:
 * { credit_card_id, due_date, amount, segment }.
 */
export async function cardAmountsDue(db, { cardFilterSql = 'true', dueBefore = null } = {}) {
  const params = [];
  let dueCond = '';
  if (dueBefore) {
    params.push(dueBefore);
    dueCond = `AND s.due_date < $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT s.id, s.credit_card_id, s.due_date, cc.segment, cc.name,
            GREATEST(s.statement_balance - COALESCE(s.paid_amount, 0), 0) AS amount
     FROM (${LATEST_STATEMENTS_SQL}) s
     JOIN credit_cards cc ON cc.id = s.credit_card_id
     WHERE s.paid = false AND cc.status = 'active' AND (${cardFilterSql}) ${dueCond}`,
    params
  );
  return rows.filter((r) => Number(r.amount) > 0.005);
}

/**
 * Balance owed per card: Map card_id → { outstanding, itemized }.
 * Pass `cards` (rows from credit_cards) to avoid a second fetch.
 */
export async function cardBalances(db, cards = null) {
  const cardRows = cards || (await db.query('SELECT * FROM credit_cards')).rows;
  const [{ rows: ledger }, { rows: latest }] = await Promise.all([
    db.query(
      `SELECT c.id,
              c.ledger_opening_balance
                + COALESCE(SUM(CASE WHEN t.account_id IS NULL THEN -t.amount ELSE t.amount END), 0) AS balance
       FROM credit_cards c
       LEFT JOIN transactions t ON t.credit_card_id = c.id AND t.date >= c.ledger_start_date
       WHERE c.ledger_start_date IS NOT NULL
       GROUP BY c.id`
    ),
    db.query(LATEST_STATEMENTS_SQL),
  ]);
  const ledgerById = new Map(ledger.map((r) => [r.id, Number(r.balance)]));
  const latestById = new Map(latest.map((s) => [s.credit_card_id, s]));
  const out = new Map();
  for (const c of cardRows) {
    let outstanding;
    const itemized = c.ledger_start_date != null;
    if (itemized) outstanding = ledgerById.get(c.id) ?? Number(c.ledger_opening_balance || 0);
    else if (c.current_balance != null) outstanding = Number(c.current_balance);
    else {
      const s = latestById.get(c.id);
      outstanding = s && !s.paid ? Math.max(Number(s.statement_balance) - Number(s.paid_amount || 0), 0) : 0;
    }
    out.set(c.id, { outstanding: round2(outstanding), itemized });
  }
  return out;
}
