import { onCall, HttpsError } from './runtime';
import { db, requireAdmin, auditNote, chunk } from './admin';
import { roundRobin, packIntoRounds, matchweekOf, Pair, groupBy } from './shared/league';
import { loadSeason, newMatch } from './derive';

/**
 * Single or double round-robin via the circle method. Divisions share round numbers.
 * mode "replace": delete unplayed league fixtures and regenerate (refuses if results exist unless force).
 * mode "topUp": add only missing pairings (late teams) in new rounds after the last existing round.
 */
export const generateSchedule = onCall(async (req) => {
  const uid = requireAdmin(req);
  const { seasonId, double = true, mode = 'replace', force = false } = req.data as { seasonId: string; double?: boolean; mode?: 'replace' | 'topUp'; force?: boolean };
  const season = await loadSeason(seasonId);
  if (season.locked) throw new HttpsError('failed-precondition', 'Season is locked.');
  const [entriesSnap, matchesSnap] = await Promise.all([
    db.collection(`seasons/${seasonId}/entries`).get(),
    db.collection(`seasons/${seasonId}/matches`).where('stage', '==', 'league').get(),
  ]);
  const entries = entriesSnap.docs.map((d) => ({ teamId: d.id, divisionId: (d.data().divisionId as string) || null, confirmed: d.data().confirmed !== false }))
    .filter((e) => e.confirmed);
  if (entries.length < 2) throw new HttpsError('failed-precondition', 'Need at least two confirmed teams.');
  const divisions = season.divided ? groupBy(entries, (e) => e.divisionId || '_') : { _: entries };
  const col = db.collection(`seasons/${seasonId}/matches`);
  const fixtures: { round: number; pair: Pair; divisionId: string | null }[] = [];

  if (mode === 'replace') {
    const playedCount = matchesSnap.docs.filter((d) => d.data().status === 'played').length;
    if (playedCount && !force) throw new HttpsError('failed-precondition', `${playedCount} results exist. Use top-up, or force to keep results and replace the rest.`);
    for (const group of chunk(matchesSnap.docs.filter((d) => d.data().status !== 'played'), 400)) {
      const b = db.batch(); group.forEach((d) => b.delete(d.ref)); await b.commit();
    }
    for (const [div, list] of Object.entries(divisions)) {
      const ids = list.map((e) => e.teamId).sort(() => Math.random() - 0.5);
      roundRobin(ids, double).forEach((rd, i) => rd.forEach((pair) => fixtures.push({ round: i + 1, pair, divisionId: div === '_' ? null : div })));
    }
    // Forced replace keeps results: never schedule two teams more often than the format allows (once single, twice
    // double — once each way), counting the results already played in either direction.
    const kept = dedupeAgainstPlayed(fixtures, matchesSnap.docs.filter((d) => d.data().status === 'played').map((d) => d.data() as { homeTeamId: string; awayTeamId: string }), double);
    fixtures.splice(0, fixtures.length, ...kept);
  } else {
    const existing = matchesSnap.docs.map((d) => d.data());
    const key = (h: string, a: string) => (double ? `${h}>${a}` : [h, a].sort().join('|'));
    const have = new Set(existing.map((m) => key(m.homeTeamId, m.awayTeamId)));
    const lastRound = existing.reduce((mx, m) => Math.max(mx, m.round || 0), 0);
    for (const [div, list] of Object.entries(divisions)) {
      const ids = list.map((e) => e.teamId);
      const missing: Pair[] = [];
      for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++) {
        if (i === j || (!double && j < i)) continue;
        const [h, a] = [ids[i], ids[j]];
        if (!have.has(key(h, a))) { missing.push([h, a]); have.add(key(h, a)); }
      }
      packIntoRounds(missing).forEach((rd, i) => rd.forEach((pair) => fixtures.push({ round: lastRound + i + 1, pair, divisionId: div === '_' ? null : div })));
    }
  }

  for (const group of chunk(fixtures, 400)) {
    const b = db.batch();
    group.forEach((f) => b.set(col.doc(), newMatch({
      stage: 'league', round: f.round, matchweek: matchweekOf(f.round, season.roundsPerWeek), divisionId: f.divisionId,
      homeTeamId: f.pair[0], awayTeamId: f.pair[1], createdBy: uid, updatedBy: uid,
    })));
    await b.commit();
  }
  await auditNote(uid, `Generated ${fixtures.length} fixtures (${mode}, ${double ? 'double' : 'single'} round-robin)`, `seasons/${seasonId}/matches`);
  return { created: fixtures.length, rounds: new Set(fixtures.map((f) => f.round)).size };
});

/**
 * Drop regenerated fixtures so that, together with the played results, each pair of teams meets at most once
 * (single round-robin) or twice (double). Fixtures in a home/away direction that hasn't been played yet are kept first,
 * so a double round-robin still gets one home and one away game whenever possible.
 */
export function dedupeAgainstPlayed<T extends { pair: Pair }>(fixtures: T[], played: { homeTeamId: string; awayTeamId: string }[], double: boolean): T[] {
  const limit = double ? 2 : 1;
  const pairKey = (h: string, a: string) => [h, a].sort().join('|');
  const meetings = new Map<string, number>();
  const playedDirected = new Set<string>();
  for (const m of played) {
    const k = pairKey(m.homeTeamId, m.awayTeamId);
    meetings.set(k, (meetings.get(k) || 0) + 1);
    playedDirected.add(`${m.homeTeamId}>${m.awayTeamId}`);
  }
  const keep = fixtures.map(() => false);
  for (const freshOnly of [true, false]) {
    fixtures.forEach((f, i) => {
      if (keep[i]) return;
      const [h, a] = f.pair;
      if (freshOnly && playedDirected.has(`${h}>${a}`)) return;
      const k = pairKey(h, a);
      if ((meetings.get(k) || 0) >= limit) return;
      meetings.set(k, (meetings.get(k) || 0) + 1);
      keep[i] = true;
    });
  }
  return fixtures.filter((_, i) => keep[i]);
}
