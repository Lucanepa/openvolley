import { describe, it, expect } from 'vitest'
import { benchJoinableMatches, refereeJoinableMatches } from '../relayMatchList'

const rows = [
  { id: 'real', refereeConnectionEnabled: true, homeTeamConnectionEnabled: true, status: 'live' },
  { id: 'rehearsal', test: true, refereeConnectionEnabled: true, homeTeamConnectionEnabled: true, status: 'live' }
]

describe('the pickers list rehearsal (test) matches apart', () => {
  it('referee: real games by default, test matches on the switch', () => {
    expect(refereeJoinableMatches(rows).map((m) => m.id)).toEqual(['real'])
    expect(refereeJoinableMatches(rows, Date.now(), { test: true }).map((m) => m.id)).toEqual(['rehearsal'])
  })
  it('bench: real games by default, test matches on the switch', () => {
    expect(benchJoinableMatches(rows).map((m) => m.id)).toEqual(['real'])
    expect(benchJoinableMatches(rows, Date.now(), { test: true }).map((m) => m.id)).toEqual(['rehearsal'])
  })
})
