import { useEffect, useRef, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';

// The menu, laid out like a personal finance app (Jake, 2026-10-24: "like
// Quicken … split by accounting tools and money management tools"):
//
//   Dashboard, Advisor
//   Money management — the everyday pages: transactions, spending, cash
//                      flow, bills, paystubs, groceries
//   Accounts         — every bank account, card and loan with its balance
//                      today; click one for its transactions
//   Accounting       — the books: the review queue, receipts, income &
//                      expenses, statements, tax, year-end, contracts,
//                      assets, imports
//
// On a wide screen it's all open, nothing to fold. On a narrower screen it's
// a bar across the top and each section is a drop-down.
const TOP = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/advisor', label: 'Advisor' },
];
export const GROUPS = [
  { id: 'money', label: 'Money management', short: 'Money', links: [
    { to: '/ledgers', label: 'Transactions' },
    { to: '/personal', label: 'Spending & budget' },
    { to: '/cash-flow', label: 'Cash flow' },
    { to: '/goals', label: 'Goals' },
    { to: '/bills', label: 'Bills' },
    { to: '/invoices', label: 'Invoices & receipts' },
    { to: '/calendar', label: 'Calendar' },
    { to: '/paystubs', label: 'Paystubs' },
    { to: '/groceries', label: 'Groceries' },
  ] },
  { id: 'accounts', label: 'Accounts', short: 'Accounts', accounts: true, links: [
    { to: '/accounts', label: 'Bank accounts' },
    { to: '/credit-cards', label: 'Credit cards' },
    { to: '/loans', label: 'Loans' },
  ] },
  { id: 'accounting', label: 'Accounting', short: 'Accounting', links: [
    { to: '/review', label: 'To review', count: true },
    { to: '/receipts', label: 'Receipts' },
    { to: '/expenses', label: 'Income & expenses' },
    { to: '/financials', label: 'Financial statements' },
    { to: '/tax', label: 'Tax' },
    { to: '/books', label: 'Year-end books' },
    { to: '/contracts', label: 'Grain & cattle contracts' },
    { to: '/assets', label: 'Assets & inventory' },
    { to: '/quicken', label: 'Quicken import' },
  ] },
];

const groupOf = (path) => GROUPS.find((g) => g.links.some((l) => path === l.to || path.startsWith(`${l.to}/`)))?.id || null;
const money0 = (n) => {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toLocaleString('en-CA');
  return `${v < 0 ? '−' : ''}$${s}`;
};

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

/** One group of accounts: its page, its total, and each account (folds). */
function AccountGroup({ title, to, data, linkFor, folded, onFold, location, warnNegative = false }) {
  if (!data) return null;
  const here = (href) => `${location.pathname}${location.search}` === href;
  return (
    <div className="acct-group">
      <div className="acct-head">
        <button type="button" className="acct-fold" aria-expanded={!folded} aria-label={`${folded ? 'Show' : 'Hide'} ${title}`} onClick={onFold}>
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" style={{ transform: folded ? 'none' : 'rotate(90deg)' }}><path d="M3 2l3.5 3L3 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <NavLink to={to} end className={({ isActive }) => `acct-title${isActive ? ' active' : ''}`}>{title}</NavLink>
        <span className={`acct-amt${warnNegative && data.total < 0 ? ' neg' : ''}`}>{money0(data.total)}</span>
      </div>
      {!folded && data.items.map((a) => {
        const href = linkFor(a);
        return (
          <Link key={a.id} to={href} className={`acct-row${here(href) ? ' active' : ''}`} title={a.name}>
            <span className="acct-name">{a.name}</span>
            {/* Red only for an overdrawn bank account: what's owed on a card or loan is debt, not a warning. */}
            <span className={`acct-amt${warnNegative && a.balance < 0 ? ' neg' : ''}`}>{money0(a.balance)}</span>
          </Link>
        );
      })}
    </div>
  );
}

