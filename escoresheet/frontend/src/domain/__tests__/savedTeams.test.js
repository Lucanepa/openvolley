import { describe, it, expect } from 'vitest'
import {
  savedTeamToRoster,
  rosterToSavedRoster,
  findSavedTeamSuggestions,
  validateSavedRoster,
  isoToDisplayDob,
  displayDobToIso,
  rosterHasContent,
  normalizeName,
  SPORTS,
  sportOf,
  bundleForSport,
  beachSeasonOptions
} from '../savedTeams'
import { beachSavedTeamsBundle, mixedSavedTeamsBundle } from './fixtures/beachSavedTeamsBundle'

const player = (over = {}) => ({
  id: over.id ?? null, number: 1, first_name: 'Anna', last_name: 'Muster', dob: '2001-03-04',
  license_number: null, is_libero: false, is_captain: false, active: true, sort_order: 0, ...over
})

describe('DOB conversion', () => {
  it('goes both ways', () => {
    expect(isoToDisplayDob('2001-03-04')).toBe('04.03.2001')
    expect(isoToDisplayDob(null)).toBe('')
    expect(isoToDisplayDob('junk')).toBe('')
    expect(displayDobToIso('4.3.2001')).toBe('2001-03-04')
    expect(displayDobToIso('04/03/2001')).toBe('2001-03-04')
    expect(displayDobToIso('2001-03-04')).toBe('2001-03-04')
    expect(displayDobToIso('')).toBeNull()
    expect(displayDobToIso('March 2001')).toBeNull()
  })
})

describe('savedTeamToRoster', () => {
  it('maps players in sort order and skips inactive ones', () => {
    const { roster } = savedTeamToRoster({
      name: 'VBC',
      players: [
        player({ number: 7, last_name: 'B', sort_order: 1 }),
        player({ number: 3, last_name: 'A', sort_order: 0 }),
        player({ number: 9, last_name: 'Gone', active: false, sort_order: 2 })
      ]
    })
    expect(roster.map(p => p.lastName)).toEqual(['A', 'B'])
    expect(roster[0]).toEqual({ number: 3, firstName: 'Anna', lastName: 'A', dob: '04.03.2001', libero: '', isCaptain: false, isLfp: false })
  })

  it.each([
    [0, [], false],
    [1, ['libero1'], false],
    [2, ['libero1', 'libero2'], false],
    [3, ['libero1', 'libero2', ''], true]
  ])('marks %i liberos', (count, expected, warns) => {
    const players = Array.from({ length: count }, (_, i) => player({ number: 10 + i, last_name: `L${i}`, is_libero: true, sort_order: i }))
    const { roster, warnings } = savedTeamToRoster({ name: 'VBC', players })
    expect(roster.map(p => p.libero)).toEqual(expected)
    expect(warnings.some(w => w.key === 'savedTeams.tooManyLiberos')).toBe(warns)
  })

  it('keeps only one captain', () => {
    const { roster } = savedTeamToRoster({
      players: [player({ number: 1, is_captain: true }), player({ number: 2, last_name: 'X', is_captain: true, sort_order: 1 })]
    })
    expect(roster.filter(p => p.isCaptain)).toHaveLength(1)
    expect(roster[0].isCaptain).toBe(true)
  })

  it('maps staff to the bench and always has a coach', () => {
    const none = savedTeamToRoster({ players: [], staff: [] })
    expect(none.bench).toEqual([{ role: 'Coach', firstName: '', lastName: '', dob: '' }])
    const some = savedTeamToRoster({
      staff: [{ role: 'Physiotherapist', first_name: 'P', last_name: 'Q', dob: null, sort_order: 0 }, { role: 'Bogus', last_name: 'Z' }]
    })
    expect(some.bench).toEqual([
      { role: 'Coach', firstName: '', lastName: '', dob: '' },
      { role: 'Physiotherapist', firstName: 'P', lastName: 'Q', dob: '' }
    ])
  })

  it('reads the meta from both team shapes', () => {
    expect(savedTeamToRoster({ name: 'A', short_name: 'AA', color: '#112233' }).meta).toEqual({ name: 'A', shortName: 'AA', color: '#112233' })
    expect(savedTeamToRoster({ name: 'B', shortName: 'BB', color: null }).meta).toEqual({ name: 'B', shortName: 'BB', color: '' })
  })
})

