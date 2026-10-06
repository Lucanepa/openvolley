import { describe, it, expect } from 'vitest'
import { settleLiveChange, liveScoreboard, livePhase, applyMatchRowChange, isLateFrame, FRAME_REORDER_WINDOW_MS } from '../livescoreModel'
import { applyLiveChange } from '../livescoreChanges'

// Frames recorded on the dev relay at the end of game 992303 (3:1, set 4 won
// 26:24 by Team A playing on the right), e2e round 3, ws-live.log.
const base = {
  match_id: 'm1',
  team_a_name: 'E2E Live Home',
  team_b_name: 'E2E Live Away',
  current_set: 4,
  matches: { set_results: [{ set: 1, home: 25, away: 4 }, { set: 2, home: 18, away: 25 }, { set: 3, home: 25, away: 21 }], coin_toss: { team_a: 'home' } }
}
const lastPoint = { match_id: 'm1', points_a: 26, points_b: 24, sets_won_a: 2, sets_won_b: 1, side_a: 'right', serving_team: 'right', match_status: 'in_progress', last_event_type: 'point', current_set: 4, set_interval_active: false, updated_at: '2026-10-06T08:31:07.202+00:00' }
// set_end push of the match-ending set: already 'ended', but with set 5's layout
const setEndFrame = { match_id: 'm1', points_a: 0, points_b: 0, sets_won_a: 3, sets_won_b: 1, side_a: 'left', serving_team: 'left', match_status: 'ended', last_event_type: 'set_end', current_set: 4, set_interval_active: true, updated_at: '2026-10-06T08:31:17.018Z' }
const matchEndFrame = { match_id: 'm1', points_a: 26, points_b: 24, sets_won_a: 3, sets_won_b: 1, side_a: 'right', serving_team: 'right', match_status: 'ended', last_event_type: 'match_end', current_set: 4, set_interval_active: false, updated_at: '2026-10-06T08:31:18.511Z' }

const update = (row) => ({ eventType: 'UPDATE', new: row })
// This page's clock, a little after the recorded frames
const NOW = Date.parse('2026-10-06T08:31:20Z')
const apply = (games, row) => {
  const settled = settleLiveChange(games, update(row), NOW)
  return settled ? applyLiveChange(games, settled) : games
}
const view = (game) => {
  const v = liveScoreboard(game)
  return `${v.leftScore} ${v.leftName} : ${v.rightScore} ${v.rightName} ${v.setResults.map(s => `${s.left}-${s.right}`).join(' ')}`
}

describe('match end on the livescore: no transient flip', () => {
  it('the set_end frame keeps the last set layout, the match_end frame changes nothing on screen', () => {
    let games = [{ ...base, ...lastPoint }]
    games = apply(games, setEndFrame)
    const afterSetEnd = view(games[0])
    expect(games[0].side_a).toBe('right')
    expect(livePhase(games[0])).toBe('final')
    // Team A (home) plays on the right: sets 1 - 3, chips from the right
    expect(afterSetEnd).toBe('1 E2E Live Away : 3 E2E Live Home 4-25 25-18 21-25')

    games = apply(games, matchEndFrame)
    expect(view(games[0])).toBe(afterSetEnd)

    // set 4 arrives through the matches row: same orientation
    games = applyMatchRowChange(games, { eventType: 'UPDATE', new: { id: 'm1', set_results: [...base.matches.set_results, { set: 4, home: 26, away: 24 }] } })
    expect(view(games[0])).toBe('1 E2E Live Away : 3 E2E Live Home 4-25 25-18 21-25 24-26')
  })

  it('a frame older than the shown row is dropped (out-of-order delivery)', () => {
    const games = [{ ...base, ...matchEndFrame }]
    expect(settleLiveChange(games, update(setEndFrame), NOW)).toBeNull()
    expect(settleLiveChange(games, update({ ...lastPoint }), NOW)).toBeNull()
  })

  it('the match_end frame itself is authoritative', () => {
    const games = [{ ...base, ...lastPoint, side_a: 'left' }]
    const settled = settleLiveChange(games, update(matchEndFrame), NOW)
    expect(settled.new.side_a).toBe('right')
  })

  it('an in-play frame and an unknown match pass unchanged; DELETE passes', () => {
    const games = [{ ...base, ...lastPoint }]
    const next = { ...lastPoint, points_a: 25, updated_at: '2026-10-06T08:31:08Z', side_a: 'left' }
    expect(settleLiveChange(games, update(next), NOW).new).toEqual(next)
    const other = { ...setEndFrame, match_id: 'm2' }
    expect(settleLiveChange(games, update(other), NOW).new).toEqual(other)
    const del = { eventType: 'DELETE', old: { match_id: 'm1' } }
    expect(settleLiveChange(games, del, NOW)).toBe(del)
  })

  it('rows without updated_at are never dropped', () => {
    const games = [{ ...base, ...lastPoint }]
    const { updated_at: _u, ...noStamp } = lastPoint
    expect(settleLiveChange(games, update(noStamp), NOW)).not.toBeNull()
  })
})

