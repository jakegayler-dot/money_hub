import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

// The pages, grouped by job (Jake, 2026-10-23). Dashboard and Advisor stay
// on top; every other page sits in a group that folds open on click. The
// group holding the page you're on opens by itself. On a narrower screen
// the sidebar is a bar across the top and each group is a drop-down.
const TOP = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/advisor', label: 'Advisor' },
];
export const GROUPS = [
  { id: 'inbox', label: 'Inbox', links: [
    { to: '/review', label: 'Review', count: true },
    { to: '/receipts', label: 'Receipts' },
    { to: '/quicken', label: 'Quicken' },
  ] },
  { id: 'plan', label: 'Plan', links: [
    { to: '/cash-flow', label: 'Cash Flow' },
    { to: '/calendar', label: 'Calendar' },
    { to: '/bills', label: 'Bills' },
  ] },
  { id: 'reports', label: 'Reports', links: [
    { to: '/financials', label: 'Financials' },
    { to: '/expenses', label: 'Income & Expenses' },
    { to: '/tax', label: 'Tax' },
    { to: '/books', label: 'Books' },
  ] },
  { id: 'money', label: 'Money', links: [
    { to: '/accounts', label: 'Accounts' },
    { to: '/ledgers', label: 'Ledgers' },
    { to: '/credit-cards', label: 'Credit Cards' },
    { to: '/loans', label: 'Loans' },
  ] },
  { id: 'farm', label: 'Farm', links: [
    { to: '/contracts', label: 'Contracts' },
    { to: '/assets', label: 'Assets' },
  ] },
  { id: 'household', label: 'Household', links: [
    { to: '/personal', label: 'Personal' },
    { to: '/paystubs', label: 'Paystubs' },
    { to: '/groceries', label: 'Groceries' },
  ] },
];

const groupOf = (path) => GROUPS.find((g) => g.links.some((l) => path === l.to || path.startsWith(`${l.to}/`)))?.id || null;

function useNarrow() {
  const query = '(max-width: 1100px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

export default function Sidebar({ canSignOut = false }) {
  // Statement lines waiting for a human — refreshed on every navigation
  // and whenever the Review page approves or rejects something.
  const [held, setHeld] = useState(0);
  const location = useLocation();
  const narrow = useNarrow();
  const current = groupOf(location.pathname);
  const [open, setOpen] = useState(() => new Set(current ? [current] : []));
  const navRef = useRef(null);

  useEffect(() => {
    const refresh = () => fetch('/api/statements/review/count')
      .then((r) => r.json()).then((d) => setHeld(d.held || 0)).catch(() => {});
    refresh();
    window.addEventListener('review-changed', refresh);
    return () => window.removeEventListener('review-changed', refresh);
  }, [location.pathname]);

  // Moving to a page: in the sidebar its group opens (others stay as they
  // were); in the top bar any open drop-down closes.
  useEffect(() => {
    setOpen((o) => (narrow ? new Set() : current ? new Set([...o, current]) : o));
  }, [location.pathname, narrow]); // eslint-disable-line react-hooks/exhaustive-deps

  // A drop-down closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!narrow || !open.size) return undefined;
    const away = (e) => { if (!navRef.current?.contains(e.target)) setOpen(new Set()); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(new Set()); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [narrow, open]);

  const toggle = (id) => setOpen((o) => {
    if (narrow) return o.has(id) ? new Set() : new Set([id]);
    const n = new Set(o);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const link = (l, sub = false) => (
    <NavLink key={l.to} to={l.to} end={l.end}
      className={({ isActive }) => `nav-link${sub ? ' sub' : ''}${isActive ? ' active' : ''}`}>
      {l.label}
      {l.count && held > 0 && <span className="nav-count" aria-label={`${held} waiting`}>{held}</span>}
    </NavLink>
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">Money Hub</div>
        <div className="brand-sub">Capital allocation system</div>
      </div>
      <nav ref={navRef} aria-label="Pages">
        {TOP.map((l) => link(l))}
        {GROUPS.map((g) => {
          const isOpen = open.has(g.id);
          const waiting = g.links.some((l) => l.count) && held > 0;
          return (
            <div key={g.id} className={`nav-group${isOpen ? ' open' : ''}${current === g.id ? ' current' : ''}`}>
              <button type="button" className="nav-link nav-group-head" aria-expanded={isOpen} aria-controls={`nav-${g.id}`} onClick={() => toggle(g.id)}>
                <span>{g.label}</span>
                {waiting && !isOpen && <span className="nav-count" aria-label={`${held} waiting in Review`}>{held}</span>}
                <svg className="nav-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l3.5 3L3 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              {isOpen && <div className="nav-sub" id={`nav-${g.id}`}>{g.links.map((l) => link(l, true))}</div>}
            </div>
          );
        })}
      </nav>
      {canSignOut && <button type="button" className="nav-link signout" onClick={async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.dispatchEvent(new Event('auth-required'));
      }}>Sign out</button>}
    </aside>
  );
}
