// Pure league logic shared by Cloud Functions and the web client (Predict tab, previews).
// No Firebase imports here — timestamps are typed structurally.

export interface TS { toMillis(): number }

export type Position = 'GK' | 'DF' | 'MF' | 'WF' | 'ST' | 'UNSURE';
export const POSITIONS: Position[] = ['GK', 'DF', 'MF', 'WF', 'ST', 'UNSURE'];
export const POSITION_LABELS: Record<Position, string> = {
  GK: 'Goalkeeper', DF: 'Defender', MF: 'Midfielder', WF: 'Wing Forward', ST: 'Striker', UNSURE: 'Flexible',
};

export type Stage = 'league' | 'wildcard' | 'qf' | 'sf' | 'final' | 'cup';
export type MatchStatus = 'scheduled' | 'agreed' | 'played' | 'void';
export type SeasonStatus = 'draft' | 'signups' | 'live' | 'finals' | 'complete';

export interface PlayerGameStats {
  teamId: string;
  goals?: number; assists?: number; interceptions?: number; passes?: number; saves?: number;
  mvp?: boolean;
  /** Legacy fields from older results; no longer entered. */
  shots?: number; tackles?: number; rating?: number;
}
export interface Game {
  n: number; homeGoals: number; awayGoals: number; sidesSwapped?: boolean;
  playerStats?: Record<string, PlayerGameStats>;
}
export interface Match {
  id: string;
  stage: Stage; round: number; matchweek: number; divisionId: string | null;
  homeTeamId: string; awayTeamId: string; status: MatchStatus;
  kickoffAt: TS | null; matchDate: TS | null;
  games: Game[];
  seriesHome: number; seriesAway: number; goalsHome: number; goalsAway: number;
  winnerTeamId: string | null; mvpPlayerId: string | null;
  screenshotUrls?: string[];
  verification?: 'ok' | 'check';
  discordThreadId?: string | null; bracketSlot?: string | null;
  createdBy?: string; updatedBy?: string; createdAt?: TS; updatedAt?: TS;
}

export interface Zone { from: number; to: number; label: string; color: string; kind: string }
export interface SeriesFormat { minGames: number; maxGames: number; rule: 'leadBy2' | 'bestOf' }
export interface Scoring { win: number; draw: number; loss: number }
export interface FinalsFormat {
  qualifiers: number; byeSeeds: number[]; directSeeds: number[]; wildcardSeeds: number[]; secondChanceSeeds: number[];
}
export interface Season {
  id: string; number: number; name: string; status: SeasonStatus; locked: boolean;
  kickoffDate: TS | null; roundsPerWeek: number; divided: boolean;
  divisions: { id: string; name: string }[];
  scoring: Scoring; seriesFormat: SeriesFormat; tiebreakers: string[];
  zones: Zone[]; finalsFormat: FinalsFormat; wrappedOpenUntil: TS | null;
}
export interface Entry { teamId: string; confirmed: boolean; divisionId: string | null; seed: number | null }

export const DEFAULT_ZONES: Zone[] = [
  { from: 1, to: 1, label: 'League Champions', color: '#eab308', kind: 'champion' },
  { from: 1, to: 2, label: 'Bye to quarterfinals', color: '#8b5cf6', kind: 'bye' },
  { from: 3, to: 6, label: 'Straight to quarterfinals', color: '#1D8ADE', kind: 'finals' },
  { from: 7, to: 10, label: 'Wildcard round', color: '#033c93', kind: 'wildcard' },
];
export const DEFAULT_SEASON: Omit<Season, 'id' | 'number' | 'name'> = {
  status: 'draft', locked: false, kickoffDate: null, roundsPerWeek: 2, divided: false, divisions: [],
  scoring: { win: 3, draw: 1, loss: 0 },
  seriesFormat: { minGames: 2, maxGames: 2, rule: 'leadBy2' },
  tiebreakers: ['pts', 'gd', 'gf', 'h2h'],
  zones: DEFAULT_ZONES,
  finalsFormat: { qualifiers: 10, byeSeeds: [1, 2], directSeeds: [3, 4, 5, 6], wildcardSeeds: [7, 8, 9, 10], secondChanceSeeds: [] },
  wrappedOpenUntil: null,
};

export const matchweekOf = (round: number, roundsPerWeek: number) => Math.ceil(round / Math.max(1, roundsPerWeek || 1));

