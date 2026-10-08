// Diagnostics mode, checked from outside: off costs nothing (no listener,
// observer, database or Dexie middleware), and on, a PIN typed or shown on
// screen never reaches a line.
import 'fake-indexeddb/auto'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { installDiagnostics, setDiagnosticsEnabled } from '../index'
import { diagActive, flushDiagnostics, startRecorder, stopRecorder } from '../recorder'
import { installWatchers } from '../watchers'
import { createJumpDetector } from '../jumps'
import { DIAG_STORAGE_KEY, DIAG_SESSION_KEY } from '../switch'

const frame = () => new Promise(r => setTimeout(r, 40))

describe('diagnostics off', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.removeItem(DIAG_STORAGE_KEY)
    sessionStorage.removeItem(DIAG_SESSION_KEY)
  })

  it('registers no listener, observer, database or middleware', () => {
    const winAdd = vi.spyOn(window, 'addEventListener')
    const docAdd = vi.spyOn(document, 'addEventListener')
    const idbOpen = vi.spyOn(indexedDB, 'open')
    const ro = vi.fn()
    const mo = vi.fn()
    const po = vi.fn()
    window.ResizeObserver = ro
    const realMO = window.MutationObserver
    window.MutationObserver = mo
    window.PerformanceObserver = po
    const db = { use: vi.fn(), isOpen: () => false }
    try {
      const state = installDiagnostics({ db, win: window })
      expect(state.on).toBe(false)
      expect(diagActive()).toBe(false)
      expect(winAdd).not.toHaveBeenCalled()
      expect(docAdd).not.toHaveBeenCalled()
      expect(idbOpen).not.toHaveBeenCalled()
      expect(ro).not.toHaveBeenCalled()
      expect(mo).not.toHaveBeenCalled()
      expect(po).not.toHaveBeenCalled()
      expect(db.use).not.toHaveBeenCalled()
    } finally {
      delete window.ResizeObserver
      delete window.PerformanceObserver
      window.MutationObserver = realMO
    }
  })

  it('the Options switch starts it, and turning it off stops every listener', async () => {
    const added = []
    const removed = []
    const realAdd = document.addEventListener.bind(document)
    const realRemove = document.removeEventListener.bind(document)
    vi.spyOn(document, 'addEventListener').mockImplementation((t, f, o) => { added.push(t); realAdd(t, f, o) })
    vi.spyOn(document, 'removeEventListener').mockImplementation((t, f, o) => { removed.push(t); realRemove(t, f, o) })
    const on = await setDiagnosticsEnabled(true, { win: window })
    expect(on).toMatchObject({ on: true, source: 'options', option: true })
    expect(added).toContain('click')
    const off = await setDiagnosticsEnabled(false, { win: window })
    expect(off).toMatchObject({ on: false, option: false })
    expect(diagActive()).toBe(false)
    expect(removed.sort()).toEqual(added.sort())
  })
})

describe('diagnostics on: no PIN in any line', () => {
  let sink, stop
  afterEach(async () => {
    stop?.()
    await stopRecorder()
    document.body.innerHTML = ''
  })

  it('typing a PIN into a field, clicking a shown PIN or a keypad, and a dialog showing a PIN leave no digits', async () => {
    sink = { lines: [], write: async (b) => { sink.lines.push(...b) } }
    startRecorder({ sink, sessionId: 'p', storage: window.sessionStorage })
    stop = installWatchers({ win: window, appVersion: 't', platform: 'web', source: 'url' })
    document.body.innerHTML = `
      <input id="game-pin" type="text" inputmode="numeric">
      <span class="pin-text" title="PIN 482913">482 913</span>
      <div class="keypad"><button class="key">4</button><button class="key" aria-label="8">8</button></div>`
    const input = document.getElementById('game-pin')
    input.focus()
    for (const k of '482913') {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: `Digit${k}`, bubbles: true }))
      input.value += k
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    input.click()
    document.querySelector('.pin-text').click()
    for (const b of document.querySelectorAll('.key')) b.click()
    const dlg = document.createElement('div')
    dlg.setAttribute('role', 'dialog')
    dlg.setAttribute('aria-label', 'Game PIN 482913')
    dlg.innerHTML = '<h2>Game PIN 482913</h2>'
    document.body.appendChild(dlg)
    await frame()
    dlg.setAttribute('aria-label', 'Team PIN 4829')
    dlg.querySelector('h2').textContent = 'Team PIN 4829'
    await frame()
    await flushDiagnostics()
    const text = sink.lines.join('\n')
    expect(sink.lines.length).toBeGreaterThan(3)
    expect(text).not.toMatch(/4829|482 913|Digit/)
    expect(text).toMatch(/"k":"dialog.open"/)
  })
})

describe('jump detection, adversarial', () => {
  it('a bounce at 499 ms is a jump; at 501 ms, a one-way resize or a drag that never returns is not', () => {
    const j = createJumpDetector()
    j.observe('a', 100, 50, 0)
    j.observe('a', 110, 55, 1000)
    expect(j.observe('a', 100, 50, 1499)).toMatchObject({ size: [100, 50], ms: 499 })
    const k = createJumpDetector()
    k.observe('b', 100, 50, 0)
    k.observe('b', 110, 55, 1000)
    expect(k.observe('b', 100, 50, 1501)).toBeNull()
    const d = createJumpDetector()
    let hits = 0
    for (let i = 0; i <= 40; i++) if (d.observe('c', 1200 + i * 5, 800, i * 16)) hits++
    expect(hits).toBe(0)
  })
})
