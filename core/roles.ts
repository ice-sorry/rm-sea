import { onCall, logger } from './runtime';
import { db, requireAdmin, currentSeasonId, getSettings, discordAllowed, requireDiscordOn, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID } from './admin';
import { discordApi } from './discord';

// Each Worker invocation may make ≤50 subrequests on the free plan: ~8 go to Firestore, the rest to Discord.
const OPS_PER_CALL = 30;
const STATE = 'private/roleSync'; // { seasonId, teams: { [teamId]: discordIds[] }, captains: discordIds[] } — what we last applied
const CAPTAIN_ROLE_NAME = 'Captain';
const CAPTAINS = '__captains'; // key for the captain role in the in-memory applied/want maps

type Integ = Record<string, unknown> & { captainRoleId?: string };
type TeamData = { name?: string; color?: string; discordRoleId?: string | null; captainIds?: string[]; active?: boolean; mergedInto?: string | null };
type Op = { method: 'PUT' | 'DELETE'; discordId: string; roleId: string; key: string };

/** Active, unmerged teams get roles; their captains get the captain role. */
const live = (t: TeamData | undefined): t is TeamData => !!t && t.active !== false && !t.mergedInto;
const captainPlayerIds = (teams: (TeamData | undefined)[]) => [...new Set(teams.filter(live).flatMap((t) => t.captainIds || []))];

const guild = <T = unknown>(method: string, path: string, body?: unknown) =>
  discordApi<T>(DISCORD_BOT_TOKEN.value(), method, `/guilds/${DISCORD_GUILD_ID.value()}${path}`, body);

async function discordIdsByPlayer(playerIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!playerIds.length) return out;
  const docs = await db.getAll(...[...new Set(playerIds)].map((id) => db.doc(`players/${id}`)));
  docs.forEach((d) => { const id = d.data()?.discordId; if (id) out.set(d.id, id); });
  return out;
}

const roleCall = (method: 'PUT' | 'DELETE', discordId: string, roleId: string) =>
  guild(method, `/members/${discordId}/roles/${roleId}`)
    .then(() => true)
    .catch((e) => { logger.warn('role sync failed', { discordId, roleId, e: String(e) }); return false; });

/**
 * Finds or creates server roles by name. An existing role with the same name is reused, so a lost
 * write-back (or a role an admin made by hand) never leads to duplicates. Created roles grant no permissions.
 */
class RoleMaker {
  private roles: { id: string; name: string }[] | null = null;
  calls = 0;
  async ensure(name: string, color?: string): Promise<string | null> {
    const wanted = name.trim().slice(0, 100);
    if (!wanted) return null;
    try {
      if (!this.roles) { this.calls++; this.roles = await guild<{ id: string; name: string }[]>('GET', '/roles'); }
      const hit = this.roles.find((r) => r.name === wanted);
      if (hit) return hit.id;
      this.calls++;
      const n = parseInt(String(color || '').replace('#', ''), 16);
      const made = await guild<{ id: string; name: string }>('POST', '/roles', { name: wanted, color: Number.isFinite(n) ? n : 0, permissions: '0' });
      this.roles.push(made);
      return made.id;
    } catch (e) {
      logger.warn('role create failed', { name: wanted, e: String(e) });
      return null;
    }
  }
}

/**
 * Creates the roles that are missing (team roles for live teams, and the captain role when wanted) and saves
 * their IDs on the team / in settings/integrations. Mutates `teams` and `integ` in place. Returns how many were linked.
 */
async function createMissingRoles(maker: RoleMaker, teams: { id: string; data: TeamData | undefined }[], integ: Integ, withCaptain: boolean, budget: number) {
  const batch = db.batch();
  let made = 0;
  for (const t of teams) {
    if (maker.calls >= budget) break;
    if (!live(t.data) || t.data.discordRoleId || !t.data.name) continue;
    const id = await maker.ensure(t.data.name, t.data.color);
    if (!id) continue;
    t.data.discordRoleId = id;
    batch.update(db.doc(`teams/${t.id}`), { discordRoleId: id });
    made++;
  }
  if (withCaptain && !integ.captainRoleId && maker.calls < budget) {
    const id = await maker.ensure(CAPTAIN_ROLE_NAME);
    if (id) { integ.captainRoleId = id; batch.set(db.doc('settings/integrations'), { captainRoleId: id }, { merge: true }); made++; }
  }
  if (made) await batch.commit();
  return made;
}

/**
 * Incremental sync for rosters (and, with `captains: true`, captain lists) that just changed.
 * Compares each team's roster with what was last applied and adds/removes the team role. Paged.
 */
