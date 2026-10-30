import { Fragment, useEffect, useState } from 'react';
import { money } from '../format.js';

// Land rent (Jake, 2026-10-30: "a land rent tab... that shows all the rent payments, their cost per acre, their due
// dates etc"). Each landlord: the land from Quarter Section (fields, acres, $/acre by the lease), what the rent works
// out to an acre, what's due next, and every payment — paid, owing, and the yearly ones not billed yet (the cash
// forecast counts those too). server/lib/landRent.js.

const send = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d; });
const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const STATUS = { paid: ['Paid', 'pass'], owing: ['Owing', 'warn'], expected: ['Expected', ''] };
const KIND = { land: 'Land', pasture: 'Pasture', bales: 'Bales' };
const acresOf = (n) => `${Math.round(n * 10) / 10} ac`;

export default function LandRent() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { send('GET', '/api/land/rent').then(setD).catch((e) => setErr(e.message)); }, []);
  const link = async (payee, landlord) => {
    setBusy(true); setErr(null);
    try { setD(await send('PUT', '/api/land/alias', { payee, landlord })); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  if (!d) return <div className="page"><h1 className="page-title">Land rent</h1>{err ? <p className="review-error">{err}</p> : <p className="small secondary">Loading…</p>}</div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Land rent</h1>
        <span className="page-meta">
          {money(d.totals.next_12)} due in the next 12 months{d.totals.acres ? ` · ${acresOf(d.totals.acres)} cash-rented` : ''}
        </span>
      </div>
      {err && <p className="review-error">{err}</p>}

      {d.upcoming.length > 0 && (
        <div className="panel">
          <div className="panel-header">Coming up</div>
          <table>
            <thead><tr><th>Due</th><th>Landlord</th><th>For</th><th style={{ textAlign: 'right' }}>Amount</th><th /></tr></thead>
            <tbody>
              {d.upcoming.map((p, i) => (
                <tr key={i}>
                  <td className="nowrap">{day(p.date)}</td><td>{p.payee}</td><td>{KIND[p.kind]}</td>
                  <td style={{ textAlign: 'right' }}>{money(p.amount)}</td>
                  <td><span className={`badge ${STATUS[p.status][1]}`}>{STATUS[p.status][0]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <div className="panel-header">By landlord</div>
        <table>
          <thead><tr><th>Landlord</th><th style={{ textAlign: 'right' }}>Acres</th><th style={{ textAlign: 'right' }}>Per acre</th><th style={{ textAlign: 'right' }}>Last 12 months</th><th style={{ textAlign: 'right' }}>Next 12 months</th><th>Next due</th></tr></thead>
          <tbody>
            {d.landlords.map((l) => {
              const isOpen = !!open[l.payee];
              const leaseRates = [...new Set(l.fields.filter((f) => f.rent_per_acre).map((f) => f.rent_per_acre))];
              return (
                <Fragment key={l.payee}>
                  <tr className="sortable" onClick={() => setOpen((o) => ({ ...o, [l.payee]: !isOpen }))} style={{ cursor: 'pointer' }}>
                    <td>
                      <b>{l.payee}</b>
                      {l.landlord && l.landlord !== l.payee && <div className="small secondary">{l.landlord} in Quarter Section</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{l.acres ? acresOf(l.acres) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {l.per_acre != null ? money(l.per_acre) : '—'}
                      {leaseRates.length > 0 && <div className="small secondary">lease {leaseRates.map((r) => money(r)).join(' / ')}</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{money(l.last_12)}</td>
                    <td style={{ textAlign: 'right' }}>{money(l.next_12)}</td>
                    <td className="nowrap">{l.next ? `${day(l.next.date)} · ${money(l.next.amount)}` : '—'}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--surface-2, transparent)' }}>
                        {l.fields.length > 0 ? (
                          <p className="small">
                            {l.fields.map((f) => `${f.field} ${acresOf(f.acres)}${f.tenure === 'cropshare' ? ` (crop share ${f.crop_share_pct ?? '?'}%)` : f.rent_per_acre ? ` at ${money(f.rent_per_acre)}/ac` : ''}`).join(' · ')}
                            {l.by_lease ? ` — ${money(l.by_lease)} a year by the lease rates` : ''}
                          </p>
                        ) : <p className="small secondary">No Quarter Section land linked{l.landlord === null ? '' : ''}.</p>}
                        <label className="small" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                          Quarter Section landlord:
                          <select disabled={busy} value={l.landlord ?? ''} onClick={(e) => e.stopPropagation()} onChange={(e) => link(l.payee, e.target.value)}>
                            <option value="">None</option>
                            {d.qs_landlords.map((q) => <option key={q} value={q}>{q}</option>)}
                          </select>
                        </label>
                        <table>
                          <thead><tr><th>Date</th><th>Bill</th><th>For</th><th style={{ textAlign: 'right' }}>Amount</th><th /></tr></thead>
                          <tbody>
                            {l.payments.map((p, i) => (
                              <tr key={i}>
                                <td className="nowrap">{day(p.date)}</td><td>{p.name}</td><td>{KIND[p.kind]}</td>
                                <td style={{ textAlign: 'right' }}>{money(p.amount)}</td>
                                <td><span className={`badge ${STATUS[p.status][1]}`}>{STATUS[p.status][0]}</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        <p className="small secondary" style={{ padding: '8px 12px' }}>
          Per acre is the land rent for a year (the next 12 months, else the last 12) over the cash-rented acres in Quarter Section; pasture and bales are apart.
          "Expected" is a yearly rent not billed yet: last year's bill again on the same day, and Cash Flow counts it. Tap a landlord for the fields and every payment.
          {d.land_from ? '' : ' Quarter Section hasn’t sent its fields yet; acres show once it does (with its next crop-plan send).'}
        </p>
      </div>

      {d.unbilled.length > 0 && (
        <div className="panel">
          <div className="panel-header">Land with no rent bill</div>
          <table>
            <tbody>
              {d.unbilled.map((u) => (
                <tr key={u.landlord}>
                  <td><b>{u.landlord}</b>{u.crop_share && <div className="small secondary">Crop share: paid in grain</div>}</td>
                  <td className="small">{u.fields.map((f) => `${f.field} ${acresOf(f.acres)}${f.tenure === 'cropshare' ? ` (${f.crop_share_pct ?? '?'}%)` : f.rent_per_acre ? ` at ${money(f.rent_per_acre)}/ac` : ''}`).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
