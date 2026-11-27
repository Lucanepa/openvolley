import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { flightValue, dateChunks, fetchGames, __setActionId } from '../lib/gameCenter.js'
import { gameCenterGameToRow, prepareGameCenterRows, gameCenterRegionsFromEnv } from '../lib/vmSync.js'

// The Swiss Volley Game Center as the schedule's source (VM_GAME_CENTER_REGIONS).
// Shapes are the live ones (svrz.ch, checked 27.11.2026); teams, halls and
// referees are invented.

export const gcGame = (over = {}) => ({
  gameId: 999001,
  playDate: '2026-10-06 20:30:00',
  playDateUtc: '2026-10-06T18:30:00Z',
  gender: 'f',
  status: 2,
  teams: { home: { teamId: 1, caption: 'Test Home D2', clubId: 10 }, away: { teamId: 2, caption: 'Test Away D1', clubId: 20 } },
  league: { leagueId: 7125, caption: '3L', season: 2026 },
  phase: { phaseId: 1, caption: 'Vor- & Rückrunde' },
  group: { groupId: 1, caption: 'Frauen 3. Liga Gruppe B' },
  hall: { hallId: 1, caption: 'Test Hall', street: 'Teststrasse', number: '32', zip: 8006, city: 'Zürich', latitude: 47.3, longitude: 8.5, plusCode: '8FVC0000+00' },
  referees: { 1: { refereeId: 512345, firstName: 'Anna', lastName: 'Test' }, 2: { refereeId: 623456, firstName: 'Ben', lastName: 'Beispiel' } },
  setResults: {},
  ...over
})
export const flight = (value) => `0:["$@1",["build",null]]\n1:${JSON.stringify(value)}\n`

describe('VM_GAME_CENTER_REGIONS', () => {
  it('reads region codes, upper-cased and once each', () => {
    assert.deepEqual(gameCenterRegionsFromEnv({ VM_GAME_CENTER_REGIONS: 'svrz, SV svrz' }), ['SVRZ', 'SV'])
    assert.deepEqual(gameCenterRegionsFromEnv({}), [])
  })
  it('refuses something that is no region code', () => {
    assert.throws(() => gameCenterRegionsFromEnv({ VM_GAME_CENTER_REGIONS: 'https://x' }), /not a region code/)
  })
})

describe('a Game Center game as a svrz_games row', () => {
  it('fills what the login search filled: referees with their SV numbers, group letter, street number', () => {
    const r = gameCenterGameToRow(gcGame())
    assert.equal(r.game_number, '999001')
    assert.equal(r.datetime, '2026-10-06T18:30:00.000000+00:00', 'VolleyManager\'s own shape')
    assert.equal(r.date, '06/10/2026')
    assert.equal(r.time, '20:30')
    assert.equal(r.league, '3L B')
    assert.equal(r.league_category, '3L')
    assert.equal(r.gender, 'women')
    assert.equal(r.match_level, 'senior')
    assert.equal(r.match_type, 'championship')
    assert.equal(r.championship_type, 'regional')
    assert.equal(r.team_home, 'Test Home D2')
    assert.equal(r.hall, 'Test Hall')
    assert.equal(r.hall_address, 'Teststrasse 32')
    assert.equal(r.hall_postal_code, '8006')
    assert.equal(r.city, 'Zürich')
    assert.deepEqual([r.referee_1, r.referee_1_first_name, r.referee_1_last_name, r.referee_1_licence], ['Anna Test', 'Anna', 'Test', '512345'])
    assert.equal(r.referee_2_licence, '623456')
    assert.deepEqual(r.convocations, ['Anna Test', 'Ben Beispiel'])
    assert.equal(r.linesman_1, '')
    assert.equal(r.is_supervised, false)
  })
  it('no number of win sets in the list: no format (the run keeps the stored one)', () => {
    assert.equal(gameCenterGameToRow(gcGame()).match_format, null)
    assert.equal(gameCenterGameToRow(gcGame({ league: { caption: '2L', numberOfWinSets: 'three_win_sets' } })).match_format, 5)
  })
  it('1L names its groups with the bare letter; national; youth and cups are told apart', () => {
    const l1 = gameCenterGameToRow(gcGame({ league: { caption: '1L' }, group: { caption: 'D' }, gender: 'm' }))
    assert.equal(l1.league, '1L D')
    assert.equal(l1.championship_type, 'national')
    assert.equal(gameCenterGameToRow(gcGame({ league: { caption: 'U23' }, group: { caption: 'Frauen U23 2. Stärkeklasse' } })).match_level, 'junior')
    assert.equal(gameCenterGameToRow(gcGame({ league: { caption: 'Züri Cup' }, group: { caption: 'Runde 3, Spiel 3' } })).match_type, 'cup')
  })
  it('a game without referees yet has empty places and no licence', () => {
    const r = gameCenterGameToRow(gcGame({ referees: {} }))
    assert.deepEqual([r.referee_1, r.referee_1_licence, r.referee_2_licence], ['', null, null])
    assert.deepEqual(r.convocations, [])
  })
})

