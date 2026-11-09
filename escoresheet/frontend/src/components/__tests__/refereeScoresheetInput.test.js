import { describe, it, expect } from 'vitest'
import { scoresheetInputFromBundle, bundleHasFullAccess } from '../referee/scoresheetInput.js'
import { readRelayBundle } from '../../utils/serverDataSync'

// The referee's live scoresheet is built from the relay bundle the tablet
// holds, in the shape ScoresheetApp builds from the scorer's IndexedDB
// ({ match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events, sanctions }).

const ev = (seq, type, setIndex, payload = {}) => ({ id: seq, seq, type, setIndex, payload })

function fullBundle(over = {}) {
  return {
    access: 'full',
    match: { id: 7, seed_key: 'match_1_abc', status: 'live', coinTossTeamA: 'home', coinTossServeA: true, homeShortName: 'MUS', awayShortName: 'BEI', remarks: 'Ball changed', bench_home: [{ role: 'Coach', lastName: 'Muster' }] },
    homeTeam: { name: 'VBC Musterdorf', color: '#ef4444' },
    awayTeam: { name: 'Volley Beispiel', color: '#3b82f6' },
    homePlayers: [{ number: 9, lastName: 'Neun' }, { number: 1, lastName: 'Eins', isCaptain: true }],
    awayPlayers: [{ number: 4, lastName: 'Vier', libero: 'libero1' }],
    sets: [
      { index: 2, homePoints: 3, awayPoints: 2, finished: false, startTime: '2026-11-09T19:31:00Z' },
      { index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: '2026-11-09T19:00:00Z', endTime: '2026-11-09T19:25:00Z' }
    ],
    events: [
      ev(3, 'point', 2, { team: 'home' }),
      ev(1, 'point', 1, { team: 'home' }),
      ev(2.5, 'lineup', 2, { team: 'home', lineup: { I: 1 } }),
      ev(2, 'set_end', 1, {}),
      ev(4, 'point', 2, { team: 'away' }),
      ev(5, 'timeout', 2, { team: 'away' })
    ],
    liveState: { points_a: 3, points_b: 2 },
    ...over
  }
}

describe('scoresheetInputFromBundle', () => {
  it('only from a full bundle: a summary, a bundle without access, or nothing gives no sheet', () => {
    expect(scoresheetInputFromBundle(null)).toBeNull()
    expect(scoresheetInputFromBundle(undefined)).toBeNull()
    expect(scoresheetInputFromBundle({ ...fullBundle(), access: 'summary' })).toBeNull()
    const { access, ...noAccess } = fullBundle()
    expect(access).toBe('full')
    expect(scoresheetInputFromBundle(noAccess)).toBeNull()
    expect(scoresheetInputFromBundle({ access: 'full', match: null })).toBeNull()
    expect(bundleHasFullAccess(fullBundle())).toBe(true)
  })

  it('has the shape ScoresheetApp gives the viewer, the match passed as it is', () => {
    const b = fullBundle()
    const input = scoresheetInputFromBundle(b)
    expect(Object.keys(input).sort()).toEqual(['awayPlayers', 'awayTeam', 'events', 'homePlayers', 'homeTeam', 'match', 'sanctions', 'sets'])
    expect(input.match).toBe(b.match)
    expect(input.match.remarks).toBe('Ball changed')
    expect(input.homeTeam).toBe(b.homeTeam)
    expect(input.homePlayers).toEqual(b.homePlayers)
    expect(input.awayPlayers[0].libero).toBe('libero1')
    expect(input.sanctions).toEqual([])
  })

  it('sets by index and events by seq (sub-events in place), as read from IndexedDB', () => {
    const input = scoresheetInputFromBundle(fullBundle())
    expect(input.sets.map(s => s.index)).toEqual([1, 2])
    expect(input.events.map(e => e.seq)).toEqual([1, 2, 2.5, 3, 4, 5])
    // the bundle itself is not changed
    expect(fullBundle().events[0].seq).toBe(3)
  })

  it('keeps events without seq after the rest, in the order received', () => {
    const input = scoresheetInputFromBundle(fullBundle({ events: [{ type: 'point', setIndex: 1, payload: { team: 'home' } }, ev(2, 'point', 1, { team: 'away' }), { type: 'note', setIndex: 1 }] }))
    expect(input.events.map(e => e.seq ?? e.type)).toEqual([2, 'point', 'note'])
  })

  it('a running set takes its score from its points (a newer live state laid over the bundle runs ahead of its events)', () => {
    // the tablet laid a live state's 4:2 over set 2; the bundle holds the points of 1:1
    const input = scoresheetInputFromBundle(fullBundle({ sets: [{ index: 2, homePoints: 4, awayPoints: 2, finished: false }] }))
    expect(input.sets[0]).toMatchObject({ index: 2, homePoints: 1, awayPoints: 1 })
    // finished sets stay as recorded
    const done = scoresheetInputFromBundle(fullBundle({ sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }] }))
    expect(done.sets[0]).toMatchObject({ homePoints: 25, awayPoints: 20 })
    // a set with no points yet keeps its 0:0
    const fresh = scoresheetInputFromBundle(fullBundle({ sets: [{ index: 3, homePoints: 0, awayPoints: 0, finished: false }] }))
    expect(fresh.sets[0]).toMatchObject({ homePoints: 0, awayPoints: 0 })
  })

  it('a team sent as a plain name becomes { name }; missing lists become empty', () => {
    const input = scoresheetInputFromBundle(fullBundle({ homeTeam: 'VBC Musterdorf', awayTeam: null, homePlayers: null, events: undefined, sets: 'x' }))
    expect(input.homeTeam).toEqual({ name: 'VBC Musterdorf' })
    expect(input.awayTeam).toBeNull()
    expect(input.homePlayers).toEqual([])
    expect(input.events).toEqual([])
    expect(input.sets).toEqual([])
  })

  it('works on the bundle as the tablet reads it off the relay socket (readRelayBundle keeps the access mark)', () => {
    const message = { type: 'match-full-data', matchId: 'match_1_abc', ...fullBundle(), _timestamp: 1 }
    const read = readRelayBundle(message)
    expect(read.access).toBe('full')
    expect(scoresheetInputFromBundle(read).events).toHaveLength(6)
    expect(readRelayBundle({ ...message, access: 'summary' }).access).toBe('summary')
    const { access, ...old } = message
    expect(access).toBe('full')
    expect(readRelayBundle(old).access).toBeUndefined()
  })
})
