// Opening, reloading and coming back to the app (the owner's start and resume
// rules, 2026-10-27, after the established e-scoresheets: DataProject /
// FIVB / CEV, SAMS, Nevobo DWF, FFvolley FDME, VolleySpike, nuScore, SIHF,
// GameSheet and the cricket scorers all open on their home or match list and
// resume a match with one tap; none reopens a match on its own):
// 1. Opening the app always lands on Home, with a Continue card for the match
//    in progress. A crash or a kill counts as an opening.
// 2. A reload goes back into the match: a sessionStorage marker, which a
//    reload keeps and an app kill or a new tab does not; a tab the browser
//    discarded (document.wasDiscarded) too.
// 3. 15 minutes or more in the background (hidden, never visible and idle)
//    goes to Home. It only changes the screen.
// 4. Home shows each match's state; a copy closed on the server or scored on
//    another device opens read-only (view and scoresheet).
// 5. Remove from this device is local only for such copies, and warns when
//    something would be lost. Nothing is removed without the user.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import en from '../i18n/locales/en.json'
import { scorerRelay } from '../utils/relayPublisher'
import { offline, online, mountApp, button, sleep } from './appMount'
import {
  SEED, MIN, HOUR, DAY, ago, OPEN_MATCH_KEY, reloadInto, seedMatch, signIn, answerServer, rowsReads, callsTo,
  closedRow, openRow, offlineDevice, backgroundClock, jsonResponse
} from './selfCheckFixtures'

beforeAll(offline)
afterAll(online)
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(table => table.clear()))
  localStorage.removeItem('api_auth_token')
  sessionStorage.clear()
  globalThis.fetch.mockImplementation(() => Promise.reject(new TypeError('offline (test)')))
})

const continueCard = () => document.querySelector('[data-testid="continue-card"]')
const stateLabels = (root = document) => [...root.querySelectorAll('[data-testid="match-state"]')].map(e => e.textContent)
const closedModal = () => document.querySelector('[data-testid="closed-copy-modal"]')
const movedModal = () => document.querySelector('[data-testid="scorer-moved-modal"]')
const homeShown = () => !!button('Restore match')
const scoreboardShown = () => !homeShown() && !closedModal() && /Set 3|Start rally|Start set/.test(document.body.textContent)
const matchSetupShown = () => !!document.querySelector('[data-help-id="setup-match-info-card"]')
const dialogWith = (text) => [...document.querySelectorAll('[role="dialog"]')].find(d => d.textContent.includes(text))
const dialogButton = (dialog, text) => [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled)
const menuOfficialMatch = () => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Official match' && !b.disabled)
// (written before the strings existed: a missing one is its key)
const str = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), en) ?? path
const state = (key) => str(`home.matchState.${key}`)

describe('Opening the app lands on Home', () => {
  it('a fresh start with a live match scored 20 minutes ago, offline: Home with the Continue card, one tap back', async () => {
    await seedMatch({ at: ago(20 * MIN) })
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(continueCard()?.textContent).toContain('Home – Away'))
      const text = continueCard().textContent
      expect(text).toMatch(/Set 3/)
      expect(text).toMatch(/12:10/)
      expect(text).toMatch(/1:1/)
      expect(text).toContain(str('home.continueCard.lastSaved').split('{{')[0].trim())
      // offline: the server could not be asked
      await waitFor(() => expect(stateLabels(continueCard())).toContain(state('unchecked')))
      await sleep(800)
      expect(homeShown()).toBe(true)
      expect(scoreboardShown()).toBe(false)
      expect(sessionStorage.getItem(OPEN_MATCH_KEY)).toBeNull()

      fireEvent.click(button('Continue match'))
      await waitFor(() => expect(scoreboardShown()).toBe(true))
      // the match screen is marked for a reload
      expect(JSON.parse(sessionStorage.getItem(OPEN_MATCH_KEY))).toMatchObject({ view: 'scoreboard' })
    } finally {
      onLine.mockRestore()
    }
  })

  it('the same online and signed in: Home, the match asked about: "Scoring here"', async () => {
    await seedMatch({ at: ago(20 * MIN) })
    signIn()
    answerServer(() => [openRow], { scorer: { mine: true } })
    mountApp()
    await waitFor(() => expect(stateLabels(continueCard() || document)).toContain(state('here')))
    expect(rowsReads()).toHaveLength(1)
    await sleep(500)
    expect(homeShown()).toBe(true)
    expect(scoreboardShown()).toBe(false)
  })
})

