import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Scoreboard.jsx and MatchEnd.jsx are too large to mount for this; the
// queue's side of these jobs is tested in hooks/__tests__/useSyncQueue and
// utils/__tests__/eventSync. This pins the wiring.
const scoreboard = readFileSync(resolve(__dirname, '../Scoreboard.jsx'), 'utf8')
const matchEnd = readFileSync(resolve(__dirname, '../MatchEnd.jsx'), 'utf8')

describe('set jobs of the scoring screens', () => {
  // fe-sync-4: a bare local id carried no match key until a pass rewrote
  // it, and was dropped when the local set was gone by then
  it('never queue a set by its bare local id', () => {
    for (const src of [scoreboard, matchEnd]) {
      expect(src).not.toMatch(/external_id: String\(/)
    }
    expect(scoreboard).toContain('setUpdateJob(matchRecord, reopenSetId, { finished: false, end_time: null })')
    expect(scoreboard).toContain('setUpdateJob(matchRecord, setId, { home_points: homePoints, away_points: awayPoints, finished: true, end_time: nowIso })')
    expect(matchEnd).toContain('setUpdateJob(match, lastSet.id, { finished: false, end_time: null })')
    // a forfeit reversed: the set's score back (unfinished, or still finished
    // for a played set a default rewrote: domain/matchEnd restoredSetWrites)
    expect(matchEnd).toContain('setUpdateJob(match, r.id, restoredSetWrites(r).cloud)')
    expect(scoreboard).toContain('setUpdateJob(match, r.id, restoredSetWrites(r).cloud)')
    // a default rewrites the played sets, or sets one past the result aside
    expect(scoreboard).toContain('setUpdateJob(matchRecord, planned.id, { home_points: homePoints, away_points: awayPoints })')
    expect(scoreboard).toContain('setUpdateJob(matchRecord, planned.id, { finished: false, end_time: null })')
  })

  // fe-sync-2: a set deleted on the device stayed in the cloud; a finished
  // one counted in the result the account approval checks
  it('a set deleted on the device is deleted in the cloud too', () => {
    // a forfeit reversed (undo, Reopen set) and on Match End
    expect(scoreboard).toContain('await queueSetDeletes(db, match, plan.deleteSetIds)')
    expect(matchEnd).toContain('await queueSetDeletes(db, match, forfeitPlan.deleteSetIds)')
    // the next set of an undone set end
    expect(scoreboard).toContain('await queueSetDeletes(db, data?.match, [nextSet.id])')
    // Reopen set: the later sets
    expect(scoreboard).toContain('await queueSetDeletes(db, matchRecord, setsToDelete.map(s => s.id))')
  })

  // var-local-delete-2: jobs are found by the whole external id
  it('unsent event jobs are found by the match key and the local id together', () => {
    const calls = [...scoreboard.matchAll(/syncJobsForEvents\(([^\n]*)\)/g), ...matchEnd.matchAll(/syncJobsForEvents\(([^\n]*)\)/g)]
    // Scoreboard: discardEvents, the undone set end's next set; MatchEnd:
    // the forfeit reversal, the match_stopped event of a reopened set
    expect(calls.length).toBe(4)
    for (const call of calls) {
      expect(call[1].split(',').length, call[0]).toBe(3)
    }
  })
})
