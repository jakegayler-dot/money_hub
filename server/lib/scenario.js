// What-if engine.
//
// A scenario is a set of levers applied to the forecast's flows. Each
// lever transforms flows (moves them, re-prices them, adds new ones) and
// may adjust taxable income directly (CCA on a purchase, the optional
// inventory adjustment). After every group of levers the forecast is
// re-evaluated with income tax re-worked from the change in taxable income
// per year — so deferring a sale moves its cash AND its tax, and a new
// loan's interest lowers tax as well as cash.
//
// The groups are applied in a fixed order and each one's effect is
// measured on top of the ones before it; that sequence is the impact
// breakdown (the waterfall). An operating line, if on, goes last: it draws
// to keep the balance above a minimum and repays when cash allows.
//
// Scenario shape (every part optional):
// {
//   commodities: { [groupKey]: { price, pct, qty, sell_month } },
//   contracts_new: [{ commodity, crop: 'bins'|'next', group, quantity, unit, price, pay_month, estimate_id, estimate_price }],
//   contract_moves: { [contract_id]: 'YYYY-MM' },
//   bill_moves: { [bill_id]: 'YYYY-MM-DD' },
//   prepay: [{ label, amount, month, instead_month }],
//   costs_pct, rate_pts, rate_scope: 'variable'|'all', gst_delay,
//   tax: { instalment: 'plan'|'skip', oia, next_year_net, prescribed_rate },
//   loans_new: [{ label, amount, rate, years, per_year, start_month, first_month, owner: 'farm'|'personal', buy_cost, cca_rate }],
//   oneoffs: [{ label, amount, month, treatment: 'farm'|'capital'|'personal', cca_rate }],
//   op_line: { on, limit, rate, keep },
// }

import { addMonths, toISODate } from './dates.js';
import {
  evaluate, buildTaxFlows, taxesFor, baseNetByYear, taxYearOf, midMonth, norm, scopeShare, monthLabel,
} from './forecast.js';
import { rawOwing } from './vendorAccount.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const ym = (v) => (/^\d{4}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 7) : null);
const clone = (flows) => flows.map((f) => ({ ...f, ref: { ...f.ref } }));

export const GROUPS = [
  { id: 'prices', label: 'Prices & quantities' },
  { id: 'contracts', label: 'New contracts' },
  { id: 'timing', label: 'Sale & payment timing' },
  { id: 'costs', label: 'Costs & bills' },
  { id: 'loans', label: 'Loans & rates' },
  { id: 'oneoffs', label: 'One-off items' },
  { id: 'gst', label: 'GST timing' },
  { id: 'tax', label: 'Tax choices' },
  { id: 'opline', label: 'Operating line' },
];

/** Which groups a scenario actually touches. */
export function activeGroups(sc = {}) {
  const has = (o) => o && Object.keys(o).length > 0;
  const commodityHas = (pred) => Object.values(sc.commodities || {}).some(pred);
  return {
    prices: commodityHas((c) => num(c.price) != null || num(c.pct) || num(c.qty) != null),
    contracts: (sc.contracts_new || []).some((c) => num(c.quantity) > 0 && num(c.price) > 0 && ym(c.pay_month)),
    timing: has(sc.contract_moves) || commodityHas((c) => ym(c.sell_month)),
    costs: !!num(sc.costs_pct) || has(sc.bill_moves) || (sc.prepay || []).some((p) => num(p.amount) > 0 && ym(p.month)),
    loans: !!num(sc.rate_pts) || (sc.loans_new || []).some((l) => num(l.amount) > 0),
    oneoffs: (sc.oneoffs || []).some((o) => num(o.amount) && ym(o.month)),
    gst: num(sc.gst_delay) > 0,
    tax: (sc.tax?.instalment === 'skip') || num(sc.tax?.oia) > 0 || num(sc.tax?.next_year_net) != null,
    opline: !!(sc.op_line?.on && num(sc.op_line.limit) > 0),
  };
}

// ---- Lever groups: (flows, adj, ctx, sc) → flows (adj mutated) ------------------

/** Scale a flow's amount and taxable effect together. */
const scale = (f, k) => { f.amount = r2(f.amount * k); f.taxable = r2(f.taxable * k); f.changed = true; };

