import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseLeagueCalendar, parseCalendarName, parseTeams, unfoldIcal } from '../lib/vmIcal.js'
import { icalGameToRow, icalFeedsFromEnv, mergeWithStored } from '../lib/vmSync.js'

// a real VolleyManager league calendar (Rookie 2 men, SVRZ), made with an Italian account
const ROOKIE2 = readFileSync(new URL('./fixtures/vm-ical-rookie2.ics', import.meta.url), 'utf8')

describe('parseLeagueCalendar (VolleyManager league calendar)', () => {
  it('reads the real calendar: league, gender, every game, teams, hall and address', () => {
    const { calendar, games, skipped } = parseLeagueCalendar(ROOKIE2)
    assert.deepEqual(calendar, { id: '7351', league: 'Rookie 2', gender: 'men', region: 'SVRZ' })
    assert.equal(games.length, 14)
    assert.equal(skipped, 0)
    assert.deepEqual(games[0], {
      game_number: '422684',
      start: { ymd: '2026-09-12', hour: 9, minute: 0, tz: 'Europe/Zurich' },
      team_home: 'VC Tornado Adliswil Rookie HU14',
      team_away: 'VC Tornado Adliswil Rookie HU14-2',
      hall: 'Sporthalle Ruebisbach Feld 1-3',
      street: 'Talacherstrasse', postalCode: '8302', city: 'Kloten'
    })
    assert.equal(new Set(games.map((g) => g.game_number)).size, 14)
  })

  it('does not depend on the account\'s language (labels are never read)', () => {
    const german = ROOKIE2.replaceAll('Risultato', 'Resultat').replaceAll('Lega', 'Liga').replaceAll('Palestra', 'Halle').replaceAll('Indirizzo', 'Adresse')
    assert.deepEqual(parseLeagueCalendar(german).games, parseLeagueCalendar(ROOKIE2).games)
  })

  it('unfolds continuation lines and reads a UTC start', () => {
    assert.deepEqual(unfoldIcal('A:1\r\n 23\r\nB:x\n\tyz\n'), ['A:123', 'B:xyz'])
    const ics = 'BEGIN:VCALENDAR\nX-WR-CALNAME:#1 | 3L | ♀ (SVRZ)\nBEGIN:VEVENT\nUID:game-5\nDTSTART:20261006T183000Z\nSUMMARY:A - B (3L)\nEND:VEVENT\nEND:VCALENDAR'
    const { games } = parseLeagueCalendar(ics)
    assert.deepEqual(games[0].start, { ymd: '2026-10-06', hour: 18, minute: 30, tz: 'UTC' })
    assert.deepEqual([games[0].team_home, games[0].team_away], ['A', 'B'], 'the summary when the description has no teams')
  })

  it('skips events without a game number or start, and names without a league', () => {
    const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:other-1\nDTSTART:20261006T183000Z\nEND:VEVENT\nBEGIN:VEVENT\nUID:game-7\nEND:VEVENT\nEND:VCALENDAR'
    const r = parseLeagueCalendar(ics)
    assert.equal(r.games.length, 0)
    assert.equal(r.skipped, 2)
    assert.equal(parseCalendarName('Just a name').gender, '')
    assert.deepEqual(parseTeams('#1 | d | Home Club — Away - Club', ''), { home: 'Home Club', away: 'Away - Club' }, 'the em dash, not the hyphen inside a name')
  })
})

