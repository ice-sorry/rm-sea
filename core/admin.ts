import { FieldValue, Timestamp } from './firestore';
import { db, param, HttpsError, CallableRequest } from './runtime';

export { db, FieldValue, Timestamp };

export const DISCORD_CLIENT_SECRET = param('DISCORD_CLIENT_SECRET');
export const DISCORD_BOT_TOKEN = param('DISCORD_BOT_TOKEN');
export const DISCORD_PUBLIC_KEY = param('DISCORD_PUBLIC_KEY');
export const DISCORD_CLIENT_ID = param('DISCORD_CLIENT_ID', '1569644221718331412');
export const DISCORD_GUILD_ID = param('DISCORD_GUILD_ID', '1562776724431831050');
export const DISCORD_ADMIN_ROLE_IDS = param('DISCORD_ADMIN_ROLE_IDS', '1562781903604424794,1563169917384134827');
export const ALLOWED_REDIRECTS = param('ALLOWED_REDIRECTS', 'http://localhost:5000/auth/callback,http://localhost:5173/auth/callback');
export const FIREBASE_PROJECT_ID = param('FIREBASE_PROJECT_ID', 'rm-sea');

export type Role = 'user' | 'admin' | 'owner';

export function requireAuth(req: CallableRequest): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in with Discord first.');
  return req.auth.uid;
}
export function roleOf(req: CallableRequest): Role {
  return (req.auth?.token?.role as Role) || 'user';
}
export function requireAdmin(req: CallableRequest): string {
  const uid = requireAuth(req);
  if (!['admin', 'owner'].includes(roleOf(req))) throw new HttpsError('permission-denied', 'Admins only.');
  return uid;
}
export function requireOwner(req: CallableRequest): string {
  const uid = requireAuth(req);
  if (roleOf(req) !== 'owner') throw new HttpsError('permission-denied', 'Owners only.');
  return uid;
}

export async function getSettings<T = Record<string, any>>(id: string): Promise<T> {
  const s = await db.doc(`settings/${id}`).get();
  return (s.data() || {}) as T;
}
/** Discord switches in Admin → Settings → Discord & roles (settings/integrations). A missing field counts as on. */
export type DiscordFeature = 'rosterPosts' | 'roleSync' | 'matchThreads';
export function discordAllowed(integ: Record<string, unknown>, feature?: DiscordFeature): boolean {
  return integ.discordEnabled !== false && (!feature || integ[feature] !== false);
}
export async function discordOn(feature?: DiscordFeature): Promise<boolean> {
  return discordAllowed(await getSettings<Record<string, unknown>>('integrations'), feature);
}
/** For admin buttons: explain why nothing happened instead of silently skipping. */
export async function requireDiscordOn(feature?: DiscordFeature) {
  if (!(await discordOn(feature))) {
    throw new HttpsError('failed-precondition', feature ? 'This Discord feature is turned off in Settings → Discord & roles.' : 'Discord is turned off in Settings → Discord & roles.');
  }
}
export async function getPrivateDiscord(): Promise<Record<string, string>> {
  const s = await db.doc('private/discord').get();
  return (s.data() || {}) as Record<string, string>;
}
export async function currentSeasonId(): Promise<string | null> {
  const g = await getSettings<{ currentSeasonId?: string }>('general');
  return g.currentSeasonId || null;
}

/** Write an audit "note" entry. */
export async function auditNote(actorUid: string, note: string, path = '', extra: Record<string, unknown> = {}) {
  const u = actorUid ? await db.doc(`users/${actorUid}`).get() : null;
  await db.collection('auditLog').add({
    at: FieldValue.serverTimestamp(), actorUid, actorName: u?.data()?.displayName || u?.data()?.username || actorUid,
    kind: 'note', path, op: 'update', before: null, after: null, diff: null, note, ...extra,
  });
}

export const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
