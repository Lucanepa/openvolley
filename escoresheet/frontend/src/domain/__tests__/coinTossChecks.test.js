import { describe, it, expect } from 'vitest'
import { coinTossConfirmIssues } from '../coinTossChecks'
import en from '../../i18n/locales/en.json'
import de from '../../i18n/locales/de.json'
import deCH from '../../i18n/locales/de-CH.json'
import fr from '../../i18n/locales/fr.json'
import it_ from '../../i18n/locales/it.json'

// The coin toss confirm's checks were English literals shown to every scorer
// ("Home team captain is not set", "Hall is not set"): they are i18n keys now.
const player = (number, over = {}) => ({ number, lastName: `P${number}`, firstName: 'X', libero: '', isCaptain: false, dob: '', ...over })
const roster = (n = 7) => Array.from({ length: n }, (_, i) => player(i + 1, { isCaptain: i === 0 }))
const coach = [{ role: 'Coach', firstName: 'C', lastName: 'Coach' }]
const ok = () => ({
  match: {
    hall: 'Halle', city: 'Zürich', league: '2L', scheduledAt: '2026-10-21T18:00:00Z',
    officials: [{ role: '1st referee', firstName: 'A', lastName: 'Ref' }, { role: 'scorer', firstName: 'S', lastName: 'Scorer' }]
  },
  home: 'VBC A', away: 'VBC B', homeRoster: roster(), awayRoster: roster(), benchHome: coach, benchAway: coach
})
const keys = (input) => coinTossConfirmIssues(input).map(i => i.key)

describe('coinTossConfirmIssues', () => {
  it('a complete match has none', () => {
    expect(coinTossConfirmIssues(ok())).toEqual([])
  })

  it('names, officials and match info', () => {
    expect(keys({ ...ok(), home: 'Home', away: '', match: {} })).toEqual([
      'validation.homeTeamNotSet', 'validation.awayTeamNotSet', 'validation.refereeNotSet', 'validation.scorerNotSet',
      'validation.hallNotSet', 'validation.cityNotSet', 'validation.leagueNotSet', 'validation.dateNotSet'
    ])
  })

  it('the rosters: too few, too many, numbers, coach, captain, duplicates, dates', () => {
    const big = roster(15)
    const away = [...roster(4), player(6, { libero: 'libero1' }), player(7, { number: '' }), player(3, { lastName: 'P1' }), player(120, { libero: 'libero2' })]
    const issues = coinTossConfirmIssues({
      ...ok(),
      homeRoster: big.map((p, i) => (i === 2 ? { ...p, dob: '01.01.1900' } : p)),
      awayRoster: away.map(p => ({ ...p, isCaptain: false })),
      benchAway: []
    })
    expect(issues).toEqual([
      { key: 'validation.tooManyPlayers', params: { team: 'home', max: 14, count: 15 } },
      { key: 'validation.needMorePlayers', params: { team: 'away', count: 5 } },
      { key: 'validation.playersWithoutNumbers', params: { team: 'away', count: 1 } },
      { key: 'validation.coachNotSet', params: { team: 'away' } },
      { key: 'validation.captainNotSet', params: { team: 'away' } },
      { key: 'validation.duplicateNumbers', params: { team: 'away', numbers: '3' } },
      { key: 'validation.duplicatePlayers', params: { team: 'away', names: 'p1 x' } },
      { key: 'validation.invalidBirthdate' },
      { key: 'validation.invalidJerseyNumbers', params: { team: 'away', numbers: '120' } }
    ])
  })

  it.each([['en', en], ['de', de], ['de-CH', deCH], ['fr', fr], ['it', it_]])('every key is in %s', (_, locale) => {
    const all = ['homeTeamNotSet', 'awayTeamNotSet', 'refereeNotSet', 'scorerNotSet', 'hallNotSet', 'cityNotSet', 'leagueNotSet', 'dateNotSet',
      'needMorePlayers', 'tooManyPlayers', 'playersWithoutNumbers', 'coachNotSet', 'captainNotSet', 'duplicateNumbers', 'duplicatePlayers',
      'invalidBirthdate', 'invalidJerseyNumbers']
    for (const k of all) expect(typeof locale.validation[k], k).toBe('string')
  })
})

describe('CoinToss confirm uses them, translated', () => {
  it('no English literal is pushed any more', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(__dirname, '../../components/CoinToss.jsx'), 'utf8')
    expect(src).toMatch(/coinTossConfirmIssues\(\{ match, home, away, homeRoster, awayRoster, benchHome, benchAway \}\)/)
    expect(src).not.toMatch(/validationErrors\.push\(/)
    for (const literal of ['Home team captain is not set', 'Hall is not set', 'duplicate jersey numbers']) expect(src).not.toContain(literal)
  })
})