describe('icalGameToRow', () => {
  it('a svrz_games row in the login sync\'s formats, without referees', () => {
    const { calendar, games } = parseLeagueCalendar(ROOKIE2)
    const row = icalGameToRow(games[0], calendar, { syncedAt: new Date('2026-11-27T08:00:00Z') })
    assert.equal(row.datetime, '2026-09-12T07:00:00.000000+00:00')
    assert.equal(row.date, '12/09/2026')
    assert.equal(row.time, '09:00')
    assert.equal(row.match_level, 'junior', 'Rookie is a youth league')
    assert.equal(row.junior_category, true)
    assert.equal(row.gender, 'men')
    assert.equal(row.league, 'Rookie 2')
    assert.equal(row.match_type, 'championship')
    assert.equal(row.championship_type, 'regional')
    assert.equal(row.match_format, null)
    for (const k of ['referee_1', 'referee_1_licence', 'referee_2', 'linesman_1', 'linesman_2']) assert.equal(row[k], null, k)
    assert.deepEqual(row.convocations, [])
  })

  it('cup, senior and national leagues', () => {
    const g = { game_number: '1', start: { ymd: '2026-10-06', hour: 20, minute: 0, tz: 'Europe/Zurich' }, team_home: 'A', team_away: 'B', hall: '', street: '', postalCode: '', city: '' }
    assert.equal(icalGameToRow(g, { league: 'Züri Cup', gender: 'women' }).match_type, 'cup')
    assert.equal(icalGameToRow(g, { league: 'SVRZ Meisterschaft 1', gender: 'men' }).match_level, 'senior')
    assert.equal(icalGameToRow(g, { league: 'U20 Ligamodus', gender: 'men' }).match_level, 'junior')
    assert.equal(icalGameToRow(g, { league: '1L D', gender: 'men' }).championship_type, 'national')
  })
})

describe('mergeWithStored', () => {
  const row = (n, league, home, away, extra = {}) => ({ game_number: n, league, gender: 'women', team_home: home, team_away: away, hall_address: 'Gloriastrasse', match_format: null, group_display: '', phase_name: '', league_category: league, ...extra })
  it('keeps a stored group letter, the street number and the format; a new game takes its team\'s group', () => {
    const stored = [
      { game_number: '1', league: '3L B', gender: 'women', team_home: 'X D2', team_away: 'Y', hall_address: 'Gloriastrasse 32', match_format: 5, group_display: 'Gruppe B', phase_name: '', league_category: '' }
    ]
    const [known, fresh, other] = mergeWithStored([row('1', '3L', 'X D2', 'Y'), row('2', '3L', 'Z', 'X D2'), row('3', '3L', 'P', 'Q')], stored)
    assert.equal(known.league, '3L B')
    assert.equal(known.hall_address, 'Gloriastrasse 32')
    assert.equal(known.match_format, 5)
    assert.equal(known.group_display, 'Gruppe B')
    assert.equal(known.league_category, '3L', 'an empty stored category does not blank the calendar\'s')
    assert.equal(fresh.league, '3L B')
    assert.equal(fresh.match_format, 5)
    assert.equal(other.league, '3L', 'no group known: the calendar\'s league')
  })
  it('a different street or league is the calendar\'s, and "Rookie 2" is no group', () => {
    const stored = [{ game_number: '1', league: 'Rookie 2', gender: 'women', team_home: 'A', team_away: 'B', hall_address: 'Elsewhere 1', match_format: null, group_display: '', phase_name: '', league_category: '' }]
    const [r] = mergeWithStored([row('1', 'Rookie 2', 'A', 'B')], stored)
    assert.equal(r.league, 'Rookie 2')
    assert.equal(r.hall_address, 'Gloriastrasse')
    assert.equal(r.match_format, null)
  })
})

describe('icalFeedsFromEnv', () => {
  const T = '6cb9a637ce4e5ef754b016d30144047b8966e4b0'
  it('tokens, webcal:// and https:// links, de-duplicated; empty -> []', () => {
    assert.deepEqual(icalFeedsFromEnv({}), [])
    assert.deepEqual(icalFeedsFromEnv({ VM_ICAL_FEEDS: `${T}\nwebcal://volleymanager.volleyball.ch/iCal/schedule/${T}, https://volleymanager.volleyball.ch/iCal/schedule/${T}` }),
      [`https://volleymanager.volleyball.ch/iCal/schedule/${T}`])
  })
  it('refuses anything that is not a VolleyManager league calendar', () => {
    assert.throws(() => icalFeedsFromEnv({ VM_ICAL_FEEDS: 'https://evil.example/iCal/schedule/x' }), /not a VolleyManager league calendar/)
    assert.throws(() => icalFeedsFromEnv({ VM_ICAL_FEEDS: 'volleymanager.volleyball.ch/login' }), /not a VolleyManager league calendar/)
  })
})
