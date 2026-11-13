import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { installErrorReporting, trackVisitOnce } from './lib/telemetry';

installErrorReporting();
trackVisitOnce();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

const splash = document.getElementById('splash');
if (splash) { splash.style.opacity = '0'; setTimeout(() => splash.remove(), 350); }

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