describe('A reload goes back into the match', () => {
  it('the marker names a live match on the device: its scoring screen', async () => {
    const id = await seedMatch({ at: ago(20 * MIN) })
    reloadInto(id)
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(scoreboardShown()).toBe(true))
      expect(JSON.parse(sessionStorage.getItem(OPEN_MATCH_KEY))).toMatchObject({ id })
    } finally {
      onLine.mockRestore()
    }
  })

  it('a reload in Match Setup goes back to Match Setup', async () => {
    const created = ago(HOUR)
    const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
    const id = await db.matches.add({ homeTeamId: home, awayTeamId: away, status: 'scheduled', createdAt: created, seed_key: SEED, gameN: 406970 })
    reloadInto(id, 'matchSetup')
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(matchSetupShown()).toBe(true))
    } finally {
      onLine.mockRestore()
    }
  })

  it('a marker naming a match no longer on the device: Home, the marker cleared', async () => {
    await seedMatch({ at: ago(20 * MIN) })
    reloadInto(9999)
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(continueCard()).toBeTruthy())
      await sleep(500)
      expect(homeShown()).toBe(true)
      expect(sessionStorage.getItem(OPEN_MATCH_KEY)).toBeNull()
    } finally {
      onLine.mockRestore()
    }
  })

  it('a tab the browser discarded (document.wasDiscarded) reopens the live match', async () => {
    await seedMatch({ at: ago(20 * MIN) })
    Object.defineProperty(document, 'wasDiscarded', { value: true, configurable: true })
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(scoreboardShown()).toBe(true))
    } finally {
      onLine.mockRestore()
      delete document.wasDiscarded
    }
  })

  it('a reload into a copy scored on another device: read-only again; Close goes Home and clears the marker', async () => {
    const id = await seedMatch({ at: ago(20 * MIN), cloudBlock: { code: 'OV_SCORER_MOVED', claim: null, scorer: null, at: Date.now() } })
    reloadInto(id)
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(movedModal()).toBeTruthy())
      fireEvent.click(dialogButton(movedModal().closest('[role="dialog"]'), en.scorerMoved.close))
      await waitFor(() => expect(homeShown()).toBe(true))
      await waitFor(() => expect(sessionStorage.getItem(OPEN_MATCH_KEY)).toBeNull())
    } finally {
      onLine.mockRestore()
    }
  })
})

