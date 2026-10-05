import { newScoresheetKey, SCORESHEET_KEY_RE } from '../../scoresheet_pdf/utils/scoresheetStorage'

/**
 * The random part of a match's scoresheet file names (see
 * scoresheet_pdf/utils/scoresheetStorage.ts): made once per match on this
 * device and kept in localStorage, never on the match record, because match
 * records are synced to the cloud and copied into cloud backups that other
 * accounts can read, and the key must stay unknown until the scorer has
 * created the files. A device without localStorage keeps it for the session;
 * another device (or a restore) simply gets its own key and files.
 */
const PREFIX = 'ov:scoresheetKey:'
const memory = new Map()

function matchIdentity(match) {
  const id = match?.seed_key || match?.seedKey || match?.externalId || match?.external_id
  if (id) return String(id)
  if (match?.id !== undefined && match?.id !== null) return `local-${match.id}`
  return null
}

export function getScoresheetKey(match) {
  const ident = matchIdentity(match)
  if (!ident) return newScoresheetKey()
  const slot = PREFIX + ident
  let key = memory.get(slot)
  if (!key) {
    try {
      key = globalThis.localStorage?.getItem(slot) || null
    } catch {
      key = null
    }
  }
  if (!key || !SCORESHEET_KEY_RE.test(key)) {
    key = newScoresheetKey()
    try {
      globalThis.localStorage?.setItem(slot, key)
    } catch {
      // private window / storage full: kept in memory for this session
    }
  }
  memory.set(slot, key)
  return key
}
