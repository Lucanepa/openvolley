/**
 * An imported roster, whatever read it (docs/roster-photo-spec.md): the PDF
 * reader (utils/parseRosterPdf), the photo reader on this device
 * (utils/rosterPhoto, plan A) or, one day, a reader on our own server
 * (plan B). All of them hand Match Setup this one structure, and Match Setup
 * takes it the one way (importedToSetup), so a photo and a PDF of the same
 * list give the same roster.
 *
 *   {
 *     source: 'pdf' | 'ocr' | 'server',
 *     players: [{
 *       number: 1..99 | null,       on the list (a photo: written on it), else null
 *       licence: '12345' | '',      the SV number
 *       firstName, lastName,
 *       dob,                        what parseRosterPdf read (it finds the rows by it); never kept
 *       isLfp, isCaptain, isLibero,
 *       confidence?: { [field]: 0..1 }   how sure the reader is (a PDF: none, sure)
 *     }],
 *     coach | ac1 | ac2: { firstName, lastName, licence, confidence? } | null,
 *     struck?: [{ firstName, lastName, licence }]   rows struck out by hand on a photo: not playing, never applied
 *   }
 *
 * Plain data, no React. An Einsatzliste names its players, the coach and two
 * assistants (owner 2026-11-10); shirt numbers, the captain and the liberos
 * are on it only when the team wrote them in (owner 2026-11-23: "if they
 * already put numbers and/or L/C then fill it for this game"). Numbers it
 * leaves out come from the side's saved team, as for a PDF.
 */

import { fillNumbersFromSaved } from './savedTeams'
import { importedIdValue } from './idMode'

export const ROSTER_SOURCES = Object.freeze(['pdf', 'ocr', 'server'])
export const OFFICIAL_KEYS = Object.freeze(['coach', 'ac1', 'ac2'])
export const OFFICIAL_ROLES = Object.freeze({ coach: 'Coach', ac1: 'Assistant Coach 1', ac2: 'Assistant Coach 2' })
export const PLAYER_FIELDS = Object.freeze(['number', 'licence', 'firstName', 'lastName', 'isCaptain', 'isLibero'])
export const OFFICIAL_FIELDS = Object.freeze(['licence', 'firstName', 'lastName'])

/** Below this a field is shown as "check this" on the confirm screen. */
export const LOW_CONFIDENCE = 0.8
// a photo holds one page of a team's list (an Einsatzliste: every eligible
// player, often more than 14): a reading with more rows is no roster. A PDF
// keeps its own limits (parseRosterPdf: pages, text) and all its rows, as before
export const IMPORT_MAX_PLAYERS = 60
export const NAME_MAX = 60
export const MAX_LIBEROS = 2

const PLAYER_LICENCE = /^\d{5,6}$/
// the officials' SV numbers are shorter or longer (#10001; teamRosters.js)
const OFFICIAL_LICENCE = /^\d{4,7}$/
const HAS_LETTER = /\p{L}/u
const DIGIT = /\d/

const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
const digits = (v) => String(v ?? '').replace(/\s+/g, '')
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function shirtNumber (v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : NaN
}

function confidenceOf (raw, fields) {
  if (!isObject(raw)) return undefined
  const out = {}
  for (const f of fields) {
    const c = Number(raw[f])
    if (Number.isFinite(c)) out[f] = Math.min(1, Math.max(0, c))
  }
  return Object.keys(out).length ? out : undefined
}

function playerOf (p) {
  const out = {
    number: shirtNumber(p.number),
    licence: digits(p.licence),
    firstName: text(p.firstName),
    lastName: text(p.lastName),
    dob: typeof p.dob === 'string' ? p.dob : '',
    isLfp: p.isLfp === true,
    isCaptain: p.isCaptain === true,
    isLibero: p.isLibero === true
  }
  const confidence = confidenceOf(p.confidence, PLAYER_FIELDS)
  if (confidence) out.confidence = confidence
  if (p.fromSavedTeam === true) out.fromSavedTeam = true
  return out
}

function officialOf (o) {
  if (!isObject(o)) return null
  const out = { firstName: text(o.firstName), lastName: text(o.lastName), licence: digits(o.licence) }
  if (!out.firstName && !out.lastName) return null
  const confidence = confidenceOf(o.confidence, OFFICIAL_FIELDS)
  if (confidence) out.confidence = confidence
  return out
}

