import { signaturesSyncJob } from '../domain/signatureEdits'
import { appendRemark } from '../domain/remarks'

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
 * @param {{ remark?: string }} [opts]  a line appended to the remarks in the
 *   same update (a Re-sign: domain/rosterSignatures signatureReplacedRemark);
 *   the remarks hook (db/remarksSync) queues it for the cloud
 */
export async function saveMatchSignature(db, matchId, field, image, extra = null, { remark = '' } = {}) {
  if (matchId === null || matchId === undefined || !field) return false
  return writeSignatures(db, matchId, { ...(extra || {}), [field]: image ?? null }, remark)
}

/**
 * Clear pre-match signatures that no longer fit the roster (a change after
 * signing, domain/rosterSignatures): the images and their phone-signing
 * records go in one update with the remark, then the full `signatures` object
 * is queued. Returns true when it was written.
 *
 * @param {import('dexie').Dexie & { matches: any, sync_queue: any }} db
 * @param {number|string|null|undefined} matchId
 * @param {string[]} fields  match-row signature fields
 * @param {string} [remark]
 */
export async function clearMatchSignatures(db, matchId, fields, remark = '') {
  if (matchId === null || matchId === undefined || !fields?.length) return false
  const update = {}
  for (const f of fields) {
    update[f] = null
    update[`signatureSources.${f}`] = null
  }
  return writeSignatures(db, matchId, update, remark)
}

async function writeSignatures(db, matchId, update, remark) {
  try {
    if (remark) {
      // read and write the remarks in one transaction, so a remark written
      // elsewhere in between is not lost
      await db.transaction('rw', db.matches, async () => {
        const row = await db.matches.get(matchId)
        await db.matches.update(matchId, { ...update, remarks: appendRemark(row?.remarks || '', remark) })
      })
    } else {
      await db.matches.update(matchId, update)
    }
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