function applyPrices(flows, adj, ctx, sc) {
  for (const [key, cfg] of Object.entries(sc.commodities || {})) {
    const g = ctx.groups.get(key);
    const commodity = g ? norm(g.commodity) : key.replace(/^est:/, '');
    let factor = 1;
    if (num(cfg.price) != null && g?.avg_price > 0) factor = num(cfg.price) / g.avg_price;
    else if (num(cfg.pct)) factor = 1 + num(cfg.pct) / 100;
    adj.price[key] = (g?.avg_price || 0) * factor;
    let qtyFactor = 1;
    if (g && num(cfg.qty) != null) {
      const q = Math.max(0, num(cfg.qty));
      adj.qty[key] = q;
      if (g.uncontracted > 0) qtyFactor = q / g.uncontracted;
      else if (q > 0) {
        // Nothing uncontracted today: the extra sells on the group's usual date.
        const date = ctx.inventory.items.find((i) => ctx.groupOf(i) === key)?.start_date || midMonth(addMonths(ctx.today, 3));
        flows.push({
          key: `whatif:inv:${key}`, kind: 'inventory', label: `${g.commodity} — added in what-if`, date: toISODate(date),
          amount: r2(q * adj.price[key]), farm: 1, taxable: r2(q * adj.price[key]), estimate: true, whatif: true,
          ref: { group: key, commodity },
        });
      }
    }
    for (const f of flows) {
      if (f.kind === 'inventory' && f.ref.group === key && !f.whatif) scale(f, factor * qtyFactor);
      else if (f.kind === 'estimate_in' && f.ref.commodity === commodity && factor !== 1) scale(f, factor);
    }
  }
  return flows;
}

function applyContracts(flows, adj, ctx, sc) {
  for (const [i, c] of (sc.contracts_new || []).entries()) {
    const qty = num(c.quantity);
    const price = num(c.price);
    const month = ym(c.pay_month);
    if (!(qty > 0 && price > 0 && month)) continue;
    const value = r2(qty * price);
    const crop = c.crop === 'bins' ? 'bins' : 'next';
    const name = c.commodity || ctx.groups.get(c.group)?.commodity || 'Contract';
    flows.push({
      key: `whatif:contract:${i}`, kind: 'contract', label: `New contract — ${name}${crop === 'next' ? ' (next crop)' : ''}`,
      date: midMonth(month), amount: value, farm: 1, taxable: value, estimate: false, whatif: true,
      ref: { commodity: norm(name) },
    });
    if (crop === 'bins' && c.group) {
      // Sold from the bins: that much less to sell later at the forecast price.
      const g = ctx.groups.get(c.group);
      const avail = adj.qtyLeft[c.group] ?? adj.qty[c.group] ?? g?.uncontracted ?? 0;
      const used = Math.min(qty, avail);
      adj.qtyLeft[c.group] = avail - used;
      if (qty > avail + 1e-6) adj.warnings.push(`${name}: contract is for ${qty} but only ${r2(avail)} ${g?.unit || ''} is uncontracted — the extra is counted as new production.`);
      const invFlows = flows.filter((f) => f.kind === 'inventory' && f.ref.group === c.group);
      const total = invFlows.reduce((s, f) => s + f.amount, 0);
      const cut = Math.min(total, used * (adj.price[c.group] || g?.avg_price || price));
      if (total > 0 && cut > 0) for (const f of invFlows) scale(f, 1 - cut / total);
    } else if (crop === 'next' && c.estimate_id) {
      // Prices part of an estimate: that estimate shrinks by what it had for this quantity.
      let cut = qty * (num(c.estimate_price) ?? price);
      const est = flows.filter((f) => f.kind === 'estimate_in' && f.ref.estimate_id === Number(c.estimate_id)).sort((a, b) => (a.date < b.date ? -1 : 1));
      for (const f of est) {
        if (cut <= 0) break;
        const take = Math.min(f.amount, cut);
        scale(f, (f.amount - take) / f.amount);
        cut -= take;
      }
    }
  }
  return flows;
}

