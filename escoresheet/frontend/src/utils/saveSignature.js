import { signaturesSyncJob } from '../domain/signatureEdits'

/**
 * Save one signature to the match row the moment its pad is confirmed, then
 * queue the match's `signatures` for the cloud (owner 2026-10-07: "save the
 * signatures as soon as they're made"). A reload or a crash before the screen
 * is confirmed no longer loses it, and the live scoresheet (a Dexie live query
 * on the match) shows it at once. Test matches are saved locally, never synced
 * (signaturesSyncJob). Returns true when it was written.
 *
 * @param {import('dexie').Dexie & { matches: any, sync_queue: any }} db
 * @param {number|string|null|undefined} matchId
 * @param {string|null} field  a match-row signature field (homeCaptainSignature, ...)
 * @param {string|null} image  the PNG data URL, null to clear
 * @param {object} [extra]  more fields written in the same update, e.g. the
 *   phone-signing source record (`signatureSources.<field>`, from main's
 *   domain/phoneSignature signatureUpdate) so it never lags the image
 */
export async function saveMatchSignature(db, matchId, field, image, extra = null) {
  if (matchId === null || matchId === undefined || !field) return false
  try {
    await db.matches.update(matchId, { ...(extra || {}), [field]: image ?? null })
    const job = signaturesSyncJob(await db.matches.get(matchId))
    if (job) {
      await db.sync_queue.add(job)
      try { window.dispatchEvent(new Event('sync-queue-write')) } catch { /* no window */ }
    }
    return true
  } catch (err) {
    console.error('[signature] Could not save the signature:', err?.message)
    return false
  }
}
