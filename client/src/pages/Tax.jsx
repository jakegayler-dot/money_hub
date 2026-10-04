import { useEffect, useState } from 'react';
import { money } from '../format.js';
import { cents } from '../components/SplitEditor.jsx';

const STATUS = {
  current: <span className="badge">IN PROGRESS</span>,
  to_file: <span className="badge warn">TO FILE</span>,
  overdue: <span className="badge fail">OVERDUE</span>,
  filed: <span className="badge warn">FILED — AWAITING</span>,
  settled: <span className="badge pass">SETTLED</span>,
};
const today = () => new Date().toISOString().slice(0, 10);
const net = (n) => (n < 0 ? `${cents(-n)} refund` : n > 0 ? `${cents(n)} owing` : cents(0));

export default function Tax() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [gst, setGst] = useState(null);
  const [inc, setInc] = useState(null);
  const [whatIf, setWhatIf] = useState({ defer_sales: '', prepay_inputs: '', oia: '' });
  const [err, setErr] = useState(null);

  const loadGst = () => fetch(`/api/tax/gst?year=${year}`).then((r) => r.json()).then(setGst).catch((e) => setErr(e.message));
  const loadInc = (w = whatIf) => {
    const q = new URLSearchParams({ year });
    for (const [k, v] of Object.entries(w)) if (Number(v) > 0) q.set(k, v);
    return fetch(`/api/tax/income?${q}`).then((r) => r.json()).then(setInc).catch((e) => setErr(e.message));
  };
  useEffect(() => { loadGst(); loadInc(); }, [year]);

  const send = async (method, url, body) => {
    setErr(null);
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(d.error || `HTTP ${r.status}`); return null; }
    return d;
  };

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Tax</h1>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
          {[0, 1, 2].map((i) => { const y = new Date().getFullYear() - i; return <option key={y} value={y}>{y}</option>; })}
        </select>
      </div>
      {err && <div className="notice" style={{ borderColor: 'var(--negative)', color: 'var(--negative)' }}>{err}</div>}

      {inc && <IncomeTax inc={inc} year={year} whatIf={whatIf} setWhatIf={setWhatIf} reload={loadInc} send={send} />}
      {gst && <Gst gst={gst} reload={loadGst} send={send} />}
    </>
  );
}