/**
 * The structure from a reader's answer (parseRosterPdf's result, the photo
 * reader's): every field there with its type, strings trimmed and cut to
 * NAME_MAX, unknown keys dropped. Never throws; what cannot be a player row
 * (not an object, no name at all) is left out.
 * @param {object} raw
 * @param {'pdf'|'ocr'|'server'} source
 */
export function importedRosterOf (raw, source) {
  const from = ROSTER_SOURCES.includes(source) ? source : 'pdf'
  const rows = (Array.isArray(raw?.players) ? raw.players : []).filter(isObject)
  const players = (from === 'pdf' ? rows : rows.slice(0, IMPORT_MAX_PLAYERS))
    .map(playerOf)
    .filter((p) => p.firstName || p.lastName)
  const out = { source: from, players }
  for (const k of OFFICIAL_KEYS) out[k] = officialOf(raw?.[k])
  // rows struck out on a photo (not playing): named on the confirm screen, never applied
  const struck = from === 'pdf' || !Array.isArray(raw?.struck)
    ? []
    : raw.struck.filter(isObject).slice(0, IMPORT_MAX_PLAYERS)
      .map((p) => ({ firstName: text(p.firstName), lastName: text(p.lastName), licence: digits(p.licence) }))
      .filter((p) => p.firstName || p.lastName || p.licence)
  if (struck.length) out.struck = struck
  return out
}

/**
 * Is it the structure (importedRosterOf's output, or what a reader on the
 * server would send)? { ok, errors: [{ path, code }] }: the shape only (types,
 * sizes); what the scorer may still correct is fieldIssues'.
 */
export function validateImportedRoster (roster) {
  const errors = []
  const err = (path, code) => errors.push({ path, code })
  if (!isObject(roster)) return { ok: false, errors: [{ path: '', code: 'type' }] }
  if (!ROSTER_SOURCES.includes(roster.source)) err('source', 'value')
  if (!Array.isArray(roster.players)) err('players', 'type')
  else {
    if (roster.source !== 'pdf' && roster.players.length > IMPORT_MAX_PLAYERS) err('players', 'size')
    roster.players.forEach((p, i) => {
      const at = `players.${i}`
      if (!isObject(p)) return err(at, 'type')
      for (const f of ['firstName', 'lastName', 'licence']) {
        if (typeof p[f] !== 'string') err(`${at}.${f}`, 'type')
        else if (p[f].length > NAME_MAX) err(`${at}.${f}`, 'size')
      }
      if (!(p.number === null || Number.isInteger(p.number))) err(`${at}.number`, 'type')
      for (const f of ['isCaptain', 'isLibero', 'isLfp']) if (typeof p[f] !== 'boolean') err(`${at}.${f}`, 'type')
      if (p.confidence !== undefined && !isObject(p.confidence)) err(`${at}.confidence`, 'type')
      else if (p.confidence) {
        for (const [f, c] of Object.entries(p.confidence)) {
          if (!PLAYER_FIELDS.includes(f) || !(typeof c === 'number' && c >= 0 && c <= 1)) err(`${at}.confidence.${f}`, 'value')
        }
      }
    })
  }
  for (const k of OFFICIAL_KEYS) {
    const o = roster[k]
    if (o === null || o === undefined) continue
    if (!isObject(o)) { err(k, 'type'); continue }
    for (const f of ['firstName', 'lastName', 'licence']) if (typeof o[f] !== 'string' || o[f].length > NAME_MAX) err(`${k}.${f}`, 'type')
  }
  return { ok: errors.length === 0, errors }
}

/**
 * What the confirm screen marks, per field: 'invalid' (red; nothing is
 * applied while one is left) or 'low' (amber: the reader was unsure, or the
 * value is unusual; the scorer checks it). Reasons are keys under
 * rosterPhoto.issue.* in the locales.
 *   { players: [{ [field]: { level, reason } }], officials: { coach: {...}, ... }, blocking: boolean }
 */
