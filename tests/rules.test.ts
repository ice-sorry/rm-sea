/**
 * Security rules tests — run with: npm run test:rules  (starts the Firestore emulator)
 */
import { readFileSync } from 'fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection } from 'firebase/firestore';

let env: RulesTestEnvironment;
const USER = 'discord:200', ADMIN = 'discord:300', OWNER = 'discord:400', CAPTAIN = 'discord:500', ROSTERED = 'discord:700';

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'srl-rules-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'seasons/s1'), { name: 'Season 1', locked: false, status: 'live' });
    await setDoc(doc(d, 'seasons/s2'), { name: 'Season 2', locked: true, status: 'complete' });
    await setDoc(doc(d, 'seasons/s1/matches/m1'), { homeTeamId: 't1', awayTeamId: 't2', status: 'scheduled', screenshotUrls: [] });
    await setDoc(doc(d, 'seasons/s2/matches/m1'), { homeTeamId: 't1', awayTeamId: 't2', status: 'played' });
    await setDoc(doc(d, 'seasons/s1/rosters/t1'), { playerIds: ['p-cap', 'p-mem'] });
    await setDoc(doc(d, `users/${ROSTERED}`), { discordId: '700', role: 'user', playerId: 'p-mem' });
    await setDoc(doc(d, 'cups/c1/matches/m1'), { homeTeamId: 't1', awayTeamId: 't2', status: 'scheduled', screenshotUrls: [] });
    await setDoc(doc(d, 'seasons/s1/rosters/t2'), { playerIds: [] });
    await setDoc(doc(d, 'seasons/s1/derived/standings'), { rows: [] });
    await setDoc(doc(d, `users/${USER}`), { discordId: '200', role: 'user', playerId: null });
    await setDoc(doc(d, `users/${CAPTAIN}`), { discordId: '500', role: 'user', playerId: 'p-cap' });
    await setDoc(doc(d, 'teams/t1'), { name: 'Team 1', shortName: 'T1', color: '#1D8ADE', crestUrl: '', captainIds: ['p-cap'] });
    await setDoc(doc(d, 'teams/t2'), { name: 'Team 2', captainIds: [] });
    await setDoc(doc(d, 'players/p1'), { name: 'P1', ownerUid: null });
    await setDoc(doc(d, 'players/p-cap'), { name: 'Cap', ownerUid: CAPTAIN, bio: '' });
    await setDoc(doc(d, 'private/discord'), { resultWebhookUrl: 'https://discord.com/api/webhooks/x/y' });
    await setDoc(doc(d, 'auditLog/a1'), { note: 'x' });
    await setDoc(doc(d, 'settings/admins'), { adminUids: [ADMIN], ownerUids: [OWNER] });
    await setDoc(doc(d, 'settings/general'), { currentSeasonId: 's1' });
  });
});

const as = (uid: string | null, role = 'user') => (uid ? env.authenticatedContext(uid, { role }) : env.unauthenticatedContext()).firestore();

describe('public reads', () => {
  it('anyone reads league data', async () => {
    await assertSucceeds(getDoc(doc(as(null), 'seasons/s1/matches/m1')));
    await assertSucceeds(getDoc(doc(as(null), 'seasons/s1/derived/standings')));
    await assertSucceeds(getDoc(doc(as(null), 'settings/general')));
  });
  it('visitors cannot read users, private, settings/admins', async () => {
    await assertFails(getDoc(doc(as(null), `users/${USER}`)));
    await assertFails(getDoc(doc(as(USER), 'private/discord')));
    await assertFails(getDoc(doc(as(USER), 'settings/admins')));
  });
});