// ---------- Series ----------
export interface SeriesSummary {
  seriesHome: number; seriesAway: number; goalsHome: number; goalsAway: number;
  winnerSide: 'home' | 'away' | null; complete: boolean; needsAnotherGame: boolean;
}
/** leadBy2: min 2 games; game 3 at 1–1, game 4 at 2–1, game 5 at 2–2; ends when a side leads by 2 or max reached. */
export function summarizeSeries(games: Game[], fmt: SeriesFormat = DEFAULT_SEASON.seriesFormat): SeriesSummary {
  let sh = 0, sa = 0, gh = 0, ga = 0;
  for (const g of games) {
    gh += g.homeGoals || 0; ga += g.awayGoals || 0;
    if (g.homeGoals > g.awayGoals) sh++; else if (g.awayGoals > g.homeGoals) sa++;
  }
  const n = games.length;
  let complete: boolean;
  if (fmt.rule === 'bestOf') {
    const need = Math.floor(fmt.maxGames / 2) + 1;
    complete = n >= fmt.maxGames || sh >= need || sa >= need;
  } else {
    complete = n >= fmt.maxGames || (n >= fmt.minGames && Math.abs(sh - sa) >= 2);
  }
  return {
    seriesHome: sh, seriesAway: sa, goalsHome: gh, goalsAway: ga,
    winnerSide: sh > sa ? 'home' : sa > sh ? 'away' : null,
    complete, needsAnotherGame: !complete,
  };
}

// ---------- Standings ----------
export interface StandingRow {
  teamId: string; divisionId: string | null;
  p: number; w: number; d: number; l: number; gf: number; ga: number; gd: number; pts: number;
  form: string[]; pos: number; zone: string | null;
}

const played = (m: Match) => m.status === 'played';
const isLeague = (m: Match) => (m.stage || 'league') === 'league';

function blankRow(teamId: string, divisionId: string | null): StandingRow {
  return { teamId, divisionId, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0, form: [], pos: 0, zone: null };
}

export function zoneFor(pos: number, zones: Zone[]): Zone | null {
  // First listed zone that covers the position wins the row band.
  return zones.find((z) => pos >= z.from && pos <= z.to) || null;
}

/** Points are earned per game, not per fixture: each game is a win, draw or loss (default 3 / 1 / 0). */
export function gamePoints(m: Pick<Match, 'homeTeamId' | 'awayTeamId' | 'games'>, teamId: string, scoring: Scoring): number {
  const home = teamId === m.homeTeamId;
  if (!home && teamId !== m.awayTeamId) return 0;
  let pts = 0;
  for (const g of m.games || []) {
    const mine = home ? g.homeGoals : g.awayGoals, theirs = home ? g.awayGoals : g.homeGoals;
    pts += mine > theirs ? scoring.win : mine < theirs ? scoring.loss : scoring.draw;
  }
  return pts;
}

function h2hPoints(a: string, b: string, matches: Match[], scoring: Scoring) {
  let pa = 0, pb = 0;
  for (const m of matches) {
    const ids = [m.homeTeamId, m.awayTeamId];
    if (!ids.includes(a) || !ids.includes(b)) continue;
    pa += gamePoints(m, a, scoring); pb += gamePoints(m, b, scoring);
  }
  return pa - pb;
}

export function sortStandings(rows: StandingRow[], tiebreakers: string[], matches: Match[], scoring: Scoring, names: Record<string, string> = {}) {
  return [...rows].sort((x, y) => {
    for (const t of tiebreakers) {
      let diff = 0;
      if (t === 'pts') diff = y.pts - x.pts;
      else if (t === 'gd') diff = y.gd - x.gd;
      else if (t === 'gf') diff = y.gf - x.gf;
      else if (t === 'w') diff = y.w - x.w;
      else if (t === 'h2h') diff = -h2hPoints(x.teamId, y.teamId, matches, scoring);
      if (diff) return diff;
    }
    return (names[x.teamId] || x.teamId).localeCompare(names[y.teamId] || y.teamId);
  });
}

