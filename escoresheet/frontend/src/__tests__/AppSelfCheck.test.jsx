// The self-check on open (utils/deviceSelfCheck). 2026-10-27: the owner's
// desktop app (3.0.5) opened straight on the scoring screen of official match
// 406970, "Online · Connected", Start set, as if the match were live. That
// copy had only reached the coin toss on the PC on 20.10; the match was
// continued and closed on a phone the same day. The PC never learnt: a
// device hears of a close only when a write of its copy is refused, and this
// copy had written nothing since. A stale copy reopened like that is how
// duplicate scoring and duplicate records start.
//
// The server is the app's own /api/db read, answered here through fetch;
// everything else stays offline.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup, screen } from '@testing-library/react'
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
  globalThis.fetch.mockImplementation(() => Promise.reject(new TypeError('offline (test)')))
})

const SEED = 'match_1792518507614_u2sbmb'
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms) => new Date(Date.now() - ms).toISOString()

// An official match on its third set, last scored `at`
async function seedMatch({ at = ago(HOUR), created = at, names = ['Home', 'Away'], shorts = ['HOM', 'AWA'], ...fields } = {}) {
  const home = await db.teams.add({ name: names[0], shortName: shorts[0] })
  const away = await db.teams.add({ name: names[1], shortName: shorts[1] })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
  ]))
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', createdAt: created, matchInfoConfirmedAt: created,
    seed_key: SEED, gameN: 406970, gamePin: '482915',
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
    homeCoachSignature: 'x', homeCaptainSignature: 'x', awayCoachSignature: 'x', awayCaptainSignature: 'x',
    ...fields
  })
  await db.sets.bulkAdd([
    { matchId, index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: created, endTime: created },
    { matchId, index: 2, homePoints: 20, awayPoints: 25, finished: true, startTime: created, endTime: created },
    { matchId, index: 3, homePoints: 12, awayPoints: 10, finished: false, startTime: created }
  ])
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: at })
  return matchId
}

// A session on this device (the self-check reads the server only signed in)
function signIn() {
  localStorage.setItem('api_auth_token', JSON.stringify({
    access_token: 'token-test', expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    user: { id: '00000000-0000-4000-8000-0000000000aa' }
  }))
}

const jsonResponse = (body, status = 200) => ({
  ok: status < 400, status, headers: { get: (h) => (/content-type/i.test(h) ? 'application/json' : null) }, json: async () => body
})
// The self-check's read: the matches of these external ids, in one request
const isRowsRead = (body) => body?.table === 'matches' && body?.action === 'select' &&
  (body.params?.filters || []).some(f => f.type === 'in' && f.column === 'external_id')
const rowsReads = () => globalThis.fetch.mock.calls.filter(([, init]) => {
  try { return isRowsRead(JSON.parse(init?.body || 'null')) } catch { return false }
})
// answer(keys, n) -> rows | { status, body } | an Error (network) | a promise
function answerServer(answer) {
  let n = 0
  globalThis.fetch.mockImplementation(async (url, init) => {
    let body = null
    try { body = JSON.parse(init?.body || 'null') } catch { /* not JSON */ }
    if (String(url).endsWith('/api/db') && isRowsRead(body)) {
      const out = await answer(body.params.filters.find(f => f.type === 'in').value, ++n)
      if (out instanceof Error) throw out
      if (out && !Array.isArray(out) && out.status) return jsonResponse(out.body, out.status)
      return jsonResponse({ data: out })
    }
    throw new TypeError('offline (test)')
  })
}
const closedRow = { id: 'c0ffee00-0000-4000-8000-000000000001', external_id: SEED, status: 'final', closed_at: '2026-10-20T18:40:00.000Z' }
const openRow = { ...closedRow, status: 'live', closed_at: null }

function offlineDevice() {
  return vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
}

