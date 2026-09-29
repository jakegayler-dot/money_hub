import { pool } from '../db.js';
import { todayISO, addMonths, yearsBetween, toISODate } from './dates.js';

/**
 * Value of an asset on a date, rolled from its last valuation by
 * annual_change_pct, compounded: (1 + rate)^years. A negative rate is
 * declining-balance depreciation — the CCA method — e.g. -30 means each
 * year it's worth 70% of the year before. Past the valuation date only;
 * values are never rolled backward.
 */
export function assetValueAt(asset, dateISO) {
  const years = Math.max(0, yearsBetween(asset.value_date, dateISO));
  const rate = Number(asset.annual_change_pct) / 100;
  if (rate <= -1) return 0;
  return Number(asset.value) * Math.pow(1 + rate, years);
}

/** Outstanding principal on a loan as of a date: principal minus every schedule row marked paid or already due. */
export function outstandingAt(loan, payments, dateISO) {
  const paid = payments
    .filter((p) => p.paid || toISODate(p.due_date) <= dateISO)
    .reduce((s, p) => s + Number(p.principal_amount), 0);
  return Math.max(Number(loan.principal) - paid, 0);
}

/**
 * Everything the equity figures need, valued today and 12 months out:
 * capital assets, inventory (uncontracted only), and loans. Callers apply
 * owner weights themselves, so one load serves Combined and every owner.
 */