export function computeStandings(
  season: Pick<Season, 'scoring' | 'tiebreakers' | 'zones' | 'divided'>,
  entries: Entry[], matches: Match[], names: Record<string, string> = {},
): { rows: StandingRow[]; byRound: Record<string, string[]> } {
  const league = matches.filter((m) => isLeague(m) && played(m)).sort((a, b) => a.round - b.round);
  const build = (upTo: number) => {
    const map = new Map<string, StandingRow>();
    for (const e of entries) map.set(e.teamId, blankRow(e.teamId, e.divisionId ?? null));
    const ms = league.filter((m) => m.round <= upTo);
    for (const m of ms) {
      const h = map.get(m.homeTeamId) || blankRow(m.homeTeamId, m.divisionId);
      const a = map.get(m.awayTeamId) || blankRow(m.awayTeamId, m.divisionId);
      map.set(h.teamId, h); map.set(a.teamId, a);
      // Every game in the fixture is its own win / draw / loss, and each one earns points.
      for (const g of m.games || []) {
        h.p++; a.p++;
        h.gf += g.homeGoals || 0; h.ga += g.awayGoals || 0; a.gf += g.awayGoals || 0; a.ga += g.homeGoals || 0;
        if (g.homeGoals > g.awayGoals) { h.w++; a.l++; h.pts += season.scoring.win; a.pts += season.scoring.loss; h.form.push('W'); a.form.push('L'); }
        else if (g.awayGoals > g.homeGoals) { a.w++; h.l++; a.pts += season.scoring.win; h.pts += season.scoring.loss; a.form.push('W'); h.form.push('L'); }
        else { h.d++; a.d++; h.pts += season.scoring.draw; a.pts += season.scoring.draw; h.form.push('D'); a.form.push('D'); }
      }
    }
    const all = [...map.values()].map((r) => ({ ...r, gd: r.gf - r.ga, form: r.form.slice(-5) }));
    const groups = season.divided ? groupBy(all, (r) => r.divisionId || '_') : { _: all };
    const out: StandingRow[] = [];
    for (const g of Object.values(groups)) {
      sortStandings(g, season.tiebreakers, ms, season.scoring, names).forEach((r, i) => {
        r.pos = i + 1;
        r.zone = zoneFor(r.pos, season.zones)?.kind ?? null;
        out.push(r);
      });
    }
    return out;
  };
  const rounds = [...new Set(league.map((m) => m.round))];
  const byRound: Record<string, string[]> = {};
  for (const r of rounds) byRound[String(r)] = build(r).map((x) => x.teamId);
  return { rows: build(Infinity), byRound };
}

export function groupBy<T>(arr: T[], key: (t: T) => string): Record<string, T[]> {
  const o: Record<string, T[]> = {};
  for (const x of arr) (o[key(x)] ||= []).push(x);
  return o;
}

// ---------- Player & team stats ----------
export interface PlayerStatRow {
  playerId: string; teamId: string | null;
  gp: number; sp: number; w: number; d: number; l: number;
  goals: number; assists: number; interceptions: number; passes: number; saves: number; mvps: number;
  rating: number | null;
  perGame: Record<StatKey, number>;
  adv: { contribPg: number; winRate: number; mvpRate: number };
  bestGame: { goals: number; matchId: string | null };
}
/** Per-game player stats, in display order. Keys are internal; show STAT_LABELS to people. */
export const STAT_KEYS = ['goals', 'assists', 'interceptions', 'passes', 'saves'] as const;
export type StatKey = typeof STAT_KEYS[number];
export const STAT_LABELS: Record<StatKey, string> = { goals: 'Goals', assists: 'Assists', interceptions: 'Interceptions', passes: 'Passes', saves: 'Saves' };
const blankStats = (): Record<StatKey, number> => ({ goals: 0, assists: 0, interceptions: 0, passes: 0, saves: 0 });

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computePlayerStats(matches: Match[]): PlayerStatRow[] {
  const map = new Map<string, PlayerStatRow & { _ratingSum: number; _ratingN: number; _series: Set<string> }>();
  const ms = matches.filter(played);
  for (const m of ms) {
    for (const g of m.games || []) {
      for (const [pid, s] of Object.entries(g.playerStats || {})) {
        let row = map.get(pid);
        if (!row) {
          row = {
            playerId: pid, teamId: s.teamId, gp: 0, sp: 0, w: 0, d: 0, l: 0,
            ...blankStats(), mvps: 0, rating: null,
            perGame: blankStats(),
            adv: { contribPg: 0, winRate: 0, mvpRate: 0 },
            bestGame: { goals: 0, matchId: null },
            _ratingSum: 0, _ratingN: 0, _series: new Set(),
          };
          map.set(pid, row);
        }
        row.teamId = s.teamId || row.teamId;
        row.gp++;
        row._series.add(m.id);
        for (const k of STAT_KEYS) row[k] += Number(s[k] || 0);
        if (s.mvp) row.mvps++;
        if (typeof s.rating === 'number' && s.rating > 0) { row._ratingSum += s.rating; row._ratingN++; }
        if ((s.goals || 0) > row.bestGame.goals) row.bestGame = { goals: s.goals || 0, matchId: m.id };
        // Per-game W/D/L attributed to the team the player appeared for in that game (handles transfers).
        const homeSide = s.teamId === m.homeTeamId;
        const mine = homeSide ? g.homeGoals : g.awayGoals, theirs = homeSide ? g.awayGoals : g.homeGoals;
        if (mine > theirs) row.w++; else if (mine < theirs) row.l++; else row.d++;
      }
    }
    if (m.mvpPlayerId && map.has(m.mvpPlayerId)) map.get(m.mvpPlayerId)!.mvps++;
  }
  return [...map.values()].map(({ _ratingSum, _ratingN, _series, ...row }) => {
    row.sp = _series.size;
    row.rating = _ratingN ? r2(_ratingSum / _ratingN) : null;
    for (const k of STAT_KEYS) row.perGame[k] = row.gp ? r2(row[k] / row.gp) : 0;
    row.adv = {
      contribPg: row.gp ? r2((row.goals + row.assists) / row.gp) : 0,
      winRate: row.gp ? r2(row.w / row.gp) : 0,
      mvpRate: row.sp ? r2(row.mvps / row.sp) : 0,
    };
    return row;
  });
}

