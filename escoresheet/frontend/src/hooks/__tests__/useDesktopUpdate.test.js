import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useDesktopUpdate } from '../useDesktopUpdate'

const READY = {
  kind: 'nsis',
  phase: 'ready',
  current: '2.2.0',
  available: { version: '2.2.1', notes: null, date: null },
  autoCheck: true,
  autoInstall: true,
  blockers: [],
  canRestart: true,
  manual: false,
}

/** A window of the desktop app's scoretable, with the app's commands faked. */
function appWindow(handlers = {}, label = 'main') {
  const win = new EventTarget()
  const invoke = vi.fn(async (cmd, args) => {
    const h = handlers[cmd]
    if (typeof h === 'function') return h(args)
    return h ?? null
  })
  win.__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label } } }
  return { win, invoke }
}

const updateEvent = (detail) => new CustomEvent('ov-update', { detail })

afterEach(() => vi.restoreAllMocks())

describe('useDesktopUpdate', () => {
  it('outside the desktop app it does nothing', () => {
    const { result } = renderHook(() => useDesktopUpdate({ win: new EventTarget() }))
    expect(result.current.active).toBe(false)
    expect(result.current.status).toBeNull()
  })

  it('a scoresheet window of the app is not the scoretable', () => {
    const { win, invoke } = appWindow({ update_status: READY }, 'popup-1')
    const { result } = renderHook(() => useDesktopUpdate({ win }))
    expect(result.current.active).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reads the status, then follows the app\'s ov-update events', async () => {
    const { win, invoke } = appWindow({ update_status: { ...READY, phase: 'idle', available: null } })
    const { result } = renderHook(() => useDesktopUpdate({ win }))
    expect(result.current.active).toBe(true)
    await waitFor(() => expect(result.current.status?.phase).toBe('idle'))
    expect(invoke).toHaveBeenCalledWith('update_status')
    act(() => { win.dispatchEvent(updateEvent({ ...READY, phase: 'downloading', got: 10, total: 100 })) })
    expect(result.current.status).toMatchObject({ phase: 'downloading', got: 10 })
    act(() => { win.dispatchEvent(updateEvent(READY)) })
    expect(result.current.status.phase).toBe('ready')
    // junk is ignored
    act(() => { win.dispatchEvent(updateEvent(null)) })
    expect(result.current.status.phase).toBe('ready')
  })

  it('check, settings and restart go to the app', async () => {
    const { win, invoke } = appWindow({
      update_status: READY,
      update_check_now: { ...READY, phase: 'checking', manual: true },
      update_set_prefs: (args) => ({ ...READY, autoInstall: args.autoInstall ?? true }),
      update_install_now: READY,
    })
    const { result } = renderHook(() => useDesktopUpdate({ win }))
    await waitFor(() => expect(result.current.status).not.toBeNull())
    await act(() => result.current.checkNow())
    expect(invoke).toHaveBeenCalledWith('update_check_now', { reason: 'manual' })
    expect(result.current.status.phase).toBe('checking')
    await act(() => result.current.setPrefs({ autoInstall: false }))
    expect(invoke).toHaveBeenCalledWith('update_set_prefs', { autoInstall: false })
    expect(result.current.status.autoInstall).toBe(false)
    let r
    await act(async () => { r = await result.current.installNow() })
    expect(r).toEqual({ ok: true })
  })

  it('a closed gate comes back as the reasons; nothing installs', async () => {
    const blockers = [{ kind: 'matchLive' }, { kind: 'tablets', count: 2 }]
    const { win } = appWindow({
      update_status: READY,
      update_install_now: () => { throw { code: 'blocked', blockers } },
    })
    const { result } = renderHook(() => useDesktopUpdate({ win }))
    await waitFor(() => expect(result.current.status).not.toBeNull())
    let r
    await act(async () => { r = await result.current.installNow() })
    expect(r).toEqual({ ok: false, error: { code: 'blocked', blockers } })
  })

  it('a sign-in asks the app to check, once however many components listen', async () => {
    const { win, invoke } = appWindow({ update_status: READY })
    const a = renderHook(() => useDesktopUpdate({ win }))
    const b = renderHook(() => useDesktopUpdate({ win }))
    await waitFor(() => expect(a.result.current.status).not.toBeNull())
    act(() => { win.dispatchEvent(new CustomEvent('ov-signed-in')) })
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'update_check_now')).toEqual([['update_check_now', { reason: 'signIn' }]])
    a.unmount()
    act(() => { win.dispatchEvent(new CustomEvent('ov-signed-in')) })
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'update_check_now')).toHaveLength(2)
    b.unmount()
    act(() => { win.dispatchEvent(new CustomEvent('ov-signed-in')) })
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'update_check_now')).toHaveLength(2)
  })
})

describe('an older answer never replaces a newer status', () => {
  it('the page asks on load while it reports the end of the match: the event wins', async () => {
    let answer
    const { win } = appWindow({ update_status: () => new Promise((r) => { answer = r }) })
    const { result } = renderHook(() => useDesktopUpdate({ win }))
    // the app pushes the newer status (the match is over) before it answers
    act(() => { win.dispatchEvent(updateEvent({ ...READY, seq: 8, canRestart: true, blockers: [] })) })
    await act(async () => { answer({ ...READY, seq: 7, canRestart: false, blockers: [{ kind: 'matchLive' }] }) })
    expect(result.current.status).toMatchObject({ seq: 8, canRestart: true })
    act(() => { win.dispatchEvent(updateEvent({ ...READY, seq: 9, phase: 'installing' })) })
    expect(result.current.status.phase).toBe('installing')
  })

  it('newerStatus', async () => {
    const { newerStatus } = await import('../useDesktopUpdate')
    expect(newerStatus(null, { seq: 1 })).toEqual({ seq: 1 })
    expect(newerStatus({ seq: 2 }, { seq: 1 })).toEqual({ seq: 2 })
    expect(newerStatus({ seq: 2 }, { seq: 3 })).toEqual({ seq: 3 })
    expect(newerStatus({ seq: 2 }, null)).toEqual({ seq: 2 })
    expect(newerStatus({ phase: 'a' }, { phase: 'b' })).toEqual({ phase: 'b' }, 'without numbers: the latest')
  })
})
