// New match → Official match with an official match that ended, or was
// approved here, and was not closed (review 2026-11-10): the match is still
// the current one until its Match End's Close match, and the button replaced
// it after the generic "There is an existing match..." question, with no game
// PIN and no word about what was lost. Offline, the approval, the last points
// and set ends and the scoresheet upload went with it: deleted from the queue
// before the server had them. Now such a match, a live one and one with
// writes the server does not have stay; the scorer is told to close or delete
// it first, and how many changes have not reached the server. Delete match
// (game PIN, loss warning) still reaches it.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import en from '../i18n/locales/en.json'
import { offline, online, mountApp, button, sleep } from './appMount'
import { SEED, MIN, HOUR, ago, seedMatch, signIn, offlineDevice } from './selfCheckFixtures'

beforeAll(offline)
afterAll(online)
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(table => table.clear()))
  localStorage.removeItem('api_auth_token')
  sessionStorage.clear()
  globalThis.fetch.mockImplementation(() => Promise.reject(new TypeError('offline (test)')))
})

const menuOfficialMatch = () => [...document.querySelectorAll('button')]
  .find(b => b.textContent.trim() === 'Official match' && !b.disabled)
const dialogWith = (text) => text && [...document.querySelectorAll('[role="dialog"]')].find(d => d.textContent.includes(text))
const unsentCount = (count) => en.home.modals[`officialMatchUnsentCount_${count === 1 ? 'one' : 'other'}`]?.replace('{{count}}', count)

// Signed in (Official game is for accounts); offline, today's games cannot
// load, so the game is typed in
async function openOfficialMatch() {
  signIn()
  mountApp()
  await waitFor(() => expect(button('Continue match')).toBeTruthy(), { timeout: 5000 })
  await sleep(800) // the home screen's match status is read
  await waitFor(() => expect(menuOfficialMatch()).toBeTruthy())
  fireEvent.click(menuOfficialMatch())
  await waitFor(() => expect(document.querySelector('[data-testid="today-games-manual"]')).toBeTruthy())
  fireEvent.click(document.querySelector('[data-testid="today-games-manual"]'))
}

// What New match showed: the generic replace question, or the message that
// keeps the match
async function shownAfterOfficialMatch(kept) {
  await waitFor(() => expect(dialogWith(en.home.modals.existingMatchWarning) || dialogWith(kept)).toBeTruthy())
  return {
    replaceQuestion: !!dialogWith(en.home.modals.existingMatchWarning),
    kept: dialogWith(kept) || null
  }
}

// The writes of the match's end that the server does not have yet (offline)
const endJobs = () => [
  { resource: 'event', action: 'insert', payload: { external_id: `${SEED}:e:50`, match_id: SEED, type: 'point' }, ts: ago(40 * MIN), status: 'queued' },
  { resource: 'set', action: 'update', payload: { external_id: `${SEED}:s:3`, home_points: 15, away_points: 10, finished: true }, ts: ago(30 * MIN), status: 'queued' },
  { resource: 'match', action: 'update', payload: { id: SEED, status: 'approved' }, ts: ago(20 * MIN), status: 'queued' },
  { resource: 'scoresheet', action: 'upload', payload: { path: '2026-11-09/game406970_k0123456789abcdef0123456789abcdef.pdf', match_external_id: SEED }, ts: ago(20 * MIN), status: 'queued' }
]

async function finishThirdSet(id) {
  const third = await db.sets.where('matchId').equals(id).and(s => s.index === 3).first()
  await db.sets.update(third.id, { homePoints: 15, awayPoints: 10, finished: true, endTime: ago(30 * MIN) })
}

// A confirmed official match in Match Setup: no coin toss, no set
async function seedSetupMatch(fields = {}) {
  const at = ago(HOUR)
  const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
  const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
  ]))
  return db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'scheduled', createdAt: at, matchInfoConfirmedAt: at,
    seed_key: SEED, gameN: 406970, gamePin: '482915', ...fields
  })
}
const insertJob = () => ({ resource: 'match', action: 'insert', payload: { external_id: SEED, status: 'scheduled' }, ts: ago(10 * MIN), status: 'queued' })