describe('15 minutes in the background goes to Home', () => {
  async function inTheMatch() {
    const id = await seedMatch({ at: ago(5 * MIN) })
    reloadInto(id)
    return id
  }

  it('back after 16 minutes hidden: Home with the Continue card; nothing closed, locked, set aside or deleted', async () => {
    const id = await inTheMatch()
    await db.sync_queue.add({ resource: 'event', action: 'insert', payload: { external_id: `${SEED}:e:9`, match_id: SEED }, ts: ago(MIN), status: 'queued' })
    const onLine = offlineDevice()
    const bg = backgroundClock()
    try {
      mountApp()
      await waitFor(() => expect(scoreboardShown()).toBe(true))
      const before = { match: await db.matches.get(id), events: await db.events.where('matchId').equals(id).count(), jobs: await db.sync_queue.toArray() }
      bg.hide()
      bg.advance(16 * MIN)
      bg.show()
      await waitFor(() => expect(homeShown()).toBe(true))
      await waitFor(() => expect(continueCard()).toBeTruthy())
      expect(scoreboardShown()).toBe(false)
      const after = await db.matches.get(id)
      expect(after.status).toBe(before.match.status)
      expect(after.cloudBlock ?? null).toBeNull()
      expect(await db.events.where('matchId').equals(id).count()).toBe(before.events)
      expect((await db.sync_queue.toArray()).map(j => j.status)).toEqual(before.jobs.map(j => j.status))
      // a reload now stays on Home
      expect(sessionStorage.getItem(OPEN_MATCH_KEY)).toBeNull()
    } finally {
      bg.restore()
      onLine.mockRestore()
    }
  })

  it('back after 5 minutes hidden: still in the match', async () => {
    await inTheMatch()
    const onLine = offlineDevice()
    const bg = backgroundClock()
    try {
      mountApp()
      await waitFor(() => expect(scoreboardShown()).toBe(true))
      bg.hide()
      bg.advance(5 * MIN)
      bg.show()
      await sleep(500)
      expect(scoreboardShown()).toBe(true)
      expect(homeShown()).toBe(false)
    } finally {
      bg.restore()
      onLine.mockRestore()
    }
  })

  it('20 minutes visible and idle (a long set break, the screen on): still in the match', async () => {
    await inTheMatch()
    const onLine = offlineDevice()
    const bg = backgroundClock()
    try {
      mountApp()
      await waitFor(() => expect(scoreboardShown()).toBe(true))
      bg.advance(20 * MIN)
      // a visibility event while visible (a notification shade, a focus change)
      bg.show()
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('pageshow'))
      await sleep(500)
      expect(scoreboardShown()).toBe(true)
      expect(homeShown()).toBe(false)
    } finally {
      bg.restore()
      onLine.mockRestore()
    }
  })

  it('back after 16 minutes hidden, online: the server is asked again', async () => {
    const id = await inTheMatch()
    signIn()
    answerServer((keys, n) => (n === 1 ? [openRow] : [closedRow]))
    const bg = backgroundClock()
    try {
      mountApp()
      await waitFor(() => expect(rowsReads()).toHaveLength(1))
      await waitFor(() => expect(scoreboardShown()).toBe(true))
      bg.hide()
      bg.advance(16 * MIN)
      bg.show()
      await waitFor(() => expect(rowsReads()).toHaveLength(2))
      await waitFor(async () => expect((await db.matches.get(id)).cloudBlock).toMatchObject({ code: 'OV_MATCH_CLOSED' }))
      await waitFor(() => expect(homeShown()).toBe(true))
      await waitFor(() => expect(stateLabels()).toContain(state('closed')))
    } finally {
      bg.restore()
    }
  })
})

