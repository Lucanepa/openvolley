/**
 * A player who is also a bench official: a playing coach, #7 on the roster
 * and C on the bench list (owner 2026-11-22: "the bench official gets greyed
 * out when they're in the court, and when they're on the bench, their number
 * on the bench gets greyed out. injuries, substitutions, sanctions etc is
 * given to either the number or function based on where the person is").
 * Pure: no React, no Dexie.
 *
 * THE LINK is kept on the official's row of the match roster (bench_home /
 * bench_away), with the roster, so the scoresheet, the tablets and the
 * backups have it: `plays`
 *   - not set   automatic: the one player of the team who is the same person
 *               (the same licence, or without one the same name:
 *               teamRosters samePersonInMatch)
 *   - a number  the scorer's choice in the roster editor ("Plays as #7")
 *   - false     not the same person, whatever the names say
 *
 * WHERE HE IS decides the role:
 *   - on court (in the current line-up, or replaced by the libero, who gives
 *     the place back to him): the player. The official's chip is greyed;
 *     sanctions, injuries and substitutions go to #7.
 *   - anywhere else (the bench, before the line-up of a set): the official.
 *     His number on the bench is greyed and his sanctions go to the
 *     official's chip; he may still come in as a substitute, and is the
 *     player again.
 *
 * ONE PERSON FOR THE SANCTIONS: a sanction of a linked official records the
 * number too (`plays` on the sanction, sanctionPlays), so the escalation
 * (domain/sanctions memberSanctions) and an expulsion or disqualification
 * count for him in both roles.
 */

import { samePersonInMatch } from './teamRosters'

const hasNumber = (n) => n !== undefined && n !== null && n !== false && String(n).trim() !== ''
const same = (a, b) => hasNumber(a) && hasNumber(b) && String(a).trim() === String(b).trim()
const named = (o) => !!(String(o?.firstName ?? o?.first_name ?? '').trim() || String(o?.lastName ?? o?.last_name ?? '').trim())

/**
 * An official row's own `plays`: a shirt number (the scorer's choice), false
 * (not the same person), or undefined (automatic).
 * @param {object} official
 * @returns {number|string|false|undefined}
 */
export function playsValue(official) {
  const v = official?.plays
  if (v === false) return false
  return hasNumber(v) ? v : undefined
}

/**
 * The shirt number of the one player of `players` who is the same person as
 * the official, else null (none, or more than one).
 * @param {object} official a bench official row
 * @param {Array} players the team's players
 * @returns {number|string|null}
 */
export function autoPlaysAs(official, players) {
  if (!named(official)) return null
  const found = (players || []).filter(p => hasNumber(p?.number) && samePersonInMatch(official, p))
  return found.length === 1 ? found[0].number : null
}

/**
 * The shirt number the official also plays with, or null: the scorer's
 * choice when it names a player of the team, else the automatic link.
 * @param {object} official
 * @param {Array} players the team's players
 * @returns {number|string|null}
 */
export function officialPlaysAs(official, players) {
  const v = playsValue(official)
  if (v === false) return null
  if (v !== undefined) return (players || []).find(p => same(p?.number, v))?.number ?? null
  return autoPlaysAs(official, players)
}

/**
 * Every official of a team who also plays, in bench order: [{ role, number }].
 * Two roles of one person (AC2 and the medic) may name the same number.
 * @param {Array} bench the team's bench officials
 * @param {Array} players the team's players
 */
export function playerOfficialLinks(bench, players) {
  const out = []
  for (const o of bench || []) {
    if (!o?.role) continue
    const number = officialPlaysAs(o, players)
    if (number !== null) out.push({ role: o.role, number })
  }
  return out
}

/** The number the official with `role` plays with, or null. */
export function playsAsOf(links, role) {
  return (links || []).find(l => l.role === role)?.number ?? null
}

/** The official roles the player with `number` also holds (bench order). */
export function rolesOfPlayer(links, number) {
  return (links || []).filter(l => same(l.number, number)).map(l => l.role)
}

