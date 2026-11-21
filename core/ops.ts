import { onCall, HttpsError } from './runtime';
import type { CollectionReference, DocumentData } from './firestore';
import { db, FieldValue, Timestamp, requireAdmin, requireOwner, auditNote, chunk } from './admin';
import { recomputeSeason, recomputeSeasonBrackets, recomputeRecords } from './derive';

// ---------- Visitor analytics ----------
async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const trackVisit = onCall(async (req) => {
  const visitorId = String(req.data?.visitorId || '').slice(0, 64);
  if (!visitorId) throw new HttpsError('invalid-argument', 'visitorId required.');
  const day = new Date().toISOString().slice(0, 10);
  const hash = (await sha256Hex(`${visitorId}|${day}`)).slice(0, 32);
  const dayRef = db.doc(`analytics/${day}`);
  const visRef = dayRef.collection('visitors').doc(hash);
  await db.runTransaction(async (tx) => {
    const v = await tx.get(visRef);
    if (v.exists) return;
    tx.set(visRef, { at: FieldValue.serverTimestamp() });
    tx.set(dayRef, { uniques: FieldValue.increment(1), day }, { merge: true });
  });
  return { ok: true };
});

// ---------- Backup / restore ----------
// Browsers can't list collections, so backups walk the app's known schema.
const TOP = ['players', 'teams', 'users', 'seasons', 'requests', 'cups', 'content', 'settings', 'private', 'derived'];
const SEASON_SUBS = ['matches', 'rosters', 'entries', 'transfers', 'playoffs', 'awards', 'ratings', 'matchweeks', 'derived', 'powerRankings', 'predictions', 'wrapped'];
const CHUNK_CHARS = 200_000; // ≤ ~800 KB per chunk doc even with multi-byte characters (doc limit is 1 MiB)

type Ser = unknown;
function serialize(v: unknown): Ser {
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (Array.isArray(v)) return v.map(serialize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, serialize(x)]));
  return v;
}
function deserialize(v: Ser): unknown {
  if (Array.isArray(v)) return v.map(deserialize);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.__ts === 'number') return Timestamp.fromMillis(o.__ts);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, deserialize(x)]));
  }
  return v;
}

async function dump(col: CollectionReference, out: Record<string, Ser>) {
  const snap = await col.get();
  for (const d of snap.docs) out[d.ref.path] = serialize(d.data());
  return snap.docs;
}

export async function collectBackup(): Promise<Record<string, Ser>> {
  const docs: Record<string, Ser> = {};
  for (const name of TOP) {
    const rows = await dump(db.collection(name), docs);
    if (name === 'seasons') {
      for (const s of rows) {
        await Promise.all(SEASON_SUBS.map((sub) => dump(s.ref.collection(sub), docs)));
      }
    }
    if (name === 'cups') for (const c of rows) await dump(c.ref.collection('matches'), docs);
  }
  return docs;
}

/** Store a restore point as chunked docs in restorePoints/{id}/chunks and return the JSON for download. */
export async function runBackup(reason: string) {
  const docs = await collectBackup();
  const json = JSON.stringify({ createdAt: Date.now(), docs });
  const ref = db.collection('restorePoints').doc();
  const counts: Record<string, number> = {};
  for (const p of Object.keys(docs)) {
    const parts = p.split('/');
    const key = parts.length > 2 ? `${parts[0]}/*/${parts[parts.length - 2]}` : parts[0];
    counts[key] = (counts[key] || 0) + 1;
  }
  const parts: string[] = [];
  for (let i = 0; i < json.length; i += CHUNK_CHARS) parts.push(json.slice(i, i + CHUNK_CHARS));
  for (const group of chunk(parts.map((data, i) => ({ data, i })), 8)) {
    const b = db.batch();
    group.forEach(({ data, i }) => b.set(ref.collection('chunks').doc(String(i).padStart(4, '0')), { data }));
    await b.commit();
  }
  await ref.set({ createdAt: FieldValue.serverTimestamp(), reason, counts, total: Object.keys(docs).length, chunks: parts.length });
  return { id: ref.id, total: Object.keys(docs).length, json };
}

/** Runs in the admin's browser; the page also offers the returned JSON as a download. */
export const backupNow = onCall(async (req) => {
  const uid = requireAdmin(req);
  const r = await runBackup(`manual by ${uid}`);
  await auditNote(uid, `Manual backup (${r.total} docs)`, `restorePoints/${r.id}`);
  return r;
});

async function loadPoint(pointId: string): Promise<Record<string, Ser>> {
  const point = await db.doc(`restorePoints/${pointId}`).get();
  if (!point.exists) throw new HttpsError('not-found', 'Restore point not found.');
  const chunks = await db.collection(`restorePoints/${pointId}/chunks`).get();
  if (!chunks.size) throw new HttpsError('failed-precondition', 'This restore point has no stored data (made before the free-plan migration).');
  const json = chunks.docs.sort((a, b) => a.id.localeCompare(b.id)).map((d) => d.data().data as string).join('');
  return (JSON.parse(json) as { docs: Record<string, Ser> }).docs;
}

/** Re-create only documents missing from live data — never overwrites. Owner only; runs in the browser.
 *  Source: a stored restore point (pointId) or an uploaded backup file (docs). */
