import { useEffect, useRef, useState } from 'react';

// The financial advisor (server/lib/advisor): Jake's chat with it here, the
// threads it has had in Sentinel (read here, answered in Sentinel), what it
// remembers, and what it has cost this week.

const WHO = { jake: 'You', sentinel: 'Sentinel', advisor: 'Advisor' };
const STARTERS = [
  'Where should my next $20,000 go?',
  'Should I prepay inputs before December 31?',
  'How does this year’s tax look, and what would lower it?',
  'Can the farm afford a new combine next spring?',
];
const KIND = { fact: 'Fact', goal: 'Goal', preference: 'Preference', decision: 'Decision' };
const when = (t) => new Date(t).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function Advisor() {
  const [info, setInfo] = useState(null);
  const [threadId, setThreadId] = useState(null);
  const [thread, setThread] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const endRef = useRef(null);

  const loadInfo = () => fetch('/api/advisor').then((r) => r.json()).then((d) => {
    setInfo(d);
    setThreadId((cur) => cur ?? d.threads[0]?.id ?? null);
  }).catch(() => setError('Couldn’t load the advisor.'));
  const loadThread = (id) => fetch(`/api/advisor/threads/${id}`).then((r) => r.json()).then(setThread).catch(() => setError('Couldn’t load that thread.'));
  useEffect(() => { loadInfo(); }, []);
  useEffect(() => { if (threadId) loadThread(threadId); }, [threadId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [thread?.messages?.length, busy]);

  const current = info?.threads.find((t) => t.id === threadId);
  const readOnly = current?.where === 'sentinel';

  const ask = async (q) => {
    const body = String(q ?? text).trim();
    if (!body || busy) return;
    setError(null); setBusy(true);
    setThread((t) => t && { ...t, messages: [...t.messages, { id: `pending-${Date.now()}`, author: 'jake', body, created_at: new Date().toISOString() }] });
    setText('');
    try {
      const r = await fetch('/api/advisor/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: body, thread_id: threadId }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || `HTTP ${r.status}`); setText(body); }
      await Promise.all([loadThread(threadId), loadInfo()]);
    } finally { setBusy(false); }
  };
  const forget = async (id) => {
    await fetch(`/api/advisor/notes/${id}`, { method: 'DELETE' });
    loadInfo();
  };

  if (!info) return <div className="empty-state">{error || 'Loading…'}</div>;
  const msgs = thread?.messages || [];
  const spend = info.spend;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Advisor</h1>
        <span className="page-meta">US${spend.spent.toFixed(2)} of US${spend.budget.toFixed(0)} this week</span>
      </div>

      <div className="adv">
        <nav className="adv-threads" aria-label="Conversations">
          {info.threads.map((t) => (
            <button key={t.id} type="button" className={`adv-thread${t.id === threadId ? ' on' : ''}`} onClick={() => setThreadId(t.id)}>
              <span className="adv-thread-title">{t.title}</span>
              <span className="adv-thread-meta">{t.where === 'sentinel' ? (t.kind === 'group' ? 'Group in Sentinel' : 'In Sentinel') : 'Here'} · {t.messages}</span>
            </button>
          ))}
        </nav>

        <section className="adv-chat" aria-label={current?.title || 'Conversation'}>
          <div className="adv-log" aria-live="polite">
            {!msgs.length && !busy && (
              <div className="adv-empty">
                <p>Ask anything about money: the farm, the household, debt, tax, investing. It works from everything in Money Hub, runs decisions through the forecast, and cites the tax rules it relies on.</p>
                <div className="adv-starters">
                  {STARTERS.map((s) => <button key={s} type="button" className="small secondary" onClick={() => ask(s)}>{s}</button>)}
                </div>
              </div>
            )}
            {msgs.map((m) => <Message key={m.id} m={m} />)}
            {busy && <div className="adv-msg advisor working"><span className="adv-who">Advisor</span><p>Working it out. A decision with the numbers run can take a minute or two.</p></div>}
            <div ref={endRef} />
          </div>
          {error && <p className="review-error" role="alert">{error}</p>}
          {readOnly ? (
            <p className="adv-readonly">This thread lives in Sentinel. Reply there so Sentinel sees it too.</p>
          ) : (
            <form className="adv-compose" onSubmit={(e) => { e.preventDefault(); ask(); }}>
              <textarea aria-label="Your question" rows={2} value={text} placeholder="Ask the advisor…" disabled={busy}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} />
              <button type="submit" disabled={busy || !text.trim()}>Ask</button>
            </form>
          )}
        </section>

        <aside className="adv-side">
          <h2 className="adv-side-title">What it remembers</h2>
          {!info.notes.length && <p className="adv-quiet">Nothing yet. Tell it your goals, your RRSP and TFSA room, what your accountant has said, and it keeps them.</p>}
          <ul className="adv-notes">
            {info.notes.map((n) => (
              <li key={n.id}>
                <span className="adv-note-kind">{KIND[n.kind]}</span>
                <span>{n.text}</span>
                <button type="button" className="small-link" onClick={() => forget(n.id)} aria-label={`Forget: ${n.text}`}>Forget</button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </>
  );
}

function Message({ m }) {
  const meta = m.meta || {};
  return (
    <div className={`adv-msg ${m.author}`}>
      <span className="adv-who">{WHO[m.author] || m.author} <time>{when(m.created_at)}</time></span>
      {String(m.body).split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
      {m.author === 'advisor' && (meta.saved?.length || meta.cites?.length || meta.sources?.length) ? (
        <div className="adv-meta">
          {meta.saved?.map((s) => <a key={s.id} href={s.open}>What-if saved: {s.name}</a>)}
          {meta.cites?.length > 0 && <span title="Tax library entries it relied on">Tax library: {meta.cites.join(', ')}</span>}
          {meta.sources?.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.title || new URL(s.url).hostname}</a>)}
        </div>
      ) : null}
    </div>
  );
}
