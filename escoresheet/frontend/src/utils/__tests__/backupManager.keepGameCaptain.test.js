// A match continued on another device from the server's copy: the server's
// match row has no column for the last game captain or "Keep as game
// captain" (domain/gameCaptainKeep.js); the local row takes both from the
// designation events, so the switch is still on there.
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { localMatchRowFromCloud } from '../backupManager'

const cloud = (events) => ({
  match: { external_id: 'match_1_abc', status: 'live', home_team: { name: 'H' }, away_team: { name: 'A' } },
  events
})

describe('localMatchRowFromCloud: the kept game captain', () => {
  it('reads the switch and the player from the newest designation of each team', () => {
    const row = localMatchRowFromCloud(cloud([
      { seq: 3, set_index: 1, type: 'court_captain_designation', payload: { team: 'home', playerNumber: 8, keep: true } },
      { seq: 5, set_index: 1, type: 'court_captain_designation', payload: { team: 'away', playerNumber: 4, keep: false } }
    ]))
    expect(row).toMatchObject({ homeRememberedCourtCaptain: 8, homeKeepCourtCaptain: true, awayRememberedCourtCaptain: 4, awayKeepCourtCaptain: false })
  })

  it('adds nothing without a designation', () => {
    const row = localMatchRowFromCloud(cloud([{ seq: 1, set_index: 1, type: 'point', payload: { team: 'home' } }]))
    expect('homeKeepCourtCaptain' in row).toBe(false)
    expect('homeRememberedCourtCaptain' in row).toBe(false)
  })
})
