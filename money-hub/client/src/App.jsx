import { Routes, Route } from 'react-router-dom';
import Sidebar from './components/Sidebar.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Accounts from './pages/Accounts.jsx';
import Bills from './pages/Bills.jsx';
import Ledgers from './pages/Ledgers.jsx';
import Loans from './pages/Loans.jsx';
import Expenses from './pages/Expenses.jsx';
import PurchaseEvaluator from './pages/PurchaseEvaluator.jsx';

export default function App() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/bills" element={<Bills />} />
          <Route path="/ledgers" element={<Ledgers />} />
          <Route path="/loans" element={<Loans />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/purchase-evaluator" element={<PurchaseEvaluator />} />
        </Routes>
      </main>
    </div>
  );
}
