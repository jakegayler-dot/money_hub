import { useEffect, useState } from 'react';
import { OWNER_KEYS, OWNER_LABELS } from '../owners.jsx';
import CategorySelect from '../components/CategorySelect.jsx';
import { ReceiptRow } from './Receipts.jsx';
import PayeeSelect, { usePayees } from '../components/PayeeSelect.jsx';
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

const NO_LINKS = { bills: [], loan_payments: [], contracts: [], cards: [] };

/**
 * "What it is" for one review item: regular spending/income, a transfer
 * to/from another of your accounts, an unpaid bill, or a scheduled loan
 * payment. `value` = { type: '' | 'transfer' | 'bill' | 'loan', target: id }.
 */
function WhatItIs({ amount, accountId, date, accounts, links, value, onChange }) {
  const out = amount < 0;
  const near = (x) => Math.abs(Math.abs(x) - Math.abs(amount)) < 0.005;
  const gap = (d) => (date ? Math.abs(new Date(d) - new Date(date)) : 0);
  const sorted = (list) => [...list].sort((a, b) => (Number(near(b.amount)) - Number(near(a.amount))) || (gap(a.due_date) - gap(b.due_date)));
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="review-fields">
      <div className="field">
        <label>What it is</label>
        <select value={value.type} onChange={(e) => set({ type: e.target.value, target: '' })}>
          <option value="">Spending / income</option>
          {accountId && <option value="transfer">Transfer with another of my accounts</option>}
          {out && <option value="bill">Pays a bill</option>}
          {out && accountId && <option value="loan">Loan payment</option>}
          {out && accountId && links.cards.length > 0 && <option value="card">Credit card payment</option>}
          {!out && accountId && <option value="contract">Contract payment (grain / cattle sale)</option>}
        </select>
      </div>
      {value.type === 'transfer' && (
        <div className="field">
          <label>{out ? 'Going into' : 'Coming from'}</label>
          <select value={value.target} onChange={(e) => set({ target: e.target.value })}>
            <option value="">Not one of my accounts / its statement brings the other side</option>
            {accounts.filter((a) => a.id !== accountId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      )}
      {value.type === 'bill' && (
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label>Which bill (✓ = amount matches)</label>
          <select value={value.target} onChange={(e) => set({ target: e.target.value })}>
            <option value="">{links.bills.length ? 'Pick a bill' : 'No unpaid bills on file'}</option>
            {sorted(links.bills).map((b) => (
              <option key={b.id} value={b.id}>{near(b.amount) ? '✓ ' : ''}{b.name} · {cents(b.amount)} · due {b.due_date}</option>
            ))}
          </select>
        </div>
      )}
      {value.type === 'contract' && (
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label>Which contract (✓ = amount matches)</label>
          <select value={value.target} onChange={(e) => set({ target: e.target.value })}>
            <option value="">{links.contracts.length ? 'Pick a contract' : 'No open contracts'}</option>
            {sorted(links.contracts).map((c) => (
              <option key={c.id} value={c.id}>{near(c.amount) ? '✓ ' : ''}{c.commodity}{c.counterparty ? ` — ${c.counterparty}` : ''} · {cents(c.amount)} · expected {c.due_date}</option>
            ))}
          </select>
        </div>
      )}
      {value.type === 'card' && (
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label>Which card</label>
          <select value={value.target} onChange={(e) => set({ target: e.target.value })}>
            <option value="">Pick a card</option>
            {links.cards.map((c) => <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` ••${c.last4}` : ''}</option>)}
          </select>
        </div>
      )}
      {value.type === 'loan' && (
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label>Which loan payment (✓ = amount matches)</label>
          <select value={value.target} onChange={(e) => set({ target: e.target.value })}>
            <option value="">{links.loan_payments.length ? 'Pick a payment' : 'No unrecorded loan payments due'}</option>
            {sorted(links.loan_payments).map((l) => (
              <option key={l.id} value={l.id}>{near(l.amount) ? '✓ ' : ''}{l.loan_name} · {cents(l.amount)} · due {l.due_date}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

export default function Review() {
  const [lines, setLines] = useState(null);
  const [imports, setImports] = useState([]);
  const [categories, setCategories] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [links, setLinks] = useState(NO_LINKS);
  const payees = usePayees();
  const [error, setError] = useState(null);

  const [flagged, setFlagged] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const load = () => {
    Promise.all([
      fetch('/api/statements/review').then((r) => r.json()),
      fetch('/api/statements/imports').then((r) => r.json()),
      fetch('/api/transactions?needs_review=true&limit=500').then((r) => r.json()),
    ]).then(([l, i, f]) => { setLines(l); setImports(i); setFlagged(Array.isArray(f) ? f : []); })
      .catch((e) => setError(e.message));
    fetch('/api/receipts?status=review,failed').then((r) => r.json()).then((d) => setReceipts(d.receipts || [])).catch(() => {});
    fetch('/api/transactions/link-options').then((r) => r.json())
      .then((d) => setLinks(d && d.bills ? { ...NO_LINKS, ...d } : NO_LINKS)).catch(() => {});
  };
  useEffect(() => {
    load();
    fetch('/api/expenses').then((r) => r.json()).then(setCategories);
    fetch('/api/accounts').then((r) => r.json()).then(setAccounts);
    const reload = () => fetch('/api/expenses').then((r) => r.json()).then(setCategories);
    window.addEventListener('categories-changed', reload);
    return () => window.removeEventListener('categories-changed', reload);
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
        <span className="page-meta">{lines.length + flagged.length + receipts.length} waiting</span>
      </div>

      <div className="panel">
        <div className="panel-header">Statement lines waiting for you</div>
        {lines.length === 0 ? (
          <div className="empty-state">Nothing to review — every statement line has been posted or matched.</div>
        ) : (
          lines.map((l) => (
            <ReviewItem key={l.id} line={l} categories={categories} accounts={accounts} links={links} payees={payees} onDone={changed} />
          ))
        )}
      </div>

      {receipts.length > 0 && (
        <div className="panel">
          <div className="panel-header">Receipts that need you</div>
          {receipts.map((r) => (
            <ReceiptRow key={r.id} r={r} act={async (method, url, body) => {
              const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
              if (res.ok) changed();
              return res.ok;
            }} />
          ))}
        </div>
      )}

      <div className="panel">
        <div className="panel-header">Transactions flagged for review</div>
        {flagged.length === 0 ? (
          <div className="empty-state">Nothing flagged. Entries marked "Needs review" on the Ledgers tab show up here.</div>
        ) : (
          flagged.map((t) => (
            <FlaggedItem key={t.id} tx={t} categories={categories} accounts={accounts} links={links} payees={payees} onDone={changed} />
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

const KIND_TO_TYPE = { transfer: 'transfer', owner_draw: 'transfer', bill_payment: 'bill', loan_payment: 'loan', contract_payment: 'contract', card_payment: 'card' };

function ReviewItem({ line, categories, accounts, links, payees, onDone }) {
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
  const partyName = (p.party || p.payee || '').trim().toLowerCase();
  const [payeeId, setPayeeId] = useState('');
  const knownPayee = partyName ? payees.find((x) => x.name.toLowerCase() === partyName) : null;
  const payeeValue = payeeId || (knownPayee ? String(knownPayee.id) : '');
  const [what, setWhat] = useState({
    type: KIND_TO_TYPE[line.kind || p.kind] || '',
    target: p.counterparty_account_id ? String(p.counterparty_account_id) : '',
  });
  const [postAsNew, setPostAsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const candType = candidates[0]?.type;
  const cardSidePayment = !!line.card_name && kind === 'card_payment';
  // The "What it is" picker applies unless a suggested match was picked.
  const usePicker = !(pick && pick !== 'none') && !cardSidePayment;

  const approve = async () => {
    const overrides = {};
    if (pick && pick !== 'none' && candType) overrides[CANDIDATE_KEY[candType]] = Number(pick);
    if (pick && pick !== 'none' && candType === 'card') overrides.kind = 'card_payment'; // a held plain line that pays a card
    if (pick === 'none' && candType === 'transaction') overrides.post_as_new = true;
    if (postAsNew) overrides.post_as_new = true;
    if (categoryId) { overrides.category_id = Number(categoryId); overrides.category = null; }
    if (payeeId) overrides.payee_id = Number(payeeId);
    if (editing) {
      overrides.kind = kind;
      if (segment) { overrides.segment = segment; overrides.is_segment_split = false; }
      if (splitting) overrides.splits = piecesPayload(pieces);
      else if (p.splits) overrides.splits = null;
    }
    if (cardSidePayment && fromAccount) overrides.from_account_id = Number(fromAccount);
    if (usePicker && what.type === 'transfer') {
      overrides.kind = (line.kind || p.kind) === 'owner_draw' ? 'owner_draw' : 'transfer';
      if (what.target) { overrides.counterparty_account_id = Number(what.target); overrides.counterparty_last4 = null; }
    } else if (usePicker && what.type === 'bill') {
      if (!what.target) { setErr('Pick which bill this pays.'); return; }
      overrides.kind = 'bill_payment'; overrides.bill_id = Number(what.target);
    } else if (usePicker && what.type === 'loan') {
      if (!what.target) { setErr('Pick which loan payment this is.'); return; }
      overrides.kind = 'loan_payment'; overrides.loan_payment_id = Number(what.target);
    } else if (usePicker && what.type === 'contract') {
      if (!what.target) { setErr('Pick which contract this settles.'); return; }
      overrides.kind = 'contract_payment'; overrides.contract_id = Number(what.target);
    } else if (usePicker && what.type === 'card') {
      if (!what.target) { setErr('Pick which card this pays.'); return; }
      overrides.kind = 'card_payment'; overrides.credit_card_id = Number(what.target);
    } else if (usePicker && !what.type && KIND_TO_TYPE[line.kind || p.kind] && !editing) {
      overrides.kind = 'standard';
    }
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

      {usePicker && (
        <WhatItIs amount={Number(line.amount)} accountId={line.account_id} date={line.date}
          accounts={accounts} links={links} value={what} onChange={setWhat} />
      )}
      {usePicker && what.type === '' && !splitting && (
        <div className="review-fields">
          <div className="field">
            <label>Category{Number(line.amount) > 0 ? ' (required for money in)' : ''}</label>
            <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId}
              preferKind={Number(line.amount) > 0 ? 'income' : 'expense'}
              emptyLabel={p.category ? `Keep "${p.category}"` : 'No category'} />
          </div>
          <div className="field">
            <label>{Number(line.amount) > 0 ? 'Received from' : 'Paid to'}</label>
            <PayeeSelect payees={payees} value={payeeValue} onChange={setPayeeId}
              emptyLabel={p.party || p.payee ? `"${p.party || p.payee}" (new)` : 'Not recorded'} />
          </div>
        </div>
      )}

      {editing && (
        <>
          <div className="review-fields">
            <div className="field">
              <label>Other kind</label>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {!splitting && (
              <>
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

// A transaction someone flagged. It already counts; this is where a person
// confirms or fixes its category and owner, then clears the flag. Anything
// more (amount, splits) opens it on the Ledgers tab.
function FlaggedItem({ tx, categories, accounts, links, payees, onDone }) {
  const [categoryId, setCategoryId] = useState(tx.category_id ? String(tx.category_id) : '');
  const [segment, setSegment] = useState(tx.is_segment_split ? '' : (tx.segment || ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const amount = Number(tx.amount);
  // Already a bill/loan/card payment, or already a paired transfer: nothing to re-assign here.
  const canAssign = !tx.pays && !tx.transfer_peer_id && !(tx.credit_card_id && tx.account_id);
  const [what, setWhat] = useState({ type: tx.is_transfer ? 'transfer' : '', target: '' });
  const [payeeId, setPayeeId] = useState(tx.payee_id ? String(tx.payee_id) : '');
  const needsIncomeCategory = amount > 0 && !tx.is_split && what.type === '' && !categoryId;

  const resolve = async () => {
    if (needsIncomeCategory && what.type !== 'contract') { setErr('This is money in — pick an income category first.'); return; }
    const body = { needs_review: false, payee_id: payeeId ? Number(payeeId) : null };
    if (canAssign) {
      if (what.type === 'transfer') {
        body.is_transfer = true; body.category_id = null; body.splits = [];
        if (what.target) body.transfer_account_id = Number(what.target);
      } else {
        if (tx.is_transfer) body.is_transfer = false;
        if (what.type === 'bill') {
          if (!what.target) { setErr('Pick which bill this pays.'); return; }
          body.link_bill_id = Number(what.target);
        }
        if (what.type === 'loan') {
          if (!what.target) { setErr('Pick which loan payment this is.'); return; }
          body.link_loan_payment_id = Number(what.target);
        }
        if (what.type === 'contract') {
          if (!what.target) { setErr('Pick which contract this settles.'); return; }
          body.link_contract_id = Number(what.target);
        }
        if (what.type === 'card') {
          if (!what.target) { setErr('Pick which card this pays.'); return; }
          body.link_card_id = Number(what.target);
        }
      }
    }
    if (!tx.is_split && what.type !== 'transfer') {
      body.category_id = categoryId ? Number(categoryId) : null;
      if (segment) { body.segment = segment; body.is_segment_split = false; }
    }
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/transactions/${tx.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    setBusy(false);
    if (!r.ok) { const b = await r.json().catch(() => ({})); setErr(b.error || `HTTP ${r.status}`); return; }
    onDone();
  };

  return (
    <div className="review-item">
      <div className="review-head">
        <div>
          <div className="review-desc">{tx.description || '(no description)'}</div>
          <div className="review-meta">
            {tx.date} · {tx.account_name || `${tx.card_name} (card)`}{tx.category_name ? ` · ${tx.category_name}` : ''}
            {tx.is_split ? ' · split' : ''}
          </div>
        </div>
        <div className={`review-amount ${amount < 0 ? 'neg' : 'pos'}`}>{cents(amount)}</div>
      </div>
      <div className="review-reason">{tx.review_note || 'Flagged for review.'}</div>
      {canAssign && (
        <WhatItIs amount={amount} accountId={tx.account_id} date={tx.date}
          accounts={accounts} links={links} value={what} onChange={setWhat} />
      )}
      {tx.pays && <div className="review-meta">Already linked — {tx.pays}</div>}
      {!tx.is_split && what.type !== 'transfer' && (
        <div className="review-fields">
          <div className="field">
            <label>Category</label>
            <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId}
              preferKind={amount > 0 ? 'income' : 'expense'} />
          </div>
          <div className="field">
            <label>Belongs to</label>
            <select value={segment} onChange={(e) => setSegment(e.target.value)}>
              <option value="">{tx.is_segment_split ? 'Keep split' : 'Keep as is'}</option>
              {OWNER_KEYS.map((k) => <option key={k} value={k}>{OWNER_LABELS[k]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{amount > 0 ? 'Received from' : 'Paid to'}</label>
            <PayeeSelect payees={payees} value={payeeId} onChange={setPayeeId} />
          </div>
        </div>
      )}
      <div className="review-actions">
        <button className="small" onClick={resolve} disabled={busy}>Looks right — clear flag</button>
        <a className="small-link" href={`/ledgers?edit=${tx.id}`}>Open in Ledgers to change amount or split</a>
        {err && <span className="review-error">{err}</span>}
      </div>
    </div>
  );
}