export interface TeamStatRow {
  teamId: string; series: number; games: number; gw: number; gd: number; gl: number;
  gf: number; ga: number; cleanSheets: number; interceptions: number; passes: number; saves: number;
  goalsPg: number; concededPg: number; biggestWin: { margin: number; matchId: string | null };
}
export function computeTeamStats(matches: Match[]): TeamStatRow[] {
  const map = new Map<string, TeamStatRow>();
  const get = (id: string) => {
    let r = map.get(id);
    if (!r) {
      r = { teamId: id, series: 0, games: 0, gw: 0, gd: 0, gl: 0, gf: 0, ga: 0, cleanSheets: 0, interceptions: 0, passes: 0, saves: 0, goalsPg: 0, concededPg: 0, biggestWin: { margin: 0, matchId: null } };
      map.set(id, r);
    }
    return r;
  };
  for (const m of matches.filter(played)) {
    const h = get(m.homeTeamId), a = get(m.awayTeamId);
    h.series++; a.series++;
    for (const g of m.games || []) {
      for (const [t, mine, theirs] of [[h, g.homeGoals, g.awayGoals], [a, g.awayGoals, g.homeGoals]] as const) {
        t.games++; t.gf += mine; t.ga += theirs;
        if (mine > theirs) t.gw++; else if (mine < theirs) t.gl++; else t.gd++;
        if (theirs === 0) t.cleanSheets++;
        if (mine - theirs > t.biggestWin.margin) t.biggestWin = { margin: mine - theirs, matchId: m.id };
      }
      for (const s of Object.values(g.playerStats || {})) {
        const t = s.teamId === m.homeTeamId ? h : s.teamId === m.awayTeamId ? a : null;
        if (!t) continue;
        t.interceptions += s.interceptions || 0; t.passes += s.passes || 0; t.saves += s.saves || 0;
      }
    }
  }
  return [...map.values()].map((t) => ({ ...t, goalsPg: t.games ? r2(t.gf / t.games) : 0, concededPg: t.games ? r2(t.ga / t.games) : 0 }));
}

export interface LeaderEntry { playerId: string; teamId: string | null; value: number }
export const LEADER_CATEGORIES: { key: string; label: string; emoji: string }[] = [
  { key: 'goals', label: 'Goals', emoji: '⚽' },
  { key: 'assists', label: 'Assists', emoji: '🅰️' },
  { key: 'saves', label: 'Saves', emoji: '🧤' },
  { key: 'mvps', label: 'MVPs', emoji: '⭐' },
  { key: 'interceptions', label: 'Interceptions', emoji: '🛡️' },
  { key: 'passes', label: 'Passes', emoji: '🎯' },
  { key: 'contributions', label: 'Goal contributions', emoji: '🔥' },
];
export function computeLeaders(rows: PlayerStatRow[], topN = 10): Record<string, LeaderEntry[]> {
  const out: Record<string, LeaderEntry[]> = {};
  const val = (r: PlayerStatRow, k: string): number =>
    k === 'contributions' ? r.goals + r.assists : k === 'rating' ? (r.gp >= 3 ? r.rating ?? 0 : 0) : Number((r as unknown as Record<string, number>)[k] || 0);
  for (const c of LEADER_CATEGORIES) {
    out[c.key] = rows.map((r) => ({ playerId: r.playerId, teamId: r.teamId, value: val(r, c.key) }))
      .filter((e) => e.value > 0).sort((a, b) => b.value - a.value).slice(0, topN);
  }
  return out;
}

