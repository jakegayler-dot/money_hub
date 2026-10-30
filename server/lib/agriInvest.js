// AgriInvest in the cash forecast (Jake, Oct 30: "Agriinvest is a program based on revenue, so moneyhub can work it
// out. It doesn't matter if I take the money out or not - it's simply a cash inflow"). For each program year (the
// calendar year) the governments match 1% of allowable net sales (ANS: qualifying commodity sales less qualifying
// commodity purchases), on ANS up to $1,000,000, so at most $10,000; under $25,000 of ANS there's nothing (taxlib
// "agriinvest"). The forms go in with the tax return (by June 30 the year after), so the match is counted on
// MATCH_DAY of the year after the program year. ANS = what's been sold and bought so far that year (the ledger)
// plus what the forecast has for the rest of it. Sales: grain and cattle (contracts, inventory, Quarter Section's
// crop plan and unharvested grain, the cattle manager's forecast). Purchases: livestock (bulls included), feed
// grain and hay bought. A year whose match is already in the ledger (Program payments › AgriInvest) is skipped.
export const MATCH_PCT = 0.01;
export const ANS_CAP = 1000000;
export const MIN_ANS = 25000;
export const MATCH_DAY = '11-15';
const SALE_CATS = new Set(['grain sales', 'cattle sales']);
const PURCHASE_CATS = new Set(['livestock purchased', 'grain purchased', 'hay & straw purchased']);

/** The ledger's sales and purchases by year, and the years an AgriInvest payment came in. */
export const ACTUAL_SQL = `SELECT EXTRACT(YEAR FROM tl.date)::int AS year,
    SUM(CASE WHEN lower(COALESCE(p.name, c.name)) IN ('grain sales', 'cattle sales') THEN tl.amount ELSE 0 END) AS sales,
    SUM(CASE WHEN lower(c.name) IN ('livestock purchased', 'grain purchased', 'hay & straw purchased') THEN -tl.amount ELSE 0 END) AS purchases,
    SUM(CASE WHEN lower(c.name) = 'agriinvest' AND tl.amount > 0 THEN tl.amount ELSE 0 END) AS agriinvest_in
  FROM transaction_lines tl JOIN expense_categories c ON c.id = tl.category_id LEFT JOIN expense_categories p ON p.id = c.parent_id
  WHERE tl.ledger = 'business' AND NOT tl.is_transfer AND tl.date >= $1 AND tl.date < $2
  GROUP BY 1`;
export const PURCHASE_IDS_SQL = `SELECT id FROM expense_categories WHERE lower(name) IN ('livestock purchased', 'grain purchased', 'hay & straw purchased')`;

const text = (f) => `${f.ref?.category || ''}`.toLowerCase();
export const isSale = (f) => f.amount > 0 && (f.kind === 'contract' || f.kind === 'inventory'
  || (f.kind === 'estimate_in' && (/^(grain sales|cattle forecast|cattle sales)/.test(text(f)) || (!f.ref?.category && !!f.ref?.commodity))));
export const isPurchase = (f, purchaseIds = new Set()) => f.amount < 0 && (
  (f.kind === 'estimate_out' && /cattle forecast|livestock|feed/.test(text(f)))
  || (f.kind === 'bill' && purchaseIds.has(Number(f.ref?.category_id))));

/**
 * The AgriInvest matching payments the window holds (pure). actual: { [year]: { sales, purchases, agriinvest_in } }
 * from the ledger before today; flows: the forecast's flows (from today).
 */
export function agriInvestFlows({ flows, actual = {}, purchaseIds = new Set(), today, endStr }) {
  const out = [];
  const y0 = Number(today.slice(0, 4));
  const yEnd = Number(endStr.slice(0, 4));
  for (let y = y0 - 1; y < yEnd; y++) {
    const date = `${y + 1}-${MATCH_DAY}`;
    if (date < today || date >= endStr) continue;
    if (Number(actual[y + 1]?.agriinvest_in) > 0) continue;
    const inYear = (f) => f.date >= today && f.date >= `${y}-01-01` && f.date < `${y + 1}-01-01`; // the ledger has the rest
    const share = (f) => Math.abs(f.amount) * (f.farm ?? 1);
    const sales = (Number(actual[y]?.sales) || 0) + flows.filter((f) => inYear(f) && isSale(f)).reduce((a, f) => a + share(f), 0);
    const purchases = (Number(actual[y]?.purchases) || 0) + flows.filter((f) => inYear(f) && isPurchase(f, purchaseIds)).reduce((a, f) => a + share(f), 0);
    const ans = sales - purchases;
    if (ans < MIN_ANS) continue;
    const amount = Math.round(Math.min(ans, ANS_CAP) * MATCH_PCT * 100) / 100;
    out.push({
      key: `agriinvest:${y}`, kind: 'estimate_in', label: `AgriInvest match for ${y} (1% of $${Math.round(ans).toLocaleString('en-CA')} allowable net sales)`,
      date, amount, farm: 1, taxable: amount, estimate: true,
      ref: { program: 'agriinvest', program_year: y, ans: Math.round(ans), sales: Math.round(sales), purchases: Math.round(purchases) },
    });
  }
  return out;
}
