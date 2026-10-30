import { useEffect, useState } from 'react';
import { Pie } from './Pie.jsx';
import { money } from '../format.js';
import { cents } from './SplitEditor.jsx';

// Everything behind one month of the cash flow forecast (Jake, 2026-10-24):
// money in and money out as pies by where they come from — click a slice
// (or its row) for every item in it, with its date, where the figure comes
// from and whether it's committed or an estimate — plus how the month gets
// from opening to closing cash and what the floor after it is made of.

// Groups, each with a colour and where its figures come from.
export const GROUPS = {
  contracts: { label: 'Grain & cattle contracts', color: '#c9a227', link: '/contracts', from: 'Open sale contracts, on their expected payment date.' },
  invoices: { label: 'Invoices & rebates owed', color: '#4fb3a0', link: '/invoices', from: 'Invoices the farm sent that aren\'t paid yet, on their due date, and rebates still to come on their expected date (Rewards page; one still being earned is an estimate). An overdue one counts now.' },
  wages: { label: 'Wages', color: '#6fbf73', link: '/paystubs', from: 'The paystubs: recent take-home pay on the usual pay schedule, with CPP and EI stopping once they reach the year\'s maximum, and the summer holdback in July and August.' },
  est_in: { label: 'Estimated income', color: '#2bb0a1', link: '/cash-flow', from: 'Your cash estimates on this page (Estimates, below).' },
  inventory: { label: 'Inventory sales', color: '#5b8def', link: '/assets', from: 'Unsold grain and cattle at today\'s prices, in the month you expect to sell them.' },
  gst_in: { label: 'GST refunds', color: '#9b85ee', link: '/tax', from: 'GST returns: a refund about a month after filing.' },
  opline: { label: 'Operating line', color: '#8fa3b8', link: '/loans', from: 'Drawing on or paying down the operating line.' },
  bills: { label: 'Bills', color: '#e0835a', link: '/bills', from: 'Unpaid bills by due date, and recurring bills on their schedule (an overdue one counts now).' },
  loans: { label: 'Loan & lease payments', color: '#d46a9a', link: '/loans', from: 'Loan and lease payment schedules (principal and interest).' },
  cards: { label: 'Card statements', color: '#e8b04a', link: '/credit-cards', from: 'Credit card statement balances, on their due date.' },
  household: { label: 'Household spending', color: '#9b85ee', link: '/personal', from: 'The household budget (Personal page): a share of the room above the cash floor each month (90% unless changed), for everything that isn\'t a bill.' },
  tax: { label: 'Income tax', color: '#5b8def', link: '/tax', from: 'The farm income tax estimate: the December instalment and the April balance (or a June refund).' },
  gst_out: { label: 'GST payments', color: '#7f8ce0', link: '/tax', from: 'GST returns owing.' },
  fees: { label: 'Account fees', color: '#6b7480', link: '/accounts', from: 'Recurring bank account fees.' },
  est_out: { label: 'Estimated costs', color: '#2bb0a1', link: '/cash-flow', from: 'Your cash estimates on this page (Estimates, below).' },
  whatif: { label: 'What-if', color: '#5fd3e6', link: null, from: 'The what-if shown on this page.' },
  other: { label: 'Other', color: '#6b7480', link: null, from: '' },
};

export function groupOf(it) {
  const inflow = it.amount > 0;
  switch (it.kind) {
    case 'contract': return 'contracts';
    case 'receivable': return 'invoices';
    case 'estimate_in': return it.ref?.paystub ? 'wages' : 'est_in';
    case 'inventory': return 'inventory';
    case 'gst': return inflow ? 'gst_in' : 'gst_out';
    case 'opline': return 'opline';
    case 'bill': return 'bills';
    case 'loan': case 'lease': return 'loans';
    case 'card': return 'cards';
    case 'personal': return 'household';
    case 'tax': return inflow ? 'est_in' : 'tax';
    case 'fee': return 'fees';
    case 'estimate_out': return 'est_out';
    case 'whatif': return 'whatif';
    default: return 'other';
  }
}

// The chart itself lives in Pie.jsx; re-exported here for the pages that import it from this file.
export { Pie };

function ItemRow({ it }) {
  return (
    <li className="mb-item">
      <div className="mb-item-head">
        <span>{it.label}</span>
        <span className={`mb-amt ${it.amount > 0 ? 'pos' : 'neg'}`}>{cents(it.amount)}</span>
      </div>
      <div className="split-lines">
        {it.date || ''}
        {it.estimate ? <span className="tag">Estimate</span> : <span className="tag tag-link">Committed</span>}
        {it.overdue && <span className="tag">Overdue — counted now</span>}
        {it.whatif && <span className="tag">What-if</span>}
        {it.moved && !it.whatif && <span className="tag">Moved by what-if</span>}
        {it.changed && !it.whatif && !it.moved && <span className="tag">Changed by what-if</span>}
        {it.kind === 'loan' && it.interest > 0 && <span className="tag">incl. {cents(it.interest)} interest</span>}
      </div>
    </li>
  );
}

