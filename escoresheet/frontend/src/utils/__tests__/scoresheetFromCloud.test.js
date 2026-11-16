import { describe, it, expect } from 'vitest'
import { scoresheetDataFromCloud, rebuildSetStart } from '../scoresheetFromCloud'
import { resultKey } from '../../domain/accountApproval'
import { setTargetsOf, courtSwitchPointOf, DEFAULT_SET_TARGETS } from '../../domain/rules'

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

  it('the deciding set changes courts at 8: a server match plays the standard targets (field spec 17.14)', () => {
    // Only a Global match has its own points per set (MatchSetup writes
    // match.setTargets for match.global only). A Global match is a test
    // match: it is never queued to the server (queueMatchUpdate, test) and
    // the server neither lists nor rebuilds a test row (lib/scoresheets.js,
    // m.test IS NOT TRUE). So a rebuilt sheet never needs set targets.
    const d = scoresheetDataFromCloud(record())
    expect(d.match.setTargets).toBeUndefined()
    expect(setTargetsOf(d.match)).toEqual(DEFAULT_SET_TARGETS)
    expect(courtSwitchPointOf(setTargetsOf(d.match))).toBe(8)
  })

  it('the account approvals come along by slot (a PIN approval keeps its stamp); revoked ones and unknown slots do not', () => {
    const base = record()
    const key = resultKey([
      { index: 1, homePoints: 25, awayPoints: 20, finished: true },
      { index: 2, homePoints: 20, awayPoints: 25, finished: true }
    ])
    const scorer = { id: 'a1', short_id: 'K7Q2', slot: 'scorer', name: 'Schneider Sara', approved_at: '2026-11-15T15:52:00Z', result_key: key }
    const d = scoresheetDataFromCloud({
      ...base,
      approvals: [
        scorer,
        { id: 'a2', slot: 'referee1', name: 'Moser Claudia', approved_at: '2026-11-15T15:53:00Z', result_key: key, revoked_at: '2026-11-15T16:00:00Z' },
        { id: 'a3', slot: 'captain', name: 'X', result_key: key }
      ]
    })
    expect(d.match.accountApprovals).toEqual({ scorer })
    // none: no key at all, as a match approved by hand only
    expect(scoresheetDataFromCloud(base).match.accountApprovals).toBeNull()
  })

  describe('set starts as the scorer\'s device printed them', () => {
    const at = (hh, mm) => `2026-11-15T${hh}:${mm}:00.000Z`
    const opened = (setIndex, startTime, extra = {}) => ({ set_index: setIndex, type: 'set_start', ts: startTime, payload: { setIndex, startTime, firstRallyAt: startTime, ...extra } })

    it('an old cloud start_time (the row\'s creation: coin toss, end of the set before) gives way to the confirmed start', () => {
      const base = record()
      const d = scoresheetDataFromCloud({
        ...base,
        sets: [
          { ...base.sets[1], start_time: at('14', '00') }, // set 1 row made at the coin toss
          { ...base.sets[0], start_time: at('14', '34') } // set 2 row made when set 1 ended
        ],
        events: [...base.events, opened(1, at('14', '15')), opened(2, at('14', '37'))]
      })
      expect(d.sets.map(s => [s.index, s.startTime])).toEqual([[1, at('14', '15')], [2, at('14', '37')]])
    })

    it('a start corrected after the match (its log entry or the set_end Corrections rewrote) still wins', () => {
      const events = [
        opened(1, at('14', '15')),
        { set_index: 2, type: 'set_start', ts: at('14', '37'), payload: { startTime: at('14', '37') } },
        { set_index: 2, type: 'set_end', ts: at('14', '58'), payload: { startTime: at('14', '36'), endTime: at('14', '58') } }
      ]
      const log = [{ action: 'setTimes', setIndex: 1, after: { startTime: at('14', '12') }, text: 'Set 1 times corrected' }]
      expect(rebuildSetStart({ index: 1, start_time: at('14', '12') }, events, log)).toBe(at('14', '12'))
      expect(rebuildSetStart({ index: 2, start_time: at('14', '36') }, events, [])).toBe(at('14', '36'))
      // the same earlier time without either: taken as the creation time
      expect(rebuildSetStart({ index: 1, start_time: at('14', '12') }, events, [])).toBe(at('14', '15'))
    })

    it('a cloud start later than the confirmed one (never a creation time), the same minute, or nothing to compare with: as stored', () => {
      const events = [opened(1, at('14', '15'))]
      expect(rebuildSetStart({ index: 1, start_time: at('14', '20') }, events)).toBe(at('14', '20'))
      expect(rebuildSetStart({ index: 1, start_time: '2026-11-15T14:15:42Z' }, events)).toBe('2026-11-15T14:15:42Z')
      expect(rebuildSetStart({ index: 2, start_time: at('14', '30') }, events)).toBe(at('14', '30'))
      expect(rebuildSetStart({ index: 1, start_time: null }, events)).toBeNull()
    })
  })
})
