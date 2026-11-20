import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDocFromServer, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { useCol, useDoc } from './hooks';
import type {
  Team, Player, UserDoc, GeneralSettings, Season, MatchDoc, StandingsDoc, PlayerStatsDoc, TeamStatsDoc, LeadersDoc, Entry,
} from './types';
import { DEFAULT_SEASON } from './types';

export interface Claims { role: 'user' | 'admin' | 'owner' }
interface LeagueState {
  ready: boolean;
  general: GeneralSettings;
  seasons: Season[];
  seasonId: string | null;
  setSeasonId: (id: string) => void;
  season: Season | null;
  teams: Record<string, Team>;
  teamList: Team[];
  players: Record<string, Player>;
  playerList: Player[];
  matches: MatchDoc[];
  entries: Entry[];
  rosters: Record<string, string[]>;
  standings: StandingsDoc | null;
  /** Standings rows for the selected season: null while loading, [] when the league has no teams yet. */
  standingsRows: StandingsDoc['rows'] | null;
  playerStats: PlayerStatsDoc | null;
  teamStats: TeamStatsDoc | null;
  leaders: LeadersDoc | null;
  authUser: User | null;
  authReady: boolean;
  claims: Claims;
  me: UserDoc | null;
  /** True once we know whether the signed-in user's record exists (always true when signed out). */
  meReady: boolean;
  /** Set when a missing user record could not be re-created. */
  meError: string;
  myPlayer: Player | null;
  isAdmin: boolean;
  isOwner: boolean;
}

const Ctx = createContext<LeagueState | null>(null);
export const useLeague = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLeague outside provider');
  return v;
};

/**
 * Every player, team or season, read from its public summary (derived/players etc., 1 read; see core/public.ts).
 * Until an admin's first "Recompute season" builds the summary, it reads the whole collection instead.
 */
function usePublicCol<T>(name: 'players' | 'teams' | 'seasons'): { data: (T & { id: string })[]; loading: boolean } {
  const summary = useDoc<{ items?: Record<string, T> }>(`derived/${name}`);
  const missing = !summary.loading && !summary.data;
  const fallback = useCol<T>(missing ? name : null);
  const data = useMemo(() => (summary.data
    ? Object.entries(summary.data.items || {}).map(([id, v]) => ({ ...v, id }))
    : fallback.data), [summary.data, fallback.data]);
  return { data, loading: summary.loading || (missing && fallback.loading) };
}

