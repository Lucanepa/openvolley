/**
 * What the coin toss confirm refuses (a test match skips it): pure, no React.
 * Each issue is an i18n key of the `validation` namespace with its params;
 * `team` is 'home' or 'away', and CoinToss puts the team's word in for it.
 */
import { ROSTER_MAX } from './playerPool'
import { isShirtNumber } from './roster'

const hasNumber = (p) => p.number != null && p.number !== ''

/** How many players of a roster (liberos too) have no shirt number yet. */
export function playersWithoutNumber(roster) {
  return (Array.isArray(roster) ? roster : []).filter(p => p && !hasNumber(p)).length
}

/**
 * The coin toss waits until every player of both teams has a shirt number,
 * a test or easy match too (the line-up and the sheet go by numbers; owner
 * 23.11.2026: "players saved anyway, but no coin toss until numbers").
 * @returns {{ key: string, params: { team: 'home'|'away', count: number } }[]}
 */
export function rosterNumberIssues({ homeRoster = [], awayRoster = [] } = {}) {
  const issues = []
  for (const [team, roster] of [['home', homeRoster], ['away', awayRoster]]) {
    const count = playersWithoutNumber(roster)
    if (count > 0) issues.push({ key: 'validation.playersWithoutNumbers', params: { team, count } })
  }
  return issues
}
// FIVB 19.1.1: two liberos at most, one per slot
const MAX_LIBEROS = 2
const LIBERO_SLOT_LABEL = { libero1: 'L1', libero2: 'L2' }

/**
 * @param {{ match?: object, home?: string, away?: string, homeRoster?: object[], awayRoster?: object[],
 *   benchHome?: object[], benchAway?: object[] }} input
 * @returns {{ key: string, params?: object }[]}
 */
export function coinTossConfirmIssues({ match = {}, home = '', away = '', homeRoster = [], awayRoster = [], benchHome = [], benchAway = [] } = {}) {
  const issues = []
  const add = (key, params) => issues.push(params ? { key, params } : { key })
  const teams = [['home', homeRoster, benchHome], ['away', awayRoster, benchAway]]

  // 1. Team names (not the default "Home" / "Away", not empty)
  if (!home || home === 'Home' || home.trim() === '') add('validation.homeTeamNotSet')
  if (!away || away === 'Away' || away.trim() === '') add('validation.awayTeamNotSet')

  // 2. The 1st referee and the scorer, with names
  const ref1 = match?.officials?.find(o => o.role === '1st referee')
  const scorer = match?.officials?.find(o => o.role === 'scorer')
  if (!ref1?.lastName || !ref1?.firstName) add('validation.refereeNotSet')
  if (!scorer?.lastName || !scorer?.firstName) add('validation.scorerNotSet')

  // 3. Match info (hall, city, league, date)
  if (!match?.hall || match.hall.trim() === '') add('validation.hallNotSet')
  if (!match?.city || match.city.trim() === '') add('validation.cityNotSet')
  if (!match?.league || match.league.trim() === '') add('validation.leagueNotSet')
  if (!match?.scheduledAt) add('validation.dateNotSet')

  for (const [team, roster] of teams) {
    // 4. At least 6 non-libero players with numbers
    const playing = roster.filter(p => !p.libero && hasNumber(p))
    if (playing.length < 6) add('validation.needMorePlayers', { team, count: playing.length })
    // 4a. At most 14 players on the scoresheet (FIVB 4.1.1)
    if (roster.length > ROSTER_MAX) add('validation.tooManyPlayers', { team, max: ROSTER_MAX, count: roster.length })
    // 4b. Every player (liberos too) has a number
    const noNumber = roster.filter(p => !hasNumber(p))
    if (noNumber.length > 0) add('validation.playersWithoutNumbers', { team, count: noNumber.length })
    // 4c. At most two liberos, each libero slot once
    const liberos = roster.filter(p => p.libero)
    if (liberos.length > MAX_LIBEROS) add('validation.tooManyLiberos', { team, count: liberos.length })
    for (const [slot, label] of Object.entries(LIBERO_SLOT_LABEL)) {
      if (liberos.filter(p => p.libero === slot).length > 1) add('validation.liberoSlotTwice', { team, slot: label })
    }
  }

  for (const [team, roster, bench] of teams) {
    // 5. A coach
    if (!bench.find(b => b.role === 'Coach' && (b.lastName || b.firstName))) add('validation.coachNotSet', { team })
    // 6. A captain, only one
    const captains = roster.filter(p => p.isCaptain).length
    if (!captains) add('validation.captainNotSet', { team })
    else if (captains > 1) add('validation.tooManyCaptains', { team, count: captains })
  }

  for (const [team, roster] of teams) {
    // 7. Duplicate shirt numbers (7 and '7' are one number)
    const numbers = roster.filter(hasNumber).map(p => Number(p.number)).filter(Number.isFinite)
    const dupNumbers = [...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))]
    if (dupNumbers.length > 0) add('validation.duplicateNumbers', { team, numbers: dupNumbers.join(', ') })
  }
  for (const [team, roster] of teams) {
    // 8. Duplicate players (same last and first name)
    const names = roster.map(p => `${(p.lastName || '').toLowerCase()} ${(p.firstName || '').toLowerCase()}`.trim())
    const dupNames = [...new Set(names.filter((n, i) => n && names.indexOf(n) !== i))]
    if (dupNames.length > 0) add('validation.duplicatePlayers', { team, names: dupNames.join(', ') })
  }

  // 9. (gone) A date of birth 01.01.1900, the placeholder of an unknown date,
  // no longer holds the coin toss: the roster editor notes the 1 January
  // dates (owner 2026-11-15: "in the roster only, not at coin toss";
  // domain/januaryFirstDob)

  for (const [team, roster] of teams) {
    // 10. Shirt numbers: whole numbers 1-99
    const invalid = roster.filter(p => hasNumber(p) && !isShirtNumber(p.number))
    if (invalid.length > 0) add('validation.invalidJerseyNumbers', { team, numbers: invalid.map(p => p.number).join(', ') })
  }
  return issues
}
