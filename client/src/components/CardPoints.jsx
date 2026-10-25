import { useEffect, useState } from 'react';
import MetricCard from './MetricCard.jsx';
import { Pie } from './MonthBreakdown.jsx';
import { money, localToday } from '../format.js';

// Credit card points (server/lib/points.js): each program's balance and
// what it's worth, points on the way from spending since the last
// statement, what this year's spending earns by category, and the ledger
// of balances, earnings and redemptions.
const PALETTE = ['#c9a227', '#5b8def', '#2bb0a1', '#e0835a', '#9b85ee', '#6fbf73', '#d46a9a', '#e8b04a', '#5fd3e6', '#b0896a', '#8fa3b8', '#7f8ce0'];
const OWNERS = { jake: 'Jake', ashley: 'Ashley', farm: 'Farm' };
const KIND_LABELS = { balance: 'Balance', earned: 'Earned', bonus: 'Bonus', redeemed: 'Redeemed', expired: 'Expired', adjusted: 'Adjustment' };
const pts = (n) => new Intl.NumberFormat('en-CA', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
const cents2 = (n) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2 }).format(n || 0);
const amt = (p, n) => (p.unit === 'dollars' ? cents2(n) : `${pts(n)} pts`);

function Legend({ items, total, selected, onSelect, fmt }) {
  return (
    <table className="ps-legend" data-nostack="">
      <tbody>
        {items.map((s) => (
          <tr key={s.key} className={`ps-legend-row${selected === s.key ? ' on' : ''}`} tabIndex={0} onClick={() => onSelect(selected === s.key ? null : s.key)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSelect(selected === s.key ? null : s.key); }}>
            <td><span className="ps-swatch" style={{ background: s.color }} />{s.label}</td>
            <td className="num">{fmt(s)}</td>
            <td className="num ps-pct">{total ? Math.round((s.amount / total) * 100) : 0}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const emptyProgram = { name: '', owner: 'jake', unit: 'points', cents_per_point: '1', balance: '', card_ids: [] };

function ProgramForm({ initial, cards, onSave, onCancel, submitLabel }) {
  const [f, setF] = useState(initial);
  const set = (k, v) => setF({ ...f, [k]: v });
  const toggle = (id) => set('card_ids', f.card_ids.includes(id) ? f.card_ids.filter((x) => x !== id) : [...f.card_ids, id]);
  return (
    <div className="pt-form">
      <div className="pt-form-row">
        <label>Program<input value={f.name} placeholder="e.g. Aeroplan, RBC Avion, Scene+" onChange={(e) => set('name', e.target.value)} /></label>
        <label>Whose points
          <select value={f.owner} onChange={(e) => set('owner', e.target.value)}>
            {Object.entries(OWNERS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label>Counted in
          <select value={f.unit} onChange={(e) => set('unit', e.target.value)}>
            <option value="points">Points</option><option value="dollars">Dollars (cash back)</option>
          </select>
        </label>
        {f.unit === 'points' && (
          <label>Worth per point (¢)
            <input type="number" step="0.01" min="0" value={f.cents_per_point} onChange={(e) => set('cents_per_point', e.target.value)} />
          </label>
        )}
        {'balance' in f && (
          <label>Balance today<input type="number" step="1" value={f.balance} placeholder={f.unit === 'dollars' ? '$ on the card' : 'points'} onChange={(e) => set('balance', e.target.value)} /></label>
        )}
      </div>
      {f.unit === 'points' && (
        <p className="split-lines">What a point gets you the way you usually redeem: 1,000 points for a $10 credit is 1¢; a flight that costs 60,000 points instead of $1,200 is 2¢.</p>
      )}
      <div className="pt-cards">
        <span className="split-lines">Cards that earn it:</span>
        {cards.map((c) => (
          <label key={c.id} className="tp-check"><input type="checkbox" checked={f.card_ids.includes(c.id)} onChange={() => toggle(c.id)} /> {c.name}</label>
        ))}
      </div>
      <div className="pt-form-row">
        <button type="button" className="small" disabled={!f.name.trim()} onClick={() => onSave(f)}>{submitLabel}</button>
        {onCancel && <button type="button" className="small secondary" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

function EntryForm({ p, redeemedFor, onSave }) {
  const [f, setF] = useState({ kind: 'balance', date: localToday(), points: '', value: '', redeemed_for: 'statement_credit', credit_card_id: '', note: '' });
  const set = (k, v) => setF({ ...f, [k]: v });
  const worth = f.points !== '' ? Math.abs(Number(f.points)) * (p.unit === 'dollars' ? 1 : p.cents_per_point / 100) : null;
  return (
    <div className="pt-form">
      <div className="pt-form-row">
        <label>Record
          <select className="pt-kind" value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="balance">Balance shown by the program</option>
            <option value="redeemed">Redemption</option>
            <option value="earned">Points earned</option>
            <option value="bonus">Bonus (sign-up, promo)</option>
            <option value="expired">Points expired</option>
            <option value="adjusted">Adjustment (+ or −)</option>
          </select>
        </label>
        <label>Date<input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></label>
        <label>{p.unit === 'dollars' ? 'Dollars' : 'Points'}<input type="number" step="1" value={f.points} onChange={(e) => set('points', e.target.value)} /></label>
        {f.kind === 'redeemed' && (
          <>
            <label>For
              <select value={f.redeemed_for} onChange={(e) => set('redeemed_for', e.target.value)}>
                {Object.entries(redeemedFor).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            {p.unit === 'points' && (
              <label>Worth ($)<input type="number" step="0.01" value={f.value} placeholder={worth != null ? cents2(worth).replace('$', '') : ''} onChange={(e) => set('value', e.target.value)} /></label>
            )}
          </>
        )}
        {f.kind !== 'balance' && p.cards.length > 1 && (
          <label>Card
            <select value={f.credit_card_id} onChange={(e) => set('credit_card_id', e.target.value)}>
              <option value="">—</option>{p.cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label className="pt-note">Note<input value={f.note} onChange={(e) => set('note', e.target.value)} /></label>
        <button type="button" className="small" disabled={f.points === ''} onClick={async () => { if (await onSave(f)) setF({ ...f, points: '', value: '', note: '' }); }}>Record</button>
      </div>
      {f.kind === 'redeemed' && (
        <p className="split-lines">
          A redemption is money you didn't have to spend — counted as a saving, never as income. Enter what it was really worth
          {p.unit === 'points' ? ' (blank uses the program\'s value per point)' : ''}.
          {f.redeemed_for === 'statement_credit' ? ' The credit itself shows up on the card statement; file it under the spending it paid for.' : ''}
        </p>
      )}
    </div>
  );
}

function Program({ p, cards, redeemedFor, call }) {
  const [sel, setSel] = useState(null);
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const cats = p.year.by_category.filter((x) => x.points > 0);
  const byCat = {};
  for (const x of cats) (byCat[x.category] = byCat[x.category] || []).push(x);
  const slices = Object.entries(byCat).map(([k, list], i) => ({
    key: k, label: k, color: PALETTE[i % PALETTE.length], list,
    amount: list.reduce((a, x) => a + x.points, 0), spend: list.reduce((a, x) => a + x.amount, 0), value: list.reduce((a, x) => a + x.value, 0),
  })).sort((a, b) => b.amount - a.amount).map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }));
  const totalPts = slices.reduce((a, s) => a + s.amount, 0);
  const cur = slices.find((s) => s.key === sel);
  const entries = showAll ? p.entries : p.entries.slice(0, 8);
  const noRates = p.cards.filter((c) => !c.has_rates);

  return (
    <div className="pt-program">
      <div className="pt-program-head">
        <div>
          <div className="pt-name">{p.name} <span className="tag">{OWNERS[p.owner]}</span></div>
          <div className="split-lines">
            {p.cards.length ? p.cards.map((c) => c.name).join(', ') : 'No card linked'}
            {p.unit === 'points' ? ` · ${p.cents_per_point}¢ a point` : ' · cash back'}
          </div>
        </div>
        <div className="pt-balance">
          <div className="pt-balance-big">{p.unit === 'dollars' ? cents2(p.balance) : pts(p.balance)}{p.unit === 'points' && <span> pts</span>}</div>
          <div className="split-lines">
            {p.unit === 'points' ? `worth about ${money(p.value)}` : 'cash back'}{p.as_of ? ` · as of ${p.as_of}` : ''}
          </div>
        </div>
      </div>

      {!p.balance_known && <p className="pt-hint">Record the balance your program shows today — everything is measured from it.</p>}
      {p.pending.points > 0 && (
        <p className="pt-pending">
          About {amt(p, p.pending.points)} more on the way{p.unit === 'points' ? ` (${money(p.pending.value)})` : ''} from {money(p.pending.spending)} spent since the last statement — an estimate at the earn rates below, not yet in the balance.
        </p>
      )}
      {noRates.length > 0 && <p className="pt-hint">{noRates.map((c) => c.name).join(', ')} {noRates.length === 1 ? 'has' : 'have'} no earn rates yet — add them under the card below, so spending can be turned into points.</p>}

      <div className="pt-year">
        <div><span className="split-lines">{p.year.year} spending on these cards</span><strong>{money(p.year.spending)}</strong></div>
        <div><span className="split-lines">earns about</span><strong>{amt(p, p.year.earned_estimate)}</strong>{p.unit === 'points' && <span className="split-lines">{money(p.year.earned_estimate_value)}</span>}</div>
        <div><span className="split-lines">redeemed</span><strong>{amt(p, p.year.redeemed)}</strong>{p.unit === 'points' && <span className="split-lines">saved {money(p.year.saved)}</span>}</div>
        {p.year.expired > 0 && <div><span className="split-lines">expired</span><strong className="neg">{amt(p, p.year.expired)}</strong></div>}
      </div>

      {slices.length > 0 && (
        <div className="ps-pie-wrap">
          {slices.length > 1 && <Pie slices={slices} selected={sel} onSelect={setSel} size={180} label={`${p.name} points by spending category`} />}
          <div className="ps-pie-side">
            {cur ? (
              <div>
                <button type="button" className="small-link" onClick={() => setSel(null)}>All categories</button>
                <div className="pt-cat-title">{cur.label}</div>
                <p className="split-lines">{money(cur.spend)} spent earns {amt(p, cur.amount)} — {money(cur.value)}</p>
                <table className="ps-legend" data-nostack="">
                  <tbody>
                    {cur.list.map((x) => (
                      <tr key={x.credit_card_id}><td>{x.card}<div className="split-lines">{x.rate_label}</div></td><td className="num">{money(x.amount)}</td><td className="num">{amt(p, x.points)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <>
                <div className="split-lines" style={{ marginBottom: 6 }}>{p.unit === 'dollars' ? 'Cash back' : 'Points'} this year's spending earns, by category — click one</div>
                <Legend items={slices} total={totalPts} selected={sel} onSelect={setSel} fmt={(s) => amt(p, s.amount)} />
              </>
            )}
          </div>
        </div>
      )}

      <EntryForm p={p} redeemedFor={redeemedFor} onSave={(f) => call(`/api/credit-cards/points/programs/${p.id}/entries`, 'POST', {
        ...f, credit_card_id: f.credit_card_id ? Number(f.credit_card_id) : (f.kind !== 'balance' && p.cards.length === 1 ? p.cards[0].id : null),
      })} />

      {p.entries.length > 0 && (
        <table className="pt-ledger">
          <thead><tr><th>Date</th><th>What</th><th className="num">{p.unit === 'dollars' ? 'Dollars' : 'Points'}</th><th className="num">Worth</th><th /></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{e.date}</td>
                <td>
                  {KIND_LABELS[e.kind]}{e.redeemed_for ? ` — ${redeemedFor[e.redeemed_for]}` : ''}
                  <div className="split-lines">{[e.card, e.source === 'statement' ? 'from the statement' : null, e.note && e.note !== 'From the card statement' ? e.note : null].filter(Boolean).join(' · ')}</div>
                </td>
                <td className={`num${e.kind !== 'balance' && e.points < 0 ? ' neg' : ''}`}>{e.kind === 'balance' ? '' : e.points > 0 ? '+' : ''}{p.unit === 'dollars' ? cents2(e.points) : pts(e.points)}</td>
                <td className="num">{e.kind === 'redeemed' ? money(e.value != null ? e.value : -e.points * (p.unit === 'dollars' ? 1 : p.cents_per_point / 100)) : ''}</td>
                <td><button type="button" className="small secondary" onClick={() => call(`/api/credit-cards/points/entries/${e.id}`, 'DELETE')}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.entries.length > 8 && <button type="button" className="small-link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${p.entries.length}`}</button>}

      <div className="pt-actions">
        {editing ? (
          <ProgramForm initial={{ name: p.name, owner: p.owner, unit: p.unit, cents_per_point: String(p.cents_per_point), card_ids: p.cards.map((c) => c.id) }}
            cards={cards} submitLabel="Save program" onCancel={() => setEditing(false)}
            onSave={async (f) => { if (await call(`/api/credit-cards/points/programs/${p.id}`, 'PATCH', { ...f, cents_per_point: Number(f.cents_per_point) })) setEditing(false); }} />
        ) : (
          <>
            <button type="button" className="small secondary" onClick={() => setEditing(true)}>Edit program</button>
            <button type="button" className="small secondary" onClick={() => { if (window.confirm(`Delete ${p.name} and its points history?`)) call(`/api/credit-cards/points/programs/${p.id}`, 'DELETE'); }}>Delete</button>
          </>
        )}
      </div>
    </div>
  );
}

export default function CardPoints({ cards, refreshKey, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [adding, setAdding] = useState(false);
  const [sel, setSel] = useState(null);
  const load = () => fetch('/api/credit-cards/points').then((r) => r.json()).then((x) => (x.error ? setErr(x.error) : setD(x))).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const call = async (url, method, body) => {
    setErr(null);
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const x = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(x.error || `HTTP ${r.status}`); return false; }
    setD(x);
    onChanged?.();
    return true;
  };
  if (!d) return err ? <div className="panel"><p className="review-error">{err}</p></div> : null;
  const active = cards.filter((c) => c.status === 'active');
  const t = d.totals;
  const progSlices = d.programs.filter((p) => p.value > 0).map((p, i) => ({ key: String(p.id), label: p.name, amount: p.value, color: PALETTE[i % PALETTE.length], p }));
  const shown = sel ? d.programs.filter((p) => String(p.id) === sel) : d.programs;

  return (
    <div className="panel pt">
      <div className="panel-header spend-header">
        <span>Points</span>
        {t.value > 0 && <span className="tp-total">worth about {money(t.value)}</span>}
      </div>
      <p>
        Card points by program, valued at what a point redeems for. Statements pushed with points fill this in; you can also record a balance
        or a redemption by hand. Points sit beside the books, not on the balance sheet — they can't pay a bill until redeemed, and programs
        devalue them. Redeeming them is a saving, not income.
      </p>
      {err && <p className="review-error" style={{ margin: '0 16px 8px' }}>{err}</p>}

      {d.programs.length > 0 && (
        <div className="grid personal-cards pt-metrics">
          <MetricCard label="Points worth" value={money(t.value)} sub={t.by_owner.map((o) => `${OWNERS[o.owner]} ${money(o.value)}`).join(' · ') || 'record a balance'} />
          <MetricCard label="On the way" value={money(t.pending_value)} sub="from spending since the last statements (estimate)" />
          <MetricCard label={`Earned in ${d.year}`} value={money(t.earned_value_this_year)} sub="what this year's card spending earns, at your earn rates" />
          <MetricCard label={`Saved by redeeming in ${d.year}`} value={money(t.saved_this_year)} sub="money you didn't have to spend" />
        </div>
      )}

      {progSlices.length > 1 && (
        <div className="ps-pie-wrap">
          <Pie slices={progSlices} selected={sel} onSelect={setSel} size={160} label="Points value by program" />
          <div className="ps-pie-side">
            <div className="split-lines" style={{ marginBottom: 6 }}>Value by program — click one to see only it</div>
            <Legend items={progSlices} total={t.value} selected={sel} onSelect={setSel} fmt={(s) => money(s.amount)} />
          </div>
        </div>
      )}

      {shown.map((p) => <Program key={p.id} p={p} cards={active} redeemedFor={d.redeemed_for} call={call} />)}

      {d.unlinked_cards.length > 0 && d.programs.length > 0 && !adding && (
        <p className="pt-hint">Not earning points here: {d.unlinked_cards.map((c) => c.name).join(', ')}. Link a card under Edit program, or add its program.</p>
      )}
      <div className="pt-actions">
        {adding ? (
          <ProgramForm initial={emptyProgram} cards={active} submitLabel="Add program" onCancel={() => setAdding(false)}
            onSave={async (f) => { if (await call('/api/credit-cards/points/programs', 'POST', { ...f, cents_per_point: Number(f.cents_per_point), balance: f.balance === '' ? null : Number(f.balance) })) setAdding(false); }} />
        ) : (
          <button type="button" className="small" onClick={() => setAdding(true)}>{d.programs.length ? 'Add another program' : 'Add a points program'}</button>
        )}
      </div>
    </div>
  );
}
