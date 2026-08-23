import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { sweepOrphanedTransfers } from './utils/opfsCleanup';

// Service worker is now handled by vite-plugin-pwa automatically

// Collect OPFS files left behind by previous sessions (media previews are
// not deleted at finalize time, so this is their cleanup path)
sweepOrphanedTransfers();

// NOTE: StrictMode removed intentionally — it causes double Supabase channel 
// subscriptions which breaks peer discovery and presence counting.
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
