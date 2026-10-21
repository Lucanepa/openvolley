/**
 * What the coin toss confirm refuses (a test match skips it): pure, no React.
 * Each issue is an i18n key of the `validation` namespace with its params;
 * `team` is 'home' or 'away', and CoinToss puts the team's word in for it.
 */
import { ROSTER_MAX } from './playerPool'

const hasNumber = (p) => p.number != null && p.number !== ''

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
  }

  for (const [team, roster, bench] of teams) {
    // 5. A coach
    if (!bench.find(b => b.role === 'Coach' && (b.lastName || b.firstName))) add('validation.coachNotSet', { team })
    // 6. A captain
    if (!roster.find(p => p.isCaptain)) add('validation.captainNotSet', { team })
  }

  for (const [team, roster] of teams) {
    // 7. Duplicate shirt numbers
    const numbers = roster.filter(hasNumber).map(p => p.number)
    const dupNumbers = [...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))]
    if (dupNumbers.length > 0) add('validation.duplicateNumbers', { team, numbers: dupNumbers.join(', ') })
  }
  for (const [team, roster] of teams) {
    // 8. Duplicate players (same last and first name)
    const names = roster.map(p => `${(p.lastName || '').toLowerCase()} ${(p.firstName || '').toLowerCase()}`.trim())
    const dupNames = [...new Set(names.filter((n, i) => n && names.indexOf(n) !== i))]
    if (dupNames.length > 0) add('validation.duplicatePlayers', { team, names: dupNames.join(', ') })
  }

  // 9. No date of birth 01.01.1900 (a placeholder / import error)
  const badDate = (x) => x.dob === '01.01.1900' || x.dob === '01/01/1900'
  if ([...homeRoster, ...awayRoster].some(badDate) || [...benchHome, ...benchAway].some(badDate)) add('validation.invalidBirthdate')

  for (const [team, roster] of teams) {
    // 10. Shirt numbers 1-99
    const invalid = roster.filter(p => hasNumber(p) && (p.number < 1 || p.number > 99))
    if (invalid.length > 0) add('validation.invalidJerseyNumbers', { team, numbers: invalid.map(p => p.number).join(', ') })
  }
  return issues
}
