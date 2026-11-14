// Best of 3 end to end (owner decision: some matches are best of 3, the same
// limits for every category). One best-of-3 match on every path it takes: the
// schedule row (format known or not), the cloud import, scoring to 2:1 with a
// deciding set, the bench and referee data built from the database rows (no
// relay bundle), the scorer's Sanctions and results dialog, Match End, the
// official sheet and its final result. Synthetic teams and people only.
import 'fake-indexeddb/auto'
import React from 'react'
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('../../lib/apiClient', () => ({
  apiFrom: vi.fn(() => { throw new Error('no network in this test') }),
  apiStorage: { from: vi.fn() },
  apiMatchRestoreByPin: vi.fn(),
  apiMatchScorer: vi.fn(async () => ({ data: null, error: { status: 0, network: true } })),
  writingDevice: () => ({ id: '00000000-0000-4000-8000-000000000001', platform: 'web' }),
  OV_PROTO: '2'
}))

import { db } from '../../db/db'
import { importMatchFromSupabase, cloudBestOf } from '../../utils/backupManager'
import { mapSupabaseToMatchFormat } from '../LoadOfficialMatchModal'
import { getNextSetIndex, displaySetNumber, setsToWin, previousSetIndex, resolveBestOf } from '../../utils/matchFormat'
import { getSetResult } from '../../domain/rules'
import { getMatchWinner, opensAtMatchEnd } from '../../domain/matchEnd'
import { buildLiveStateMatchData } from '../../utils/serverDataSync'
import { describeNotice } from '../../utils/refereeRecordedNotices'
import SanctionsResultsModal from '../SanctionsResultsModal'
import App from '../../../scoresheet_pdf/App_Scoresheet'
import { Results } from '../../../scoresheet_pdf/components/FooterSection'
import { consistencyWarnings } from '../../../scoresheet_pdf/utils/scoresheetModel'

const seed = 'match_1800000000000_bo3e2e01'

function cloudMatch(status, externalId = seed) {
  return {
    id: `22222222-2222-4222-8222-${externalId.slice(-12).padStart(12, '0')}`, external_id: externalId, game_n: 900301, status, test: false,
    sport_type: 'indoor',
    home_team: { name: 'Falcon Club', short_name: 'FAL' }, away_team: { name: 'Otter Club', short_name: 'OTT' },
    officials: [{ role: '1st referee', firstName: 'Rita', lastName: 'Example' }, { role: 'scorer', firstName: 'Sam', lastName: 'Sample' }],
    players_home: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, first_name: 'H', last_name: `P${n}`, is_captain: n === 1 })),
    players_away: [11, 12, 13, 14, 15, 16].map(n => ({ number: n, first_name: 'A', last_name: `Q${n}`, is_captain: n === 11 })),
    signatures: {},
    coin_toss: { team_a: 'home', team_b: 'away', serve_a: true, confirmed: true, first_serve: 'home' },
    match_info: { best_of: 3 }
  }
}

// 2:1 for home: 25:20, 18:25, and the decider (index 5) 15:13
const cloudSetsOf = (externalId) => [
  { index: 1, home_points: 25, away_points: 20 },
  { index: 2, home_points: 18, away_points: 25 },
  { index: 5, home_points: 15, away_points: 13 }
].map((s, i) => ({
  ...s, external_id: `${externalId}:s:${s.index}`, finished: true,
  start_time: `2026-11-20T18:${i}0:00Z`, end_time: `2026-11-20T18:${i}8:00Z`
}))
const cloudSets = cloudSetsOf(seed)

async function importedSheetData(status, externalId) {
  const id = await importMatchFromSupabase({ match: cloudMatch(status, externalId), sets: cloudSetsOf(externalId), events: [] })
  const match = await db.matches.get(id)
  const homeTeam = await db.teams.get(match.homeTeamId)
  const awayTeam = await db.teams.get(match.awayTeamId)
  const homePlayers = await db.players.where('teamId').equals(match.homeTeamId).toArray()
  const awayPlayers = await db.players.where('teamId').equals(match.awayTeamId).toArray()
  const sets = await db.sets.where('matchId').equals(id).sortBy('index')
  return { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events: [] }
}

const resultBoxOf = (container) => [...container.querySelectorAll('div')].find(d => d.firstChild?.textContent === 'RESULT')

