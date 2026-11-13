/**
 * Seed: 1 season, 10 teams, 50 players, a generated double round-robin and 5 sample results.
 * Runs against the Emulator Suite by default:   npm run seed
 * Against a real project (careful!):            SEED_PROD=1 GOOGLE_APPLICATION_CREDENTIALS=key.json npm run seed
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  roundRobin, matchweekOf, summarizeSeries, computeStandings, computePlayerStats, computeTeamStats, computeLeaders,
  DEFAULT_SEASON, Game, Match, Position,
} from '../core/shared/league';

const projectId = process.env.GCLOUD_PROJECT || process.env.VITE_FIREBASE_PROJECT_ID || 'srl-dev';
if (!process.env.SEED_PROD) {
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
}
initializeApp({ projectId });
const db = getFirestore();

const TEAMS: [string, string, string][] = [
  ['Manila Mavericks', 'MNL', '#1D8ADE'], ['Jakarta Jaguars', 'JKT', '#ef4444'], ['Bangkok Blitz', 'BKK', '#eab308'],
  ['Kuala Lumpur Kites', 'KUL', '#22c55e'], ['Singapore Strikers', 'SGP', '#e11d48'], ['Hanoi Hornets', 'HAN', '#f97316'],
  ['Cebu Corsairs', 'CEB', '#8b5cf6'], ['Penang Pirates', 'PEN', '#14b8a6'], ['Surabaya Sharks', 'SUB', '#0ea5e9'], ['Saigon Sabres', 'SGN', '#a3e635'],
];
const FIRST = ['Ari', 'Bayu', 'Chen', 'Dewi', 'Eko', 'Farid', 'Gita', 'Hiro', 'Indra', 'Jun', 'Kai', 'Lina', 'Minh', 'Nadia', 'Omar', 'Putri', 'Quan', 'Rizal', 'Siti', 'Tan', 'Uma', 'Vu', 'Wira', 'Xian', 'Yuki'];
const LAST = ['Santos', 'Wijaya', 'Nguyen', 'Tan', 'Lim', 'Reyes', 'Hassan', 'Pham', 'Lee', 'Cruz'];
const POS: Position[] = ['GK', 'DF', 'MF', 'WF', 'ST'];

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const ri = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

async function wipe() {
  for (const col of await db.listCollections()) await db.recursiveDelete(col);
}

async function main() {
  console.log(`Seeding ${projectId} ${process.env.SEED_PROD ? '(PRODUCTION)' : '(emulator)'}…`);
  if (!process.env.SEED_PROD) await wipe();
  const seasonId = 's1';
  const now = Date.now();

  // Settings
  await db.doc('settings/general').set({ currentSeasonId: seasonId, homeMode: 'live', pinnedSeasonId: null, leagueName: 'SEA Rematch League', siteUrl: 'http://localhost:5000', socials: {} });
  await db.doc('settings/admins').set({ ownerUids: ['discord:100000000000000001'], adminUids: [], adminRoleIds: ['1562781903604424794', '1563169917384134827'] });
  await db.doc('settings/integrations').set({ guildId: '1562776724431831050', matchReportChannelId: '', alertsChannelId: '', autoPost: true, autoPostOnEdit: false });
  await db.doc('private/discord').set({ resultWebhookUrl: '', rulesWebhookUrl: '' });
  await db.doc('content/rules').set({
    markdown: '# SEA Rematch League Rules\n\n## 1. Format\nEach fixture is 2 games. Every game is a win, draw or loss worth 3, 1 or 0 points.\n\n## 2. Scheduling\nCaptains agree a kickoff in the match thread before the matchweek ends.\n\n## 3. Results\nPost scoreboard screenshots for every game.\n',
    updatedBy: 'seed', updatedAt: FieldValue.serverTimestamp(), discordMessageIds: [],
  });

  // Season
  await db.doc(`seasons/${seasonId}`).set({ ...DEFAULT_SEASON, number: 1, name: 'Season 1', status: 'live', kickoffDate: Timestamp.fromMillis(now - 14 * 86400_000) });

  // Teams, players, entries, rosters
  const teamIds: string[] = [];
  const rosters: Record<string, string[]> = {};
  let pi = 0;
  for (const [name, short, color] of TEAMS) {
    const t = db.collection('teams').doc();
    teamIds.push(t.id);
    await t.set({ name, shortName: short, nameNormalized: name.toLowerCase(), color, crestUrl: '', discordRoleId: null, captainIds: [], active: true, mergedInto: null });
    await db.doc(`seasons/${seasonId}/entries/${t.id}`).set({ confirmed: true, divisionId: null, seed: null, joinedAt: FieldValue.serverTimestamp() });
    rosters[t.id] = [];
    for (let k = 0; k < 5; k++) {
      const p = db.collection('players').doc();
      const pname = `${FIRST[pi % FIRST.length]} ${LAST[(pi * 7) % LAST.length]}${pi >= FIRST.length ? ` ${Math.floor(pi / FIRST.length) + 1}` : ''}`;
      await p.set({
        name: pname, nameLower: pname.toLowerCase(), discordId: null, ownerUid: null, linkSource: null, position: POS[k],
        currentTeamId: t.id, avatarUrl: '', bio: '', country: ['PH', 'ID', 'TH', 'MY', 'SG', 'VN'][pi % 6], mergedInto: null,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      rosters[t.id].push(p.id);
      pi++;
    }
    await db.doc(`seasons/${seasonId}/rosters/${t.id}`).set({ playerIds: rosters[t.id], updatedAt: FieldValue.serverTimestamp(), updatedBy: 'seed' });
    await t.update({ captainIds: [rosters[t.id][2]] });
  }

  // Dev accounts for emulator sign-in (see the 🧪 button next to "Sign in")
  const captainTeam = teamIds[0];
  const captainPlayer = rosters[captainTeam][2];
  await db.doc('users/discord:100000000000000001').set({ discordId: '100000000000000001', username: 'dev-owner', displayName: 'Dev Owner', avatarUrl: '', role: 'owner', guildRoleIds: [], playerId: null, createdAt: FieldValue.serverTimestamp(), lastLoginAt: FieldValue.serverTimestamp() });
  await db.doc('users/discord:100000000000000002').set({ discordId: '100000000000000002', username: 'dev-user', displayName: 'Dev Newbie', avatarUrl: '', role: 'user', guildRoleIds: [], playerId: null, createdAt: FieldValue.serverTimestamp(), lastLoginAt: FieldValue.serverTimestamp() });
  await db.doc('users/discord:100000000000000003').set({ discordId: '100000000000000003', username: 'dev-captain', displayName: 'Dev Captain', avatarUrl: '', role: 'user', guildRoleIds: [], playerId: captainPlayer, createdAt: FieldValue.serverTimestamp(), lastLoginAt: FieldValue.serverTimestamp() });
  await db.doc(`players/${captainPlayer}`).update({ discordId: '100000000000000003', ownerUid: 'discord:100000000000000003', linkSource: 'admin' });

  // Double round-robin (18 rounds for 10 teams)
  const rounds = roundRobin(teamIds, true);
  const matches: Match[] = [];
  const batch = db.batch();
  rounds.forEach((rd, i) => rd.forEach(([h, a]) => {
    const ref = db.collection(`seasons/${seasonId}/matches`).doc();
    const round = i + 1;
    const m = {
      id: ref.id, stage: 'league', round, matchweek: matchweekOf(round, 2), divisionId: null, homeTeamId: h, awayTeamId: a,
      status: 'scheduled', kickoffAt: round <= 4 ? Timestamp.fromMillis(now + (round - 3) * 3 * 86400_000 + ri(0, 8) * 3600_000) : null, matchDate: null, games: [],
      seriesHome: 0, seriesAway: 0, goalsHome: 0, goalsAway: 0, winnerTeamId: null, mvpPlayerId: null, screenshotUrls: [],
      verification: 'ok', discordThreadId: null, bracketSlot: null, createdBy: 'seed', updatedBy: 'seed',
    } as unknown as Match;
    matches.push(m);
  }));

  // 5 sample results from round 1
  const sample = matches.filter((m) => m.round === 1).slice(0, 5);
  for (const m of sample) {
    const games: Game[] = [];
    let g = 0;
    while (summarizeSeries(games).needsAnotherGame && g < 5) {
      g++;
      const hg = ri(0, 5), ag = ri(0, 5) === hg ? ri(0, 4) : ri(0, 5);
      const ps: Game['playerStats'] = {};
      for (const [team, goals] of [[m.homeTeamId, hg], [m.awayTeamId, ag]] as const) {
        let left = goals;
        rosters[team].forEach((pid, k) => {
          const scored = k === 4 ? left : Math.min(left, ri(0, k >= 2 ? 2 : 1));
          left -= scored;
          ps[pid] = { teamId: team, goals: scored, assists: ri(0, 2), saves: k === 0 ? ri(2, 9) : ri(0, 1), passes: ri(10, 40), interceptions: ri(0, 6) };
        });
      }
      const all = Object.entries(ps).sort((x, y) => ((y[1].goals || 0) + (y[1].assists || 0)) - ((x[1].goals || 0) + (x[1].assists || 0)));
      ps[all[0][0]].mvp = true;
      games.push({ n: g, homeGoals: hg, awayGoals: ag, sidesSwapped: g % 2 === 0, playerStats: ps });
    }
    const s = summarizeSeries(games);
    Object.assign(m, {
      status: 'played', games, matchDate: Timestamp.fromMillis(now - 3 * 86400_000), seriesHome: s.seriesHome, seriesAway: s.seriesAway,
      goalsHome: s.goalsHome, goalsAway: s.goalsAway, winnerTeamId: s.winnerSide === 'home' ? m.homeTeamId : s.winnerSide === 'away' ? m.awayTeamId : null,
      mvpPlayerId: Object.entries(games[0].playerStats!).find(([, x]) => x.mvp)?.[0] ?? null,
    });
  }
  for (const m of matches) {
    const { id, ...data } = m;
    batch.set(db.doc(`seasons/${seasonId}/matches/${id}`), { ...data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();

  // Derived docs (the onMatchWrite function recomputes these too when the Functions emulator is running)
  const entries = teamIds.map((teamId) => ({ teamId, confirmed: true, divisionId: null, seed: null }));
  const names = Object.fromEntries(teamIds.map((id, i) => [id, TEAMS[i][0]]));
  const { rows, byRound } = computeStandings(DEFAULT_SEASON, entries, matches, names);
  const playerRows = computePlayerStats(matches);
  const played = matches.filter((m) => m.status === 'played');
  await db.doc(`seasons/${seasonId}/derived/standings`).set({ rows, byRound, computedAt: FieldValue.serverTimestamp() });
  await db.doc(`seasons/${seasonId}/derived/positions`).set({ byRound, computedAt: FieldValue.serverTimestamp() });
  await db.doc(`seasons/${seasonId}/derived/playerStats`).set({ rows: playerRows, leagueRows: playerRows, computedAt: FieldValue.serverTimestamp() });
  await db.doc(`seasons/${seasonId}/derived/teamStats`).set({ rows: computeTeamStats(matches), computedAt: FieldValue.serverTimestamp() });
  await db.doc(`seasons/${seasonId}/derived/leaders`).set({
    categories: computeLeaders(playerRows), computedAt: FieldValue.serverTimestamp(),
    totals: { series: played.length, games: played.reduce((s, m) => s + m.games.length, 0), goals: played.reduce((s, m) => s + m.goalsHome + m.goalsAway, 0) },
  });

  console.log(`✔ ${teamIds.length} teams, ${pi} players, ${matches.length} fixtures over ${rounds.length} rounds, ${sample.length} results.`);
  console.log('Dev sign-in (emulator): owner discord:100000000000000001 · new user …002 · captain …003');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
