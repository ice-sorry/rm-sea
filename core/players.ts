import { onCall, HttpsError, invoke, logger, CallableRequest } from './runtime';
import { db, FieldValue, requireAuth, requireAdmin, roleOf, currentSeasonId, getSettings, discordAllowed, adminRoleIds, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, auditNote } from './admin';
import { avatarUrl, discordApi, sendDm } from './discord';
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
 * Whether this Discord account may create a player: it must hold one of the player role IDs (e.g. Verified) set in
 * Admin → Settings → Admins (settings/admins.playerRoleIds). No role IDs set means anyone may register.
 * Roles are re-read through the bot so a freshly verified member doesn't have to sign in again.
 */
async function hasPlayerRole(uid: string, discordId: string): Promise<boolean> {
  const { playerRoleIds = [] } = await getSettings<{ playerRoleIds?: string[] }>('admins');
  if (!playerRoleIds.length) return true;
  const userRef = db.doc(`users/${uid}`);
  let roles: string[] = (await userRef.get()).data()?.guildRoleIds || [];
  try {
    const member = await discordApi<{ roles?: string[] }>(DISCORD_BOT_TOKEN.value(), 'GET', `/guilds/${DISCORD_GUILD_ID.value()}/members/${discordId}`);
    roles = member.roles || [];
    await userRef.set({ guildRoleIds: roles }, { merge: true });
  } catch (e) {
    // 404: not in the server (any more). Other failures (bot not set up, outage): fall back to the roles from sign-in.
    if (/: 404 /.test(String(e))) roles = [];
  }
  return roles.some((r) => playerRoleIds.includes(r));
}

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
  // Only checked when creating a new player: records an admin already linked to this account can still be adopted.
  const eligible = isAdminReq(req) || await hasPlayerRole(caller, discordId);
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

    if (!eligible) throw new HttpsError('permission-denied', 'Only members with the Verified role in the league Discord can register as a player. Get verified in the server, then try again.');
    const name = String(rawName || '').trim().slice(0, 32);
    if (name.length < 1) throw new HttpsError('invalid-argument', 'Name is too short.');
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

/** `removed`: an admin took the player off the team (a kick), rather than the player leaving. */
export interface RosterMove { playerId: string; fromTeamId: string | null; toTeamId: string | null; removed?: boolean }

/**
 * Best-effort Discord post for players who signed for or left a team, and for newly created teams
 * (needs the bot token, so it runs in the Worker).
 */
export async function announceMoves(moves: RosterMove[], newTeamIds: string[] = []) {
  const real = moves.filter((m) => m.playerId && (m.fromTeamId || null) !== (m.toTeamId || null));
  if (real.length || newTeamIds.length) await invoke('notifyRosterMove', { moves: real, newTeamIds }).catch(() => undefined);
}

/** True while an admin has closed the transfer window (Admin → Moves → Transfers). */
export async function transfersBlocked() {
  return !!(await getSettings<{ transfersBlocked?: boolean }>('general')).transfersBlocked;
}

const embedColor = (hex: unknown) => (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : 0x1d8ade);

/**
 * Posts roster moves and newly created teams to the roster channel set in Admin → Settings → Discord & roles.
 * Silently skips when unset. New teams come first, so a "new team" request reads as created, then signed.
 */