export function LeagueProvider({ children }: { children: ReactNode }) {
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [claims, setClaims] = useState<Claims>({ role: 'user' });

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    setAuthUser(u);
    if (u) {
      const t = await u.getIdTokenResult();
      setClaims({ role: (t.claims.role as Claims['role']) || 'user' });
    } else setClaims({ role: 'user' });
    setAuthReady(true);
  }), []);

  const { data: general, loading: gLoading } = useDoc<GeneralSettings>('settings/general');
  const { data: seasonDocs } = usePublicCol<Season>('seasons');
  const [picked, setPicked] = useState<string | null>(() => {
    try { return sessionStorage.getItem('srl_season'); } catch { return null; }
  });
  const seasonId = picked || general?.currentSeasonId || seasonDocs[0]?.id || null;
  const setSeasonId = (id: string) => { setPicked(id); try { sessionStorage.setItem('srl_season', id); } catch { /* ignore */ } };

  const { data: teamDocs, loading: tLoading } = usePublicCol<Team>('teams');
  const { data: playerDocs } = usePublicCol<Player>('players');
  const { data: matches } = useCol<MatchDoc>(seasonId ? `seasons/${seasonId}/matches` : null);
  const { data: entryDocs } = useCol<Entry & { id: string }>(seasonId ? `seasons/${seasonId}/entries` : null);
  const { data: rosterDocs } = useCol<{ playerIds: string[] }>(seasonId ? `seasons/${seasonId}/rosters` : null);
  const { data: standings, loading: sLoading } = useDoc<StandingsDoc>(seasonId ? `seasons/${seasonId}/derived/standings` : null);
  const { data: playerStats } = useDoc<PlayerStatsDoc>(seasonId ? `seasons/${seasonId}/derived/playerStats` : null);
  const { data: teamStats } = useDoc<TeamStatsDoc>(seasonId ? `seasons/${seasonId}/derived/teamStats` : null);
  const { data: leaders } = useDoc<LeadersDoc>(seasonId ? `seasons/${seasonId}/derived/leaders` : null);
  const { data: me, loading: meLoading } = useDoc<UserDoc>(authUser ? `users/${authUser.uid}` : null);
  const meReady = authReady && (!authUser || !meLoading);
  const [meError, setMeError] = useState('');

  // The Worker creates users/{uid} at Discord sign-in. If it's missing (e.g. the emulator database was reset while
  // the browser stayed signed in), re-create a plain record so the app doesn't hang on "Setting up your profile".
  useEffect(() => {
    if (!authUser || !meReady || me || !authUser.uid.startsWith('discord:')) return;
    let cancelled = false;
    (async () => {
      const ref = doc(db, `users/${authUser.uid}`);
      if ((await getDocFromServer(ref)).exists() || cancelled) return;
      await setDoc(ref, {
        discordId: authUser.uid.slice(8), username: authUser.displayName || '', displayName: authUser.displayName || 'Player',
        avatarUrl: authUser.photoURL || '', role: 'user', guildRoleIds: [], playerId: null,
        createdAt: serverTimestamp(), lastLoginAt: serverTimestamp(),
      });
    })().then(() => setMeError(''), (e) => !cancelled && setMeError(e instanceof Error ? e.message : String(e)));
    return () => { cancelled = true; };
  }, [authUser, meReady, me]);

  // Its own memo so L.seasons only changes when a season changes. Pages fetch per-season data (awards, stats)
  // keyed on it, and rebuilding it with every player or match update made them re-read everything.
  const seasons = useMemo(() => [...seasonDocs].map((s) => ({ ...DEFAULT_SEASON, ...s }) as Season)
    // The retired Finals Shield's "second chance" zone may still be stored on older seasons; hide it.
    .map((s) => ({ ...s, zones: (s.zones || []).filter((z) => z.kind !== 'secondChance') }))
    .sort((a, b) => (b.number || 0) - (a.number || 0)), [seasonDocs]);

  const value = useMemo<LeagueState>(() => {
    const teamList = teamDocs.filter((t) => !t.mergedInto).sort((a, b) => a.name.localeCompare(b.name));
    const playerList = playerDocs.filter((p) => !p.mergedInto).sort((a, b) => a.name.localeCompare(b.name));
    const players = Object.fromEntries(playerDocs.map((p) => [p.id, p]));
    return {
      ready: !gLoading && !tLoading,
      general: general || {},
      seasons, seasonId, setSeasonId,
      season: seasons.find((s) => s.id === seasonId) || null,
      teams: Object.fromEntries(teamDocs.map((t) => [t.id, t])), teamList,
      players, playerList,
      matches,
      entries: entryDocs.map((e) => ({ ...e, teamId: e.id })),
      rosters: Object.fromEntries(rosterDocs.map((r) => [r.id, r.playerIds || []])),
      standings, playerStats, teamStats, leaders,
      standingsRows: standings?.rows ?? (seasonId && sLoading ? null : []),
      authUser, authReady, claims, me, meReady, meError,
      myPlayer: me?.playerId ? players[me.playerId] || null : null,
      isAdmin: claims.role === 'admin' || claims.role === 'owner',
      isOwner: claims.role === 'owner',
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [general, gLoading, tLoading, seasons, seasonId, teamDocs, playerDocs, matches, entryDocs, rosterDocs, standings, sLoading, playerStats, teamStats, leaders, authUser, authReady, claims, me, meReady, meError]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Re-read custom claims after an admin change (spec: refreshClaims callable). */
export async function reloadClaims() {
  await auth.currentUser?.getIdToken(true);
  location.reload();
}

/** Roster limit set in Admin → Settings → General. 0 means no limit. */
export function rosterLimit(general: GeneralSettings): number {
  const n = Math.floor(Number(general.maxRosterSize) || 0);
  return n > 0 ? n : 0;
}

/** The team's squad: its season roster when the club is in the selected season, otherwise the players currently on it. */
export function squadIds(L: Pick<LeagueState, 'rosters' | 'playerList'>, teamId: string): string[] {
  return L.rosters[teamId] || L.playerList.filter((p) => p.currentTeamId === teamId).map((p) => p.id);
}

/** True when the team has reached the roster limit and can't accept new players. */
export function rosterFull(L: Pick<LeagueState, 'rosters' | 'playerList' | 'general'>, teamId: string): boolean {
  const cap = rosterLimit(L.general);
  return !!cap && squadIds(L, teamId).length >= cap;
}