describe('preparing a Game Center answer', () => {
  it('drops NL, keeps one row per game, and says which leagues and teams it covers', () => {
    const p = prepareGameCenterRows([
      gcGame(), gcGame(), // the same game twice (two regions)
      gcGame({ gameId: 2, league: { caption: 'NLA' }, group: { caption: 'Qualifikation' } })
    ])
    assert.equal(p.rows.length, 1)
    assert.equal(p.excluded, 1)
    assert.deepEqual(p.excludedLeagues, ['NLA'])
    assert.ok(p.numbers.has('2'), 'a game it returns is not cancelled, NL included')
    assert.deepEqual([...p.covered.get('women|3L')].sort(), ['Test Away D1', 'Test Home D2'])
  })
})

describe('Game Center client', () => {
  beforeEach(() => __setActionId('games', 'a'.repeat(40)))

  it('reads line 1 of a flight answer', () => {
    assert.deepEqual(flightValue(flight([1])), [1])
    assert.equal(flightValue('<html>'), undefined)
  })
  it('windows of a month, dateEnd exclusive', () => {
    assert.deepEqual(dateChunks('2026-10-04', '2026-10-19'), [['2026-10-04', '2026-10-20']])
    assert.equal(dateChunks('2026-10-01', '2027-01-31').length, 4)
  })
  it('asks each region over the window, one game per number', async () => {
    const asked = []
    const fake = async (_url, init) => { asked.push(JSON.parse(init.body)[0]); return new Response(flight([gcGame()])) }
    const games = await fetchGames([{ region: 'SVRZ' }, { region: 'SV' }], '2026-10-04', '2026-10-19', fake)
    assert.equal(games.length, 1)
    assert.deepEqual(asked, ['?region=SVRZ&includeCup=1&dateStart=2026-10-04&dateEnd=2026-10-20', '?region=SV&includeCup=1&dateStart=2026-10-04&dateEnd=2026-10-20'])
  })
  it('a failed call throws, so a partial schedule is never read as complete', async () => {
    const fake = async (_url, init) => init?.method === 'POST' ? new Response('', { status: 503 }) : new Response('<html></html>')
    await assert.rejects(fetchGames([{ region: 'SVRZ' }], '2026-10-04', '2026-10-19', fake))
  })
  it('finds the action again after svrz.ch redeploys', async () => {
    const NEW = 'c'.repeat(40)
    const OTHER = 'd'.repeat(40)
    const fake = async (url, init) => {
      if (init?.method === 'POST') {
        const id = init.headers['Next-Action']
        if (id === NEW) return new Response(flight([gcGame()]))
        if (id === OTHER) return new Response(flight([]))
        return new Response('', { status: 404 })
      }
      if (String(url).endsWith('/game-center')) return new Response('<script src="/_next/static/chunks/854-x.js"></script>')
      return new Response(`var c=(0,l.$)("${OTHER}"),d=(0,l.$)("${NEW}");`)
    }
    assert.equal((await fetchGames([{ region: 'SVRZ' }], '2026-10-04', '2026-10-19', fake)).length, 1)
  })
})
