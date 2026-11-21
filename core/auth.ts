import { onCall, HttpsError, logger, identity } from './runtime';
import {
  db, FieldValue, requireAuth, roleOf, Role,
  DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, adminRoleIdsFrom, ALLOWED_REDIRECTS, FIREBASE_PROJECT_ID,
} from './admin';
import { avatarUrl, discordApi } from './discord';

interface DiscordUser { id: string; username: string; global_name: string | null; avatar: string | null }

function allowedRedirects(): string[] {
  const project = FIREBASE_PROJECT_ID.value();
  return [
    ...ALLOWED_REDIRECTS.value().split(',').map((s) => s.trim()).filter(Boolean),
    `https://${project}.web.app/auth/callback`,
    `https://${project}.firebaseapp.com/auth/callback`,
  ];
}

export async function computeClaims(uid: string, guildRoleIds: string[]): Promise<{ role: Role }> {
  const admins = ((await db.doc('settings/admins').get()).data() || {}) as { adminUids?: string[]; ownerUids?: string[]; adminRoleIds?: string[] };
  const adminRoleIds = adminRoleIdsFrom(admins);
  let role: Role = 'user';
  if ((admins.ownerUids || []).includes(uid)) role = 'owner';
  else if ((admins.adminUids || []).includes(uid) || guildRoleIds.some((r) => adminRoleIds.includes(r))) role = 'admin';
  return { role };
}

export const discordAuth = onCall(async (req) => {
  const { code, redirectUri } = (req.data || {}) as { code?: string; redirectUri?: string };
  if (!code || !redirectUri) throw new HttpsError('invalid-argument', 'code and redirectUri are required.');
  if (!allowedRedirects().includes(redirectUri)) throw new HttpsError('invalid-argument', 'Redirect URI is not allowed.');

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID.value(), client_secret: DISCORD_CLIENT_SECRET.value(),
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    logger.warn('Discord token exchange failed', { status: tokenRes.status, body: await tokenRes.text() });
    throw new HttpsError('permission-denied', 'Discord sign-in failed. Try again.');
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const bearer = { Authorization: `Bearer ${access_token}` };

  const me = (await (await fetch('https://discord.com/api/v10/users/@me', { headers: bearer })).json()) as DiscordUser;
  if (!me?.id) throw new HttpsError('internal', 'Could not read Discord profile.');

  let guildRoleIds: string[] = [];
  const guildId = DISCORD_GUILD_ID.value();
  if (guildId) {
    const mres = await fetch(`https://discord.com/api/v10/users/@me/guilds/${guildId}/member`, { headers: bearer });
    if (mres.ok) guildRoleIds = ((await mres.json()) as { roles?: string[] }).roles || [];
  }

  const uid = `discord:${me.id}`;
  const claims = await computeClaims(uid, guildRoleIds);
  const avatar = avatarUrl(me.id, me.avatar);
  const userRef = db.doc(`users/${uid}`);
  const existing = await userRef.get();
  let pid: string | null = existing.data()?.playerId || null;

  // Auto-link a player an admin pre-linked to this Discord ID.
  const batch = db.batch();
  if (!pid) {
    const linked = await db.collection('players').where('discordId', '==', me.id).limit(1).get();
    const doc = linked.docs.find((d) => !d.data()!.mergedInto);
    if (doc) { pid = doc.id; batch.update(doc.ref, { ownerUid: uid }); }
  }
  batch.set(userRef, {
    discordId: me.id, username: me.username, displayName: me.global_name || me.username, avatarUrl: avatar,
    role: claims.role, guildRoleIds, lastLoginAt: FieldValue.serverTimestamp(),
    ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp(), playerId: null }),
    ...(pid ? { playerId: pid } : {}),
  }, { merge: true });
  await batch.commit();
  // Keep a claimed player's avatar fresh.
  if (pid) await db.doc(`players/${pid}`).update({ avatarUrl: avatar, updatedAt: FieldValue.serverTimestamp() }).catch(() => undefined);

  await identity.applyClaims(uid, claims, { displayName: me.global_name || me.username, photoURL: avatar });
  const token = await identity.createCustomToken(uid);
  return { token, uid, role: claims.role, hasPlayer: !!pid, playerId: pid };
});

/** Recompute role claims (self, or any user when called by an admin). Re-reads guild roles via the bot when available. */
export const refreshClaims = onCall(async (req) => {
  const caller = requireAuth(req);
  const target = (req.data?.uid as string) || caller;
  if (target !== caller && !['admin', 'owner'].includes(roleOf(req))) throw new HttpsError('permission-denied', 'Admins only.');
  const ref = db.doc(`users/${target}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'User not found.');
  let guildRoleIds: string[] = snap.data()?.guildRoleIds || [];
  const discordId = snap.data()?.discordId as string;
  try {
    const member = await discordApi<{ roles: string[] }>(DISCORD_BOT_TOKEN.value(), 'GET', `/guilds/${DISCORD_GUILD_ID.value()}/members/${discordId}`);
    guildRoleIds = member.roles || [];
  } catch { /* bot not configured or user left the server — keep stored roles */ }
  const claims = await computeClaims(target, guildRoleIds);
  await ref.set({ role: claims.role, guildRoleIds }, { merge: true });
  await identity.applyClaims(target, claims);
  return claims;
});
