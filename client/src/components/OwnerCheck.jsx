import { useEffect, useState } from 'react';
import { OWNER_KEYS, OWNER_LABELS } from '../owners.jsx';
import { cents } from './SplitEditor.jsx';

// Spending counted as farm that's probably household: one tap sets the
// owner (and, ticked, the business's rule so it never comes up again).
export default function OwnerCheck({ onChanged }) {
  const [data, setData] = useState(null);
  const [always, setAlways] = useState({}); // payee_id → true
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => fetch('/api/personal/owner-check').then((r) => r.json()).then(setData).catch(() => {});
  useEffect(() => { load(); }, []);

  const settle = async (t, owner) => {
    setBusy(t.id); setErr(null);
    try {
      if (owner) {
        const r = await fetch(`/api/transactions/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segment: owner, is_segment_split: false }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Not saved');
        if (always[t.payee_id] && t.payee_id) {
          await fetch(`/api/payees/${t.payee_id}/owner`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segment: owner, is_segment_split: false }) });
        }
      }
      await fetch(`/api/personal/owner-check/${t.id}/confirm`, { method: 'POST' });
      setData((d) => {
        // A rule for this business settles its other lines too.
        const drop = (x) => x.id === t.id || (owner && always[t.payee_id] && x.payee_id === t.payee_id);
        const items = d.items.filter((x) => !drop(x));
        return { ...d, items, count: items.length };
      });
      onChanged?.();
    } catch (e) { setErr(e.message); }
    setBusy(null);
  };

  if (!data || data.count === 0) return null;
  return (
    <div className="panel owner-check">
      <div className="panel-header">Check the owner<span className="badge warn" style={{ marginLeft: 8 }}>{data.count}</span></div>
      <p className="qk-help">Counted as farm, but probably household. Each one you set makes the personal forecast more accurate; a rule for the business settles it for good.</p>
      {err && <p className="review-error" style={{ margin: '8px 16px' }}>{err}</p>}
      <ul className="oc-list">
        {data.items.slice(0, 30).map((t) => (
          <li key={t.id} className={busy === t.id ? 'busy' : ''}>
            <div className="oc-main">
              <span className="oc-amt">{cents(t.amount)}</span>
              <span className="oc-what">{t.payee || t.description}<em>{t.date} · {t.account}{t.category ? ` · ${t.category}` : ''}</em></span>
              <span className="oc-why">{t.reasons.join(' · ')}</span>
            </div>
            <div className="oc-actions">
              {OWNER_KEYS.map((k) => <button key={k} type="button" className="small secondary" disabled={busy === t.id} onClick={() => settle(t, k)}>{OWNER_LABELS[k]}</button>)}
              <button type="button" className="small-link" disabled={busy === t.id} onClick={() => settle(t, null)}>Farm is right</button>
              {t.payee_id && (
                <label className="oc-always">
                  <input type="checkbox" checked={!!always[t.payee_id]} onChange={(e) => setAlways((a) => ({ ...a, [t.payee_id]: e.target.checked }))} />
                  Always for {t.payee}
                </label>
              )}
            </div>
          </li>
        ))}
      </ul>
      {data.count > 30 && <p className="qk-help">Showing 30 of {data.count}.</p>}
    </div>
  );
}