export const notifyRosterMove = onCall(async (req) => {
  requireAdmin(req);
  // Discord allows 10 embeds per message.
  const newTeamIds = [...new Set(((req.data?.newTeamIds as string[]) || []).filter((t) => typeof t === 'string' && t))].slice(0, 10);
  const moves = (((req.data?.moves as RosterMove[]) || []).filter((m) => m?.playerId && (m.fromTeamId || null) !== (m.toTeamId || null))).slice(0, 10 - newTeamIds.length);
  const token = DISCORD_BOT_TOKEN.value();
  if ((!moves.length && !newTeamIds.length) || !token) return { posted: 0 };
  const [integ, general] = await Promise.all([
    getSettings<{ rosterChannelId?: string; discordEnabled?: boolean; rosterPosts?: boolean }>('integrations'),
    getSettings<{ siteUrl?: string }>('general'),
  ]);
  const channelId = String(integ.rosterChannelId || '').trim();
  if (!channelId || !discordAllowed(integ, 'rosterPosts')) return { posted: 0 };
  const paths = [...new Set(moves.flatMap((m) => [`players/${m.playerId}`, m.fromTeamId ? `teams/${m.fromTeamId}` : '', m.toTeamId ? `teams/${m.toTeamId}` : '']).filter(Boolean))];
  const teamPaths = newTeamIds.map((t) => `teams/${t}`);
  const allPaths = [...new Set([...paths, ...teamPaths])];
  const snaps = await db.getAll(...allPaths.map((x) => db.doc(x)));
  const data = new Map(allPaths.map((x, i) => [x, snaps[i].data() || {}]));
  // Captains of the new teams, for the "New team" embed.
  const captainPaths = [...new Set(teamPaths.flatMap((t) => ((data.get(t)?.captainIds as string[]) || []).map((c) => `players/${c}`)))].filter((c) => !data.has(c));
  if (captainPaths.length) (await db.getAll(...captainPaths.map((x) => db.doc(x)))).forEach((s, i) => data.set(captainPaths[i], s.data() || {}));
  const site = String(general.siteUrl || '').replace(/\/+$/, '');
  const teamEmbeds = newTeamIds.filter((t) => data.get(`teams/${t}`)?.name).map((t) => {
    const team = data.get(`teams/${t}`)!;
    const captains = ((team.captainIds as string[]) || []).map((c) => data.get(`players/${c}`)).filter((p) => p?.name)
      .map((p) => `**${p!.name}**${p!.discordId ? ` (<@${p!.discordId}>)` : ''}`);
    return {
      title: '🆕 New team', description: `**${team.name}** has joined the league.${captains.length ? `\nCaptain: ${captains.join(', ')}` : ''}`,
      color: embedColor(team.color),
      ...(site ? { url: `${site}/#team/${encodeURIComponent(t)}` } : {}),
      ...(team.crestUrl ? { thumbnail: { url: team.crestUrl } } : {}),
      timestamp: new Date().toISOString(),
    };
  });
  const moveEmbeds = moves.map((m) => {
    const p = data.get(`players/${m.playerId}`) || {};
    const from = m.fromTeamId ? data.get(`teams/${m.fromTeamId}`) : null;
    const to = m.toTeamId ? data.get(`teams/${m.toTeamId}`) : null;
    const who = `**${p.name || 'A player'}**${p.discordId ? ` (<@${p.discordId}>)` : ''}`;
    const fromName = from?.name || 'their team', toName = to?.name || 'a new team';
    const [title, description] = !m.fromTeamId ? ['✍️ Signed', `${who} has signed for **${toName}**.`]
      : !m.toTeamId && m.removed ? ['🚫 Removed from team', `${who} has been removed from **${fromName}** and is now a free agent.`]
      : !m.toTeamId ? ['👋 Left team', `${who} has left **${fromName}** and is now a free agent.`]
      : ['🔁 Transfer', `${who} has left **${fromName}** and signed for **${toName}**.`];
    return {
      title, description, color: embedColor((to || from)?.color),
      ...(site ? { url: `${site}/#player/${encodeURIComponent(m.playerId)}` } : {}),
      ...(p.avatarUrl ? { thumbnail: { url: p.avatarUrl } } : {}),
      timestamp: new Date().toISOString(),
    };
  });
  const embeds = [...teamEmbeds, ...moveEmbeds];
  if (!embeds.length) return { posted: 0 };
  // allowed_mentions: show the player's handle without pinging them.
  await discordApi(token, 'POST', `/channels/${channelId}/messages`, { embeds, allowed_mentions: { parse: [] } });
  return { posted: embeds.length };
});

/** Request types only an admin can approve. These are posted to the alerts channel when they're made. */
const ADMIN_REQUEST_TYPES = ['new_team', 'join_season', 'leave_season', 'kick_player'];

/**
 * Posts a pending admin-only request to the alerts channel set in Admin → Settings → Discord & roles.
 * Each request is posted once (adminNotifiedAt). Silently skips when the channel is unset or the posts are off.
 */