export const restoreMissing = onCall(async (req) => {
  const uid = requireOwner(req);
  const { pointId, docs: uploaded, dryRun = false } = req.data as { pointId?: string; docs?: Record<string, Ser>; dryRun?: boolean };
  const docs = uploaded || (pointId ? await loadPoint(pointId) : null);
  if (!docs) throw new HttpsError('invalid-argument', 'Pick a restore point or a backup file.');
  const paths = Object.keys(docs);
  const missing: string[] = [];
  for (const group of chunk(paths, 100)) {
    const snaps = await db.getAll(...group.map((p) => db.doc(p)));
    snaps.forEach((s, i) => { if (!s.exists) missing.push(group[i]); });
  }
  if (!dryRun) {
    for (const group of chunk(missing, 400)) {
      const b = db.batch();
      group.forEach((p) => b.create(db.doc(p), deserialize(docs[p]) as DocumentData));
      await b.commit();
    }
    await auditNote(uid, `Restored ${missing.length} missing docs from ${pointId || 'an uploaded file'}`, pointId ? `restorePoints/${pointId}` : '');
  }
  return { checked: paths.length, missing: missing.length, restored: dryRun ? 0 : missing.length, sample: missing.slice(0, 20) };
});

// ---------- Merge duplicates ----------
function deepReplace(v: unknown, from: string, to: string): unknown {
  if (v === from) return to;
  if (v instanceof Timestamp || v instanceof FieldValue) return v;
  if (Array.isArray(v)) {
    const arr = v.map((x) => deepReplace(x, from, to));
    return arr.every((x) => typeof x === 'string') ? [...new Set(arr as string[])] : arr;
  }
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const nk = k === from ? to : k;
      o[nk] = deepReplace(x, from, to);
    }
    return o;
  }
  return v;
}

/** Rewrite fixtures, results, rosters and allowlists from removeId to keepId, then tombstone the removed doc. Owner only; runs in the browser. */
export const mergeEntities = onCall(async (req) => {
  const uid = requireOwner(req);
  const { kind, removeId, keepId } = req.data as { kind: 'player' | 'team'; removeId: string; keepId: string };
  if (!removeId || !keepId || removeId === keepId) throw new HttpsError('invalid-argument', 'Pick two different records.');
  const base = kind === 'player' ? 'players' : 'teams';
  const [rem, keep] = await db.getAll(db.doc(`${base}/${removeId}`), db.doc(`${base}/${keepId}`));
  if (!rem.exists || !keep.exists) throw new HttpsError('not-found', 'Record missing.');
  await runBackup(`pre-merge ${kind} ${removeId}→${keepId}`);

  let rewritten = 0, moved = 0;
  const seasons = await db.collection('seasons').get();
  const cols: CollectionReference[] = [db.collection('requests'), db.collection('teams'), db.collection('users'), db.collection('players'), db.collection('cups')];
  for (const s of seasons.docs) for (const c of ['matches', 'rosters', 'entries', 'transfers', 'awards', 'playoffs', 'ratings']) cols.push(s.ref.collection(c));
  for (const c of (await db.collection('cups').get()).docs) cols.push(c.ref.collection('matches'));

  for (const col of cols) {
    const snap = await col.get();
    for (const d of snap.docs) {
      if (d.ref.path === `${base}/${removeId}`) continue;
      const data = d.data();
      const next = deepReplace(data, removeId, keepId) as DocumentData;
      const changed = JSON.stringify(serialize(next)) !== JSON.stringify(serialize(data));
      if (d.id === removeId) {
        // Doc keyed by the removed id (rosters/entries/ratings) — move or merge into the kept id.
        const target = col.doc(keepId);
        const t = await target.get();
        if (t.exists && Array.isArray(next.playerIds)) {
          await target.update({ playerIds: [...new Set([...(t.data()!.playerIds || []), ...next.playerIds])] });
        } else if (!t.exists) await target.set(next);
        await d.ref.delete();
        moved++;
      } else if (changed) { await d.ref.set(next); rewritten++; }
    }
  }
  const removedData = rem.data()!;
  const keepPatch: Record<string, unknown> = {};
  if (kind === 'player') {
    for (const k of ['discordId', 'ownerUid', 'avatarUrl', 'bio', 'country']) if (!keep.data()![k] && removedData[k]) keepPatch[k] = removedData[k];
    await db.doc(`players/${removeId}`).update({ mergedInto: keepId, discordId: null, ownerUid: null, updatedAt: FieldValue.serverTimestamp() });
  } else {
    await db.doc(`teams/${removeId}`).update({ mergedInto: keepId, active: false });
  }
  if (Object.keys(keepPatch).length) await db.doc(`${base}/${keepId}`).update(keepPatch);

  for (const s of seasons.docs) { const r = await recomputeSeason(s.id); await recomputeSeasonBrackets(s.id, r.matches); }
  // Cup matches were rewritten too, so their record candidates are rebuilt.
  await recomputeRecords(undefined, { rebuildCups: true });
  await auditNote(uid, `Merged ${kind} ${removeId} into ${keepId} (${rewritten} docs rewritten, ${moved} moved)`, `${base}/${keepId}`);
  return { rewritten, moved };
});

// ---------- Admin utilities ----------
/** private/* is Worker-write only; admins save webhook URLs through here. */
export const savePrivate = onCall(async (req) => {
  const uid = requireAdmin(req);
  const allowed = ['resultWebhookUrl', 'rulesWebhookUrl'];
  const patch: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.data || {})) {
    if (!allowed.includes(k)) continue;
    const s = String(v ?? '').trim();
    if (k.endsWith('Url') && s && !/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(s))
      throw new HttpsError('invalid-argument', `${k} must be a Discord webhook URL.`);
    patch[k] = s;
  }
  await db.doc('private/discord').set(patch, { merge: true });
  await auditNote(uid, `Updated Discord secrets: ${Object.keys(patch).join(', ')}`, 'private/discord');
  return { ok: true };
});

export const addAuditNote = onCall(async (req) => {
  const uid = requireAdmin(req);
  const note = String(req.data?.note || '').slice(0, 1000);
  if (!note) throw new HttpsError('invalid-argument', 'Note required.');
  await auditNote(uid, note, String(req.data?.path || ''));
  return { ok: true };
});
