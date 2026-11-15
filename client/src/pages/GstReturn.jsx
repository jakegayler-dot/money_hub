// The GST return, one period at a time (Jake, Nov 15: "a gst return system that compiles all eligible expenses, flags if
// there is no receipt, automatically determines the required data points for the gst return for each quarter").
// Server: lib/gstReturn.js, GET /api/tax/gst/return.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { money, localToday } from '../format.js';
import { cents } from '../components/SplitEditor.jsx';
import { uploadBody } from './Receipts.jsx';

const STATUS = {
  current: <span className="badge">IN PROGRESS</span>,
  to_file: <span className="badge warn">TO FILE</span>,
  overdue: <span className="badge fail">OVERDUE</span>,
  filed: <span className="badge warn">FILED, AWAITING</span>,
  settled: <span className="badge pass">SETTLED</span>,
};
const KEY_LINES = new Set(['101', '103', '106', '109', '114', '115']);
// Lines CRA's online return works out itself; shown so the figures can be checked.
const CRA_CALCS = new Set(['105', '108', '109', '112', '113A', '113B', '113C', '114', '115']);
const GROUPS = [
  ['taxable', 'GST charged: input tax credits'],
  ['zero_rated', 'Zero-rated (0%): seed, fertilizer, chemical, feed, livestock'],
  ['exempt', 'No GST charged: insurance, interest, wages, taxes, licences, rent'],
];

/** Quarters (or months, or the year) around today, newest first, for the picker. */
function periodsAround(frequency, today) {
  const len = frequency === 'monthly' ? 1 : frequency === 'annual' ? 12 : 3;
  const y = Number(today.slice(0, 4));
  const out = [];
  for (let yy = y; yy >= y - 2; yy--) {
    for (let m = 12 - len + 1; m >= 1; m -= len) {
      const start = `${yy}-${String(m).padStart(2, '0')}-01`;
      if (start > today) continue;
      out.push({ start, label: len === 12 ? `${yy}` : len === 3 ? `Q${(m + 2) / 3} ${yy}` : start.slice(0, 7) });
    }
  }
  return out;
}

export default function GstReturn() {
  const [params, setParams] = useSearchParams();
  const [frequency, setFrequency] = useState('quarterly');
  const today = localToday();
  const options = useMemo(() => periodsAround(frequency, today), [frequency, today]);
  const start = params.get('period') || options[0]?.start;
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => { fetch(`/api/tax/gst?year=${today.slice(0, 4)}`).then((x) => x.json()).then((g) => g.frequency && setFrequency(g.frequency)).catch(() => {}); }, []);
  const load = () => start && fetch(`/api/tax/gst/return?period_start=${start}`).then(async (x) => {
    const d = await x.json();
    if (!x.ok) throw new Error(d.error || `HTTP ${x.status}`);
    setR(d); setErr(null);
  }).catch((e) => setErr(e.message));
  useEffect(() => { setR(null); load(); }, [start]);

  const send = async (method, url, body) => {
    setErr(null);
    const x = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await x.json().catch(() => ({}));
    if (!x.ok) { setErr(d.error || `HTTP ${x.status}`); return null; }
    await load();
    return d;
  };

  // Upload a receipt for one entry: read, attached, its GST and the supplier's GST number taken from it.
  const fileRef = useRef(null);
  const [uploadFor, setUploadFor] = useState(null);
  const upload = async (file) => {
    const id = uploadFor;
    setUploadFor(null);
    if (!file || !id) return;
    setBusy(`up:${id}`);
    try {
      const { body, type } = await uploadBody(file);
      const x = await fetch(`/api/receipts/upload?transaction_id=${id}`, { method: 'POST', headers: { 'Content-Type': type }, body });
      if (!x.ok) { const b = await x.json().catch(() => ({})); setErr(b.error || `Couldn't attach it (HTTP ${x.status}).`); }
    } catch { setErr(`Couldn't open ${file.name}: photos and PDFs only.`); }
    if (fileRef.current) fileRef.current.value = '';
    setBusy(null);
    load();
  };
  const pickFile = (id) => { setUploadFor(id); setTimeout(() => fileRef.current?.click(), 0); };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">GST return</h1>
        <div className="gst-head-controls">
          <select value={start || ''} onChange={(e) => setParams({ period: e.target.value })} aria-label="Reporting period">
            {options.map((o) => <option key={o.start} value={o.start}>{o.label}</option>)}
          </select>
          <Link to="/tax" className="small-link">All periods on Tax</Link>
        </div>
      </div>
      {err && <div className="notice" style={{ borderColor: 'var(--negative)', color: 'var(--negative)' }}>{err}</div>}
      <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={(e) => upload(e.target.files?.[0])} />
      {!r ? <div className="panel"><p>Working out the return…</p></div> : (
        <>
          <Summary r={r} send={send} />
          <ToFix r={r} send={send} pickFile={pickFile} busy={busy} />
          <Lines r={r} />
          <Purchases r={r} send={send} pickFile={pickFile} busy={busy} />
          <Sales r={r} />
          {r.carried.length > 0 && <Carried r={r} />}
          <Filing r={r} send={send} />
        </>
      )}
    </>
  );
}

