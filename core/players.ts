import { onCall, HttpsError, invoke, CallableRequest } from './runtime';
import { db, FieldValue, requireAuth, requireAdmin, roleOf, currentSeasonId, getSettings, discordAllowed, DISCORD_BOT_TOKEN, auditNote } from './admin';
import { avatarUrl, discordApi } from './discord';
import { POSITIONS, Position, TRANSFER_LOG_STATUSES } from './shared/league';

const isAdminReq = (req: CallableRequest) => ['admin', 'owner'].includes(roleOf(req));

/** Admin: link a player record to a Discord account (the user may not have signed in yet). */
export const claimPlayer = onCall(async (req) => {
  requireAdmin(req);
  const { playerId, discordId: forDiscordId } = (req.data || {}) as { playerId?: string; discordId?: string };
  if (!playerId || !forDiscordId) throw new HttpsError('invalid-argument', 'playerId and discordId are required.');
  const uid = `discord:${forDiscordId}`;
  await db.runTransaction(async (tx) => {
    const pRef = db.doc(`players/${playerId}`), uRef = db.doc(`users/${uid}`);
    const p = await tx.get(pRef), u = await tx.get(uRef);
    if (!p.exists) throw new HttpsError('not-found', 'Player not found.');
    const dupe = await tx.get(db.collection('players').where('discordId', '==', forDiscordId).limit(2));
    if (dupe.docs.some((d) => d.id !== playerId)) throw new HttpsError('already-exists', 'That Discord account is linked to another player.');
    if (u.exists && u.data()?.playerId && u.data()?.playerId !== playerId) throw new HttpsError('already-exists', 'That Discord account already has a player.');
    tx.update(pRef, { discordId: forDiscordId, ownerUid: u.exists ? uid : null, linkSource: 'admin', updatedAt: FieldValue.serverTimestamp() });
    if (u.exists) tx.update(uRef, { playerId });
  });
  return { playerId };
});

/**
 * First sign-in: give the Discord account its player. Every league player signs in to register for teams, so the
 * player is tied to the Discord account. A record an admin already linked to this Discord ID is adopted; otherwise a
 * new free agent is created.
 */