describe('rosterToSavedRoster', () => {
  const existing = {
    players: [
      player({ id: 'p1', number: 5, last_name: 'Muster', license_number: 'L-5' }),
      player({ id: 'p2', number: 8, last_name: 'Old', active: false, license_number: 'L-8' })
    ],
    staff: [{ id: 's1', role: 'Coach', first_name: 'C', last_name: 'Trainer', license_number: 'T-1' }]
  }

  it('keeps ids and licence numbers by number + last name, and saved inactive players', () => {
    const body = rosterToSavedRoster(
      [
        { number: '5', firstName: 'Anna', lastName: 'MUSTER', dob: '04.03.2001', libero: 'libero1', isCaptain: true },
        { number: 6, firstName: 'New', lastName: 'Player', dob: '', libero: '', isCaptain: false },
        { number: null, firstName: '', lastName: '', dob: '' }
      ],
      [{ role: 'Coach', firstName: 'C', lastName: 'trainer', dob: '' }, { role: 'Medic', firstName: '', lastName: '', dob: '' }],
      existing
    )
    expect(body.players).toEqual([
      { id: 'p1', number: 5, first_name: 'Anna', last_name: 'MUSTER', dob: '2001-03-04', license_number: 'L-5', is_libero: true, is_captain: true, active: true },
      { number: 6, first_name: 'New', last_name: 'Player', dob: null, license_number: null, is_libero: false, is_captain: false, active: true },
      { id: 'p2', number: 8, first_name: 'Anna', last_name: 'Old', dob: '2001-03-04', license_number: 'L-8', is_libero: false, is_captain: false, active: false }
    ])
    expect(body.staff).toEqual([{ id: 's1', role: 'Coach', first_name: 'C', last_name: 'trainer', dob: null, license_number: 'T-1' }])
  })

  it('does not reuse an id when the number changed', () => {
    const body = rosterToSavedRoster([{ number: 6, firstName: 'A', lastName: 'Muster' }], [], existing)
    expect(body.players[0].id).toBeUndefined()
    expect(body.players[0].license_number).toBeNull()
  })

  it('works without an existing team', () => {
    expect(rosterToSavedRoster([], [], null)).toEqual({ players: [], staff: [] })
  })
})

describe('validateSavedRoster', () => {
  it('flags missing names, duplicate numbers and two captains among active players', () => {
    const errors = validateSavedRoster({
      players: [
        { number: 1, last_name: 'A', is_captain: true, active: true },
        { number: 1, last_name: '', is_captain: true, active: true },
        { number: 1, last_name: 'C', is_captain: true, active: false }
      ],
      staff: [{ role: 'Coach', last_name: '' }]
    })
    expect(errors.map(e => `${e.list}:${e.index}:${e.key}`)).toEqual([
      'players:1:savedTeams.errors.lastNameRequired',
      'players:1:savedTeams.errors.duplicateNumber',
      'players:1:savedTeams.errors.twoCaptains',
      'staff:0:savedTeams.errors.lastNameRequired'
    ])
    expect(validateSavedRoster({ players: [{ number: 1, last_name: 'A' }, { number: null, last_name: 'B' }, { number: null, last_name: 'C' }] })).toEqual([])
  })
})

describe('findSavedTeamSuggestions', () => {
  const comp = (id, over = {}) => ({ id, name: id, season: '2026/27', vmLeagues: [], archived: false, ...over })
  const team = (id, name, competition, over = {}) => ({ id, name, svrzTeamName: '', competition, competitionId: competition.id, updatedAt: '2026-09-01T00:00:00Z', ...over })

  it('matches the svrz team name or the name, normalised', () => {
    const c = comp('c1')
    const teams = [team('t1', 'Wiedikon', c, { svrzTeamName: 'KSC  Wiedikon H1' }), team('t2', 'Uni Bern', c)]
    expect(findSavedTeamSuggestions(teams, { home: ' ksc wiedikon h1', away: 'UNI BERN' })).toEqual({ home: teams[0], away: teams[1] })
    expect(findSavedTeamSuggestions(teams, { home: 'Nobody', away: '' })).toEqual({ home: null, away: null })
  })

  it('excludes archived competitions', () => {
    const teams = [team('t1', 'A', comp('c1', { archived: true }))]
    expect(findSavedTeamSuggestions(teams, { home: 'A' }).home).toBeNull()
  })

  it('ranks the league first, then the season, then the newest', () => {
    const league = comp('league', { vmLeagues: ['1. Liga Herren'], season: '2025/26' })
    const season = comp('season', { season: '2026/27' })
    const other = comp('other', { season: '2024/25' })
    const tLeague = team('a', 'A', league, { updatedAt: '2020-01-01T00:00:00Z' })
    const tSeason = team('b', 'A', season, { updatedAt: '2021-01-01T00:00:00Z' })
    const tNew = team('c', 'A', other, { updatedAt: '2026-10-01T00:00:00Z' })
    const at = '2026-10-10T16:00:00Z'
    expect(findSavedTeamSuggestions([tNew, tSeason, tLeague], { home: 'A', league: '1. liga herren', scheduledAt: at }).home).toBe(tLeague)
    expect(findSavedTeamSuggestions([tNew, tSeason], { home: 'A', league: 'x', scheduledAt: at }).home).toBe(tSeason)
    expect(findSavedTeamSuggestions([tSeason, tNew], { home: 'A', scheduledAt: null }).home).toBe(tNew)
  })

  it('works with API teams plus a competitions list', () => {
    const competitions = [{ id: 'c1', season: '2026/27', vm_leagues: ['L'], archived: false }]
    const apiTeam = { id: 't', name: 'X', svrz_team_name: 'X H1', competition_id: 'c1', updated_at: '2026-01-01' }
    expect(findSavedTeamSuggestions([apiTeam], { home: 'x h1', competitions }).home).toBe(apiTeam)
  })
})