/**
 * Is the player on court for the role rule: in the current line-up, or
 * replaced by the libero (he comes back with the rotation).
 * @param {Iterable} onCourt the numbers in the current line-up
 * @param {Iterable} [replacedByLibero] the numbers the libero replaces now
 */
export function playsOnCourt(number, onCourt = [], replacedByLibero = []) {
  for (const n of onCourt || []) if (same(n, number)) return true
  for (const n of replacedByLibero || []) if (same(n, number)) return true
  return false
}

/**
 * The official's chip on the scorer's bench list: greyed while the person is
 * on court as the player.
 * @returns {{ playsAs: number|string|null, onCourt: boolean }}
 */
export function officialChipState(links, role, { onCourt = [], replacedByLibero = [] } = {}) {
  const playsAs = playsAsOf(links, role)
  return { playsAs, onCourt: playsAs !== null && playsOnCourt(playsAs, onCourt, replacedByLibero) }
}

/**
 * The player's number on the scorer's bench row: greyed while the person is
 * there as an official (asOfficial: his first role), which a player replaced
 * by the libero is not.
 * @returns {{ roles: string[], asOfficial: string|null }}
 */
export function benchNumberState(links, number, { onCourt = [], replacedByLibero = [] } = {}) {
  const roles = rolesOfPlayer(links, number)
  const asOfficial = roles.length > 0 && !playsOnCourt(number, onCourt, replacedByLibero) ? roles[0] : null
  return { roles, asOfficial }
}

/**
 * The member a sanction menu checks (domain/sanctions memberSanctionOptions,
 * validateMemberSanction): the player with the roles he also holds, or the
 * official with the number he also plays with.
 * @param {Array} links playerOfficialLinks of the team
 * @param {{ team: string, playerNumber?: any, role?: string }} member
 */
export function sanctionMember(links, { team, playerNumber, role } = {}) {
  if (hasNumber(playerNumber)) {
    const alsoRoles = rolesOfPlayer(links, playerNumber)
    return alsoRoles.length ? { team, playerNumber, alsoRoles } : { team, playerNumber }
  }
  const plays = role ? playsAsOf(links, role) : null
  return plays !== null ? { team, role, plays } : { team, role }
}

/**
 * What a team official's sanction records besides the role: `plays`, the
 * number he plays with, while he is linked. Nothing for a player (his
 * sanction is on his number) or an official who does not play.
 * @returns {{ plays?: number|string }}
 */
export function sanctionPlays(links, { type, playerNumber, role } = {}) {
  if (type !== 'official' || hasNumber(playerNumber) || !role) return {}
  const plays = playsAsOf(links, role)
  return plays !== null ? { plays } : {}
}

/**
 * The official row with the roster editor's choice: a number (plays as),
 * false (not the same person), or '' / undefined (automatic again).
 */
export function withPlays(official, value) {
  const { plays: _old, ...rest } = official || {}
  if (value === false || value === 'none') return { ...rest, plays: false }
  if (!hasNumber(value)) return rest
  const n = Number(value)
  return { ...rest, plays: Number.isFinite(n) ? n : value }
}

/**
 * The editor's value for an official: 'none', a number as a string, or ''
 * while there is nothing to show (automatic, no player found). `auto`: the
 * number came from the automatic link.
 * @returns {{ value: string, auto: boolean }}
 */
export function playsChoice(official, players) {
  const v = playsValue(official)
  if (v === false) return { value: 'none', auto: false }
  if (v !== undefined) {
    const found = (players || []).find(p => same(p?.number, v))
    return { value: found ? String(found.number) : '', auto: false }
  }
  const auto = autoPlaysAs(official, players)
  return auto !== null ? { value: String(auto), auto: true } : { value: '', auto: false }
}

/**
 * The bench rows with a renumbered player's link moved along: an official
 * who plays as #7 plays as #17 once #7 is #17 (`renumbers`: [{ from, to }]).
 */
export function renumberPlays(bench, renumbers = []) {
  if (!renumbers?.length) return bench
  return (bench || []).map(o => {
    const v = playsValue(o)
    if (v === undefined || v === false) return o
    const r = renumbers.find(x => same(x.from, v))
    return r ? { ...o, plays: Number(r.to) } : o
  })
}