// ---------- Power rankings ----------
export interface PowerRow { teamId: string; rank: number; score: number; reasons: string[] }
export function computePowerRankings(rows: StandingRow[]): PowerRow[] {
  const scored = rows.filter((r) => r.p > 0).map((r) => {
    const ppg = r.pts / r.p;
    const formPts = r.form.reduce((s, f) => s + (f === 'W' ? 3 : f === 'D' ? 1 : 0), 0);
    const formScore = r.form.length ? formPts / (3 * r.form.length) : 0;
    const gdpg = r.gd / r.p;
    const score = Math.round(100 * (0.5 * (ppg / 3) + 0.3 * formScore + 0.2 * Math.min(1, Math.max(0, (gdpg + 5) / 10))));
    const wins = r.form.filter((f) => f === 'W').length;
    const reasons = [
      `${ppg.toFixed(2)} points per game (${r.w}W ${r.d}D ${r.l}L)`,
      r.form.length ? `Won ${wins} of last ${r.form.length}` : 'No recent form',
      `${r.gd >= 0 ? '+' : ''}${r.gd} goal difference (${gdpg >= 0 ? '+' : ''}${gdpg.toFixed(1)} per game)`,
      `Sits ${ordinal(r.pos)} in the table`,
    ];
    return { teamId: r.teamId, rank: 0, score, reasons };
  });
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, i) => (s.rank = i + 1));
  return scored;
}
export const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// ---------- Scheduling (circle method) ----------
export type Pair = [string, string];
/** Returns rounds of [home, away] pairs. Odd counts get a bye (team simply sits out). */
export function roundRobin(teamIds: string[], double: boolean): Pair[][] {
  const teams: (string | null)[] = [...teamIds];
  if (teams.length < 2) return [];
  if (teams.length % 2) teams.push(null);
  const n = teams.length, rounds: Pair[][] = [];
  const arr = [...teams];
  for (let r = 0; r < n - 1; r++) {
    const round: Pair[] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a && b) round.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(round);
    arr.splice(1, 0, arr.pop()!); // rotate all but the first
  }
  if (double) return [...rounds, ...rounds.map((rd) => rd.map(([h, a]) => [a, h] as Pair))];
  return rounds;
}
/** Greedy: pack missing pairs into new rounds so no team plays twice in a round. */
export function packIntoRounds(pairs: Pair[]): Pair[][] {
  const rounds: Pair[][] = [];
  const left = [...pairs];
  while (left.length) {
    const busy = new Set<string>(); const round: Pair[] = [];
    for (let i = 0; i < left.length;) {
      const [h, a] = left[i];
      if (!busy.has(h) && !busy.has(a)) { round.push(left[i]); busy.add(h); busy.add(a); left.splice(i, 1); }
      else i++;
    }
    rounds.push(round);
  }
  return rounds;
}

// ---------- Brackets ----------
export interface BracketSlot {
  slot: string; homeSeed: number | null; awaySeed: number | null;
  homeTeamId: string | null; awayTeamId: string | null; matchId: string | null; winnerTeamId: string | null;
  /** "SLOT.home" within the same bracket */
  feedsTo: string | null;
  /** "SLOT.side" in the same bracket, or "bracketId:SLOT.side" in a sibling bracket (second-chance path). */
  loserFeedsTo: string | null;
}
export interface BracketRound { key: string; label: string; slots: BracketSlot[] }
export interface Bracket { name: string; rounds: BracketRound[]; secondChanceSeeds: number[] }
export interface SlotResult { winnerTeamId: string; loserTeamId: string }
export interface ExternalFeed { bracketId: string; slot: string; side: 'home' | 'away'; teamId: string | null }

