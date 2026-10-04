// One definition of earnings, used by the dashboard, Income & Expenses and
// the Tax tab: cash method, capital purchases out (they come off through
// CCA), loan principal out (only interest is a cost), transfers out.
//
// GST: the farm claims back the GST it pays and remits what it collects,
// so the farm's share of every line counts WITHOUT its GST. Jake's and
// Ashley's shares count as paid — GST is a real cost to a household.
//
// The farm's share of a line is businessShare(): Grain + Cattle, and an
// entry with no owner on the business ledger counts as farm (as on the Tax tab).
import { businessShare, ownerWeights } from './segments.js';

const FARM = new Set(['grain', 'livestock']);

/** Columns a line needs: select these from transaction_lines l JOIN transactions t, LEFT JOIN loan_payments lp. */
export const EARNING_COLUMNS = `l.amount, l.split_id, l.is_capex, l.is_debt_service, l.ledger, l.segment, l.is_segment_split,
  l.segment_grain_pct, l.segment_livestock_pct, l.segment_jake_pct, l.segment_ashley_pct,
  t.amount AS tx_amount, t.gst_amount, lp.interest_amount`;

/** The line's amount as it counts (loan payments: interest only), with and without its share of the GST. */
export function lineAmounts(l) {
  let gross = Number(l.amount);
  if (l.is_debt_service) gross = l.split_id != null ? Number(l.amount) : -Number(l.interest_amount || 0);
  const gst = l.is_debt_service || l.gst_amount == null || !Number(l.tx_amount)
    ? 0 : Math.abs(Number(l.gst_amount) * (Number(l.amount) / Number(l.tx_amount)));
  const net = gross - Math.sign(gross) * gst;
  return { gross, net };
}

/**
 * What a line counts for one view: 'farm' (Grain + Cattle, GST out),
 * 'grain' / 'livestock' (that owner's share, GST out), 'jake' / 'ashley'
 * (as paid), 'household' (the non-farm share, as paid) or 'all' (farm
 * share GST out + household share as paid).
 */
export function lineValue(l, view) {
  if (l.is_capex) return 0;
  const { gross, net } = lineAmounts(l);
  const farm = businessShare(l);
  if (view === 'farm') return farm * net;
  if (view === 'household') return (1 - farm) * gross;
  if (view === 'all') return farm * net + (1 - farm) * gross;
  const w = ownerWeights(l)[view] || 0;
  return w * (FARM.has(view) ? net : gross);
}