async function postAdminRequest(requestId: string): Promise<boolean> {
  const ref = db.doc(`requests/${requestId}`);
  const snap = await ref.get();
  const r = snap.data();
  if (!r || r.status !== 'pending' || r.adminNotifiedAt || !ADMIN_REQUEST_TYPES.includes(r.type)) return false;
  const token = DISCORD_BOT_TOKEN.value();
  if (!token) return false;
  const [integ, general] = await Promise.all([
    getSettings<{ alertsChannelId?: string; discordEnabled?: boolean; requestPosts?: boolean }>('integrations'),
    getSettings<{ siteUrl?: string }>('general'),
  ]);
  const channelId = String(integ.alertsChannelId || '').trim();
  if (!channelId || !discordAllowed(integ, 'requestPosts')) return false;
  const teamId: string | null = r.teamId || null;
  const paths = [`players/${r.playerId}`, ...(teamId ? [`teams/${teamId}`] : []), ...(r.seasonId ? [`seasons/${r.seasonId}`] : [])];
  const snaps = await db.getAll(...paths.map((x) => db.doc(x)));
  const data = new Map(paths.map((x, i) => [x, snaps[i].data() || {}]));
  const p = data.get(`players/${r.playerId}`) || {};
  const team = (teamId && data.get(`teams/${teamId}`)) || {};
  const season = (r.seasonId && data.get(`seasons/${r.seasonId}`)) || {};
  const who = `**${p.name || 'A player'}**${p.discordId ? ` (<@${p.discordId}>)` : ''}`;
  const teamName = `**${team.name || 'their team'}**`, seasonName = `**${season.name || 'the current season'}**`;
  const [title, description, color] =
    r.type === 'new_team' ? ['🆕 New club request', `${who} wants to create **${r.teamName || '?'}**${r.shortName ? ` (${r.shortName})` : ''}.`, r.color]
    : r.type === 'join_season' ? ['📥 Season entry request', `${who} wants ${teamName} to join ${seasonName}.`, team.color]
    : r.type === 'leave_season' ? ['📤 Season exit request', `${who} wants ${teamName} to leave ${seasonName}.`, team.color]
    : ['🚫 Removal request', `${who} has been put forward for removal from ${teamName}.`, team.color];
  const message = String(r.message || '').trim();
  const site = String(general.siteUrl || '').replace(/\/+$/, '');
  // Ping the admin roles so the alert gets seen. The bot needs "Mention @everyone, @here and All Roles", or the
  // roles must be set to "Allow anyone to @mention this role", for the ping to go through.
  const roles = await adminRoleIds();
  await discordApi(token, 'POST', `/channels/${channelId}/messages`, {
    ...(roles.length ? { content: roles.map((id) => `<@&${id}>`).join(' ') } : {}),
    embeds: [{
      title, color: embedColor(color),
      description: `${description}${message ? `\n> ${message.replace(/\n/g, ' ')}` : ''}\nApprove or decline it in Admin → Moves → Requests.`,
      ...(site ? { url: `${site}/#admin/moves` } : {}),
      timestamp: new Date().toISOString(),
    }],
    // Only the admin roles may ping; player handles in the embed stay silent.
    allowed_mentions: { parse: [], roles },
  });
  await ref.update({ adminNotifiedAt: FieldValue.serverTimestamp() });
  return true;
}

/**
 * Best-effort Discord DM to each player (by player ID), when Player DMs are on in Admin → Settings → Discord & roles.
 * Players who block DMs from server members, or have no linked Discord account, are skipped. Returns how many were sent.
 */
async function dmPlayers(playerIds: string[], embed: Record<string, unknown>): Promise<number> {
  const ids = [...new Set(playerIds.filter(Boolean))].slice(0, 5); // keeps the Worker under its subrequest cap
  const token = DISCORD_BOT_TOKEN.value();
  if (!ids.length || !token || !discordAllowed(await getSettings('integrations'), 'playerDms')) return 0;
  const players = await db.getAll(...ids.map((id) => db.doc(`players/${id}`)));
  let sent = 0;
  for (const p of players) {
    const discordId = p.data()?.discordId as string | undefined;
    if (!discordId) continue;
    try {
      await sendDm(token, discordId, { embeds: [{ ...embed, timestamp: new Date().toISOString() }], allowed_mentions: { parse: [] } });
      sent++;
    } catch (e) {
      logger.warn('player DM failed', { playerId: p.id, error: String(e) });
    }
  }
  return sent;
}

