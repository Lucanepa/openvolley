// Laptop run of 2026-10-08 (OV-18): New match > Test match showed Match
// Setup with 'Not set' and 'Players: 0' for ~165 ms before the test data;
// the setup filled in over four changes (teams, one roster, the other,
// the officials). The home screen stays now until Match Setup has its data.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { offline, online, mountApp, button, sleep, track } from './appMount'
import { fireEvent } from '@testing-library/react'

beforeAll(offline)
afterAll(online)

describe('App: a new test match', () => {
  it('goes from the home screen to the filled Match Setup in one change', async () => {
    mountApp()
    await waitFor(() => expect(button('New match')).toBeTruthy(), { timeout: 8000 })
    fireEvent.click(button('New match'))
    await waitFor(() => expect(button('Test match')).toBeTruthy())

    const { states, stop } = track(() => {
      const text = document.body.textContent
      return {
        home: !!button('Restore match'),
        match: !!button('Continue match') || !!button('Delete match'),
        setup: /Players: \d+/.test(text),
        notSet: (text.match(/Not set/g) || []).length,
        players: (text.match(/Players: \d+/g) || []).join(' ')
      }
    })
    fireEvent.click(button('Test match'))
    await waitFor(() => expect(states.at(-1)).toMatchObject({ home: false, setup: true, notSet: 0 }), { timeout: 8000 })
    await sleep(500)
    stop()

    expect(states.at(-1)).toEqual({ home: false, match: false, setup: true, notSet: 0, players: 'Players: 12 Players: 12' })
    // the home screen as it was (never the new match's 'Continue match /
    // Delete match', OB-2); once it is gone: only the filled setup
    expect(states.filter(s => s.home && s.match)).toEqual([])
    expect(states.filter(s => !s.home && !(s.setup && s.notSet === 0 && s.players === 'Players: 12 Players: 12'))).toEqual([])
  }, 30000)
})
