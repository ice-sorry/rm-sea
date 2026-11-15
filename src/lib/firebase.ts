import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { BROWSER_OP_NAMES } from '../../core/opnames';

const env = import.meta.env;
export const USE_EMULATORS = env.VITE_USE_EMULATORS === 'true';
const projectId = env.VITE_FIREBASE_PROJECT_ID || 'rm-sea';
const host = typeof location !== 'undefined' ? location.hostname : 'localhost';

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
  projectId,
  appId: env.VITE_FIREBASE_APP_ID || 'demo-app',
});
export const auth = getAuth(app);
export const db = getFirestore(app);

if (USE_EMULATORS) {
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
}

/** Cloudflare Worker base URL (Discord sign-in, bot, webhooks, cross-user actions). */
export const API_URL = (env.VITE_API_URL || (USE_EMULATORS ? `http://${host}:8787` : '')).replace(/\/+$/, '');

class CallError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** POST /api/<name> on the Worker with the user's ID token. */
async function remote(name: string, data: unknown): Promise<any> {
  if (!API_URL) throw new CallError('failed-precondition', 'VITE_API_URL is not set — deploy the Worker and add its URL to .env.production.');
  const token = await auth.currentUser?.getIdToken();
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ data }),
    });
  } catch {
    throw new CallError('unavailable', 'Could not reach the league API. Check your connection and try again.');
  }
  const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { code: string; message: string } };
  if (!res.ok || body.error) throw new CallError(body.error?.code || 'internal', body.error?.message || `Request failed (${res.status}).`);
  return body.result;
}

/** Browser ops run here with the admin's own credentials; the core code is loaded on first use. */
let local: Promise<(name: string, data: unknown) => Promise<unknown>> | null = null;
function localRunner() {
  local ??= (async () => {
    const [{ Firestore }, runtime, { BROWSER_OPS }] = await Promise.all([
      import('../../core/firestore'), import('../../core/runtime'), import('../../core/index'),
    ]);
    runtime.useDb(new Firestore({
      projectId,
      token: async () => (await auth.currentUser?.getIdToken()) ?? null,
      emulatorHost: USE_EMULATORS ? `${host}:8080` : undefined,
    }));
    runtime.useInvoke(remote);
    return async (name: string, data: unknown) => {
      const user = auth.currentUser;
      const claims = user ? (await user.getIdTokenResult()).claims : undefined;
      return BROWSER_OPS[name]({ data, auth: user ? { uid: user.uid, token: claims as Record<string, unknown> } : undefined });
    };
  })();
  return local;
}

/** Paged ops return { done: false, cursor }: call again until done, summing numeric counters. */
async function runPaged(run: (data: unknown) => Promise<any>, data: unknown) {
  const totals: Record<string, number> = {};
  let extra: Record<string, unknown> = {};
  for (let i = 0; i < 500; i++) {
    const r = await run({ ...(data as object), ...extra });
    if (!r || typeof r !== 'object' || !('done' in r)) return r;
    for (const [k, v] of Object.entries(r)) if (typeof v === 'number' && k !== 'cursor') totals[k] = (totals[k] || 0) + v;
    if (r.done) return { ...r, ...totals };
    extra = r.cursor === undefined || r.cursor === null ? {} : { cursor: r.cursor };
  }
  throw new CallError('deadline-exceeded', 'Operation did not finish.');
}

/** Typed operation call — routes to the Worker or runs in the browser. */
export function call<Req = unknown, Res = unknown>(name: string) {
  return async (data: Req): Promise<Res> => {
    if (BROWSER_OP_NAMES.has(name)) {
      const run = await localRunner();
      return (await runPaged((d) => run(name, d), data)) as Res;
    }
    return (await runPaged((d) => remote(name, d), data)) as Res;
  };
}
