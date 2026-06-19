import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Service worker is now handled by vite-plugin-pwa automatically


// NOTE: StrictMode removed intentionally — it causes double Supabase channel 
// subscriptions which breaks peer discovery and presence counting.
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