function applyTiming(flows, adj, ctx, sc) {
  for (const [id, m] of Object.entries(sc.contract_moves || {})) {
    if (!ym(m)) continue;
    for (const f of flows) if (f.kind === 'contract' && f.ref.contract_id === Number(id)) { f.date = midMonth(m); f.moved = true; }
  }
  for (const [key, cfg] of Object.entries(sc.commodities || {})) {
    if (!ym(cfg.sell_month)) continue;
    for (const f of flows) if (f.kind === 'inventory' && f.ref.group === key) { f.date = midMonth(cfg.sell_month); f.moved = true; }
  }
  return flows;
}

function applyCosts(flows, adj, ctx, sc) {
  const pct = num(sc.costs_pct);
  if (pct) for (const f of flows) if (f.kind === 'bill' || f.kind === 'estimate_out') scale(f, 1 + pct / 100);
  for (const [id, date] of Object.entries(sc.bill_moves || {})) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? date : ym(date) ? midMonth(date) : null;
    if (!d) continue;
    const bill = ctx.bills.find((b) => b.id === Number(id));
    const f = flows.find((x) => x.kind === 'bill' && x.ref.bill_id === Number(id) && x.ref.first);
    if (!bill || !f) continue;
    const before = -f.amount;
    // A financed bill paid later owes its interest to the new date.
    const after = bill.is_financed ? Math.max(0, rawOwing(bill, d) - Number(bill.applied || 0)) * (1 + (pct || 0) / 100) : before;
    const extra = r2(after - before);
    f.date = d < ctx.today ? ctx.today : d;
    f.moved = true;
    if (Math.abs(extra) >= 0.005) {
      f.amount = r2(-after);
      f.taxable = r2(f.taxable - extra * f.farm);
      f.ref = { ...f.ref, extra_interest: extra };
      f.changed = true;
      adj.extraInterest += extra * f.farm;
    }
  }
  for (const [i, p] of (sc.prepay || []).entries()) {
    const amt = num(p.amount);
    if (!(amt > 0) || !ym(p.month)) continue;
    flows.push({ key: `whatif:prepay:${i}`, kind: 'whatif', label: p.label || 'Prepaid inputs', date: midMonth(p.month),
      amount: -amt, farm: 1, taxable: -amt, estimate: false, whatif: true, ref: {} });
    if (ym(p.instead_month)) {
      flows.push({ key: `whatif:prepay-later:${i}`, kind: 'whatif', label: `${p.label || 'Prepaid inputs'} — not spent later`, date: midMonth(p.instead_month),
        amount: amt, farm: 1, taxable: amt, estimate: false, whatif: true, ref: {} });
    }
  }
  return flows;
}

/** Blended payments for a new loan. */
export function loanSchedule({ amount, rate, years, per_year = 12, first_month }) {
  const P = Number(amount);
  const n = Math.max(1, Math.round(Number(years) * Number(per_year)));
  const i = Number(rate) / 100 / Number(per_year);
  const pay = i > 0 ? P * i / (1 - Math.pow(1 + i, -n)) : P / n;
  const step = 12 / Number(per_year);
  const out = [];
  let bal = P;
  for (let k = 0; k < n; k++) {
    const interest = bal * i;
    const principal = Math.min(bal, pay - interest);
    bal -= principal;
    out.push({ date: midMonth(addMonths(`${first_month}-01`, Math.round(k * step))), interest: r2(interest), principal: r2(principal), payment: r2(interest + principal) });
  }
  return { payment: r2(pay), payments: out };
}

/** First-year CCA at the class rate, then declining balance (the half-year rule is suspended for 2024–2027 acquisitions). */
function addCca(adj, year, cost, rate, farm) {
  const r = Number(rate) / 100;
  if (!(r > 0) || !(cost > 0)) return;
  let ucc = cost;
  for (let y = year; y <= year + 2; y++) {
    const cca = ucc * r;
    adj.extra[y] = (adj.extra[y] || 0) - cca * farm;
    ucc -= cca;
  }
}

