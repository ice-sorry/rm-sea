import { onCall, logger, invoke } from './runtime';
import type { QuerySnapshot, WriteBatch } from './firestore';
import { db, FieldValue, getSettings, getPrivateDiscord, discordAllowed, requireAdmin } from './admin';
import { webhookPost } from './discord';
import {
  Bracket, BracketSlot, Entry, Match, Season, DEFAULT_SEASON, summarizeSeries, computeStandings, computePlayerStats,
  computeTeamStats, computeLeaders, recomputeBracket, matchweekOf, stageForRoundKey, PlayerStatRow, StandingRow,
} from './shared/league';

const docsToMatches = (snap: QuerySnapshot) => snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Match);

export async function loadSeason(seasonId: string): Promise<Season> {
  const s = await db.doc(`seasons/${seasonId}`).get();
  return { ...DEFAULT_SEASON, id: seasonId, number: 0, name: seasonId, ...(s.data() as Partial<Season>) } as Season;
}
export async function teamNames(): Promise<Record<string, string>> {
  const t = await db.collection('teams').get();
  return Object.fromEntries(t.docs.map((d) => [d.id, d.data()!.name as string]));
}

/** Recompute every derived doc for a season from its matches. */
export async function recomputeSeason(seasonId: string) {
  const [season, entriesSnap, matchesSnap, names] = await Promise.all([
    loadSeason(seasonId),
    db.collection(`seasons/${seasonId}/entries`).get(),
    db.collection(`seasons/${seasonId}/matches`).get(),
    teamNames(),
  ]);
  const entries: Entry[] = entriesSnap.docs.map((d) => ({ teamId: d.id, confirmed: !!d.data()!.confirmed, divisionId: d.data()!.divisionId ?? null, seed: d.data()!.seed ?? null }));
  const matches = docsToMatches(matchesSnap);
  const { rows, byRound } = computeStandings(season, entries, matches, names);
  const playerRows = computePlayerStats(matches);
  const teamRows = computeTeamStats(matches);
  const leaders = computeLeaders(playerRows);
  const leagueOnly = computePlayerStats(matches.filter((m) => m.stage === 'league'));
  const now = FieldValue.serverTimestamp();
  const played = matches.filter((m) => m.status === 'played');
  const base = `seasons/${seasonId}/derived`;
  const batch = db.batch();
  batch.set(db.doc(`${base}/standings`), { rows, byRound, computedAt: now });
  batch.set(db.doc(`${base}/positions`), { byRound, computedAt: now });
  batch.set(db.doc(`${base}/playerStats`), { rows: playerRows, leagueRows: leagueOnly, computedAt: now });
  batch.set(db.doc(`${base}/teamStats`), { rows: teamRows, computedAt: now });
  batch.set(db.doc(`${base}/leaders`), {
    categories: leaders, computedAt: now,
    totals: {
      series: played.length,
      games: played.reduce((s, m) => s + (m.games?.length || 0), 0),
      goals: played.reduce((s, m) => s + (m.goalsHome || 0) + (m.goalsAway || 0), 0),
    },
  });
  await batch.commit();
  return { rows, playerRows };
}

// ---------- Records ----------
export interface CareerStats { goals: number; assists: number; gp: number; mvps: number; saves: number; interceptions: number; passes: number; seasons: number }
interface RecordEntry { key: string; label: string; value: number; holderType: 'player' | 'team'; holderId: string; seasonId: string | null; matchId: string | null }