const slotObj = (slot: string, extra: Partial<BracketSlot> = {}): BracketSlot => ({
  slot, homeSeed: null, awaySeed: null, homeTeamId: null, awayTeamId: null, matchId: null, winnerTeamId: null, feedsTo: null, loserFeedsTo: null, ...extra,
});
function parseTarget(t: string): { bracketId: string | null; slot: string; side: 'home' | 'away' } {
  const [left, side] = t.split('.') as [string, 'home' | 'away'];
  if (left.includes(':')) { const [b, s] = left.split(':'); return { bracketId: b, slot: s, side }; }
  return { bracketId: null, slot: left, side };
}

/** Rebuild winners from scratch so deleting/editing a result rolls later rounds back. */
export function recomputeBracket(bracket: Bracket, resultFor: (slot: BracketSlot) => SlotResult | null): { bracket: Bracket; external: ExternalFeed[] } {
  const b: Bracket = JSON.parse(JSON.stringify(bracket));
  const all = b.rounds.flatMap((r) => r.slots);
  const bySlot = new Map(all.map((s) => [s.slot, s]));
  const fed = new Set<string>();
  const external: ExternalFeed[] = [];
  for (const s of all) for (const t of [s.feedsTo, s.loserFeedsTo]) {
    if (!t) continue;
    const p = parseTarget(t);
    if (p.bracketId) external.push({ bracketId: p.bracketId, slot: p.slot, side: p.side, teamId: null });
    else fed.add(`${p.slot}.${p.side}`);
  }
  for (const s of all) {
    if (fed.has(`${s.slot}.home`)) s.homeTeamId = null;
    if (fed.has(`${s.slot}.away`)) s.awayTeamId = null;
    s.winnerTeamId = null;
  }
  const place = (t: string, teamId: string) => {
    const p = parseTarget(t);
    if (p.bracketId) {
      const e = external.find((x) => x.bracketId === p.bracketId && x.slot === p.slot && x.side === p.side);
      if (e) e.teamId = teamId;
      return;
    }
    const target = bySlot.get(p.slot);
    if (target) target[p.side === 'home' ? 'homeTeamId' : 'awayTeamId'] = teamId;
  };
  for (const round of b.rounds) for (const s of round.slots) {
    if (!s.homeTeamId || !s.awayTeamId) {
      // Bye: one team and an empty side that no earlier slot feeds → that team goes through automatically.
      const lone = s.homeTeamId || s.awayTeamId;
      const empty = s.homeTeamId ? 'away' : 'home';
      if (lone && !fed.has(`${s.slot}.${empty}`)) { s.winnerTeamId = lone; if (s.feedsTo) place(s.feedsTo, lone); }
      continue;
    }
    const res = resultFor(s);
    if (!res) continue;
    if (![s.homeTeamId, s.awayTeamId].includes(res.winnerTeamId)) continue;
    s.winnerTeamId = res.winnerTeamId;
    if (s.feedsTo) place(s.feedsTo, res.winnerTeamId);
    if (s.loserFeedsTo) {
      const loserSeed = res.loserTeamId === s.homeTeamId ? s.homeSeed : s.awaySeed;
      const eligible = !s.loserFeedsTo.includes(':') || b.secondChanceSeeds.length === 0 ||
        (loserSeed != null && b.secondChanceSeeds.includes(loserSeed));
      if (eligible) {
        place(s.loserFeedsTo, res.loserTeamId);
      }
    }
  }
  return { bracket: b, external };
}

