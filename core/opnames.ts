/** Names of the ops that run in the admin's browser (see BROWSER_OPS in ./index). Import-free so the
 *  public bundle can route calls without loading the op code. */
export const BROWSER_OP_NAMES = new Set([
  'afterMatchWrite', 'afterCupMatchWrite', 'recomputeAll', 'generateSchedule', 'moveToNextSeason', 'buildWrapped',
  'transferPlayer', 'backupNow', 'restoreMissing', 'mergeEntities', 'addAuditNote',
]);
