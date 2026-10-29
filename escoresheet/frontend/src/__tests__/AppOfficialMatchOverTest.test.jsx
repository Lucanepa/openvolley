// New match → Official match while a test match is being recorded (stress
// test 2026-10-25, 3 of 3 rounds): nothing happened at all, no dialog, no
// message, the home screen just stayed, while Test match in the same menu
// asked to replace the match. The scorer kept tapping until someone thought
// of deleting the test match. Now the test match is replaced after the same
// kind of question, and an official match being recorded is not replaced but
// the scorer is told what to do.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import en from '../i18n/locales/en.json'
import { offline, online, mountApp, button, sleep } from './appMount'

beforeAll(offline)
afterAll(online)
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(table => table.clear()))
  localStorage.removeItem('api_auth_token')
})

const start = new Date(Date.now() - 3600000).toISOString()

// A match on the home screen that is being recorded: set 1 at 1:0 (not
// 'live', so the app does not reopen its scoring screen at start; the home
// screen is where the scorer taps New match)
async function seedRecordingMatch(fields = {}) {
  const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
  ]))
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'scheduled', createdAt: start, matchInfoConfirmedAt: start,
    scheduledAt: start, hall: 'Hall', city: 'City', league: 'League',
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
    homeCoachSignature: 'x', homeCaptainSignature: 'x', awayCoachSignature: 'x', awayCaptainSignature: 'x',
    ...fields
  })
  await db.sets.add({ matchId, index: 1, homePoints: 1, awayPoints: 0, finished: false, startTime: start })
  await db.events.bulkAdd([
    { matchId, setIndex: 1, type: 'set_start', payload: {}, seq: 1, ts: start },
    { matchId, setIndex: 1, type: 'rally_start', payload: {}, seq: 2, ts: start },
    { matchId, setIndex: 1, type: 'point', payload: { team: 'home' }, seq: 3, ts: start }
  ])
  return matchId
}

const menuOfficialMatch = () => [...document.querySelectorAll('button')]
  .find(b => b.textContent.trim() === 'Official match' && !b.disabled)
const dialogWith = (text) => [...document.querySelectorAll('[role="dialog"]')].find(d => d.textContent.includes(text))

// Signed in (Official game is for accounts); offline, today's games cannot
// load, so the game is typed in
async function openOfficialMatch() {
  localStorage.setItem('api_auth_token', JSON.stringify({
    access_token: 'token-test', expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    user: { id: '00000000-0000-4000-8000-0000000000aa' }
  }))
  mountApp()
  await waitFor(() => expect(button('Continue match')).toBeTruthy())
  await sleep(500) // the home screen's match status is read
  await waitFor(() => expect(menuOfficialMatch()).toBeTruthy())
  fireEvent.click(menuOfficialMatch())
  await waitFor(() => expect(document.querySelector('[data-testid="today-games-manual"]')).toBeTruthy())
  fireEvent.click(document.querySelector('[data-testid="today-games-manual"]'))
}

describe('App: New match → Official match while a match is being recorded', () => {
  it('a test match being recorded: asks to replace it; Yes deletes it and opens the official match setup', async () => {
    const testId = await seedRecordingMatch({ test: true })
    await openOfficialMatch()
    await waitFor(() => expect(dialogWith(en.home.modals.officialMatchReplaceTest)).toBeTruthy())

    fireEvent.click(button('Yes'))
    await waitFor(async () => expect(await db.matches.get(testId)).toBeUndefined())
    await waitFor(() => expect(button('Restore match')).toBeFalsy())
    expect(await db.events.where('matchId').equals(testId).count()).toBe(0)
    const matches = await db.matches.toArray()
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ status: 'scheduled' })
    expect(matches[0].test).not.toBe(true)
  })

  it('Cancel keeps the test match', async () => {
    const testId = await seedRecordingMatch({ test: true })
    await openOfficialMatch()
    await waitFor(() => expect(dialogWith(en.home.modals.officialMatchReplaceTest)).toBeTruthy())
    fireEvent.click(button('Cancel'))
    await waitFor(() => expect(dialogWith(en.home.modals.officialMatchReplaceTest)).toBeFalsy())
    await sleep(300)
    expect(await db.matches.get(testId)).toBeTruthy()
    expect(await db.matches.count()).toBe(1)
  })

  it('an official match being recorded: not replaced, a message says what to do', async () => {
    const officialId = await seedRecordingMatch()
    await openOfficialMatch()
    await waitFor(() => expect(dialogWith(en.home.modals.officialMatchStillRecording)).toBeTruthy())
    await sleep(300)
    expect(await db.matches.count()).toBe(1)
    expect(await db.matches.get(officialId)).toBeTruthy()
    expect(button('Restore match')).toBeTruthy()
  })
})
