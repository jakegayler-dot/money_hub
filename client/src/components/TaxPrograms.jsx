import { useEffect, useState } from 'react';
import { money } from '../format.js';

// Tax credits and programs for this family (server/lib/taxPrograms.js):
// what each is worth here, how to claim it, and where the rule comes from.
const GROUPS = [
  ['yes', 'Worth doing', 'These fit, on your numbers.'],
  ['check', 'Worth a look', 'May fit: needs a detail or a decision.'],
  ['auto', 'Automatic', 'Happen on the return — just make sure they\'re there.'],
  ['no', 'Not for you', 'And why.'],
];
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function Program({ p }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`tp-item tp-${p.status}`}>
      <button type="button" className="tp-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tp-name">{p.name}<span className="tp-chips"><span className="tag">{p.level}</span><span className="tag">{p.kind}</span><span className="tag">{p.who === 'farm' ? 'Farm' : p.who === 'ashley' ? 'Ashley' : p.who === 'jake' ? 'Jake' : 'Household'}</span></span></span>
        <span className="tp-value">{p.value ? `${p.status === 'check' ? 'up to ' : p.status === 'auto' ? 'about ' : ''}${money(p.value)}` : ''}</span>
      </button>
      {p.value_note && <p className="tp-note">{p.value_note}</p>}
      {open && (
        <div className="tp-body">
          <p>{p.what}</p>
          {p.claim && <p><strong>How to claim:</strong> {p.claim}</p>}
          <p className="split-lines">
            Checked {p.verified}{p.sources?.length ? ' · ' : ''}
            {p.sources?.map((u, i) => <span key={u}>{i ? ', ' : ''}<a href={u} target="_blank" rel="noreferrer">{host(u)}</a></span>)}
          </p>
        </div>
      )}
    </li>
  );
}

export default function TaxPrograms({ year }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [showNo, setShowNo] = useState(false);
  const [kids, setKids] = useState('');
  const load = () => fetch(`/api/tax/programs?year=${year}`).then((r) => r.json()).then((x) => {
    if (x.error) setErr(x.error); else { setD(x); setKids((x.profile.kids_birth_years || []).join(', ')); }
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [year]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (patch) => {
    setErr(null);
    const r = await fetch(`/api/tax/profile?year=${year}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const x = await r.json().catch(() => ({}));
    if (!r.ok) setErr(x.error || `HTTP ${r.status}`); else { setD(x); setKids((x.profile.kids_birth_years || []).join(', ')); }
  };
  if (!d) return err ? <p className="review-error">{err}</p> : null;
  const p = d.profile;
  const total = d.programs.filter((x) => x.status === 'yes' && x.value).reduce((a, x) => a + x.value, 0);

  return (
    <div className="panel tp">
      <div className="panel-header spend-header">
        <span>Credits and programs for you — {year}</span>
        {total > 0 && <span className="tp-total">about {money(total)} on the table</span>}
      </div>
      <p>
        Federal and Saskatchewan credits, deductions and programs that fit a grain-and-cattle sole proprietorship and its household,
        worked out from your books where they can be. Rules checked against the official sources on {d.verified}; click one for the
        details and how to claim it.
      </p>
      {err && <p className="review-error" style={{ margin: '0 16px 8px' }}>{err}</p>}

      <div className="tp-profile">
        <label>Children's birth years
          <input value={kids} placeholder="e.g. 2021, 2023" onChange={(e) => setKids(e.target.value)}
            onBlur={() => save({ kids_birth_years: kids.split(/[ ,;]+/).filter(Boolean).map(Number) })} />
        </label>
        <label>Ashley is a certified teacher or ECE
          <select value={p.ashley_educator == null ? '' : p.ashley_educator ? 'yes' : 'no'} onChange={(e) => save({ ashley_educator: e.target.value === '' ? null : e.target.value === 'yes' })}>
            <option value="">Not sure</option><option value="yes">Yes</option><option value="no">No</option>
          </select>
        </label>
        <label className="tp-check"><input type="checkbox" checked={!!p.owns_home} onChange={(e) => save({ owns_home: e.target.checked })} /> We own our home</label>
        <label className="tp-check"><input type="checkbox" checked={!!p.childcare} onChange={(e) => save({ childcare: e.target.checked })} /> We pay for child care</label>
        <label className="tp-check"><input type="checkbox" checked={!!p.jake_tuition} onChange={(e) => save({ jake_tuition: e.target.checked })} /> Jake pays tuition</label>
      </div>

      {GROUPS.map(([k, label, sub]) => {
        const list = d.programs.filter((x) => x.status === k);
        if (!list.length) return null;
        if (k === 'no' && !showNo) {
          return <div key={k} className="tp-group-head"><button type="button" className="small-link" onClick={() => setShowNo(true)}>Show {list.length} that don't fit</button></div>;
        }
        return (
          <div key={k}>
            <div className="tp-group-head">{label} <span className="split-lines">— {sub}</span></div>
            <ul className="tp-list">{list.map((x) => <Program key={x.id} p={x} />)}</ul>
          </div>
        );
      })}
      <p className="split-lines">Estimates, not advice: confirm amounts with your accountant before filing.</p>
    </div>
  );
}
