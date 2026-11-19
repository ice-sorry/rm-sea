import type { Timestamp } from 'firebase/firestore';
export * from '../../core/shared/league';
import type { Bracket, Position, Match, StandingRow, PlayerStatRow, TeamStatRow, LeaderEntry, PowerRow } from '../../core/shared/league';

export interface Team {
  id: string; name: string; shortName: string; nameNormalized: string; color: string; crestUrl: string;
  discordRoleId: string | null; captainIds: string[]; active: boolean; mergedInto: string | null;
}
export interface Player {
  id: string; name: string; nameLower: string; discordId: string | null; ownerUid: string | null;
  linkSource: 'self' | 'admin' | null; position: Position; currentTeamId: string | null;
  avatarUrl: string; bio: string; country: string; mergedInto: string | null;
  createdAt?: Timestamp; updatedAt?: Timestamp;
}
export interface UserDoc {
  id: string; discordId: string; username: string; displayName: string; avatarUrl: string;
  role: 'user' | 'admin' | 'owner'; guildRoleIds: string[]; playerId: string | null;
}
export interface RequestDoc {
  id: string; type: 'join_team' | 'transfer' | 'new_team' | 'join_season' | 'leave_season' | 'leave_team' | 'kick_player'; playerId: string; teamId?: string; fromTeamId: string | null; toTeamId: string | null;
  seasonId: string; status: 'pending' | 'accepted' | 'declined' | 'cancelled'; message: string; teamName?: string; shortName?: string; adminNotifiedAt?: unknown; color?: string;
  requestedBy: string; decidedBy?: string; createdAt?: Timestamp; decidedAt?: Timestamp;
}
export interface Cup {
  id: string; name: string; seasonId: string | null;
  /** Entrants in seeding order. Older cups lack it; read them from the bracket with cupTeamIds(). */
  teamIds?: string[];
  /** Legacy category (league cup, all-star…) from before cups were simplified; ignored. */
  kind?: string;
  status: string; bracket: Bracket | null; championTeamId: string | null; archived: boolean;
}
export interface Award {
  id: string; type: string; label: string; recipientType: 'player' | 'team'; recipientId: string;
  suggestedId?: string | null; value?: number | string | null; grantedBy?: string; grantedAt?: Timestamp;
}
export interface GeneralSettings {
  currentSeasonId?: string; homeMode?: 'live' | 'pinned'; pinnedSeasonId?: string; leagueName?: string;
  socials?: Record<string, string>; siteUrl?: string;
  /** Closed transfer window: players can't request to join, transfer or form a club. */
  transfersBlocked?: boolean;
}
export type MatchDoc = Match & { verificationIssues?: string[]; verifiedOverride?: boolean };
export interface StandingsDoc { rows: StandingRow[]; byRound: Record<string, string[]> }
export interface PlayerStatsDoc { rows: PlayerStatRow[]; leagueRows?: PlayerStatRow[] }
export interface TeamStatsDoc { rows: TeamStatRow[] }
export interface LeadersDoc { categories: Record<string, LeaderEntry[]>; totals: { series: number; games: number; goals: number } }
export interface PowerDoc { id: string; rows: PowerRow[]; roundNo?: number; votes?: number }
export interface RecordsDoc {
  records: { key: string; label: string; value: number; holderType: 'player' | 'team'; holderId: string; seasonId: string | null; matchId: string | null }[];
  milestones: { key: string; label: string; holderId: string; value: number }[];
  career: Record<string, { goals: number; assists: number; gp: number; mvps: number; saves: number; interceptions?: number; passes?: number; seasons?: number }>;
}

/** A cup's entrants: its teamIds, or (older cups) every team placed in the bracket's first round. */
export function cupTeamIds(cup: Pick<Cup, 'teamIds' | 'bracket'>): string[] {
  if (cup.teamIds?.length) return cup.teamIds;
  const first = cup.bracket?.rounds?.[0]?.slots || [];
  return first.flatMap((s) => [s.homeTeamId, s.awayTeamId]).filter((t): t is string => !!t);
}
