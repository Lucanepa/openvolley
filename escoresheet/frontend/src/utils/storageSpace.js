/**
 * The device's storage for the match data (IndexedDB). When the origin's
 * quota is used up (the disk is full, e.g. a Downloads folder full of backups)
 * every write fails: in the stress test (2026-10-25) every scoring tap said
 * "That was not saved. Check the scoresheet and try again", which never helps,
 * and only a console line named the quota. The scoreboard names it
 * (isStorageFullError) and warns at a set start while there is still room
 * (freeStorageBytes below LOW_STORAGE_BYTES).
 */

// Below this, the scoreboard warns: room for a few more matches (a 5-set
// match writes a few MB: its events, each with a state snapshot, the sync
// queue and the activity log)
export const LOW_STORAGE_BYTES = 50 * 1024 * 1024

/**
 * A write refused because the storage is full: the browser's
 * QuotaExceededError, also as the cause of the AbortError Dexie throws for the
 * transaction it aborted (err.inner), however deep.
 */
export function isStorageFullError(err) {
  const seen = new Set()
  for (let e = err; e && typeof e === 'object' && !seen.has(e); e = e.inner || e.cause) {
    seen.add(e)
    if (e.name === 'QuotaExceededError') return true
  }
  return false
}

/**
 * What is left of this app's storage quota in bytes (navigator.storage
 * .estimate()), or null when the browser cannot say.
 */
export async function freeStorageBytes(nav = typeof navigator !== 'undefined' ? navigator : undefined) {
  try {
    if (!nav?.storage?.estimate) return null
    const { usage, quota } = await nav.storage.estimate()
    if (!Number.isFinite(quota) || !Number.isFinite(usage)) return null
    return Math.max(0, quota - usage)
  } catch {
    return null
  }
}