const closedModal = () => document.querySelector('[data-testid="closed-copy-modal"]')
const selfCheckNotice = () => document.querySelector('[data-testid="self-check-notice"]')
// a button of the open dialog (the device list behind it has its own Delete)
const dialogButton = (text) => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === text && !b.disabled)
const homeShown = () => !!button('Restore match')
// the Scoreboard's own screen (its set and rally controls), not the home screen
const scoreboardShown = () => !homeShown() && !closedModal() && /Set 3|Start rally|Start set/.test(document.body.textContent)
// (written before the strings existed: a missing one fails as a missing line)
const strings = () => en.home.selfCheck || {}
const line = (key, game = '406970') => (strings()[key] || `home.selfCheck.${key}`).replace('{{game}}', game)

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
    await sleep(500)
    expect(homeShown()).toBe(true)
    expect(scoreboardShown()).toBe(false)
    expect(rowsReads()).toHaveLength(1)

    // the notice's own action, and Continue: the closed-copy dialog
    fireEvent.click(button(strings().show))
    await waitFor(() => expect(closedModal()).toBeTruthy())
    expect(button(en.cloudBlock.closedCopy.loadOfficial)).toBeTruthy()
    expect(button(en.cloudBlock.closedCopy.remove)).toBeTruthy()
    fireEvent.click(button(en.common.close))
    await waitFor(() => expect(closedModal()).toBeNull())
    fireEvent.click(button('Continue match'))
    await waitFor(() => expect(closedModal()).toBeTruthy())
    expect(scoreboardShown()).toBe(false)
  })

  it('(b) the same offline, last active 7 days ago: stays on Home (the stale rule), Continue still opens it', async () => {
    await seedMatch({ at: ago(7 * DAY) })
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(button('Continue match')).toBeTruthy())
      await sleep(800)
      expect(homeShown()).toBe(true)
      expect(scoreboardShown()).toBe(false)
      // nothing flagged or cleaned: no notice
      expect(selfCheckNotice()).toBeNull()
      fireEvent.click(button('Continue match'))
      await waitFor(() => expect(scoreboardShown()).toBe(true))
    } finally {
      onLine.mockRestore()
    }
  })

  it('(c) a live match last active 20 minutes ago, offline: the scoring screen opens at once', async () => {
    await seedMatch({ at: ago(20 * MIN) })
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(scoreboardShown()).toBe(true), { timeout: 5000 })
    } finally {
      onLine.mockRestore()
    }
  })

  it('(d) a live copy still open on the server opens, after one read', async () => {
    await seedMatch({ at: ago(20 * MIN) })
    signIn()
    answerServer((keys) => (keys.includes(SEED) ? [openRow] : []))
    mountApp()
    await waitFor(() => expect(scoreboardShown()).toBe(true), { timeout: 5000 })
    expect(rowsReads()).toHaveLength(1)
    expect(closedModal()).toBeNull()
  })

  it.each([
    ['fails (no network)', () => new TypeError('network down')],
    ['fails (server error)', () => ({ status: 503, body: { error: { message: 'Service unavailable' } } })],
    ['never answers (timeout)', () => new Promise(() => {})]
  ])('(d) the server read %s: the live copy opens', async (_, answer) => {
    await seedMatch({ at: ago(20 * MIN) })
    signIn()
    answerServer(answer)
    mountApp()
    await waitFor(() => expect(scoreboardShown()).toBe(true), { timeout: 8000 })
    expect(rowsReads()).toHaveLength(1)
  })

  it('(e) two copies of one official match: the empty one is removed, the other kept', async () => {
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
      await waitFor(() => expect(selfCheckNotice()?.textContent).toContain(line('removedCopy')))
      expect(await db.matches.get(empty)).toBeUndefined()
      expect(await db.teams.bulkGet([home, away])).toEqual([undefined, undefined])
      expect(await db.matches.get(kept)).toBeTruthy()
      expect(await db.events.where('matchId').equals(kept).count()).toBe(1)
      expect(homeShown()).toBe(true)
      // dismissed, it goes
      fireEvent.click(screen.getByRole('button', { name: strings().dismiss || 'home.selfCheck.dismiss' }))
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
      expect(await db.matches.count()).toBe(2)
      // the device list shows both, as the same game twice
      await waitFor(() => expect(document.body.textContent).toContain(en.home.deviceMatches.sameGame))

      fireEvent.click(button(strings().remove))
      await waitFor(() => expect(document.body.textContent).toContain(en.home.deviceMatches.removeCopyOnly || 'home.deviceMatches.removeCopyOnly'))
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

  it('(f) two live matches: the most recent one is resumed', async () => {
    // the older-scored one was added first (the start-up used to open it)
    await seedMatch({ seed_key: 'match_1_x', gameN: 406001, at: ago(2 * HOUR), created: ago(5 * HOUR), names: ['Alpha', 'Beta'], shorts: ['ALP', 'BET'] })
    await seedMatch({ seed_key: 'match_2_y', gameN: 406002, at: ago(5 * MIN), created: ago(3 * HOUR), names: ['Gamma', 'Delta'], shorts: ['GAM', 'DEL'] })
    const onLine = offlineDevice()
    try {
      mountApp()
      await waitFor(() => expect(scoreboardShown()).toBe(true), { timeout: 5000 })
      await waitFor(() => expect(document.body.textContent).toMatch(/Gamma|GAM/))
      expect(document.body.textContent).not.toMatch(/Alpha|ALP\b/)
    } finally {
      onLine.mockRestore()
    }
  })

  it('(g) a test match: no server read', async () => {
    await seedMatch({ at: ago(20 * MIN), test: true, seed_key: 'test-match-1', matchInfoConfirmedAt: undefined })
    signIn()
    answerServer(() => [])
    mountApp()
    await waitFor(() => expect(scoreboardShown()).toBe(true), { timeout: 5000 })
    await sleep(300)
    expect(rowsReads()).toHaveLength(0)
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

  it('back after an hour in the background, the check runs again', async () => {
    const matchId = await seedMatch({ at: ago(2 * DAY) })
    signIn()
    answerServer((keys, n) => (n === 1 ? [openRow] : [closedRow]))
    let visibility = 'visible'
    const state = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const realNow = Date.now.bind(Date)
    let offset = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
    try {
      mountApp()
      await waitFor(() => expect(rowsReads()).toHaveLength(1))
      await waitFor(() => expect(button('Continue match')).toBeTruthy())
      // a few minutes away: nothing
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      offset = 5 * MIN
      visibility = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
      await sleep(300)
      expect(rowsReads()).toHaveLength(1)
      // two hours away: checked again
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      offset += 2 * HOUR
      visibility = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
      await waitFor(() => expect(rowsReads()).toHaveLength(2))
      await waitFor(async () => expect((await db.matches.get(matchId)).cloudBlock).toMatchObject({ code: 'OV_MATCH_CLOSED' }))
      await waitFor(() => expect(selfCheckNotice()?.textContent).toContain(line('closedCopy')))
    } finally {
      clock.mockRestore()
      state.mockRestore()
    }
  })
})
