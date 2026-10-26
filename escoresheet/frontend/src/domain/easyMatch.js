// Easy match: an unofficial match scored on OpenVolley's own scoreboard, with
// no rosters, officials or signatures. The two teams start without players;
// a shirt number becomes a player the first time the scorer types it (in a
// line-up, as a libero, or as a new substitute). Everything else (rotation,
// service, liberos, substitutions, time-outs, sanctions, set and match end)
// is the normal scoreboard's.
//
// An easy match is a test-type match (`test: true` plus `easy: true`): it is
// never synced to the cloud nor uploaded, needs no signatures, and lives in
// the device's test-match slot (its relay room stays the same, so a LedBox
// keeps following it).
//
// Liberos are named in the line-up modal (at most two). A libero box can be
// changed as long as that libero has done nothing yet.

import { MAX_SUBSTITUTIONS_PER_SET } from './substitutions'
import { cutText } from '../utils/stringUtils'

/** The teams' seed keys: "test-" so that clearing the test data removes them */
export const EASY_TEAM_SEED_KEYS = { home: 'test-easy-home', away: 'test-easy-away' }

/** Liberos a team can name (FIVB 19.1.1) */
export const MAX_LIBEROS = 2

/** Error codes of the libero boxes */
export const EASY_LIBERO_ERRORS = {
  invalid: 'invalid',
  duplicate: 'duplicate',
  inLineup: 'inLineup',
  played: 'played'
}

/** Error codes of a new substitute's number */
export const NEW_PLAYER_ERRORS = {
  invalid: 'invalid',
  onCourt: 'onCourt',
  libero: 'libero',
  notAllowed: 'notAllowed'
}

const isBlank = (v) => v == null || String(v).trim() === ''
const same = (a, b) => a != null && b != null && String(a) === String(b)

