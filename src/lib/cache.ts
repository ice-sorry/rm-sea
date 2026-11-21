/**
 * Session cache for one-off reads (awards, career lines, past seasons' matches and stats). Pages that fetch these
 * on mount would otherwise read them from the server again every time you navigate back. Entries expire after a
 * few minutes; admins pass ttl 0 so changes they just made show at once.
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { db } from './firebase';
import { useLeague } from './league';
import type { Award, MatchDoc, PlayerStatRow } from './types';

const DEFAULT_TTL = 5 * 60_000;
const store = new Map<string, { at: number; p: Promise<unknown> }>();

export function cached<T>(key: string, load: () => Promise<T>, ttlMs = DEFAULT_TTL): Promise<T> {
  const hit = store.get(key);
  if (hit && ttlMs > 0 && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
  const p = load();
  store.set(key, { at: Date.now(), p });
  p.catch(() => store.delete(key));
  return p;
}

/** Load once per key (through the cache); null while loading. Put everything the loader depends on in the key. */
export function useCached<T>(key: string | null, load: () => Promise<T>, ttlMs = DEFAULT_TTL): T | null {
  const [state, set] = useState<{ key: string | null; value: T | null }>({ key: null, value: null });
  useEffect(() => {
    if (!key) return;
    let live = true;
    cached(key, load, ttlMs).then((value) => { if (live) set({ key, value }); }, () => { if (live) set({ key, value: null }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state.value : null;
}

/** A summary document (core/public.ts) when it's built and not overflowed, otherwise null. */
async function summary(path: string): Promise<Record<string, any> | null> {
  const d = (await getDoc(doc(db, path))).data();
  return d && !d.overflow ? d : null;
}

/** Every season's awards: derived/awards (1 read), or each season's awards collection until it's built. */
export function loadAwards(seasonIds: string[], ttl?: number): Promise<Record<string, Award[]>> {
  return cached(`awards|${seasonIds.join(',')}`, async () => {
    const s = await summary('derived/awards');
    if (s?.items) {
      const items = s.items as Record<string, Record<string, Omit<Award, 'id'>>>;
      return Object.fromEntries(seasonIds.map((sid) => [sid, Object.entries(items[sid] || {}).map(([id, a]) => ({ ...a, id }) as Award)]));
    }
    return Object.fromEntries(await Promise.all(seasonIds.map(async (sid) =>
      [sid, (await getDocs(collection(db, `seasons/${sid}/awards`))).docs.map((d) => ({ ...d.data(), id: d.id }) as Award)] as const)));
  }, ttl);
}

/** Every season's awards for the current season list, with the season name on each; null while loading. */
export function useAllAwards(): (Award & { seasonId: string; seasonName: string })[] | null {
  const L = useLeague();
  const ids = L.seasons.map((s) => s.id);
  const ttl = L.isAdmin ? 0 : undefined;
  const bySeason = useCached(`awards|${ids.join(',')}`, () => loadAwards(ids, ttl), ttl);
  return useMemo(() => bySeason && L.seasons.flatMap((s) => (bySeason[s.id] || []).map((a) => ({ ...a, seasonId: s.id, seasonName: s.name }))), [bySeason, L.seasons]);
}

/** A season's matches: its match-list summary (1 read), or the matches collection until it's built. */
export function loadSeasonMatches(seasonId: string, ttl?: number): Promise<MatchDoc[]> {
  return cached(`matches|${seasonId}`, async () => {
    const s = await summary(`seasons/${seasonId}/derived/matchList`);
    if (s?.items) return Object.entries(s.items as Record<string, Omit<MatchDoc, 'id'>>).map(([id, m]) => ({ ...m, id }) as MatchDoc);
    return (await getDocs(collection(db, `seasons/${seasonId}/matches`))).docs.map((d) => ({ ...d.data(), id: d.id }) as MatchDoc);
  }, ttl);
}

/** A season's player stat rows. */
export function loadPlayerStats(seasonId: string, ttl?: number): Promise<PlayerStatRow[]> {
  return cached(`playerStats|${seasonId}`, async () =>
    ((await getDoc(doc(db, `seasons/${seasonId}/derived/playerStats`))).data()?.rows || []) as PlayerStatRow[], ttl);
}

export interface CareerLine { s: string; t: string | null; gp: number; g: number; a: number; sv: number; m: number }
/**
 * One player's season-by-season line: derived/careers (1 read, shared by every player page), or each season's
 * player stats until the records job has built it.
 */
export function loadCareer(playerId: string, seasonIds: string[], ttl?: number): Promise<CareerLine[]> {
  return cached(`career|${playerId}|${seasonIds.join(',')}`, async () => {
    const all = await cached('careers', () => summary('derived/careers'), ttl);
    if (all?.players) return ((all.players as Record<string, CareerLine[]>)[playerId] || []);
    const rows = await Promise.all(seasonIds.map(async (s) => {
      const r = (await loadPlayerStats(s, ttl)).find((x) => x.playerId === playerId);
      return r ? { s, t: r.teamId, gp: r.gp, g: r.goals, a: r.assists, sv: r.saves, m: r.mvps } : null;
    }));
    return rows.filter((r): r is CareerLine => !!r);
  }, ttl);
}
