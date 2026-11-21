/**
 * rosterVersions — which version of a team's roster from the server this
 * device has seen, taken or put aside (owner 2026-11-21: "in case the roster
 * has to be reuploaded etc ... a 'refresh' button that looks for rosters on
 * the server"; Match Setup's Remote panel checks again on its own).
 *
 * Two kinds of roster come from the server for a side:
 *  - the upload made with the team's upload PIN (Upload Roster app ->
 *    connections.pending_{home|away}_roster of the match row). Its version is
 *    the `timestamp` the app gives every upload; one without a timestamp (an
 *    older app) is known by its content.
 *  - the roster sent from the manager page (db/023, the device's
 *    game_rosters rows). Its version is `updatedAt`; a team that sends the
 *    same roster again makes a new version with the same content.
 *
 * A version the scorer accepted or rejected is never offered again, nor a
 * new version whose content is the one accepted (nothing would change). A
 * newer version is offered as a card, never filled in by itself.
 * Pure: no React, no Dexie.
 */

// cyrb53: a fast 53-bit string hash (public domain). Not for security: two
// rosters only have to differ, and a signature image is long.
function hash53 (str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const text = (v) => (v === undefined || v === null ? '' : String(v).trim())
// One line per person, the lines sorted: the order of a list does not make another roster
const lines = (list, keys) => (Array.isArray(list) ? list : [])
  .map((p) => keys.map((k) => text(p?.[k])).join('\u0001'))
  .sort()
  .join('\u0002')

/** The content of an uploaded roster ({ players, bench, coachSignature, captainSignature }) as a short key. */
export function uploadedRosterFingerprint (raw) {
  if (!raw || typeof raw !== 'object') return null
  return hash53([
    lines(raw.players, ['number', 'firstName', 'lastName', 'dob', 'libero', 'isCaptain', 'isLfp']),
    lines(raw.bench, ['role', 'firstName', 'lastName', 'dob']),
    text(raw.coachSignature),
    text(raw.captainSignature)
  ].join('\u0003'))
}

/** The content of a sent roster (a game_rosters row: players, staff, signatures) as a short key. */
export function sentRosterFingerprint (row) {
  if (!row || typeof row !== 'object') return null
  return hash53([
    lines(row.players, ['number', 'first_name', 'last_name', 'license_number', 'is_captain', 'is_libero']),
    lines(row.staff, ['role', 'first_name', 'last_name', 'license_number']),
    text(row.coachSignature),
    text(row.captainSignature)
  ].join('\u0003'))
}

/** { version, fp } of an uploaded roster: its timestamp (null without one) and its content. */
export function uploadedRosterIdentity (raw) {
  if (!raw || typeof raw !== 'object') return null
  const version = typeof raw.timestamp === 'string' && raw.timestamp.trim() ? raw.timestamp.trim() : null
  return { version, fp: uploadedRosterFingerprint(raw) }
}

// An identity as it is, a roster as its identity
const identityOf = (v) => (v && typeof v === 'object' && 'fp' in v && 'version' in v ? v : uploadedRosterIdentity(v))

/**
 * The same upload: by the timestamp when both have one, else by the content.
 * `a` and `b` are rosters or identities ({ version, fp }).
 */
export function sameUpload (a, b) {
  const x = identityOf(a)
  const y = identityOf(b)
  if (!x || !y) return false
  if (x.version && y.version) return x.version === y.version
  return !!x.fp && x.fp === y.fp
}

/**
 * What the server's upload for a side is to this device:
 *  - 'none'  the server has none
 *  - 'taken' the version accepted or rejected here, or the content accepted
 *            here sent again (nothing to offer)
 *  - 'same'  the one the card shows already
 *  - 'new'   a version to offer (the card)
 * @param {{ remote: object|null, pending?: object|null, taken?: { accepted?: object, rejected?: object }|null }} args
 */
export function uploadState ({ remote, pending = null, taken = null }) {
  if (!remote || typeof remote !== 'object') return 'none'
  const id = uploadedRosterIdentity(remote)
  if (taken?.accepted && (sameUpload(id, taken.accepted) || (id.fp && id.fp === taken.accepted.fp))) return 'taken'
  if (taken?.rejected && sameUpload(id, taken.rejected)) return 'taken'
  if (pending && sameUpload(id, pending)) return 'same'
  return 'new'
}

/**
 * The match's record after the scorer accepted or rejected the upload `raw`
 * of `side`: match.uploadedRosterTaken = { home|away: { accepted?, rejected? } },
 * each { version, fp, at }. The last accepted one stays when a later one is
 * rejected (the roster in use is still that one).
 */
export function takenAfter (match, side, raw, how, at = new Date().toISOString()) {
  const id = uploadedRosterIdentity(raw)
  const all = match?.uploadedRosterTaken && typeof match.uploadedRosterTaken === 'object' ? match.uploadedRosterTaken : {}
  const mine = all[side] && typeof all[side] === 'object' ? all[side] : {}
  if (!id) return { ...all }
  return { ...all, [side]: { ...mine, [how]: { version: id.version, fp: id.fp, at } } }
}

/** An earlier upload of this side was accepted here: a later one is "a new version". */
export function uploadIsNewVersion (match, side) {
  return !!match?.uploadedRosterTaken?.[side]?.accepted
}
