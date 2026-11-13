import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { relayMatchPayload, relayTeamPayload, relayPeoplePayload, relayRemarks } from '../serverDataSync'
import { relayEvents } from '../relayPublisher'

// What the scorer sends in sync-match-data: no relay subscriber is ever given
// a date of birth, a signature, the officials or the approvals
// (backend/lib/publicColumns.js), so they never leave the device.
const SEED = 'match_1791215210058_privcy'
const SIG = 'data:image/png;base64,iVBORw0KGgo'

describe('the relay payload carries no personal data the tablets never get', () => {
  it('relayMatchPayload drops the officials, signatures, approvals, manual changes and pending rosters', () => {
    const match = {
      id: 1, seed_key: SEED, status: 'live',
      officials: [{ role: '1st referee', firstName: 'Rita', lastName: 'Referee', dob: '01.02.1980', email: 'ref@example.org' }],
      signatures: { homeCoach: SIG },
      homeCoachSignature: SIG,
      awayCaptainSignature: SIG,
      remarksSignatures: [{ role: 'captain', signature: SIG }],
      approval: { approved: true },
      accountApprovals: { referee1: { id: 'acc-1', name: 'Rita Referee', at: '2026-11-12T10:00:00.000Z' } },
      manualChanges: [{ field: 'score' }],
      pendingHomeRoster: { players: [{ number: 3, dob: '01.01.2012' }] },
      pendingAwayRoster: null,
      bench_home: [{ role: 'Coach', firstName: 'Cora', lastName: 'Coach', dob: '02.01.1980', email: 'c@example.org' }],
      players_home: [{ number: 7, lastName: 'Player', dob: '03.05.2011', country: 'SUI' }],
      homeCourtCaptain: 7
    }
    const before = JSON.stringify(match)
    const { match: out } = relayMatchPayload(match, null, { now: 1 })
    expect(JSON.stringify(match)).toBe(before)
    for (const k of ['officials', 'signatures', 'homeCoachSignature', 'awayCaptainSignature', 'remarksSignatures', 'approval',
      'accountApprovals', 'manualChanges', 'pendingHomeRoster', 'pendingAwayRoster']) {
      expect(out, k).not.toHaveProperty(k)
    }
    expect(out.bench_home).toEqual([{ role: 'Coach', firstName: 'Cora', lastName: 'Coach' }])
    expect(out.players_home).toEqual([{ number: 7, lastName: 'Player' }])
    expect(out).toMatchObject({ id: 1, seed_key: SEED, status: 'live', homeCourtCaptain: 7 })
    const text = JSON.stringify(out)
    for (const s of ['1980', '2011', '2012', 'Rita', 'example.org', 'base64']) expect(text, s).not.toContain(s)
  })

  it('keeps the remarks (the referee\'s live scoresheet prints them) without the values of a date-of-birth correction', () => {
    const remarks = 'Roster change after coin toss (Home VC, Set 2, 14:02):\n- Player #7 dob: 03.05.2011 → 04.06.2011 (Home VC)\n- Bench official Coach dob: (none) → 02.01.1980 (Home VC)\nSet 2, 14:05, A 3:1, #4 injured (bench)'
    const { match } = relayMatchPayload({ id: 1, seed_key: SEED, remarks }, null)
    expect(match.remarks).toBe('Roster change after coin toss (Home VC, Set 2, 14:02):\n- Player #7 date of birth changed (Home VC)\n- Bench official Coach date of birth changed (Home VC)\nSet 2, 14:05, A 3:1, #4 injured (bench)')
    expect(relayRemarks('- Player #7 number: 7 → 8 (Home VC)')).toBe('- Player #7 number: 7 → 8 (Home VC)')
    expect(relayRemarks(undefined)).toBeUndefined()
  })

  // Audit 2026-11: the Remarks dialog logs a 'remark' event with the lines it
  // added and the whole remarks text, which carried an older scorer's
  // date-of-birth correction to the relay
  it('the remark text on the events goes without dates of birth, the whole remarks text not at all', () => {
    const fullRemarks = 'Roster change after coin toss (Home VC, Set 1, 14:01):\n- Player #7 dob: 03.05.2011 → 04.06.2011 (Home VC)\nSet 1, 14:05, #4 injured (bench)'
    const snap = { pointsA: 1 }
    const events = [
      { id: 1, setIndex: 1, type: 'remark', payload: { text: '- Player #7 dob: 03.05.2011 → 04.06.2011 (Home VC)', fullRemarks } },
      { id: 2, setIndex: 1, type: 'remark', payload: { text: 'Set 1, 14:05, #4 injured (bench)', fullRemarks: 'Set 1, 14:05, #4 injured (bench)' }, stateSnapshot: snap },
      { id: 3, setIndex: 1, type: 'substitution', payload: { team: 'home', autoRemark: '- Player #7 dob: 1.1.2011 -> 2.1.2011 (Home VC)' } },
      { id: 4, setIndex: 1, type: 'point', payload: { team: 'home', text: 'dob: kept → on other events' } }
    ]
    const before = JSON.stringify(events)
    expect(relayEvents(events)).toEqual([
      { id: 1, setIndex: 1, type: 'remark', payload: { text: '- Player #7 date of birth changed (Home VC)' } },
      { id: 2, setIndex: 1, type: 'remark', payload: { text: 'Set 1, 14:05, #4 injured (bench)' } },
      { id: 3, setIndex: 1, type: 'substitution', payload: { team: 'home', autoRemark: '- Player #7 date of birth changed (Home VC)' } },
      events[3]
    ])
    expect(JSON.stringify(events)).toBe(before)
  })

  // Audit 2026-11: a backtracking pattern took seconds on a long line of "dob: "
  it('relayRemarks takes time in proportion to the text', () => {
    for (const text of ['dob: '.repeat(80000), 'dob: x -> '.repeat(40000) + ' (T)', '- Player #7 dob: 03.05.2011 → 04.06.2011 (Home VC)\n'.repeat(8000)]) {
      const start = performance.now()
      relayRemarks(text)
      expect(performance.now() - start, `${text.length} characters`).toBeLessThan(100)
    }
    expect(relayRemarks('a\n- Player #7 dob: 1 -> 2 (Home VC)\r\nb dob: 3 → 4')).toBe('a\n- Player #7 date of birth changed (Home VC)\r\nb date of birth changed')
    expect(relayRemarks('- Player #7 dob: 3 May 2011 → (none) (Home (U18))')).toBe('- Player #7 date of birth changed')
  })

  it('a team row goes as its names and colours, a player without date of birth or contact data', () => {
    const team = {
      id: 3, name: 'Home VC', shortName: 'HOME', color: '#e2001a', seedKey: 'team-home', createdAt: '2026-11-01',
      benchStaff: [{ role: 'Coach', firstName: 'Cora', lastName: 'Coach', dob: '02.01.1980' }],
      benchOfficials: [{ role: 'Coach', firstName: 'Cora', lastName: 'Coach', dob: '02.01.1980' }]
    }
    expect(relayTeamPayload(team)).toEqual({ name: 'Home VC', shortName: 'HOME', color: '#e2001a' })
    expect(relayTeamPayload(null)).toBeNull()
    expect(relayTeamPayload(undefined)).toBeNull()
    const players = [{ id: 1, teamId: 3, number: 7, firstName: 'Ana', lastName: 'Player', dob: '03.05.2011', country: 'SUI', isCaptain: true, libero: '' }]
    expect(relayPeoplePayload(players)).toEqual([{ id: 1, teamId: 3, number: 7, firstName: 'Ana', lastName: 'Player', isCaptain: true, libero: '' }])
    expect(players[0].dob).toBe('03.05.2011')
    expect(relayPeoplePayload(null)).toEqual([])
  })
})

