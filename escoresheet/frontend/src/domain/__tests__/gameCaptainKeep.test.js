// "Keep as game captain" (owner 2026-11-22): what the switch stores, who is
// designated without the dialog, what Undo puts back and what a match
// continued from the server's copy reads back.
import { describe, it, expect } from 'vitest'
import {
  keepCourtCaptainField, keepsGameCaptain, keptGameCaptain, automaticGameCaptain,
  chosenGameCaptain, automaticDesignation, keepFieldsFromEvents
} from '../gameCaptainKeep'

describe('the kept game captain', () => {
  it('is the remembered one while the switch is on, per team', () => {
    const match = { homeKeepCourtCaptain: true, homeRememberedCourtCaptain: 8, awayRememberedCourtCaptain: 4 }
    expect(keepCourtCaptainField('home')).toBe('homeKeepCourtCaptain')
    expect(keepCourtCaptainField('away')).toBe('awayKeepCourtCaptain')
    expect(keepsGameCaptain(match, 'home')).toBe(true)
    expect(keptGameCaptain(match, 'home')).toBe(8)
    // the away switch is off: the remembered one is only proposed
    expect(keepsGameCaptain(match, 'away')).toBe(false)
    expect(keptGameCaptain(match, 'away')).toBeNull()
    // on, but nobody remembered
    expect(keptGameCaptain({ homeKeepCourtCaptain: true }, 'home')).toBeNull()
    expect(keptGameCaptain(null, 'home')).toBeNull()
  })

  it('is designated without asking only when he is on court (a libero included)', () => {
    const match = { awayKeepCourtCaptain: true, awayRememberedCourtCaptain: '12' }
    expect(automaticGameCaptain({ match, team: 'away', playersOnCourt: [2, 3, 4, 5, 6, 12] })).toBe('12')
    expect(automaticGameCaptain({ match, team: 'away', playersOnCourt: ['2', '3', '4', '5', '6', '7'] })).toBeNull()
    expect(automaticGameCaptain({ match: { ...match, awayKeepCourtCaptain: false }, team: 'away', playersOnCourt: [12] })).toBeNull()
  })
})

describe('the game captain chosen in the dialog', () => {
  it('sets the game captain, the remembered one and the switch; the event keeps what they were', () => {
    const { matchUpdate, payload } = chosenGameCaptain({ match: { homeCourtCaptain: 5, homeRememberedCourtCaptain: 5 }, team: 'home', playerNumber: '8', keep: true })
    expect(matchUpdate).toEqual({ homeCourtCaptain: '8', homeRememberedCourtCaptain: '8', homeKeepCourtCaptain: true })
    expect(payload).toEqual({ team: 'home', playerNumber: '8', previousCourtCaptain: 5, keep: true, previousRememberedCourtCaptain: 5, previousKeepCourtCaptain: false })
  })

  it('records only what changes: the same remembered player, the switch as it was', () => {
    const { payload } = chosenGameCaptain({ match: { awayRememberedCourtCaptain: 8, awayKeepCourtCaptain: true }, team: 'away', playerNumber: 8, keep: true })
    expect(payload).toEqual({ team: 'away', playerNumber: 8, previousCourtCaptain: null, keep: true })
  })

  it('switch off at the tap turns it off', () => {
    const { matchUpdate, payload } = chosenGameCaptain({ match: { homeKeepCourtCaptain: true, homeRememberedCourtCaptain: 8 }, team: 'home', playerNumber: 4, keep: false })
    expect(matchUpdate.homeKeepCourtCaptain).toBe(false)
    expect(payload).toMatchObject({ keep: false, previousKeepCourtCaptain: true, previousRememberedCourtCaptain: 8 })
  })
})

describe('the automatic designation', () => {
  it('is the same event, marked auto and keep, and touches only the game captain in force', () => {
    expect(automaticDesignation({ match: { homeCourtCaptain: 3 }, team: 'home', playerNumber: 8 })).toEqual({
      matchUpdate: { homeCourtCaptain: 8 },
      payload: { team: 'home', playerNumber: 8, previousCourtCaptain: 3, keep: true, auto: true }
    })
  })
})

describe('a match rebuilt from the server copy', () => {
  it('reads the last game captain and the switch from the newest designation of each team', () => {
    const events = [
      { seq: 4, type: 'court_captain_designation', payload: { team: 'home', playerNumber: 3, keep: false } },
      { seq: 9, type: 'court_captain_designation', payload: { team: 'home', playerNumber: 8, keep: true } },
      { seq: 12, type: 'court_captain_designation', payload: { team: 'home', playerNumber: 8, keep: true, auto: true } },
      { seq: 7, type: 'court_captain_designation', payload: { team: 'away', playerNumber: 5, fromLineup: true } },
      { seq: 13, type: 'point', payload: { team: 'home' } }
    ]
    expect(keepFieldsFromEvents(events)).toEqual({
      homeRememberedCourtCaptain: 8, homeKeepCourtCaptain: true,
      awayRememberedCourtCaptain: 5, awayKeepCourtCaptain: false
    })
  })

  it('leaves out a team without a designation', () => {
    expect(keepFieldsFromEvents([])).toEqual({})
    expect(keepFieldsFromEvents([{ seq: 1, type: 'court_captain_designation', payload: { team: 'away', playerNumber: 2, keep: true } }]))
      .toEqual({ awayRememberedCourtCaptain: 2, awayKeepCourtCaptain: true })
  })
})
