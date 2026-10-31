// Owner 2026-10-31: the coach and captain signatures no longer hold the coin
// toss of an official match. It confirms without them and the scoring screen
// opens with each team's flashing "Missing signature" (the first serve waits
// for them there: ScoreboardPreMatchSignatures.test.jsx).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor, fireEvent, screen } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
// The connection checks wait for timeouts offline (20 s and more on a busy
// machine); this test is about the signatures: they all pass at once
vi.mock('../utils/preMatchChecks', async (orig) => ({ ...(await orig()), runConnectionChecks: vi.fn(async () => []) }))
import { db } from '../db/db'
import { offline, online, mountApp, button, sleep } from './appMount'

beforeAll(offline)
afterAll(online)

describe('App: the coin toss of an official match without signatures', () => {
  it('confirms, and the scoring screen asks each team for its signatures', async () => {
    const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away VC', shortName: 'AWA' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1, dob: '12.03.1990' },
      { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1, dob: '12.03.1990' }
    ]))
    const now = new Date().toISOString()
    await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'scheduled', test: false, createdAt: now, matchInfoConfirmedAt: now,
      hall: 'Hall', city: 'City', league: 'League', scheduledAt: now, homeShortName: 'HOM', awayShortName: 'AWA',
      officials: [
        { role: '1st referee', firstName: 'R', lastName: 'Referee' },
        { role: 'scorer', firstName: 'S', lastName: 'Scorer', dob: '12.03.1985' }
      ],
      bench_home: [{ role: 'Coach', firstName: 'C', lastName: 'Homecoach', dob: '12.03.1970' }],
      bench_away: [{ role: 'Coach', firstName: 'C', lastName: 'Awaycoach', dob: '12.03.1970' }]
    })

    // the scorer's offline mode: no cloud sync to wait for at the coin toss
    localStorage.setItem('offlineMode', 'true')
    mountApp()
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    fireEvent.click(button('Continue match'))
    // an official match opens on its Match Setup (offline: "Connecting..." first)
    await waitFor(() => expect(button('Coin toss')).toBeTruthy(), { timeout: 10000 })
    if (button('Dismiss')) fireEvent.click(button('Dismiss'))
    fireEvent.click(button('Coin toss'))
    await waitFor(() => expect(button('Confirm coin toss result')).toBeTruthy(), { timeout: 10000 })
    // the page reads the teams after it shows: confirmed before, it says "Home team name is not set"
    await waitFor(() => expect(document.body.textContent).toMatch(/Home VC[\s\S]*Away VC|Away VC[\s\S]*Home VC/), { timeout: 10000 })
    await sleep(300)
    fireEvent.click(button('Confirm coin toss result'))
    // no "Please complete all signatures": on to the scoring screen
    await waitFor(() => expect(button('Proceed anyway') || screen.queryByTestId('missing-signature-left')).toBeTruthy(), { timeout: 20000 })
    expect(document.body.textContent).not.toContain('complete all signatures')
    if (button('Proceed anyway')) fireEvent.click(button('Proceed anyway'))

    await waitFor(() => expect(screen.getByTestId('missing-signature-left')).toBeTruthy(), { timeout: 15000 })
    expect(screen.getByTestId('missing-signature-right')).toBeTruthy()
    const match = (await db.matches.toArray())[0]
    expect(match.coinTossConfirmed).toBe(true)
    expect(match.homeCoachSignature ?? null).toBeNull()
    localStorage.removeItem('offlineMode')
  }, 60000)
})
