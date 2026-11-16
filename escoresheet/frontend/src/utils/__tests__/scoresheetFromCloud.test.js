import { describe, it, expect } from 'vitest'
import { scoresheetDataFromCloud } from '../scoresheetFromCloud'

// The server's record of a closed match (GET /api/scoresheets/:id/match) as
// the sheet takes it, with nothing written to this device (Rebuild PDF)
const record = () => ({
  match: {
    id: '7f9c0d1e-0000-4000-8000-000000000001',
    external_id: 'match_1_abc',
    game_n: 424849,
    status: 'final',
    closed_at: '2026-11-15T15:50:00Z',
    scheduled_at: '2026-11-15T14:00:00Z',
    match_info: { league: 'SM-Quali-U23' },
    home_team: { name: 'Home Club', short_name: 'HOME' },
    away_team: { name: 'Away Club', short_name: 'AWAY' },
    players_home: [{ number: 7, first_name: 'Ana', last_name: 'Muster', dob: '2007-01-02', is_captain: true, is_lfp: true }],
    players_away: [{ number: 4, first_name: 'Ben', last_name: 'Beispiel', dob: '2006-05-06', libero: 'libero1' }],
    coin_toss: { team_a: 'home', team_b: 'away', serve_a: true, confirmed: true },
    signatures: { home_captain: 'data:image/png;base64,AAA', scorer: 'data:image/png;base64,BBB' },
    manual_changes: [{ afterMatch: true, text: 'Set 1 times corrected' }],
    remarks: 'Late start'
  },
  sets: [
    { external_id: 'match_1_abc:s:2', index: 2, home_points: 20, away_points: 25, finished: true, start_time: '2026-11-15T14:37:00Z', end_time: '2026-11-15T14:58:00Z' },
    { external_id: 'match_1_abc:s:1', index: 1, home_points: 25, away_points: 20, finished: true, start_time: '2026-11-15T14:15:00Z', end_time: '2026-11-15T14:34:00Z' }
  ],
  events: [
    { external_id: 'match_1_abc:e:1', set_index: 1, type: 'lineup', seq: 1, ts: '2026-11-15T14:14:00Z', payload: { team: 'home', lineup: { I: 7 }, isInitial: true } },
    { external_id: 'match_1_abc:e:2', set_index: 1, type: 'point', seq: 2, ts: '2026-11-15T14:15:30Z', payload: { team: 'home' } }
  ],
  liveState: null
})

describe('scoresheetDataFromCloud', () => {
  it('the match, teams, rosters, sets and events as the sheet reads them', () => {
    const d = scoresheetDataFromCloud(record())
    expect(d.match.gameN).toBe(424849)
    expect(d.match.coinTossTeamA).toBe('home')
    expect(d.match.remarks).toBe('Late start')
    // the stored signatures stay on the sheet
    expect(d.match.homeCaptainSignature).toBe('data:image/png;base64,AAA')
    // the "Corrected after the match" remarks come with the match
    expect(d.match.manualChanges).toEqual([{ afterMatch: true, text: 'Set 1 times corrected' }])
    expect(d.homeTeam).toMatchObject({ id: d.match.homeTeamId, name: 'Home Club', shortName: 'HOME' })
    expect(d.awayTeam).toMatchObject({ id: d.match.awayTeamId, name: 'Away Club' })
    expect(d.homePlayers).toEqual([expect.objectContaining({ teamId: d.homeTeam.id, number: 7, firstName: 'Ana', lastName: 'Muster', isCaptain: true, isLfp: true })])
    expect(d.awayPlayers[0]).toMatchObject({ teamId: d.awayTeam.id, number: 4, libero: 'libero1', isLfp: false })
    // sets by index, the confirmed start times as stored
    expect(d.sets.map(s => [s.index, s.startTime])).toEqual([[1, '2026-11-15T14:15:00Z'], [2, '2026-11-15T14:37:00Z']])
    expect(d.sets.every(s => s.matchId === d.match.id)).toBe(true)
    expect(d.events.filter(e => e.externalId).map(e => [e.type, e.setIndex, e.seq])).toEqual([['lineup', 1, 1], ['point', 1, 2]])
    expect(d.events.every(e => e.matchId === d.match.id)).toBe(true)
  })

  it('a match without teams or rows still gives a sheet input (nothing thrown)', () => {
    const d = scoresheetDataFromCloud({ match: { id: 'x', status: 'final' }, sets: [], events: [] })
    expect(d.homeTeam).toBeNull()
    expect(d.homePlayers).toEqual([])
    expect(d.sets).toEqual([])
  })
})
