// Audit LOG-01 (round 3): a Global match and a guest match (the Swiss "New
// match" signed out) are REAL matches (test: false) whose only full copy is
// on this device, in its test-match slot (domain/matchKind usesKeyStore).
// Home's Test match, Easy match, the Global tool's Match and the signed-out
// New match wiped such a match with its events and sets, without a question
// (App clearLocalTestData took every isLocalOnly match), while the match's
// own Delete asks for its game PIN. Now each of them is blocked with a
// message naming the match, and the match stays; it goes only by Close match
// or by Delete match.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import { offline, online, mountApp, button, sleep } from './appMount'
import { HOUR, ago, seedMatch } from './selfCheckFixtures'

beforeAll(offline)
afterAll(online)
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(table => table.clear()))
  localStorage.removeItem('api_auth_token')
  localStorage.removeItem('ov-tool-mode')
  sessionStorage.clear()
  globalThis.fetch.mockImplementation(() => Promise.reject(new TypeError('offline (test)')))
})

const GLOBAL_OPEN = 'A Global match is still open on this device'
const GUEST_OPEN = 'A match without an account is still open on this device'

// as App createKeyStoreMatch makes it: the slot's seed key and external id,
// its own key for the keyed store; then played on (sets 25:20, 20:25, 12:10)
async function seedKeyStoreMatch(kind, status) {
  const id = await seedMatch({
    at: ago(HOUR), status, test: false, [kind]: true, globalKey: 'k'.repeat(22),
    seed_key: null, seedKey: 'test-match-default-a1b2c3d4e5f6', externalId: 'test-match-default', gamePin: '482913'
  })
  for (let n = 2; n <= 30; n++) {
    await db.events.add({ matchId: id, setIndex: n < 15 ? 1 : n < 25 ? 2 : 3, type: 'point', payload: { team: n % 2 ? 'home' : 'away' }, seq: n, ts: ago(HOUR) })
  }
  return id
}

async function stillThere(id) {
  return {
    row: !!(await db.matches.get(id)),
    events: await db.events.where('matchId').equals(id).count(),
    sets: await db.sets.where('matchId').equals(id).count(),
    matches: await db.matches.count()
  }
}

const bodyHas = (text) => document.body.textContent.includes(text)

// One tap on a Home button: the block appears (and is closed), nothing is created
async function tapAndExpectBlock(find, message) {
  await waitFor(() => expect(find()).toBeTruthy(), { timeout: 10000 })
  fireEvent.click(find())
  await waitFor(() => expect(bodyHas(message)).toBe(true), { timeout: 5000 })
  fireEvent.click(button('OK'))
  await waitFor(() => expect(bodyHas(message)).toBe(false))
}

const byTestId = (id) => () => {
  const b = document.querySelector(`[data-testid="${id}"]`)
  return b && !b.disabled ? b : null
}
const byText = (text) => () => button(text)

describe('App: a Global or guest match is never wiped by a new match', () => {
  for (const status of ['scheduled', 'live', 'ended']) {
    it(`guest match ${status}, signed out: New match, Test match and Easy match are blocked, the match stays`, async () => {
      const id = await seedKeyStoreMatch('guest', status)
      const before = await stillThere(id)
      expect(before).toEqual({ row: true, events: 30, sets: 3, matches: 1 })
      mountApp()
      await waitFor(() => expect(document.querySelector('[data-testid="continue-card"]')).toBeTruthy(), { timeout: 10000 })
      await sleep(500) // the home screen reads the match status

      await tapAndExpectBlock(byTestId('home-new-match'), GUEST_OPEN)
      await tapAndExpectBlock(byText('Test match'), GUEST_OPEN)
      await tapAndExpectBlock(byText('Easy match'), GUEST_OPEN)
      await sleep(300)

      expect(await stillThere(id)).toEqual(before)
      expect(await db.matches.get(id)).toMatchObject({ guest: true, test: false, globalKey: 'k'.repeat(22), status })
      // no Easy match form was left open over Home
      expect(document.querySelector('[data-testid="continue-card"]')).toBeTruthy()
    }, 40000)
  }

  for (const status of ['scheduled', 'live', 'ended']) {
    it(`Global match ${status}, Global tool: Match and Test match are blocked, the match stays`, async () => {
      localStorage.setItem('ov-tool-mode', 'global')
      const id = await seedKeyStoreMatch('global', status)
      const before = await stillThere(id)
      mountApp()
      await waitFor(() => expect(document.querySelector('[data-testid="home-global-match"]')).toBeTruthy(), { timeout: 10000 })
      await sleep(500)

      await tapAndExpectBlock(byTestId('home-global-match'), GLOBAL_OPEN)
      await tapAndExpectBlock(byText('Test match'), GLOBAL_OPEN)
      await sleep(300)

      expect(await stillThere(id)).toEqual(before)
      expect(await db.matches.get(id)).toMatchObject({ global: true, test: false, globalKey: 'k'.repeat(22), status })
    }, 40000)
  }

  it('a final guest match left on the device: Test match is made beside it, the final match keeps its row and log', async () => {
    const id = await seedKeyStoreMatch('guest', 'final')
    const before = await stillThere(id)
    mountApp()
    await waitFor(() => expect(button('Test match')).toBeTruthy(), { timeout: 10000 })
    await sleep(500)
    fireEvent.click(button('Test match'))
    // Match Setup of the new test match
    await waitFor(async () => expect(await db.matches.filter(m => m.test === true).count()).toBe(1), { timeout: 10000 })
    const test = await db.matches.filter(m => m.test === true).first()
    expect(test.id).not.toBe(id)
    // its own relay room, not the final match's seed key
    expect(test.seedKey).not.toBe('test-match-default-a1b2c3d4e5f6')
    const after = await stillThere(id)
    expect(after).toMatchObject({ row: true, events: before.events, sets: before.sets })
    expect(await db.matches.get(id)).toMatchObject({ guest: true, status: 'final', test: false })
  }, 40000)
})
