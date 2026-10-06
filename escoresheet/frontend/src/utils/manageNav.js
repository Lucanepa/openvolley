/**
 * App-wide navigation events for the manage console and the restore dialog.
 * App.jsx listens; any component (user menu, sync notices, MatchSetup) can
 * ask without a prop chain.
 */

export const OPEN_MANAGE_EVENT = 'ov-open-manage'
export const OPEN_RESTORE_EVENT = 'ov-open-restore'

/** Open the manage console on a tab ('accounts', 'invites', 'games', 'matches', 'audit', 'teams'). */
export function openManage(tab = 'accounts') {
  try { window.dispatchEvent(new CustomEvent(OPEN_MANAGE_EVENT, { detail: { tab } })) } catch { /* no window */ }
}

/** Open "restore a match" with the game number prefilled (join with game PIN). */
export function openRestore({ gameN } = {}) {
  try { window.dispatchEvent(new CustomEvent(OPEN_RESTORE_EVENT, { detail: { gameN: gameN ?? null } })) } catch { /* no window */ }
}
