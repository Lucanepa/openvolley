/**
 * The player pool of a team: every player MatchSetup knows for it, from which
 * the scorer ticks the match roster ("load all the players, and select them":
 * the owner, 2026-10-21). PlayerPoolModal shows it; MatchSetup applies the
 * ticked players as the roster, as a saved-team load does.
 *
 * Sources, in priority order (a player found in several takes the number,
 * date of birth and libero / captain marks of the first that has them):
 *   current   the roster in the setup now
 *   imported  an Einsatzliste just read (utils/parseRosterPdf)
 *   saved     the saved team (domain/savedTeams savedTeamToRoster, active players)
 *   earlier   rosters of earlier matches of the team on this device, newest
 *             first (db/rememberedPlayers)
 * Every source is a list of MatchSetup roster entries
 * ({ number, firstName, lastName, dob, libero, isCaptain, isLfp }).
 */

import { normalizeName, displayDobToIso } from './savedTeams'

// FIVB 4.1.1: up to 14 players on the scoresheet; with more than 12, two
// liberos (19.1.1, MatchSetup liberosOk); never more than two liberos marked
export const ROSTER_MAX = 14
export const ROSTER_MIN = 6
export const TWO_LIBEROS_ABOVE = 12
export const POOL_SOURCES = ['current', 'imported', 'saved', 'earlier']

const isLibero = (p) => p?.libero === 'libero1' || p?.libero === 'libero2' || p?.libero === true

function numberOf(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null
}

/**
 * The identity of a player across sources: the name (last + first), and the
 * date of birth when there is one, so a new shirt number is the same player.
 * A player without a name is known by the number only.
 */
export function poolKey(p) {
  const name = `${normalizeName(p?.lastName)}|${normalizeName(p?.firstName)}`
  if (name !== '|') return `n:${name}`
  const n = numberOf(p?.number)
  return n === null ? null : `#:${n}`
}

const hasName = (p) => !!(String(p?.lastName || '').trim() || String(p?.firstName || '').trim())

// A date of birth to compare: a saved team gives DD.MM.YYYY, an Einsatzliste
// DD/MM/YYYY, the same day either way
const dobId = (dob) => displayDobToIso(dob) || dob

/**
 * Merge the sources into one list, sorted by number (players without a
 * number last, then by name).
 * @param {{current?: object[], imported?: object[], saved?: object[], earlier?: object[][]}} sources
 *   `earlier`: one roster per earlier match, newest first; the first one is
 *   "the team's last match" (lastMatch on its players)
 * @returns {{ key: string, number: number|null, firstName: string, lastName: string, dob: string,
 *   isLibero: boolean, liberoSlot: ''|'libero1'|'libero2', isCaptain: boolean, isLfp: boolean,
 *   sources: string[], lastMatch: boolean }[]}
 */
export function buildPlayerPool({ current = [], imported = [], saved = [], earlier = [] } = {}) {
  const byKey = new Map()
  const add = (p, source, lastMatch) => {
    if (!p || (!hasName(p) && numberOf(p.number) === null)) return
    let key = poolKey(p)
    if (!key) return
    const dob = String(p.dob || '').trim()
    const known = byKey.get(key)
    if (known && dob && known.dob && dobId(known.dob) !== dobId(dob)) {
      // Same name, another date of birth: another person
      key = `${key}|${dobId(dob)}`
    }
    const entry = byKey.get(key)
    if (!entry) {
      byKey.set(key, {
        key,
        number: numberOf(p.number),
        firstName: String(p.firstName || '').trim(),
        lastName: String(p.lastName || '').trim(),
        dob,
        isLibero: isLibero(p),
        liberoSlot: p.libero === 'libero1' || p.libero === 'libero2' ? p.libero : '',
        isCaptain: !!p.isCaptain,
        isLfp: !!p.isLfp,
        sources: [source],
        lastMatch: !!lastMatch
      })
      return
    }
    if (!entry.sources.includes(source)) entry.sources.push(source)
    if (lastMatch) entry.lastMatch = true
    if (entry.number === null) entry.number = numberOf(p.number)
    if (!entry.dob && dob) entry.dob = dob
    if (!entry.firstName && p.firstName) entry.firstName = String(p.firstName).trim()
    if (!entry.isLibero && isLibero(p)) {
      entry.isLibero = true
      entry.liberoSlot = p.libero === 'libero1' || p.libero === 'libero2' ? p.libero : ''
    }
    if (!entry.isCaptain && p.isCaptain) entry.isCaptain = true
  }
  for (const p of current) add(p, 'current')
  for (const p of imported) add(p, 'imported')
  for (const p of saved) add(p, 'saved')
  earlier.forEach((roster, i) => { for (const p of roster || []) add(p, 'earlier', i === 0) })

  return [...byKey.values()].sort((a, b) =>
    (a.number ?? 1000) - (b.number ?? 1000) ||
    a.lastName.localeCompare(b.lastName) ||
    a.firstName.localeCompare(b.firstName))
}

