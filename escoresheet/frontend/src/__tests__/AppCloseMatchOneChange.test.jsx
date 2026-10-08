// Laptop run of 2026-10-08 (OV-17): closing a match (Match End > Close
// match) showed the home screen with the closed match's 'Continue match /
// Delete match' and the header's 'Test match' for one frame: App went home
// before its live queries had seen the delete. The home screen never shows
// the closed match now.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor, fireEvent } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import { offline, online, mountApp, button, sleep, track } from './appMount'

beforeAll(offline)
afterAll(online)

describe('App: closing a match', () => {
  it('goes from Match End to the home screen without the closed match, in one change', async () => {
    const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6].flatMap(n => [
      { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
      { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
    ]))
    const start = new Date(Date.now() - 3600000).toISOString()
    // an approved test match: Match End offers 'Close match'
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'ended', test: true, approved: true, approvedAt: start,
      createdAt: start, matchInfoConfirmedAt: start,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
      homeCoachSignature: 'x', homeCaptainSignature: 'x', awayCoachSignature: 'x', awayCaptainSignature: 'x'
    })
    await db.sets.bulkAdd([1, 2, 3].map(index => (
      { matchId, index, homePoints: 25, awayPoints: 20, finished: true, startTime: start, endTime: start }
    )))
    await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: start })

    mountApp()
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(button('Close match')).toBeTruthy())

    const { states, stop } = track(() => ({
      home: !!button('Restore match'),
      match: !!button('Continue match') || !!button('Delete match'),
      testMatchChip: !!button('Test match'),
      matchEnd: /Match complete/.test(document.body.textContent)
    }))
    fireEvent.click(button('Close match'))
    await waitFor(async () => expect(await db.matches.count()).toBe(0))
    await waitFor(() => expect(states.at(-1)?.home).toBe(true))
    await sleep(500)
    stop()

    expect(states.at(-1)).toEqual({ home: true, match: false, testMatchChip: false, matchEnd: false })
    // never the home screen with the closed match on it, never an empty page
    expect(states.filter(s => s.home && (s.match || s.testMatchChip))).toEqual([])
    expect(states.filter(s => !s.home && !s.matchEnd)).toEqual([])
  })
})