describe('best of 3 end to end', () => {
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterAll(() => vi.restoreAllMocks())
  afterEach(cleanup)

  it('schedule: a known format comes through, an unknown one stays unset (Match setup asks)', () => {
    expect(mapSupabaseToMatchFormat({ game_number: 1, match_format: 3 }).bestOf).toBe(3)
    expect(mapSupabaseToMatchFormat({ game_number: 2, match_format: null }).bestOf ?? null).toBe(null)
    expect(mapSupabaseToMatchFormat({ game_number: 3 }).bestOf ?? null).toBe(null)
  })

  it('import: best_of from match_info makes the local match best of 3', async () => {
    const data = await importedSheetData('live', 'match_1800000000000_bo3live01')
    expect(cloudBestOf(cloudMatch('live'))).toBe(3)
    expect(data.match.bestOf).toBe(3)
  })

  it('scoring: after 1:1 the decider is index 5, won at 15, and the match ends 2:1', () => {
    expect(getNextSetIndex(1, 1, 0, 3)).toBe(2)
    expect(getNextSetIndex(2, 1, 1, 3)).toBe(5)
    expect(previousSetIndex(5, 3)).toBe(2)
    expect(getSetResult(14, 13, 5, { bestOf: 3, homeSetsWon: 1, awaySetsWon: 1 }).winner).toBe(null)
    const r = getSetResult(15, 13, 5, { bestOf: 3, homeSetsWon: 1, awaySetsWon: 1 })
    expect(r.winner).toBe('home')
    expect(r.isMatchEnd).toBe(true)
    const sets = cloudSets.map(s => ({ index: s.index, homePoints: s.home_points, awayPoints: s.away_points, finished: true }))
    expect(getMatchWinner(sets, 3)).toBe('home')
    expect(opensAtMatchEnd({ status: 'live', homeSetsWon: 2, awaySetsWon: 1, bestOf: 3 })).toBe(true)
  })

  it('bench and referee from the database rows: the decider is set 3 there too', () => {
    const row = { id: 'u1', external_id: seed, match_info: { best_of: 3 }, home_team: { name: 'Falcon Club' }, away_team: { name: 'Otter Club' }, coin_toss: { team_a: 'home' } }
    const live = { best_of: 3, current_set: 5, sets_won_a: 1, sets_won_b: 1, points_a: 4, points_b: 3, team_a_name: 'Falcon Club', side_a: 'left', updated_at: new Date().toISOString() }
    const data = buildLiveStateMatchData(row, live, seed)
    expect(data.match.bestOf).toBe(3)
    // bench (MatchEntry, BenchRequestPanel) and the referee read the same value
    const benchBestOf = resolveBestOf(data.match, data.liveState)
    expect(benchBestOf).toBe(3)
    expect(displaySetNumber(data.sets[0].index, benchBestOf)).toBe(3)
    expect(setsToWin(benchBestOf)).toBe(2)
    // a row without match_info: the live state's best_of still says 3
    expect(resolveBestOf({ ...data.match, bestOf: undefined, match_info: {} }, live)).toBe(3)
    // the referee's "recorded by the scorer" popup
    const sub = { type: 'substitution', setIndex: 5, seq: 40, payload: { team: 'home', playerOut: 5, playerIn: 9 } }
    const notice = describeNotice('substitution:40', sub, [sub], { match: data.match, homeTeam: data.homeTeam, awayTeam: data.awayTeam })
    expect(notice.setLabel).toBe('Set 3')
  })

  it("scorer's Sanctions and results dialog numbers the decider III, not V", () => {
    const data = {
      match: { bestOf: 3, status: 'live', coinTossTeamA: 'home' },
      homeTeam: { name: 'Falcon Club', color: '#ef4444' },
      awayTeam: { name: 'Otter Club', color: '#3b82f6' },
      sets: [
        { id: 1, index: 1, homePoints: 25, awayPoints: 20, finished: true },
        { id: 2, index: 2, homePoints: 18, awayPoints: 25, finished: true },
        { id: 3, index: 5, homePoints: 4, awayPoints: 3, finished: false, startTime: '2026-11-20T19:30:00Z' }
      ],
      events: [{ id: 9, type: 'sanction', setIndex: 5, seq: 50, payload: { team: 'home', type: 'warning', playerNumber: 4 } }]
    }
    render(<SanctionsResultsModal open onClose={() => {}} data={data} teamAKey="home" leftIsHome onSign={() => {}} />)
    const tds = [...document.querySelectorAll('td')].map((n) => n.textContent)
    expect(tds).toContain('III')
    expect(tds).not.toContain('V')
  })

  it('official sheet of the closed match loaded from the cloud: A/B, team names and the 2:1 result', async () => {
    const data = await importedSheetData('approved', 'match_1800000000000_bo3done01')
    const { container } = render(<App matchData={data} autoAction="preview" />)
    const result = resultBoxOf(container)?.textContent || ''
    expect(result).toContain('FAL')
    expect(result).toContain('OTT')
    expect(result).toContain('2:1')
    // the decider is printed as set 3, its 15:13 in the RESULT box
    const sheet = container.querySelector('.scoresheet-container')?.textContent || ''
    expect(sheet).toContain('SET3')
    expect(sheet).not.toContain('SET5')
    expect(result).toContain('15')
    expect(result).toContain('13')
    // the rosters carry their A/B circle
    const homeRoster = container.querySelector('[data-testid="roster-home"]')
    expect(homeRoster?.textContent?.startsWith('A')).toBe(true)
  })

  it('a closed match imported by an older app (no coinTossServeB) still prints A/B and the team names', async () => {
    const data = await importedSheetData('approved', 'match_1800000000000_bo3old01')
    const { coinTossServeB, ...olderCopy } = data.match
    expect(coinTossServeB).toBe(false)
    expect(olderCopy.coinTossConfirmed).toBe(true)
    const { container } = render(<App matchData={{ ...data, match: olderCopy }} autoAction="preview" />)
    const result = resultBoxOf(container)?.textContent || ''
    expect(result).toContain('FAL')
    expect(result).toContain('OTT')
    expect(container.querySelector('[data-testid="roster-home"]')?.textContent?.startsWith('A')).toBe(true)
  })

  it('a set 3 played in a match stored as best of 3 is printed, and the sheet warns', () => {
    const row = (setNumber, a, b) => ({
      setNumber, teamATimeouts: 0, teamASubstitutions: 0, teamAWon: a > b ? 1 : 0, teamAPoints: a,
      teamBTimeouts: 0, teamBSubstitutions: 0, teamBWon: b > a ? 1 : 0, teamBPoints: b, duration: "20'"
    })
    const blank = (setNumber) => ({ setNumber, teamATimeouts: null, teamASubstitutions: null, teamAWon: null, teamAPoints: null, teamBTimeouts: null, teamBSubstitutions: null, teamBWon: null, teamBPoints: null })
    const setResults = [row(1, 25, 20), row(2, 18, 25), row(3, 25, 23), blank(4), blank(5)]
    const { container } = render(<Results setResults={setResults} bestOf={3} coinTossConfirmed teamAShortName="FAL" teamBShortName="OTT" result="2:1" />)
    const cells = [...container.querySelectorAll('.text-\\[9px\\]')].map((n) => n.textContent)
    expect(cells.filter((c) => c === '23').length).toBe(1)

    const sets = [
      { index: 1, homePoints: 25, awayPoints: 20, finished: true },
      { index: 2, homePoints: 18, awayPoints: 25, finished: true },
      { index: 3, homePoints: 25, awayPoints: 23, finished: true }
    ]
    const warnings = consistencyWarnings({ sets, events: [], teamAKey: 'home', bestOf: 3 })
    expect(warnings).toContain('Set 3 recorded in a best-of-3 match.')
    expect(consistencyWarnings({ sets, events: [], teamAKey: 'home', bestOf: 5 }).some(w => /best-of-3/.test(w))).toBe(false)
  })

  it('the sheet draws a played set 3 of a best-of-3 match in its grid', () => {
    const sets = [
      { index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: '2026-11-20T18:00:00Z', endTime: '2026-11-20T18:20:00Z' },
      { index: 2, homePoints: 18, awayPoints: 25, finished: true, startTime: '2026-11-20T18:25:00Z', endTime: '2026-11-20T18:45:00Z' },
      { index: 3, homePoints: 25, awayPoints: 23, finished: true, startTime: '2026-11-20T18:50:00Z', endTime: '2026-11-20T19:15:00Z' }
    ]
    const matchData = {
      match: { id: 'm-late', status: 'ended', bestOf: 3, coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false, homeShortName: 'FAL', awayShortName: 'OTT' },
      homeTeam: { name: 'Falcon Club' }, awayTeam: { name: 'Otter Club' },
      homePlayers: [1, 2, 3, 4, 5, 6].map(n => ({ number: n, firstName: 'H', lastName: `${n}` })),
      awayPlayers: [11, 12, 13, 14, 15, 16].map(n => ({ number: n, firstName: 'A', lastName: `${n}` })),
      sets, events: []
    }
    const { container } = render(<App matchData={matchData} autoAction="preview" />)
    const text = container.querySelector('.scoresheet-container')?.textContent || ''
    const set3 = text.slice(text.indexOf('SET3'), text.indexOf('SET4'))
    expect(set3).toContain('FAL')
    expect(container.querySelector('[data-testid="sheet-warnings"]')?.textContent || '').toContain('Set 3 recorded in a best-of-3 match.')
  })
})