/**
 * The players ticked when the dialog opens: the roster in the setup now; else
 * those of the Einsatzliste (or, without one, of the whole pool) who played
 * the team's last match; else all of them.
 * @returns {Set<string>}
 */
export function preselectedKeys(pool) {
  const list = Array.isArray(pool) ? pool : []
  const current = list.filter(e => e.sources.includes('current'))
  if (current.length) return new Set(current.map(e => e.key))
  const imported = list.filter(e => e.sources.includes('imported'))
  const base = imported.length ? imported : list
  const played = base.filter(e => e.lastMatch)
  return new Set((played.length ? played : base).map(e => e.key))
}

/**
 * Warnings for a selection (never a block: the setup's own checks decide at
 * the coin toss): more than 14, more than 12 with fewer than two liberos,
 * more than two liberos, fewer than six.
 * @returns {{key: string, params?: object}[]}
 */
export function selectionIssues(selected) {
  const list = Array.isArray(selected) ? selected : []
  const liberos = list.filter(e => e.isLibero).length
  const issues = []
  if (list.length > ROSTER_MAX) issues.push({ key: 'playerPool.tooMany', params: { max: ROSTER_MAX, count: list.length } })
  if (list.length > TWO_LIBEROS_ABOVE && liberos < 2) issues.push({ key: 'playerPool.twoLiberos', params: { max: TWO_LIBEROS_ABOVE } })
  if (liberos > 2) issues.push({ key: 'playerPool.tooManyLiberos' })
  if (list.length > 0 && list.length < ROSTER_MIN) issues.push({ key: 'playerPool.tooFew', params: { min: ROSTER_MIN, count: list.length } })
  return issues
}

/**
 * The ticked players as MatchSetup roster entries, by number. Liberos keep
 * their L1 / L2 where they had one, the others fill the free slots by number;
 * a third libero is not marked. One captain (the first).
 */
export function poolToRoster(selected) {
  const list = [...(Array.isArray(selected) ? selected : [])].sort((a, b) => (a.number ?? 1000) - (b.number ?? 1000))
  const slots = new Map()
  const taken = new Set()
  for (const e of list) {
    if (e.isLibero && e.liberoSlot && !taken.has(e.liberoSlot)) { slots.set(e.key, e.liberoSlot); taken.add(e.liberoSlot) }
  }
  for (const e of list) {
    if (!e.isLibero || slots.has(e.key)) continue
    const free = ['libero1', 'libero2'].find(s => !taken.has(s))
    if (!free) break
    slots.set(e.key, free)
    taken.add(free)
  }
  // libero2 without libero1 (the first libero left out): the remaining one is L1
  if (taken.has('libero2') && !taken.has('libero1')) {
    for (const [k, s] of slots) if (s === 'libero2') slots.set(k, 'libero1')
  }
  let captain = false
  return list.map(e => {
    const isCaptain = e.isCaptain && !captain
    if (isCaptain) captain = true
    return {
      number: e.number,
      firstName: e.firstName,
      lastName: e.lastName,
      dob: e.dob,
      libero: slots.get(e.key) || '',
      isCaptain,
      isLfp: e.isLfp
    }
  })
}
