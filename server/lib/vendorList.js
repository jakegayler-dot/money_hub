// The Bills page's By vendor list (GET /api/bills/vendors).
//
// Every vendor account on file, settled or not (Jake, Oct 31: "why are bills that have been settled disappearing
// from the vendors tab? it should show all accounts regardless of current balance"): a vendor is an account once it
// has a bill (paid or unpaid), a deposit or credit, or an opening balance. One line each with what's owed on its
// unpaid bills, deposits it's holding and the net ($0 once settled); the ones with something owing or held come
// first (most owed first), then the settled ones by name.
import { toISODate } from './dates.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * bills: unpaid bills { id, payee_id, owing, amount, applied, due_date, received_date, created_at, … } (soonest due first)
 * credits: vendor_credits rows with `remaining`
 * payees: { id, name, auto_apply_credits, has_account, last_paid } — has_account: a bill, credit or opening balance on file
 * now: a Date; credits closed over a year ago aren't listed under the vendor
 */
export function vendorRows(bills, credits, payees, { now = new Date() } = {}) {
  const info = new Map(payees.map((p) => [p.id, p]));
  const by = new Map();
  const get = (id) => {
    const k = id ?? 0;
    if (!by.has(k)) {
      const p = id ? info.get(id) : null;
      by.set(k, {
        payee_id: id ?? null, name: id ? (p?.name ?? `Vendor ${id}`) : 'No vendor set', auto_apply: id ? p?.auto_apply_credits !== false : true,
        owing: 0, held: 0, bills: [], credits: [], last_paid: p?.last_paid ? toISODate(p.last_paid) : null,
      });
    }
    return by.get(k);
  };
  for (const p of payees) if (p.has_account) get(p.id);
  for (const b of bills) {
    const v = get(b.payee_id);
    v.owing += Number(b.owing);
    v.bills.push({ ...b, due_date: toISODate(b.due_date), bill_date: toISODate(b.received_date) || toISODate(b.created_at), amount: Number(b.amount), owing: Number(b.owing), applied: Number(b.applied || 0) });
  }
  const yearAgo = new Date(now.getTime() - 365 * 86400000);
  for (const c of credits) {
    const v = get(c.payee_id);
    const open = c.status === 'open';
    if (open) v.held += Number(c.remaining);
    if (open || new Date(c.date) >= yearAgo) {
      v.credits.push({ ...c, date: toISODate(c.date), amount: Number(c.amount), remaining: Number(c.remaining) });
    }
  }
  return [...by.values()]
    .map((v) => ({ ...v, owing: r2(v.owing), held: r2(v.held), net: r2(v.owing - v.held), oldest_due: v.bills[0]?.due_date || null }))
    // "No vendor set" only while it has something on it.
    .filter((v) => v.payee_id != null || v.bills.length || v.credits.length)
    .sort((a, b) => {
      const ao = a.owing > 0 || a.held > 0;
      const bo = b.owing > 0 || b.held > 0;
      if (ao !== bo) return ao ? -1 : 1;
      if (ao) return b.owing - a.owing || b.held - a.held || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    });
}
