import { useEffect, useRef, useState } from 'react';
import { OWNER_KEYS, OWNER_LABELS } from '../owners.jsx';

// The Quicken feed: drop in an export (or let an agent send one daily),
// link each Quicken account once, and teach it each Quicken category once.

const when = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export default function Quicken() {
  const [data, setData] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);

  const load = () => fetch('/api/quicken').then((r) => r.json()).then(setData).catch(() => setError('Could not load the Quicken feed.'));
  useEffect(() => { load(); }, []);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const text = await file.text();
      const r = await fetch(`/api/quicken/import?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setError(d.error || `Import failed (${r.status})`); else setResult(d);
      load();
    } catch (e) { setError(e.message); }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const saveAccount = async (a, patch) => {
    const body = { account_id: a.account_id, credit_card_id: a.credit_card_id, ignored: a.ignored, import_from: a.import_from, card_opening_balance: a.card_opening_balance, ...patch };
    const r = await fetch(`/api/quicken/accounts/${a.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setError(d.error || 'Not saved'); else { setError(null); load(); }
  };
  const saveCategory = async (c, patch) => {
    const body = { category_id: c.category_id, owner: c.owner, kind: c.kind, ...patch };
    const r = await fetch(`/api/quicken/categories/${c.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setError(d.error || 'Not saved');
    else {
      setError(null);
      setResult((x) => (x ? { ...x, unmapped_categories: (x.unmapped_categories || []).filter((n) => n !== c.name) } : x));
      if (d.filled) setResult((x) => ({ ...(x || {}), filledNote: `${plural(d.filled, 'transaction')} filled in under ${c.name}.` }));
      load();
    }
  };

  const last = data?.imports?.[0];
  const unlinked = (data?.accounts || []).filter((a) => !a.account_id && !a.credit_card_id && !a.ignored);
  const unmapped = (data?.categories || []).filter((c) => !c.category_id && c.kind === 'standard');

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Quicken</h1>
        <span className="page-meta">{last ? `Last import ${when(last.received_at)} · ${last.source_label === 'agent' ? 'by an agent' : 'uploaded'}` : 'Nothing imported yet'}</span>
      </div>

      <div
        className={`panel qk-drop${drag ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files?.[0]); }}
      >
        <div>
          <strong>Drop a Quicken export here</strong>
          <p>QIF or CSV from Quicken Classic (Windows or Mac) or Simplifi. Overlapping exports are fine — nothing is entered twice. A rolling 30–60 days, daily, keeps Money Hub current.</p>
        </div>
        <input ref={fileRef} type="file" accept=".qif,.csv,.txt,text/csv,text/plain" hidden onChange={(e) => upload(e.target.files?.[0])} />
        <button type="button" className="small" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Importing…' : 'Choose file'}</button>
      </div>

      {error && <p className="review-error">{error}</p>}
      {result?.summary && <ImportResult r={result} />}
      {result?.filledNote && <p className="qk-note">{result.filledNote}</p>}

      {!data ? <div className="empty-state">Loading…</div> : (
        <>
          <div className="panel">
            <div className="panel-header">Accounts{unlinked.length > 0 && <span className="badge warn" style={{ marginLeft: 8 }}>{unlinked.length} to link</span>}</div>
            {data.accounts.length === 0 ? <div className="empty-state">Quicken accounts appear here after the first import.</div> : (
              <table className="qk-table">
                <thead><tr><th>Quicken account</th><th>Goes to</th><th>Import from</th><th>Card balance owed before that</th><th className="num">Lines seen</th></tr></thead>
                <tbody>
                  {data.accounts.map((a) => {
                    const val = a.account_id ? `a:${a.account_id}` : a.credit_card_id ? `c:${a.credit_card_id}` : a.ignored ? 'ignore' : '';
                    const needsBal = a.credit_card_id && !a.card_itemized;
                    return (
                      <tr key={a.id} className={val === '' ? 'qk-todo' : ''}>
                        <td>{a.name}{a.qtype && <span className="tag">{a.qtype}</span>}{a.auto_matched && <span className="qk-auto" title="Matched by name or last 4 digits">matched</span>}</td>
                        <td>
                          <select aria-label={`Where ${a.name} goes`} value={val} onChange={(e) => {
                            const v = e.target.value;
                            saveAccount(a, { account_id: v.startsWith('a:') ? Number(v.slice(2)) : null, credit_card_id: v.startsWith('c:') ? Number(v.slice(2)) : null, ignored: v === 'ignore' });
                          }}>
                            <option value="">Not linked — skipped</option>
                            <optgroup label="Accounts">{data.options.accounts.map((x) => <option key={x.id} value={`a:${x.id}`}>{x.name}{x.last4 ? ` ··${x.last4}` : ''}</option>)}</optgroup>
                            <optgroup label="Credit cards">{data.options.cards.map((x) => <option key={x.id} value={`c:${x.id}`}>{x.name}{x.last4 ? ` ··${x.last4}` : ''}</option>)}</optgroup>
                            <option value="ignore">Ignore this account</option>
                          </select>
                        </td>
                        <td><input type="date" aria-label={`Import ${a.name} from`} defaultValue={a.import_from || ''} key={`f${a.import_from}`} disabled={!a.account_id && !a.credit_card_id}
                          onBlur={(e) => e.target.value !== (a.import_from || '') && saveAccount(a, { import_from: e.target.value || null })} /></td>
                        <td>{needsBal ? (
                          <input type="number" step="0.01" aria-label={`${a.name} balance owed`} placeholder="Needed to start" defaultValue={a.card_opening_balance ?? ''} key={`b${a.card_opening_balance}`}
                            onBlur={(e) => String(a.card_opening_balance ?? '') !== e.target.value && saveAccount(a, { card_opening_balance: e.target.value === '' ? null : Number(e.target.value) })} />
                        ) : <span className="qk-muted">—</span>}</td>
                        <td className="num">{a.lines_seen}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <div className="panel-header">Categories{unmapped.length > 0 && <span className="badge warn" style={{ marginLeft: 8 }}>{unmapped.length} to map</span>}</div>
            {data.categories.length === 0 ? <div className="empty-state">Quicken categories appear here after the first import.</div> : (
              <>
                <p className="qk-help">Map each once. Lines in an unmapped category post uncategorized; mapping it fills them in.</p>
                <table className="qk-table">
                  <thead><tr><th>Quicken category</th><th>Money Hub category</th><th>Owner</th><th>Treat as</th><th className="num">Lines seen</th></tr></thead>
                  <tbody>
                    {data.categories.map((c) => (
                      <tr key={c.id} className={!c.category_id && c.kind === 'standard' ? 'qk-todo' : ''}>
                        <td>{c.name}{c.auto_matched && <span className="qk-auto" title="Matched by name">matched</span>}</td>
                        <td>
                          <select aria-label={`Money Hub category for ${c.name}`} value={c.category_id || ''} disabled={c.kind !== 'standard'} onChange={(e) => saveCategory(c, { category_id: e.target.value ? Number(e.target.value) : null })}>
                            <option value="">Not mapped</option>
                            {['expense', 'income'].map((k) => (
                              <optgroup key={k} label={k === 'income' ? 'Income' : 'Expenses'}>
                                {data.options.categories.filter((x) => (x.kind || 'expense') === k).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                              </optgroup>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select aria-label={`Owner for ${c.name}`} value={c.owner?.segment || ''} onChange={(e) => saveCategory(c, { owner: e.target.value ? { segment: e.target.value } : null })}>
                            <option value="">From the account</option>
                            {OWNER_KEYS.map((k) => <option key={k} value={k}>{OWNER_LABELS[k]}</option>)}
                          </select>
                        </td>
                        <td>
                          <select aria-label={`Treat ${c.name} as`} value={c.kind} onChange={(e) => saveCategory(c, { kind: e.target.value })}>
                            <option value="standard">Spending or income</option>
                            <option value="owner_draw">Owner draw</option>
                            <option value="transfer">Transfer</option>
                          </select>
                        </td>
                        <td className="num">{c.lines_seen}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>

          {data.imports.length > 0 && (
            <div className="panel">
              <div className="panel-header">Recent imports</div>
              <table className="qk-table">
                <thead><tr><th>When</th><th>From</th><th>File</th><th className="num">Lines</th><th className="num">New</th><th className="num">Already on file</th><th className="num">For review</th></tr></thead>
                <tbody>
                  {data.imports.map((i) => (
                    <tr key={i.id}>
                      <td>{when(i.received_at)}</td>
                      <td>{i.source_label || '—'}</td>
                      <td>{i.filename || i.format?.toUpperCase()}</td>
                      <td className="num">{i.lines_read}</td>
                      <td className="num">{i.summary?.posted ?? 0}</td>
                      <td className="num">{(i.summary?.matched ?? 0) + (i.summary?.already ?? 0)}</td>
                      <td className="num">{(i.summary?.held ?? 0) + (i.summary?.flagged_gone ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

function ImportResult({ r }) {
  const s = r.summary;
  const parts = [
    s.posted && `${plural(s.posted, 'new transaction')}`,
    s.matched && `${s.matched} already on file`,
    s.already && `${s.already} from an earlier import`,
    s.held && `${s.held} waiting on Review`,
    s.flagged_gone && `${s.flagged_gone} no longer in Quicken — flagged`,
    s.skipped_before && `${s.skipped_before} before an account’s start date`,
  ].filter(Boolean);
  return (
    <div className="qk-result" role="status">
      <strong>Imported {plural(r.lines_read, 'line')}.</strong> {parts.join(' · ') || 'Nothing new.'}
      {r.needs_linking?.length > 0 && <div>Link {r.needs_linking.map((x) => x.quicken_account).join(', ')} below to bring {r.needs_linking.length === 1 ? 'it' : 'them'} in.</div>}
      {r.unmapped_categories?.length > 0 && <div>{plural(r.unmapped_categories.length, 'category')} to map below.</div>}
      {r.warnings?.map((w) => <div key={w} className="qk-warn">{w}</div>)}
    </div>
  );
}