describe('Home shows each match\'s state; closed and moved copies open read-only', () => {
  it('the owner\'s case: a live official copy closed on the server is "closed on the server", opens read-only, and Remove queues no server delete', async () => {
    const id = await seedMatch({ at: ago(HOUR) })
    signIn()
    answerServer(() => [closedRow])
    const relaySend = vi.spyOn(scorerRelay, 'send')
    const open = vi.spyOn(window, 'open').mockImplementation(() => ({ closed: false, focus() {}, document: { title: '' } }))
    try {
      mountApp()
      await waitFor(() => expect(stateLabels(continueCard() || document)).toContain(state('closed')))
      await sleep(300)
      expect(homeShown()).toBe(true)

      fireEvent.click(button('Continue match'))
      await waitFor(() => expect(closedModal()).toBeTruthy())
      expect(document.body.textContent).not.toMatch(/Start rally/)
      // view and print: this copy's scoresheet
      fireEvent.click(dialogButton(closedModal().closest('[role="dialog"]'), en.header.scoresheet))
      await waitFor(() => expect(open).toHaveBeenCalled())
      expect(String(open.mock.calls[0][0])).toContain(`/scoresheet/?matchId=${id}`)

      fireEvent.click(button(en.cloudBlock.closedCopy.remove))
      await waitFor(() => expect(document.body.textContent).toContain(en.cloudBlock.removeLocalOnly))
      // nothing is lost: no warning
      expect(document.querySelector('[data-testid="delete-loss-warning"]')).toBeNull()
      fireEvent.change(document.getElementById('delete-match-pin'), { target: { value: '482915' } })
      fireEvent.click(button(en.deleteMatch.delete))
      await waitFor(async () => expect(await db.matches.get(id)).toBeUndefined())
      await sleep(300)
      expect((await db.sync_queue.toArray()).filter(j => j.action === 'delete')).toEqual([])
      expect(relaySend.mock.calls.filter(([m]) => m?.type === 'delete-match')).toEqual([])
    } finally {
      open.mockRestore()
      relaySend.mockRestore()
    }
  })

  it('a copy scored on another device is "on another device", opens read-only, and Take back shows the server\'s score first', async () => {
    const id = await seedMatch({
      at: ago(HOUR),
      cloudBlock: { code: 'OV_SCORER_MOVED', claim: null, scorer: { platform: 'android', at: ago(30 * MIN) }, at: Date.now() - 30 * MIN }
    })
    signIn()
    const serverCopy = {
      match: { id: openRow.id, external_id: SEED, status: 'live', game_n: 406970, home_team: { name: 'Home' }, away_team: { name: 'Away' } },
      sets: [
        { index: 1, home_points: 25, away_points: 20, finished: true },
        { index: 2, home_points: 20, away_points: 25, finished: true },
        { index: 3, home_points: 14, away_points: 12, finished: false }
      ],
      events: []
    }
    answerServer(() => [openRow], { scorer: { mine: false, scorer: { platform: 'android', at: ago(30 * MIN) } }, restore: () => serverCopy })
    const open = vi.spyOn(window, 'open').mockImplementation(() => ({ closed: false, focus() {}, document: { title: '' } }))
    try {
      mountApp()
      await waitFor(() => expect(stateLabels(continueCard() || document)).toContain(state('moved')))

      fireEvent.click(button('Continue match'))
      await waitFor(() => expect(movedModal()).toBeTruthy())
      // no scoring control under it: the screens are inert
      await sleep(300)
      const rally = [...document.querySelectorAll('button')].find(b => /Start rally|Start set/.test(b.textContent))
      if (rally) expect(rally.closest('[inert]')).toBeTruthy()
      // the scoresheet stays reachable
      const dialog = movedModal().closest('[role="dialog"]')
      fireEvent.click(dialogButton(dialog, en.header.scoresheet))
      await waitFor(() => expect(open).toHaveBeenCalled())
      expect(String(open.mock.calls[0][0])).toContain(`/scoresheet/?matchId=${id}`)

      // Take back: the server's score to compare first, nothing loaded yet
      fireEvent.click(dialogButton(dialog, en.scorerMoved.takeBack))
      await waitFor(() => expect(document.querySelector('[data-testid="scorer-moved-preview"]')).toBeTruthy())
      const preview = document.querySelector('[data-testid="scorer-moved-preview"]').textContent
      expect(preview).toMatch(/Set 3/)
      expect(preview).toMatch(/14:12/)
      expect(preview).toMatch(/1:1/)
      expect(callsTo('/api/match/restore-by-pin').every(b => b?.claim !== true)).toBe(true)
      expect((await db.matches.get(id)).cloudBlock).toMatchObject({ code: 'OV_SCORER_MOVED' })
    } finally {
      open.mockRestore()
    }
  })

  it('Take back needs a connection', async () => {
    await seedMatch({ at: ago(HOUR), cloudBlock: { code: 'OV_SCORER_MOVED', claim: null, scorer: null, at: Date.now() } })
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(button('Continue match')).toBeTruthy())
      fireEvent.click(button('Continue match'))
      await waitFor(() => expect(movedModal()).toBeTruthy())
      fireEvent.click(dialogButton(movedModal().closest('[role="dialog"]'), en.scorerMoved.takeBack))
      await waitFor(() => expect(document.querySelector('[data-testid="scorer-moved-error"]')?.textContent).toBe(en.scorerMoved.errors.offline))
      expect(document.querySelector('[data-testid="scorer-moved-preview"]')).toBeNull()
    } finally {
      onLine.mockRestore()
    }
  })
})

describe('No automatic deletion: duplicates are flagged, Clean up asks once', () => {
  it('an empty second copy is flagged and stays until Clean up is confirmed', async () => {
    const kept = await seedMatch({ at: ago(2 * DAY) })
    const created = ago(3 * DAY)
    const home = await db.teams.add({ name: 'Home', shortName: 'HOM' })
    const away = await db.teams.add({ name: 'Away', shortName: 'AWA' })
    const empty = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'scheduled', createdAt: created, matchInfoConfirmedAt: created,
      seed_key: SEED, gameN: 406970, gamePin: '482915'
    })
    const onLine = offlineDevice()
    try {
      mountApp()
      const cleanUp = () => button(str('home.selfCheck.cleanUp'))
      await waitFor(() => expect(cleanUp()).toBeTruthy())
      await sleep(300)
      expect(await db.matches.get(empty)).toBeTruthy()
      expect(await db.matches.get(kept)).toBeTruthy()

      // Cancel keeps it
      fireEvent.click(cleanUp())
      await waitFor(() => expect(button(en.common.cancel)).toBeTruthy())
      fireEvent.click(button(en.common.cancel))
      await sleep(300)
      expect(await db.matches.get(empty)).toBeTruthy()

      // confirmed: the empty copy goes, with its own team rows; the other stays
      fireEvent.click(cleanUp())
      await waitFor(() => expect(button(en.common.yes)).toBeTruthy())
      fireEvent.click(button(en.common.yes))
      await waitFor(async () => expect(await db.matches.get(empty)).toBeUndefined())
      expect(await db.teams.bulkGet([home, away])).toEqual([undefined, undefined])
      expect(await db.matches.get(kept)).toBeTruthy()
      expect(await db.events.where('matchId').equals(kept).count()).toBe(1)
    } finally {
      onLine.mockRestore()
    }
  })
})

