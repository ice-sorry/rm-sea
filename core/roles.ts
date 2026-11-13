import { onCall, logger } from './runtime';
import { db, requireAdmin, currentSeasonId, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } from './admin';
import { discordApi } from './discord';

// Each Worker invocation may make ≤50 subrequests on the free plan: ~8 go to Firestore, the rest to Discord.
const OPS_PER_CALL = 30;
const STATE = 'private/roleSync'; // { seasonId, teams: { [teamId]: discordIds[] } } — what we last applied

async function discordIdsByPlayer(playerIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!playerIds.length) return out;
  const docs = await db.getAll(...[...new Set(playerIds)].map((id) => db.doc(`players/${id}`)));
  docs.forEach((d) => { const id = d.data()?.discordId; if (id) out.set(d.id, id); });
  return out;
}

const roleCall = (method: 'PUT' | 'DELETE', discordId: string, roleId: string) =>
  discordApi(DISCORD_BOT_TOKEN.value(), method, `/guilds/${DISCORD_GUILD_ID.value()}/members/${discordId}/roles/${roleId}`)
    .then(() => true)
    .catch((e) => { logger.warn('role sync failed', { discordId, roleId, e: String(e) }); return false; });

/**
 * Incremental sync for rosters that just changed (replaces the onRosterWrite trigger).
 * Compares each team's roster with what was last applied and adds/removes the team role. Paged.
 */
export const syncTeamRoles = onCall(async (req) => {
  requireAdmin(req);
  const sid = await currentSeasonId();
  const teamIds = ((req.data?.teamIds as string[]) || []).filter(Boolean);
  if (!sid || !teamIds.length || !DISCORD_BOT_TOKEN.value()) return { added: 0, removed: 0, done: true };
  const [stateSnap, ...rest] = await db.getAll(db.doc(STATE), ...teamIds.flatMap((t) => [db.doc(`teams/${t}`), db.doc(`seasons/${sid}/rosters/${t}`)]));
  const state = (stateSnap.data() || {}) as { seasonId?: string; teams?: Record<string, string[]> };
  const applied = state.seasonId === sid ? { ...(state.teams || {}) } : {};
  const ops: { method: 'PUT' | 'DELETE'; discordId: string; roleId: string; teamId: string }[] = [];
  const want: Record<string, string[]> = {};
  const rosterOf: Record<string, string[]> = {};
  teamIds.forEach((t, i) => { rosterOf[t] = rest[i * 2 + 1].data()?.playerIds || []; });
  const ids = await discordIdsByPlayer(Object.values(rosterOf).flat());
  teamIds.forEach((t, i) => {
    const roleId = rest[i * 2].data()?.discordRoleId as string | undefined;
    if (!roleId) return;
    want[t] = rosterOf[t].map((p) => ids.get(p)).filter((x): x is string => !!x);
    const before = applied[t] || [];
    want[t].filter((d) => !before.includes(d)).forEach((d) => ops.push({ method: 'PUT', discordId: d, roleId, teamId: t }));
    before.filter((d) => !want[t].includes(d)).forEach((d) => ops.push({ method: 'DELETE', discordId: d, roleId, teamId: t }));
  });
  let added = 0, removed = 0;
  for (const op of ops.slice(0, OPS_PER_CALL)) {
    if (!(await roleCall(op.method, op.discordId, op.roleId))) continue;
    const cur = new Set(applied[op.teamId] || []);
    if (op.method === 'PUT') { cur.add(op.discordId); added++; } else { cur.delete(op.discordId); removed++; }
    applied[op.teamId] = [...cur];
  }
  const done = ops.length <= OPS_PER_CALL;
  // Failed calls are not retried forever: once a page finishes, record the wanted state.
  if (done) Object.assign(applied, want);
  await db.doc(STATE).set({ seasonId: sid, teams: applied });
  return { added, removed, done, cursor: null };
});

/**
 * Full sync: add every rostered player's team role; remove team roles from members no longer on that roster.
 * Removal needs the bot's Server Members intent; without it only additions happen. Paged via cursor.
 */
export const syncRoles = onCall(async (req) => {
  requireAdmin(req);
  const sid = await currentSeasonId();
  if (!sid) return { added: 0, removed: 0, done: true };
  const cursor = Number(req.data?.cursor || 0);
  const [teams, rosters] = await Promise.all([db.collection('teams').get(), db.collection(`seasons/${sid}/rosters`).get()]);
  const ids = await discordIdsByPlayer(rosters.docs.flatMap((r) => r.data()!.playerIds || []));
  const roleToAllowed = new Map<string, Set<string>>();
  const want: Record<string, string[]> = {};
  const ops: { method: 'PUT' | 'DELETE'; discordId: string; roleId: string }[] = [];
  for (const t of teams.docs) {
    const roleId = t.data()!.discordRoleId;
    if (!roleId) continue;
    const roster: string[] = rosters.docs.find((r) => r.id === t.id)?.data()!.playerIds || [];
    want[t.id] = roster.map((p) => ids.get(p)).filter((x): x is string => !!x);
    roleToAllowed.set(roleId, new Set(want[t.id]));
    want[t.id].forEach((d) => ops.push({ method: 'PUT', discordId: d, roleId }));
  }
  const adds = ops.length;
  if (cursor + OPS_PER_CALL > adds) {
    // Removal pass: needs the member list (one call per 1,000 members).
    try {
      let after = '0';
      for (;;) {
        const page = await discordApi<{ user: { id: string }; roles: string[] }[]>(DISCORD_BOT_TOKEN.value(), 'GET', `/guilds/${DISCORD_GUILD_ID.value()}/members?limit=1000&after=${after}`);
        for (const m of page) for (const r of m.roles) {
          const allowed = roleToAllowed.get(r);
          if (allowed && !allowed.has(m.user.id)) ops.push({ method: 'DELETE', discordId: m.user.id, roleId: r });
        }
        if (page.length < 1000) break;
        after = page[page.length - 1].user.id;
      }
    } catch (e) { logger.warn('member listing unavailable; skipped removals', String(e)); }
  }
  // Removals shrink as they are applied, so they are always taken from the start of the removal list.
  const slice = cursor < adds ? ops.slice(cursor, Math.min(adds, cursor + OPS_PER_CALL)) : ops.slice(adds, adds + OPS_PER_CALL);
  let added = 0, removed = 0;
  for (const op of slice) if (await roleCall(op.method, op.discordId, op.roleId)) op.method === 'PUT' ? added++ : removed++;
  const nextCursor = cursor < adds ? cursor + slice.length : adds;
  const done = cursor >= adds ? ops.length - adds <= OPS_PER_CALL : false;
  if (done) await db.doc(STATE).set({ seasonId: sid, teams: want });
  return { added, removed, done, cursor: nextCursor };
});