function Summary({ r }) {
  const l = r.lines;
  const refund = l[114] > 0;
  return (
    <div className="grid">
      <div className="metric-card">
        <div className="metric-label">{r.period.label} · due {r.period.due}</div>
        <div className={`metric-value${refund ? ' positive' : l[115] > 0 ? ' negative' : ''}`}>{refund ? `${cents(l[114])} back` : l[115] > 0 ? `${cents(l[115])} owing` : cents(0)}</div>
        <div className="metric-sub">{STATUS[r.period.status]} {r.period.start} to {r.period.end}</div>
      </div>
      <div className="metric-card">
        <div className="metric-label">Input tax credits (106)</div>
        <div className="metric-value">{cents(l[106])}</div>
        <div className="metric-sub">{r.totals.by_treatment.taxable.count} purchases with GST{r.totals.carried_itc ? ` · ${cents(r.totals.carried_itc)} from earlier periods` : ''}</div>
      </div>
      <div className="metric-card">
        <div className="metric-label">GST collected (103)</div>
        <div className="metric-value">{cents(l[103])}</div>
        <div className="metric-sub">on {money(l[101])} of farm sales and revenue (101)</div>
      </div>
      <div className="metric-card">
        <div className="metric-label">{r.ready ? 'Ready to file' : 'To fix first'}</div>
        <div className={`metric-value${r.ready ? ' positive' : ' negative'}`}>{r.ready ? '✓' : r.flags.open + r.flags.unpaid_invoices.length}</div>
        <div className="metric-sub">
          {r.flags.gst_missing.count ? `Up to ${cents(r.flags.gst_missing.itc_up_to)} more GST back once receipts are in` : r.ready ? 'Every credit has its receipt' : 'See below'}
        </div>
      </div>
    </div>
  );
}