/** A shirt number 1-99 as a number, or null */
export function shirtNumber(value) {
  const s = String(value ?? '').trim()
  if (!/^\d{1,2}$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= 99 ? n : null
}

/** As Match Setup: "VBC Zürich" -> "VBC", "Wiedikon" -> "WIED" */
export function defaultShortName(name) {
  if (!name) return ''
  const cleaned = String(name).trim().toUpperCase()
  const words = cleaned.split(/\s+/)
  if (words.length > 1 && words[0].length <= 4) return words[0]
  return cutText(cleaned, 4)
}

/** The team's current libero for a slot ('libero1' / 'libero2'), or null */
function liberoInSlot(players, slot) {
  return (players || []).find(p => p?.libero === slot) || null
}

/** Shirt numbers of the team's named liberos, slot order ('' when empty) */
export function easyLiberoNumbers(players) {
  return ['libero1', 'libero2'].map(slot => {
    const p = liberoInSlot(players, slot)
    return p ? String(p.number) : ''
  })
}

/** Has the number played as a regular player (in a line-up or substitution)? */
export function playedAsPlayer(events, team, number) {
  return (events || []).some(e => {
    if (e.payload?.team !== team) return false
    if (e.type === 'lineup') return Object.values(e.payload?.lineup || {}).some(v => same(v, number))
    if (e.type === 'substitution') return same(e.payload?.playerIn, number) || same(e.payload?.playerOut, number)
    return false
  })
}

const LIBERO_EVENTS = ['libero_entry', 'libero_exit', 'libero_exchange', 'libero_unable', 'libero_redesignation', 'sanction']

/** Has the libero done anything yet (entry, exit, exchange, unable, a sanction...)? */
export function liberoUsed(events, team, number) {
  return (events || []).some(e => {
    if (e.payload?.team !== team) return false
    if (!LIBERO_EVENTS.includes(e.type)) return false
    const p = e.payload || {}
    return [p.liberoIn, p.liberoOut, p.libero, p.playerIn, p.playerOut, p.playerNumber, p.liberoNumber].some(v => same(v, number))
  })
}

/**
 * The libero boxes are read-only once a libero was declared unable or another
 * player was re-designated libero: the scoreboard's own libero flows decide
 * from then on (and a third libero must never be added).
 */
export function easyLiberosLocked(players) {
  return (players || []).some(p => p?.libero === 'unable' || p?.libero === 'redesignated')
}

/**
 * The shirt numbers of a team that some event names: line-ups, substitutions,
 * libero actions, sanctions, game captains. A player of an easy match that no
 * event names any more (a line-up undone or retyped) is a stray.
 */
export function easyReferencedNumbers(events, team) {
  const numbers = new Set()
  const keep = (v) => { const n = shirtNumber(v); if (n != null) numbers.add(n) }
  ;(events || []).forEach(e => {
    const p = e.payload || {}
    if (p.team !== team) return
    if (e.type === 'lineup') Object.values(p.lineup || {}).forEach(keep)
    else [p.playerIn, p.playerOut, p.playerNumber, p.liberoIn, p.liberoOut, p.liberoNumber].forEach(keep)
  })
  return numbers
}

/** Is this player of an easy match one that no event names (and no libero)? */
export function isEasyStray(player, referenced) {
  return !!player?.easy && (!player.libero || player.libero === '') && !referenced.has(Number(player.number))
}

/**
 * The errors of the two libero boxes. A box left as it was (the libero already
 * named) is never an error.
 *
 * @param {object} args
 * @param {string[]} args.liberos two values ('' = none)
 * @param {string[]} args.lineup the six line-up values being entered
 * @param {object[]} args.players the team's players
 * @param {object[]} args.events the match events
 * @param {'home'|'away'} args.team
 * @returns {Record<number, string>} box index -> EASY_LIBERO_ERRORS code
 */
export function easyLiberoErrors({ liberos = [], lineup = [], players = [], events = [], team }) {
  const errors = {}
  const values = (liberos || []).slice(0, MAX_LIBEROS).map(v => (isBlank(v) ? '' : String(v).trim()))
  const named = easyLiberoNumbers(players)
  const inLineup = new Set((lineup || []).filter(v => !isBlank(v)).map(v => String(Number(v))))
  values.forEach((value, i) => {
    if (!value) return
    const n = shirtNumber(value)
    if (n == null) { errors[i] = EASY_LIBERO_ERRORS.invalid; return }
    if (values.some((other, j) => j !== i && other && shirtNumber(other) === n)) { errors[i] = EASY_LIBERO_ERRORS.duplicate; return }
    if (inLineup.has(String(n))) { errors[i] = EASY_LIBERO_ERRORS.inLineup; return }
    if (same(named[i], n)) return
    if (playedAsPlayer(events, team, n)) errors[i] = EASY_LIBERO_ERRORS.played
  })
  return errors
}

/** May the libero in this slot still be changed (named, but has done nothing)? */
export function liberoSlotEditable({ players = [], events = [], team, slot }) {
  if (easyLiberosLocked(players)) return false
  const current = liberoInSlot(players, slot)
  return !current || !liberoUsed(events, team, current.number)
}

/** A player of an easy match: only the shirt number (and the libero slot, if any) */
export function easyPlayerRow({ teamId, number, libero = '', now = new Date().toISOString() }) {
  return {
    teamId,
    number,
    name: '',
    firstName: '',
    lastName: '',
    dob: '',
    libero,
    isCaptain: false,
    isLfp: false,
    role: null,
    test: true,
    easy: true,
    createdAt: now
  }
}

/**
 * What saving a line-up of an easy match changes in the team's players: every
 * line-up number that is no player yet is added, and the libero boxes name
 * (or replace) the team's liberos. Call only when lineupEntryErrors (with
 * allowUnknown) and easyLiberoErrors found nothing.
 *
 * @returns {{ add: object[], update: { id: number, changes: object }[], remove: number[] }}
 */
export function easyRosterChanges({ teamId, team, players = [], events = [], lineup = [], liberos = null, now = new Date().toISOString() }) {
  const add = []
  const update = []
  const remove = []
  // Players no event names any more (a line-up undone or retyped) go, unless
  // this line-up names them
  const referenced = easyReferencedNumbers(events, team)
  ;(lineup || []).forEach(v => { const n = shirtNumber(v); if (n != null) referenced.add(n) })
  ;(liberos || []).forEach(v => { const n = shirtNumber(v); if (n != null) referenced.add(n) })
  ;(players || []).forEach(pl => { if (isEasyStray(pl, referenced)) remove.push(pl.id) })
  const byNumber = new Map((players || []).map(p => [String(Number(p.number)), p]))
  const willAdd = new Set()

  ;(lineup || []).forEach(v => {
    const n = shirtNumber(v)
    if (n == null || byNumber.has(String(n)) || willAdd.has(String(n))) return
    add.push(easyPlayerRow({ teamId, number: n, now }))
    willAdd.add(String(n))
  })

  if (Array.isArray(liberos) && !easyLiberosLocked(players)) {
    const SLOTS = ['libero1', 'libero2']
    // The slot each number ends in; a libero who did something keeps its slot
    const finalSlot = new Map()
    SLOTS.forEach((slot, i) => {
      const current = liberoInSlot(players, slot)
      const wanted = current && liberoUsed(events, team, current.number) ? Number(current.number) : shirtNumber(liberos[i])
      if (wanted != null && !finalSlot.has(wanted)) finalSlot.set(wanted, slot)
    })
    ;(players || []).forEach(pl => {
      if (pl.libero && !SLOTS.includes(pl.libero)) return // unable / re-designated: not ours to change
      const wantedSlot = finalSlot.get(Number(pl.number)) || ''
      const was = pl.libero || ''
      if (wantedSlot === was) return
      // A libero typed by mistake and never used goes away; a roster player keeps the shirt
      if (wantedSlot === '' && pl.easy && !playedAsPlayer(events, team, pl.number) && !liberoUsed(events, team, pl.number)) remove.push(pl.id)
      else update.push({ id: pl.id, changes: { libero: wantedSlot } })
    })
    finalSlot.forEach((slot, number) => {
      if (byNumber.has(String(number))) return
      const pending = add.find(pl => same(pl.number, number))
      if (pending) pending.libero = slot
      else add.push(easyPlayerRow({ teamId, number, libero: slot, now }))
    })
  }

  const removed = [...new Set(remove)]
  return { add, update: update.filter(u => !removed.includes(u.id)), remove: removed }
}

/**
 * May a number that is no player yet come in for `playerOut`? Exactly when the
 * scoreboard would offer any bench player who has not played: a regular
 * substitution while the team has substitutions left and the player going
 * out did not come in as a substitute (only the player they replaced can
 * then come back), or an exceptional substitution.
 *
 * @param {object} args
 * @param {object[]} args.substitutions this set's substitution events of the team
 * @param {number|string} args.playerOut
 * @param {number} args.regularSubstitutionsUsed
 * @param {boolean} [args.exceptional]
 */
export function newPlayerMayEnter({ substitutions = [], playerOut, regularSubstitutionsUsed = 0, exceptional = false }) {
  if (exceptional) return true
  if (regularSubstitutionsUsed >= MAX_SUBSTITUTIONS_PER_SET) return false
  return !(substitutions || []).some(s => same(s.payload?.playerIn, playerOut))
}

/**
 * Check of a number typed for a new substitute: null when it can come in as a
 * new player; 'existing' when it already is a player (the scorer picks it in
 * the list, where the substitution rules decide); otherwise an error code.
 */
export function newPlayerError({ value, players = [], onCourt = [] }) {
  const n = shirtNumber(value)
  if (n == null) return NEW_PLAYER_ERRORS.invalid
  if ((onCourt || []).some(v => same(Number(v), n))) return NEW_PLAYER_ERRORS.onCourt
  const existing = (players || []).find(p => same(Number(p.number), n))
  if (existing && existing.libero && existing.libero !== '') return NEW_PLAYER_ERRORS.libero
  if (existing) return 'existing'
  return null
}

const COLOUR = /^#[0-9a-f]{6}$/i

/**
 * Prefill of the easy-match form from the page address, so another program
 * (a scoreboard console) can open OpenVolley on its game:
 *   ?easy=1&home=KSC+Wiedikon&away=VBC+Zürich&bestOf=5&homeColor=%23dc2626
 *   &awayColor=%233b82f6&homeShort=KSCW&awayShort=VBCZ&league=3L&game=406201&hall=KWI
 * Returns null when the address does not ask for an easy match.
 */
export function easyMatchPrefill(search) {
  let params
  try {
    params = new URLSearchParams(search || '')
  } catch {
    return null
  }
  if (!params.has('easy')) return null
  // cut on a character boundary: half an emoji made Save PDF fail (cutText)
  const text = (key, max = 60) => cutText((params.get(key) || '').trim(), max)
  const colour = (key) => (COLOUR.test(params.get(key) || '') ? params.get(key).toLowerCase() : null)
  const bestOf = params.get('bestOf') === '3' ? 3 : 5
  return {
    homeName: text('home'),
    awayName: text('away'),
    homeShort: text('homeShort', 8).toUpperCase(),
    awayShort: text('awayShort', 8).toUpperCase(),
    homeColor: colour('homeColor'),
    awayColor: colour('awayColor'),
    bestOf,
    league: text('league', 40),
    gameNumber: text('game', 20),
    hall: text('hall', 60)
  }
}
