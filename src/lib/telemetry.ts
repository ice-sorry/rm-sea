import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, call, db } from './firebase';

const sessionId = (() => {
  try {
    let s = sessionStorage.getItem('srl_session');
    if (!s) { s = crypto.randomUUID(); sessionStorage.setItem('srl_session', s); }
    return s;
  } catch { return crypto.randomUUID(); }
})();

/** Capture up to 5 distinct client errors per session. */
export function installErrorReporting() {
  const seen = new Set<string>();
  const report = async (message: string, stack = '') => {
    if (seen.size >= 5) return;
    const hash = Array.from(new TextEncoder().encode(message + stack.slice(0, 200))).reduce((h, c) => ((h << 5) - h + c) | 0, 0).toString(36);
    if (seen.has(hash)) return;
    seen.add(hash);
    try {
      await setDoc(doc(db, 'clientErrors', `${sessionId}_${hash}`.replace(/[^\w-]/g, '')), {
        message: message.slice(0, 1500), stack: stack.slice(0, 4000), url: location.href.slice(0, 500), userAgent: navigator.userAgent.slice(0, 300),
        uid: auth.currentUser?.uid || null, sessionId, count: 1, firstAt: serverTimestamp(), lastAt: serverTimestamp(), hash,
      });
    } catch { /* never throw from the reporter */ }
  };
  window.addEventListener('error', (e) => report(e.message || 'error', e.error?.stack || ''));
  window.addEventListener('unhandledrejection', (e) => report(String(e.reason?.message || e.reason), e.reason?.stack || ''));
}

/** Count one unique visitor per browser per UTC day. */
export function trackVisitOnce() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem('srl_visit') === day) return;
    let vid = localStorage.getItem('srl_vid');
    if (!vid) { vid = crypto.randomUUID(); localStorage.setItem('srl_vid', vid); }
    call<{ visitorId: string }, unknown>('trackVisit')({ visitorId: vid })
      .then(() => localStorage.setItem('srl_visit', day)).catch(() => undefined);
  } catch { /* storage blocked */ }
}
