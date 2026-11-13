import { onCall, HttpsError } from './runtime';
import { db, FieldValue, Timestamp, requireAdmin, auditNote, chunk } from './admin';
import { loadSeason, recomputeSeason } from './derive';
import { syncRolesFor } from './players';
import { DEFAULT_SEASON, PlayerStatRow, StandingRow, ordinal } from './shared/league';

/**
 * Four-step wizard backend: create season, copy rosters, set status (and optionally make it current). Runs in the admin's browser.
 * teamIds may be empty: teams are then added by admins or join through captains' season requests.
 */
export const moveToNextSeason = onCall(async (req) => {
  const uid = requireAdmin(req);
  const { fromSeasonId, number, name, teamIds = [], copyRosters = true, status = 'signups', setCurrent = true, completePrevious = true, kickoffDate = null } = req.data as {
    fromSeasonId?: string; number: number; name?: string; teamIds?: string[]; copyRosters?: boolean;
    status?: string; setCurrent?: boolean; completePrevious?: boolean; kickoffDate?: number | null;
  };
  if (!number || number < 1) throw new HttpsError('invalid-argument', 'Season number required.');
  const id = `s${number}`;
  const ref = db.doc(`seasons/${id}`);
  if ((await ref.get()).exists) throw new HttpsError('already-exists', `${id} already exists.`);
  const prev = fromSeasonId ? await loadSeason(fromSeasonId) : null;
  const carry = prev ? (({ roundsPerWeek, divided, divisions, scoring, seriesFormat, tiebreakers, zones, finalsFormat }) =>
    ({ roundsPerWeek, divided, divisions, scoring, seriesFormat, tiebreakers, zones, finalsFormat }))(prev) : {};
  await ref.set({ ...DEFAULT_SEASON, ...carry, number, name: name || `Season ${number}`, status, locked: false, kickoffDate: kickoffDate ? Timestamp.fromMillis(kickoffDate) : null, createdAt: FieldValue.serverTimestamp() });

  const batch = db.batch();
  const prevEntries = fromSeasonId ? await db.collection(`seasons/${fromSeasonId}/entries`).get() : null;
  for (const t of teamIds) {
    const pe = prevEntries?.docs.find((d) => d.id === t)?.data();
    batch.set(db.doc(`seasons/${id}/entries/${t}`), { confirmed: true, divisionId: pe?.divisionId ?? null, seed: null, joinedAt: FieldValue.serverTimestamp() });
  }
  let rosterPlayers: Record<string, string[]> = {};
  if (copyRosters && fromSeasonId) {
    const rs = await db.collection(`seasons/${fromSeasonId}/rosters`).get();
    rosterPlayers = Object.fromEntries(rs.docs.filter((d) => teamIds.includes(d.id)).map((d) => [d.id, d.data().playerIds || []]));
    for (const [t, ps] of Object.entries(rosterPlayers)) batch.set(db.doc(`seasons/${id}/rosters/${t}`), { playerIds: ps, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
  }
  if (setCurrent) batch.set(db.doc('settings/general'), { currentSeasonId: id }, { merge: true });
  const completing = completePrevious && fromSeasonId && prev?.status !== 'complete';
  if (completePrevious && fromSeasonId) batch.update(db.doc(`seasons/${fromSeasonId}`), { status: 'complete', locked: true });
  await batch.commit();

  if (setCurrent) {
    const onRoster = new Map<string, string>();
    for (const [t, ps] of Object.entries(rosterPlayers)) ps.forEach((p) => onRoster.set(p, t));
    const players = await db.collection('players').get();
    for (const group of chunk(players.docs, 400)) {
      const b = db.batch();
      group.forEach((p) => {
        const cur = (p.data().currentTeamId as string | null) || null;
        // Players whose club isn't in the new season stay with their club (it can still request to join).
        const t = onRoster.get(p.id) ?? (cur && !teamIds.includes(cur) ? cur : null);
        if (cur !== t) b.update(p.ref, { currentTeamId: t });
      });
      await b.commit();
    }
    await syncRolesFor(Object.keys(rosterPlayers));
  }
  // Completing a season generates its Wrapped (formerly the onSeasonComplete trigger).
  if (completing) await buildWrappedFor(fromSeasonId!);
  await auditNote(uid, `Launched ${id} from ${fromSeasonId ?? 'scratch'} with ${teamIds.length} teams`, `seasons/${id}`);
  return { seasonId: id };
});

export async function buildWrappedFor(seasonId: string) {
  const { rows: standings, playerRows } = await recomputeSeason(seasonId);
  const season = await loadSeason(seasonId);
  const teams = Object.fromEntries((await db.collection('teams').get()).docs.map((d) => [d.id, d.data().name]));
  const rankOf = (key: keyof PlayerStatRow) => {
    const sorted = [...playerRows].sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0));
    return (pid: string) => sorted.findIndex((r) => r.playerId === pid) + 1;
  };
  const goalsRank = rankOf('goals'), assistsRank = rankOf('assists'), savesRank = rankOf('saves');
  let n = 0;
  for (const group of chunk(playerRows, 400)) {
    const b = db.batch();
    for (const r of group) {
      const st = standings.find((s: StandingRow) => s.teamId === r.teamId);
      const slides = [
        { kind: 'intro', title: `${season.name} Wrapped`, value: '', caption: 'Your season in numbers' },
        { kind: 'stat', title: 'Games played', value: r.gp, caption: `${r.w} wins · ${r.d} draws · ${r.l} losses (${Math.round(r.adv.winRate * 100)}% win rate)` },
        { kind: 'stat', title: 'Goals', value: r.goals, caption: `${ordinal(goalsRank(r.playerId))} in the league` },
        { kind: 'stat', title: 'Assists', value: r.assists, caption: `${ordinal(assistsRank(r.playerId))} in the league` },
        r.saves ? { kind: 'stat', title: 'Saves', value: r.saves, caption: `${ordinal(savesRank(r.playerId))} in the league` } : null,
        { kind: 'stat', title: 'Best game', value: `${r.bestGame.goals} goals`, caption: 'Your highest-scoring game' },
        { kind: 'stat', title: 'MVPs', value: r.mvps, caption: r.mvps ? 'Standout performances' : 'Next season…' },
        st ? { kind: 'team', title: teams[r.teamId!] || 'Your team', value: ordinal(st.pos), caption: `${st.pts} points · ${st.w}W ${st.d}D ${st.l}L` } : null,
      ].filter(Boolean);
      b.set(db.doc(`seasons/${seasonId}/wrapped/${r.playerId}`), { slides, generatedAt: FieldValue.serverTimestamp() });
      n++;
    }
    await b.commit();
  }
  return n;
}

/** Also called by the browser when an admin marks a season complete. */
export const buildWrapped = onCall(async (req) => {
  const uid = requireAdmin(req);
  const seasonId = req.data?.seasonId as string;
  if (!seasonId) throw new HttpsError('invalid-argument', 'seasonId required.');
  const n = await buildWrappedFor(seasonId);
  await auditNote(uid, `Built Wrapped for ${n} players`, `seasons/${seasonId}`);
  return { players: n };
});