describe('A closed or moved copy never blocks a new match', () => {
  // Signed in (Official game is for accounts; signed out, Home offers test
  // and easy matches only): offline, today's games cannot load, so the game
  // is typed in
  async function newOfficialMatch() {
    signIn()
    mountApp()
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    await sleep(500) // the home screen's match status is read
    await waitFor(() => expect(menuOfficialMatch()).toBeTruthy())
    fireEvent.click(menuOfficialMatch())
    await waitFor(() => expect(document.querySelector('[data-testid="today-games-manual"]')).toBeTruthy())
    fireEvent.click(document.querySelector('[data-testid="today-games-manual"]'))
  }

  it.each([
    ['closed on the server', { cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: 1 } }],
    ['scored on another device', { cloudBlock: { code: 'OV_SCORER_MOVED', claim: null, scorer: null, at: 1 } }]
  ])('a copy %s: New match → Official match opens the setup, the copy stays', async (_, fields) => {
    const copy = await seedMatch({ at: ago(DAY), ...fields })
    const onLine = offlineDevice()
    try {
      await newOfficialMatch()
      await waitFor(() => expect(homeShown()).toBe(false))
      await waitFor(() => expect(matchSetupShown()).toBe(true))
      expect(dialogWith(en.home.modals.officialMatchStillRecording)).toBeFalsy()
      expect(dialogWith(en.home.modals.existingMatchWarning)).toBeFalsy()
      expect(await db.matches.get(copy)).toBeTruthy()
      expect(await db.matches.count()).toBe(2)
    } finally {
      onLine.mockRestore()
    }
  })
})

describe('Remove warns before anything unsent is lost', () => {
  it('a copy with unsent changes: the dialog names them before Delete', async () => {
    const id = await seedMatch({ at: ago(HOUR) })
    await db.sync_queue.bulkAdd([
      { resource: 'event', action: 'insert', payload: { external_id: `${SEED}:e:2`, match_id: SEED }, ts: ago(MIN), status: 'queued' },
      { resource: 'event', action: 'insert', payload: { external_id: `${SEED}:e:3`, match_id: SEED }, ts: ago(MIN), status: 'error' },
      { resource: 'set', action: 'update', payload: { external_id: `${SEED}:s:3`, match_id: SEED, home_points: 12 }, ts: ago(MIN), status: 'queued' }
    ])
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(stateLabels(continueCard() || document)).toContain(state('unsent')))
      fireEvent.click(button('Delete match'))
      await waitFor(() => expect(document.querySelector('[data-testid="delete-loss-warning"]')).toBeTruthy())
      const warning = document.querySelector('[data-testid="delete-loss-warning"]').textContent
      expect(warning).toMatch(/3/)
      expect(warning).toMatch(/2/)
      expect(await db.matches.get(id)).toBeTruthy()
    } finally {
      onLine.mockRestore()
    }
  })

  it('a closed copy whose writes were set aside warns too', async () => {
    await seedMatch({ at: ago(HOUR), cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: 1 } })
    await db.sync_queue.add({ resource: 'event', action: 'insert', payload: { external_id: `${SEED}:e:2`, match_id: SEED }, ts: ago(MIN), status: 'queued' })
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(button('Continue match')).toBeTruthy())
      fireEvent.click(button('Continue match'))
      await waitFor(() => expect(closedModal()).toBeTruthy())
      fireEvent.click(button(en.cloudBlock.closedCopy.remove))
      await waitFor(() => expect(document.querySelector('[data-testid="delete-loss-warning"]')).toBeTruthy())
      expect(document.body.textContent).toContain(en.cloudBlock.removeLocalOnly)
    } finally {
      onLine.mockRestore()
    }
  })
})