export const setupPlayer = onCall(async (req) => {
  const caller = requireAuth(req);
  const discordId = caller.startsWith('discord:') ? caller.slice(8) : '';
  if (!discordId) throw new HttpsError('failed-precondition', 'Sign in with Discord first.');
  const { name: rawName, position: rawPos, country: rawCountry } = (req.data || {}) as { name?: string; position?: Position; country?: string };
  const userRef = db.doc(`users/${caller}`);
  return db.runTransaction(async (tx) => {
    const user = await tx.get(userRef);
    const u = user.data() || {};
    if (u.playerId) {
      const cur = await tx.get(db.doc(`players/${u.playerId}`));
      if (cur.exists && !cur.data()!.mergedInto) return { playerId: u.playerId as string, created: false };
    }

    const linked = await tx.get(db.collection('players').where('discordId', '==', discordId).limit(5));
    const pre = linked.docs.find((d) => !d.data()!.mergedInto && (!d.data()!.ownerUid || d.data()!.ownerUid === caller));
    if (pre) {
      tx.update(pre.ref, { ownerUid: caller, avatarUrl: u.avatarUrl || pre.data()!.avatarUrl || '', updatedAt: FieldValue.serverTimestamp() });
      tx.set(userRef, { discordId, playerId: pre.id }, { merge: true });
      return { playerId: pre.id, created: false };
    }

    const name = String(rawName || '').trim().slice(0, 32);
    if (name.length < 2) throw new HttpsError('invalid-argument', 'Name is too short.');
    const position: Position = POSITIONS.includes(rawPos as Position) ? (rawPos as Position) : 'UNSURE';
    const country = /^[A-Za-z]{2}$/.test(String(rawCountry || '')) ? String(rawCountry).toUpperCase() : '';
    const dupe = await tx.get(db.collection('players').where('nameLower', '==', name.toLowerCase()).limit(1));
    if (!dupe.empty) throw new HttpsError('already-exists', `A player called "${name}" already exists. Pick another name, or ask an admin to link that player to your Discord.`);
    const ref = db.collection('players').doc();
    tx.set(ref, {
      name, nameLower: name.toLowerCase(), discordId, ownerUid: caller, linkSource: 'self',
      position, currentTeamId: null, avatarUrl: u.avatarUrl || '', bio: '', country, mergedInto: null,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(userRef, { discordId, playerId: ref.id }, { merge: true });
    return { playerId: ref.id, created: true };
  });
});

/** Admin: unlink a player from its Discord account. */
export const unclaimPlayer = onCall(async (req) => {
  requireAdmin(req);
  const playerId = req.data?.playerId as string | undefined;
  if (!playerId) throw new HttpsError('invalid-argument', 'playerId required.');
  return db.runTransaction(async (tx) => {
    const pRef = db.doc(`players/${playerId}`);
    const p = await tx.get(pRef);
    if (!p.exists) throw new HttpsError('not-found', 'Player not found.');
    const ownerUid = p.data()?.ownerUid as string | null;
    const owner = ownerUid ? await tx.get(db.doc(`users/${ownerUid}`)) : null;
    tx.update(pRef, { ownerUid: null, discordId: null, linkSource: null, updatedAt: FieldValue.serverTimestamp() });
    if (owner?.exists && owner.data()?.playerId === playerId) tx.update(owner.ref, { playerId: null });
    return { ok: true };
  });
});

async function nextRound(seasonId: string): Promise<number> {
  const ms = await db.collection(`seasons/${seasonId}/matches`).where('status', '==', 'played').get();
  return ms.docs.reduce((m, d) => Math.max(m, d.data()!.stage === 'league' ? d.data()!.round || 0 : 0), 0) + 1;
}

/** Move a player between rosters within a season, keeping currentTeamId and the transfer log in sync. */
export async function movePlayer(seasonId: string, playerId: string, toTeamId: string | null, actor: string, source: 'request' | 'admin', startingRound?: number) {
  const season = (await db.doc(`seasons/${seasonId}`).get()).data() || {};
  const rosters = await db.collection(`seasons/${seasonId}/rosters`).get();
  const from = rosters.docs.find((d) => (d.data()!.playerIds || []).includes(playerId));
  const currentSeason = await currentSeasonId();
  // A player on a club that hasn't entered this season has no season roster, but still has a team: fall back to
  // currentTeamId so the move (and the transfer log) records where they came from instead of "free agent".
  const fromTeamId = from?.id || (currentSeason === seasonId ? ((await db.doc(`players/${playerId}`).get()).data()?.currentTeamId as string) || null : null);
  if (fromTeamId === toTeamId) return { fromTeamId, toTeamId };
  const batch = db.batch();
  if (from) batch.update(from.ref, { playerIds: FieldValue.arrayRemove(playerId), updatedAt: FieldValue.serverTimestamp(), updatedBy: actor });
  if (toTeamId) batch.set(db.doc(`seasons/${seasonId}/rosters/${toTeamId}`), { playerIds: FieldValue.arrayUnion(playerId), updatedAt: FieldValue.serverTimestamp(), updatedBy: actor }, { merge: true });
  if (currentSeason === seasonId) batch.update(db.doc(`players/${playerId}`), { currentTeamId: toTeamId, updatedAt: FieldValue.serverTimestamp() });
  if ((!TRANSFER_LOG_STATUSES || TRANSFER_LOG_STATUSES.includes(season.status)) && toTeamId) {
    batch.set(db.collection(`seasons/${seasonId}/transfers`).doc(), {
      playerId, fromTeamId, toTeamId, startingRound: startingRound ?? (await nextRound(seasonId)), source,
      createdAt: FieldValue.serverTimestamp(), createdBy: actor,
    });
  }
  await batch.commit();
  return { fromTeamId, toTeamId };
}

/** Best-effort Discord team-role sync for the rosters that just changed. */
export async function syncRolesFor(teamIds: (string | null)[]) {
  const ids = teamIds.filter((t): t is string => !!t);
  if (ids.length) await invoke('syncTeamRoles', { teamIds: ids }).catch(() => undefined);
}

export interface RosterMove { playerId: string; fromTeamId: string | null; toTeamId: string | null }

/** Best-effort Discord post for players who signed for or left a team (needs the bot token, so it runs in the Worker). */
export async function announceMoves(moves: RosterMove[]) {
  const real = moves.filter((m) => m.playerId && (m.fromTeamId || null) !== (m.toTeamId || null));
  if (real.length) await invoke('notifyRosterMove', { moves: real }).catch(() => undefined);
}

/** True while an admin has closed the transfer window (Admin → Moves → Transfers). */
export async function transfersBlocked() {
  return !!(await getSettings<{ transfersBlocked?: boolean }>('general')).transfersBlocked;
}

const embedColor = (hex: unknown) => (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : 0x1d8ade);

/** Posts roster moves to the roster channel set in Admin → Settings → Discord & roles. Silently skips when unset. */
export const notifyRosterMove = onCall(async (req) => {
  requireAdmin(req);
  const moves = (((req.data?.moves as RosterMove[]) || []).filter((m) => m?.playerId && (m.fromTeamId || null) !== (m.toTeamId || null))).slice(0, 10);
  const token = DISCORD_BOT_TOKEN.value();
  if (!moves.length || !token) return { posted: 0 };
  const [integ, general] = await Promise.all([
    getSettings<{ rosterChannelId?: string; discordEnabled?: boolean; rosterPosts?: boolean }>('integrations'),
    getSettings<{ siteUrl?: string }>('general'),
  ]);
  const channelId = String(integ.rosterChannelId || '').trim();
  if (!channelId || !discordAllowed(integ, 'rosterPosts')) return { posted: 0 };
  const paths = [...new Set(moves.flatMap((m) => [`players/${m.playerId}`, m.fromTeamId ? `teams/${m.fromTeamId}` : '', m.toTeamId ? `teams/${m.toTeamId}` : '']).filter(Boolean))];
  const snaps = await db.getAll(...paths.map((x) => db.doc(x)));
  const data = new Map(paths.map((x, i) => [x, snaps[i].data() || {}]));
  const site = String(general.siteUrl || '').replace(/\/+$/, '');
  const embeds = moves.map((m) => {
    const p = data.get(`players/${m.playerId}`) || {};
    const from = m.fromTeamId ? data.get(`teams/${m.fromTeamId}`) : null;
    const to = m.toTeamId ? data.get(`teams/${m.toTeamId}`) : null;
    const who = `**${p.name || 'A player'}**${p.discordId ? ` (<@${p.discordId}>)` : ''}`;
    const fromName = from?.name || 'their team', toName = to?.name || 'a new team';
    const [title, description] = !m.fromTeamId ? ['✍️ Signed', `${who} has signed for **${toName}**.`]
      : !m.toTeamId ? ['👋 Left team', `${who} has left **${fromName}** and is now a free agent.`]
      : ['🔁 Transfer', `${who} has left **${fromName}** and signed for **${toName}**.`];
    return {
      title, description, color: embedColor((to || from)?.color),
      ...(site ? { url: `${site}/#player/${encodeURIComponent(m.playerId)}` } : {}),
      ...(p.avatarUrl ? { thumbnail: { url: p.avatarUrl } } : {}),
      timestamp: new Date().toISOString(),
    };
  });
  // allowed_mentions: show the player's handle without pinging them.
  await discordApi(token, 'POST', `/channels/${channelId}/messages`, { embeds, allowed_mentions: { parse: [] } });
  return { posted: moves.length };
});

/** Admin mid-season transfer. Runs in the admin's browser. */
export const transferPlayer = onCall(async (req) => {
  const uid = requireAdmin(req);
  const { seasonId, playerId, toTeamId, startingRound } = req.data as { seasonId?: string; playerId: string; toTeamId: string | null; startingRound?: number };
  const sid = seasonId || (await currentSeasonId());
  if (!sid || !playerId) throw new HttpsError('invalid-argument', 'seasonId and playerId required.');
  const r = await movePlayer(sid, playerId, toTeamId || null, uid, 'admin', startingRound);
  await auditNote(uid, `Transfer ${playerId}: ${r.fromTeamId ?? 'free agent'} → ${toTeamId ?? 'free agent'}`, `players/${playerId}`);
  await syncRolesFor([r.fromTeamId, r.toTeamId]);
  await announceMoves([{ playerId, ...r }]);
  return r;
});

/** Accept/decline (admin or captain of the receiving team) or cancel (requester). */
export const decideRequest = onCall(async (req) => {
  const uid = requireAuth(req);
  const { requestId, decision } = req.data as { requestId: string; decision: 'accept' | 'decline' | 'cancel' };
  const ref = db.doc(`requests/${requestId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Request not found.');
  const r = snap.data()!;
  if (r.status !== 'pending') throw new HttpsError('failed-precondition', 'Request already decided.');

  if (decision === 'cancel') {
    if (r.requestedBy !== uid) throw new HttpsError('permission-denied', 'Only the requester can cancel.');
    await ref.update({ status: 'cancelled', decidedBy: uid, decidedAt: FieldValue.serverTimestamp() });
    return { status: 'cancelled' };
  }

  const seasonRequest = r.type === 'join_season' || r.type === 'leave_season';
  let allowed = isAdminReq(req);
  // Season entry/exit is admin-only; captains decide join/transfer requests for their own team.
  if (!allowed && !seasonRequest && r.toTeamId && r.type !== 'new_team') {
    const [me, team] = await db.getAll(db.doc(`users/${uid}`), db.doc(`teams/${r.toTeamId}`));
    allowed = !!me.data()?.playerId && (team.data()?.captainIds || []).includes(me.data()!.playerId);
  }
  if (!allowed) throw new HttpsError('permission-denied', seasonRequest ? 'Only admins can decide season requests.' : 'Only admins or the team captain can decide this.');

  if (decision === 'decline') {
    await ref.update({ status: 'declined', decidedBy: uid, decidedAt: FieldValue.serverTimestamp() });
    return { status: 'declined' };
  }

  // A closed transfer window stops captains approving moves that were requested before it closed. Admins can override.
  if (!seasonRequest && !isAdminReq(req) && (await transfersBlocked())) throw new HttpsError('failed-precondition', 'Transfers are closed right now.');

  // Team requests work between seasons too: with no season the player's team is set directly (no season roster).
  const seasonId: string | null = r.seasonId || (await currentSeasonId()) || null;
  if (seasonRequest) {
    if (!seasonId) throw new HttpsError('failed-precondition', 'No current season.');
    const result = await decideSeasonRequest(r as { type: string; teamId?: string }, seasonId, uid);
    await ref.update({ status: 'accepted', decidedBy: uid, decidedAt: FieldValue.serverTimestamp() });
    return { status: 'accepted', ...result };
  }
  if (r.type === 'new_team') {
    const name = String(r.teamName || r.message || '').trim();
    if (!name) throw new HttpsError('invalid-argument', 'Request has no team name.');
    const teamRef = db.collection('teams').doc();
    // The new club is not entered into any season; its captain requests to join the current season separately.
    await teamRef.set({
      name, shortName: name.slice(0, 4).toUpperCase(), nameNormalized: normalizeTeamName(name), color: r.color || '#1D8ADE',
      crestUrl: '', discordRoleId: null, captainIds: [r.playerId], active: true, mergedInto: null,
    });
    let fromTeamId: string | null;
    if (seasonId) fromTeamId = (await movePlayer(seasonId, r.playerId, teamRef.id, uid, 'request')).fromTeamId;
    else {
      const p = await db.doc(`players/${r.playerId}`).get();
      fromTeamId = (p.data()?.currentTeamId as string) || null;
      await p.ref.update({ currentTeamId: teamRef.id, updatedAt: FieldValue.serverTimestamp() });
    }
    await ref.update({ status: 'accepted', toTeamId: teamRef.id, decidedBy: uid, decidedAt: FieldValue.serverTimestamp() });
    await syncRolesFor([fromTeamId]);
    await announceMoves([{ playerId: r.playerId, fromTeamId, toTeamId: teamRef.id }]);
    return { status: 'accepted', teamId: teamRef.id };
  }
  let moved: { fromTeamId: string | null; toTeamId: string | null };
  if (seasonId) moved = await movePlayer(seasonId, r.playerId, r.toTeamId, uid, 'request');
  else {
    const p = await db.doc(`players/${r.playerId}`).get();
    moved = { fromTeamId: (p.data()?.currentTeamId as string) || null, toTeamId: r.toTeamId };
    await p.ref.update({ currentTeamId: r.toTeamId, updatedAt: FieldValue.serverTimestamp() });
  }
  await ref.update({ status: 'accepted', decidedBy: uid, decidedAt: FieldValue.serverTimestamp() });
  await syncRolesFor([moved.fromTeamId, moved.toTeamId]);
  await announceMoves([{ playerId: r.playerId, ...moved }]);
  return { status: 'accepted' };
});

/** Accepting a captain's request to enter the season, or to withdraw from it. */
async function decideSeasonRequest(r: { type: string; teamId?: string }, seasonId: string, uid: string) {
  const teamId = r.teamId;
  if (!teamId) throw new HttpsError('invalid-argument', 'Request has no team.');
  const season = await db.doc(`seasons/${seasonId}`).get();
  if (!season.exists) throw new HttpsError('not-found', 'Season not found.');
  if (season.data()!.locked) throw new HttpsError('failed-precondition', 'Season is locked.');
  const entryRef = db.doc(`seasons/${seasonId}/entries/${teamId}`);
  const entry = await entryRef.get();
  if (r.type === 'join_season') {
    const b = db.batch();
    if (!entry.exists) b.set(entryRef, { confirmed: true, divisionId: null, seed: null, joinedAt: FieldValue.serverTimestamp() });
    // A club formed between seasons has no season roster yet: start it from the players already on the team.
    const rosterRef = db.doc(`seasons/${seasonId}/rosters/${teamId}`);
    if (!(await rosterRef.get()).exists) {
      const members = await db.collection('players').where('currentTeamId', '==', teamId).get();
      b.set(rosterRef, { playerIds: members.docs.map((d) => d.id), updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
    }
    await b.commit();
    await auditNote(uid, `Approved ${teamId} joining ${seasonId}`, `seasons/${seasonId}/entries/${teamId}`);
    return { removedFixtures: 0 };
  }
  // Leaving: drop the entry and the team's unplayed league fixtures. Played results stay on record.
  const matches = db.collection(`seasons/${seasonId}/matches`);
  const [home, away] = await Promise.all([
    matches.where('homeTeamId', '==', teamId).get(),
    matches.where('awayTeamId', '==', teamId).get(),
  ]);
  const unplayed = [...home.docs, ...away.docs].filter((d) => d.data()!.stage === 'league' && ['scheduled', 'agreed'].includes(d.data()!.status));
  const b = db.batch();
  if (entry.exists) b.delete(entryRef);
  unplayed.forEach((d) => b.delete(d.ref));
  await b.commit();
  await auditNote(uid, `Approved ${teamId} leaving ${seasonId} (${unplayed.length} unplayed fixtures removed)`, `seasons/${seasonId}/entries/${teamId}`);
  return { removedFixtures: unplayed.length };
}

export function normalizeTeamName(name: string) {
  return name.toLowerCase().replace(/\b(afc|fc|esports|e-sports|gaming|team|club)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

const AVATARS_PER_CALL = 35; // keeps each Worker invocation under the free plan's 50-subrequest cap

/** Pull fresh Discord avatars for every linked player (paged: call again with the returned cursor). */
export const refreshAvatars = onCall(async (req) => {
  requireAdmin(req);
  const start = Number(req.data?.cursor || 0);
  const ps = await db.collection('players').where('discordId', '!=', null).get();
  const page = ps.docs.slice(start, start + AVATARS_PER_CALL);
  const batch = db.batch();
  let updated = 0;
  for (const p of page) {
    try {
      const u = await discordApi<{ id: string; avatar: string | null }>(DISCORD_BOT_TOKEN.value(), 'GET', `/users/${p.data()!.discordId}`);
      const url = avatarUrl(u.id, u.avatar);
      if (url !== p.data()!.avatarUrl) { batch.update(p.ref, { avatarUrl: url }); updated++; }
    } catch { /* skip unknown users */ }
  }
  await batch.commit();
  const next = start + page.length;
  return { checked: page.length, updated, done: next >= ps.size, cursor: next };
});
