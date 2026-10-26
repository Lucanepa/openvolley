/**
 * A copy of the signed-in session (lib/apiClient, localStorage
 * 'api_auth_token') in IndexedDB.
 *
 * Chromium, and the Android WebView with it, writes localStorage to disk
 * lazily and rate-limited: about a minute after the first writes of a browser
 * start. A crash, a killed app or a dead battery within that minute lost the
 * session (stress test 2026-10-25: lost at 3, 15, 30 and 45 s after signing
 * in, kept at 62 s): the match was still there (IndexedDB), but the scorer was
 * signed out and every rally waited in the sync queue, while the referee
 * dashboard and the livescore stayed stale. An IndexedDB commit reaches the
 * disk with the transaction; 'strict' durability also flushes it there before
 * it completes, for a power loss.
 *
 * Its own small database, not a table of the app's 'escoresheet' database:
 * apiClient is loaded by every page, also the ones that never open that one.
 * Every function here fails quietly (no IndexedDB, private mode, storage
 * full): the localStorage copy stays the one the app reads.
 */
import Dexie from 'dexie'

export const SESSION_MIRROR_DB_NAME = 'openvolley-session'
const KEY = 'api'

let mirrorDb = null
function openMirror() {
  if (!mirrorDb) {
    mirrorDb = new Dexie(SESSION_MIRROR_DB_NAME, { chromeTransactionDurability: 'strict' })
    mirrorDb.version(1).stores({ session: 'key' })
  }
  return mirrorDb
}

/** The session copy, or null (none, or no IndexedDB). */
export async function readSessionMirror() {
  try {
    const row = await openMirror().session.get(KEY)
    return row?.session ?? null
  } catch {
    return null
  }
}

/** Keep `session` as the copy; null removes it. */
export async function writeSessionMirror(session) {
  try {
    if (session) await openMirror().session.put({ key: KEY, session })
    else await openMirror().session.delete(KEY)
  } catch { /* no IndexedDB: localStorage only, as before */ }
}
