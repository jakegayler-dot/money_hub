import { Fragment, useEffect, useState } from 'react';
import { money, localToday } from '../format.js';
import { cents } from '../components/SplitEditor.jsx';
import { Pie } from '../components/Pie.jsx';
import CardPoints from '../components/CardPoints.jsx';
import CategorySelect from '../components/CategorySelect.jsx';
import { SERIES } from '../chartColors.js';

// Gift cards, card points and rebates (Jake, 2026-10-29): what each is worth
// today, in one place. Gift cards received have a balance that goes down as
// they're used; ones given are a record of the gift. Points are the card
// programs (also on Credit Cards). Rebates are input programs earned on
// purchases and paid later: on Cash Flow on their expected date, and booked
// when the cheque comes.

const send = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => { const d = r.status === 204 ? {} : await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; });
const OWNERS = { jake: 'Jake', ashley: 'Ashley', farm: 'Farm', family: 'Family' };
const STATUS = { earning: 'Earning', claimed: 'Claimed', approved: 'Approved', received: 'Received', lost: 'Lost' };
const STEPS = ['earning', 'claimed', 'approved', 'received'];
const SEG = { grain: 'Grain', livestock: 'Cattle', jake: 'Jake', ashley: 'Ashley' };

function Card({ title, children, action }) {
  return (
    <div className="panel">
      <div className="panel-header spend-header"><span>{title}</span>{action}</div>
      {children}
    </div>
  );
}

// ---- Gift cards ------------------------------------------------------------
const blankCard = (direction) => ({ direction, merchant: '', person: '', value: '', date: localToday(), expires: '', owner: 'jake', occasion: '', notes: '' });