const siteUrl = async () => String((await getSettings<{ siteUrl?: string }>('general')).siteUrl || '').replace(/\/+$/, '');

/** DM the captains of the team a player asked to join (or transfer to). Each request is sent once (captainsNotifiedAt). */
async function dmCaptainsAboutJoin(requestId: string): Promise<number> {
  const ref = db.doc(`requests/${requestId}`);
  const r = (await ref.get()).data();
  if (!r || r.status !== 'pending' || r.captainsNotifiedAt || !['join_team', 'transfer'].includes(r.type) || !r.toTeamId) return 0;
  const paths = [`teams/${r.toTeamId}`, `players/${r.playerId}`, ...(r.fromTeamId ? [`teams/${r.fromTeamId}`] : [])];
  const [team, player, from] = (await db.getAll(...paths.map((x) => db.doc(x)))).map((s) => s.data() || {});
  const captainIds: string[] = (team.captainIds || []).filter((c: string) => c !== r.playerId);
  if (!captainIds.length) return 0;
  // Mark first, so a retried call can't DM the captains twice.
  await ref.update({ captainsNotifiedAt: FieldValue.serverTimestamp() });
  const site = await siteUrl();
  const message = String(r.message || '').trim();
  return dmPlayers(captainIds, {
    title: r.type === 'transfer' ? '🔁 Transfer request' : '📨 Join request',
    description: `**${player.name || 'A player'}**${r.type === 'transfer' ? ` (from **${from?.name || 'another team'}**)` : ''} wants to join **${team.name || 'your team'}**.`
      + `${message ? `\n> ${message.replace(/\n/g, ' ')}` : ''}\nAccept or decline it in the captain tools on your team page.`,
    color: embedColor(team.color),
    ...(site ? { url: `${site}/#team/${encodeURIComponent(r.toTeamId)}` } : {}),
    ...(player.avatarUrl ? { thumbnail: { url: player.avatarUrl } } : {}),
  });
}

/**
 * Requester (or an admin): announce a request they just made. Admin-only requests are posted to the alerts
 * channel; join and transfer requests are DMed to the team's captains.
 */
