/**
 * The device's one-time clean-up of dates of birth (owner 2026-11-19: a
 * Swiss match carries the licence number beside a name, a date of birth only
 * when the scorer types one, and the birthdates kept so far go, past sheets
 * too). Run at every start-up (main.jsx), it does its work once per device
 * and never blocks the start: it is not awaited, never throws, and a failure
 * leaves the flag unset so the next start tries again.
 *
 *  (a) the account caches lose every `dob`: the club lists (club_players
 *      players / people), the saved teams (saved_teams players / staff) and
 *      the sent rosters (game_rosters players / staff); the cached profile
 *      in localStorage (`cachedProfile`) too;
 *  (b) every match on the device that is not Global (domain/idMode 'licence')
 *      and not in progress has the date values of its people blanked; the
 *      licences stay (domain/idMode isDateValue: the same rule as the
 *      server's migration). Its people: the players of its two teams, the
 *      bench (match bench_home / bench_away, the teams' bench lists), the
 *      match officials, the rosters waiting for Accept (pendingHomeRoster /
 *      pendingAwayRoster) and the unsaved Match setup draft.
 *
 * A match in progress (live, ended and waiting for its approval, or with the
 * coin toss done) is left alone: its sheet is being written. Its id is kept
 * in the flag and it is cleaned at a later start, once it is closed.
 * Nothing here is sent to the server (the server's own copies are cleaned
 * there); a sync job already queued is sent as it is.
 */
import { isDateValue, isPlaceholderValue } from '../domain/idMode'

export const DOB_CLEANUP_KEY = 'ov-dob-cleanup-v1'
const PROFILE_KEY = 'cachedProfile'
const CLOSED_STATUSES = new Set(['final', 'approved', 'closed'])

/** A match whose sheet is being written: live, ended and not yet approved, or with the coin toss done. */
export function matchInProgress(match) {
  if (!match) return false
  const status = match.status
  if (CLOSED_STATUSES.has(status) || match.approved === true) return false
  return status === 'live' || status === 'ended' || match.coinTossConfirmed === true
}

/** A Swiss match (every match that is not Global): its values are licences or dates. */
const swissMatch = (match) => !!match && match.global !== true

const isDate = (v) => typeof v === 'string' ? (isDateValue(v) || isPlaceholderValue(v)) : false

/** A person without the `dob` key (null / not an object as it is). Same object when it has none. */
export function withoutDob(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || !('dob' in p)) return p
  const { dob: _dob, ...rest } = p
  return rest
}

/** A person with a date value blanked (a licence stays). Same object when there is nothing to blank. */
export function withoutDate(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || !isDate(p.dob)) return p
  return { ...p, dob: '' }
}

// A list mapped, and whether anything changed
function mapList(list, fn) {
  if (!Array.isArray(list)) return { list, changed: false }
  let changed = false
  const out = list.map((p) => {
    const next = fn(p)
    if (next !== p) changed = true
    return next
  })
  return { list: changed ? out : list, changed }
}

// The changes of `keys` (lists of people) of `row` under `fn`, or null
function listChanges(row, keys, fn) {
  const changes = {}
  for (const k of keys) {
    const { list, changed } = mapList(row?.[k], fn)
    if (changed) changes[k] = list
  }
  return Object.keys(changes).length ? changes : null
}

/** The officials of a match without dates: the app's list, or an older match's object keyed by role. */
function officialsWithoutDates(officials) {
  if (Array.isArray(officials)) return mapList(officials, withoutDate)
  if (officials && typeof officials === 'object') {
    let changed = false
    const out = {}
    for (const [k, v] of Object.entries(officials)) {
      const next = withoutDate(v)
      if (next !== v) changed = true
      out[k] = next
    }
    return { list: changed ? out : officials, changed }
  }
  return { list: officials, changed: false }
}

/** A roster waiting for Accept ({ players, bench, ... }) without dates, or the same object. */
function pendingWithoutDates(roster) {
  if (!roster || typeof roster !== 'object' || Array.isArray(roster)) return roster
  const changes = listChanges(roster, ['players', 'bench'], withoutDate)
  return changes ? { ...roster, ...changes } : roster
}

/**
 * The match's own fields without dates: { changes } for db.matches.update, or
 * null when there is nothing to blank.
 */
export function matchChanges(match) {
  if (!swissMatch(match) || matchInProgress(match)) return null
  const changes = listChanges(match, ['bench_home', 'bench_away'], withoutDate) || {}
  const officials = officialsWithoutDates(match.officials)
  if (officials.changed) changes.officials = officials.list
  for (const k of ['pendingHomeRoster', 'pendingAwayRoster']) {
    const next = pendingWithoutDates(match[k])
    if (next !== match[k]) changes[k] = next
  }
  return Object.keys(changes).length ? changes : null
}

