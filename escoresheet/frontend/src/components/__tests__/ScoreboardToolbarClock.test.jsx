// Point Hub board, 2026-11-08: the date and time at the top left of the
// scoring screen read "08/11/2026, 09:51:10". The owner asked for no comma:
// the date and the time as the browser writes them, joined by a space.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { render, waitFor, cleanup, fireEvent } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import Scoreboard from '../Scoreboard'

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

let saved
beforeAll(() => {
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterAll(() => {
  cleanup()
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

describe('Scoreboard: the toolbar clock', () => {
  it('shows the date and the time with a space between them, no comma', async () => {
    const home = await db.teams.add({ name: 'Home' })
    const away = await db.teams.add({ name: 'Away' })
    const matchId = await db.matches.add({ homeTeamId: home, awayTeamId: away, status: 'live', test: true })
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    await waitFor(() => expect(document.querySelector('.toolbar-clock')).toBeTruthy())
    const text = document.querySelector('.toolbar-clock').textContent
    expect(text).not.toContain(',')
    const now = new Date()
    const day = now.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
    expect(text.startsWith(`${day} `)).toBe(true)
    expect(text.slice(day.length + 1)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    cleanup()
  })

  // Owner, 20.11.2026 (tablet): the chevron had a 16px strip of its own under
  // the toolbar, ruled above and below. It now sits beside the clock in the
  // bar; folded away, one slim unruled row keeps the clock and the chevron.
  it('folds the toolbar with a chevron beside the clock, and brings it back', async () => {
    const home = await db.teams.add({ name: 'Home' })
    const away = await db.teams.add({ name: 'Away' })
    const matchId = await db.matches.add({ homeTeamId: home, awayTeamId: away, status: 'live', test: true })
    await db.sets.add({ matchId, index: 1, homePoints: 0, awayPoints: 0, finished: false })

    render(<ScaleProvider><AlertProvider><LoggingProvider><Scoreboard matchId={matchId} /></LoggingProvider></AlertProvider></ScaleProvider>)
    await waitFor(() => expect(document.querySelector('.toolbar-clock')).toBeTruthy())
    const toolbar = document.querySelector('.match-toolbar')
    const chevron = document.querySelector('[data-testid="toolbar-toggle"]')
    expect(toolbar.contains(chevron)).toBe(true)
    expect(chevron.parentElement).toBe(document.querySelector('.toolbar-clock').parentElement)
    expect(chevron.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-testid="toolbar-strip"]')).toBeNull()

    fireEvent.click(chevron)
    await waitFor(() => expect(document.querySelector('[data-testid="toolbar-strip"]')).toBeTruthy())
    expect(toolbar.style.display).toBe('none')
    const strip = document.querySelector('[data-testid="toolbar-strip"]')
    expect(strip.style.borderBottom).toBe('')
    expect(strip.querySelector('[data-testid="toolbar-strip-clock"]')).toBeTruthy()
    // both clocks have their time in the fixed box (styles.css
    // .toolbar-clock-time), the strip's at its line height of 1
    expect(document.querySelector('.toolbar-clock > .toolbar-clock-time')).toBeTruthy()
    const stripClock = strip.querySelector('[data-testid="toolbar-strip-clock"]')
    expect(stripClock.querySelector(':scope > .toolbar-clock-time')).toBeTruthy()
    expect(stripClock.style.getPropertyValue('--clock-lh')).toBe('1')
    const folded = strip.querySelector('[data-testid="toolbar-toggle"]')
    expect(folded.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(folded)
    await waitFor(() => expect(document.querySelector('[data-testid="toolbar-strip"]')).toBeNull())
    expect(document.querySelector('.match-toolbar').style.display).toBe('grid')
    cleanup()
  })
})