describe('helpers', () => {
  it('rosterHasContent and normalizeName', () => {
    expect(rosterHasContent([], [{ role: 'Coach', firstName: '', lastName: '' }])).toBe(false)
    expect(rosterHasContent([{ number: 4 }], [])).toBe(true)
    expect(rosterHasContent([], [{ role: 'Coach', lastName: 'X' }])).toBe(true)
    expect(normalizeName('  A   b ')).toBe('a b')
  })
})

describe('beach saved teams (docs/beach-saved-teams-spec.md 3.2)', () => {
  it('sportOf: beach only when it says so', () => {
    expect(sportOf({ sport: 'beach' })).toBe('beach')
    expect(sportOf({ sport: 'indoor' })).toBe('indoor')
    expect(sportOf({})).toBe('indoor')
    expect(sportOf(null)).toBe('indoor')
    expect(sportOf({ competition: { sport: 'beach' } }.competition)).toBe('beach')
    expect(SPORTS).toEqual(['indoor', 'beach'])
  })

  it('bundleForSport keeps the competitions of a sport and their teams', () => {
    const mixed = mixedSavedTeamsBundle()
    const beach = bundleForSport(mixed, 'beach')
    expect(beach.sport).toBe('beach')
    expect(beach.version).toBe(mixed.version)
    expect(beach.fetched_at).toBe(mixed.fetched_at)
    expect(beach.competitions.map(c => c.name)).toEqual(['Coop Beachtour', 'Old tour'])
    expect(beach.teams.map(t => t.name)).toEqual(['Müller / Weber', 'Rossi'])
    const indoor = bundleForSport(mixed, 'indoor')
    expect(indoor.competitions.map(c => c.name)).toEqual(['2. Liga Damen'])
    expect(indoor.teams.map(t => t.name)).toEqual(['VBC Test'])
    expect(mixed.competitions).toHaveLength(3) // the input is not changed
    // a 2.1.0 bundle (no sport anywhere) is all indoor
    const old = bundleForSport({ version: '1', competitions: [{ id: 'c' }], teams: [{ id: 't', competition_id: 'c' }] }, 'indoor')
    expect(old.teams).toHaveLength(1)
    expect(bundleForSport(beachSavedTeamsBundle(), 'indoor').teams).toEqual([])
    expect(bundleForSport(null, 'indoor')).toMatchObject({ competitions: [], teams: [] })
  })

  it('beachSeasonOptions uses the Zurich calendar year', () => {
    expect(beachSeasonOptions(new Date('2026-12-31T23:30:00Z'))).toEqual(['2026', '2027', '2028'])
    expect(beachSeasonOptions(new Date('2026-06-15T12:00:00Z'))).toEqual(['2025', '2026', '2027'])
  })

  it('validateSavedRoster beach: last name, country, at most 2 players and 1 coach', () => {
    const bp = (over = {}) => ({ number: 1, first_name: 'A', last_name: 'Müller', dob: null, license_number: null, country: null, ...over })
    expect(validateSavedRoster({ players: [bp(), bp({ number: 2, country: 'ita' })], staff: [{ role: 'Coach', last_name: 'K' }] }, { sport: 'beach' })).toEqual([])
    expect(validateSavedRoster({ players: [bp({ last_name: ' ' })], staff: [] }, { sport: 'beach' }))
      .toEqual([{ index: 0, list: 'players', key: 'savedTeams.errors.lastNameRequired' }])
    expect(validateSavedRoster({ players: [bp(), bp({ number: 2, country: 'CH' })], staff: [] }, { sport: 'beach' }))
      .toEqual([{ index: 1, list: 'players', key: 'savedTeams.errors.countryFormat' }])
    expect(validateSavedRoster({ players: [bp(), bp(), bp()], staff: [] }, { sport: 'beach' })[0]).toMatchObject({ list: 'players', key: 'manage.errors.generic' })
    expect(validateSavedRoster({ players: [], staff: [{ role: 'Coach', last_name: 'A' }, { role: 'Coach', last_name: 'B' }] }, { sport: 'beach' })[0])
      .toMatchObject({ list: 'staff', key: 'manage.errors.generic' })
    expect(validateSavedRoster({ players: [], staff: [{ role: 'Coach', last_name: '' }] }, { sport: 'beach' }))
      .toEqual([{ index: 0, list: 'staff', key: 'savedTeams.errors.lastNameRequired' }])
    // indoor is unchanged (a duplicate number is still an error there)
    expect(validateSavedRoster({ players: [bp(), bp()], staff: [] }).map(e => e.key)).toEqual(['savedTeams.errors.duplicateNumber'])
  })
})
