import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { doc, onSnapshot, Query, collection, query, queryEqual, QueryConstraint } from 'firebase/firestore';
import { db } from './firebase';

// ---------- Shared listeners, kept for the tab's lifetime ----------
// Every useDoc / useQuery goes through this registry. Components asking for the same document or query share one
// Firestore listener, and when the last one unmounts (you leave the page) the listener is kept running instead of
// stopped. Coming back to the page shows the data at once and costs no reads; while it stays open, only actual
// changes are read. Everything lives in memory, so closing the tab clears it.
//  - A listener nobody has used for IDLE_RELEASE_MS is stopped, so opening many pages (or match windows) doesn't
//    leave an ever-growing set of listeners.
//  - In a tab hidden for HIDDEN_PAUSE_MS, every listener stops (unused ones are dropped). When the tab is shown
//    again, the ones still on screen restart with fresh data.
const IDLE_RELEASE_MS = 30 * 60_000;
const HIDDEN_PAUSE_MS = 10 * 60_000;

interface Snap<T> { data: T; loading: boolean }
interface Entry {
  /** Document path, or the query (matched with queryEqual). */
  path?: string;
  q?: Query;
  start: (emit: (s: Snap<unknown>) => void, fail: () => void) => () => void;
  state: Snap<unknown> | null;
  subs: Set<(s: Snap<unknown>) => void>;
  stop: (() => void) | null;
  idle?: ReturnType<typeof setTimeout>;
}
const entries = new Set<Entry>();
let paused = false;

function run(e: Entry) {
  if (e.stop || paused) return;
  const emit = (s: Snap<unknown>) => { e.state = s; e.subs.forEach((cb) => cb(s)); };
  // A failed listener (e.g. permission denied before sign-in finished) is dead: forget it so the next
  // component that asks starts a fresh one.
  e.stop = e.start(emit, () => { e.stop = null; entries.delete(e); clearTimeout(e.idle); });
}
function drop(e: Entry) {
  clearTimeout(e.idle);
  e.stop?.();
  e.stop = null;
  entries.delete(e);
}
/** Find the shared entry for this document/query, creating it if needed, and register a subscriber. */
function retain(match: (e: Entry) => boolean, create: () => Entry, cb: (s: Snap<unknown>) => void): { entry: Entry; release: () => void } {
  let e = [...entries].find(match);
  if (!e) { e = create(); entries.add(e); }
  clearTimeout(e.idle);
  e.subs.add(cb);
  run(e);
  const entry = e;
  return {
    entry,
    release: () => {
      entry.subs.delete(cb);
      if (entry.subs.size || !entries.has(entry)) return;
      entry.idle = setTimeout(() => drop(entry), IDLE_RELEASE_MS);
    },
  };
}

if (typeof document !== 'undefined') {
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  const resume = () => {
    clearTimeout(pauseTimer);
    if (!paused || document.hidden) return;
    paused = false;
    entries.forEach(run);
  };
  // Backup for a missed visibilitychange (a restored or uncovered window, a page back from the back/forward
  // cache): while paused, new listeners never start, so a newly opened match would never load.
  window.addEventListener('focus', resume);
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', () => {
    clearTimeout(pauseTimer);
    if (document.hidden) {
      pauseTimer = setTimeout(() => {
        paused = true;
        for (const e of [...entries]) {
          if (!e.subs.size) drop(e); // not on screen: restarting it later would cost reads for nothing
          else { e.stop?.(); e.stop = null; } // on screen: keep showing what we have
        }
      }, HIDDEN_PAUSE_MS);
    } else resume();
  });
}

/** Subscribe a component to a shared entry; keeps the last data while a new path/query loads. */
function useShared<T>(key: string, acquire: ((cb: (s: Snap<unknown>) => void) => { entry: Entry; release: () => void }) | null, empty: T): Snap<T> {
  const [state, set] = useState<Snap<T>>({ data: empty, loading: !!acquire });
  const last = useRef(key);
  useEffect(() => {
    const changed = last.current !== key;
    last.current = key;
    if (!acquire) { set({ data: empty, loading: false }); return; }
    const { entry, release } = acquire((s) => set(s as Snap<T>));
    // Already loaded (a page you visited before): show it at once. Otherwise keep the old data until it arrives.
    if (entry.state) set(entry.state as Snap<T>);
    else if (changed) set((s) => ({ ...s, loading: true }));
    return release;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

/** Live document. Pass null to skip. */
export function useDoc<T>(path: string | null): { data: (T & { id: string }) | null; loading: boolean } {
  return useShared<(T & { id: string }) | null>(`doc|${path}`, path ? (cb) => retain((e) => e.path === path, () => ({
    path, state: null, subs: new Set(), stop: null,
    start: (emit, fail) => onSnapshot(doc(db, path),
      (s) => emit({ data: s.exists() ? { id: s.id, ...s.data() } : null, loading: false }),
      () => { emit({ data: null, loading: false }); fail(); }),
  }), cb) : null, null);
}

/** Live collection/query. `key` must change whenever the query changes. */
export function useQuery<T>(build: (() => Query) | null, key: string): { data: (T & { id: string })[]; loading: boolean } {
  return useShared<(T & { id: string })[]>(`query|${key}`, build ? (cb) => {
    const q = build();
    return retain((e) => !!e.q && queryEqual(e.q, q), () => ({
      q, state: null, subs: new Set(), stop: null,
      start: (emit, fail) => onSnapshot(q,
        (s) => emit({ data: s.docs.map((d) => ({ id: d.id, ...d.data() })), loading: false }),
        () => { emit({ data: [], loading: false }); fail(); }),
    }), cb);
  } : null, []);
}
export function useCol<T>(path: string | null, ...constraints: QueryConstraint[]) {
  return useQuery<T>(path ? () => query(collection(db, path), ...constraints) : null, `${path}|${constraints.length}`);
}

// ---------- Hash router ----------
function subscribe(cb: () => void) { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); }
const snapshot = () => location.hash.replace(/^#\/?/, '');
/** Returns [route, sub, params] from "#route/sub?x=1". */
export function useHash(): [string, string, URLSearchParams] {
  const h = useSyncExternalStore(subscribe, snapshot);
  const [path, qs = ''] = h.split('?');
  const [route = 'home', ...rest] = path.split('/');
  return [route || 'home', rest.join('/'), new URLSearchParams(qs)];
}
export const go = (hash: string) => { location.hash = hash.startsWith('#') ? hash : `#${hash}`; };

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial; } catch { return initial; }
  });
  return [v, (nv: T) => { setV(nv); try { localStorage.setItem(key, JSON.stringify(nv)); } catch { /* ignore */ } }];
}
