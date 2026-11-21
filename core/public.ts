/**
 * Public summaries: one document holding a copy of every document in a collection, so the site reads 1 document
 * instead of the whole collection.
 *
 *   players/{id}                → derived/players            items.{id}
 *   teams/{id}                  → derived/teams              items.{id}
 *   seasons/{id}                → derived/seasons            items.{id}
 *   seasons/{s}/matches/{id}    → seasons/{s}/derived/matchList  items.{id}
 *   seasons/{s}/entries/{team}  → seasons/{s}/derived/squads     entries.{team}
 *   seasons/{s}/rosters/{team}  → seasons/{s}/derived/squads     rosters.{team}
 *   seasons/{s}/awards/{id}     → derived/awards             items.{s}.{id}
 *
 * Every write to a summarised document copies its new state into the summary:
 *  - writes made by ops (Worker or admin browser) go through Firestore._commit, which calls installPublicSync's hook;
 *  - writes made with the browser SDK (src/lib/db.ts, MatchModal) call the syncPublic op afterwards.
 * recomputeAll rebuilds every summary from scratch, which also creates them the first time; recomputeSeason
 * rewrites its season's match list on every result. Until a summary exists, or once it has grown past
 * Firestore's 1 MB document limit ({ overflow: true }), the site reads the collection directly.
 */
import { onCall, HttpsError, logger } from './runtime';
import { db, FieldValue, requireAuth } from './admin';
import type { Firestore } from './firestore';

export const PUBLIC_COLLECTIONS = ['players', 'teams', 'seasons'] as const;

interface Target { doc: string; field: string }
const ROUTES: [RegExp, (m: RegExpMatchArray) => Target][] = [
  [/^(players|teams|seasons)\/([^/]+)$/, (m) => ({ doc: `derived/${m[1]}`, field: `items.${m[2]}` })],
  [/^seasons\/([^/]+)\/matches\/([^/]+)$/, (m) => ({ doc: `seasons/${m[1]}/derived/matchList`, field: `items.${m[2]}` })],
  [/^seasons\/([^/]+)\/(entries|rosters)\/([^/]+)$/, (m) => ({ doc: `seasons/${m[1]}/derived/squads`, field: `${m[2]}.${m[3]}` })],
  [/^seasons\/([^/]+)\/awards\/([^/]+)$/, (m) => ({ doc: 'derived/awards', field: `items.${m[1]}.${m[2]}` })],
];
function targetOf(path: string): Target | null {
  for (const [re, to] of ROUTES) { const m = path.match(re); if (m) return to(m); }
  return null;
}
export const isPublicPath = (path: string) => !!targetOf(path);

/** Stay well under Firestore's 1 MiB document limit (the JSON size is a rough stand-in for the stored size). */
const MAX_SUMMARY_BYTES = 900_000;
const tooBig = (data: unknown) => JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? String(v) : v)).length > MAX_SUMMARY_BYTES;
const isSizeError = (e: unknown) => /exceed|too (large|big)|maximum size|1048576|1 ?MiB/i.test(String((e as Error)?.message || e));

/** Write a whole summary, or mark it overflowed (the site then reads the collection) when it would be too big. */
export async function writeSummary(docPath: string, data: Record<string, unknown>) {
  const ref = db.doc(docPath);
  if (tooBig(data)) {
    logger.warn(`public summary ${docPath} is too big; the site reads the collection instead`);
    await ref.set({ overflow: true, updatedAt: FieldValue.serverTimestamp() });
    return;
  }
  await ref.set({ ...data, updatedAt: FieldValue.serverTimestamp() });
}

/** Copy these documents' current state into their summaries, removing deleted ones. Skips a summary that isn't built yet. */
export async function syncPublicPaths(paths: string[]) {
  const uniq = [...new Set(paths)].filter(isPublicPath);
  if (!uniq.length) return;
  const snaps = await db.getAll(...uniq.map((p) => db.doc(p)));
  const bySummary = new Map<string, Record<string, unknown>>();
  snaps.forEach((s, i) => {
    const t = targetOf(uniq[i])!;
    const patch = bySummary.get(t.doc) || {};
    // The field path replaces that entry as a whole, so fields removed from the document are removed here too.
    patch[t.field] = s.exists ? s.data() : FieldValue.delete();
    bySummary.set(t.doc, patch);
  });
  for (const [docPath, patch] of bySummary) {
    try {
      await db.doc(docPath).update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
    } catch (e) {
      if (isSizeError(e)) {
        logger.warn(`public summary ${docPath} hit the size limit; the site reads the collection instead`);
        await db.doc(docPath).set({ overflow: true, updatedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
      } else {
        // Not built yet: the site reads the collection directly until it is.
        logger.warn(`public summary ${docPath} not updated`, e);
      }
    }
  }
}

const itemsOf = (docs: { id: string; data(): unknown }[]) => Object.fromEntries(docs.map((d) => [d.id, d.data()]));

/** Rebuild one season's squads (entries + rosters) and, unless told to skip it, its match list. */
export async function rebuildSeasonSummaries(seasonId: string, withMatches = true) {
  const [entries, rosters] = await Promise.all(['entries', 'rosters'].map((c) => db.collection(`seasons/${seasonId}/${c}`).get()));
  await writeSummary(`seasons/${seasonId}/derived/squads`, { entries: itemsOf(entries.docs), rosters: itemsOf(rosters.docs) });
  if (withMatches) await writeSummary(`seasons/${seasonId}/derived/matchList`, { items: itemsOf((await db.collection(`seasons/${seasonId}/matches`).get()).docs) });
}

/**
 * Rebuild every summary from its collection. Reads everything, so it runs with recomputeAll.
 * `matchListsDone`: seasons whose match list was just rewritten (by recomputeSeason), so it isn't read again.
 */
export async function rebuildPublic(matchListsDone: Set<string> = new Set()) {
  const seasonIds: string[] = [];
  for (const col of PUBLIC_COLLECTIONS) {
    const docs = (await db.collection(col).get()).docs;
    if (col === 'seasons') seasonIds.push(...docs.map((d) => d.id));
    await writeSummary(`derived/${col}`, { items: itemsOf(docs) });
  }
  const awards: Record<string, unknown> = {};
  for (const s of seasonIds) {
    await rebuildSeasonSummaries(s, !matchListsDone.has(s));
    awards[s] = itemsOf((await db.collection(`seasons/${s}/awards`).get()).docs);
  }
  await writeSummary('derived/awards', { items: awards });
}

/** Hosts call this after useDb so every committed write to a summarised document updates its summary. */
export function installPublicSync(d: Firestore) {
  d.onCommitted = async (paths) => {
    if (paths.some(isPublicPath)) await syncPublicPaths(paths).catch((e) => logger.warn('public summary sync failed', e));
  };
}

/** Browser SDK writes (src/lib/db.ts) ask for their documents to be copied. It only copies stored data, so anyone signed in may ask. */
export const syncPublic = onCall(async (req) => {
  requireAuth(req);
  const paths = ((req.data?.paths as unknown[]) || []).filter((p): p is string => typeof p === 'string' && isPublicPath(p));
  if (paths.length > 50) throw new HttpsError('invalid-argument', 'Too many paths.');
  await syncPublicPaths(paths);
  return { synced: paths.length };
});
