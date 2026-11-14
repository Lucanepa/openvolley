/**
 * uploadedRoster — the server's check of a roster a team uploads with its
 * upload PIN (POST /api/match/upload-roster): a copy of the scorer app's
 * rules (escoresheet/frontend/src/domain/uploadedRoster.js; the Docker build
 * sees only escoresheet/backend), so a modified client stores nothing the
 * app's Preview and Accept would refuse. tests/uploadedRoster.test.js checks
 * that the two answer alike; change both.
 *
 * Also: the signatures an upload may fill in (never one the match has), and
 * the pending rosters a match drops at the coin toss or the match end.
 */
import { SIGNATURE_RE } from './teams.js'
import { STAFF_ROLES as BENCH_ROLES } from './savedTeams.js'

export { SIGNATURE_RE, BENCH_ROLES }
export const UPLOADED_ROSTER_MAX_PLAYERS = 30
export const UPLOADED_NAME_MAX = 80
// The pad's picture of a large tablet screen stays well below this; the body is limited to 5 MB anyway
export const UPLOADED_SIGNATURE_MAX_LENGTH = 1000000

// ---- the rules (a copy of frontend/src/domain/uploadedRoster.js)
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

/** "players[2].number: badNumber, bench[0].role: roleTwice" (the first few), for a 400 answer. */
export function uploadedRosterProblemText(problems, max = 3) {
  const list = (problems || []).slice(0, max).map((p) => `${p.path}: ${p.code}`)
  if ((problems || []).length > max) list.push(`${problems.length - max} more`)
  return list.join(', ')
}

const SIGNATURE_KEYS = { home: { coach: 'home_coach', captain: 'home_captain' }, away: { coach: 'away_coach', captain: 'away_captain' } }

/**
 * The matches.signatures object after an upload of `team`: the uploaded
 * coach and captain signatures go into empty keys only, every other key as
 * stored. null when nothing changes. An upload PIN never replaces a
 * signature the match has (the scorer's, or an earlier upload's).
 */
export function signaturesAfterUpload(stored, team, { coachSignature, captainSignature }) {
  const keys = SIGNATURE_KEYS[team]
  if (!keys) return null
  const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  const filled = (k) => typeof base[k] === 'string' && base[k] !== ''
  const add = {}
  if (coachSignature && !filled(keys.coach)) add[keys.coach] = coachSignature
  if (captainSignature && !filled(keys.captain)) add[keys.captain] = captainSignature
  return Object.keys(add).length ? { ...base, ...add } : null
}

// The statuses of a match that has left 'setup' and is not closed: the coin
// toss ('live') and the match end ('ended'). A closing write ('approved',
// 'final') is left alone: db/007's guard lets a closed match take only
// approved -> final or a no-op rewrite, so two added keys there would refuse
// Close match on every match closed without them; the coin toss or the match
// end has dropped the rosters by then.
const CLEARING_STATUSES = new Set(['live', 'ended'])

/**
 * A match update (/api/db) whose status leaves 'setup' (CLEARING_STATUSES):
 * the teams' uploaded rosters the server still holds go with it (connections
 * is merged, so only these two keys change). The scorer can no longer accept
 * them, and a device that restores the running match must not find them.
 * Anything else as given.
 */
export function withPendingRostersCleared(data) {
  if (!isPlainObject(data) || !CLEARING_STATUSES.has(data.status)) return data
  if (data.connections !== undefined && !isPlainObject(data.connections)) return data
  return { ...data, connections: { ...(data.connections || {}), pending_home_roster: null, pending_away_roster: null } }
}
