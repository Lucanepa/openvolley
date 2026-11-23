// The set break (audit round 3 LOG-21): the set end's push names the next set
// (current_set) while its snapshot is still the finished set's. It zeroed the
// substitution count but sent the finished set's time-outs, so the board said
// "Set 3" with the two time-outs used in set 2 for the whole break.
import { describe, it, expect } from 'vitest'
import { liveSetCounters } from '../livePublicFields'
import { boardScoreFromRow } from '../../utils/boardFeed'

const sub = (playerIn, playerOut) => ({ playerIn, playerOut })
const snapshotOfSet2 = { currentSetIndex: 2, teamAKey: 'home', timeoutsA: 2, timeoutsB: 1, subsA: [sub(4, 9)], subsB: [] }

describe('liveSetCounters', () => {
  it('in the set: its time-outs and substitutions', () => {
    expect(liveSetCounters({ snapshot: snapshotOfSet2, pushedSetIndex: 2 })).toEqual({ timeouts_a: 2, timeouts_b: 1, subs_a: [sub(4, 9)], subs_b: null })
  })

  it('the set end\'s push naming the next set: none yet', () => {
    expect(liveSetCounters({ snapshot: snapshotOfSet2, pushedSetIndex: 3 })).toEqual({ timeouts_a: 0, timeouts_b: 0, subs_a: null, subs_b: null })
    // a best-of-3 at 1-1 goes from set 2 to set 5
    expect(liveSetCounters({ snapshot: snapshotOfSet2, pushedSetIndex: 5 }).timeouts_a).toBe(0)
  })
})

describe('the board in a set break', () => {
  const row = (over = {}) => ({
    current_set: 3, best_of: 5, match_status: 'interval', set_interval_active: true, team_a_name: 'Home VC', team_b_name: 'Away VC',
    sets_won_a: 1, sets_won_b: 1, points_a: 0, points_b: 0, side_a: 'left', serving_team: 'left', timeouts_a: 2, timeouts_b: 1, subs_count_a: 0, subs_count_b: 0, ...over
  })
  it('shows no time-out taken in the coming set, also from an older scorer app\'s push', () => {
    const v = boardScoreFromRow(row())
    expect(v.phase).toBe('set_break')
    expect(v.setNumber).toBe(3)
    expect([v.left.timeoutsUsed, v.right.timeoutsUsed]).toEqual([0, 0])
  })
  it('in play the row\'s time-outs as before', () => {
    const v = boardScoreFromRow(row({ match_status: 'in_progress', set_interval_active: false }))
    expect([v.left.timeoutsUsed, v.right.timeoutsUsed]).toEqual([2, 1])
  })
})
