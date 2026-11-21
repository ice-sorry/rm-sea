/**
 * Audited drop-ins for setDoc / updateDoc / addDoc / deleteDoc / writeBatch.
 * Without Cloud Functions there are no audit triggers, so each write to an audited path commits an auditLog
 * entry in the same atomic batch. Firestore rules require the entry's actorUid to be the signed-in user.
 */
import {
  collection, doc, getDoc, serverTimestamp, writeBatch as fsWriteBatch, FieldValue,
  type CollectionReference, type DocumentReference, type DocumentData, type SetOptions,
} from 'firebase/firestore';
import { auth, call, db } from './firebase';

// Same routes as core/public.ts (importing it here would pull the op code into the public bundle).
const PUBLIC_PATHS = [/^(players|teams|seasons)\/[^/]+$/, /^seasons\/[^/]+\/(matches|entries|rosters|awards)\/[^/]+$/];
export const isPublicPath = (path: string) => PUBLIC_PATHS.some((r) => r.test(path));

/** Ask the Worker to copy these documents into their summaries (best effort; the write itself already succeeded). */
export async function syncPublicDocs(paths: string[]) {
  const all = [...new Set(paths.filter(isPublicPath))];
  // The op takes up to 50 paths per call.
  for (let i = 0; i < all.length; i += 50) await call('syncPublic')({ paths: all.slice(i, i + 50) }).catch(() => undefined);
}

const AUDITED = [
  /^players\/[^/]+$/, /^teams\/[^/]+$/, /^requests\/[^/]+$/, /^content\/[^/]+$/, /^settings\/[^/]+$/,
  /^cups\/[^/]+$/, /^cups\/[^/]+\/matches\/[^/]+$/, /^seasons\/[^/]+$/,
  /^seasons\/[^/]+\/(?!derived\/|powerRankings\/|predictions\/|wrapped\/)[^/]+\/[^/]+$/,
];
const audited = (path: string) => AUDITED.some((r) => r.test(path));

/** Replace write sentinels (serverTimestamp, arrayUnion…) with a readable marker for the log. */
function clean(v: unknown): unknown {
  if (v instanceof FieldValue) return '(server value)';
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => [k, clean(x)]));
  }
  return v;
}
function diffOf(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    if (['updatedAt', 'computedAt'].includes(k)) continue;
    const a = JSON.stringify(before?.[k] ?? null), b = JSON.stringify(after?.[k] ?? null);
    if (a !== b) diff[k] = { from: before?.[k] ?? null, to: after?.[k] ?? null };
  }
  return diff;
}

type Pending = { ref: DocumentReference; op: 'set' | 'merge' | 'update' | 'delete'; data?: DocumentData };

class AuditedBatch {
  private readonly inner = fsWriteBatch(db);
  private readonly pending: Pending[] = [];
  set(ref: DocumentReference<any>, data: DocumentData, opts?: SetOptions) {
    if (opts) this.inner.set(ref, data, opts); else this.inner.set(ref, data);
    this.pending.push({ ref, op: opts && 'merge' in opts && opts.merge ? 'merge' : 'set', data });
    return this;
  }
  update(ref: DocumentReference<any>, data: DocumentData) {
    this.inner.update(ref, data);
    this.pending.push({ ref, op: 'update', data });
    return this;
  }
  delete(ref: DocumentReference<any>) {
    this.inner.delete(ref);
    this.pending.push({ ref, op: 'delete' });
    return this;
  }
  async commit() {
    const user = auth.currentUser;
    const rows = this.pending.filter((p) => audited(p.ref.path));
    if (user && rows.length) {
      const befores = await Promise.all(rows.map((p) => getDoc(p.ref).then((s) => (s.exists() ? s.data() : null)).catch(() => null)));
      rows.forEach((p, i) => {
        const before = befores[i] as Record<string, unknown> | null;
        const data = clean(p.data || {}) as Record<string, unknown>;
        const after = p.op === 'delete' ? null : p.op === 'set' ? data : { ...(before || {}), ...data };
        const op = !before ? 'create' : p.op === 'delete' ? 'delete' : 'update';
        const diff = op === 'update' ? diffOf(before, after) : null;
        if (diff && !Object.keys(diff).length) return;
        this.inner.set(doc(collection(db, 'auditLog')), {
          at: serverTimestamp(), actorUid: user.uid, actorName: user.displayName || user.uid,
          kind: 'client', path: p.ref.path, op, before: op === 'create' ? null : before, after, diff, note: null,
        });
      });
    }
    await this.inner.commit();
    // Copy changed documents into the public summaries the site reads (core/public.ts).
    await syncPublicDocs(this.pending.map((p) => p.ref.path));
  }
}

/** Same call shape as firebase/firestore's writeBatch(db); the argument is ignored. */
export const writeBatch = (_db?: unknown) => new AuditedBatch();

export function setDoc(ref: DocumentReference<any>, data: DocumentData, opts?: SetOptions) {
  return writeBatch().set(ref, data, opts).commit();
}
export function updateDoc(ref: DocumentReference<any>, data: DocumentData) {
  return writeBatch().update(ref, data).commit();
}
export function deleteDoc(ref: DocumentReference<any>) {
  return writeBatch().delete(ref).commit();
}
export async function addDoc(col: CollectionReference<any>, data: DocumentData) {
  const ref = doc(col);
  await writeBatch().set(ref, data).commit();
  return ref;
}
