import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// NOTE: StrictMode removed intentionally — it causes double Supabase channel 
// subscriptions which breaks peer discovery and presence counting.
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
