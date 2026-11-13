/**
 * uploadedRoster — the rules of a roster a team uploads for a match (Upload
 * Roster app -> POST /api/match/upload-roster -> the match row's
 * connections.pending_home_roster / pending_away_roster, or a LAN relay),
 * checked before it is sent, by the server before it is stored, and again
 * before the scorer's Preview and Accept use it. Pure, no React, no Dexie.
 *
 * The backend runs a copy of checkUploadedRoster (backend/lib/uploadedRoster.js:
 * its Docker build sees only escoresheet/backend); change both.
 * backend/tests/uploadedRoster.test.js fails when the two answer differently.
 *
 * A roster: { players, bench, coachSignature?, captainSignature?, timestamp? }
 *  - players: at most UPLOADED_ROSTER_MAX_PLAYERS plain objects { number
 *    (1-99, or empty), firstName, lastName, dob, libero ('', 'libero1' or
 *    'libero2'), isCaptain, isLfp }: no number twice (7 and '7' are one
 *    number), one captain at most, each libero slot once
 *  - bench: at most one official per role of BENCH_ROLES { role, firstName,
 *    lastName, dob }
 *  - the coach's and captain's signatures: absent or the signature pad's PNG
 *    data URL (never a link or any other text: the sheet draws it as a picture)
 * Texts are trimmed and bounded; every other key is dropped.
 */

export const UPLOADED_ROSTER_MAX_PLAYERS = 30
export const UPLOADED_NAME_MAX = 80
// The pad's picture (SignaturePad toDataURL('image/png')) of a large tablet
// screen stays well below this; the upload body is limited to 5 MB anyway.
export const UPLOADED_SIGNATURE_MAX_LENGTH = 1000000
// The pattern of the team managers' signatures (backend/lib/teams.js SIGNATURE_RE)
export const SIGNATURE_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/
// The bench of the scoresheet: one official per role (backend/lib/savedTeams.js STAFF_ROLES)
export const BENCH_ROLES = Object.freeze(['Coach', 'Assistant Coach 1', 'Assistant Coach 2', 'Physiotherapist', 'Medic'])

// ---- the rules (backend/lib/uploadedRoster.js has the same code below its imports)
const LIBERO_SLOTS = ['libero1', 'libero2']
const DATE_RE = /^(\d{1,2}[./]\d{1,2}[./]\d{4}|\d{4}-\d{2}-\d{2})$/
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]{2,20}(Z|[+-]\d{2}:?\d{2})?$/

// A plain object (also one made in another realm, e.g. read back from IndexedDB)
const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]'
const empty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/**
 * Check an uploaded roster and give it back in the stored shape.
 * @param {unknown} raw
 * @returns {{ ok: true, roster: { players: object[], bench: object[], coachSignature: string|null,
 *   captainSignature: string|null, timestamp: string|null } } | { ok: false, problems: Array<{ path: string, code: string }> }}
 *   problems: the first problem of each entry, in order (code: notObject, notList, tooMany,
 *   badText, badDate, badNumber, numberTwice, badLibero, liberoSlotTwice, badFlag,
 *   captainTwice, badRole, roleTwice, badSignature, badTimestamp)
 */
