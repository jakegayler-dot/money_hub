import { useEffect, useState } from 'react';
import { cents } from './SplitEditor.jsx';

// Money with CRA: GST/HST refunds and payments, income tax refunds and
// instalments. Marked, they're transfers — never farm income or spending.
// Lines that look like CRA but aren't marked are offered here, including
// ones filed under a category (a GST refund booked as a program payment).
export const TAX_KIND_LABELS = {
  gst_refund: 'GST/HST refund',
  gst_payment: 'GST/HST payment',
  income_tax_refund: 'Income tax refund',
  income_tax_payment: 'Income tax instalment or payment',
};
export const kindsFor = (amount) => (Number(amount) > 0 ? ['gst_refund', 'income_tax_refund'] : ['gst_payment', 'income_tax_payment']);

/** Marks one transaction (shared with Ledgers and Review). Returns an error message or null. */
export async function markTax(id, kind, interest) {
  const r = await fetch(`/api/transactions/${id}/tax`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, interest: kind === 'income_tax_refund' && Number(interest) > 0 ? Number(interest) : 0 }),
  });
  if (r.ok) return null;
  const b = await r.json().catch(() => ({}));
  return b.error || `HTTP ${r.status}`;
}

function Suggestion({ t, onDone, setErr }) {
  const [kind, setKind] = useState(t.kind);
  const [interest, setInterest] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <tr>
      <td className="nowrap">{t.date}</td>
      <td>
        {t.description}{!t.sure && <span className="tag" title="A government line with no tax words: check it's CRA">check</span>}
        <div className="split-lines">
          {t.account_name}
          {t.category_name ? ` · counting as ${t.category_name}` : t.is_transfer ? ' · a transfer' : ' · no category'}
        </div>
      </td>
      <td className="num nowrap">{cents(t.amount)}</td>
      <td>
        <select aria-label={`What ${t.description} is`} value={kind} onChange={(e) => setKind(e.target.value)}>
          {kindsFor(t.amount).map((k) => <option key={k} value={k}>{TAX_KIND_LABELS[k]}</option>)}
        </select>
        {kind === 'income_tax_refund' && (
          <input className="cra-interest" type="number" min="0" step="0.01" placeholder="Interest in it" aria-label="Refund interest included"
            value={interest} onChange={(e) => setInterest(e.target.value)} />
        )}
      </td>
      <td className="nowrap">
        <button type="button" className="small" disabled={busy} onClick={async () => {
          setBusy(true); setErr(null);
          const e = await markTax(t.id, kind, interest);
          setBusy(false);
          if (e) setErr(e); else onDone();
        }}>Mark</button>
        <a className="small-link cra-open" href={`/ledgers?edit=${t.id}`}>Open</a>
      </td>
    </tr>
  );
}

export default function CraMoney({ year, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => fetch(`/api/tax/cra?year=${year}`).then((r) => r.json()).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = () => { load(); onChanged?.(); };
  if (!d) return null;
  const refunds = d.totals.gst_refund + d.totals.income_tax_refund;
  const paid = -(d.totals.gst_payment + d.totals.income_tax_payment);

  return (
    <div className="panel cra-money">
      <div className="panel-header">Money with CRA</div>
      <p>
        GST and income tax refunds, and GST and income tax payments, are your own money moving, not income or spending.
        Marked here, they stay out of the farm's income, the tax estimate and Income &amp; Expenses. Interest CRA pays on a
        late refund is taxable: enter it and it's booked as interest income. Linking a GST one to its quarters below is optional.
      </p>
      {err && <p className="review-error" style={{ margin: '0 16px 10px' }}>{err}</p>}

      {d.suggestions.length > 0 && (
        <>
          <div className="cra-sub">
            Looks like CRA, not marked yet ({d.suggestions.length})
            <span className="split-lines"> — until marked, money in counts as income and money out as spending.</span>
          </div>
          <div className="table-scroll">
            <table className="cra-table">
              <thead><tr><th>Date</th><th>Line</th><th className="num">Amount</th><th>What it is</th><th /></tr></thead>
              <tbody>{d.suggestions.map((t) => <Suggestion key={t.id} t={t} onDone={done} setErr={setErr} />)}</tbody>
            </table>
          </div>
        </>
      )}

      <div className="cra-sub">
        Marked in {year}
        {d.marked.length > 0 && (
          <span className="split-lines"> — {[refunds > 0.005 && `${cents(refunds)} back from CRA`, paid > 0.005 && `${cents(paid)} paid to CRA`].filter(Boolean).join(', ')}</span>
        )}
      </div>
      {d.marked.length === 0 ? (
        <p>Nothing marked in {year}. Mark a line above, or from any transaction in Ledgers.</p>
      ) : (
        <div className="table-scroll">
          <table className="cra-table">
            <thead><tr><th>Date</th><th>Line</th><th className="num">Amount</th><th>What it is</th><th /></tr></thead>
            <tbody>
              {d.marked.map((t) => (
                <tr key={t.id}>
                  <td className="nowrap">{t.date}</td>
                  <td>{t.description}<div className="split-lines">{t.account_name}{t.quarters ? ` · settles GST ${t.quarters}` : ''}</div></td>
                  <td className="num nowrap">{cents(t.amount)}</td>
                  <td>
                    {TAX_KIND_LABELS[t.tax_kind]}
                    {t.interest > 0 && <div className="split-lines">incl. {cents(t.interest)} interest (taxable)</div>}
                  </td>
                  <td className="nowrap">
                    <button type="button" className="small-link" onClick={async () => {
                      setErr(null);
                      const r = await fetch(`/api/transactions/${t.id}/tax`, { method: 'DELETE' });
                      if (!r.ok) { const b = await r.json().catch(() => ({})); setErr(b.error || `HTTP ${r.status}`); return; }
                      done();
                      window.dispatchEvent(new Event('review-changed'));
                    }}>Undo</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
