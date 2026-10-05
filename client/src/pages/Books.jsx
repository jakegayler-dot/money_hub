import { useEffect, useState } from 'react';
import { localToday } from '../format.js';
import { Link } from 'react-router-dom';
import { cents } from '../components/SplitEditor.jsx';

const STATUS = {
  ok: <span className="badge pass">RECONCILED</span>,
  held: <span className="badge warn">WAITING ON REVIEW</span>,
  off: <span className="badge fail">OFF</span>,
  never: <span className="badge fail">NEVER CHECKED</span>,
};

export default function Books() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(null); // ledger row being confirmed by hand
  const [closing, setClosing] = useState(null);   // { month, force, note, mode: 'close' | 'reopen' }
  const [msg, setMsg] = useState(null);

  const load = () => fetch('/api/books').then(async (r) => {
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    setData(d);
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const post = async (url, body) => {
    setMsg(null);
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg({ error: true, text: d.error || `HTTP ${r.status}` }); return null; }
    return d;
  };

  if (error) return <div className="empty-state">Couldn't load the books: {error}</div>;
  if (!data) return <div className="empty-state">Loading…</div>;

  const okCount = data.ledgers.filter((l) => l.status === 'ok').length;
  const blocking = data.checks.filter((c) => c.level === 'block' && c.count > 0).length;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Books</h1>
        <span className="page-meta">
          {okCount} of {data.ledgers.length} reconciled · {blocking ? `${blocking} blocking item${blocking === 1 ? '' : 's'}` : 'nothing blocking'}
        </span>
      </div>

      {msg && <div className="notice" style={msg.error ? { borderColor: 'var(--negative)', color: 'var(--negative)' } : undefined}>{msg.text}</div>}

      <div className="panel">
        <div className="panel-header">Balances vs. the bank</div>
        <p>
          Each account and card's latest statement, checked right now against Money Hub. Reconciled means the two agree
          to the cent on the statement date. For an account with no statements coming in, use <em>Confirm balance</em> with
          a figure from the bank's app.
        </p>
        <table>
          <thead><tr><th>Account / card</th><th>Latest check</th><th>Statement</th><th>Money Hub</th><th>Difference</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {data.ledgers.map((l) => (
              <tr key={`${l.kind}${l.id}`}>
                <td>
                  {l.name}{l.kind === 'card' ? ' (card)' : ''}
                  <div className="split-lines">
                    {l.reconciled_through ? `Reconciled through ${l.reconciled_through}` : 'Never reconciled'}
                  </div>
                </td>
                <td>{l.latest ? <>{l.latest.period_end}{l.latest.manual && <div className="split-lines">confirmed by hand</div>}</> : '—'}</td>
                <td>{l.latest ? cents(l.latest.statement_closing) : '—'}</td>
                <td>{l.latest ? cents(l.latest.money_hub_balance) : '—'}</td>
                <td style={l.latest && !l.latest.reconciled ? { color: 'var(--negative)' } : undefined}>
                  {l.latest ? cents(l.latest.difference) : '—'}
                  {l.latest?.held_count > 0 && <div className="split-lines">{l.latest.held_count} line{l.latest.held_count === 1 ? '' : 's'} on Review ({cents(l.latest.held_effect)})</div>}
                </td>
                <td>{STATUS[l.status]}</td>
                <td>
                  {checking?.key === `${l.kind}${l.id}` ? (
                    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input type="date" value={checking.date} onChange={(e) => setChecking({ ...checking, date: e.target.value })} aria-label="Balance date" />
                      <input type="number" step="0.01" placeholder={l.kind === 'card' ? 'Owed' : 'Balance'} style={{ width: 110 }}
                        value={checking.balance} onChange={(e) => setChecking({ ...checking, balance: e.target.value })} aria-label="Balance" />
                      <button className="small" disabled={!checking.date || checking.balance === ''} onClick={async () => {
                        const out = await post('/api/books/confirm', {
                          [l.kind === 'card' ? 'credit_card_id' : 'account_id']: l.id, date: checking.date, balance: Number(checking.balance),
                        });
                        if (out) {
                          setChecking(null);
                          setMsg({ text: out.check?.reconciled ? `${l.name} matches the bank on ${checking.date}.` : `${l.name} is off by ${cents(out.check?.difference)} on ${checking.date}.` });
                          load();
                        }
                      }}>Check</button>
                      <button className="small secondary" onClick={() => setChecking(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button className="small secondary" onClick={() => setChecking({ key: `${l.kind}${l.id}`, date: localToday(), balance: '' })}>
                      Confirm balance
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-header">Loose ends</div>
        <table>
          <tbody>
            {data.checks.map((c) => (
              <tr key={c.key}>
                <td style={{ width: 90 }}>
                  {c.count === 0 ? <span className="badge pass">CLEAR</span>
                    : c.level === 'block' ? <span className="badge fail">{c.count}</span>
                      : c.level === 'warn' ? <span className="badge warn">{c.count}</span>
                        : <span className="badge">{c.count}</span>}
                </td>
                <td>{c.label}</td>
                <td style={{ textAlign: 'right' }}>{c.count > 0 && <Link className="small-link" to={c.link}>Open</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <div className="panel-header">Month-end close</div>
        <p>
          A month is ready when every account and card is reconciled through its last day and nothing dated in it is
          waiting on Review. Closing locks it: nothing dated in it can be added, edited, deleted or cleared — by you or by
          the statement agent — until it's reopened. Closes and reopens are logged below.
        </p>
        {data.months.length === 0 ? (
          <div className="empty-state">No finished months with transactions yet.</div>
        ) : (
          <table>
            <thead><tr><th>Month</th><th>Status</th><th>What's left</th><th></th></tr></thead>
            <tbody>
              {data.months.map((m) => (
                <tr key={m.month}>
                  <td>{m.label}</td>
                  <td>
                    {m.closed ? <span className={`badge ${m.forced ? 'warn' : 'pass'}`}>{m.forced ? 'CLOSED WITH NOTE' : 'CLOSED'}</span>
                      : m.ready ? <span className="badge pass">READY</span> : <span className="badge">OPEN</span>}
                  </td>
                  <td>
                    {m.closed ? (m.note ? <span className="split-lines">{m.note}</span> : '—')
                      : m.blockers.length === 0 ? '—'
                        : m.blockers.map((b) => <div key={b} className="split-lines">{b}</div>)}
                  </td>
                  <td>
                    {closing?.month === m.month ? (
                      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                        <input placeholder={closing.mode === 'reopen' ? 'Why reopen?' : 'Why close with items open?'} style={{ width: 200 }}
                          value={closing.note} onChange={(e) => setClosing({ ...closing, note: e.target.value })} aria-label="Note" />
                        <button className="small" disabled={!closing.note.trim()} onClick={async () => {
                          const out = closing.mode === 'reopen'
                            ? await post('/api/books/reopen', { month: m.month, note: closing.note })
                            : await post('/api/books/close', { month: m.month, force: true, note: closing.note });
                          if (out) { setClosing(null); load(); }
                        }}>{closing.mode === 'reopen' ? 'Reopen' : 'Close anyway'}</button>
                        <button className="small secondary" onClick={() => setClosing(null)}>Cancel</button>
                      </span>
                    ) : m.closed ? (
                      <button className="small secondary" onClick={() => setClosing({ month: m.month, mode: 'reopen', note: '' })}>Reopen</button>
                    ) : m.ready ? (
                      <button className="small" onClick={async () => { if (await post('/api/books/close', { month: m.month })) load(); }}>Close month</button>
                    ) : (
                      <button className="small secondary" onClick={() => setClosing({ month: m.month, mode: 'close', note: '' })}>Close anyway…</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data.log.length > 0 && (
          <>
            <div className="panel-header" style={{ borderTop: '1px solid var(--border)' }}>Log</div>
            <table>
              <tbody>
                {data.log.map((l) => (
                  <tr key={l.id}>
                    <td>{String(l.at).slice(0, 16).replace('T', ' ')}</td>
                    <td>{l.action === 'closed' ? (l.forced ? 'Closed with open items' : 'Closed') : 'Reopened'} {l.label}</td>
                    <td>{l.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}
