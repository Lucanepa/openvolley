// Laptop run of 2026-10-08 (OB-3, checked here in OpenVolley): confirming
// the coin toss swapped the button to 'Return to match' (the layout moved),
// then showed the scoreboard's 'Loading...' for ~290 ms before the
// scoreboard. The coin toss (with its progress dialog) stays now until the
// scoreboard replaces it, filled.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor, fireEvent } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import { offline, online, mountApp, button, sleep, track } from './appMount'

beforeAll(offline)
afterAll(online)

describe('App: confirming the coin toss', () => {
  it('goes from the coin toss to the filled scoreboard in one change', async () => {
    const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1, dob: '01.01.1990' },
      { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1, dob: '01.01.1990' }
    ]))
    const now = new Date().toISOString()
    await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'scheduled', test: true, createdAt: now, matchInfoConfirmedAt: now,
      hall: 'Hall', city: 'City', league: 'League', scheduledAt: now,
      homeCoachSignature: 'x', homeCaptainSignature: 'x', awayCoachSignature: 'x', awayCaptainSignature: 'x'
    })

    mountApp()
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(button('Confirm coin toss result')).toBeTruthy())

    const { states, stop } = track(() => {
      const text = document.body.textContent
      return {
        confirm: !!button('Confirm coin toss result') || !![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Confirm coin toss result'),
        returnToMatch: !![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Return to match'),
        progress: [...document.querySelectorAll('[role=dialog]')].map(d => d.textContent).find(x => /initiali[sz]|checks|Syncing/i.test(x))?.slice(0, 40) || null,
        loading: /Loading\.\.\./.test(text),
        scoreboard: !![...document.querySelectorAll('button')].find(b => /^Lineup/.test(b.textContent.trim()))
      }
    })
    fireEvent.click(button('Confirm coin toss result'))
    // offline, the connection checks fail: the scorer goes on
    await waitFor(() => expect(button('Proceed anyway')).toBeTruthy(), { timeout: 15000 })
    fireEvent.click(button('Proceed anyway'))
    await waitFor(() => expect(states.at(-1)?.scoreboard).toBe(true), { timeout: 15000 })
    await sleep(500)
    stop()

    expect(states.at(-1)).toMatchObject({ scoreboard: true, loading: false, progress: null })
    // the coin toss page keeps its button; then the scoreboard, never 'Loading...' between
    expect(states.filter(s => s.returnToMatch)).toEqual([])
    expect(states.filter(s => s.loading)).toEqual([])
    expect(states.filter(s => !s.confirm && !s.scoreboard)).toEqual([])
  })
})
