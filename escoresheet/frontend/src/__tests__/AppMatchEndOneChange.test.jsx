// Laptop run of 2026-10-08 (OV-14): confirming the match end showed the
// scoreboard's 'Loading...' and then an empty page for ~150 ms before Match
// End: the scoreboard cleared its set-end progress screen before App had
// switched, and Match End rendered nothing until it had read the match.
// The progress screen stays now until Match End replaces it, filled.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor, fireEvent } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import { offline, online, mountApp, button, sleep, track } from './appMount'

beforeAll(offline)
afterAll(online)

describe('App: the match end', () => {
  it('goes from the set-end progress screen to the filled Match End in one change', async () => {
    const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
      { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
    ]))
    const start = new Date(Date.now() - 3600000).toISOString()
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: true, createdAt: start,
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
      homeCoachSignature: 'x', homeCaptainSignature: 'x', awayCoachSignature: 'x', awayCaptainSignature: 'x'
    })
    await db.sets.bulkAdd([
      { matchId, index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: start, endTime: start },
      { matchId, index: 2, homePoints: 25, awayPoints: 20, finished: true, startTime: start, endTime: start },
      // the match point is on the score: the scoreboard asks for the match end
      { matchId, index: 3, homePoints: 25, awayPoints: 20, finished: false, startTime: start }
    ])
    await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: start })

    mountApp() // opens the live match (App restores it)
    // the scoreboard's match-end dialog
    const dialog = () => [...document.querySelectorAll('[role=dialog]')].find(d => /won the match/.test(d.textContent))
    await waitFor(() => expect(dialog()).toBeTruthy(), { timeout: 8000 })

    const { states, stop } = track(() => {
      const text = document.body.textContent
      return {
        dialog: !!dialog(),
        progress: (text.match(/(Finishing set|Saving set data|Syncing to cloud|Uploading backup|Downloading backup|Loading)\.\.\./) || [])[0] || null,
        matchEnd: /Match complete/.test(text) && /Results/.test(text)
      }
    })
    fireEvent.click([...dialog().querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm'))
    await waitFor(() => expect(states.at(-1)?.matchEnd).toBe(true), { timeout: 8000 })
    await sleep(500)
    stop()

    expect(states.at(-1)).toEqual({ dialog: false, progress: null, matchEnd: true })
    // the dialog, the set-end progress, Match End: never the generic
    // 'Loading...', never a page with none of them
    expect(states.filter(s => s.progress === 'Loading...')).toEqual([])
    expect(states.filter(s => !s.dialog && !s.progress && !s.matchEnd)).toEqual([])
  }, 30000)
})
