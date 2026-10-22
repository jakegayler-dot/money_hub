import { useState } from 'react';
import BalanceSheet from './BalanceSheet.jsx';
import { IncomeStatement, CashFlowStatement } from '../components/FinancialStatements.jsx';

// The three statements in one place: what the farm owns and owes, what it
// earned, and where the cash went.
const TABS = [['balance', 'Balance sheet'], ['income', 'Income statement'], ['cash', 'Cash flows']];

export default function Financials() {
  const [tab, setTab] = useState(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return TABS.some(([k]) => k === t) ? t : 'balance';
  });
  const pick = (t) => { setTab(t); window.history.replaceState(null, '', `/financials?tab=${t}`); };
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Financials</h1>
        <span className="seg-toggle fs-tabs" role="tablist" aria-label="Statement">
          {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => pick(k)}>{l}</button>)}
        </span>
      </div>
      {tab === 'balance' && <BalanceSheet embedded />}
      {tab === 'income' && <IncomeStatement />}
      {tab === 'cash' && <CashFlowStatement />}
    </>
  );
}