export default function Sidebar({ canSignOut = false }) {
  // Statement lines waiting for a human — refreshed on every navigation
  // and whenever the Review page approves or rejects something.
  const [held, setHeld] = useState(0);
  const [accts, setAccts] = useState(null);
  const [folded, setFolded] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem('moneyhub.navFolded')) || []); } catch { return new Set(); } });
  const location = useLocation();
  const narrow = useNarrow();
  const current = groupOf(location.pathname);
  const [open, setOpen] = useState(null); // narrow screens: the drop-down showing
  const navRef = useRef(null);

  useEffect(() => {
    const refresh = () => fetch('/api/statements/review/count')
      .then((r) => r.json()).then((d) => setHeld(d.held || 0)).catch(() => {});
    const loadAccts = () => fetch('/api/accounts/sidebar').then((r) => (r.ok ? r.json() : null)).then((d) => d && setAccts(d)).catch(() => {});
    refresh(); loadAccts();
    window.addEventListener('review-changed', refresh);
    window.addEventListener('review-changed', loadAccts);
    return () => { window.removeEventListener('review-changed', refresh); window.removeEventListener('review-changed', loadAccts); };
  }, [location.pathname]);

  useEffect(() => { setOpen(null); }, [location.pathname, location.search, narrow]);

  // A drop-down closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!narrow || !open) return undefined;
    const away = (e) => { if (!navRef.current?.contains(e.target)) setOpen(null); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [narrow, open]);

  const fold = (k) => setFolded((f) => {
    const n = new Set(f);
    if (n.has(k)) n.delete(k); else n.add(k);
    try { localStorage.setItem('moneyhub.navFolded', JSON.stringify([...n])); } catch { /* private window */ }
    return n;
  });

  const link = (l, sub = false) => (
    <NavLink key={l.to} to={l.to} end={l.end}
      className={({ isActive }) => `nav-link${sub ? ' sub' : ''}${isActive ? ' active' : ''}`}>
      {l.label}
      {l.count && held > 0 && <span className="nav-count" aria-label={`${held} waiting`}>{held}</span>}
    </NavLink>
  );

  const accountList = (
    <div className="acct-list">
      <AccountGroup title="Banking" to="/accounts" data={accts?.banking} linkFor={(a) => `/ledgers?account=${a.id}`}
        folded={folded.has('banking')} onFold={() => fold('banking')} location={location} warnNegative />
      <AccountGroup title="Credit cards" to="/credit-cards" data={accts?.cards} linkFor={(a) => `/ledgers?card=${a.id}`}
        folded={folded.has('cards')} onFold={() => fold('cards')} location={location} />
      <AccountGroup title="Loans" to="/loans" data={accts?.loans} linkFor={() => '/loans'}
        folded={folded.has('loans')} onFold={() => fold('loans')} location={location} />
      {accts && (
        <div className="acct-net"><span>Net</span><span className="acct-amt">{money0(accts.net)}</span></div>
      )}
    </div>
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
          const waiting = g.links.some((l) => l.count) && held > 0;
          if (!narrow) {
            return (
              <section key={g.id} className="nav-section" aria-labelledby={`nav-h-${g.id}`}>
                <h2 className="nav-section-head" id={`nav-h-${g.id}`}>{g.label}</h2>
                {g.accounts ? accountList : g.links.map((l) => link(l, true))}
              </section>
            );
          }
          const isOpen = open === g.id;
          return (
            <div key={g.id} className={`nav-group${isOpen ? ' open' : ''}${current === g.id ? ' current' : ''}`}>
              <button type="button" className="nav-link nav-group-head" aria-expanded={isOpen} aria-controls={`nav-${g.id}`} onClick={() => setOpen(isOpen ? null : g.id)}>
                <span>{g.short}</span>
                {waiting && <span className="nav-count" aria-label={`${held} waiting in To review`}>{held}</span>}
                <svg className="nav-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 2l3.5 3L3 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              {isOpen && (
                <div className={`nav-sub${g.accounts ? ' nav-sub-accts' : ''}`} id={`nav-${g.id}`}>
                  {g.accounts ? accountList : g.links.map((l) => link(l, true))}
                </div>
              )}
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
