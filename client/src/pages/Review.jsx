import { useEffect, useState } from 'react';
import { OWNER_KEYS, OWNER_LABELS } from '../owners.jsx';
import SplitEditor, { cents, newPiece, piecesPayload } from '../components/SplitEditor.jsx';

const KIND_LABELS = {
  standard: 'Purchase / income',
  bill_payment: 'Bill payment',
  loan_payment: 'Loan payment',
  card_payment: 'Credit card payment',
  contract_payment: 'Contract settlement',
  transfer: 'Transfer between accounts',
  owner_draw: 'Owner draw',
};

// Which approval field a picked candidate fills in.
const CANDIDATE_KEY = {
  bill: 'bill_id', loan_payment: 'loan_payment_id', contract: 'contract_id',
  card: 'credit_card_id', transaction: 'match_transaction_id',
};

export default function Review() {
  const [lines, setLines] = useState(null);
  const [imports, setImports] = useState([]);
  const [categories, setCategories] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState(null);

  const load = () => {
    Promise.all([
      fetch('/api/statements/review').then((r) => r.json()),
      fetch('/api/statements/imports').then((r) => r.json()),
    ]).then(([l, i]) => { setLines(l); setImports(i); })
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    load();
    fetch('/api/expenses').then((r) => r.json()).then(setCategories);
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
  }, []);

  const changed = () => {
    load();
    window.dispatchEvent(new Event('review-changed'));
  };

  if (error) return <div className="empty-state">Could not load the review queue: {error}</div>;
  if (!lines) return <div className="empty-state">Loading…</div>;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Review</h1>
        <span className="page-meta">{lines.length} waiting</span>
      </div>

      <div className="panel">
        <div className="panel-header">Statement lines waiting for you</div>
        {lines.length === 0 ? (
          <div className="empty-state">Nothing to review — every statement line has been posted or matched.</div>
        ) : (
          lines.map((l) => (
            <ReviewItem key={l.id} line={l} categories={categories} accounts={accounts} onDone={changed} />
          ))
        )}
      </div>

      <div className="panel">
        <div className="panel-header">Recent statements</div>
        {imports.length === 0 ? (
          <div className="empty-state">No statements received yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>Statement</th><th>Period</th><th>Posted</th><th>Matched</th><th>Waiting</th><th>Balance check</th></tr>
              </thead>
              <tbody>
                {imports.map((i) => (
                  <tr key={i.id}>
                    <td>{i.account_name || i.card_name}{i.external_id ? <span className="tag">{i.external_id}</span> : null}{i.historical ? <span className="tag">History</span> : null}</td>
                    <td>{i.period_start || '—'} → {i.period_end || '—'}</td>
                    <td>{i.posted}</td>
                    <td>{i.matched}</td>
                    <td>{i.held > 0 ? <span className="badge warn">{i.held}</span> : 0}</td>
                    <td><Reconciliation r={i.reconciliation} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function Reconciliation({ r }) {
  if (!r) return <span className="tag">No closing balance sent</span>;
  if (r.reconciled) return <span className="badge pass">Matches statement</span>;
  if (r.explained_by_held) {
    return <span className="badge warn" title={`Money Hub ${cents(r.money_hub_balance)} vs statement ${cents(r.statement_closing)}`}>Off {cents(r.difference)} — the waiting lines</span>;
  }
  return <span className="badge fail" title={`Money Hub ${cents(r.money_hub_balance)} vs statement ${cents(r.statement_closing)}`}>Off by {cents(r.difference)}</span>;
}

function ReviewItem({ line, categories, accounts, onDone }) {
  const p = line.payload || {};
  const candidates = line.candidates || [];
  const [pick, setPick] = useState(candidates.length === 1 ? String(candidates[0].id) : '');
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState(p.kind || 'standard');
  const [categoryId, setCategoryId] = useState('');
  const [segment, setSegment] = useState(p.segment || '');
  const [splitting, setSplitting] = useState(false);
  const [pieces, setPieces] = useState([newPiece(), newPiece()]);
  const [fromAccount, setFromAccount] = useState('');
  const [postAsNew, setPostAsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const candType = candidates[0]?.type;
  const cardSidePayment = !!line.card_name && kind === 'card_payment';

  const approve = async () => {
    const overrides = {};
    if (pick && pick !== 'none' && candType) overrides[CANDIDATE_KEY[candType]] = Number(pick);
    if (pick === 'none' && candType === 'transaction') overrides.post_as_new = true;
    if (postAsNew) overrides.post_as_new = true;
    if (editing) {
      overrides.kind = kind;
      if (categoryId) { overrides.category_id = Number(categoryId); overrides.category = null; }
      if (segment) { overrides.segment = segment; overrides.is_segment_split = false; }
      if (splitting) overrides.splits = piecesPayload(pieces);
      else if (p.splits) overrides.splits = null;
    }
    if (cardSidePayment && fromAccount) overrides.from_account_id = Number(fromAccount);
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/statements/lines/${line.id}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrides }),
    });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setErr(body.line?.reason || body.error || 'Still needs a decision.');
      return;
    }
    onDone();
  };

  const reject = async () => {
    if (!window.confirm('Discard this line? Nothing will be recorded for it.')) return;
    await fetch(`/api/statements/lines/${line.id}/reject`, { method: 'POST' });
    onDone();
  };

  return (
    <div className="review-item">
      <div className="review-head">
        <div>
          <div className="review-desc">{line.description || '(no description)'}</div>
          <div className="review-meta">
            {line.date} · {line.account_name || `${line.card_name} (card)`} · {KIND_LABELS[line.kind] || line.kind}
            {p.category ? ` · ${p.category}` : ''}
          </div>
        </div>
        <div className={`review-amount ${line.amount < 0 ? 'neg' : 'pos'}`}>{cents(line.amount)}</div>
      </div>

      <div className="review-reason">{line.reason}</div>

      {candidates.length > 0 && (
        <div className="review-cands" role="radiogroup" aria-label="Possible matches">
          {candidates.map((c) => (
            <label key={`${c.type}-${c.id}`}>
              <input type="radio" name={`cand-${line.id}`} value={c.id} checked={pick === String(c.id)} onChange={() => setPick(String(c.id))} />
              {c.label}
              <span className="cand-meta">{[c.date, c.amount != null ? cents(c.amount) : null].filter(Boolean).join(' · ')}</span>
            </label>
          ))}
          <label>
            <input type="radio" name={`cand-${line.id}`} value="none" checked={pick === 'none'} onChange={() => setPick('none')} />
            {candType === 'transaction' ? 'None — this is a new transaction' : 'None of these'}
          </label>
        </div>
      )}

      {cardSidePayment && (
        <div className="review-fields">
          <div className="field">
            <label>Paid from account</label>
            <select value={fromAccount} onChange={(e) => setFromAccount(e.target.value)}>
              <option value="">Select account</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>
      )}

      {editing && (
        <>
          <div className="review-fields">
            <div className="field">
              <label>What it is</label>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {!splitting && (
              <>
                <div className="field">
                  <label>Category</label>
                  <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                    <option value="">{p.category ? `Keep "${p.category}"` : 'No category'}</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>Belongs to</label>
                  <select value={segment} onChange={(e) => setSegment(e.target.value)}>
                    <option value="">{p.segment ? `Keep ${OWNER_LABELS[p.segment] || p.segment}` : 'Account’s owner'}</option>
                    {OWNER_KEYS.map((k) => <option key={k} value={k}>{OWNER_LABELS[k]}</option>)}
                  </select>
                </div>
              </>
            )}
          </div>
          {kind === 'standard' && (
            <div className="field">
              <label>
                <input type="checkbox" checked={splitting} onChange={(e) => setSplitting(e.target.checked)} /> Split into pieces
              </label>
            </div>
          )}
          {splitting && kind === 'standard' && (
            <SplitEditor pieces={pieces} setPieces={setPieces} categories={categories} total={line.amount} />
          )}
          {candidates.length === 0 && (
            <div className="field">
              <label>
                <input type="checkbox" checked={postAsNew} onChange={(e) => setPostAsNew(e.target.checked)} /> Post as new even if it looks like a duplicate
              </label>
            </div>
          )}
        </>
      )}

      <div className="review-actions">
        <button className="small" onClick={approve} disabled={busy}>Approve</button>
        <button className="small secondary" onClick={() => setEditing(!editing)}>{editing ? 'Hide details' : 'Change details'}</button>
        <button className="small secondary" onClick={reject}>Reject</button>
        {err && <span className="review-error">{err}</span>}
      </div>
    </div>
  );
}