function applyLoans(flows, adj, ctx, sc) {
  const pts = num(sc.rate_pts);
  if (pts) {
    for (const f of flows) {
      if (f.kind !== 'loan' || !(f.ref.rate > 0)) continue;
      if (sc.rate_scope !== 'all' && f.ref.rate_type !== 'variable') continue;
      const ni = Math.max(0, f.ref.interest * (f.ref.rate + pts) / f.ref.rate);
      const d = r2(ni - f.ref.interest);
      f.amount = r2(f.amount - d);
      f.taxable = r2(f.taxable - d * f.farm);
      f.ref = { ...f.ref, interest: r2(ni) };
      f.changed = true;
    }
  }
  for (const [i, l] of (sc.loans_new || []).entries()) {
    const amount = num(l.amount);
    if (!(amount > 0)) continue;
    const start = ym(l.start_month) || ctx.today.slice(0, 7);
    const first = ym(l.first_month) || addMonths(`${start}-01`, Number(l.per_year) === 1 ? 12 : 1).slice(0, 7);
    const farm = l.owner === 'personal' ? 0 : 1;
    const label = l.label || 'New loan';
    flows.push({ key: `whatif:loan-in:${i}`, kind: 'whatif', label: `${label} — loan advanced`, date: midMonth(start),
      amount, farm, taxable: 0, estimate: false, whatif: true, ref: {} });
    const { payments } = loanSchedule({ amount, rate: num(l.rate) || 0, years: num(l.years) || 5, per_year: Number(l.per_year) === 1 ? 1 : 12, first_month: first });
    payments.forEach((p, k) => flows.push({
      key: `whatif:loan:${i}:${k}`, kind: 'loan', label, date: p.date, amount: -p.payment, farm,
      taxable: -p.interest * farm, estimate: false, whatif: true, ref: { interest: p.interest, principal: p.principal, new_loan: true },
    }));
    const cost = num(l.buy_cost);
    if (cost > 0) {
      flows.push({ key: `whatif:buy:${i}`, kind: 'whatif', label: `${label} — purchase`, date: midMonth(start),
        amount: -cost, farm, taxable: 0, estimate: false, whatif: true, ref: {} });
      addCca(adj, Number(start.slice(0, 4)), cost, num(l.cca_rate) ?? 20, farm);
    }
  }
  return flows;
}

function applyOneoffs(flows, adj, ctx, sc) {
  for (const [i, o] of (sc.oneoffs || []).entries()) {
    const amount = num(o.amount);
    const m = ym(o.month);
    if (!amount || !m) continue;
    const farm = o.treatment === 'personal' ? 0 : 1;
    const taxable = o.treatment === 'farm' ? amount : 0;
    flows.push({ key: `whatif:oneoff:${i}`, kind: 'whatif', label: o.label || (amount > 0 ? 'One-off money in' : 'One-off purchase'),
      date: midMonth(m), amount, farm, taxable, estimate: false, whatif: true, ref: {} });
    if (o.treatment === 'capital' && amount < 0) addCca(adj, Number(m.slice(0, 4)), -amount, num(o.cca_rate) ?? 20, 1);
  }
  return flows;
}

function applyGst(flows, adj, ctx, sc) {
  const n = num(sc.gst_delay);
  if (n > 0) for (const f of flows) if (f.kind === 'gst' && f.amount > 0) { f.date = addMonths(f.date, n); f.moved = true; }
  return flows;
}

function applyTax(flows, adj, ctx, sc) {
  const t = sc.tax || {};
  if (t.instalment === 'skip') adj.method = 'skip';
  if (num(t.prescribed_rate) != null) adj.prescribedRate = num(t.prescribed_rate);
  const oia = num(t.oia);
  if (oia > 0) {
    const y0 = ctx.win.y0;
    adj.extra[y0] = (adj.extra[y0] || 0) + oia;
    adj.extra[y0 + 1] = (adj.extra[y0 + 1] || 0) - oia;
  }
  if (num(t.next_year_net) != null) adj.nextYearNet = num(t.next_year_net);
  return flows;
}

const APPLY = { prices: applyPrices, contracts: applyContracts, timing: applyTiming, costs: applyCosts, loans: applyLoans,
  oneoffs: applyOneoffs, gst: applyGst, tax: applyTax };

// ---- Outcome ---------------------------------------------------------------------

function taxableByYear(flows, today) {
  const out = {};
  for (const f of flows) {
    if (!f.taxable) continue;
    const y = taxYearOf(f.date, today);
    out[y] = (out[y] || 0) + f.taxable;
  }
  return out;
}

