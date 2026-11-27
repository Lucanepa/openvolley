// A photo of the list goes straight into the roster editor (owner 27.11.2026:
// "just already import them in the official roster and fix there"): every
// field the reading was unsure of (domain/importedRoster fieldIssues: red =
// must fix, amber = check) is marked on the editor's own rows until the
// scorer changes it.
//
// The marks are UI state only, never data: they live in Match setup's state,
// keyed by a token on each row the photo gave (PHOTO_ROW, a Symbol). A row
// edit ({ ...row, field }) keeps the token, so the row keeps its other marks;
// nothing that stores or sends a row sees it (JSON and IndexedDB's structured
// clone skip symbol keys, and the roster is written field by field). A mark
// shows while its field still holds the value the photo gave: the scorer's
// edit clears it. The officials' marks are keyed by their bench role (one
// row per role).
import { fieldIssues, OFFICIAL_KEYS, OFFICIAL_ROLES } from '../../domain/importedRoster'
import { normalizeName } from '../../domain/savedTeams'

export const PHOTO_ROW = Symbol('ov.photoRow')

// imported field -> the roster editor's field (the licence is kept in `dob`)
const PLAYER_FIELD = { number: 'number', licence: 'dob', firstName: 'firstName', lastName: 'lastName', isCaptain: 'isCaptain', isLibero: 'libero' }
const OFFICIAL_FIELD = { licence: 'dob', firstName: 'firstName', lastName: 'lastName' }

const blankish = (v) => v === null || v === undefined || v === '' || v === false
/** Does a field still hold the value the photo gave? */
export function sameValue (now, then) {
  if (blankish(now) && blankish(then)) return true
  if (typeof then === 'boolean' || typeof now === 'boolean') return !!now === !!then
  return String(now ?? '').trim() === String(then ?? '').trim()
}

function marksOf (issues, row, fieldMap) {
  const out = {}
  for (const [field, issue] of Object.entries(issues || {})) {
    const to = fieldMap[field]
    if (!to || !row) continue
    out[to] = { level: issue.level, reason: issue.reason, value: row[to] }
  }
  return Object.keys(out).length ? out : null
}

/**
 * The editor's rows from a photo with their tokens, and the marks on them.
 * `imported`: the photo's roster (importedRosterOf); `players` and `bench`:
 * what importedToSetup made of it (players in the same order).
 * @returns {{ players: object[], rowMarks: Map<symbol, object>, officialMarks: object, total: number }}
 */
export function photoMarksOf (imported, players, bench) {
  const issues = fieldIssues(imported)
  const rowMarks = new Map()
  const marked = (players || []).map((p, i) => {
    const token = Symbol(`photo row ${i + 1}`)
    const row = { ...p, [PHOTO_ROW]: token }
    const m = marksOf(issues.players[i], row, PLAYER_FIELD)
    if (m) rowMarks.set(token, m)
    return row
  })
  const officialMarks = {}
  for (const k of OFFICIAL_KEYS) {
    const role = OFFICIAL_ROLES[k]
    const row = (bench || []).find((b) => b?.role === role)
    const m = marksOf(issues.officials[k], row, OFFICIAL_FIELD)
    if (m) officialMarks[role] = m
  }
  const total = [...rowMarks.values(), ...Object.values(officialMarks)].reduce((n, m) => n + Object.keys(m).length, 0)
  return { players: marked, rowMarks, officialMarks, total }
}

/** The mark of a player's field while it holds the photo's value, else null. */
export function playerMarkOf (state, row, field) {
  const m = row && state?.rowMarks?.get(row[PHOTO_ROW])?.[field]
  return m && sameValue(row[field], m.value) ? m : null
}

/** The mark of a team official's field (by its bench role), else null. */
export function officialMarkOf (state, row, field) {
  const m = row && state?.officialMarks?.[row.role]?.[field]
  return m && sameValue(row[field], m.value) ? m : null
}

/** The marks still shown: { invalid, low } over the rows the editor holds now. */
export function marksLeft (state, roster, bench) {
  const left = { invalid: 0, low: 0 }
  if (!state) return left
  for (const row of roster || []) {
    for (const field of Object.keys(state.rowMarks.get(row?.[PHOTO_ROW]) || {})) {
      const m = playerMarkOf(state, row, field)
      if (m) left[m.level === 'invalid' ? 'invalid' : 'low']++
    }
  }
  for (const row of bench || []) {
    for (const field of Object.keys(state.officialMarks?.[row?.role] || {})) {
      const m = officialMarkOf(state, row, field)
      if (m) left[m.level === 'invalid' ? 'invalid' : 'low']++
    }
  }
  return left
}

/** How many of the editor's rows came from the photo. */
export function photoRowsIn (roster) {
  return (roster || []).filter((row) => row && row[PHOTO_ROW]).length
}

const nameKey = (p) => `${normalizeName(p?.lastName)}|${normalizeName(p?.firstName)}`

/**
 * The tokens carried onto rows rebuilt from the photo's (the "tick who
 * plays" step of a list of more than 14 builds new rows): by licence, else by
 * name.
 */
export function carryPhotoTokens (rows, fromRows) {
  const byLicence = new Map()
  const byName = new Map()
  for (const r of fromRows || []) {
    if (!r?.[PHOTO_ROW]) continue
    const lic = String(r.dob || '').trim()
    if (lic && !byLicence.has(lic)) byLicence.set(lic, r[PHOTO_ROW])
    if (!byName.has(nameKey(r))) byName.set(nameKey(r), r[PHOTO_ROW])
  }
  return (rows || []).map((r) => {
    const lic = String(r?.dob || '').trim()
    const token = (lic && byLicence.get(lic)) || byName.get(nameKey(r))
    return token ? { ...r, [PHOTO_ROW]: token } : r
  })
}