export async function recomputeRecords() {
  const [seasonsSnap, allMatches] = await Promise.all([db.collection('seasons').get(), db.collectionGroup('matches').get()]);
  const records: RecordEntry[] = [];
  const best = (key: string, label: string, holderType: 'player' | 'team', cand: Omit<RecordEntry, 'key' | 'label' | 'holderType'>) => {
    const cur = records.find((r) => r.key === key);
    if (!cur) records.push({ key, label, holderType, ...cand });
    else if (cand.value > cur.value) Object.assign(cur, cand);
  };
  const career = new Map<string, CareerStats>();
  const derivedSnaps = await db.getAll(...seasonsSnap.docs.flatMap((s) => [db.doc(`seasons/${s.id}/derived/playerStats`), db.doc(`seasons/${s.id}/derived/standings`)]));
  seasonsSnap.docs.forEach((s, i) => {
    const ps = derivedSnaps[i * 2], st = derivedSnaps[i * 2 + 1];
    for (const r of (ps.data()?.rows || []) as PlayerStatRow[]) {
      best('season_goals', 'Most goals in a season', 'player', { value: r.goals, holderId: r.playerId, seasonId: s.id, matchId: null });
      best('season_assists', 'Most assists in a season', 'player', { value: r.assists, holderId: r.playerId, seasonId: s.id, matchId: null });
      best('season_saves', 'Most saves in a season', 'player', { value: r.saves, holderId: r.playerId, seasonId: s.id, matchId: null });
      best('season_mvps', 'Most MVPs in a season', 'player', { value: r.mvps, holderId: r.playerId, seasonId: s.id, matchId: null });
      best('season_interceptions', 'Most interceptions in a season', 'player', { value: r.interceptions || 0, holderId: r.playerId, seasonId: s.id, matchId: null });
      const c = career.get(r.playerId) || { goals: 0, assists: 0, gp: 0, mvps: 0, saves: 0, interceptions: 0, passes: 0, seasons: 0 };
      c.goals += r.goals; c.assists += r.assists; c.gp += r.gp; c.mvps += r.mvps; c.saves += r.saves;
      c.interceptions += r.interceptions || 0; c.passes += r.passes || 0; c.seasons += 1;
      career.set(r.playerId, c);
    }
    for (const r of (st.data()?.rows || []) as StandingRow[]) {
      best('season_points', 'Most points in a season', 'team', { value: r.pts, holderId: r.teamId, seasonId: s.id, matchId: null });
      best('season_gd', 'Best goal difference in a season', 'team', { value: r.gd, holderId: r.teamId, seasonId: s.id, matchId: null });
    }
    // Longest series win streak within a season
    const ms = allMatches.docs.filter((d) => d.ref.parent.parent?.id === s.id && d.ref.parent.parent?.parent.id === 'seasons')
      .map((d) => ({ id: d.id, ...d.data() }) as Match).filter((m) => m.status === 'played' && m.stage === 'league').sort((a, b) => a.round - b.round);
    const streak = new Map<string, number>();
    for (const m of ms) for (const t of [m.homeTeamId, m.awayTeamId]) {
      const n = m.winnerTeamId === t ? (streak.get(t) || 0) + 1 : 0;
      streak.set(t, n);
      best('win_streak', 'Longest win streak', 'team', { value: n, holderId: t, seasonId: s.id, matchId: m.id });
    }
  });
  for (const d of allMatches.docs) {
    const m = { id: d.id, ...d.data() } as Match;
    if (m.status !== 'played') continue;
    const seasonId = d.ref.parent.parent?.parent.id === 'seasons' ? d.ref.parent.parent!.id : null;
    for (const g of m.games || []) {
      for (const [pid, s] of Object.entries(g.playerStats || {})) {
        best('game_goals', 'Most goals in a game', 'player', { value: s.goals || 0, holderId: pid, seasonId, matchId: m.id });
        best('game_saves', 'Most saves in a game', 'player', { value: s.saves || 0, holderId: pid, seasonId, matchId: m.id });
      }
      const margin = Math.abs(g.homeGoals - g.awayGoals);
      if (margin) best('biggest_win', 'Biggest winning margin (game)', 'team', { value: margin, holderId: g.homeGoals > g.awayGoals ? m.homeTeamId : m.awayTeamId, seasonId, matchId: m.id });
    }
    best('series_goals', 'Most goals in a series', 'team', { value: m.goalsHome, holderId: m.homeTeamId, seasonId, matchId: m.id });
    best('series_goals', 'Most goals in a series', 'team', { value: m.goalsAway, holderId: m.awayTeamId, seasonId, matchId: m.id });
  }
  for (const [pid, c] of career) {
    best('career_goals', 'All-time goals', 'player', { value: c.goals, holderId: pid, seasonId: null, matchId: null });
    best('career_assists', 'All-time assists', 'player', { value: c.assists, holderId: pid, seasonId: null, matchId: null });
    best('career_apps', 'All-time appearances (games)', 'player', { value: c.gp, holderId: pid, seasonId: null, matchId: null });
  }
  const milestones: { key: string; label: string; holderId: string; value: number }[] = [];
  for (const [pid, c] of career) {
    for (const t of [25, 50, 100, 250]) if (c.goals >= t) milestones.push({ key: `goals_${t}`, label: `${t} career goals`, holderId: pid, value: c.goals });
    for (const t of [50, 100, 250]) if (c.gp >= t) milestones.push({ key: `apps_${t}`, label: `${t} appearances`, holderId: pid, value: c.gp });
    for (const t of [10, 25, 50]) if (c.mvps >= t) milestones.push({ key: `mvps_${t}`, label: `${t} MVPs`, holderId: pid, value: c.mvps });
  }
  await db.doc('derived/records').set({
    records: records.filter((r) => r.value > 0), milestones,
    career: Object.fromEntries(career), computedAt: FieldValue.serverTimestamp(),
  });
}

