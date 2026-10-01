import { Routes, Route, useLocation } from 'react-router-dom';
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

export default function App() {
  // The owner toggle and the three headline numbers live on the Dashboard
  // only; every other page goes straight to its own content.
  const { pathname } = useLocation();
  return (
    <div className="app-shell">
      <Sidebar />
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
        </Routes>
      </main>
    </div>
  );
}