/** A Match setup draft's data without dates: its rosters and benches, and the officials' *Dob fields. */
export function draftDataWithoutDates(data) {
  if (!data || typeof data !== 'object') return data
  let changed = false
  const out = { ...data }
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      const m = mapList(v, withoutDate)
      if (m.changed) { out[k] = m.list; changed = true }
    } else if (/Dob$/.test(k) && isDate(v)) {
      out[k] = ''
      changed = true
    }
  }
  return changed ? out : data
}

/** (a) The account caches without `dob`. Returns the rows changed. */
export async function stripCacheDobs(db) {
  let rows = 0
  const tables = [
    ['club_players', ['players', 'people']],
    ['saved_teams', ['players', 'staff']],
    ['game_rosters', ['players', 'staff']]
  ]
  for (const [name, keys] of tables) {
    const table = db[name]
    if (!table) continue
    await db.transaction('rw', table, async () => {
      await table.toCollection().modify((row) => {
        const changes = listChanges(row, keys, withoutDob)
        if (changes) { Object.assign(row, changes); rows++ }
      })
    })
  }
  return rows
}

/** (a) The cached profile without its date of birth. */
export function stripProfileDob(storage) {
  const raw = storage?.getItem(PROFILE_KEY)
  if (!raw) return false
  const profile = JSON.parse(raw)
  if (!profile || typeof profile !== 'object' || !('dob' in profile)) return false
  delete profile.dob
  storage.setItem(PROFILE_KEY, JSON.stringify(profile))
  return true
}

/**
 * (b) The matches of `ids` (all of them when null): the date values of their
 * people blanked. Returns { cleaned, skipped: ids of matches in progress }.
 */
export async function blankMatchDates(db, ids = null) {
  const matches = ids ? (await db.matches.bulkGet(ids)).filter(Boolean) : await db.matches.toArray()
  const skipped = []
  let cleaned = 0
  for (const match of matches) {
    if (!swissMatch(match)) continue
    if (matchInProgress(match)) { skipped.push(match.id); continue }
    await db.transaction('rw', [db.matches, db.players, db.teams, db.match_setup], async () => {
      // read again in the transaction: the scorer may have opened it since
      const fresh = await db.matches.get(match.id)
      if (!swissMatch(fresh) || matchInProgress(fresh)) return
      let touched = false
      const changes = matchChanges(fresh)
      if (changes) { await db.matches.update(fresh.id, changes); touched = true }
      for (const teamId of [fresh.homeTeamId, fresh.awayTeamId]) {
        if (teamId == null) continue
        const players = await db.players.where('teamId').equals(teamId).toArray()
        for (const p of players) {
          if (isDate(p.dob)) { await db.players.update(p.id, { dob: '' }); touched = true }
        }
        const team = await db.teams.get(teamId)
        const teamChanges = team ? listChanges(team, ['benchOfficials', 'benchStaff'], withoutDate) : null
        if (teamChanges) { await db.teams.update(teamId, teamChanges); touched = true }
      }
      const drafts = (await db.match_setup.toArray()).filter((r) => r.matchId === fresh.id)
      for (const d of drafts) {
        const data = draftDataWithoutDates(d.data)
        if (data !== d.data) { await db.match_setup.update(d.id, { data }); touched = true }
      }
      if (touched) cleaned++
    })
  }
  return { cleaned, skipped }
}

function readFlag(storage) {
  try {
    const raw = storage?.getItem(DOB_CLEANUP_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/**
 * Do the clean-up once per device; afterwards only the matches it left
 * alone (in progress then), until none is left. Never throws.
 * @returns {Promise<{ done: boolean, rows?: number, cleaned?: number, pending?: number }>}
 */
export async function runDobCleanup({ db, storage = typeof localStorage === 'undefined' ? null : localStorage } = {}) {
  try {
    if (!db || !storage) return { done: false }
    const flag = readFlag(storage)
    if (flag?.done && !(Array.isArray(flag.pending) && flag.pending.length)) return { done: true, rows: 0, cleaned: 0, pending: 0 }
    let rows = 0
    if (!flag?.done) {
      rows = await stripCacheDobs(db)
      try { stripProfileDob(storage) } catch { /* an unreadable profile: AuthContext rewrites it */ }
    }
    const { cleaned, skipped } = await blankMatchDates(db, flag?.done ? flag.pending : null)
    storage.setItem(DOB_CLEANUP_KEY, JSON.stringify({ done: true, at: new Date().toISOString(), pending: skipped }))
    return { done: true, rows, cleaned, pending: skipped.length }
  } catch (e) {
    console.warn('[dobCleanup] not done, next start again:', e?.message)
    return { done: false }
  }
}

/** main.jsx: start the clean-up after the first paint, without waiting for it. */
export function startDobCleanup({ db, delayMs = 3000 } = {}) {
  try {
    setTimeout(() => { runDobCleanup({ db }).catch(() => {}) }, delayMs)
  } catch { /* no timers: nothing */ }
}