describe('frame ordering against device clocks', () => {
  const at = (ms) => new Date(ms).toISOString()
  const frame = (points, ms) => ({ ...lastPoint, points_a: points, updated_at: at(ms) })

  it('a shown row stamped 10 min in the future does not block later honest frames', () => {
    // A scorer device whose clock ran 10 min fast, then an honest device
    let games = [{ ...base, ...frame(10, NOW + 10 * 60 * 1000) }]
    for (let i = 1; i <= 3; i++) {
      const settled = settleLiveChange(games, update(frame(10 + i, NOW + i * 1000)), NOW + i * 1000)
      expect(settled).not.toBeNull()
      games = applyLiveChange(games, settled)
    }
    expect(games[0].points_a).toBe(13)
  })

  it('a scorer device whose clock is behind keeps the game moving', () => {
    let games = [{ ...base, ...frame(10, NOW) }]
    // The scorer moved to a tablet 10 min behind
    for (let i = 1; i <= 3; i++) {
      const settled = settleLiveChange(games, update(frame(10 + i, NOW - 10 * 60 * 1000 + i * 1000)), NOW + i * 1000)
      expect(settled).not.toBeNull()
      games = applyLiveChange(games, settled)
    }
    expect(games[0].points_a).toBe(13)
  })

  it('a frame with a future stamp is clamped: it blocks honest frames for seconds at most', () => {
    let games = [{ ...base, ...frame(10, NOW) }]
    games = applyLiveChange(games, settleLiveChange(games, update(frame(11, NOW + 60 * 60 * 1000)), NOW))
    // The shown row is now far ahead: the next honest frame is applied
    expect(settleLiveChange(games, update(frame(12, NOW + 1000)), NOW + 1000)).not.toBeNull()
  })

  it('isLateFrame: only a slightly older frame is late', () => {
    expect(isLateFrame(at(NOW), at(NOW - 1500), NOW)).toBe(true)
    expect(isLateFrame(at(NOW), at(NOW - FRAME_REORDER_WINDOW_MS - 1), NOW)).toBe(false)
    expect(isLateFrame(at(NOW), at(NOW), NOW)).toBe(false)
    expect(isLateFrame(at(NOW + 60_000), at(NOW), NOW)).toBe(false)
    expect(isLateFrame(undefined, at(NOW), NOW)).toBe(false)
  })
})

describe('liveScoreboard during the match', () => {
  const inSet2 = { ...base, current_set: 2, matches: { set_results: [{ set: 1, home: 25, away: 4 }], coin_toss: { team_a: 'home' } }, points_a: 7, points_b: 9, sets_won_a: 1, sets_won_b: 0, side_a: 'right', serving_team: 'left', match_status: 'in_progress' }

  it('shows the finished sets while the match is in progress', () => {
    const v = liveScoreboard(inSet2)
    expect(v.phase).toBe('play')
    expect(v.setResults).toEqual([{ set: 1, left: 4, right: 25 }])
    expect([v.leftScore, v.rightScore]).toEqual([9, 7])
    expect([v.leftSets, v.rightSets]).toEqual([0, 1])
  })

  it('a set break shows the points and a set_break phase, not the set count as the main score', () => {
    const v = liveScoreboard({ ...inSet2, points_a: 0, points_b: 0, set_interval_active: true })
    expect(v.phase).toBe('set_break')
    expect(v.isInSetInterval).toBe(true)
    expect([v.leftScore, v.rightScore]).toEqual([0, 0])
    expect(v.setResults).toHaveLength(1)
  })

  it('a running timeout is its own phase', () => {
    expect(livePhase({ ...inSet2, timeout_active: true })).toBe('timeout')
    expect(livePhase({ ...inSet2, match_status: 'timeout' })).toBe('timeout')
    expect(liveScoreboard({ ...inSet2, timeout_active: true }).isTimeout).toBe(true)
  })

  it('FINAL shows the set count as the main score', () => {
    const v = liveScoreboard({ ...base, ...matchEndFrame })
    expect(v.phase).toBe('final')
    expect([v.leftScore, v.rightScore]).toEqual([1, 3])
  })
})
