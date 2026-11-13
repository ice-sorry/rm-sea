/**
 * Operation registry. On Firebase's free (Spark) plan there are no Cloud Functions, so:
 *  - WORKER_OPS run in the Cloudflare Worker: anything that needs a secret (Discord client secret, bot token,
 *    webhooks, service account) or must be trusted across users (claims, requests, kickoff).
 *  - BROWSER_OPS run in the signed-in admin's browser with their own credentials; Firestore rules are the guard.
 *    These are the heavy jobs that would blow the Worker free plan's 50-subrequest / 10 ms CPU limits.
 */
import type { Handler } from './runtime';
import { discordAuth, refreshClaims } from './auth';
import { claimPlayer, setupPlayer, unclaimPlayer, decideRequest, transferPlayer, refreshAvatars } from './players';
import { afterMatchWrite, matchSideEffects, afterCupMatchWrite, recomputeAll } from './derive';
import { generateSchedule } from './schedule';
import { publishMatchweek, completeMatchweek, agreeKickoff, registerCommands } from './matchday';
import { publishRules } from './content';
import { syncRoles, syncTeamRoles } from './roles';
import { trackVisit, backupNow, restoreMissing, mergeEntities, savePrivate, addAuditNote } from './ops';
import { moveToNextSeason, buildWrapped } from './season';

export const WORKER_OPS: Record<string, Handler> = {
  discordAuth, refreshClaims,
  claimPlayer, setupPlayer, unclaimPlayer, decideRequest, refreshAvatars,
  matchSideEffects,
  publishMatchweek, completeMatchweek, agreeKickoff, registerCommands,
  publishRules, syncRoles, syncTeamRoles, trackVisit, savePrivate,
};

export const BROWSER_OPS: Record<string, Handler> = {
  afterMatchWrite, afterCupMatchWrite, recomputeAll, generateSchedule, moveToNextSeason, buildWrapped,
  transferPlayer, backupNow, restoreMissing, mergeEntities, addAuditNote,
};

export { handleInteraction } from './matchday';