describe('non-admins cannot write league data', () => {
  it('blocks match, team, season, settings writes', async () => {
    await assertFails(updateDoc(doc(as(USER), 'seasons/s1/matches/m1'), { status: 'played' }));
    await assertFails(setDoc(doc(as(USER), 'teams/t9'), { name: 'Hack' }));
    await assertFails(updateDoc(doc(as(USER), 'seasons/s1'), { locked: true }));
    await assertFails(setDoc(doc(as(USER), 'settings/general'), { currentSeasonId: 'x' }));
    await assertFails(updateDoc(doc(as(USER), 'players/p1'), { name: 'Mine' }));
  });
  it('blocks derived writes for non-admins, private writes for admins, and keeps the audit log append-only', async () => {
    await assertFails(setDoc(doc(as(USER), 'seasons/s1/derived/standings'), { rows: [] }));
    await assertFails(setDoc(doc(as(USER), 'derived/records'), {}));
    await assertFails(updateDoc(doc(as(ADMIN, 'admin'), 'auditLog/a1'), { note: 'edited' }));
    await assertFails(deleteDoc(doc(as(OWNER, 'owner'), 'auditLog/a1')));
    await assertFails(setDoc(doc(as(ADMIN, 'admin'), 'private/discord'), { resultWebhookUrl: 'x' }));
  });
  it('audit entries must carry the writer uid', async () => {
    await assertSucceeds(addDoc(collection(as(USER), 'auditLog'), { actorUid: USER, kind: 'client', path: 'players/p1', op: 'update' }));
    await assertFails(addDoc(collection(as(USER), 'auditLog'), { actorUid: ADMIN, kind: 'client', path: 'players/p1', op: 'update' }));
    await assertFails(addDoc(collection(as(USER), 'auditLog'), { actorUid: USER, kind: 'server', path: 'players/p1', op: 'update' }));
  });
  it('users cannot escalate their own role or claim a player directly', async () => {
    await assertFails(updateDoc(doc(as(USER), `users/${USER}`), { role: 'admin' }));
    await assertFails(updateDoc(doc(as(USER), `users/${USER}`), { playerId: 'p1' }));
  });
});

describe('admins', () => {
  it('write league data and read private/audit', async () => {
    await assertSucceeds(updateDoc(doc(as(ADMIN, 'admin'), 'seasons/s1/matches/m1'), { status: 'agreed' }));
    await assertSucceeds(setDoc(doc(as(ADMIN, 'admin'), 'teams/t9'), { name: 'New' }));
    await assertSucceeds(getDoc(doc(as(ADMIN, 'admin'), 'private/discord')));
    await assertSucceeds(getDoc(doc(as(ADMIN, 'admin'), 'auditLog/a1')));
  });
  it('recompute derived docs, power rankings and Wrapped in the browser', async () => {
    await assertSucceeds(setDoc(doc(as(ADMIN, 'admin'), 'seasons/s1/derived/standings'), { rows: [] }));
    await assertSucceeds(setDoc(doc(as(ADMIN, 'admin'), 'derived/records'), { records: [] }));
    await assertSucceeds(setDoc(doc(as(ADMIN, 'admin'), 'seasons/s1/powerRankings/3'), { rows: [] }));
    await assertSucceeds(setDoc(doc(as(ADMIN, 'admin'), 'seasons/s1/wrapped/p1'), { slides: [] }));
    await assertSucceeds(setDoc(doc(as(ADMIN, 'admin'), 'restorePoints/r1/chunks/0000'), { data: '{}' }));
  });
  it('cannot edit results in a locked season', async () => {
    await assertFails(updateDoc(doc(as(ADMIN, 'admin'), 'seasons/s2/matches/m1'), { status: 'void' }));
  });
  it('only owners edit settings/admins', async () => {
    await assertFails(setDoc(doc(as(ADMIN, 'admin'), 'settings/admins'), { adminUids: [] }));
    await assertSucceeds(setDoc(doc(as(OWNER, 'owner'), 'settings/admins'), { adminUids: [ADMIN], ownerUids: [OWNER] }));
  });
  it('owners can rewrite any collection for merge/restore; admins cannot', async () => {
    await assertSucceeds(setDoc(doc(as(OWNER, 'owner'), `users/${USER}`), { discordId: '200', role: 'user', playerId: 'p1' }));
    await assertFails(setDoc(doc(as(ADMIN, 'admin'), `users/${USER}`), { discordId: '200', role: 'user', playerId: 'p1' }));
  });
});