/** Interest paid inside the window (existing and new loans, financed bills' extra, operating line). */
function interestIn(flows, ctx) {
  let s = 0;
  for (const f of flows) {
    if (f.date >= ctx.win.endStr) continue;
    if (f.kind === 'loan') s += f.ref.interest || 0;
    if (f.ref?.extra_interest) s += f.ref.extra_interest;
    if (f.kind === 'opline' && f.ref.interest) s += f.ref.interest;
  }
  return r2(s);
}

/**
 * Operating line: draw to keep the balance at `keep`, repay when above it,
 * interest monthly on what's drawn. Works on an evaluated trajectory in
 * the scope's own dollars.
 */
function operatingLine(ev, ctx, cfg, scope) {
  const limit = num(cfg.limit) || 0;
  const rate = (num(cfg.rate) || 0) / 100 / 12;
  const keep = num(cfg.keep) ?? 0;
  const farm = scope === 'personal' ? 0 : 1;
  const flows = [];
  let drawn = 0;
  let carry = 0;
  let peak = 0;
  let interestTotal = 0;
  ev.trajectory.forEach((m, i) => {
    const date = `${m.year}-${String(m.month).padStart(2, '0')}-27`;
    let bal = m.balance + carry;
    const interest = r2(drawn * rate);
    if (interest > 0) {
      flows.push({ key: `opline:int:${i}`, kind: 'opline', label: 'Operating line interest', date, amount: -interest, farm,
        taxable: -interest * farm, estimate: false, whatif: true, ref: { interest } });
      carry -= interest; bal -= interest; interestTotal += interest;
    }
    if (bal < keep && drawn < limit) {
      const d = r2(Math.min(limit - drawn, keep - bal));
      flows.push({ key: `opline:draw:${i}`, kind: 'opline', label: 'Operating line draw', date, amount: d, farm, taxable: 0, estimate: false, whatif: true, ref: {} });
      carry += d; drawn += d;
    } else if (bal > keep && drawn > 0) {
      const rp = r2(Math.min(drawn, bal - keep));
      flows.push({ key: `opline:repay:${i}`, kind: 'opline', label: 'Operating line repaid', date, amount: -rp, farm, taxable: 0, estimate: false, whatif: true, ref: {} });
      carry -= rp; drawn -= rp;
    }
    peak = Math.max(peak, drawn);
  });
  return { flows, peak: r2(peak), interest: r2(interestTotal), owing_at_end: r2(drawn) };
}

/**
 * Evaluates flows + adjustments: tax re-worked per year from the change in
 * taxable income against the plan, tax cash flows rebuilt, then the
 * operating line (twice, so its interest is in the tax it pays for).
 */
function outcome(ctx, base, flows, adj, opts) {
  const { y0 } = ctx.win;
  const baseNet = baseNetByYear(ctx, adj.nextYearNet);
  const scnTaxable = taxableByYear(flows, ctx.today);
  const run = (extraFlows) => {
    const allTaxable = { ...scnTaxable };
    for (const f of extraFlows) if (f.taxable) { const y = taxYearOf(f.date, ctx.today); allTaxable[y] = (allTaxable[y] || 0) + f.taxable; }
    let net = null;
    if (baseNet) {
      net = {};
      for (const y of [y0, y0 + 1, y0 + 2]) {
        net[y] = r2(baseNet[y] + (allTaxable[y] || 0) - (base.taxable[y] || 0) + (adj.extra[y] || 0));
      }
    }
    const taxes = net ? taxesFor(net) : null;
    const planTaxes = baseNet ? taxesFor(baseNet) : null;
    const taxFlows = opts.includeTax && taxes
      ? buildTaxFlows(ctx, taxes, { method: adj.method, prescribedRate: adj.prescribedRate, planTaxes })
      : [];
    const ev = evaluate([...flows, ...extraFlows, ...taxFlows], ctx, { scope: opts.scope, accountIds: opts.accounts });
    return { net, taxes, ev, taxFlows };
  };
  let res = run([]);
  let line = null;
  if (adj.opLine) {
    // Pass 1 sizes the line; pass 2 re-sizes it against the tax its interest saves.
    const first = operatingLine(res.ev, ctx, adj.opLine, opts.scope);
    const withInterestTax = run(first.flows);
    const evNoLine = evaluate([...flows, ...withInterestTax.taxFlows], ctx, { scope: opts.scope, accountIds: opts.accounts });
    line = operatingLine(evNoLine, ctx, adj.opLine, opts.scope);
    res = run(line.flows);
  }
  const interest = r2(interestIn(flows, ctx) + (line ? line.interest : 0));
  return { ...res, line, interest };
}

