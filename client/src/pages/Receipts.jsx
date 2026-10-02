import { useEffect, useRef, useState } from 'react';
import { cents } from '../components/SplitEditor.jsx';

const STATUS = {
  reading: <span className="badge">READING…</span>,
  unmatched: <span className="badge warn">WAITING FOR TRANSACTION</span>,
  unread: <span className="badge warn">ENTER DATE + TOTAL</span>,
  matched: <span className="badge pass">MATCHED</span>,
  review: <span className="badge warn">PICK THE TRANSACTION</span>,
  failed: <span className="badge fail">COULDN'T READ</span>,
  not_receipt: <span className="badge">NOT A RECEIPT</span>,
  billed: <span className="badge warn">BILL — NOT PAID YET</span>,
};

const DOC_LABEL = { receipt: 'Receipt', invoice: 'Invoice', sales_ticket: 'Sales ticket' };

// Phone photos are 3–6 MB. Shrink to 1600 px on the long side as JPEG —
// ~150–250 KB and still sharp enough to read every line.
async function compress(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.72));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function Receipts() {
  const [data, setData] = useState(null);
  const [missing, setMissing] = useState(null);
  const [tab, setTab] = useState(() => (new URLSearchParams(window.location.search).get('missing') ? 'missing' : 'all'));
  const [uploading, setUploading] = useState(null);
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);

  const load = () => {
    fetch('/api/receipts').then((r) => r.json()).then(setData);
    fetch('/api/receipts/missing').then((r) => r.json()).then((d) => setMissing(Array.isArray(d) ? d : []));
  };
  useEffect(load, []);
  // While anything is being read, check back every few seconds.
  useEffect(() => {
    if (!data?.receipts?.some((r) => r.status === 'reading')) return undefined;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [data]);

  const upload = async (files) => {
    const list = [...files];
    setMsg(null);
    for (let i = 0; i < list.length; i++) {
      setUploading(`Uploading ${i + 1} of ${list.length}…`);
      try {
        const blob = await compress(list[i]);
        const r = await fetch('/api/receipts/upload', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
        if (!r.ok) { const b = await r.json().catch(() => ({})); setMsg({ error: true, text: b.error || `Upload failed (${r.status})` }); }
      } catch {
        setMsg({ error: true, text: `Couldn't open ${list[i].name} as an image.` });
      }
    }
    setUploading(null);
    if (fileRef.current) fileRef.current.value = '';
    load();
  };

  const act = async (method, url, body) => {
    setMsg(null);
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { const b = await r.json().catch(() => ({})); setMsg({ error: true, text: b.error || `HTTP ${r.status}` }); return false; }
    load();
    window.dispatchEvent(new Event('review-changed'));
    return true;
  };

  if (!data) return <div className="empty-state">Loading…</div>;
  const counts = data.receipts.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Receipts & documents</h1>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          {uploading && <span className="page-meta">{uploading}</span>}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => upload(e.target.files)} />
          <button onClick={() => fileRef.current?.click()} disabled={!!uploading}>Add photos</button>
        </span>
      </div>

      {msg && <div className="notice" style={msg.error ? { borderColor: 'var(--negative)', color: 'var(--negative)' } : undefined}>{msg.text}</div>}
      {!data.reader && (
        <div className="notice">
          Receipts aren't being read automatically yet — add <code>ANTHROPIC_API_KEY</code> in Railway → Variables. Until then,
          type each receipt's date and total below and it still matches.
        </div>
      )}

      <div className="seg-toggle" role="group" aria-label="Show" style={{ marginBottom: 12 }}>
        {[['all', `All (${data.receipts.length})`], ['open', `Needs you (${(counts.review || 0) + (counts.failed || 0) + (counts.unread || 0)})`],
          ['missing', `Missing receipts (${missing ? missing.length : '…'})`], ['setup', 'iPhone setup']].map(([k, l]) => (
          <button key={k} type="button" aria-pressed={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === 'setup' && <Setup keySet={data.upload_key_set} />}

      {tab === 'missing' && (
        <div className="panel">
          <div className="panel-header">Farm purchases over $50 this year with no receipt</div>
          <p>Snap any of these you still have the paper for — it matches on its own.</p>
          {!missing || missing.length === 0 ? <div className="empty-state">None — every farm purchase over $50 has its receipt.</div> : (
            <table>
              <thead><tr><th>Date</th><th>Description</th><th>Paid with</th><th>Amount</th></tr></thead>
              <tbody>
                {missing.map((t) => (
                  <tr key={t.id}>
                    <td>{t.date}</td>
                    <td>{t.description}{t.payee && <div className="split-lines">{t.payee}</div>}</td>
                    <td>{t.account_name || `${t.card_name} (card)`}</td>
                    <td>{cents(t.amount)}{t.gst_amount ? <div className="split-lines">GST {cents(t.gst_amount)}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {(tab === 'all' || tab === 'open') && (
        <div className="panel">
          {data.receipts.filter((r) => tab === 'all' || ['review', 'failed', 'unread'].includes(r.status)).length === 0 ? (
            <div className="empty-state">{tab === 'all' ? 'No receipts yet — add one above, or set up the iPhone button.' : 'Nothing needs you.'}</div>
          ) : data.receipts.filter((r) => tab === 'all' || ['review', 'failed', 'unread'].includes(r.status)).map((r) => (
            <ReceiptRow key={r.id} r={r} act={act} />
          ))}
        </div>
      )}
    </>
  );
}

export function ReceiptRow({ r, act }) {
  const ex = r.extracted || {};
  const [edit, setEdit] = useState(null);
  const [suggest, setSuggest] = useState(null);
  const img = `/api/receipts/${r.id}/image`;

  return (
    <div className="receipt-row">
      <a href={img} target="_blank" rel="noreferrer" className="receipt-thumb"><img src={img} alt={`Receipt ${r.id}`} loading="lazy" /></a>
      <div className="receipt-body">
        <div className="review-head">
          <div>
            <div className="review-desc">
              {ex.party || (r.status === 'reading' ? 'Reading…' : 'Unknown business')}
              {ex.doc_type && ex.doc_type !== 'receipt' && <span className="badge" style={{ marginLeft: 8 }}>{DOC_LABEL[ex.doc_type]}</span>}
            </div>
            <div className="review-meta">
              {ex.date || '—'} · {ex.total != null ? `${ex.doc_type === 'sales_ticket' ? 'net ' : ''}${cents(ex.total)}` : '—'}
              {ex.doc_type === 'invoice' && ex.due_date ? ` · due ${ex.due_date}` : ''}{ex.invoice_number ? ` · #${ex.invoice_number}` : ''}{ex.gst != null ? ` · GST ${cents(ex.gst)}` : ''}
              {ex.category ? ` · ${ex.category}` : ''}{ex.card_last4 ? ` · card ••${ex.card_last4}` : ''}
            </div>
          </div>
          {STATUS[r.status] || <span className="badge">{r.status}</span>}
        </div>
        {r.status === 'matched' && (
          <div className="split-lines">
            On {r.tx_date} · {r.tx_description} · {cents(r.tx_amount)} · {r.tx_account || `${r.tx_card} (card)`}{' '}
            <a className="small-link" href={`/ledgers?edit=${r.transaction_id}`}>Open</a>
          </div>
        )}
        {r.status === 'billed' && (
          <div className="split-lines">
            Added to Bills{r.bill_name ? ` as "${r.bill_name}"` : ''}{r.bill_amount != null ? ` · ${cents(r.bill_amount)}` : ''}
            {r.bill_due ? ` · due ${r.bill_due}` : ''} — attaches to the payment once it's paid.{' '}
            <a className="small-link" href="/bills">Bills</a>
          </div>
        )}
        {r.status === 'unmatched' && (
          <div className="split-lines">
            {ex.doc_type === 'sales_ticket'
              ? `No ${ex.total != null ? cents(ex.total) : ''} deposit since ${ex.date} yet — matches when it lands (up to 45 days after).`
              : `No ${ex.total != null ? cents(-ex.total) : ''} transaction near ${ex.date} yet — matches when that statement comes in.`}
          </div>
        )}
        {ex.doc_type === 'sales_ticket' && (ex.gross != null || (ex.deductions || []).length > 0) && (
          <div className="split-lines">
            {ex.commodity ? `${ex.commodity}${ex.quantity ? ` · ${ex.quantity} ${ex.unit || ''}` : ''} · ` : ''}
            {ex.gross != null ? `gross ${cents(ex.gross)}` : ''}
            {(ex.deductions || []).map((d, i) => <span key={i}> · {d.description} −{cents(Math.abs(d.amount))}</span>)}
          </div>
        )}
        {r.status === 'failed' && <div className="review-error">{r.error}</div>}
        {ex.notes && <div className="split-lines">{ex.notes}</div>}
        {Array.isArray(ex.items) && ex.items.length > 0 && (
          <details className="split-lines"><summary>{ex.items.length} item{ex.items.length === 1 ? '' : 's'}</summary>
            {ex.items.map((it, i) => <div key={i}>{it.description} — {cents(it.amount)}</div>)}
          </details>
        )}

        {r.status === 'review' && (
          <div className="review-cands">
            {(r.candidates || []).map((c) => (
              <label key={c.id}>
                <button className="small" onClick={() => act('POST', `/api/receipts/${r.id}/attach`, { transaction_id: c.id })}>This one</button>
                {c.description} <span className="cand-meta">{c.date} · {cents(c.amount)}</span>
              </label>
            ))}
          </div>
        )}

        {edit && (
          <div className="review-fields">
            <div className="field"><label>Type</label>
              <select value={edit.doc_type} onChange={(e) => setEdit({ ...edit, doc_type: e.target.value })}>
                <option value="receipt">Receipt (already paid)</option>
                <option value="invoice">Invoice (to pay)</option>
                <option value="sales_ticket">Sales ticket (money in)</option>
              </select>
            </div>
            <div className="field"><label>Date</label><input type="date" value={edit.date} onChange={(e) => setEdit({ ...edit, date: e.target.value })} /></div>
            <div className="field"><label>{edit.doc_type === 'sales_ticket' ? 'Net paid to you' : edit.doc_type === 'invoice' ? 'Amount owing' : 'Total paid'}</label><input type="number" step="0.01" value={edit.total} onChange={(e) => setEdit({ ...edit, total: e.target.value })} /></div>
            <div className="field"><label>GST on it</label><input type="number" step="0.01" value={edit.gst} onChange={(e) => setEdit({ ...edit, gst: e.target.value })} /></div>
            <div className="field"><label>{edit.doc_type === 'sales_ticket' ? 'Buyer' : 'Business'}</label><input value={edit.party} onChange={(e) => setEdit({ ...edit, party: e.target.value })} /></div>
            {edit.doc_type === 'invoice' && (
              <div className="field"><label>Due date</label><input type="date" value={edit.due_date} onChange={(e) => setEdit({ ...edit, due_date: e.target.value })} /></div>
            )}
          </div>
        )}
        {suggest && (
          <div className="review-cands">
            {suggest.length === 0 ? <span className="split-lines">No {ex.doc_type === 'sales_ticket' ? 'deposits' : 'spending'} within 30 days of {ex.date || 'today'}.</span> : suggest.map((t) => (
              <label key={t.id}>
                <button className="small" onClick={() => act('POST', `/api/receipts/${r.id}/attach`, { transaction_id: t.id })}>Attach</button>
                {t.description} <span className="cand-meta">{t.date} · {cents(t.amount)} · {t.account_name || `${t.card_name} (card)`}</span>
              </label>
            ))}
          </div>
        )}

        <div className="review-actions">
          {edit ? (
            <>
              <button className="small" onClick={async () => { if (await act('PATCH', `/api/receipts/${r.id}`, edit)) setEdit(null); }}>Save</button>
              <button className="small secondary" onClick={() => setEdit(null)}>Cancel</button>
            </>
          ) : (
            <button className="small secondary" onClick={() => setEdit({ doc_type: ex.doc_type || 'receipt', date: ex.date || '', total: ex.total ?? '', gst: ex.gst ?? '', party: ex.party || '', due_date: ex.due_date || '' })}>
              {r.status === 'unread' ? 'Enter date + total' : 'Correct'}
            </button>
          )}
          {r.status !== 'matched' && (
            <button className="small secondary" onClick={async () => {
              if (suggest) { setSuggest(null); return; }
              setSuggest(await fetch(`/api/receipts/${r.id}/suggest`).then((x) => x.json()));
            }}>{suggest ? 'Hide' : 'Attach by hand'}</button>
          )}
          {r.status === 'matched' && <button className="small secondary" onClick={() => act('POST', `/api/receipts/${r.id}/detach`)}>Detach</button>}
          {['failed', 'not_receipt'].includes(r.status) && <button className="small secondary" onClick={() => act('POST', `/api/receipts/${r.id}/retry`)}>Read again</button>}
          <button className="small secondary" onClick={() => { if (window.confirm('Delete this receipt photo?')) act('DELETE', `/api/receipts/${r.id}`); }}>Delete</button>
        </div>
      </div>
    </div>
  );
}

function Setup({ keySet }) {
  const url = `${window.location.origin}/api/receipts/upload`;
  return (
    <div className="panel">
      <div className="panel-header">One-tap receipts from your iPhone</div>
      <div style={{ padding: '4px 16px 16px', fontSize: 13, lineHeight: 1.6 }}>
        {!keySet && (
          <p className="notice" style={{ marginTop: 12 }}>
            First, in Railway → Variables, add <code>RECEIPT_UPLOAD_KEY</code> with a long random value (a password generator
            works). It lets the phone send receipts without signing in, and can't do anything else.
          </p>
        )}
        <p>In the <strong>Shortcuts</strong> app, tap <strong>+</strong>, name it <strong>Receipt</strong>, and add these actions in order:</p>
        <ol>
          <li><strong>Take Photo</strong> — turn off "Show Preview" if you don't want to confirm each shot.</li>
          <li><strong>Resize Image</strong> — width <code>1600</code>, height auto.</li>
          <li><strong>Convert Image</strong> — to <strong>JPEG</strong>, quality about <code>0.7</code>. (iPhones shoot HEIC, which can't be read.)</li>
          <li><strong>Get Contents of URL</strong> — URL <code style={{ wordBreak: 'break-all' }}>{url}</code>, Method <strong>POST</strong>,
            Headers: <code>X-Receipt-Key</code> = your key, Request Body <strong>File</strong> = the Converted Image.</li>
          <li><strong>Show Notification</strong> — "Receipt sent".</li>
        </ol>
        <p>
          The same button works for <strong>invoices</strong> and <strong>sales tickets</strong> (grain settlements, cash tickets,
          auction statements). An unpaid invoice goes into Bills with its due date and attaches to the payment later. A sales ticket
          finds its deposit, splits it into the gross sale and each deduction (levies, freight, dockage…), and settles the open contract.
        </p>
        <p>
          Then long-press the shortcut → <strong>Add to Home Screen</strong> (or Settings → Action Button → Shortcut → Receipt on
          an iPhone 15 Pro or newer). One tap opens the camera; Money Hub reads and files it from there.
        </p>
        <p>
          Optional: to also keep a copy in iCloud, add <strong>Save File</strong> (folder <code>Receipts</code>) after step 3.
          A receipt doesn't need anything else from you — snap it before the paper goes in the box.
        </p>
      </div>
    </div>
  );
}
