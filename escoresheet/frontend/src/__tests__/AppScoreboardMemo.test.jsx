// The scoring screen does not re-render with App (performance pass, 22.11):
// App renders while scoring on its own live queries, the sync status and the
// native backup status, and each of those was a full Scoreboard render (a
// 25k-line component, 20-35 ms on the hall's Tab A7 Lite). Scoreboard is
// memoized at App's import and gets callbacks of one identity that always run
// App's newest closure.
//
// The Scoreboard is replaced by a stub that counts its renders and keeps its
// props; MainHeader by a stub that counts App's renders (it renders with every
// App render: no memo, no state of its own).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, cleanup, act } from '@testing-library/react'
import { offline, online, mountApp, sleep } from './appMount'
import { db } from '../db/db'
import { seedMatch, reloadInto } from './selfCheckFixtures'

const seen = vi.hoisted(() => ({ scoreboard: [], app: 0 }))
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
vi.mock('../components/Scoreboard', () => ({
  default: function ScoreboardStub(props) {
    seen.scoreboard.push(props)
    return <div data-testid="scoreboard-stub">scoring screen</div>
  },
  preloadScoreboard: vi.fn(async () => undefined)
}))
vi.mock('../components/MainHeader', () => ({
  default: function MainHeaderStub() {
    seen.app++
    return null
  }
}))

beforeAll(offline)
afterAll(online)
beforeEach(async () => {
  cleanup()
  await Promise.all(db.tables.map(table => table.clear()))
  sessionStorage.clear()
  seen.scoreboard.length = 0
  seen.app = 0
})

const stubShown = () => !!document.querySelector('[data-testid="scoreboard-stub"]')

// The match on its scoring screen (a reload lands there), every read settled
async function openScoringScreen(fields = {}) {
  const matchId = await seedMatch(fields)
  reloadInto(matchId, 'scoreboard')
  mountApp()
  await waitFor(() => expect(stubShown()).toBe(true))
  await sleep(600)
  return matchId
}

// App's and the Scoreboard's renders during `fn` (and a moment after it)
async function rendersDuring(fn) {
  const app = seen.app
  const scoreboard = seen.scoreboard.length
  await act(async () => { await fn() })
  await sleep(400)
  return { app: seen.app - app, scoreboard: seen.scoreboard.length - scoreboard }
}

describe('App renders stop at the scoring screen', () => {
  it('the device going offline and online again re-renders App, not the Scoreboard', async () => {
    await openScoringScreen()
    for (const type of ['offline', 'online']) {
      const r = await rendersDuring(() => { window.dispatchEvent(new Event(type)) })
      expect(r.app, type).toBeGreaterThan(0)
      expect(r.scoreboard, type).toBe(0)
    }
  })

  it('a write of the match row re-renders App, not the Scoreboard', async () => {
    const matchId = await openScoringScreen()
    const r = await rendersDuring(() => db.matches.update(matchId, { updatedAt: new Date().toISOString() }))
    expect(r.app).toBeGreaterThan(0)
    expect(r.scoreboard).toBe(0)
  })

  it('a point (a sets and an events write) re-renders neither App nor the Scoreboard', async () => {
    const matchId = await openScoringScreen()
    const set3 = await db.sets.where({ matchId }).filter(s => s.index === 3).first()
    const r = await rendersDuring(async () => {
      await db.transaction('rw', db.sets, db.events, async () => {
        await db.events.add({ matchId, setIndex: 3, type: 'point', payload: { team: 'home' }, seq: 2, ts: new Date().toISOString() })
        await db.sets.update(set3.id, { homePoints: 13 })
      })
    })
    expect(r).toEqual({ app: 0, scoreboard: 0 })
  })

  it("the callbacks keep one identity, and onFinishSet runs App's finishSet (Match End opens)", async () => {
    const matchId = await openScoringScreen({ bestOf: 3 })
    const first = seen.scoreboard[0]
    // App renders a few times in between (its queries, the connection)
    await act(async () => { await db.matches.update(matchId, { updatedAt: new Date().toISOString() }) })
    await sleep(300)
    for (const props of seen.scoreboard) {
      for (const k of ['onFinishSet', 'onOpenSetup', 'onOpenMatchSetup', 'onOpenMatchInfo', 'onOpenCoinToss']) {
        expect(typeof props[k], k).toBe('function')
        expect(props[k], k).toBe(first[k])
      }
    }
    // Set 3 won by the home team: 2:1 in a best of 3
    const set3 = await db.sets.where({ matchId }).filter(s => s.index === 3).first()
    await db.sets.update(set3.id, { homePoints: 15, awayPoints: 10, finished: true })
    await act(async () => { await first.onFinishSet({ ...set3, homePoints: 15, awayPoints: 10, finished: true }) })
    await waitFor(() => expect(document.body.textContent).toMatch(/Match complete/))
    expect((await db.matches.get(matchId)).status).toBe('ended')
  })

  it('onOpenMatchInfo opens the match info over the scoring screen', async () => {
    await openScoringScreen()
    const first = seen.scoreboard[0]
    await act(async () => { first.onOpenMatchInfo() })
    await waitFor(() => expect(stubShown()).toBe(false))
  })
})