export const notifyRequest = onCall(async (req) => {
  const uid = requireAuth(req);
  const requestId = String(req.data?.requestId || '');
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required.');
  const snap = await db.doc(`requests/${requestId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Request not found.');
  if (snap.data()!.requestedBy !== uid && !isAdminReq(req)) throw new HttpsError('permission-denied', 'Only the requester can announce this request.');
  const [posted, dmed] = await Promise.all([
    postAdminRequest(requestId).catch((e) => { logger.warn('admin alert failed', String(e)); return false; }),
    dmCaptainsAboutJoin(requestId).catch((e) => { logger.warn('captain DM failed', String(e)); return 0; }),
  ]);
  return { posted, dmed };
});
/** Older name, kept so browsers still running the previous build keep working. */
export const notifyAdminRequest = notifyRequest;

/** True when the player is on this team: on its season roster, or (between seasons / club not entered) by currentTeamId. */
async function isOnTeam(seasonId: string | null, playerId: string, teamId: string) {
  const [p, roster] = await db.getAll(db.doc(`players/${playerId}`), db.doc(`seasons/${seasonId || '-'}/rosters/${teamId}`));
  return p.data()?.currentTeamId === teamId || (!!seasonId && (roster.data()?.playerIds || []).includes(playerId));
}

/** Roster limit from Admin → Settings → General. 0 (or unset) means no limit. */
async function maxRosterSize() {
  const n = Math.floor(Number((await getSettings<{ maxRosterSize?: number }>('general')).maxRosterSize) || 0);
  return n > 0 ? n : 0;
}

/** Players on a team: its season roster when it has one, otherwise (between seasons / club not entered) by currentTeamId. */
async function squadSize(seasonId: string | null, teamId: string) {
  const roster = seasonId ? await db.doc(`seasons/${seasonId}/rosters/${teamId}`).get() : null;
  if (roster?.exists) return ((roster.data()!.playerIds as string[]) || []).length;
  return (await db.collection('players').where('currentTeamId', '==', teamId).get()).size;
}

/** Make a player a free agent, then sync roles and announce it. Callers check permissions and team membership. */
async function releasePlayer(seasonId: string | null, playerId: string, teamId: string, uid: string, removed = false) {
  if (seasonId) await movePlayer(seasonId, playerId, null, uid, 'request');
  else await db.doc(`players/${playerId}`).update({ currentTeamId: null, updatedAt: FieldValue.serverTimestamp() });
  await syncRolesFor([teamId]);
  await announceMoves([{ playerId, fromTeamId: teamId, toTeamId: null, removed }]);
}

/**
 * Ask for a player to be removed from a team. Every removal is a request that an admin approves in
 * Admin → Moves → Requests, even when an admin asks. Captains can't ask while the transfer window is closed.
 */
export const kickPlayer = onCall(async (req) => {
  const uid = requireAuth(req);
  const { teamId, playerId } = (req.data || {}) as { teamId?: string; playerId?: string };
  if (!teamId || !playerId) throw new HttpsError('invalid-argument', 'teamId and playerId are required.');
  const [me, team] = await db.getAll(db.doc(`users/${uid}`), db.doc(`teams/${teamId}`));
  if (!team.exists) throw new HttpsError('not-found', 'Team not found.');
  const captainIds: string[] = team.data()!.captainIds || [];
  const admin = isAdminReq(req);
  if (!admin && !(me.data()?.playerId && captainIds.includes(me.data()!.playerId))) throw new HttpsError('permission-denied', "Only this team's captain can remove players.");
  if (captainIds.includes(playerId)) throw new HttpsError('failed-precondition', "Captains can't be removed. An admin can change the captains first.");
  if (!admin && (await transfersBlocked())) throw new HttpsError('failed-precondition', 'Transfers are closed right now.');
  const seasonId = await currentSeasonId();
  if (!(await isOnTeam(seasonId, playerId, teamId))) throw new HttpsError('failed-precondition', 'That player is not on this team.');
  const pending = (await db.collection('requests').where('playerId', '==', playerId).where('status', '==', 'pending').get()).docs;
  if (pending.some((d) => d.data()!.type === 'kick_player' && d.data()!.teamId === teamId)) throw new HttpsError('already-exists', 'A removal request for this player is already waiting for an admin.');
  const added = await db.collection('requests').add({
    type: 'kick_player', teamId, playerId, fromTeamId: teamId, toTeamId: null, seasonId: seasonId || null,
    status: 'pending', message: String(req.data?.message || '').slice(0, 200), requestedBy: uid, createdAt: FieldValue.serverTimestamp(),
  });
  await postAdminRequest(added.id).catch(() => undefined);
  return { requested: true };
});

/** True when this player captains a team (captains can't leave or be moved by requests; an admin changes captains first). */
async function captainsATeam(playerId: string) {
  return !(await db.collection('teams').where('captainIds', 'array-contains', playerId).limit(1).get()).empty;
}

/**
 * Captain (or admin): invite a player to the team. The invite is a pending 'team_invite' request that the
 * invited player accepts or declines; the inviting captains can cancel it. Accepting follows the same rules
 * as a join request (transfer window, roster limit).
 */
export const invitePlayer = onCall(async (req) => {
  const uid = requireAuth(req);
  const { teamId, playerId } = (req.data || {}) as { teamId?: string; playerId?: string };
  if (!teamId || !playerId) throw new HttpsError('invalid-argument', 'teamId and playerId are required.');
  const [me, team, player] = await db.getAll(db.doc(`users/${uid}`), db.doc(`teams/${teamId}`), db.doc(`players/${playerId}`));
  if (!team.exists || team.data()!.active === false) throw new HttpsError('not-found', 'Team not found.');
  if (!player.exists || player.data()!.mergedInto) throw new HttpsError('not-found', 'Player not found.');
  const captainIds: string[] = team.data()!.captainIds || [];
  const admin = isAdminReq(req);
  if (!admin && !(me.data()?.playerId && captainIds.includes(me.data()!.playerId))) throw new HttpsError('permission-denied', "Only this team's captain can invite players.");
  if (!admin && (await transfersBlocked())) throw new HttpsError('failed-precondition', 'Transfers are closed right now.');
  const p = player.data()!;
  if (!p.ownerUid) throw new HttpsError('failed-precondition', `${p.name} hasn't signed in to the site yet, so they can't accept an invite.`);
  const seasonId = await currentSeasonId();
  if (await isOnTeam(seasonId, playerId, teamId)) throw new HttpsError('failed-precondition', `${p.name} is already on this team.`);
  if (await captainsATeam(playerId)) throw new HttpsError('failed-precondition', `${p.name} captains another team. An admin has to change that team's captains first.`);
  const cap = await maxRosterSize();
  if (cap && (await squadSize(seasonId, teamId)) >= cap) throw new HttpsError('failed-precondition', `Your roster is full (${cap} players). Remove a player before inviting new ones.`);
  const pending = (await db.collection('requests').where('playerId', '==', playerId).where('status', '==', 'pending').get()).docs;
  if (pending.some((d) => d.data()!.type === 'team_invite' && d.data()!.toTeamId === teamId)) throw new HttpsError('already-exists', `${p.name} already has an invite from this team.`);
  const message = String(req.data?.message || '').trim().slice(0, 200);
  const added = await db.collection('requests').add({
    type: 'team_invite', teamId, playerId, fromTeamId: (p.currentTeamId as string) || null, toTeamId: teamId, seasonId: seasonId || null,
    status: 'pending', message, requestedBy: uid, createdAt: FieldValue.serverTimestamp(),
  });
  const t = team.data()!;
  const site = await siteUrl();
  const dmed = await dmPlayers([playerId], {
    title: '✉️ Team invite',
    description: `**${t.name}** has invited you to join the team.${message ? `\n> ${message.replace(/\n/g, ' ')}` : ''}`
      + '\nAccept or decline it on your profile or the team page.',
    color: embedColor(t.color),
    ...(site ? { url: `${site}/#team/${encodeURIComponent(teamId)}` } : {}),
    ...(t.crestUrl ? { thumbnail: { url: t.crestUrl } } : {}),
  }).catch(() => 0);
  if (dmed) await added.update({ playerNotifiedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
  return { invited: true, dmed: dmed > 0 };
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

/**
 * Accept/decline (admin or captain of the receiving team; for a team invite, the invited player) or cancel
 * (requester; for a team invite, any captain of the inviting team).
 */
export const decideRequest = onCall(async (req) => {
  const uid = requireAuth(req);
  const { requestId, decision } = req.data as { requestId: string; decision: 'accept' | 'decline' | 'cancel' };
  const ref = db.doc(`requests/${requestId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Request not found.');
  const r = snap.data()!;
  if (r.status !== 'pending') throw new HttpsError('failed-precondition', 'Request already decided.');
  const invite = r.type === 'team_invite';
  const myPlayerId = async () => ((await db.doc(`users/${uid}`).get()).data()?.playerId as string) || null;
  const captainOf = async (teamId: string | null) => {
    if (!teamId) return false;
    const [pid, team] = await Promise.all([myPlayerId(), db.doc(`teams/${teamId}`).get()]);
    return !!pid && (team.data()?.captainIds || []).includes(pid);
  };

  if (decision === 'cancel') {
    if (r.requestedBy !== uid && !(invite && await captainOf(r.toTeamId))) throw new HttpsError('permission-denied', 'Only the requester can cancel.');
    await ref.update({ status: 'cancelled', decidedBy: uid, decidedAt: FieldValue.serverTimestamp() });
    return { status: 'cancelled' };
  }

  const seasonRequest = r.type === 'join_season' || r.type === 'leave_season';
  let allowed = isAdminReq(req);
  // Removals a captain asked for need an admin.
  const adminOnly = seasonRequest || r.type === 'kick_player';
  if (!allowed && invite) {
    // Only the invited player answers an invite; the captains who sent it can only cancel it.
    allowed = (await myPlayerId()) === r.playerId;
  } else if (!allowed && !adminOnly && r.type !== 'new_team') {
    // Season entry/exit is admin-only; captains decide join/transfer requests for their own team.
    allowed = await captainOf(r.type === 'leave_team' ? r.teamId || null : r.toTeamId || null);
  }
  if (!allowed) throw new HttpsError('permission-denied', adminOnly ? 'Only admins can decide this request.' : invite ? 'Only the invited player can answer this invite.' : 'Only admins or the team captain can decide this.');

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
      name, shortName: (String(r.shortName || '').replace(/\s+/g, '').slice(0, 4) || name.slice(0, 4)).toUpperCase(), nameNormalized: normalizeTeamName(name), color: r.color || '#1D8ADE',
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
    await announceMoves([{ playerId: r.playerId, fromTeamId, toTeamId: teamRef.id }], [teamRef.id]);
    return { status: 'accepted', teamId: teamRef.id };
  }
  if (r.type === 'leave_team' || r.type === 'kick_player') {
    // The player may have moved on since asking; only release them from the team they asked to leave.
    if (!r.teamId || !(await isOnTeam(seasonId, r.playerId, r.teamId))) {
      await ref.update({ status: 'cancelled', decidedBy: uid, decidedAt: FieldValue.serverTimestamp() });
      throw new HttpsError('failed-precondition', 'That player is no longer on this team.');
    }
    const kick = r.type === 'kick_player';
    await releasePlayer(seasonId, r.playerId, r.teamId, uid, kick);
    await ref.update({ status: 'accepted', decidedBy: uid, decidedAt: FieldValue.serverTimestamp() });
    // Any other leave/removal request for this player and team is moot now.
    const others = await db.collection('requests').where('playerId', '==', r.playerId).where('status', '==', 'pending').get();
    await Promise.all(others.docs.filter((d) => d.id !== requestId && ['leave_team', 'kick_player'].includes(d.data()!.type) && d.data()!.teamId === r.teamId)
      .map((d) => d.ref.update({ status: 'cancelled', decidedBy: uid, decidedAt: FieldValue.serverTimestamp() })));
    if (kick) await auditNote(uid, `Removed ${r.playerId} from ${r.teamId} (requested by ${r.requestedBy})`, `players/${r.playerId}`);
    return { status: 'accepted' };
  }
  // The invited player may have been made a captain since; moving them would leave that team without one.
  if (invite && (await captainsATeam(r.playerId))) throw new HttpsError('failed-precondition', "Captains can't move to another team. An admin has to change the captains first.");
  // A full squad can't take new players through requests (admins can still move players directly).
  const cap = await maxRosterSize();
  if (cap && r.toTeamId && (await squadSize(seasonId, r.toTeamId)) >= cap) {
    throw new HttpsError('failed-precondition', `This team's roster is full (${cap} players). Remove a player before accepting new ones.`);
  }
  let moved: { fromTeamId: string | null; toTeamId: string | null };
  if (seasonId) moved = await movePlayer(seasonId, r.playerId, r.toTeamId, uid, 'request');
  else {
    const p = await db.doc(`players/${r.playerId}`).get();
    moved = { fromTeamId: (p.data()?.currentTeamId as string) || null, toTeamId: r.toTeamId };
    await p.ref.update({ currentTeamId: r.toTeamId, updatedAt: FieldValue.serverTimestamp() });
  }
  await ref.update({ status: 'accepted', decidedBy: uid, decidedAt: FieldValue.serverTimestamp() });
  // A join request and an invite for the same player and team are the same move: once one is accepted, close the rest.
  const dupes = await db.collection('requests').where('playerId', '==', r.playerId).where('status', '==', 'pending').get();
  await Promise.all(dupes.docs.filter((d) => d.id !== requestId && ['join_team', 'transfer', 'team_invite'].includes(d.data()!.type) && d.data()!.toTeamId === r.toTeamId)
    .map((d) => d.ref.update({ status: 'cancelled', decidedBy: uid, decidedAt: FieldValue.serverTimestamp() })));
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
