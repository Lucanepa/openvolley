// Owner, 15.11: both referee tablets in, the chip said "1 device with
// issues": a bench switched on with no tablet. The list shows the referees'
// count, the summary names the missing role.
import { describe, it, expect } from 'vitest'
import { applyRelayTablets } from '../serverDataSync'
import { getTabletStatusSummary } from '../connectionHealth'

describe('tablet chip: roles, not tablets', () => {
  it('two referee tablets count as one role with devices 2; a switched-on bench without a tablet stays not connected', () => {
    const match = { refereeConnectionEnabled: true, homeTeamConnectionEnabled: true }
    const s = applyRelayTablets(getTabletStatusSummary(match), { referee: 2, benchHome: 0, benchAway: 0 })
    expect(s.expectedCount).toBe(2)
    expect(s.connectedCount).toBe(1)
    const referee = s.roles.find(r => r.role === 'referee')
    expect(referee).toMatchObject({ status: 'connected', devices: 2 })
    expect(s.roles.find(r => r.role === 'bench_home')).toMatchObject({ status: 'disconnected', devices: 0 })
    expect(s.overallStatus).toBe('issues')
  })
})
