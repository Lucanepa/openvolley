// Laptop run of 2026-10-08 (OV-16): Save on a signature pad closed the pad at
// once and the signature showed in its box 50-59 ms later (two frames: the
// box still empty with the pad gone). The pad now closes in the render that
// shows the saved signature.
// The real match-end screen and pad over the app's Dexie database (fake IndexedDB).
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { render, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import '../../i18n'
import { AlertProvider } from '../../contexts/AlertContext'
import { ScaleProvider } from '../../contexts/ScaleContext'
import { LoggingProvider } from '../../contexts/LoggingContext'
import { db } from '../../db/db'
import MatchEnd from '../MatchEnd'

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => null }))

class OfflineSocket {
  constructor() { this.readyState = 3 }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

const SIG = 'data:image/png;base64,DRAWN'
let saved
beforeAll(() => {
  saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.WebSocket = OfflineSocket
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline (test)')))
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  // jsdom has no 2D canvas
  const ctx = { scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {}, fillRect() {}, drawImage() {} }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(SIG)
})
afterAll(() => {
  cleanup()
  globalThis.WebSocket = saved.WebSocket
  globalThis.fetch = saved.fetch
  globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act
  vi.restoreAllMocks()
})

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

describe('MatchEnd: saving a signature drawn on the pad', () => {
  it('the pad closes in the change that shows the signature', async () => {
    const home = await db.teams.add({ name: 'Home VC' })
    const away = await db.teams.add({ name: 'Away VC' })
    await db.players.bulkAdd([
      { teamId: home, number: 7, firstName: 'Lea', lastName: 'Muster', isCaptain: true },
      { teamId: away, number: 9, firstName: 'Mia', lastName: 'Meier', isCaptain: true }
    ])
    const matchId = await db.matches.add({
      homeTeamId: home, awayTeamId: away, status: 'ended', test: true, coinTossTeamA: 'home', coinTossTeamB: 'away'
    })
    for (const index of [1, 2, 3]) {
      await db.sets.add({ matchId, index, homePoints: 25, awayPoints: 20, finished: true })
    }

    render(<ScaleProvider><AlertProvider><LoggingProvider><MatchEnd matchId={matchId} onGoHome={() => {}} /></LoggingProvider></AlertProvider></ScaleProvider>)
    const box = () => document.querySelector('[data-testid="signature-slot-captain-a"]')
    await waitFor(() => expect(box()).toBeTruthy(), { timeout: 10000 })
    fireEvent.click(within(box()).getByText('Tap to sign'))
    const pad = () => document.querySelector('[role=dialog] canvas')
    await waitFor(() => expect(pad()).toBeTruthy())
    await sleep(150) // the pad sets its canvas up in a timer
    fireEvent.mouseDown(pad(), { clientX: 10, clientY: 10 })
    fireEvent.mouseMove(pad(), { clientX: 40, clientY: 30 })
    fireEvent.mouseUp(pad(), { clientX: 40, clientY: 30 })
    const saveButton = () => [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)
    await waitFor(() => expect(saveButton()).toBeTruthy())

    // what each committed change shows: the pad, the signature in its box
    const states = []
    const observer = new MutationObserver(() => {
      states.push({ pad: !!pad(), signed: !!box()?.querySelector(`img[src="${SIG}"]`) })
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    fireEvent.click(saveButton())
    await waitFor(async () => expect((await db.matches.get(matchId)).homePostGameCaptainSignature).toBe(SIG))
    await sleep(400)
    observer.disconnect()

    expect(states.at(-1)).toEqual({ pad: false, signed: true })
    // never the pad gone with the box still empty
    expect(states.filter(st => !st.pad && !st.signed)).toEqual([])
    cleanup()
  }, 30000)
})
