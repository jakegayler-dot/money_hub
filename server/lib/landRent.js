// Land rent (Jake, Oct 30: "a land rent tab on moneyhub that shows all the rent payments, their cost per acre,
// their due dates etc"). Each landlord with their rent bills (paid, owing, and the yearly ones still to be billed:
// rentProjection.js) and their land from Quarter Section (which sends its rented and crop-share fields with each
// crop-plan push: field, acres, $/acre, crop share). Money Hub pays the rent to a payee (101260740 SK Ltd) that
// Quarter Section may know by the person (Matt Fennell): they're matched on a shared name word, or linked by hand
// (setting land_landlord_alias: { payee: landlord }).
import { pool, getSetting } from '../db.js';
import { projectRent } from './rentProjection.js';
import { todayISO, toISODate, addMonths } from './dates.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const kindOf = (b) => (/pasture/i.test(b.name || '') ? 'pasture' : /bale/i.test(b.name || '') ? 'bales' : 'land');
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['and', 'the', 'ltd', 'inc', 'farms', 'farm'].includes(w));

// Every rent bill: by its category or its name (the same test as the forecast's), any date.
export const ALL_RENT_SQL = `SELECT b.id, b.name, b.amount, b.due_date, b.status, b.frequency, b.payee_id, p.name AS vendor
  FROM bills b LEFT JOIN payees p ON p.id = b.payee_id
  LEFT JOIN expense_categories c ON c.id = b.category_id LEFT JOIN expense_categories pc ON pc.id = c.parent_id
  WHERE b.frequency = 'one_time'
    AND (concat_ws(' ', pc.name, c.name) ~* '\\mrent\\M' OR b.name ~* '\\mrent\\M')
  ORDER BY b.due_date`;

/** The Quarter Section landlord a payee is: linked by hand, else the one sharing a name word. */
export function matchLandlord(payee, landlords, alias = {}) {
  if (alias[payee] !== undefined) return alias[payee] || null;
  const pw = new Set(words(payee));
  const hits = landlords.filter((l) => words(l).some((w) => pw.has(w)));
  return hits.length === 1 ? hits[0] : null;
}

/** The page (pure). bills: ALL_RENT_SQL rows; land: Quarter Section's fields; alias: payee → landlord. */
export function buildLandRent({ bills, land = [], alias = {}, today, endStr }) {
  const projected = projectRent(bills.filter((b) => toISODate(b.due_date) > `${Number(today.slice(0, 4)) - 3}`), today, endStr);
  const pays = [
    ...bills.map((b) => ({ date: toISODate(b.due_date), name: b.name, amount: r2(b.amount), kind: kindOf(b), status: b.status === 'paid' ? 'paid' : 'owing', payee: b.vendor || b.name, bill_id: b.id })),
    ...projected.map(({ bill: b, date }) => ({ date, name: b.name, amount: r2(b.amount), kind: kindOf(b), status: 'expected', payee: b.vendor || b.name, from_bill: b.id })),
  ].sort((a, b) => (a.date < b.date ? -1 : 1));
  const mine = land.filter((f) => f.included !== false);
  const landlords = [...new Set(mine.map((f) => f.landlord).filter(Boolean))];
  const yearOn = addMonths(today, 12); const yearAgo = addMonths(today, -12);
  const byPayee = new Map();
  for (const p of pays) { if (!byPayee.has(p.payee)) byPayee.set(p.payee, []); byPayee.get(p.payee).push(p); }
  const used = new Set();
  const rows = [...byPayee].map(([payee, list]) => {
    const landlord = matchLandlord(payee, landlords, alias);
    if (landlord) used.add(landlord);
    const fields = mine.filter((f) => landlord && f.landlord === landlord).map((f) => ({ field: f.field, farm: f.farm, tenure: f.tenure, acres: Number(f.acres) || 0, rent_per_acre: f.rent_per_acre ?? null, crop_share_pct: f.crop_share_pct ?? null }));
    const cash = fields.filter((f) => f.tenure === 'rented');
    const acres = r2(cash.reduce((a, f) => a + f.acres, 0));
    const landNext = list.filter((p) => p.kind === 'land' && p.date >= today && p.date < yearOn).reduce((a, p) => a + p.amount, 0);
    const landLast = list.filter((p) => p.kind === 'land' && p.date >= yearAgo && p.date < today).reduce((a, p) => a + p.amount, 0);
    const yearly = landNext || landLast;
    const next = list.find((p) => p.date >= today && p.status !== 'paid') || null;
    return {
      payee, landlord, fields, acres,
      by_lease: cash.length ? r2(cash.reduce((a, f) => a + f.acres * (Number(f.rent_per_acre) || 0), 0)) : null,
      per_acre: acres > 0 && yearly > 0 ? r2(yearly / acres) : null,
      next_12: r2(list.filter((p) => p.date >= today && p.date < yearOn).reduce((a, p) => a + p.amount, 0)),
      last_12: r2(list.filter((p) => p.date >= yearAgo && p.date < today).reduce((a, p) => a + p.amount, 0)),
      next, payments: list,
    };
  }).sort((a, b) => b.next_12 - a.next_12 || b.last_12 - a.last_12);
  // Quarter Section land with no rent bill behind it (a crop share is paid in grain, not a bill).
  const unbilled = landlords.filter((l) => !used.has(l)).map((l) => {
    const fields = mine.filter((f) => f.landlord === l);
    return { landlord: l, fields: fields.map((f) => ({ field: f.field, farm: f.farm, tenure: f.tenure, acres: Number(f.acres) || 0, rent_per_acre: f.rent_per_acre ?? null, crop_share_pct: f.crop_share_pct ?? null })),
      crop_share: fields.every((f) => f.tenure === 'cropshare') };
  });
  const upcoming = pays.filter((p) => p.date >= today && p.status !== 'paid' && p.date < yearOn);
  return {
    today, landlords: rows, unbilled, upcoming,
    totals: { next_12: r2(upcoming.reduce((a, p) => a + p.amount, 0)), acres: r2(rows.reduce((a, r) => a + r.acres, 0)) },
    qs_landlords: landlords,
  };
}

export async function loadLandRent({ today = todayISO() } = {}) {
  const [{ rows: bills }, land, alias] = await Promise.all([
    pool.query(ALL_RENT_SQL),
    getSetting('qs_rented_land', null),
    getSetting('land_landlord_alias', {}),
  ]);
  const out = buildLandRent({ bills, land: land?.items || [], alias: alias || {}, today, endStr: addMonths(today, 24) });
  return { ...out, land_from: land?.at || null };
}
