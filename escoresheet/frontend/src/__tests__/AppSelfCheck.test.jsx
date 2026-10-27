// The self-check (utils/deviceSelfCheck). 2026-10-27: the owner's desktop app
// (3.0.5) opened straight on the scoring screen of official match 406970,
// "Online · Connected", Start set, as if the match were live. That copy had
// only reached the coin toss on the PC on 20.10; the match was continued and
// closed on a phone the same day. The PC never learnt: a device hears of a
// close only when a write of its copy is refused, and this copy had written
// nothing since. A stale copy reopened like that is how duplicate scoring
// and duplicate records start.
//
// The app now opens on Home every time (AppOpenAndResume) and checks its
// matches there: the server asked in the background, copies of one match
// flagged, nothing removed without the user.
//
// The server is the app's own /api/db read and /api/match/scorer, answered
// here through fetch (selfCheckFixtures); everything else stays offline.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup, screen } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import en from '../i18n/locales/en.json'
import { offline, online, mountApp, button, sleep } from './appMount'
import {
  SEED, MIN, HOUR, DAY, ago, reloadInto, seedMatch, signIn, answerServer, rowsReads, callsTo,
  closedRow, openRow, offlineDevice, backgroundClock
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

const closedModal = () => document.querySelector('[data-testid="closed-copy-modal"]')
const selfCheckNotice = () => document.querySelector('[data-testid="self-check-notice"]')
const continueCard = () => document.querySelector('[data-testid="continue-card"]')
const stateLabels = (root = document) => [...(root || document).querySelectorAll('[data-testid="match-state"]')].map(e => e.textContent)
// a button of the open dialog (the device list behind it has its own Delete)
const dialogButton = (text) => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === text && !b.disabled)
const homeShown = () => !!button('Restore match')
// the Scoreboard's own screen (its set and rally controls), not the home screen
const scoreboardShown = () => !homeShown() && !closedModal() && /Set 3|Start rally|Start set/.test(document.body.textContent)
const line = (key, game = '406970') => en.home.selfCheck[key].replace('{{game}}', game)