function CardForm({ initial, onSaved, onCancel }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const given = f.direction === 'given';
  const save = () => (f.id ? send('PATCH', `/api/rewards/gift-cards/${f.id}`, f) : send('POST', '/api/rewards/gift-cards', f)).then(onSaved).catch((e) => setErr(e.message));
  return (
    <div className="rw-form">
      <div className="fd-grid">
        <div className="field"><label>Card for</label><input value={f.merchant} onChange={set('merchant')} placeholder="Co-op, Amazon, Cabela's…" /></div>
        <div className="field"><label>Value</label><input type="number" min="0" step="0.01" value={f.value} onChange={set('value')} /></div>
        <div className="field"><label>{given ? 'Given to' : 'From'}</label><input value={f.person} onChange={set('person')} /></div>
        <div className="field"><label>{given ? 'Given on' : 'Received'}</label><input type="date" value={f.date} onChange={set('date')} /></div>
        {!given && <div className="field"><label>Expires (optional)</label><input type="date" value={f.expires || ''} onChange={set('expires')} /></div>}
        <div className="field"><label>{given ? 'From' : 'Whose'}</label>
          <select value={f.owner} onChange={set('owner')}>{Object.entries(OWNERS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label>Occasion (optional)</label><input value={f.occasion || ''} onChange={set('occasion')} placeholder="Birthday, Christmas, thank-you…" /></div>
      </div>
      {err && <p className="review-error">{err}</p>}
      <div className="rw-form-actions">
        <button type="button" className="small" onClick={save}>{f.id ? 'Save' : given ? 'Add gift given' : 'Add gift card'}</button>
        <button type="button" className="small secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function UseForm({ card, onDone, onCancel }) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(localToday());
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState(null);
  return (
    <div className="rw-inline">
      <input type="number" min="0" step="0.01" placeholder={`up to ${card.balance.toFixed(2)}`} aria-label="Amount used" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <input type="date" aria-label="Used on" value={date} onChange={(e) => setDate(e.target.value)} />
      <input placeholder="What for (optional)" aria-label="What for" value={desc} onChange={(e) => setDesc(e.target.value)} />
      <button type="button" className="small" onClick={() => send('POST', `/api/rewards/gift-cards/${card.id}/use`, { amount: Number(amount), date, description: desc }).then(onDone).catch((e) => setErr(e.message))}>Log use</button>
      <button type="button" className="small-link" onClick={() => setAmount(card.balance.toFixed(2))}>All of it</button>
      <button type="button" className="small-link" onClick={onCancel}>Cancel</button>
      {err && <span className="review-error">{err}</span>}
    </div>
  );
}

function GiftCards({ cards, reload }) {
  const [form, setForm] = useState(null);
  const [using, setUsing] = useState(null);
  const [open, setOpen] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const received = cards.filter((c) => c.direction === 'received');
  const live = received.filter((c) => c.status === 'active' && c.balance > 0);
  const done = received.filter((c) => !(c.status === 'active' && c.balance > 0));
  const given = cards.filter((c) => c.direction === 'given');
  const year = localToday().slice(0, 4);
  const givenYear = given.filter((c) => c.date.startsWith(year));
  return (
    <Card title="Gift cards" action={
      <span className="rw-actions">
        <button type="button" className="small" onClick={() => setForm(blankCard('received'))}>Add a gift card</button>
        <button type="button" className="small secondary" onClick={() => setForm(blankCard('given'))}>Record one given</button>
      </span>
    }>
      {form && <CardForm key={form.id || form.direction} initial={form} onCancel={() => setForm(null)} onSaved={() => { setForm(null); reload(); }} />}
      {live.length === 0 && !form ? <div className="empty-state">No gift cards with money on them. Add one when you're given it, and log what you spend.</div> : (
        <table className="rw-table">
          <thead><tr><th>Card</th><th>From</th><th>Whose</th><th className="num">Value</th><th className="num">Left</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {live.map((c) => (
              <Fragment key={c.id}>
                <tr>
                  <td><b>{c.merchant}</b>{c.occasion && <div className="split-lines">{c.occasion}</div>}</td>
                  <td>{c.person || '—'}<div className="split-lines">{c.date}</div></td>
                  <td>{OWNERS[c.owner]}</td>
                  <td className="num">{cents(c.value)}</td>
                  <td className="num"><b>{cents(c.balance)}</b>
                    <span className="bf-progress rw-left" aria-hidden="true"><span style={{ width: `${c.value ? (c.balance / c.value) * 100 : 0}%`, background: SERIES[2] }} /></span></td>
                  <td>{c.expires || '—'}{c.expired ? <span className="badge fail">EXPIRED</span> : c.expiring ? <span className="badge warn">SOON</span> : null}</td>
                  <td className="fd-acts">
                    <button type="button" className="small-link" onClick={() => setUsing(using === c.id ? null : c.id)}>Log use</button>
                    {c.uses.length > 0 && <button type="button" className="small-link" onClick={() => setOpen(open === c.id ? null : c.id)}>{c.uses.length} use{c.uses.length === 1 ? '' : 's'}</button>}
                    <button type="button" className="small-link" onClick={() => setForm({ ...c, expires: c.expires || '', person: c.person || '', occasion: c.occasion || '' })}>Edit</button>
                    <button type="button" className="small-link" onClick={() => { if (window.confirm(`Delete the ${c.merchant} card?`)) send('DELETE', `/api/rewards/gift-cards/${c.id}`).then(reload); }}>Delete</button>
                  </td>
                </tr>
                {using === c.id && <tr><td colSpan={7}><UseForm card={c} onCancel={() => setUsing(null)} onDone={() => { setUsing(null); reload(); }} /></td></tr>}
                {open === c.id && (
                  <tr><td colSpan={7}>
                    <table className="ps-legend" data-nostack="">
                      <tbody>{c.uses.map((u) => (
                        <tr key={u.id}><td>{u.date}</td><td>{u.description || '—'}</td><td className="num">{cents(u.amount)}</td>
                          <td><button type="button" className="small-link" onClick={() => send('DELETE', `/api/rewards/gift-cards/uses/${u.id}`).then(reload)}>Remove</button></td></tr>
                      ))}</tbody>
                    </table>
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {done.length > 0 && (
        <div className="rw-sub">
          <button type="button" className="small-link" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} {done.length} used up or lost</button>
          {showDone && (
            <table className="rw-table rw-quiet"><tbody>{done.map((c) => (
              <tr key={c.id}><td>{c.merchant}</td><td>{c.person || '—'}</td><td>{c.date}</td><td className="num">{cents(c.value)}</td>
                <td>{c.status === 'lost' ? 'Lost' : c.expired ? 'Expired' : 'Used up'}</td>
                <td><button type="button" className="small-link" onClick={() => { if (window.confirm(`Delete the ${c.merchant} card?`)) send('DELETE', `/api/rewards/gift-cards/${c.id}`).then(reload); }}>Delete</button></td></tr>
            ))}</tbody></table>
          )}
        </div>
      )}
      {given.length > 0 && (
        <div className="rw-sub">
          <div className="split-lines">Given — {money(givenYear.reduce((a, c) => a + c.value, 0))} in {year}</div>
          <table className="rw-table rw-quiet"><tbody>{given.map((c) => (
            <tr key={c.id}><td><b>{c.merchant}</b></td><td>to {c.person || '—'}</td><td>{c.occasion || ''}</td><td>{c.date}</td><td className="num">{cents(c.value)}</td>
              <td className="fd-acts"><button type="button" className="small-link" onClick={() => setForm({ ...c, person: c.person || '', occasion: c.occasion || '', expires: '' })}>Edit</button>
                <button type="button" className="small-link" onClick={() => { if (window.confirm('Delete this gift?')) send('DELETE', `/api/rewards/gift-cards/${c.id}`).then(reload); }}>Delete</button></td></tr>
          ))}</tbody></table>
        </div>
      )}
    </Card>
  );
}

// ---- Rebates -----------------------------------------------------------------
const blankRebate = () => ({ program: '', sponsor: '', season: localToday().slice(0, 4), qualifying_spend: '', rate_pct: '', amount: '', status: 'earning', claim_by: '', expected_date: '', category_id: '', segment: 'grain', notes: '' });

function RebateForm({ initial, categories, onSaved, onCancel }) {
  const [f, setF] = useState(initial);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const calc = f.qualifying_spend !== '' && f.rate_pct !== '' ? Number(f.qualifying_spend) * Number(f.rate_pct) / 100 : null;
  const save = () => (f.id ? send('PATCH', `/api/rewards/rebates/${f.id}`, f) : send('POST', '/api/rewards/rebates', f)).then(onSaved).catch((e) => setErr(e.message));
  return (
    <div className="rw-form">
      <div className="fd-grid">
        <div className="field"><label>Program</label><input value={f.program} onChange={set('program')} placeholder="BASF Ag Solutions Rewards 2026" /></div>
        <div className="field"><label>Paid by</label><input value={f.sponsor} onChange={set('sponsor')} placeholder="BASF, Nutrien, your retailer…" /></div>
        <div className="field"><label>Season</label><input type="number" value={f.season ?? ''} onChange={set('season')} /></div>
        <div className="field"><label>Qualifying purchases (optional)</label><input type="number" min="0" step="0.01" value={f.qualifying_spend ?? ''} onChange={set('qualifying_spend')} /></div>
        <div className="field"><label>% back (optional)</label><input type="number" min="0" step="0.1" value={f.rate_pct ?? ''} onChange={set('rate_pct')} /></div>
        <div className="field"><label>Expected back</label><input type="number" min="0" step="0.01" value={f.amount ?? ''} onChange={set('amount')} placeholder={calc != null ? calc.toFixed(2) : ''} />
          {calc != null && f.amount === '' && <p className="field-hint">Purchases × % back: {cents(calc)}</p>}</div>
        <div className="field"><label>Stage</label>
          <select value={f.status} onChange={set('status')}>{['earning', 'claimed', 'approved', 'lost'].map((k) => <option key={k} value={k}>{STATUS[k]}</option>)}</select></div>
        <div className="field"><label>Claim by (optional)</label><input type="date" value={f.claim_by || ''} onChange={set('claim_by')} /></div>
        <div className="field"><label>Cheque expected</label><input type="date" value={f.expected_date || ''} onChange={set('expected_date')} /></div>
        <div className="field"><label>Files under</label><CategorySelect categories={categories} value={f.category_id} onChange={(v) => setF({ ...f, category_id: v })} emptyLabel="No category" /></div>
        <div className="field"><label>Whose</label>
          <select value={f.segment} onChange={set('segment')}>{Object.entries(SEG).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      </div>
      <p className="field-hint">Files under: the input it came off (chemical, seed, fertilizer), so the rebate lowers that cost. With a cheque date, it's on Cash Flow — while still earning, as an estimate.</p>
      {err && <p className="review-error">{err}</p>}
      <div className="rw-form-actions">
        <button type="button" className="small" onClick={save}>{f.id ? 'Save' : 'Add rebate'}</button>
        <button type="button" className="small secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ReceivePanel({ r, accounts, onDone, onCancel }) {
  const [account, setAccount] = useState('');
  const [date, setDate] = useState(localToday());
  const [amount, setAmount] = useState(r.expected != null ? r.expected.toFixed(2) : '');
  const [cands, setCands] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { fetch(`/api/rewards/rebates/${r.id}/candidates`).then((x) => x.json()).then((d) => setCands(Array.isArray(d) ? d : [])).catch(() => setCands([])); }, [r.id]);
  const go = (body) => send('POST', `/api/rewards/rebates/${r.id}/receive`, body).then(onDone).catch((e) => setErr(e.message));
  return (
    <div className="fd-pay">
      {cands?.length > 0 && (
        <div>
          <div className="split-lines">Already in the ledger? Link it instead of booking a second deposit:</div>
          {cands.map((c) => (
            <div key={c.id} className="fd-cand"><span>{c.date} · {c.account} · {c.description} · {cents(c.amount)}</span>
              <button type="button" className="small" onClick={() => go({ transaction_id: c.id })}>This is it</button></div>
          ))}
        </div>
      )}
      <div className="fd-pay-row">
        <select value={account} aria-label="Deposited to" onChange={(e) => setAccount(e.target.value)}>
          <option value="">Deposited to…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input type="number" step="0.01" aria-label="Amount received" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <input type="date" aria-label="Received on" value={date} onChange={(e) => setDate(e.target.value)} />
        <button type="button" className="small" disabled={!account} onClick={() => go({ account_id: Number(account), amount: Number(amount), date })}>Book the deposit</button>
        <button type="button" className="small-link" onClick={onCancel}>Cancel</button>
      </div>
      {err && <p className="review-error">{err}</p>}
    </div>
  );
}

function Rebates({ rows, categories, accounts, reload }) {
  const [form, setForm] = useState(null);
  const [receiving, setReceiving] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const open = rows.filter((r) => !['received', 'lost'].includes(r.status));
  const done = rows.filter((r) => ['received', 'lost'].includes(r.status));
  const edit = (r) => setForm(Object.fromEntries(Object.entries({ ...blankRebate(), ...r }).map(([k, v]) => [k, v == null ? '' : v])));
  const stage = (r, s) => send('PATCH', `/api/rewards/rebates/${r.id}`, { status: s }).then(reload);
  return (
    <Card title="Rebates" action={<button type="button" className="small" onClick={() => setForm(blankRebate())}>Add a rebate</button>}>
      {form && <RebateForm key={form.id || 'new'} initial={form} categories={categories} onCancel={() => setForm(null)} onSaved={() => { setForm(null); reload(); }} />}
      {open.length === 0 && !form ? <div className="empty-state">No rebates being tracked. Add each input program you're in — what you bought under it, the % back, and when the cheque comes.</div> : (
        <table className="rw-table">
          <thead><tr><th>Program</th><th>Stage</th><th className="num">Expected</th><th>Claim by</th><th>Cheque</th><th /></tr></thead>
          <tbody>
            {open.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td><b>{r.program}</b><div className="split-lines">{[r.sponsor, r.season, SEG[r.segment], r.category].filter(Boolean).join(' · ')}</div>
                    {r.qualifying_spend != null && <div className="split-lines">{money(r.qualifying_spend)} bought{r.rate_pct != null ? ` × ${r.rate_pct}%` : ''}</div>}</td>
                  <td>
                    <span className="rw-steps" aria-label={`Stage: ${STATUS[r.status]}`}>
                      {STEPS.slice(0, 3).map((s) => <button key={s} type="button" className={`rw-step${STEPS.indexOf(s) <= STEPS.indexOf(r.status) ? ' on' : ''}`} title={`Mark ${STATUS[s].toLowerCase()}`} onClick={() => s !== r.status && stage(r, s)}>{STATUS[s]}</button>)}
                    </span>
                  </td>
                  <td className="num">{r.expected != null ? cents(r.expected) : '—'}</td>
                  <td>{r.claim_by || '—'}{r.claim_missed ? <span className="badge fail">MISSED</span> : r.claim_soon ? <span className="badge warn">SOON</span> : null}</td>
                  <td>{r.expected_date || <span className="split-lines">not set — not on Cash Flow</span>}{r.overdue && <span className="badge warn">LATE</span>}</td>
                  <td className="fd-acts">
                    <button type="button" className="small-link" onClick={() => setReceiving(receiving === r.id ? null : r.id)}>Received</button>
                    <button type="button" className="small-link" onClick={() => edit(r)}>Edit</button>
                    <button type="button" className="small-link" onClick={() => stage(r, 'lost')}>Lost</button>
                    <button type="button" className="small-link" onClick={() => { if (window.confirm(`Delete ${r.program}?`)) send('DELETE', `/api/rewards/rebates/${r.id}`).then(reload); }}>Delete</button>
                  </td>
                </tr>
                {receiving === r.id && <tr><td colSpan={6}><ReceivePanel r={r} accounts={accounts} onCancel={() => setReceiving(null)} onDone={() => { setReceiving(null); reload(); }} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {done.length > 0 && (
        <div className="rw-sub">
          <button type="button" className="small-link" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} {done.length} received or lost</button>
          {showDone && (
            <table className="rw-table rw-quiet"><tbody>{done.map((r) => (
              <tr key={r.id}><td>{r.program}</td><td>{STATUS[r.status]}{r.received_date ? ` ${r.received_date}` : ''}</td>
                <td className="num">{r.received_amount != null ? cents(r.received_amount) : r.expected != null ? cents(r.expected) : ''}</td>
                <td>{r.account || ''}</td>
                <td className="fd-acts">
                  {r.status === 'received' && <button type="button" className="small-link" onClick={() => { if (window.confirm(`Undo receiving ${r.program}? ${r.linked_existing ? 'The deposit stays in the ledger, unlinked.' : 'The deposit booked here is deleted.'}`)) send('POST', `/api/rewards/rebates/${r.id}/unreceive`).then(reload); }}>Undo</button>}
                  {r.status === 'lost' && <button type="button" className="small-link" onClick={() => stage(r, 'earning')}>Back on</button>}
                </td></tr>
            ))}</tbody></table>
          )}
        </div>
      )}
    </Card>
  );
}

// ---- The page -----------------------------------------------------------------
export default function Rewards() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [categories, setCategories] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [cards, setCards] = useState([]);
  const [sel, setSel] = useState(null);
  const [pointsKey, setPointsKey] = useState(0);
  const load = () => fetch('/api/rewards').then((r) => r.json()).then((d) => (d.error ? setErr(d.error) : setData(d))).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    fetch('/api/expenses').then((r) => r.json()).then((c) => setCategories(Array.isArray(c) ? c : []));
    fetch('/api/accounts').then((r) => r.json()).then((a) => setAccounts(Array.isArray(a) ? a : []));
    fetch('/api/credit-cards').then((r) => r.json()).then((c) => setCards(Array.isArray(c) ? c : []));
  }, []);
  if (!data) return err ? <div className="empty-state">{err}</div> : <div className="empty-state">Loading…</div>;
  const s = data.summary;
  const slices = [
    { key: 'gift', label: 'Gift cards', amount: s.gift_cards.value, color: SERIES[2] },
    { key: 'points', label: 'Card points', amount: s.points.value, color: SERIES[0] },
    { key: 'rebates', label: 'Rebates to come', amount: s.rebates.value, color: SERIES[3] },
  ].filter((x) => x.amount > 0.005);
  const jump = (k) => { setSel(k); document.getElementById(`rw-${k}`)?.scrollIntoView({ block: 'start' }); };

  return (
    <>
      <div className="page-header"><h1 className="page-title">Gift cards, points &amp; rebates</h1></div>
      {err && <p className="review-error" style={{ margin: '0 0 12px' }}>{err}</p>}
      <div className="panel">
        <div className="panel-header">Worth today</div>
        <div className="ps-pie-wrap">
          {slices.length ? <Pie slices={slices} size={200} selected={sel} onSelect={(k) => k && jump(k)} label="What it's all worth, by kind" centerTitle="Worth" /> : null}
          <div className="ps-pie-side">
            <table className="ps-legend" data-nostack="">
              <tbody>
                {[
                  ['gift', 'Gift cards', s.gift_cards.value, SERIES[2], `${s.gift_cards.count} with money on them${s.gift_cards.expiring ? ` · ${s.gift_cards.expiring} expiring soon` : ''}`],
                  ['points', 'Card points', s.points.value, SERIES[0], s.points.programs.length ? s.points.programs.map((p) => p.name).join(', ') : 'no programs yet'],
                  ['rebates', 'Rebates to come', s.rebates.value, SERIES[3], `${s.rebates.count} open${s.rebates.claims_due ? ` · ${s.rebates.claims_due} claim${s.rebates.claims_due === 1 ? '' : 's'} due within 30 days` : ''} · ${money(s.rebates.received_this_year)} received this year`],
                ].map(([k, l, v, c, sub]) => (
                  <tr key={k} className="ps-legend-row" tabIndex={0} onClick={() => jump(k)} onKeyDown={(e) => { if (e.key === 'Enter') jump(k); }}>
                    <td><span className="ps-swatch" style={{ background: c }} />{l}<div className="split-lines">{sub}</div></td>
                    <td className="num">{money(v)}</td>
                  </tr>
                ))}
                <tr className="ps-legend-total"><td>All together</td><td className="num">{money(s.total)}</td></tr>
              </tbody>
            </table>
            {s.gift_cards.given_this_year > 0 && <p className="split-lines" style={{ marginTop: 8 }}>Gift cards given this year: {money(s.gift_cards.given_this_year)}.</p>}
          </div>
        </div>
      </div>
      <div id="rw-gift"><GiftCards cards={data.gift_cards} reload={load} /></div>
      <div id="rw-points"><CardPoints cards={cards} refreshKey={pointsKey} onChanged={() => { setPointsKey((k) => k + 1); load(); }} /></div>
      <div id="rw-rebates"><Rebates rows={data.rebates} categories={categories} accounts={accounts.filter((a) => a.status !== 'closed')} reload={load} /></div>
    </>
  );
}