function ToFix({ r, send, pickFile, busy }) {
  const items = r.expenses.filter((e) => e.flags.length);
  const [gst, setGst] = useState({});
  const [gstNo, setGstNo] = useState({});
  if (!items.length && !r.flags.unpaid_invoices.length) return null;
  const order = { no_receipt_gst_unknown: 0, no_receipt: 1, gst_not_recorded: 2, no_gst_number: 3, check_treatment: 4 };
  items.sort((a, b) => Math.min(...a.flags.map((f) => order[f])) - Math.min(...b.flags.map((f) => order[f])) || a.farm_amount - b.farm_amount);
  return (
    <div className="panel">
      <div className="panel-header">To fix before filing · {items.length + r.flags.unpaid_invoices.length}</div>
      <p>
        A credit needs the receipt: under $100 the supplier, date and total; from $100 also the supplier's GST number and
        the GST; from $500 also your name, the terms and what was bought. Upload one and it's read: its GST and the
        supplier's number come off it.
      </p>
      <table>
        <thead><tr><th>Date</th><th>Supplier</th><th>Farm amount</th><th>What's wrong</th><th></th></tr></thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.transaction_id}>
              <td>{e.date}</td>
              <td>{e.payee || e.description || '—'}<div className="split-lines">{e.category || 'No category'}{e.paid_from ? ` · ${e.paid_from}` : ''}</div></td>
              <td>{cents(-e.farm_amount)}{e.farm_share < 100 && <div className="split-lines">{e.farm_share}% of {cents(Math.abs(e.tx_amount))}</div>}</td>
              <td>
                {e.flags.map((f) => <div key={f} className="gst-flag">{r.flag_text[f]}</div>)}
                {e.itc_up_to > 0 && <div className="split-lines">Up to {cents(e.itc_up_to)} back</div>}
                {e.itc > 0 && <div className="split-lines">Claiming {cents(e.itc)}</div>}
              </td>
              <td className="gst-actions">
                {(e.flags.includes('no_receipt') || e.flags.includes('no_receipt_gst_unknown')) && (
                  <button className="small" disabled={busy === `up:${e.transaction_id}`} onClick={() => pickFile(e.transaction_id)}>{busy === `up:${e.transaction_id}` ? 'Reading…' : 'Upload receipt'}</button>
                )}
                {(e.flags.includes('gst_not_recorded') || e.flags.includes('no_receipt_gst_unknown')) && (
                  <span className="gst-inline">
                    <input type="number" step="0.01" min="0" placeholder="GST" aria-label="GST on the receipt" value={gst[e.transaction_id] ?? ''}
                      onChange={(ev) => setGst({ ...gst, [e.transaction_id]: ev.target.value })} />
                    <button className="small secondary" disabled={gst[e.transaction_id] === undefined || gst[e.transaction_id] === ''}
                      onClick={() => send('PUT', `/api/tax/gst/entry/${e.transaction_id}`, { gst_amount: Number(gst[e.transaction_id]) })}>Save GST</button>
                  </span>
                )}
                {e.flags.includes('no_gst_number') && e.payee_id && (
                  <span className="gst-inline">
                    <input placeholder="123456789 RT0001" aria-label="Supplier GST number" value={gstNo[e.payee_id] ?? ''}
                      onChange={(ev) => setGstNo({ ...gstNo, [e.payee_id]: ev.target.value })} />
                    <button className="small secondary" disabled={!gstNo[e.payee_id]}
                      onClick={() => send('PUT', `/api/tax/gst/payee/${e.payee_id}`, { gst_number: gstNo[e.payee_id] })}>Save number</button>
                  </span>
                )}
                {e.receipt && <a className="small-link" href={`/api/receipts/${e.receipt.id}/image`} target="_blank" rel="noreferrer">View receipt</a>}
                <TreatmentPick e={e} r={r} send={send} compact />
              </td>
            </tr>
          ))}
          {r.flags.unpaid_invoices.map((d) => (
            <tr key={`inv${d.id}`}>
              <td>{d.date}</td><td>{d.party}<div className="split-lines">Your invoice {d.number}</div></td><td>{cents(d.total)}</td>
              <td><div className="gst-flag">Not paid yet: its {cents(d.gst)} GST is owed in the period it was invoiced. Add it to line 103 if you file before it's paid.</div></td>
              <td><Link className="small-link" to="/invoices">Invoices</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How GST applies to an entry, or to its category for good. */
function TreatmentPick({ e, r, send, compact }) {
  if (e.treatment_source === 'gst') return null; // GST is on it: that settles it
  const cat = e.categories.length === 1 ? e.categories[0] : null;
  const value = e.treatment_source === 'entry' ? e.treatment : '';
  return (
    <span className="gst-inline">
      <select aria-label="How GST applies" value={value}
        onChange={(ev) => send('PUT', `/api/tax/gst/entry/${e.transaction_id}`, { treatment: ev.target.value || null })}>
        <option value="">{compact ? 'GST applies…' : `${r.treatments[e.treatment]}${e.treatment_source === 'guess' ? ' (guessed)' : e.treatment_source === 'category' ? ' (category)' : ''}`}</option>
        {Object.entries(r.treatments).map(([k, v]) => <option key={k} value={k}>{v}: this one</option>)}
      </select>
      {cat && (e.treatment_source === 'guess' || e.treatment_source === 'usual') && !compact && (
        <button className="small-link" title={`Use this for everything in ${cat.name}`}
          onClick={() => send('PUT', `/api/tax/gst/category/${cat.id}`, { treatment: e.treatment })}>Confirm for {cat.name}</button>
      )}
    </span>
  );
}

function Lines({ r }) {
  const [copied, setCopied] = useState(null);
  const copy = (k, v) => { navigator.clipboard?.writeText(String(v)).then(() => { setCopied(k); setTimeout(() => setCopied(null), 1200); }).catch(() => {}); };
  const shown = r.line_labels.filter(([k]) => !['112', '113A', '113B', '205', '405'].includes(String(k)) || r.lines[k]);
  return (
    <div className="panel">
      <div className="panel-header spend-header">
        <span>The return, line by line (GST34, regular method)</span>
        <a className="small-link" href={`/api/tax/gst/return.csv?period_start=${r.period.start}`}>Working papers (CSV)</a>
      </div>
      <p>
        {r.business_number ? <>GST account <strong>{r.business_number}</strong>. </> : <><BusinessNumber /> </>}
        For CRA's online return (My Business Account or GST/HST NETFILE). Lines 90 and 91 are asked only if you choose to
        split your sales; otherwise enter line 101. CRA works out 105, 108, 109 and 114/115 from what you enter; they're
        here to check against.
      </p>
      <table className="gst-lines">
        <tbody>
          {shown.map(([k, label]) => (
            <tr key={k} className={KEY_LINES.has(String(k)) ? 'key' : ''}>
              <td className="gst-line-no">{k}</td>
              <td>{label}{CRA_CALCS.has(String(k)) && <span className="split-lines"> · CRA calculates</span>}</td>
              <td className="gst-line-val">{String(k) === '101' || String(k) === '90' || String(k) === '91' ? money(r.lines[k]) : cents(r.lines[k])}</td>
              <td><button className="small secondary" onClick={() => copy(k, r.lines[k])}>{copied === k ? 'Copied' : 'Copy'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BusinessNumber() {
  const [v, setV] = useState('');
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(null);
  if (!open) return <button className="small-link" onClick={() => setOpen(true)}>Add the farm's GST account number</button>;
  return (
    <span className="gst-inline">
      <input placeholder="123456789 RT0001" value={v} onChange={(e) => setV(e.target.value)} aria-label="GST account number" />
      <button className="small" onClick={async () => {
        const x = await fetch('/api/tax/gst/business-number', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ business_number: v }) });
        const d = await x.json().catch(() => ({}));
        if (!x.ok) setMsg(d.error || 'Not saved'); else window.location.reload();
      }}>Save</button>
      {msg && <span className="split-lines" style={{ color: 'var(--negative)' }}>{msg}</span>}
    </span>
  );
}

function Purchases({ r, send, pickFile, busy }) {
  const [open, setOpen] = useState({ taxable: true });
  return (
    <div className="panel">
      <div className="panel-header">Farm purchases · {r.totals.purchases} · {cents(r.totals.farm_spend)}</div>
      <p>
        The farm's share of everything bought in the period (Grain and Cattle; a split entry counts at its farm %), capital
        purchases included. GST recorded on an entry settles it; otherwise how GST applies comes from your choice on the
        entry, then on its category, then a guess from the category's name. Confirm a guess once and it holds for the category.
        Meals and entertainment get half the GST back.
      </p>
      {GROUPS.map(([t, title]) => {
        const list = r.expenses.filter((e) => e.treatment === t);
        const s = r.totals.by_treatment[t];
        return (
          <div key={t} className="gst-group">
            <button className="gst-group-head" onClick={() => setOpen({ ...open, [t]: !open[t] })} aria-expanded={!!open[t]}>
              <span>{open[t] ? '▾' : '▸'} {title}</span>
              <span className="split-lines">{s.count} · {cents(s.farm_amount)}{t === 'taxable' ? ` · ${cents(s.itc)} back` : ''}</span>
            </button>
            {open[t] && list.length > 0 && (
              <table>
                <thead><tr><th>Date</th><th>Supplier</th><th>Category</th><th>Farm amount</th><th>GST</th><th>Credit</th><th>Receipt</th><th>GST applies</th></tr></thead>
                <tbody>
                  {list.map((e) => (
                    <tr key={e.transaction_id} className={e.flags.length ? 'gst-flagged' : ''}>
                      <td>{e.date}</td>
                      <td>{e.payee || e.description || '—'}{e.capital && <div className="split-lines">Capital purchase</div>}</td>
                      <td>{e.category || <span className="split-lines">None</span>}</td>
                      <td>{cents(-e.farm_amount)}{e.farm_share < 100 && <div className="split-lines">{e.farm_share}% farm</div>}</td>
                      <td>{e.gst_recorded == null ? <span className="split-lines">{t === 'taxable' ? 'not recorded' : '—'}</span> : cents(e.gst_recorded)}</td>
                      <td>{e.itc ? cents(e.itc) : '—'}{e.half_itc && <div className="split-lines">half (meals)</div>}</td>
                      <td>
                        {e.receipt ? <a className="small-link" href={`/api/receipts/${e.receipt.id}/image`} target="_blank" rel="noreferrer">✓ View</a>
                          : e.farm_document ? <span className="split-lines">Your {e.farm_document.kind.replace('_', ' ')} {e.farm_document.number || ''}</span>
                          : t === 'taxable' ? <button className="small secondary" disabled={busy === `up:${e.transaction_id}`} onClick={() => pickFile(e.transaction_id)}>Upload</button>
                          : <span className="split-lines">not needed for GST</span>}
                        {e.receipt?.gst_number && <div className="split-lines">GST no. {e.receipt.gst_number}</div>}
                      </td>
                      <td><TreatmentPick e={e} r={r} send={send} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Sales({ r }) {
  if (!r.sales.length) return null;
  return (
    <div className="panel">
      <div className="panel-header">Farm sales and revenue · {r.sales.length} · {money(r.lines[101])}</div>
      <p>Grain and cattle are zero-rated (no GST). Custom work and other services carry GST, collected on line 103. Program payments, insurance proceeds and rebates are other revenue (line 91).</p>
      <table>
        <thead><tr><th>Date</th><th>From</th><th>Category</th><th>Line</th><th>Revenue</th><th>GST collected</th></tr></thead>
        <tbody>
          {r.sales.map((s) => (
            <tr key={s.transaction_id}>
              <td>{s.date}</td><td>{s.payee || s.description || '—'}</td><td>{s.category || '—'}</td><td>{s.line}</td>
              <td>{cents(s.revenue)}</td><td>{s.gst_collected ? cents(s.gst_collected) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Carried({ r }) {
  return (
    <div className="panel">
      <div className="panel-header">From periods already filed · {cents(r.totals.carried_itc)}</div>
      <p>Credits that changed after their return was filed: a receipt read later is claimed here (line 106, allowed for four years); a credit that no longer stands goes back on line 104.</p>
      <table>
        <thead><tr><th>Period</th><th>Date</th><th>Supplier</th><th>Change</th></tr></thead>
        <tbody>{r.carried.map((c) => <tr key={`${c.period}:${c.transaction_id}`}><td>{c.period}</td><td>{c.date || '—'}</td><td>{c.payee || c.description || '—'}</td><td>{c.itc > 0 ? `+${cents(c.itc)} (106)` : `${cents(c.itc)} (104)`}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function Filing({ r, send }) {
  const [form, setForm] = useState(null);
  if (r.period.status === 'current') return null;
  return (
    <div className="panel">
      <div className="panel-header">Filing</div>
      {r.filed ? (
        <p>
          Filed {r.filed.filed_on}: {r.filed.net_amount < 0 ? `${cents(-r.filed.net_amount)} refund` : `${cents(r.filed.net_amount)} owing`}.
          {r.filed.lines && Math.abs(r.filed.lines[109] - r.lines[109]) >= 0.01 && <> Since then it works out to {cents(r.lines[109])}: the difference goes on the next return.</>}
          {' '}When the refund or payment shows in the bank, link it on <Link to="/tax">Tax</Link>.
        </p>
      ) : form ? (
        <div className="gst-inline" style={{ padding: '10px 16px 14px' }}>
          <input type="date" value={form.filed_on} onChange={(e) => setForm({ ...form, filed_on: e.target.value })} aria-label="Filed on" />
          <input type="number" step="0.01" value={form.net_amount} onChange={(e) => setForm({ ...form, net_amount: e.target.value })} aria-label="Net as filed (negative = refund)" />
          <button className="small" onClick={async () => { if (await send('POST', '/api/tax/gst/file', { period_start: r.period.start, ...form, net_amount: Number(form.net_amount) })) setForm(null); }}>Save</button>
          <button className="small secondary" onClick={() => setForm(null)}>Cancel</button>
          <span className="split-lines">Net as filed: negative is a refund. What it claimed is kept, so a receipt added later is claimed on the next return.</span>
        </div>
      ) : (
        <div style={{ padding: '10px 16px 14px' }}>
          <button className="small" onClick={() => setForm({ filed_on: localToday(), net_amount: String(r.lines[109]) })}>Mark filed</button>
          {!r.ready && <span className="split-lines"> {r.flags.open} still flagged above.</span>}
        </div>
      )}
    </div>
  );
}
