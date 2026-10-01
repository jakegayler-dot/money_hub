import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './styles.css';
import { startTableLabels } from './tableLabels.js';

startTableLabels();

// Any API call refused for lack of sign-in (cookie expired, password
// changed) sends the app back to the sign-in screen.
const realFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await realFetch(...args);
  const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
  if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event('auth-required'));
  }
  return res;
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
