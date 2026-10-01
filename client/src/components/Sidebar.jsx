import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

const links = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/review', label: 'Review', count: true },
  { to: '/receipts', label: 'Receipts' },
  { to: '/books', label: 'Books' },
  { to: '/tax', label: 'Tax' },
  { to: '/cash-flow', label: 'Cash Flow' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/bills', label: 'Bills' },
  { to: '/contracts', label: 'Contracts' },
  { to: '/ledgers', label: 'Ledgers' },
  { to: '/loans', label: 'Loans' },
  { to: '/credit-cards', label: 'Credit Cards' },
  { to: '/assets', label: 'Assets' },
  { to: '/expenses', label: 'Income & Expenses' },
  { to: '/purchase-evaluator', label: 'Purchase Evaluator' },
];

export default function Sidebar({ canSignOut = false }) {
  // Statement lines waiting for a human — refreshed on every navigation
  // and whenever the Review page approves or rejects something.
  const [held, setHeld] = useState(0);
  const location = useLocation();
  useEffect(() => {
    const refresh = () => fetch('/api/statements/review/count')
      .then((r) => r.json()).then((d) => setHeld(d.held || 0)).catch(() => {});
    refresh();
    window.addEventListener('review-changed', refresh);
    return () => window.removeEventListener('review-changed', refresh);
  }, [location.pathname]);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">Money Hub</div>
        <div className="brand-sub">Capital allocation system</div>
      </div>
      <nav>
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
          >
            {l.label}
            {l.count && held > 0 && <span className="nav-count" aria-label={`${held} waiting`}>{held}</span>}
          </NavLink>
        ))}
      </nav>
      {canSignOut && <button type="button" className="nav-link signout" onClick={async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.dispatchEvent(new Event('auth-required'));
      }}>Sign out</button>}
    </aside>
  );
}
