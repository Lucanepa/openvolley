// A confirmed coin toss reopened on its page (a reload there, or a first
// confirm that ended on "Match status is not live"): Switch sides and Switch
// serve are locked, and Return to match leaves Team A and the first serve as
// confirmed. A change there went to the device's row only, never to the
// coin_toss event or the cloud: a restored or handed-over match then played
// with the other team serving first. Corrections change them (planCoinToss).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { waitFor, fireEvent, screen } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() }))
import { db } from '../db/db'
import { offline, online, mountApp, button, sleep } from './appMount'

beforeAll(offline)
afterAll(online)

const buttonAny = (text) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text)

describe('Return to match after a confirmed coin toss', () => {
  it('locks Switch sides and Switch serve and keeps the confirmed toss', async () => {
    await Promise.all(db.tables.map(t => t.clear()))
    const home = await db.teams.add({ name: 'Home VC', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away VC', shortName: 'AWA' })
    await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
      { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1, dob: '12.03.1990' },
      { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1, dob: '12.03.1990' }
    ]))
    const now = new Date().toISOString()
    const INK = 'data:image/png;base64,AAAA'
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'live', test: false, seed_key: 'locked-seed-1',
      createdAt: now, matchInfoConfirmedAt: now, hall: 'Hall', city: 'City', league: 'League', scheduledAt: now,
      homeShortName: 'HOM', awayShortName: 'AWA',
      firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
      coinTossConfirmed: true,
      homeCoachSignature: INK, homeCaptainSignature: INK, awayCoachSignature: INK, awayCaptainSignature: INK
    })
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })
    await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: { teamA: 'home', teamB: 'away', serveA: true, serveB: false, firstServe: 'home' }, seq: 1, ts: now })
    await db.sync_queue.clear()
    sessionStorage.setItem('ov.openMatch', JSON.stringify({ id: matchId, view: 'coinToss' }))

    mountApp()
    await waitFor(() => expect(button('Return to match')).toBeTruthy(), { timeout: 15000 })
    await sleep(300)
    expect(buttonAny('Switch serve').disabled).toBe(true)
    expect(buttonAny('Switch sides').disabled).toBe(true)
    expect(screen.getByTestId('coin-toss-locked')).toBeTruthy()
    fireEvent.click(buttonAny('Switch serve'))
    fireEvent.click(buttonAny('Switch sides'))
    await sleep(100)
    fireEvent.click(button('Return to match'))
    await sleep(500)

    const m = await db.matches.get(matchId)
    expect(m.firstServe).toBe('home')
    expect(m.coinTossTeamA).toBe('home')
    expect(m.coinTossServeA).toBe(true)
    const ct = (await db.events.toArray()).find(e => e.type === 'coin_toss')
    expect(ct.payload.firstServe).toBe('home')
  }, 60000)
})
