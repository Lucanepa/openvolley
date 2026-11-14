/**
 * The coach's and captain's pre-match signatures belong to the roster they
 * were given for (FIVB 5.1.1, 5.2.1). One rule for every roster editor before
 * the match (Match Setup's roster editor, the coin toss page's roster
 * dialog): once a team signed, a change of its players or bench officials
 * clears that team's coach and captain signatures, so the Start set gate asks
 * for them again, and a remark says so. Replacing a collected signature is an
 * explicit Re-sign, and a remark records it. Pure: no React, no Dexie.
 */
import { remarkClock } from './remarks'

const str = (v) => (v === null || v === undefined ? '' : String(v).trim())

/**
 * What a signature covers, as one comparable string: the players (number,
 * names, date of birth, libero, captain, LFP) and the named bench officials,
 * in a fixed order. Row order and empty bench rows do not count.
 * @param {Array<object>} roster
 * @param {Array<object>} bench
 */
export function rosterSignatureKey(roster, bench) {
  const players = (roster || [])
    .map(p => [str(p?.number), str(p?.lastName), str(p?.firstName), str(p?.dob), str(p?.libero), p?.isCaptain ? 'C' : '', p?.isLfp ? 'LFP' : ''].join('|'))
    .sort()
  const officials = (bench || [])
    .filter(m => str(m?.firstName) || str(m?.lastName) || str(m?.dob))
    .map(m => [str(m?.role), str(m?.lastName), str(m?.firstName), str(m?.dob)].join('|'))
    .sort()
  return JSON.stringify([players, officials])
}

/**
 * The signature fields of a team that no longer fit its roster.
 *
 * @param {{ [field: string]: string|null|undefined }} images the stored images, by match-row field
 * @param {string[]} fields the team's coach and captain fields
 * @param {{ [field: string]: string }} signedFor the roster key each field was
 *   signed for on this screen (a pad, a sent-ahead roster); a field signed
 *   before the screen opened counts as signed for `openedKey`
 * @param {string} openedKey the roster key when the editor opened
 * @param {string} currentKey the roster key being saved
 * @returns {string[]}
 */
export function staleSignatureFields(images, fields, signedFor, openedKey, currentKey) {
  return (fields || []).filter(f => images?.[f] && (signedFor?.[f] ?? openedKey) !== currentKey)
}

const ROLE_WORD = { coach: 'Coach', captain: 'Captain' }

/**
 * The remark of signatures cleared by a roster change. In English, like the
 * other automatic remarks the match writes.
 * @param {{ team: string, roles: Array<'coach'|'captain'>, at?: Date }} p
 */
export function signaturesClearedRemark({ team, roles, at = new Date() }) {
  const who = (roles || []).map(r => ROLE_WORD[r] || r).join(' and ')
  const clock = remarkClock(at)
  return `Roster of ${team || 'team'} changed after signing${clock ? ` (${clock})` : ''}: ${who} signature${roles?.length > 1 ? 's' : ''} removed, to be signed again`
}

/**
 * The remark of a collected signature replaced by Re-sign.
 * @param {{ team: string, role: 'coach'|'captain', at?: Date }} p
 */
export function signatureReplacedRemark({ team, role, at = new Date() }) {
  const clock = remarkClock(at)
  return `${ROLE_WORD[role] || role} signature of ${team || 'team'} replaced (re-signed${clock ? ` ${clock}` : ''})`
}