const summarize = (o, ctx, floor) => {
  const t = o.ev.trajectory;
  const y0 = ctx.win.y0;
  return {
    low: o.ev.low, low_month: monthLabel(t[o.ev.lowIdx]), low_index: o.ev.lowIdx,
    end: o.ev.end, end_month: monthLabel(t[t.length - 1]),
    months_below_floor: t.filter((m) => m.balance < floor).length,
    net_y0: o.net ? o.net[y0] : null, net_y1: o.net ? o.net[y0 + 1] : null,
    tax_y0: o.taxes ? r2(o.taxes[y0]) : null, tax_y1: o.taxes ? r2(o.taxes[y0 + 1]) : null,
    interest: o.interest,
    op_peak: o.line ? o.line.peak : 0, op_interest: o.line ? o.line.interest : 0, op_owing_end: o.line ? o.line.owing_at_end : 0,
  };
};

const trimTrajectory = (ev) => ({
  opening: ev.opening,
  months: ev.trajectory.map((m) => ({
    year: m.year, month: m.month, open: m.open, inflow: m.inflow, outflow: m.outflow, balance: m.balance, committedBalance: m.committedBalance,
    items: m.items.map((it) => ({
      key: it.key, kind: it.kind, label: it.label, date: it.date, amount: it.amount, estimate: !!it.estimate,
      whatif: !!it.whatif, moved: !!it.moved, changed: !!it.changed, overdue: !!it.overdue,
      interest: it.kind === 'loan' ? it.ref?.interest : undefined, id: it.ref?.bill_id || it.ref?.contract_id || undefined,
    })),
  })),
});

/**
 * Runs a scenario. opts: { scope, accounts, includeTax, floor }.
 * Returns plan and scenario trajectories, headline figures for both, and
 * the impact of each group of levers in order.
 */
export function runScenario(ctx, sc = {}, opts = {}) {
  const o = { scope: opts.scope || 'everything', accounts: opts.accounts || null, includeTax: opts.includeTax !== false };
  const floor = opts.floor || 0;
  ctx.groupOf = ctx.groupOf || ((item) => {
    const f = ctx.flows.find((x) => x.kind === 'inventory' && x.ref.inventory_id === item.inventory_id);
    return f?.ref.group;
  });
  const baseFlows = ctx.flows;
  const base = { taxable: taxableByYear(baseFlows, ctx.today) };
  const freshAdj = () => ({
    price: {}, qty: {}, qtyLeft: {}, extra: {}, warnings: [], extraInterest: 0,
    method: 'plan', prescribedRate: 7, nextYearNet: null, opLine: null,
  });

  const planAdj = freshAdj();
  const plan = outcome(ctx, base, clone(baseFlows), planAdj, o);
  const planSum = summarize(plan, ctx, floor);

  const active = activeGroups(sc);
  const adj = freshAdj();
  let flows = clone(baseFlows);
  let prev = planSum;
  const steps = [];
  for (const g of GROUPS) {
    if (!active[g.id]) continue;
    if (g.id === 'opline') adj.opLine = sc.op_line;
    else flows = APPLY[g.id](flows, adj, ctx, sc);
    const cur = summarize(outcome(ctx, base, flows, adj, o), ctx, floor);
    steps.push({
      id: g.id, label: g.label,
      end: r2(cur.end - prev.end), low: r2(cur.low - prev.low),
      tax_y0: cur.tax_y0 != null && prev.tax_y0 != null ? r2(cur.tax_y0 - prev.tax_y0) : null,
      tax_y1: cur.tax_y1 != null && prev.tax_y1 != null ? r2(cur.tax_y1 - prev.tax_y1) : null,
    });
    prev = cur;
  }
  const scn = outcome(ctx, base, flows, adj, o);
  return {
    window: { months: ctx.win.months, start: monthLabel(ctx.win.meta[0]), end: monthLabel(ctx.win.meta[ctx.win.meta.length - 1]), y0: ctx.win.y0 },
    scope: o.scope, include_tax: o.includeTax, floor, tax_available: !!ctx.tax.available,
    active: Object.keys(active).filter((k) => active[k]),
    plan: { ...planSum, trajectory: trimTrajectory(plan.ev) },
    scenario: { ...summarize(scn, ctx, floor), trajectory: trimTrajectory(scn.ev) },
    steps,
    warnings: adj.warnings,
  };
}