// ---------- Brackets ----------
function slotResult(matches: Match[], key: string) {
  const m = matches.find((x) => x.bracketSlot === key && x.status === 'played' && x.winnerTeamId);
  if (!m) return null;
  return { winnerTeamId: m.winnerTeamId!, loserTeamId: m.winnerTeamId === m.homeTeamId ? m.awayTeamId : m.homeTeamId };
}

/** Recompute season brackets, propagate second-chance feeds, and keep slot matches in sync. */
export async function recomputeSeasonBrackets(seasonId: string) {
  const [bSnap, mSnap] = await Promise.all([db.collection(`seasons/${seasonId}/playoffs`).get(), db.collection(`seasons/${seasonId}/matches`).get()]);
  if (bSnap.empty) return;
  const matches = docsToMatches(mSnap);
  // The Finals Shield (second-chance bracket) was retired: drop it and any route into it.
  const batch0 = db.batch();
  const shield = bSnap.docs.find((d) => d.id === 'shield');
  if (shield) {
    batch0.delete(shield.ref);
    matches.filter((m) => m.bracketSlot?.startsWith('shield:') && m.status !== 'played').forEach((m) => batch0.delete(db.doc(`seasons/${seasonId}/matches/${m.id}`)));
  }
  await batch0.commit();
  const brackets = new Map(bSnap.docs.filter((d) => d.id !== 'shield').map((d) => {
    const b = d.data() as Bracket;
    b.rounds?.forEach((r) => r.slots.forEach((s) => { if (s.loserFeedsTo?.includes(':')) s.loserFeedsTo = null; }));
    return [d.id, b];
  }));
  if (!brackets.size) return;
  const run = (id: string) => recomputeBracket(brackets.get(id)!, (s) => slotResult(matches, `${id}:${s.slot}`));
  const targeted = new Set<string>();
  const first = new Map<string, ReturnType<typeof run>>();
  for (const id of brackets.keys()) { const r = run(id); first.set(id, r); r.external.forEach((e) => targeted.add(e.bracketId)); }
  for (const [id, r] of first) {
    brackets.set(id, r.bracket);
    for (const e of r.external) {
      const tb = brackets.get(e.bracketId);
      const slot = tb?.rounds.flatMap((x) => x.slots).find((x) => x.slot === e.slot);
      if (slot) slot[e.side === 'home' ? 'homeTeamId' : 'awayTeamId'] = e.teamId;
    }
  }
  for (const id of targeted) if (brackets.has(id)) brackets.set(id, run(id).bracket);

  const batch = db.batch();
  for (const [id, b] of brackets) {
    b.rounds.forEach((round, ri) => round.slots.forEach((slot) => syncSlotMatch(batch, seasonId, id, round.key, ri, slot, matches)));
    batch.set(db.doc(`seasons/${seasonId}/playoffs/${id}`), { ...b, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  await batch.commit();
}

function syncSlotMatch(batch: WriteBatch, seasonId: string, bracketId: string, roundKey: string, roundIdx: number, slot: BracketSlot, matches: Match[]) {
  const key = `${bracketId}:${slot.slot}`;
  const existing = matches.find((m) => m.bracketSlot === key);
  if (existing) slot.matchId = existing.id;
  const col = db.collection(`seasons/${seasonId}/matches`);
  if (existing && existing.status !== 'played') {
    if (!slot.homeTeamId || !slot.awayTeamId) { batch.delete(col.doc(existing.id)); slot.matchId = null; return; }
    if (existing.homeTeamId !== slot.homeTeamId || existing.awayTeamId !== slot.awayTeamId)
      batch.update(col.doc(existing.id), { homeTeamId: slot.homeTeamId, awayTeamId: slot.awayTeamId, updatedBy: 'system', updatedAt: FieldValue.serverTimestamp() });
    return;
  }
  if (!existing && slot.homeTeamId && slot.awayTeamId) {
    const ref = col.doc();
    slot.matchId = ref.id;
    batch.set(ref, newMatch({
      stage: bracketId === 'finals' ? stageForRoundKey(roundKey) : 'cup', round: 1000 + roundIdx, matchweek: 0,
      homeTeamId: slot.homeTeamId, awayTeamId: slot.awayTeamId, bracketSlot: key,
    }));
  }
}

export function newMatch(p: Partial<Match> & Pick<Match, 'homeTeamId' | 'awayTeamId' | 'round' | 'stage'>) {
  return {
    divisionId: null, matchweek: 0, status: 'scheduled', kickoffAt: null, matchDate: null, games: [],
    seriesHome: 0, seriesAway: 0, goalsHome: 0, goalsAway: 0, winnerTeamId: null, mvpPlayerId: null,
    screenshotUrls: [], verification: 'ok', discordThreadId: null, bracketSlot: null,
    createdBy: 'system', updatedBy: 'system', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    ...p,
  };
}

// ---------- Normalisation & verification ----------
function normalize(m: Match, season: Season): Partial<Match> | null {
  const sum = summarizeSeries(m.games || [], season.seriesFormat);
  const winner = m.status === 'played' ? (sum.winnerSide === 'home' ? m.homeTeamId : sum.winnerSide === 'away' ? m.awayTeamId : null) : null;
  const issues: string[] = [];
  if (m.status === 'played') {
    if (!sum.complete) issues.push('Series incomplete for the configured format');
    (m.games || []).forEach((g) => {
      const ps = Object.values(g.playerStats || {});
      if (!ps.length) return;
      const hg = ps.filter((p) => p.teamId === m.homeTeamId).reduce((s, p) => s + (p.goals || 0), 0);
      const ag = ps.filter((p) => p.teamId === m.awayTeamId).reduce((s, p) => s + (p.goals || 0), 0);
      if (hg > g.homeGoals || ag > g.awayGoals) issues.push(`Game ${g.n}: player goals exceed the score`);
    });
    if (!m.games?.length) issues.push('No games entered');
  }
  const verification = (m as Match & { verifiedOverride?: boolean }).verifiedOverride ? 'ok' : issues.length ? 'check' : 'ok';
  const want: Partial<Match> & { verificationIssues: string[] } = {
    seriesHome: sum.seriesHome, seriesAway: sum.seriesAway, goalsHome: sum.goalsHome, goalsAway: sum.goalsAway,
    winnerTeamId: winner, verification, verificationIssues: issues,
    ...(m.stage === 'league' && m.round ? { matchweek: matchweekOf(m.round, season.roundsPerWeek) } : {}),
  };
  const diff = Object.entries(want).some(([k, v]) => JSON.stringify((m as unknown as Record<string, unknown>)[k] ?? null) !== JSON.stringify(v ?? null));
  return diff ? want : null;
}

const resultKey = (m?: Partial<Match> | null) => m ? JSON.stringify([m.status, m.games, m.homeTeamId, m.awayTeamId, m.stage, m.round, m.mvpPlayerId, m.winnerTeamId, m.bracketSlot]) : '';

/**
 * Runs in the admin's browser after any write to a season match (replaces the onMatchWrite trigger):
 * normalise the series, recompute standings/stats/brackets/records, then ask the Worker for Discord side effects.
 * Pass resultChanged: false for kickoff-only edits to skip the recompute.
 */
export const afterMatchWrite = onCall(async (req) => {
  requireAdmin(req);
  const { seasonId, matchId, resultChanged = true } = req.data as { seasonId: string; matchId: string; resultChanged?: boolean };
  const season = await loadSeason(seasonId);
  const ref = db.doc(`seasons/${seasonId}/matches/${matchId}`);
  const snap = await ref.get();
  if (snap.exists) {
    const fix = normalize({ id: snap.id, ...snap.data() } as Match, season);
    if (fix) await ref.update(fix);
  }
  if (resultChanged) {
    await recomputeSeason(seasonId);
    await recomputeSeasonBrackets(seasonId);
    await recomputeRecords();
  }
  await invoke('matchSideEffects', { seasonId, matchId }).catch((e) => logger.warn('Discord side effects failed', e));
  return { ok: true };
});

/** Worker: result webhook (first post or edit, tracked via postedResultKey). */
export const matchSideEffects = onCall(async (req) => {
  requireAdmin(req);
  const { seasonId, matchId } = req.data as { seasonId: string; matchId: string };
  const ref = db.doc(`seasons/${seasonId}/matches/${matchId}`);
  const snap = await ref.get();
  if (snap.exists) {
    const m = { id: snap.id, ...snap.data() } as Match & { postedResultKey?: string | null };
    const key = m.status === 'played' ? resultKey(m) : null;
    const prev = m.postedResultKey ?? null;
    if (key !== prev) {
      if (key) {
        const edited = !!prev;
        const integ = await getSettings<{ autoPost?: boolean; autoPostOnEdit?: boolean }>('integrations');
        if (discordAllowed(integ) && ((!edited && integ.autoPost) || (edited && integ.autoPostOnEdit))) await postResult(seasonId, m, edited).catch((e) => logger.warn(e));
      }
      await ref.update({ postedResultKey: key });
    }
  }
  return { ok: true };
});

async function postResult(seasonId: string, m: Match, edited: boolean) {
  const priv = await getPrivateDiscord();
  if (!priv.resultWebhookUrl) return;
  const names = await teamNames();
  const general = await getSettings<{ siteUrl?: string; leagueName?: string }>('general');
  let mvp = '';
  if (m.mvpPlayerId) mvp = (await db.doc(`players/${m.mvpPlayerId}`).get()).data()?.name || '';
  const games = (m.games || []).map((g) => `Game ${g.n}: ${g.homeGoals}–${g.awayGoals}`).join('\n');
  await webhookPost(priv.resultWebhookUrl, {
    username: general.leagueName || 'SEA Rematch League',
    embeds: [{
      title: `${edited ? '✏️ Updated: ' : ''}${names[m.homeTeamId] || 'Home'} ${m.seriesHome}–${m.seriesAway} ${names[m.awayTeamId] || 'Away'}`,
      description: `${m.stage === 'league' ? `Round ${m.round}` : m.stage.toUpperCase()}\n${games}${mvp ? `\n⭐ MVP: ${mvp}` : ''}`,
      color: 0x1d8ade,
      url: general.siteUrl ? `${general.siteUrl}/#fixtures?match=${seasonId}/${m.id}` : undefined,
    }],
  });
}

// ---------- Cups ----------
/** Runs in the admin's browser after a cup match write (replaces the onCupMatchWrite trigger). */
export const afterCupMatchWrite = onCall(async (req) => {
  requireAdmin(req);
  const { cupId: c, matchId } = req.data as { cupId: string; matchId?: string };
  if (matchId) {
    const mref = db.doc(`cups/${c}/matches/${matchId}`);
    const snap = await mref.get();
    if (snap.exists) {
      const fix = normalize({ id: snap.id, ...snap.data() } as Match, { ...DEFAULT_SEASON, id: '', number: 0, name: '' } as Season);
      if (fix) { delete (fix as unknown as Record<string, unknown>).matchweek; await mref.update(fix); }
    }
  }
  const cupRef = db.doc(`cups/${c}`);
  const cup = (await cupRef.get()).data();
  if (!cup?.bracket) return { ok: true };
  const ms = docsToMatches(await db.collection(`cups/${c}/matches`).get());
  const { bracket } = recomputeBracket(cup.bracket as Bracket, (s) => slotResult(ms, s.slot));
  const batch = db.batch();
  bracket.rounds.forEach((r, ri) => r.slots.forEach((slot) => {
    const ex = ms.find((m) => m.bracketSlot === slot.slot);
    if (ex) {
      slot.matchId = ex.id;
      if (ex.status !== 'played' && (!slot.homeTeamId || !slot.awayTeamId)) { batch.delete(db.doc(`cups/${c}/matches/${ex.id}`)); slot.matchId = null; }
      else if (ex.status !== 'played' && (ex.homeTeamId !== slot.homeTeamId || ex.awayTeamId !== slot.awayTeamId))
        batch.update(db.doc(`cups/${c}/matches/${ex.id}`), { homeTeamId: slot.homeTeamId, awayTeamId: slot.awayTeamId });
      return;
    }
    if (slot.homeTeamId && slot.awayTeamId) {
      const ref = db.collection(`cups/${c}/matches`).doc();
      slot.matchId = ref.id;
      batch.set(ref, newMatch({ stage: 'cup', round: ri + 1, homeTeamId: slot.homeTeamId, awayTeamId: slot.awayTeamId, bracketSlot: slot.slot }));
    }
  }));
  const final = bracket.rounds[bracket.rounds.length - 1]?.slots[0];
  batch.update(cupRef, { bracket, championTeamId: final?.winnerTeamId || null });
  await batch.commit();
  return { ok: true };
});

/** Admin "recompute everything" escape hatch. Runs in the admin's browser. */
export const recomputeAll = onCall(async (req) => {
  requireAdmin(req);
  const seasonId = req.data?.seasonId as string | undefined;
  const seasons = seasonId ? [seasonId] : (await db.collection('seasons').get()).docs.map((d) => d.id);
  for (const s of seasons) { await recomputeSeason(s); await recomputeSeasonBrackets(s); }
  await recomputeRecords();
  return { seasons };
});
