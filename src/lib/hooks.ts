import { useEffect, useState, useSyncExternalStore } from 'react';
import { doc, onSnapshot, Query, collection, query, QueryConstraint } from 'firebase/firestore';
import { db } from './firebase';

/** Live document. Pass null to skip. */
export function useDoc<T>(path: string | null): { data: (T & { id: string }) | null; loading: boolean } {
  const [state, set] = useState<{ data: (T & { id: string }) | null; loading: boolean }>({ data: null, loading: !!path });
  useEffect(() => {
    if (!path) { set({ data: null, loading: false }); return; }
    set((s) => ({ ...s, loading: true }));
    return onSnapshot(doc(db, path),
      (s) => set({ data: s.exists() ? ({ id: s.id, ...s.data() } as T & { id: string }) : null, loading: false }),
      () => set({ data: null, loading: false }));
  }, [path]);
  return state;
}

/** Live collection/query. `key` must change whenever the query changes. */
export function useQuery<T>(build: (() => Query) | null, key: string): { data: (T & { id: string })[]; loading: boolean } {
  const [state, set] = useState<{ data: (T & { id: string })[]; loading: boolean }>({ data: [], loading: !!build });
  useEffect(() => {
    if (!build) { set({ data: [], loading: false }); return; }
    set((s) => ({ ...s, loading: true }));
    return onSnapshot(build(),
      (s) => set({ data: s.docs.map((d) => ({ id: d.id, ...d.data() }) as T & { id: string }), loading: false }),
      () => set({ data: [], loading: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
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