// Scoreboard cannot be mounted in a unit test: what it sends and writes is pinned
describe('the Scoreboard\'s sync and remarks', () => {
  const src = readFileSync(resolve(__dirname, '../../components/Scoreboard.jsx'), 'utf8')

  it('sends team rows and rosters the way the relay may hand them on', () => {
    const start = src.indexOf("type: 'sync-match-data',")
    const payload = src.slice(start, src.indexOf('}', start))
    expect(payload).toMatch(/homeTeam: relayTeamPayload\(freshHomeTeam\),/)
    expect(payload).toMatch(/awayTeam: relayTeamPayload\(freshAwayTeam\),/)
    expect(payload).toMatch(/homePlayers: relayPeoplePayload\(freshHomePlayers\),/)
    expect(payload).toMatch(/awayPlayers: relayPeoplePayload\(freshAwayPlayers\),/)
  })

  // Audit 2026-11: a LAN relay that finds no bundle asks the scorer
  // (match-data-request) and keeps the answer as the room's bundle: the
  // Scoreboard answered with whole team rows, dates of birth and the undo
  // snapshots
  it('answers a match-data-request the same way', () => {
    const start = src.indexOf('const handleMatchDataRequest = async (request) => {')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf("console.error('[WebSocket] Error handling match data request:'", start))
    // the answer's bundle (readRelayBundle, also the match-update-response's)
    expect(body.slice(body.indexOf('success: true,'))).toContain('data: await readRelayBundle(freshMatch, syncMark)')
    const helper = src.indexOf('const readRelayBundle = async (freshMatch, syncMark) => {')
    expect(helper).toBeGreaterThan(-1)
    const answer = src.slice(helper, src.indexOf('const handleMatchDataRequest', helper))
    for (const k of ['homeTeam: relayTeamPayload(freshHomeTeam),', 'awayTeam: relayTeamPayload(freshAwayTeam),',
      'homePlayers: relayPeoplePayload(freshHomePlayers),', 'awayPlayers: relayPeoplePayload(freshAwayPlayers),',
      'events: relayEvents(freshEvents || [])']) expect(answer).toContain(k)
    expect(answer).not.toMatch(/freshHomeTeam \|\| null|freshEvents \|\| \[\]\n/)
    // the answer for a match another device scores now stays
    expect(body).toMatch(/error: freshMatch \? 'Match scored on another device' : 'Match not found in database'/)
  })

  it('an in-match roster edit notes a corrected date of birth in the remarks without the dates', () => {
    const start = src.indexOf('const diffRosters = useCallback(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n  }, [])', start))
    expect(body).toMatch(/f\.key === 'dob' \? `Player #\$\{orig\.number\} date of birth changed \(\$\{teamLabel\}\)` : desc/)
    expect(body).toMatch(/f === 'dob' \? `Bench official \$\{orig\.role \|\| edit\.role\} date of birth changed \(\$\{teamLabel\}\)` : desc/)
    // every remark line is one of these: none writes the values of a dob change
    expect(body.match(/remarkLines\.push\(/g)).toHaveLength(6)
  })
})
