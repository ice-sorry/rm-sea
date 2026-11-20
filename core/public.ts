/**
 * Public summaries: derived/players, derived/teams and derived/seasons each hold a copy of every document in that
 * collection as { items: { [id]: data } }. The site listens to these 3 documents instead of the whole collections,
 * so a visit costs 3 reads however big the league gets.
 *
 * Every write to players/*, teams/* or seasons/* copies the document's new state into its summary:
 *  - writes made by ops (Worker or admin browser) go through Firestore._commit, which calls installPublicSync's hook;
 *  - writes made with the browser SDK (src/lib/db.ts) call the syncPublic op afterwards.
 * recomputeAll rebuilds the summaries from scratch, which also creates them the first time.
 */
import { onCall, HttpsError, logger } from './runtime';
import { db, FieldValue, requireAuth } from './admin';
import type { Firestore } from './firestore';

export const PUBLIC_COLLECTIONS = ['players', 'teams', 'seasons'] as const;
const PUBLIC_DOC = /^(players|teams|seasons)\/[^/]+$/;
export const isPublicPath = (path: string) => PUBLIC_DOC.test(path);

/** Copy these documents' current state into their summaries, removing deleted ones. Skips a summary that isn't built yet. */
export async function syncPublicPaths(paths: string[]) {
  const uniq = [...new Set(paths.filter(isPublicPath))];
  if (!uniq.length) return;
  const snaps = await db.getAll(...uniq.map((p) => db.doc(p)));
  const byCol = new Map<string, Record<string, unknown>>();
  snaps.forEach((s, i) => {
    const [col, id] = uniq[i].split('/');
    const patch = byCol.get(col) || {};
    // "items.<id>" replaces that entry as a whole, so fields removed from the document are removed here too.
    patch[`items.${id}`] = s.exists ? s.data() : FieldValue.delete();
    byCol.set(col, patch);
  });
  for (const [col, patch] of byCol) {
    try {
      await db.doc(`derived/${col}`).update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
    } catch (e) {
      // Not built yet: the site reads the collection directly until recomputeAll builds it.
      logger.warn(`public summary derived/${col} not updated`, e);
    }
  }
}

/** Rebuild every summary from its collection. Reads every player, team and season, so it runs with recomputeAll. */
export async function rebuildPublic() {
  for (const col of PUBLIC_COLLECTIONS) {
    const docs = (await db.collection(col).get()).docs;
    await db.doc(`derived/${col}`).set({ items: Object.fromEntries(docs.map((d) => [d.id, d.data()])), updatedAt: FieldValue.serverTimestamp() });
  }
}

/** Hosts call this after useDb so every committed write to a public document updates its summary. */
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