// fbf159bf: an app killed between the last rally and the scoreboard's
// 'match_end' push reopened on Match End, which makes the cloud live state
// say 'ended'; the livescore kept the game running otherwise. The app opens
// on Home now: the same repair runs at start-up, without opening a screen.
describe('Match End\'s live-state repair runs at start-up, on Home', () => {
  const CLOUD_ID = 'c0ffee00-0000-4000-8000-000000000001'
  const liveStateWrites = () => globalThis.fetch.mock.calls
    .map(([url, init]) => [String(url), JSON.parse(init?.body || 'null')])
    .filter(([url, b]) => url.endsWith('/api/db') && b?.table === 'match_live_state' && b?.action === 'update')
    .map(([, b]) => b)
  // the server: the self-check's read, and the live state's update
  function serverWithLiveState() {
    answerServer(() => [openRow])
    const inner = globalThis.fetch.getMockImplementation()
    globalThis.fetch.mockImplementation(async (url, init) => {
      const b = JSON.parse(init?.body || 'null')
      if (String(url).endsWith('/api/db') && b?.table === 'match_live_state') return jsonResponse({ data: [] })
      return inner(url, init)
    })
  }
  // the last set finished: 25:20, 20:25, 15:10
  async function endedMatch(fields) {
    const id = await seedMatch({ at: ago(10 * MIN), externalId: CLOUD_ID, bestOf: 3, ...fields })
    await db.sets.where({ matchId: id, index: 3 }).modify({ homePoints: 15, awayPoints: 10, finished: true })
    return id
  }

  it.each([
    ['ended here (killed before the push)', { status: 'ended' }],
    ['still live, won by its sets (killed in the set-end sync\'s pause)', { status: 'live' }]
  ])('a match %s: the live state says ended, and the app stays on Home', async (_, fields) => {
    await endedMatch(fields)
    signIn()
    serverWithLiveState()
    mountApp()
    await waitFor(() => expect(liveStateWrites()).toHaveLength(1))
    const write = liveStateWrites()[0]
    expect(write.params.data).toMatchObject({ match_status: 'ended', current_set: 3, sets_won_a: 2, sets_won_b: 1, points_a: 15, points_b: 10 })
    expect(write.params.filters).toEqual(expect.arrayContaining([
      { type: 'eq', column: 'match_id', value: CLOUD_ID },
      { type: 'neq', column: 'match_status', value: 'ended' }
    ]))
    await sleep(300)
    expect(homeShown()).toBe(true)
    expect(continueCard()).toBeTruthy()
    expect(liveStateWrites()).toHaveLength(1)
  })

  it('offline at the start: tried when the device comes online', async () => {
    await endedMatch({ status: 'ended' })
    signIn()
    serverWithLiveState()
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(continueCard()).toBeTruthy())
      await sleep(300)
      expect(liveStateWrites()).toHaveLength(0)
    } finally {
      onLine.mockRestore()
    }
    window.dispatchEvent(new Event('online'))
    await waitFor(() => expect(liveStateWrites()).toHaveLength(1))
    expect(homeShown()).toBe(true)
  })

  it.each([
    ['in progress', { status: 'live' }, false],
    ['scored on another device', { status: 'ended', cloudBlock: { code: 'OV_SCORER_MOVED', claim: null, scorer: null, at: 1 } }, true],
    ['closed on the server', { status: 'ended', cloudBlock: { code: 'OV_MATCH_CLOSED', claim: null, at: 1 } }, true],
    ['a test match', { status: 'ended', test: true, seed_key: 'test-match-1', matchInfoConfirmedAt: undefined }, true]
  ])('never for a match %s', async (_, fields, finished) => {
    const id = await seedMatch({ at: ago(10 * MIN), externalId: CLOUD_ID, bestOf: 3, ...fields })
    if (finished) await db.sets.where({ matchId: id, index: 3 }).modify({ homePoints: 15, awayPoints: 10, finished: true })
    signIn()
    serverWithLiveState()
    mountApp()
    await waitFor(() => expect(continueCard()).toBeTruthy())
    await sleep(600)
    expect(liveStateWrites()).toHaveLength(0)
  })
})
