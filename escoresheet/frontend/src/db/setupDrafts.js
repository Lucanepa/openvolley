/**
 * Match setup drafts (db.match_setup): the unsaved edits of one match's info
 * page or roster editor, kept until Save or Back. Keyed by matchId (a field,
 * not an index: the table holds a few rows at most, read whole), restored by
 * Match setup after a reload or an app killed in the background, and removed
 * with the match (closed or deleted). The info page never writes into the
 * stored match before its Save: the official-game and club checks run there.
 *
 * Older apps kept one draft without a matchId, with both rosters and the
 * pre-match signatures, that nothing ever read: dropStaleSetupDrafts removes
 * it.
 */
import { db } from './db'

const rowsOf = async (matchId) => (await db.match_setup.toArray()).filter((r) => r.matchId === matchId)

/** The newest draft of a match ({ matchId, view, data, updatedAt }), or null. */
export async function readSetupDraft(matchId) {
  if (matchId == null) return null
  const rows = await rowsOf(matchId)
  rows.sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')))
  return rows[rows.length - 1] || null
}

/** Keep `data` as the match's draft of `view` ('info' | 'home' | 'away'): one row per match. */
export async function writeSetupDraft(matchId, view, data) {
  if (matchId == null) return
  const [first, ...rest] = await rowsOf(matchId)
  const row = { matchId, view, data, updatedAt: new Date().toISOString() }
  if (first) await db.match_setup.update(first.id, row)
  else await db.match_setup.add(row)
  for (const r of rest) await db.match_setup.delete(r.id)
}

/** Remove the drafts of a match (Save, Back, the match closed or deleted). */
export async function clearSetupDraft(matchId) {
  for (const r of await rowsOf(matchId)) await db.match_setup.delete(r.id)
}

/** Remove the drafts without a match on this device, and the old draft without a matchId. */
export async function dropStaleSetupDrafts() {
  for (const r of await db.match_setup.toArray()) {
    if (r.matchId == null || !(await db.matches.get(r.matchId))) await db.match_setup.delete(r.id)
  }
}