export function checkUploadedRoster(raw) {
  const problems = []
  const problem = (path, code) => { problems.push({ path, code }) }
  if (!isPlainObject(raw)) return { ok: false, problems: [{ path: 'roster', code: 'notObject' }] }
  const list = (key, max) => {
    const v = raw[key]
    if (v === undefined || v === null) return []
    if (!Array.isArray(v)) { problem(key, 'notList'); return [] }
    if (v.length > max) { problem(key, 'tooMany'); return [] }
    return v
  }
  const text = (v, path, out, key) => {
    if (empty(v)) { out[key] = ''; return true }
    if (typeof v !== 'string' || v.trim().length > UPLOADED_NAME_MAX) { problem(path, 'badText'); return false }
    out[key] = v.trim()
    return true
  }
  const person = (entry, path) => {
    const out = {}
    if (!text(entry.firstName, `${path}.firstName`, out, 'firstName')) return null
    if (!text(entry.lastName, `${path}.lastName`, out, 'lastName')) return null
    if (empty(entry.dob)) out.dob = ''
    else if (typeof entry.dob !== 'string' || !DATE_RE.test(entry.dob.trim())) { problem(`${path}.dob`, 'badDate'); return null }
    else out.dob = entry.dob.trim()
    return out
  }
  const flag = (v, path) => {
    if (v === undefined || v === null) return false
    if (typeof v !== 'boolean') { problem(path, 'badFlag'); return null }
    return v
  }

  const players = []
  const numbers = new Set()
  const slots = new Set()
  let captains = 0
  list('players', UPLOADED_ROSTER_MAX_PLAYERS).forEach((entry, i) => {
    const path = `players[${i}]`
    if (!isPlainObject(entry)) { problem(path, 'notObject'); return }
    const p = person(entry, path)
    if (!p) return
    let number = null
    if (!empty(entry.number)) {
      const n = typeof entry.number === 'string' && /^\s*\d{1,2}\s*$/.test(entry.number) ? Number(entry.number) : entry.number
      if (!Number.isInteger(n) || n < 1 || n > 99) { problem(`${path}.number`, 'badNumber'); return }
      if (numbers.has(n)) { problem(`${path}.number`, 'numberTwice'); return }
      numbers.add(n)
      number = n
    }
    let libero = ''
    if (!empty(entry.libero)) {
      if (!LIBERO_SLOTS.includes(entry.libero)) { problem(`${path}.libero`, 'badLibero'); return }
      if (slots.has(entry.libero)) { problem(`${path}.libero`, 'liberoSlotTwice'); return }
      slots.add(entry.libero)
      libero = entry.libero
    }
    const isCaptain = flag(entry.isCaptain, `${path}.isCaptain`)
    const isLfp = flag(entry.isLfp, `${path}.isLfp`)
    if (isCaptain === null || isLfp === null) return
    if (isCaptain && ++captains > 1) { problem(`${path}.isCaptain`, 'captainTwice'); return }
    players.push({ number, firstName: p.firstName, lastName: p.lastName, dob: p.dob, libero, isCaptain, isLfp })
  })

  const bench = []
  const roles = new Set()
  list('bench', BENCH_ROLES.length).forEach((entry, i) => {
    const path = `bench[${i}]`
    if (!isPlainObject(entry)) { problem(path, 'notObject'); return }
    if (typeof entry.role !== 'string' || !BENCH_ROLES.includes(entry.role)) { problem(`${path}.role`, 'badRole'); return }
    if (roles.has(entry.role)) { problem(`${path}.role`, 'roleTwice'); return }
    const p = person(entry, path)
    if (!p) return
    roles.add(entry.role)
    bench.push({ role: entry.role, ...p })
  })

  const signature = (key) => {
    const v = raw[key]
    if (empty(v)) return null
    if (typeof v !== 'string' || v.length > UPLOADED_SIGNATURE_MAX_LENGTH || !SIGNATURE_RE.test(v)) { problem(key, 'badSignature'); return null }
    return v
  }
  const coachSignature = signature('coachSignature')
  const captainSignature = signature('captainSignature')
  let timestamp = null
  if (!empty(raw.timestamp)) {
    if (typeof raw.timestamp !== 'string' || !TIMESTAMP_RE.test(raw.timestamp)) problem('timestamp', 'badTimestamp')
    else timestamp = raw.timestamp
  }
  if (problems.length) return { ok: false, problems }
  return { ok: true, roster: { players, bench, coachSignature, captainSignature, timestamp } }
}
// ---- end of the rules

/**
 * May the scorer take an uploaded roster into this match? Only before the
 * coin toss (a local match is 'scheduled' or 'setup' until then): once the
 * match runs, its events name players by number, and the server takes no
 * upload either. Anything else: only Reject.
 */
export function takesUploadedRoster(match) {
  const status = match?.status
  return !!match && (status === undefined || status === null || status === '' || status === 'scheduled' || status === 'setup')
}

/**
 * The uploaded coach and captain signatures that go into empty slots only:
 * a signature the match already has stays (as on the server, which never
 * replaces a stored one with an upload). `stored`: { coach, captain }.
 * @returns {{ coach: string|null, captain: string|null }}
 */
export function uploadedSignaturesToTake(roster, stored = {}) {
  const has = (v) => typeof v === 'string' && v !== ''
  return {
    coach: roster?.coachSignature && !has(stored.coach) ? roster.coachSignature : null,
    captain: roster?.captainSignature && !has(stored.captain) ? roster.captainSignature : null
  }
}

/**
 * The uploaded signatures Accept leaves out because the match has that
 * signature already (uploadedSignaturesToTake): the roster's card says so
 * before Accept, as a re-upload with another captain or coach would else
 * keep the earlier person's signature without a word.
 * @returns {{ coach: boolean, captain: boolean }}
 */
export function uploadedSignaturesKept(roster, stored = {}) {
  const take = uploadedSignaturesToTake(roster, stored)
  return { coach: !!roster?.coachSignature && !take.coach, captain: !!roster?.captainSignature && !take.captain }
}