/** Knockout pairing: entrants in seed order; i plays (n-1-i); next round pairs (0,last),(1,last-1)… */
function knockoutRounds(entrants: { seed: number | null; teamId: string | null; from?: string }[], startKey: string, labels: Record<number, { key: string; label: string }>): BracketRound[] {
  const rounds: BracketRound[] = [];
  let cur = entrants;
  let idx = 0;
  while (cur.length >= 2) {
    const meta = labels[cur.length] || { key: `${startKey}${idx}`, label: `Round of ${cur.length}` };
    const slots: BracketSlot[] = [];
    const next: { seed: number | null; teamId: string | null; from?: string }[] = [];
    for (let i = 0; i < cur.length / 2; i++) {
      const h = cur[i], a = cur[cur.length - 1 - i];
      const key = cur.length === 2 ? meta.key.toUpperCase() : `${meta.key.toUpperCase()}${i + 1}`;
      slots.push(slotObj(key, { homeSeed: h.seed, awaySeed: a.seed, homeTeamId: h.from ? null : h.teamId, awayTeamId: a.from ? null : a.teamId }));
      next.push({ seed: null, teamId: null, from: key });
    }
    rounds.push({ key: meta.key, label: meta.label, slots });
    // wire feeds: next[i] is the winner of slots[i]; in the following round slot j gets next[j] home and next[len-1-j] away
    const half = next.length / 2;
    if (next.length >= 2) {
      const nextMeta = labels[next.length] || { key: `${startKey}${idx + 1}`, label: '' };
      for (let j = 0; j < half; j++) {
        const nk = next.length === 2 ? nextMeta.key.toUpperCase() : `${nextMeta.key.toUpperCase()}${j + 1}`;
        slots[j].feedsTo = `${nk}.home`;
        slots[next.length - 1 - j].feedsTo = `${nk}.away`;
      }
    }
    cur = next; idx++;
  }
  return rounds;
}
const LABELS: Record<number, { key: string; label: string }> = {
  16: { key: 'r16', label: 'Round of 16' }, 8: { key: 'qf', label: 'Quarterfinals' }, 4: { key: 'sf', label: 'Semifinals' }, 2: { key: 'final', label: 'Final' },
};

/** Finals bracket from table seeds: Wildcard → QF → SF → Final. */
export function buildFinalsBracket(fmt: FinalsFormat, seedTeam: (seed: number) => string | null): Bracket {
  const wc = [...fmt.wildcardSeeds].sort((a, b) => a - b);
  const wcSlots: BracketSlot[] = [];
  for (let i = 0; i < wc.length / 2; i++) {
    const hs = wc[i], as = wc[wc.length - 1 - i];
    wcSlots.push(slotObj(`WC${i + 1}`, { homeSeed: hs, awaySeed: as, homeTeamId: seedTeam(hs), awayTeamId: seedTeam(as) }));
  }
  const direct = [...fmt.byeSeeds, ...fmt.directSeeds].sort((a, b) => a - b).map((s) => ({ seed: s as number | null, teamId: seedTeam(s) }));
  const wcWinners = wcSlots.map((s) => ({ seed: null as number | null, teamId: null as string | null, from: s.slot }));
  const entrants: { seed: number | null; teamId: string | null; from?: string }[] = [...direct, ...wcWinners.reverse()];
  const ko = knockoutRounds(entrants, 'k', LABELS);
  // Wire wildcard winners into the first knockout round slots that expect them
  if (ko.length) {
    ko[0].slots.forEach((s, i) => {
      const h = entrants[i], a = entrants[entrants.length - 1 - i];
      if (h.from) wcSlots.find((w) => w.slot === h.from)!.feedsTo = `${s.slot}.home`;
      if (a.from) wcSlots.find((w) => w.slot === a.from)!.feedsTo = `${s.slot}.away`;
    });
  }
  return {
    name: 'Finals',
    rounds: [...(wcSlots.length ? [{ key: 'wildcard', label: 'Wildcard', slots: wcSlots }] : []), ...ko],
    secondChanceSeeds: [],
  };
}

/** Fisher–Yates shuffle (returns a new array). */
export function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Simple single-elimination bracket for cups. Teams are seeded in the given order; byes go to the top seeds. */
export function buildKnockout(name: string, teamIds: string[]): Bracket {
  let size = 2; while (size < teamIds.length) size *= 2;
  const entrants = Array.from({ length: size }, (_, i) => ({ seed: i + 1, teamId: teamIds[i] ?? null }));
  return { name, rounds: knockoutRounds(entrants, 'r', LABELS), secondChanceSeeds: [] };
}

export const stageForRoundKey = (key: string): Stage =>
  key === 'wildcard' ? 'wildcard' : key === 'qf' ? 'qf' : key === 'sf' ? 'sf' : key === 'final' ? 'final' : 'cup';

// ---------- Discord attachment links ----------
const DISCORD_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];
/**
 * Discord attachment URLs carry signed, expiring query params (ex/is/hm). Store the stable form (cdn host, no query);
 * the Worker's /discord-image endpoint re-signs it on view. Returns null for non-attachment URLs.
 */
export function canonicalDiscordAttachment(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!DISCORD_HOSTS.includes(u.hostname) || !/^\/(ephemeral-)?attachments\/\d+\/\d+\/[^/]+$/.test(u.pathname)) return null;
    return `https://cdn.discordapp.com${u.pathname}`;
  } catch { return null; }
}