/** Pickers for the what-if window: what can be re-priced, contracted, moved or deferred. */
export function scenarioContext(ctx) {
  const inWindow = (f) => f.date < ctx.win.endStr;
  const commodities = [...ctx.groups.values()].map((g) => {
    const fl = ctx.flows.filter((f) => f.kind === 'inventory' && f.ref.group === g.key);
    return {
      key: g.key, commodity: g.commodity, unit: g.unit, item_class: g.item_class,
      on_hand: r2(g.on_hand), uncontracted: r2(g.uncontracted), price: g.avg_price != null ? r2(g.avg_price) : null,
      value: r2(fl.filter(inWindow).reduce((s, f) => s + f.amount, 0)),
      sells: fl.length ? fl.map((f) => f.date).sort()[0] : null,
    };
  });
  // Commodities only in estimates (a crop still in the field): % changes only.
  const estOnly = new Map();
  for (const f of ctx.flows) {
    if (f.kind !== 'estimate_in' || !f.ref.commodity) continue;
    if ([...ctx.groups.values()].some((g) => norm(g.commodity) === f.ref.commodity)) continue;
    const k = `est:${f.ref.commodity}`;
    const e = estOnly.get(k) || { key: k, commodity: f.ref.commodity.replace(/\b\w/g, (c) => c.toUpperCase()), estimate_only: true, value: 0, sells: f.date };
    e.value = r2(e.value + f.amount);
    if (f.date < e.sells) e.sells = f.date;
    estOnly.set(k, e);
  }
  return {
    window: { months: ctx.win.months, start: ctx.win.meta[0], end: ctx.win.meta[ctx.win.meta.length - 1], y0: ctx.win.y0, today: ctx.today },
    months: ctx.win.meta.map((m) => ({ value: `${m.year}-${String(m.month).padStart(2, '0')}`, label: monthLabel(m) })),
    commodities: [...commodities, ...estOnly.values()],
    known_commodities: [...new Set([...ctx.groups.values()].map((g) => g.commodity).concat(ctx.contracts.map((c) => c.commodity)))],
    contracts: ctx.contracts.filter((c) => Number(c.amount) > 0).map((c) => ({
      id: c.id, label: [c.commodity, c.counterparty].filter(Boolean).join(' — '), remaining: r2(c.amount), pays: toISODate(c.due_date),
    })),
    bills: ctx.bills.map((b) => ({
      id: b.id, name: b.name, vendor: b.vendor, due: toISODate(b.due_date), owing: r2(Math.max(0, Number(b.owing_at_due))),
      financed: !!b.is_financed, free_until: b.interest_free_until ? toISODate(b.interest_free_until) : null, rate: b.finance_rate_pct != null ? Number(b.finance_rate_pct) : null,
    })),
    estimates: ctx.estimates.filter((e) => e.direction === 'inflow').map((e) => ({
      id: e.id, name: e.name, commodity: e.commodity, amount: r2(e.amount), date: toISODate(e.start_date),
    })),
    loans: [...new Map(ctx.loans.map((l) => [l.loan_id, { id: l.loan_id, name: l.loan, rate: Number(l.interest_rate_pct), rate_type: l.rate_type }])).values()],
    tax: { available: !!ctx.tax.available, net_y0: ctx.tax.netY0, tax_y0: ctx.tax.taxY0, instalment_paid: !!ctx.tax.paidY0 },
  };
}

export { scopeShare };
