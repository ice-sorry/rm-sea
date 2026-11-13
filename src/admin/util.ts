import { serverTimestamp } from 'firebase/firestore';
import { auth, call } from '../lib/firebase';
import type { Match } from '../lib/types';

/**
 * Free plan: there are no Firestore triggers, so after writing a match the admin's browser recomputes
 * standings/brackets/records and the Worker posts Discord updates. Pass resultChanged=false for kickoff-only edits.
 */
export async function afterMatchChange(path: string, resultChanged = true) {
  const [root, parentId, , matchId] = path.split('/');
  if (root === 'cups') await call('afterCupMatchWrite')({ cupId: parentId, matchId });
  else await call('afterMatchWrite')({ seasonId: parentId, matchId, resultChanged });
}

/** Sync Discord team roles for rosters that just changed (best-effort; replaces the onRosterWrite trigger). */
export const syncTeamRoles = (...teamIds: (string | null | undefined)[]) =>
  call('syncTeamRoles')({ teamIds: teamIds.filter(Boolean) }).catch(() => undefined);

export const actor = () => auth.currentUser?.uid || 'unknown';
export const stamp = () => ({ updatedBy: actor(), updatedAt: serverTimestamp() });

export function newMatchDoc(p: Partial<Match> & Pick<Match, 'homeTeamId' | 'awayTeamId' | 'round' | 'stage'>) {
  return {
    divisionId: null, matchweek: 0, status: 'scheduled', kickoffAt: null, matchDate: null, games: [],
    seriesHome: 0, seriesAway: 0, goalsHome: 0, goalsAway: 0, winnerTeamId: null, mvpPlayerId: null,
    screenshotUrls: [], verification: 'ok', discordThreadId: null, bracketSlot: null,
    createdBy: actor(), createdAt: serverTimestamp(), ...stamp(), ...p,
  };
}

export const normalizeTeamName = (name: string) =>
  name.toLowerCase().replace(/\b(afc|fc|esports|e-sports|gaming|team|club)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
