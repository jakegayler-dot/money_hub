import { NavLink } from 'react-router-dom';

const links = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/cash-flow', label: 'Cash Flow' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/bills', label: 'Bills' },
  { to: '/contracts', label: 'Contracts' },
  { to: '/ledgers', label: 'Ledgers' },
  { to: '/loans', label: 'Loans' },
  { to: '/expenses', label: 'Expenses' },
  { to: '/purchase-evaluator', label: 'Purchase Evaluator' },
];

export default function Sidebar() {
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
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