describe('App: New match → Official match keeps an official match that is not closed', () => {
  it('approved here, not closed, offline: not replaced; the message names the unsent changes; Delete match still asks for the PIN', async () => {
    const id = await seedMatch({ at: ago(HOUR), status: 'ended', approved: true })
    await finishThirdSet(id)
    await db.sync_queue.bulkAdd(endJobs())
    const onLine = offlineDevice()
    try {
      await openOfficialMatch()
      const shown = await shownAfterOfficialMatch(en.home.modals.officialMatchNotClosed)
      expect(shown.replaceQuestion).toBe(false)
      expect(shown.kept.textContent).toContain(unsentCount(4))

      await sleep(300)
      expect(await db.matches.get(id)).toBeTruthy()
      expect(await db.sync_queue.count()).toBe(4)
      expect(await db.events.where('matchId').equals(id).count()).toBe(1)
      expect(await db.matches.count()).toBe(1)

      // OK, then Delete match: the PIN and what deleting it loses
      fireEvent.click(button('OK'))
      await waitFor(() => expect(dialogWith(en.home.modals.officialMatchNotClosed)).toBeFalsy())
      fireEvent.click(document.querySelector('[data-testid="home-delete-match"]'))
      await waitFor(() => expect(document.querySelector('[data-testid="delete-loss-warning"]')).toBeTruthy())
      expect(document.querySelector('#delete-match-pin')).toBeTruthy()
    } finally {
      onLine.mockRestore()
    }
  }, 20000)

  it('ended, not approved, everything sent: not replaced either, without a count', async () => {
    const id = await seedMatch({ at: ago(HOUR), status: 'ended' })
    await finishThirdSet(id)
    await db.sync_queue.bulkAdd(endJobs().map(j => ({ ...j, status: 'sent' })))
    await openOfficialMatch()
    const shown = await shownAfterOfficialMatch(en.home.modals.officialMatchNotClosed)
    expect(shown.replaceQuestion).toBe(false)
    expect(shown.kept.textContent).not.toContain(unsentCount(4))
    await sleep(300)
    expect(await db.matches.get(id)).toBeTruthy()
    expect(await db.sync_queue.count()).toBe(4)
  }, 20000)

  it('live past the coin toss, signatures not complete: being recorded, not replaced', async () => {
    const id = await seedMatch({ at: ago(10 * MIN), homeCaptainSignature: null, awayCaptainSignature: null })
    await openOfficialMatch()
    const shown = await shownAfterOfficialMatch(en.home.modals.officialMatchStillRecording)
    expect(shown.replaceQuestion).toBe(false)
    await sleep(300)
    expect(await db.matches.get(id)).toBeTruthy()
    expect(await db.sets.where('matchId').equals(id).count()).toBe(3)
  }, 20000)

  it('in Match Setup with writes the server does not have: not replaced, the count is named', async () => {
    const id = await seedSetupMatch()
    await db.sync_queue.add(insertJob())
    const onLine = offlineDevice()
    try {
      await openOfficialMatch()
      const shown = await shownAfterOfficialMatch(en.home.modals.officialMatchUnsent)
      expect(shown.replaceQuestion).toBe(false)
      expect(shown.kept.textContent).toContain(unsentCount(1))
      await sleep(300)
      expect(await db.matches.get(id)).toBeTruthy()
      expect(await db.sync_queue.count()).toBe(1)
    } finally {
      onLine.mockRestore()
    }
  }, 20000)

  it('in Match Setup, everything sent: asked about as before; a write queued before Yes keeps the match and the write', async () => {
    const id = await seedSetupMatch()
    await db.sync_queue.add({ ...insertJob(), status: 'sent' })
    const onLine = offlineDevice()
    try {
      await openOfficialMatch()
      const shown = await shownAfterOfficialMatch(en.home.modals.officialMatchUnsent)
      expect(shown.replaceQuestion).toBe(true)

      // a change of the match is queued while the question is open
      await db.sync_queue.add({ resource: 'match', action: 'update', payload: { id: SEED, hall: 'Hall B' }, ts: ago(0), status: 'queued' })
      const dialog = dialogWith(en.home.modals.existingMatchWarning)
      fireEvent.click([...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'Yes'))

      await waitFor(() => expect(dialogWith(en.home.modals.officialMatchUnsent)).toBeTruthy())
      await sleep(300)
      expect(await db.matches.get(id)).toBeTruthy()
      expect(await db.matches.count()).toBe(1)
      expect((await db.sync_queue.toArray()).filter(j => j.status === 'queued')).toHaveLength(1)
    } finally {
      onLine.mockRestore()
    }
  }, 20000)

  it('in Match Setup, everything sent: Yes replaces it as before', async () => {
    const id = await seedSetupMatch()
    await db.sync_queue.add({ ...insertJob(), status: 'sent' })
    await openOfficialMatch()
    const shown = await shownAfterOfficialMatch(en.home.modals.officialMatchUnsent)
    expect(shown.replaceQuestion).toBe(true)
    fireEvent.click(button('Yes'))
    await waitFor(async () => expect(await db.matches.get(id)).toBeUndefined())
    const matches = await db.matches.toArray()
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({ status: 'scheduled' })
  }, 20000)
})
