/**
 * Host-agnostic runtime for the league "operations" (the former Cloud Functions).
 * The same code runs in the Cloudflare Worker (service account, secrets) and in an admin's browser
 * (their Firebase ID token, security rules apply). Hosts wire in db / config / identity at startup.
 */
import type { Firestore } from './firestore';

/** Live binding: importers always see the db the host installed. */
export let db: Firestore;
export function useDb(d: Firestore) { db = d; }

// ---------- config & secrets (Worker env vars; empty in the browser) ----------
const config: Record<string, string> = {};
export function configure(vars: Record<string, unknown>) {
  for (const [k, v] of Object.entries(vars)) if (typeof v === 'string') config[k] = v;
}
export const param = (name: string, fallback = '') => ({ value: () => config[name] || fallback });

// ---------- identity (Worker only: needs the service account) ----------
export interface Identity {
  /** Ensure the Firebase Auth user exists and set its custom claims. */
  applyClaims(uid: string, claims: Record<string, unknown>, profile?: { displayName?: string; photoURL?: string }): Promise<void>;
  createCustomToken(uid: string): Promise<string>;
}
export let identity: Identity = {
  applyClaims: async () => { throw new HttpsError('failed-precondition', 'Identity is only available in the Worker.'); },
  createCustomToken: async () => { throw new HttpsError('failed-precondition', 'Identity is only available in the Worker.'); },
};
export function useIdentity(i: Identity) { identity = i; }

// ---------- cross-host calls (browser op → Worker op, or Worker → itself) ----------
export type Invoke = (name: string, data: unknown) => Promise<any>;
export let invoke: Invoke = async (name) => { throw new Error(`No host to run ${name}`); };
export function useInvoke(fn: Invoke) { invoke = fn; }

// ---------- callable shape (mirrors firebase-functions so the op code stays familiar) ----------
export interface CallableRequest<T = any> {
  data: T;
  auth?: { uid: string; token: Record<string, unknown> };
}
export type Handler = (req: CallableRequest) => Promise<unknown>;

/** `onCall(handler)` or `onCall(options, handler)` — options are accepted and ignored. */
export function onCall(handler: Handler): Handler;
export function onCall(options: Record<string, unknown>, handler: Handler): Handler;
export function onCall(a: Handler | Record<string, unknown>, b?: Handler): Handler {
  return (b ?? a) as Handler;
}

const STATUS: Record<string, number> = {
  'invalid-argument': 400, 'failed-precondition': 412, 'out-of-range': 400, unauthenticated: 401, 'permission-denied': 403,
  'not-found': 404, 'already-exists': 409, aborted: 409, 'resource-exhausted': 429, cancelled: 499, unimplemented: 501,
  internal: 500, unavailable: 503, 'deadline-exceeded': 504, unknown: 500,
};
export class HttpsError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HttpsError'; }
  get httpStatus() { return STATUS[this.code] ?? 500; }
}

export const logger = {
  info: (...a: unknown[]) => console.log(...a),
  warn: (...a: unknown[]) => console.warn(...a),
  error: (...a: unknown[]) => console.error(...a),
};

/** Paged operations return { done: false, cursor } until finished; hosts loop and sum the numeric fields. */
export interface Paged { done: boolean; cursor?: unknown }