describe('self-service', () => {
  it('player owners edit their own profile fields only', async () => {
    await assertSucceeds(updateDoc(doc(as(CAPTAIN), 'players/p-cap'), { bio: 'hello' }));
    await assertFails(updateDoc(doc(as(CAPTAIN), 'players/p-cap'), { currentTeamId: 't2' }));
  });
  it('roster members attach screenshots only', async () => {
    await assertSucceeds(updateDoc(doc(as(CAPTAIN), 'seasons/s1/matches/m1'), { screenshotUrls: ['https://x/y.png'] }));
    await assertFails(updateDoc(doc(as(CAPTAIN), 'seasons/s1/matches/m1'), { screenshotUrls: ['https://x/y.png', 'https://x/z.png'] }));
    await assertFails(updateDoc(doc(as(USER), 'seasons/s1/matches/m1'), { screenshotUrls: ['https://x/y.png'] }));
    // A roster member who isn't a captain can't set it either.
    await assertFails(updateDoc(doc(as(ROSTERED), 'seasons/s1/matches/m1'), { screenshotUrls: ['https://x/y.png'] }));
    await assertSucceeds(updateDoc(doc(as(CAPTAIN), 'cups/c1/matches/m1'), { screenshotUrls: ['https://x/y.png'] }));
    await assertFails(updateDoc(doc(as(USER), 'cups/c1/matches/m1'), { screenshotUrls: ['https://x/y.png'] }));
    await assertFails(updateDoc(doc(as(CAPTAIN), 'seasons/s1/matches/m1'), { screenshotUrls: [], status: 'played' }));
  });
  it('captains attach one screenshot per game', async () => {
    await assertSucceeds(updateDoc(doc(as(CAPTAIN), 'seasons/s1/matches/m1'), { 'gameScreenshots.1': 'https://x/g1.png' }));
    await assertSucceeds(updateDoc(doc(as(CAPTAIN), 'seasons/s1/matches/m1'), { 'gameScreenshots.2': 'https://x/g2.png' }));
    await assertSucceeds(updateDoc(doc(as(CAPTAIN), 'cups/c1/matches/m1'), { 'gameScreenshots.1': 'https://x/g1.png' }));
    await assertFails(updateDoc(doc(as(USER), 'seasons/s1/matches/m1'), { 'gameScreenshots.1': 'https://x/g1.png' }));
    await assertFails(updateDoc(doc(as(ROSTERED), 'seasons/s1/matches/m1'), { 'gameScreenshots.1': 'https://x/g1.png' }));
    await assertFails(updateDoc(doc(as(CAPTAIN), 'seasons/s1/matches/m1'), { 'gameScreenshots.1': 'https://x/g1.png', status: 'played' }));
    await assertFails(updateDoc(doc(as(CAPTAIN), 'seasons/s2/matches/m1'), { 'gameScreenshots.1': 'https://x/g1.png' }));
  });
  it('requests must be pending, own, and for own player', async () => {
    await assertSucceeds(addDoc(collection(as(CAPTAIN), 'requests'), { type: 'transfer', playerId: 'p-cap', requestedBy: CAPTAIN, status: 'pending', toTeamId: 't2' }));
    await assertFails(addDoc(collection(as(CAPTAIN), 'requests'), { type: 'transfer', playerId: 'p-cap', requestedBy: CAPTAIN, status: 'accepted', toTeamId: 't2' }));
    await assertFails(addDoc(collection(as(USER), 'requests'), { type: 'join_team', playerId: 'p-cap', requestedBy: USER, status: 'pending', toTeamId: 't2' }));
  });
  it('a closed transfer window blocks player-move requests but not season requests', async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'settings/general'), { currentSeasonId: 's1', transfersBlocked: true }));
    await assertFails(addDoc(collection(as(CAPTAIN), 'requests'), { type: 'transfer', playerId: 'p-cap', requestedBy: CAPTAIN, status: 'pending', toTeamId: 't2' }));
    await assertFails(addDoc(collection(as(CAPTAIN), 'requests'), { type: 'new_team', playerId: 'p-cap', requestedBy: CAPTAIN, status: 'pending', toTeamId: null, teamName: 'X' }));
    await assertSucceeds(addDoc(collection(as(CAPTAIN), 'requests'), { type: 'join_season', teamId: 't1', seasonId: 's1', playerId: 'p-cap', requestedBy: CAPTAIN, status: 'pending', toTeamId: null }));
  });
  it('captains edit only their own team colour, abbreviation and logo link', async () => {
    await assertSucceeds(updateDoc(doc(as(CAPTAIN), 'teams/t1'), { color: '#ff8800' }));
    await assertSucceeds(updateDoc(doc(as(CAPTAIN), 'teams/t1'), { shortName: 'ABCD', crestUrl: 'https://cdn.discordapp.com/attachments/1/2/logo.png' }));
    await assertSucceeds(updateDoc(doc(as(CAPTAIN), 'teams/t1'), { crestUrl: '' }));
    await assertFails(updateDoc(doc(as(CAPTAIN), 'teams/t1'), { shortName: 'TOOLONG' }));
    await assertFails(updateDoc(doc(as(CAPTAIN), 'teams/t1'), { shortName: '' }));
    await assertFails(updateDoc(doc(as(CAPTAIN), 'teams/t1'), { crestUrl: 'javascript:alert(1)' }));
    await assertFails(updateDoc(doc(as(CAPTAIN), 'teams/t1'), { color: 'red' }));
    await assertFails(updateDoc(doc(as(CAPTAIN), 'teams/t1'), { color: '#ff8800', name: 'Renamed' }));
    await assertFails(updateDoc(doc(as(CAPTAIN), 'teams/t2'), { color: '#ff8800' }));
    await assertFails(updateDoc(doc(as(USER), 'teams/t1'), { color: '#ff8800' }));
  });
  it('players ask to leave only the team they are on, and only while transfers are open', async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'players/p-mem'), { name: 'Mem', ownerUid: ROSTERED, currentTeamId: 't1' }));
    const leave = (teamId: string) => addDoc(collection(as(ROSTERED), 'requests'),
      { type: 'leave_team', teamId, playerId: 'p-mem', fromTeamId: teamId, toTeamId: null, seasonId: 's1', requestedBy: ROSTERED, status: 'pending' });
    await assertSucceeds(leave('t1'));
    await assertFails(leave('t2'));
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'settings/general'), { currentSeasonId: 's1', transfersBlocked: true }));
    await assertFails(leave('t1'));
  });
  it('only a team captain can ask for the team to join or leave a season', async () => {
    const req = (type: string, teamId: string, by = CAPTAIN, playerId = 'p-cap') =>
      addDoc(collection(as(by), 'requests'), { type, teamId, seasonId: 's1', playerId, requestedBy: by, status: 'pending', toTeamId: null });
    await assertSucceeds(req('join_season', 't1'));
    await assertSucceeds(req('leave_season', 't1'));
    await assertFails(req('join_season', 't2'));
    await assertFails(req('leave_season', 't9'));
    await assertFails(req('join_season', 't1', USER, 'p1'));
  });
  it('users can only re-create their own unprivileged record', async () => {
    const NEW = 'discord:600';
    const base = { discordId: '600', role: 'user', guildRoleIds: [], playerId: null, displayName: 'Me' };
    await assertFails(setDoc(doc(as(NEW), `users/${NEW}`), { ...base, role: 'admin' }));
    await assertFails(setDoc(doc(as(NEW), `users/${NEW}`), { ...base, playerId: 'p1' }));
    await assertFails(setDoc(doc(as(NEW), `users/${NEW}`), { ...base, guildRoleIds: ['1562781903604424794'] }));
    await assertFails(setDoc(doc(as(NEW), 'users/discord:601'), { ...base, discordId: '601' }));
    await assertSucceeds(setDoc(doc(as(NEW), `users/${NEW}`), base));
  });
  it('players are created by the Worker or admins, not the browser', async () => {
    await assertFails(setDoc(doc(as(USER), 'players/mine'), { name: 'Me', ownerUid: USER, discordId: USER.split(':')[1], currentTeamId: null, linkSource: 'self' }));
  });
  it('predictions are per-user', async () => {
    await assertSucceeds(setDoc(doc(as(USER), `seasons/s1/predictions/${USER}`), { picks: {} }));
    await assertFails(setDoc(doc(as(USER), `seasons/s1/predictions/${CAPTAIN}`), { picks: {} }));
  });
});
