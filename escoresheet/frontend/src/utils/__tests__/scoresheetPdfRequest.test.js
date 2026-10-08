// The match-end approval waits for the scoresheet window's PDF. Closing that
// window while it made the PDF left the scorer waiting up to 30 s with
// nothing to press (OpenBeach video 2026-10-08, the same code here). The
// wait must end at once on a closed window, a lost heartbeat or Cancel, and
// say why.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { waitForScoresheetPdf, openedWindowClosed, PDF_FAIL } from '../scoresheetPdfRequest'
import {
  MSG_PDF_BLOB, MSG_PDF_BLOB_FAILED, MSG_PDF_PROGRESS,
  reportPdfProgress, watchPdfWindowClose
} from '../appWindowGuest'
import { openAppWindow, currentInAppView } from '../openAppWindow'

const post = (data) => window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin }))

describe('waitForScoresheetPdf', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('resolves with the PDF the scoresheet sends after its heartbeat', async () => {
    const p = waitForScoresheetPdf(() => ({ ok: true, window: { closed: false } }))
    post({ type: MSG_PDF_PROGRESS, step: 'capture' })
    post({ type: MSG_PDF_BLOB, arrayBuffer: new ArrayBuffer(4), filename: 'a.pdf' })
    const r = await p
    expect(r.filename).toBe('a.pdf')
    expect(r.blob.type).toBe('application/pdf')
  })

  it('fails at once (no 30 s wait) when the window is closed', async () => {
    const w = { closed: false }
    const caught = waitForScoresheetPdf(() => ({ ok: true, window: w })).catch(e => e)
    w.closed = true
    await vi.advanceTimersByTimeAsync(600)
    const e = await caught
    expect(e.reason).toBe(PDF_FAIL.CLOSED)
  })

  it('fails at once when the page says it was closed (pagehide)', async () => {
    const caught = waitForScoresheetPdf(() => ({ ok: true, window: { closed: false } })).catch(e => e)
    post({ type: MSG_PDF_BLOB_FAILED, reason: 'closed' })
    expect((await caught).reason).toBe(PDF_FAIL.CLOSED)
  })

  it('fails when the heartbeat stops, and closes the window', async () => {
    const close = vi.fn()
    const progress = vi.fn()
    const caught = waitForScoresheetPdf(() => ({ ok: true, window: { closed: false }, close }), { stallMs: 8000, onProgress: progress }).catch(e => e)
    // no heartbeat yet: the window may still be loading, no stall
    await vi.advanceTimersByTimeAsync(9000)
    expect(close).not.toHaveBeenCalled()
    post({ type: MSG_PDF_PROGRESS, step: 'capture' })
    await vi.advanceTimersByTimeAsync(5000)
    post({ type: MSG_PDF_PROGRESS, step: 'capture' }) // still alive: the stall clock restarts
    await vi.advanceTimersByTimeAsync(7000)
    expect(close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    expect((await caught).reason).toBe(PDF_FAIL.STALLED)
    expect(close).toHaveBeenCalled()
    expect(progress).toHaveBeenCalledWith({ step: 'capture' })
  })

  it('Cancel (AbortSignal) ends the wait and closes the window', async () => {
    const ac = new AbortController()
    const close = vi.fn()
    const caught = waitForScoresheetPdf(() => ({ ok: true, window: { closed: false }, close }), { signal: ac.signal }).catch(e => e)
    ac.abort()
    expect((await caught).reason).toBe(PDF_FAIL.CANCELLED)
    expect(close).toHaveBeenCalled()
  })

  it('a blocked window fails as blocked', async () => {
    const e = await waitForScoresheetPdf(() => ({ ok: false, window: null })).catch(x => x)
    expect(e.reason).toBe(PDF_FAIL.BLOCKED)
  })

  it('a capture error from the page fails as failed', async () => {
    const caught = waitForScoresheetPdf(() => ({ ok: true, window: { closed: false } })).catch(e => e)
    post({ type: MSG_PDF_BLOB_FAILED })
    const e = await caught
    expect(e.reason).toBe(PDF_FAIL.FAILED)
  })

  it('an in-app view (Android) counts as closed through isClosed()', () => {
    expect(openedWindowClosed({ window: { closed: false }, isClosed: () => true })).toBe(true)
    expect(openedWindowClosed({ window: { closed: true } })).toBe(true)
    expect(openedWindowClosed({ window: null })).toBe(false)
  })
})

describe('the Android in-app view reports when it is closed', () => {
  it('isClosed() turns true once the view is gone (its iframe window keeps closed = false)', () => {
    const r = openAppWindow('/scoresheet/?matchId=7&action=getBlob', { platform: 'capacitor' })
    expect(r.isClosed()).toBe(false)
    currentInAppView().close()
    expect(r.isClosed()).toBe(true)
  })
})

describe('the scoresheet window side', () => {
  function fakeWin() {
    const listeners = {}
    const opener = { closed: false, postMessage: vi.fn() }
    return {
      opener,
      parent: null,
      location: { origin: 'http://x' },
      addEventListener: (t, f) => { (listeners[t] ||= []).push(f) },
      removeEventListener: (t, f) => { listeners[t] = (listeners[t] || []).filter(g => g !== f) },
      fire: (t) => (listeners[t] || []).forEach(f => f()),
      close: vi.fn()
    }
  }

  it('reports its heartbeat to the opener', () => {
    const w = fakeWin()
    expect(reportPdfProgress({ step: 'capture' }, w)).toBe(true)
    expect(w.opener.postMessage).toHaveBeenCalledWith({ type: MSG_PDF_PROGRESS, step: 'capture' }, 'http://x')
  })

  it('closing the window while busy tells the opener once, and not when idle', () => {
    const w = fakeWin()
    let busy = false
    const stop = watchPdfWindowClose(() => busy, w)
    w.fire('pagehide')
    expect(w.opener.postMessage).not.toHaveBeenCalled()
    busy = true
    w.fire('beforeunload')
    w.fire('pagehide')
    expect(w.opener.postMessage).toHaveBeenCalledTimes(1)
    expect(w.opener.postMessage.mock.calls[0][0]).toMatchObject({ type: MSG_PDF_BLOB_FAILED, reason: 'closed' })
    stop()
    busy = true
    w.fire('pagehide')
    expect(w.opener.postMessage).toHaveBeenCalledTimes(1)
  })
})
