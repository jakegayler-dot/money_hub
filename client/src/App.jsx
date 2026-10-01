import { useEffect, useState } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import SignIn from './components/SignIn.jsx';
import Sidebar from './components/Sidebar.jsx';
import EntityBar from './components/EntityBar.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Accounts from './pages/Accounts.jsx';
import Bills from './pages/Bills.jsx';
import Contracts from './pages/Contracts.jsx';
import CashFlow from './pages/CashFlow.jsx';
import Assets from './pages/Assets.jsx';
import Ledgers from './pages/Ledgers.jsx';
import Loans from './pages/Loans.jsx';
import Expenses from './pages/Expenses.jsx';
import PurchaseEvaluator from './pages/PurchaseEvaluator.jsx';
import CreditCards from './pages/CreditCards.jsx';
import Review from './pages/Review.jsx';
import Books from './pages/Books.jsx';
import Tax from './pages/Tax.jsx';
import Receipts from './pages/Receipts.jsx';

export default function App() {
  // The owner toggle and the three headline numbers live on the Dashboard
  // only; every other page goes straight to its own content.
  const { pathname } = useLocation();
  // 'checking' until the server says whether a password is set and whether
  // this browser is signed in.
  const [auth, setAuth] = useState('checking');
  const [required, setRequired] = useState(false);
  const check = () => fetch('/api/auth/status').then((r) => r.json())
    .then((s) => { setRequired(!!s.required); setAuth(s.signedIn ? 'in' : 'out'); }).catch(() => setAuth('in'));
  useEffect(() => {
    check();
    const out = () => setAuth('out');
    window.addEventListener('auth-required', out);
    return () => window.removeEventListener('auth-required', out);
  }, []);

  if (auth === 'checking') return null;
  if (auth === 'out') return <SignIn onSignedIn={() => setAuth('in')} />;
  return (
    <div className="app-shell">
      <Sidebar canSignOut={required} />
      <main>
        {pathname === '/' && <EntityBar />}
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/cash-flow" element={<CashFlow />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/bills" element={<Bills />} />
          <Route path="/contracts" element={<Contracts />} />
          <Route path="/ledgers" element={<Ledgers />} />
          <Route path="/loans" element={<Loans />} />
          <Route path="/assets" element={<Assets />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/purchase-evaluator" element={<PurchaseEvaluator />} />
          <Route path="/credit-cards" element={<CreditCards />} />
          <Route path="/review" element={<Review />} />
          <Route path="/books" element={<Books />} />
          <Route path="/tax" element={<Tax />} />
          <Route path="/receipts" element={<Receipts />} />
        </Routes>
      </main>
    </div>
  );
}