/** One side of the month: a pie by group, the groups as a list, and the items of the group picked. */
function Side({ title, items, sign }) {
  const [sel, setSel] = useState(null);
  const groups = {};
  for (const it of items) {
    const g = groupOf(it);
    (groups[g] = groups[g] || []).push(it);
  }
  const slices = Object.entries(groups).map(([k, list]) => ({ key: k, label: GROUPS[k].label, color: GROUPS[k].color, amount: Math.abs(list.reduce((a, x) => a + x.amount, 0)), list }))
    .filter((s) => s.amount > 0.005).sort((a, b) => b.amount - a.amount);
  const total = slices.reduce((a, s) => a + s.amount, 0);
  const cur = slices.find((s) => s.key === sel);
  useEffect(() => { if (sel && !cur) setSel(null); }, [sel, cur]);
  return (
    <div className="mb-side">
      <h3>{title} <span className={sign > 0 ? 'pos' : 'neg'}>{sign > 0 ? '+' : '−'}{money(Math.round(total))}</span></h3>
      {!slices.length ? <p className="split-lines">Nothing {sign > 0 ? 'expected' : 'scheduled'}.</p> : (
        <div className="mb-side-body">
          <Pie slices={slices} selected={sel} onSelect={setSel} label={`${title} by source`} />
          <div className="mb-side-list">
            {cur ? (
              <>
                <div className="mb-group-head">
                  <span><span className="ps-swatch" style={{ background: cur.color }} />{cur.label}</span>
                  <b>{cents(cur.amount * sign)}</b>
                </div>
                {GROUPS[cur.key].from && <p className="mb-from">{GROUPS[cur.key].from}{GROUPS[cur.key].link && <> <a className="small-link" href={GROUPS[cur.key].link}>Open</a></>}</p>}
                <ul className="mb-items">{cur.list.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).map((it, i) => <ItemRow key={i} it={it} />)}</ul>
                <button type="button" className="small-link" onClick={() => setSel(null)}>Back to all</button>
              </>
            ) : (
              <table className="ps-legend" data-nostack="">
                <tbody>
                  {slices.map((s) => (
                    <tr key={s.key} className="ps-legend-row" tabIndex={0} onClick={() => setSel(s.key)} onKeyDown={(e) => { if (e.key === 'Enter') setSel(s.key); }}>
                      <td><span className="ps-swatch" style={{ background: s.color }} />{s.label}<span className="split-lines"> · {s.list.length}</span></td>
                      <td className="num">{money(Math.round(s.amount))}</td>
                      <td className="num ps-pct">{total ? Math.round((s.amount / total) * 100) : 0}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const FLOOR_PARTS = [['loans', 'Loan and lease payments'], ['bills', 'Bills'], ['cards', 'Card statements'], ['tax', 'Tax and GST'], ['fees', 'Fees']];

/** The whole month: opening to closing, money in and out by source, and the floor after it. */
export default function MonthBreakdown({ m, floor, floorDays = 60, compare = null }) {
  const ins = m.items.filter((x) => x.amount > 0);
  const outs = m.items.filter((x) => x.amount < 0);
  const committedIn = ins.filter((x) => !x.estimate).reduce((a, x) => a + x.amount, 0);
  const committedOut = outs.filter((x) => !x.estimate).reduce((a, x) => a + x.amount, 0);
  const open = m.open ?? (m.balance - (m.inflow || 0) - (m.outflow || 0));
  const parts = m.floorParts ? FLOOR_PARTS.filter(([k]) => m.floorParts[k] >= 1) : [];
  return (
    <div className="mb">
      <div className="mb-steps">
        <span>Opening <b>{money(Math.round(open))}</b></span>
        <span>+ in <b className="pos">{money(Math.round(m.inflow || 0))}</b></span>
        <span>− out <b className="neg">{money(Math.round(-(m.outflow || 0)))}</b></span>
        <span>= closing <b>{money(Math.round(m.balance))}</b></span>
        {compare != null && <span>Without the what-if <b>{money(Math.round(compare))}</b></span>}
      </div>
      <p className="mb-note">
        Committed (contracts, bills, loans, cards, tax): {money(Math.round(committedIn))} in, {money(Math.round(-committedOut))} out.
        The rest is estimated: wages, household spending, inventory sales and your cash estimates.
      </p>
      <div className="mb-sides">
        <Side title="Money in" items={ins} sign={1} />
        <Side title="Money out" items={outs} sign={-1} />
      </div>
      {floor != null && (
        <div className="mb-floor">
          <b>Floor after this month: {money(Math.round(floor))}</b> — what must be paid in the {floorDays} days after the month-end
          {parts.length ? `: ${parts.map(([k, l]) => `${l} ${money(Math.round(m.floorParts[k]))}`).join(', ')}` : ''}
          {m.floorDue != null && m.floorDue > floor + 0.5 ? `, ${money(Math.round(m.floorDue))} in all — capped at ${money(Math.round(floor))}, since those payments already come off the months they fall in` : ''}.
          {m.balance < floor ? ' The month closes below it.' : ` The month closes ${money(Math.round(m.balance - floor))} above it.`}
        </div>
      )}
    </div>
  );
}
