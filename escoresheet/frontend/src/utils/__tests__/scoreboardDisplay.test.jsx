import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../relayPublisher', () => ({ scorerRelay: { listen: () => () => {}, socket: null } }))

import { scoreboardSettingsUrl, isPrivateLanHost, displayFromMessage, createScoreboardDisplays } from '../scoreboardDisplay'
import { useScoreboardDisplay, askOpenSettings, settingsHostOf } from '../../components/scoreboard/useScoreboardDisplay'
import { SETTINGS_URL_CASES, BOARD_URL } from '../../../../backend/tests/helpers/displayPresenceContract.js'

/** A scorer relay to drive by hand: its socket, and messages on it. */
function fakeRelay() {
  const listeners = new Set()
  return {
    socket: { id: 1 },
    listen(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    emit(message, socket = this.socket) { for (const fn of [...listeners]) fn(message, socket) }
  }
}
const win = (hostname) => ({ location: { hostname } })

describe('scoreboardSettingsUrl (checked again on the scorer)', () => {
  it('opens the private-LAN pages the relays keep, nothing else', () => {
    for (const [raw, kept] of SETTINGS_URL_CASES.kept) expect(scoreboardSettingsUrl(raw)).toBe(kept)
    for (const raw of SETTINGS_URL_CASES.refused) expect(scoreboardSettingsUrl(raw)).toBeNull()
    expect(scoreboardSettingsUrl(null)).toBeNull()
    expect(scoreboardSettingsUrl('http://0xac.24.1.1/')).toBe('http://172.24.1.1/')
  })
  it('the host this page came from counts too, never this device itself', () => {
    expect(scoreboardSettingsUrl('http://board.local:8890/#settings', { pageHost: 'board.local' })).toBe('http://board.local:8890/#settings')
    expect(scoreboardSettingsUrl('http://board.local:8890/', { pageHost: 'other.local' })).toBeNull()
    expect(scoreboardSettingsUrl('http://localhost/', { pageHost: 'localhost' })).toBeNull()
    expect(scoreboardSettingsUrl('http://127.0.0.1:8890/', { pageHost: '127.0.0.1' })).toBeNull()
    expect(scoreboardSettingsUrl('http://user:pw@board.local/', { pageHost: 'board.local' })).toBeNull()
  })
  it('private-LAN hosts', () => {
    expect(isPrivateLanHost('172.24.1.1')).toBe(true)
    expect(isPrivateLanHost('192.168.5.1')).toBe(true)
    expect(isPrivateLanHost('100.64.0.1')).toBe(false)
    expect(isPrivateLanHost('app.openvolley.app')).toBe(false)
  })
})

describe('display-presence on the scorer', () => {
  it('reads the message of its own match only', () => {
    const m = { type: 'display-presence', matchId: 'seed-1', present: true, settingsUrl: BOARD_URL }
    expect(displayFromMessage(m, 'seed-1')).toEqual({ settingsUrl: BOARD_URL })
    expect(displayFromMessage(m, 'seed-2')).toBeUndefined()
    expect(displayFromMessage({ ...m, type: 'scorer-presence' }, 'seed-1')).toBeUndefined()
    expect(displayFromMessage({ ...m, present: false }, 'seed-1')).toBeNull()
    expect(displayFromMessage({ ...m, settingsUrl: null }, 'seed-1')).toBeNull()
    // a relay passing on a page off the LAN: not opened
    expect(displayFromMessage({ ...m, settingsUrl: 'https://evil.example/' }, 'seed-1')).toBeNull()
  })

  it('keeps the last state per match, for the socket it came on', () => {
    const relay = fakeRelay()
    const store = createScoreboardDisplays({ relay, win: win('172.24.1.1') })
    expect(store.get('seed-1')).toBeNull()
    relay.emit({ type: 'display-presence', matchId: 'seed-1', present: true, settingsUrl: BOARD_URL })
    expect(store.get('seed-1')).toEqual({ settingsUrl: BOARD_URL })
    expect(store.get('seed-2')).toBeNull()
    // a new socket: unknown until the relay answers its first sync again
    relay.socket = { id: 2 }
    expect(store.get('seed-1')).toBeNull()
    relay.emit({ type: 'display-presence', matchId: 'seed-1', present: false, settingsUrl: null })
    expect(store.get('seed-1')).toBeNull()
  })
})

describe('useScoreboardDisplay', () => {
  // "open" asks first with the page's host (audit 2611 SEC-45): it opened the
  // page at once, whatever display announced it
  it('offers "open" while a display with a page follows, asks with its host, then opens that page', async () => {
    const relay = fakeRelay()
    const store = createScoreboardDisplays({ relay, win: win('app.openvolley.app') })
    const openWindow = vi.fn(() => ({ ok: true }))
    const askBeforeOpen = vi.fn(async () => true)
    const { result } = renderHook(() => useScoreboardDisplay('seed-1', { store, openWindow, askBeforeOpen }))
    expect(result.current.open).toBeUndefined()
    act(() => relay.emit({ type: 'display-presence', matchId: 'seed-1', present: true, settingsUrl: BOARD_URL }))
    expect(result.current.settingsUrl).toBe(BOARD_URL)
    expect(result.current.host).toBe('172.24.1.1:8890')
    await act(() => result.current.open())
    expect(askBeforeOpen).toHaveBeenCalledWith({ url: BOARD_URL, host: '172.24.1.1:8890' })
    expect(openWindow).toHaveBeenCalledWith(BOARD_URL)
    act(() => relay.emit({ type: 'display-presence', matchId: 'seed-1', present: false, settingsUrl: null }))
    expect(result.current.open).toBeUndefined()
    expect(result.current.host).toBeNull()
    // no match (no relay key): never
    const none = renderHook(() => useScoreboardDisplay(null, { store, openWindow, askBeforeOpen }))
    expect(none.result.current.open).toBeUndefined()
  })

  it('opens nothing when the scorer says no', async () => {
    const relay = fakeRelay()
    const store = createScoreboardDisplays({ relay, win: win('app.openvolley.app') })
    const openWindow = vi.fn(() => ({ ok: true }))
    const askBeforeOpen = vi.fn(async () => false)
    const { result } = renderHook(() => useScoreboardDisplay('seed-1', { store, openWindow, askBeforeOpen }))
    act(() => relay.emit({ type: 'display-presence', matchId: 'seed-1', present: true, settingsUrl: 'http://192.168.1.1/cgi-bin/luci' }))
    await act(() => result.current.open())
    expect(askBeforeOpen).toHaveBeenCalledWith({ url: 'http://192.168.1.1/cgi-bin/luci', host: '192.168.1.1' })
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('the question names the host, in the app\'s dialog', async () => {
    const ask = vi.fn(async () => true)
    expect(await askOpenSettings({ host: '172.24.1.1:8890' }, { ask })).toBe(true)
    const [opts] = ask.mock.calls[0]
    expect(opts.title).toBeTruthy()
    expect(opts.message).toContain('172.24.1.1:8890')
    expect(opts.confirmLabel).toBeTruthy()
    expect(settingsHostOf('not a url')).toBeNull()
    expect(settingsHostOf(null)).toBeNull()
  })
})