export function fieldIssues (roster) {
  const players = (roster?.players || []).map(() => ({}))
  const officials = {}
  const put = (target, field, level, reason) => {
    if (target[field]?.level === 'invalid') return
    target[field] = { level, reason }
  }
  const low = (conf) => typeof conf === 'number' && conf < LOW_CONFIDENCE

  const numbers = new Map()
  const captains = []
  const liberos = []
  ;(roster?.players || []).forEach((p, i) => {
    const issues = players[i]
    const conf = p.confidence || {}
    if (p.number !== null) {
      if (!(Number.isInteger(p.number) && p.number >= 1 && p.number <= 99)) put(issues, 'number', 'invalid', 'number')
      else {
        if (!numbers.has(p.number)) numbers.set(p.number, [])
        numbers.get(p.number).push(i)
      }
    }
    if (p.licence && !PLAYER_LICENCE.test(p.licence)) put(issues, 'licence', 'invalid', 'licence')
    else if (!p.licence) put(issues, 'licence', 'low', 'missingLicence')
    if (!p.lastName) put(issues, 'lastName', 'invalid', 'missingName')
    for (const f of ['firstName', 'lastName']) {
      if (p[f] && (DIGIT.test(p[f]) || !HAS_LETTER.test(p[f]))) put(issues, f, 'low', 'odd')
    }
    if (p.isCaptain) captains.push(i)
    if (p.isLibero) liberos.push(i)
    // a libero cannot be the team captain (rule 19.1.3)
    if (p.isCaptain && p.isLibero) put(issues, 'isCaptain', 'invalid', 'captainLibero')
    for (const f of PLAYER_FIELDS) if (low(conf[f])) put(issues, f, 'low', 'unsure')
  })
  for (const at of numbers.values()) if (at.length > 1) for (const i of at) put(players[i], 'number', 'invalid', 'duplicateNumber')
  if (captains.length > 1) for (const i of captains) put(players[i], 'isCaptain', 'invalid', 'twoCaptains')
  if (liberos.length > MAX_LIBEROS) for (const i of liberos) put(players[i], 'isLibero', 'invalid', 'tooManyLiberos')

  for (const k of OFFICIAL_KEYS) {
    const o = roster?.[k]
    // an empty row: no one in that role (the list names none, or the scorer cleared it)
    if (!o || (!o.firstName && !o.lastName && !o.licence)) continue
    const issues = {}
    if (o.licence && !OFFICIAL_LICENCE.test(o.licence)) put(issues, 'licence', 'invalid', 'licence')
    if (!o.lastName && !o.firstName) put(issues, 'lastName', 'invalid', 'missingName')
    for (const f of ['firstName', 'lastName']) {
      if (o[f] && (DIGIT.test(o[f]) || !HAS_LETTER.test(o[f]))) put(issues, f, 'low', 'odd')
    }
    for (const f of OFFICIAL_FIELDS) if (low(o.confidence?.[f])) put(issues, f, 'low', 'unsure')
    officials[k] = issues
  }

  const blocking = players.some((m) => Object.values(m).some((x) => x.level === 'invalid')) ||
    Object.values(officials).some((m) => Object.values(m).some((x) => x.level === 'invalid'))
  return { players, officials, blocking }
}

/**
 * Match Setup's roster and bench from an imported roster: the one way a PDF
 * and a photo are taken (MatchSetup applyImportedRoster). A player keeps the
 * number the list has; one without gets the number the side's saved team
 * has for them, by licence, else name (owner 2026-11-19), never one already
 * worn. The captain and the liberos are the list's (a PDF has none); a third
 * libero mark is left out. Beside the name only the licence is kept
 * (idMode importedIdValue), never the date the list prints.
 * @returns {{ players: object[], bench: object[], numbersFilled: number }}
 */
export function importedToSetup (roster, { idMode, savedTeam = null } = {}) {
  let liberos = 0
  let captain = false
  const rows = (roster?.players || []).map((p) => {
    const libero = p.isLibero && liberos < MAX_LIBEROS ? `libero${++liberos}` : ''
    const isCaptain = p.isCaptain === true && !captain
    if (isCaptain) captain = true
    return {
      id: null,
      number: Number.isInteger(p.number) && p.number >= 1 ? p.number : null,
      firstName: p.firstName || '',
      lastName: p.lastName || '',
      dob: importedIdValue(p, idMode),
      libero,
      isCaptain,
      isLfp: p.isLfp || false
    }
  })
  const { roster: players, filled } = fillNumbersFromSaved(rows, savedTeam)
  const bench = []
  for (const k of OFFICIAL_KEYS) {
    const o = roster?.[k]
    if (!o) continue
    bench.push({ role: OFFICIAL_ROLES[k], firstName: o.firstName || '', lastName: o.lastName || '', dob: importedIdValue(o, idMode) })
  }
  return { players, bench, numbersFilled: filled }
}