export const syncTeamRoles = onCall(async (req) => {
  requireAdmin(req);
  const none = { added: 0, removed: 0, done: true };
  const teamIds = ((req.data?.teamIds as string[]) || []).filter(Boolean);
  const wantCaptains = !!req.data?.captains;
  if ((!teamIds.length && !wantCaptains) || !DISCORD_BOT_TOKEN.value()) return none;
  const [sid, integ] = await Promise.all([currentSeasonId(), getSettings<Integ>('integrations')]);
  if (!sid || !discordAllowed(integ, 'roleSync')) return none;
  const withCaptain = wantCaptains && discordAllowed(integ, 'captainRole');
  const [[stateSnap, ...rest], allTeams] = await Promise.all([
    db.getAll(db.doc(STATE), ...teamIds.flatMap((t) => [db.doc(`teams/${t}`), db.doc(`seasons/${sid}/rosters/${t}`)])),
    // The captain role covers every team, so its target needs every team's captain list.
    withCaptain ? db.collection('teams').get() : null,
  ]);
  const teams = teamIds.map((id, i) => ({ id, data: rest[i * 2].data() as TeamData | undefined }));
  const maker = new RoleMaker();
  if (discordAllowed(integ, 'roleCreate')) await createMissingRoles(maker, teams, integ, withCaptain, OPS_PER_CALL);
  const budget = OPS_PER_CALL - maker.calls;

  const state = (stateSnap.data() || {}) as { seasonId?: string; teams?: Record<string, string[]>; captains?: string[] };
  const applied: Record<string, string[]> = state.seasonId === sid ? { ...(state.teams || {}), [CAPTAINS]: state.captains || [] } : {};
  const rosterOf: Record<string, string[]> = {};
  teamIds.forEach((t, i) => { rosterOf[t] = rest[i * 2 + 1].data()?.playerIds || []; });
  const captainPids = withCaptain && integ.captainRoleId ? captainPlayerIds(allTeams!.docs.map((d) => d.data() as TeamData)) : [];
  const ids = await discordIdsByPlayer([...Object.values(rosterOf).flat(), ...captainPids]);
  const toIds = (pids: string[]) => pids.map((p) => ids.get(p)).filter((x): x is string => !!x);

  const ops: Op[] = [];
  const want: Record<string, string[]> = {};
  const diff = (key: string, roleId: string, target: string[]) => {
    want[key] = target;
    const before = applied[key] || [];
    target.filter((d) => !before.includes(d)).forEach((d) => ops.push({ method: 'PUT', discordId: d, roleId, key }));
    before.filter((d) => !target.includes(d)).forEach((d) => ops.push({ method: 'DELETE', discordId: d, roleId, key }));
  };
  for (const t of teams) if (t.data?.discordRoleId) diff(t.id, t.data.discordRoleId, toIds(rosterOf[t.id]));
  if (withCaptain && integ.captainRoleId) diff(CAPTAINS, integ.captainRoleId!, toIds(captainPids));

  let added = 0, removed = 0;
  for (const op of ops.slice(0, budget)) {
    if (!(await roleCall(op.method, op.discordId, op.roleId))) continue;
    const cur = new Set(applied[op.key] || []);
    if (op.method === 'PUT') { cur.add(op.discordId); added++; } else { cur.delete(op.discordId); removed++; }
    applied[op.key] = [...cur];
  }
  const done = ops.length <= budget;
  // Failed calls are not retried forever: once a page finishes, record the wanted state.
  if (done) Object.assign(applied, want);
  const { [CAPTAINS]: captains = [], ...teamsApplied } = applied;
  await db.doc(STATE).set({ seasonId: sid, teams: teamsApplied, captains });
  return { added, removed, done, cursor: null };
});

/**
 * Full sync: create missing roles, add every rostered player's team role and every captain's captain role;
 * remove those roles from members who no longer qualify.
 * Removal needs the bot's Server Members intent; without it only additions happen. Paged via cursor.
 */
export const syncRoles = onCall(async (req) => {
  requireAdmin(req);
  const integ = (await requireDiscordOn('roleSync')) as Integ;
  const sid = await currentSeasonId();
  if (!sid) return { added: 0, removed: 0, done: true };
  const cursor = Number(req.data?.cursor || 0);
  const withCaptain = discordAllowed(integ, 'captainRole');
  const [teamSnap, rosters] = await Promise.all([db.collection('teams').get(), db.collection(`seasons/${sid}/rosters`).get()]);
  const teams = teamSnap.docs.map((d) => ({ id: d.id, data: d.data() as TeamData }));
  // First page only: create what's missing, then start over, so the op list stays the same across later pages.
  if (cursor === 0 && discordAllowed(integ, 'roleCreate')) {
    const created = await createMissingRoles(new RoleMaker(), teams, integ, withCaptain, OPS_PER_CALL);
    if (created) return { added: 0, removed: 0, created, done: false, cursor: 0 };
  }
  const captainPids = withCaptain && integ.captainRoleId ? captainPlayerIds(teams.map((t) => t.data)) : [];
  const ids = await discordIdsByPlayer([...rosters.docs.flatMap((r) => r.data()!.playerIds || []), ...captainPids]);
  const toIds = (pids: string[]) => pids.map((p) => ids.get(p)).filter((x): x is string => !!x);
  const roleToAllowed = new Map<string, Set<string>>();
  const want: Record<string, string[]> = {};
  const ops: Omit<Op, 'key'>[] = [];
  for (const t of teams) {
    const roleId = t.data.discordRoleId;
    if (!roleId) continue;
    want[t.id] = toIds(rosters.docs.find((r) => r.id === t.id)?.data()!.playerIds || []);
    roleToAllowed.set(roleId, new Set(want[t.id]));
    want[t.id].forEach((d) => ops.push({ method: 'PUT', discordId: d, roleId }));
  }
  let captains: string[] = [];
  if (withCaptain && integ.captainRoleId) {
    captains = toIds(captainPids);
    roleToAllowed.set(integ.captainRoleId, new Set(captains));
    captains.forEach((d) => ops.push({ method: 'PUT', discordId: d, roleId: integ.captainRoleId! }));
  }
  const adds = ops.length;
  if (cursor + OPS_PER_CALL > adds) {
    // Removal pass: needs the member list (one call per 1,000 members).
    try {
      let after = '0';
      for (;;) {
        const page = await guild<{ user: { id: string }; roles: string[] }[]>('GET', `/members?limit=1000&after=${after}`);
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
  if (done) await db.doc(STATE).set({ seasonId: sid, teams: want, captains });
  return { added, removed, done, cursor: nextCursor };
});