export async function loadBalanceSheet() {
  const today = todayISO();
  const in12 = addMonths(today, 12);

  const [assetRows, loanRows, paymentRows, invRows, contractRows, priceRows, cardRows, cardStmtRows] = await Promise.all([
    pool.query(`SELECT * FROM assets ORDER BY category, name`),
    pool.query(`SELECT * FROM loans`),
    pool.query(`SELECT loan_id, due_date, principal_amount, paid FROM loan_payments`),
    pool.query(`SELECT * FROM inventory_items ORDER BY item_class, commodity`),
    pool.query(`SELECT commodity, unit, quantity FROM sale_contracts WHERE status = 'open' AND quantity IS NOT NULL`),
    pool.query(`SELECT * FROM commodity_prices`),
    pool.query(`SELECT * FROM credit_cards WHERE status = 'active'`),
    // Every unpaid statement per card, summed — what it owes right now if
    // `current_balance` hasn't been kept up to date by hand. Summed, not
    // just the soonest one, so a card behind by more than one cycle isn't
    // undercounted.
    pool.query(`
      SELECT credit_card_id, SUM(GREATEST(statement_balance - COALESCE(paid_amount, 0), 0)) AS balance
      FROM credit_card_statements WHERE paid = false GROUP BY credit_card_id
    `),
  ]);
  const priceList = new Map(priceRows.rows.map((p) => [`${p.commodity.toLowerCase()}|${p.unit.toLowerCase()}`, p]));

  const paymentsByLoan = new Map();
  for (const p of paymentRows.rows) {
    if (!paymentsByLoan.has(p.loan_id)) paymentsByLoan.set(p.loan_id, []);
    paymentsByLoan.get(p.loan_id).push(p);
  }
  const loans = loanRows.rows.map((l) => {
    const pays = paymentsByLoan.get(l.id) || [];
    return {
      ...l,
      outstanding: outstandingAt(l, pays, today),
      outstanding12: outstandingAt(l, pays, in12),
    };
  });

  const assets = assetRows.rows.map((a) => {
    const linked = loans.filter((l) => l.asset_id === a.id);
    const valueNow = assetValueAt(a, today);
    const value12 = assetValueAt(a, in12);
    const loanNow = linked.reduce((s, l) => s + l.outstanding, 0);
    const loan12 = linked.reduce((s, l) => s + l.outstanding12, 0);
    return {
      ...a,
      value_now: valueNow,
      value_12mo: value12,
      loans: linked.map((l) => ({ id: l.id, name: l.name || l.lender, outstanding: l.outstanding })),
      loan_balance: loanNow,
      equity_now: valueNow - loanNow,
      equity_12mo: value12 - loan12,
    };
  });

  // Inventory: group by class + commodity + unit. Contracted quantity is
  // what the source reported, if it reported it for any row in the group
  // (the source knows which bins are sold); otherwise it's derived from
  // open contracts for the same commodity and unit. Breeding stock is
  // never contracted. Only the uncontracted share counts as inventory —
  // the contracted share is already counted as the contract receivable.
  const openByKey = new Map();
  for (const c of contractRows.rows) {
    const k = `${String(c.commodity).toLowerCase()}|${String(c.unit || '').toLowerCase()}`;
    openByKey.set(k, (openByKey.get(k) || 0) + Number(c.quantity));
  }
  const groups = new Map();
  for (const it of invRows.rows) {
    const key = `${it.item_class}|${it.commodity.toLowerCase()}|${it.unit.toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, { key, item_class: it.item_class, commodity: it.commodity, unit: it.unit, items: [] });
    }
    groups.get(key).items.push(it);
  }
  const inventoryGroups = [];
  const inventoryRows = [];
  for (const g of groups.values()) {
    const onHand = g.items.reduce((s, i) => s + Number(i.quantity), 0);
    const reported = g.items.some((i) => i.quantity_contracted != null);
    let contracted = 0;
    let basis = 'none';
    if (g.item_class === 'breeding_livestock') {
      basis = 'not applicable';
    } else if (reported) {
      contracted = g.items.reduce((s, i) => s + (Number(i.quantity_contracted) || 0), 0);
      basis = 'reported by source';
    } else {
      contracted = openByKey.get(`${g.commodity.toLowerCase()}|${g.unit.toLowerCase()}`) || 0;
      basis = contracted > 0 ? 'derived from open contracts' : 'none';
    }
    const uncontracted = Math.max(0, onHand - contracted);
    const fraction = onHand > 0 ? uncontracted / onHand : 0;
    // Price per item: the source's own price if it sent one, else the
    // Money Hub price list for that commodity + unit, else none — valued at
    // $0 and flagged, never at a guess.
    const listed = priceList.get(`${g.commodity.toLowerCase()}|${g.unit.toLowerCase()}`) || null;
    let value = 0;
    let grossValue = 0;
    let pricedQty = 0;
    let needsPrice = 0;
    const enriched = [];
    for (const i of g.items) {
      const price = i.price_per_unit != null ? Number(i.price_per_unit) : listed ? Number(listed.price_per_unit) : null;
      const priceBasis = i.price_per_unit != null ? 'source' : listed ? 'price list' : 'missing';
      if (price == null) needsPrice++;
      const gross = price == null ? 0 : Number(i.quantity) * price;
      const counted = gross * fraction;
      grossValue += gross;
      value += counted;
      if (price != null) pricedQty += Number(i.quantity);
      const row = { ...i, effective_price: price, price_basis: priceBasis, counted_value: counted };
      enriched.push(row);
      inventoryRows.push(row);
    }
    g.items = enriched;
    inventoryGroups.push({
      ...g,
      on_hand: onHand,
      contracted,
      contracted_basis: basis,
      uncontracted,
      gross_value: grossValue,
      counted_value: value,
      avg_price: pricedQty > 0 ? grossValue / pricedQty : null,
      needs_price: needsPrice,
      list_price: listed ? { price_per_unit: Number(listed.price_per_unit), as_of: listed.as_of, source: listed.source } : null,
    });
  }

  // Credit cards: revolving debt, not amortized — there's no schedule to
  // project forward, so outstanding is treated as constant (same
  // simplification as an asset's value between valuations). `current_balance`
  // (kept up to date by hand) wins when set; otherwise the latest unpaid
  // statement's balance; otherwise the card owes nothing on file.
  const unpaidByCard = new Map(cardStmtRows.rows.map((r) => [r.credit_card_id, r]));
  const creditCards = cardRows.rows.map((c) => {
    const unpaid = unpaidByCard.get(c.id);
    const outstanding = c.current_balance != null
      ? Number(c.current_balance)
      : unpaid ? Number(unpaid.balance) : 0;
    return { ...c, outstanding };
  });

  return { today, in12, assets, loans, inventoryGroups, inventoryRows, creditCards };
}

/** Default owner for an inventory row when the source didn't say. */
export function inventoryOwnerRow(item) {
  if (item.segment) return { segment: item.segment };
  // Crops belong to grain; forage (bales) and animals to cattle — hay is
  // produced for the herd. A source can override per item with `segment`.
  return { segment: item.item_class === 'crop' ? 'grain' : item.item_class === 'other' ? null : 'livestock' };
}
