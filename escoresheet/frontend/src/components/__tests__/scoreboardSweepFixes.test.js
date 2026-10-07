// @vitest-environment node
/**
 * Scoring bugs found by the atomic-actions sweep. The rules are decided by
 * tested domain helpers; Scoreboard.jsx is too large to mount, so this pins
 * that the handlers use them.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sb = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const between = (from, to) => {
  const start = sb.indexOf(from)
  expect(start).toBeGreaterThan(-1)
  const end = sb.indexOf(to, start + from.length)
  expect(end).toBeGreaterThan(start)
  return sb.slice(start, end)
}

describe('expelled or disqualified libero on court', () => {
  const branch = () => between('// Libero on court expelled/disqualified - return replaced player to court', 'return // Exit early, don\'t do the regular substitution flow')

  it('puts back the player the libero replaced (playerReplacedByLibero), not a libero_entry playerNumber', () => {
    const body = branch()
    expect(body).toMatch(/const originalPlayerNumber = playerReplacedByLibero\(data\.events, team, data\.set\.index, playerNumber\)/)
    expect(body).not.toMatch(/lastEntry\?\.payload\?\.playerNumber/)
    // the libero_exit and its lineup sub-event are still written with it
    expect(body.indexOf("logEvent('libero_exit'")).toBeGreaterThan(body.indexOf('playerReplacedByLibero('))
    expect(body).toMatch(/currentLineup\[position\] = String\(originalPlayerNumber\)/)
  })
})

describe('cancelling the set-5 change of courts (FIVB 18.2.2-18.2.3)', () => {
  const body = () => between('const cancelCourtSwitch = useCallback(', '// Check if match is already finished')

  it('takes back the point that reached 8 with its sub-events, like Undo, not the newest event row', () => {
    const b = body()
    expect(b).toMatch(/planPointRemoval\(allEvents, null, \{ setIndex: modal\.set\.index, includeRallyStart: true \}\)/)
    expect(b).toMatch(/await discardEvents\(/)
    expect(b).toMatch(/await resyncSetScoreFromEvents\(plan\.setIndex\)/)
    // no more "delete whatever has the highest seq" (after a side-out that was
    // the rotation sub-event, and the point stayed)
    expect(b).not.toMatch(/db\.events\.delete\(lastEvent\.id\)/)
    expect(b).not.toMatch(/sortedEvents\[0\]/)
  })

  it('the referee tablets and the livescore hear about it', () => {
    const b = body()
    expect(b).toMatch(/syncToReferee\(\)/)
    expect(b).toMatch(/syncLiveStateToSupabase\('undo'/)
  })
})

describe('penalty points deferred until both line-ups are in (FIVB 16.2.3 / 21.3.1)', () => {
  const save = () => between('// Save lineup as an event (mark as initial lineup or manual override)', '// Auto-close modal after successful save (skip confirmation step)')

  it('the check sees the line-up just saved, not only the events read before it', () => {
    const b = save()
    expect(b).toMatch(/const savedLineupEvent = \{/)
    expect(b).toMatch(/deferredPenaltyPoints\(\[\.\.\.allEvents, savedLineupEvent\], setIndex\)/)
    expect(b.indexOf('const manualLineupEventId = await db.events.add(savedLineupEvent)'))
      .toBeLessThan(b.indexOf('deferredPenaltyPoints('))
  })

  it('the awarded points and the new score are queued for the cloud', () => {
    const b = save()
    expect(b).toMatch(/const penaltyPointId = await db\.events\.add\(/)
    expect(b).toMatch(/await queueEventSync\(db, penaltyPointId\)/)
    expect(b).toMatch(/await queueSetScoreSync\(db, \{ matchId, setIndex \}\)/)
  })
})

describe('replaying the rally of a point (decision change "replay")', () => {
  const body = () => between('const handleReplayRally = useCallback(', 'const cancelReplayRally = useCallback(')

  it('removes the point and its sub-events through discardEvents, so their queued cloud jobs go too', () => {
    const b = body()
    expect(b).toMatch(/const plan = planPointRemoval\(allEvents, lastEvent\)/)
    expect(b).toMatch(/await discardEvents\(/)
    // no raw deletes that leave the point's sync_queue job (and an automatic
    // libero_exit's) behind for the server
    expect(b).not.toMatch(/db\.events\.delete\(/)
  })

  it('the set score follows the remaining points and is queued for the cloud', () => {
    const b = body()
    expect(b).toMatch(/homePoints: plan\.score\.homePoints/)
    expect(b).toMatch(/awayPoints: plan\.score\.awayPoints/)
    expect(b).toMatch(/queueSetScoreSync\(db, \{ matchId, setIndex: plan\.setIndex \}\)/)
    expect(b.indexOf('queueSetScoreSync(')).toBeGreaterThan(b.indexOf('await discardEvents('))
  })

  it('the referee tablets are told as well', () => {
    expect(body()).toMatch(/syncToReferee\(\)/)
  })
})
