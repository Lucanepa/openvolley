// The native backup status while scoring (performance pass, 22.11): in the
// apps a backup file follows nearly every scoring write, and its new status
// re-rendered App, and with it the whole scoring screen. App follows the
// status only where it shows it (Home, Match Setup, Options): on the
// scoring screen a new status renders nothing, and Match Setup opened after
// it shows the status of now.
//
// The backup platform is the Android app's, with an engine whose status the
// test publishes; the Scoreboard and MainHeader are stubs that count renders
// (MainHeader renders with every App render).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, cleanup, act } from '@testing-library/react'
import { offline, online, mountApp, sleep } from './appMount'
import { db } from '../db/db'
import { seedMatch, reloadInto } from './selfCheckFixtures'

const seen = vi.hoisted(() => ({ scoreboard: [], app: 0 }))
const engine = vi.hoisted(() => {
  let status = { folder: 'Documents/OpenVolley', lastBackup: null, lastFile: null, error: null, count: 0 }
  const listeners = new Set()
  return {
    api: {
      getStatus: () => status,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      notify() {},
      warm: async () => false,
      async backupNow() { return status },
      async flush() {},
      async loadFolder() { return status.folder },
      cleanup: async () => {},
      lastWrittenOf: () => null
    },
    publish(patch) {
      status = { ...status, ...patch }
      listeners.forEach(l => l())
    }
  }
})
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
vi.mock('../utils/nativeBackup/platform', async (importOriginal) => ({
  ...(await importOriginal()),
  detectBackupPlatform: () => 'capacitor',
  createPlatformStore: async () => ({})
}))
vi.mock('../utils/nativeBackup/engine', () => ({ createNativeBackupEngine: () => engine.api }))
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
async function rendersDuring(fn) {
  const app = seen.app
  const scoreboard = seen.scoreboard.length
  await act(async () => { await fn() })
  await sleep(300)
  return { app: seen.app - app, scoreboard: seen.scoreboard.length - scoreboard }
}

describe('the native backup status while scoring', () => {
  it('a backup file renders neither App nor the Scoreboard; Match Setup then shows the status of now', async () => {
    const matchId = await seedMatch()
    reloadInto(matchId, 'scoreboard')
    mountApp()
    await waitFor(() => expect(stubShown()).toBe(true))
    await sleep(600)

    const r = await rendersDuring(() => engine.publish({ lastBackup: new Date(), lastFile: 'a.json', count: 1 }))
    expect(r).toEqual({ app: 0, scoreboard: 0 })
    // the next file fails: nothing renders either
    const failed = await rendersDuring(() => engine.publish({ error: 'The disk is full (test)' }))
    expect(failed).toEqual({ app: 0, scoreboard: 0 })

    // Match Setup (the scoreboard's Menu): its backup panel shows that error
    await act(async () => { await seen.scoreboard[0].onOpenMatchSetup() })
    await waitFor(() => expect([...document.querySelectorAll('[role="alert"]')].map(a => a.textContent)).toContain('The disk is full (test)'))
    engine.publish({ error: null })
  })

  it('on Home a backup status re-renders App as before', async () => {
    mountApp()
    await waitFor(() => expect(document.body.textContent).toMatch(/Restore match/))
    await sleep(600)
    const r = await rendersDuring(() => engine.publish({ lastBackup: new Date(), count: 2 }))
    expect(r.app).toBeGreaterThan(0)
  })
})