describe('App: the self-check on open', () => {
  it('(a) the owner\'s case: a live copy whose server row is closed stays on Home, marked closed, with the closed-copy actions', async () => {
    const matchId = await seedMatch({ at: ago(HOUR) })
    signIn()
    answerServer(() => [closedRow])
    mountApp()
    await waitFor(async () => expect((await db.matches.get(matchId)).cloudBlock).toMatchObject({ code: 'OV_MATCH_CLOSED', claim: null }))
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('cloud-block-notice').textContent).toBe(en.cloudBlock.matchClosedDiffers))
    await waitFor(() => expect(selfCheckNotice()?.textContent).toContain(line('closedCopy')))
    await waitFor(() => expect(stateLabels(continueCard())).toContain(en.home.matchState.closed))
    await sleep(500)
    expect(homeShown()).toBe(true)
    expect(scoreboardShown()).toBe(false)
    expect(rowsReads()).toHaveLength(1)
    // a closed copy's scoring device is never asked
    expect(callsTo('/api/match/scorer')).toEqual([])

    // the notice's own action, and Continue: the closed-copy dialog
    fireEvent.click(button(en.home.selfCheck.show))
    await waitFor(() => expect(closedModal()).toBeTruthy())
    expect(button(en.cloudBlock.closedCopy.loadOfficial)).toBeTruthy()
    expect(button(en.cloudBlock.closedCopy.remove)).toBeTruthy()
    expect(button(en.header.scoresheet)).toBeTruthy()
    fireEvent.click(button(en.common.close))
    await waitFor(() => expect(closedModal()).toBeNull())
    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(closedModal()).toBeTruthy())
    expect(scoreboardShown()).toBe(false)
  })

  it('(b) the same offline, last active 7 days ago: Home, "Not checked", Continue still opens it', async () => {
    await seedMatch({ at: ago(7 * DAY) })
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(stateLabels(continueCard())).toContain(en.home.matchState.unchecked))
      await sleep(800)
      expect(homeShown()).toBe(true)
      expect(scoreboardShown()).toBe(false)
      // nothing flagged or found: no notice
      expect(selfCheckNotice()).toBeNull()
      fireEvent.click(button('Continue match'))
      await waitFor(() => expect(scoreboardShown()).toBe(true))
    } finally {
      onLine.mockRestore()
    }
  })

  it('(d) a live copy still open on the server and scored here: Home says so after one read, Continue opens it', async () => {
    await seedMatch({ at: ago(20 * MIN) })
    signIn()
    answerServer((keys) => (keys.includes(SEED) ? [openRow] : []), { scorer: { mine: true } })
    mountApp()
    await waitFor(() => expect(stateLabels(continueCard())).toContain(en.home.matchState.here))
    expect(rowsReads()).toHaveLength(1)
    expect(callsTo('/api/match/scorer')).toEqual([expect.objectContaining({ external_id: SEED, claim: false })])
    expect(homeShown()).toBe(true)
    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(scoreboardShown()).toBe(true))
    expect(closedModal()).toBeNull()
  })

  it('(d) a copy the server does not have is scored nowhere else: "Scoring here", its scoring device not asked', async () => {
    await seedMatch({ at: ago(20 * MIN) })
    signIn()
    answerServer(() => [])
    mountApp()
    await waitFor(() => expect(stateLabels(continueCard())).toContain(en.home.matchState.here))
    expect(callsTo('/api/match/scorer')).toEqual([])
  })

  it.each([
    ['fails (no network)', () => new TypeError('network down')],
    ['fails (server error)', () => ({ status: 503, body: { error: { message: 'Service unavailable' } } })],
    ['never answers', () => new Promise(() => {})]
  ])('(d) the server read %s: Home at once, "Not checked", Continue still opens it', async (_, answer) => {
    await seedMatch({ at: ago(20 * MIN) })
    signIn()
    answerServer(answer)
    mountApp()
    await waitFor(() => expect(stateLabels(continueCard())).toContain(en.home.matchState.unchecked))
    await waitFor(() => expect(rowsReads()).toHaveLength(1))
    expect(homeShown()).toBe(true)
    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(scoreboardShown()).toBe(true), { timeout: 8000 })
  })

  it('(e) two copies of one official match: the empty one is flagged and kept until Clean up', async () => {
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
      await waitFor(() => expect(selfCheckNotice()?.textContent).toContain(en.home.selfCheck.cleanUpLine_one.replace('{{game}}', '406970').replace('{{count}}', '1')))
      expect(await db.matches.get(empty)).toBeTruthy()
      fireEvent.click(button(en.home.selfCheck.cleanUp))
      await waitFor(() => expect(button(en.common.yes)).toBeTruthy())
      fireEvent.click(button(en.common.yes))
      await waitFor(() => expect(selfCheckNotice()?.textContent).toContain(line('removedCopy')))
      expect(await db.matches.get(empty)).toBeUndefined()
      expect(await db.teams.bulkGet([home, away])).toEqual([undefined, undefined])
      expect(await db.matches.get(kept)).toBeTruthy()
      expect(await db.events.where('matchId').equals(kept).count()).toBe(1)
      expect(homeShown()).toBe(true)
      // dismissed, it goes
      fireEvent.click(screen.getByRole('button', { name: en.home.selfCheck.dismiss }))
      await waitFor(() => expect(selfCheckNotice()).toBeNull())
    } finally {
      onLine.mockRestore()
    }
  })

  it('(e) two copies each holding something: both kept, one flagged; Remove deletes that copy only', async () => {
    const kept = await seedMatch({ at: ago(2 * DAY) })
    await db.events.add({ matchId: kept, setIndex: 1, type: 'lineup', payload: {}, seq: 2, ts: ago(2 * DAY) })
    const keptRow = await db.matches.get(kept)
    const other = await seedMatch({ at: ago(3 * DAY), created: ago(3 * DAY), ref1Signature: 'data:image/png;base64,AAA' })
    // an unsent write of the match (whichever copy wrote it): it stays
    await db.sync_queue.add({ resource: 'match', action: 'update', payload: { id: SEED, status: 'live' }, ts: ago(DAY), status: 'queued' })
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(selfCheckNotice()?.textContent).toContain(line('duplicateCopy')))
      expect(selfCheckNotice().textContent).not.toContain(en.home.selfCheck.cleanUp)
      expect(await db.matches.count()).toBe(2)
      // the device list shows both, as the same game twice
      await waitFor(() => expect(document.body.textContent).toContain(en.home.deviceMatches.sameGame))

      fireEvent.click(button(en.home.selfCheck.remove))
      await waitFor(() => expect(document.body.textContent).toContain(en.home.deviceMatches.removeCopyOnly))
      fireEvent.change(document.getElementById('delete-match-pin'), { target: { value: '482915' } })
      fireEvent.click(dialogButton(en.deleteMatch.delete))
      await waitFor(async () => expect(await db.matches.get(other)).toBeUndefined())
      await sleep(300)

      expect(await db.matches.get(kept)).toBeTruthy()
      expect(await db.teams.bulkGet([keptRow.homeTeamId, keptRow.awayTeamId])).not.toContain(undefined)
      expect(await db.events.where('matchId').equals(kept).count()).toBe(2)
      // the other copy's writes may be the kept one's: kept, and no server delete
      const jobs = await db.sync_queue.toArray()
      expect(jobs.filter(j => j.action === 'delete')).toEqual([])
      expect(jobs.filter(j => j.action === 'update' && j.status === 'queued')).toHaveLength(1)
      await waitFor(() => expect(selfCheckNotice()).toBeNull())
    } finally {
      onLine.mockRestore()
    }
  })

  it('(f) two live matches: Home continues the newest; a reload goes back to the one on the screen, not the one scored last', async () => {
    const alpha = await seedMatch({ seed_key: 'match_1_x', gameN: 406001, at: ago(2 * HOUR), created: ago(5 * HOUR), names: ['Alpha', 'Beta'], shorts: ['ALP', 'BET'] })
    await seedMatch({ seed_key: 'match_2_y', gameN: 406002, at: ago(5 * MIN), created: ago(3 * HOUR), names: ['Gamma', 'Delta'], shorts: ['GAM', 'DEL'] })
    const onLine = offlineDevice()
    try {
      const view = mountApp()
      await waitFor(() => expect(continueCard()?.textContent).toContain('Gamma – Delta'))
      expect(homeShown()).toBe(true)
      view.unmount()

      reloadInto(alpha)
      mountApp()
      await waitFor(() => expect(scoreboardShown()).toBe(true), { timeout: 5000 })
      await waitFor(() => expect(document.body.textContent).toMatch(/Alpha|ALP/))
      expect(document.body.textContent).not.toMatch(/Gamma|GAM\b/)
    } finally {
      onLine.mockRestore()
    }
  })

  it('(g) a test match: no server read, at start or on Continue', async () => {
    await seedMatch({ at: ago(20 * MIN), test: true, seed_key: 'test-match-1', matchInfoConfirmedAt: undefined })
    signIn()
    answerServer(() => [])
    mountApp()
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    await sleep(300)
    expect(stateLabels(continueCard())).toEqual([])
    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(scoreboardShown()).toBe(true), { timeout: 5000 })
    await sleep(300)
    expect(rowsReads()).toHaveLength(0)
    expect(callsTo('/api/match/scorer')).toEqual([])
  })

  it('(h) Continue on a copy the server has closed since the start: the closed-copy dialog', async () => {
    const matchId = await seedMatch({ at: ago(2 * DAY) })
    signIn()
    // open at the start, closed by the time Continue asks
    answerServer((keys, n) => (n === 1 ? [openRow] : [closedRow]))
    mountApp()
    await waitFor(() => expect(rowsReads()).toHaveLength(1))
    await waitFor(() => expect(button('Continue match')).toBeTruthy())
    await sleep(300)
    expect((await db.matches.get(matchId)).cloudBlock ?? null).toBeNull()

    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(closedModal()).toBeTruthy())
    expect(rowsReads()).toHaveLength(2)
    expect((await db.matches.get(matchId)).cloudBlock).toMatchObject({ code: 'OV_MATCH_CLOSED' })
    await sleep(300)
    expect(scoreboardShown()).toBe(false)
  })

  it('Continue offline opens at once, without asking', async () => {
    await seedMatch({ at: ago(2 * DAY) })
    signIn()
    answerServer(() => [closedRow])
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(button('Continue match')).toBeTruthy())
      fireEvent.click(button('Continue match'))
      await waitFor(() => expect(scoreboardShown()).toBe(true))
      expect(rowsReads()).toHaveLength(0)
    } finally {
      onLine.mockRestore()
    }
  })

  it('back after 15 minutes or more in the background, the check runs again; a few minutes away, it does not', async () => {
    const matchId = await seedMatch({ at: ago(2 * DAY) })
    signIn()
    answerServer((keys, n) => (n === 1 ? [openRow] : [closedRow]))
    const bg = backgroundClock()
    try {
      mountApp()
      await waitFor(() => expect(rowsReads()).toHaveLength(1))
      await waitFor(() => expect(button('Continue match')).toBeTruthy())
      // a few minutes away: nothing
      bg.hide()
      bg.advance(5 * MIN)
      bg.show()
      await sleep(300)
      expect(rowsReads()).toHaveLength(1)
      // sixteen minutes away: checked again
      bg.hide()
      bg.advance(16 * MIN)
      bg.show()
      await waitFor(() => expect(rowsReads()).toHaveLength(2))
      await waitFor(async () => expect((await db.matches.get(matchId)).cloudBlock).toMatchObject({ code: 'OV_MATCH_CLOSED' }))
      await waitFor(() => expect(selfCheckNotice()?.textContent).toContain(line('closedCopy')))
    } finally {
      bg.restore()
    }
  })
})