function IncomeTax({ inc, year, whatIf, setWhatIf, reload, send }) {
  const [cca, setCca] = useState(inc.cca.override ?? '');
  const [prior, setPrior] = useState(inc.instalment.prior_year_owing ?? '');
  const p = inc.projected;
  const s = inc.scenario;
  const ins = inc.instalment;
  const save = async (body) => { if (await send('PUT', '/api/tax/income/settings', { year, ...body })) reload(); };

  return (
    <>
      <div className="grid">
        <div className="metric-card">
          <div className="metric-label">Farm net income — to date</div>
          <div className="metric-value">{money(inc.actual.net_income)}</div>
          <div className="metric-sub">Jan 1 – {inc.as_of}, before CCA</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Projected for {year}</div>
          <div className="metric-value">{money(p.net_income)}</div>
          <div className="metric-sub">After forecast to Dec 31 and {money(p.cca)} CCA</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Estimated tax + CPP</div>
          <div className="metric-value negative">{money(p.tax.total)}</div>
          <div className="metric-sub">{p.tax.average_rate}% average · {p.tax.marginal_income_tax_rate}% marginal income tax</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Instalment due {ins.due}</div>
          <div className={`metric-value${ins.amount && !ins.paid ? ' negative' : ''}`}>{ins.paid ? 'Paid' : money(ins.amount)}</div>
          <div className="metric-sub">{ins.required ? (s ? 'Uses the what-if below' : 'Two-thirds of the estimate') : 'Not required — tax under $3,000'}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">Income tax estimate — farm income only</div>
        <p>
          The farm's net income on the cash method — Grain and Cattle's share of every transaction, GST taken out —
          taxed as your personal income at {p.tax.rates_year} federal and Saskatchewan rates, with CPP on self-employment.
          {!p.tax.rates_current && <strong> {year} rates aren't loaded yet, so {p.tax.rates_year} rates are used.</strong>}
          {' '}Other income, credits and deductions aren't included.
        </p>
        <table>
          <thead><tr><th></th><th>To date</th><th>Forecast to Dec 31</th><th>Projected year</th>{s && <th>With what-if</th>}</tr></thead>
          <tbody>
            <tr><td>Revenue</td><td>{money(inc.actual.revenue)}</td><td>{money(inc.forecast.revenue)}</td><td>{money(p.revenue)}</td>{s && <td>{money(s.revenue)}</td>}</tr>
            <tr><td>Expenses incl. interest</td><td>−{money(inc.actual.expenses)}</td><td>−{money(inc.forecast.expenses)}</td><td>−{money(p.expenses)}</td>{s && <td>−{money(s.expenses)}</td>}</tr>
            <tr><td>CCA {inc.cca.override == null ? '(estimate)' : '(your figure)'}</td><td></td><td></td><td>−{money(p.cca)}</td>{s && <td>−{money(s.cca)}</td>}</tr>
            {s && s.oia > 0 && <tr><td>Optional inventory adjustment</td><td></td><td></td><td>—</td><td>+{money(s.oia)}</td></tr>}
            <tr><td><strong>Net farm income</strong></td><td>{money(inc.actual.net_income)}</td><td></td><td><strong>{money(p.net_income)}</strong></td>{s && <td><strong>{money(s.net_income)}</strong></td>}</tr>
            <tr><td>CPP (both halves)</td><td></td><td></td><td>{money(p.tax.cpp)}</td>{s && <td>{money(s.tax.cpp)}</td>}</tr>
            <tr><td>Federal tax</td><td></td><td></td><td>{money(p.tax.federal)}</td>{s && <td>{money(s.tax.federal)}</td>}</tr>
            <tr><td>Saskatchewan tax</td><td></td><td></td><td>{money(p.tax.sk)}</td>{s && <td>{money(s.tax.sk)}</td>}</tr>
            <tr><td><strong>Total</strong></td><td></td><td></td><td><strong>{money(p.tax.total)}</strong></td>{s && <td><strong>{money(s.tax.total)}</strong> <span className="split-lines">{s.tax.total <= p.tax.total ? `saves ${money(p.tax.total - s.tax.total)}` : `costs ${money(s.tax.total - p.tax.total)} more`}</span></td>}</tr>
          </tbody>
        </table>
        {inc.forecast.items.length > 0 && (
          <p className="split-lines" style={{ margin: '8px 16px 12px' }}>
            Forecast: {inc.forecast.items.map((i) => `${i.label} ${i.amount < 0 ? '−' : '+'}${money(Math.abs(i.amount))}`).join(' · ')}.
            {' '}Capital purchases this year ({money(inc.actual.capex)}) aren't expenses — they come off through CCA.
          </p>
        )}
        {inc.gst_gap && (
          <p className="split-lines" style={{ margin: '0 16px 12px' }}>
            {inc.gst_gap.purchases} farm purchase{inc.gst_gap.purchases === 1 ? '' : 's'} ({money(inc.gst_gap.amount)}) {inc.gst_gap.purchases === 1 ? 'has' : 'have'} no GST recorded,
            so {inc.gst_gap.purchases === 1 ? 'it counts' : 'they count'} in full as expense. Zero-rated inputs (fertilizer, seed, chemical, feed) are right as they are;
            for the rest, the GST paid is in expenses while its refund is a transfer — net income is understated by up to {money(inc.gst_gap.up_to)}.
          </p>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">Year-end what-ifs</div>
        <p>
          Cash-method moves before Dec 31. <strong>Defer a sale</strong>: grain delivered now but paid in January (a deferred
          cash ticket) moves that income to next year. <strong>Prepay inputs</strong>: next season's fertilizer, seed or chemical
          paid this year is deductible this year. <strong>Optional inventory adjustment</strong>: adds up to the value of
          inventory on hand back into income — used in a low year so income isn't wasted below the basic personal amount; it
          comes back off next year.
        </p>
        <form className="form-panel" onSubmit={(e) => { e.preventDefault(); reload(whatIf); }}>
          <div className="field"><label>Defer sales to January ($)</label>
            <input type="number" min="0" step="100" value={whatIf.defer_sales} onChange={(e) => setWhatIf({ ...whatIf, defer_sales: e.target.value })} /></div>
          <div className="field"><label>Prepay inputs before Dec 31 ($)</label>
            <input type="number" min="0" step="100" value={whatIf.prepay_inputs} onChange={(e) => setWhatIf({ ...whatIf, prepay_inputs: e.target.value })} /></div>
          <div className="field"><label>Optional inventory adjustment ($)</label>
            <input type="number" min="0" step="100" value={whatIf.oia} onChange={(e) => setWhatIf({ ...whatIf, oia: e.target.value })} /></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit">Run what-if</button>
            {s && <button type="button" className="secondary" onClick={() => { const z = { defer_sales: '', prepay_inputs: '', oia: '' }; setWhatIf(z); reload(z); }}>Clear</button>}
          </div>
        </form>
      </div>

      <div className="panel">
        <div className="panel-header">Inputs for {year}</div>
        <form className="form-panel" onSubmit={(e) => { e.preventDefault(); save({ cca: cca === '' ? null : Number(cca), prior_year_owing: prior === '' ? null : Number(prior) }); }}>
          <div className="field"><label>CCA claim (your accountant's figure)</label>
            <input type="number" min="0" step="0.01" placeholder={`Estimate: ${Math.round(inc.cca.estimate)}`} value={cca} onChange={(e) => setCca(e.target.value)} /></div>
          <div className="field"><label>Last year's net tax owing</label>
            <input type="number" min="0" step="0.01" placeholder="From last year's assessment" value={prior} onChange={(e) => setPrior(e.target.value)} /></div>
          <div style={{ display: 'flex', gap: 8 }}><button type="submit">Save</button></div>
          <p className="split-lines" style={{ margin: 0 }}>
            The CCA estimate is each depreciating farm asset on the Assets tab at its Jan 1 value × its rate — book value, not
            CRA's undepreciated capital cost. Replace it with the real claim when you have it. With last year's tax entered, the
            instalment is the lesser of two-thirds of this year's estimate ({money(ins.estimate_method)}) and two-thirds of last
            year's{ins.prior_year_method != null ? ` (${money(ins.prior_year_method)})` : ''}.
          </p>
        </form>
        <div className="review-actions" style={{ padding: '0 16px 14px' }}>
          {ins.paid ? (
            <>
              <span className="badge pass">INSTALMENT PAID{ins.paid.date ? ` ${ins.paid.date}` : ''}</span>
              <button className="small secondary" onClick={async () => { if (await send('PUT', '/api/tax/income/instalment', { year, paid: false })) reload(); }}>Undo</button>
            </>
          ) : ins.amount > 0 && (
            <button className="small" onClick={async () => { if (await send('PUT', '/api/tax/income/instalment', { year, paid: true, date: today(), amount: ins.amount })) reload(); }}>
              Mark Dec 31 instalment paid
            </button>
          )}
          <span className="split-lines">Until it's marked paid, the instalment sits in the cash-flow forecast (Combined and Jake) on Dec 31.</span>
        </div>
      </div>
    </>
  );
}

function Gst({ gst, reload, send }) {
  const [filing, setFiling] = useState(null);   // { start, filed_on, net_amount }
  const [linking, setLinking] = useState(null); // { start, candidates }
  const [unlinked, setUnlinked] = useState([]);
  useEffect(() => { fetch('/api/tax/gst/unlinked').then((r) => r.json()).then((d) => setUnlinked(Array.isArray(d) ? d : [])).catch(() => {}); }, [gst]);
  const totals = gst.periods.reduce((a, p) => ({ collected: a.collected + p.collected, itc: a.itc + p.itc, missing: a.missing + p.purchases_no_gst }), { collected: 0, itc: 0, missing: 0 });

  return (
    <div className="panel">
      <div className="panel-header spend-header">
        <span>GST — {gst.frequency} filer</span>
        <select value={gst.frequency} aria-label="Filing frequency"
          onChange={async (e) => { if (await send('PUT', '/api/tax/gst/frequency', { frequency: e.target.value })) reload(); }}>
          <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option>
        </select>
      </div>
      <p>
        Exact GST from receipts and invoices only. Input tax credits are the farm's share of GST paid; GST collected is
        on farm sales that carried it (grain and cattle don't). Net below zero is a refund. When it arrives, link the
        deposit so it isn't counted as income.
        {totals.missing > 0 && <strong> {totals.missing} farm purchase{totals.missing === 1 ? '' : 's'} this year {totals.missing === 1 ? 'has' : 'have'} no GST recorded — fine for zero-rated inputs (fertilizer, seed, chemical, feed); for anything else the credit is being missed.</strong>}
      </p>
      {unlinked.length > 0 && (
        <div className="gst-unlinked" role="status">
          <strong>{unlinked.length === 1 ? 'This looks' : 'These look'} like GST with CRA but {unlinked.length === 1 ? "isn't" : "aren't"} linked to a quarter</strong>
          {' '}— until {unlinked.length === 1 ? 'it is' : 'they are'}, {unlinked.length === 1 ? 'it counts' : 'they count'} as farm income or spending.
          Pick the year it was for above, mark that quarter filed, then link it. One deposit can settle several quarters.
          <ul>
            {unlinked.map((t) => (
              <li key={t.id}>{t.date} · <span className="nowrap">{cents(t.amount)}</span> · {t.account_name} · {t.description}{' '}
                <a className="small-link" href={`/ledgers?edit=${t.id}`}>Open</a></li>
            ))}
          </ul>
        </div>
      )}
      <table>
        <thead><tr><th>Period</th><th>GST collected</th><th>Input tax credits</th><th>Net</th><th>Due</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {gst.periods.map((p) => (
            <tr key={p.start}>
              <td>{p.label}<div className="split-lines">{p.start} → {p.end}</div></td>
              <td>{cents(p.collected)}</td>
              <td>
                {cents(p.itc)}
                {p.purchases_no_gst > 0 && <div className="split-lines">{p.purchases_no_gst} of {p.purchases} purchases ({money(p.purchases_no_gst_amount)}) with no GST recorded</div>}
              </td>
              <td>{net(p.net)}{p.filed_net != null && Math.abs(p.filed_net - p.net) >= 0.01 && <div className="split-lines">filed {net(p.filed_net)}</div>}</td>
              <td>{p.due}</td>
              <td>{STATUS[p.status]}{p.filed_on && <div className="split-lines">filed {p.filed_on}</div>}</td>
              <td>
                {filing?.start === p.start ? (
                  <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input type="date" value={filing.filed_on} onChange={(e) => setFiling({ ...filing, filed_on: e.target.value })} aria-label="Filed on" />
                    <input type="number" step="0.01" style={{ width: 110 }} value={filing.net_amount} onChange={(e) => setFiling({ ...filing, net_amount: e.target.value })} aria-label="Net as filed (negative = refund)" />
                    <button className="small" onClick={async () => { if (await send('POST', '/api/tax/gst/file', { period_start: p.start, filed_on: filing.filed_on, net_amount: Number(filing.net_amount) })) { setFiling(null); reload(); } }}>Save</button>
                    <button className="small secondary" onClick={() => setFiling(null)}>Cancel</button>
                  </span>
                ) : linking?.start === p.start ? (
                  <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    <select aria-label="Refund or payment transaction" value={linking.pick || ''} onChange={(e) => setLinking({ ...linking, pick: e.target.value })}>
                      <option value="">{linking.candidates.length ? 'Pick the deposit/payment' : 'Nothing found after the period'}</option>
                      {linking.candidates.map((c) => <option key={c.id} value={c.id}>{c.date} · {cents(c.amount)} · {c.account_name} · {c.description}{c.settles ? ` — also settles ${c.settles}` : ''}</option>)}
                    </select>
                    <button className="small" disabled={!linking.pick} onClick={async () => { if (await send('POST', '/api/tax/gst/settle', { period_start: p.start, transaction_id: Number(linking.pick) })) { setLinking(null); reload(); } }}>Link</button>
                    <button className="small secondary" onClick={() => setLinking(null)}>Cancel</button>
                  </span>
                ) : p.status === 'settled' ? (
                  <button className="small secondary" onClick={async () => { if (await send('POST', '/api/tax/gst/unsettle', { period_start: p.start })) reload(); }}>Unlink</button>
                ) : p.status === 'filed' ? (
                  <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                    <button className="small" onClick={async () => {
                      const c = await fetch(`/api/tax/gst/candidates?period_start=${p.start}`).then((r) => r.json());
                      setLinking({ start: p.start, candidates: Array.isArray(c) ? c : [] });
                    }}>Link {p.filed_net < 0 ? 'refund' : 'payment'}</button>
                    <button className="small secondary" onClick={async () => { if (await send('POST', '/api/tax/gst/unfile', { period_start: p.start })) reload(); }}>Unfile</button>
                  </span>
                ) : p.status !== 'current' && (
                  <button className="small secondary" onClick={() => setFiling({ start: p.start, filed_on: today(), net_amount: String(p.net) })}>Mark filed</button>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <td><strong>Year</strong></td><td>{cents(totals.collected)}</td><td>{cents(totals.itc)}</td>
            <td><strong>{net(Math.round((totals.collected - totals.itc) * 100) / 100)}</strong></td><td colSpan={3}></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
