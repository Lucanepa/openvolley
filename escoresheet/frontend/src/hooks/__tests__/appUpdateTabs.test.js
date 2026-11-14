import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  applyServiceWorkerUpdate, answerUpdateQuestions, otherTabHasOpenMatch, installPreloadErrorNotice,
  resetUpdateChannelForTests, resetPreloadErrorNoticeForTests, UPDATE_CHANNEL, UPDATE_DEFERRED
} from '../useServiceWorker'
import { appUpdateNeeded, noteAppUpdateNeeded, resetAppUpdateNeededForTests } from '../../utils/appUpdate'
import { toast } from '../../ui/uiStore.js'

// fe-shell-pwa-4: the tabs of one origin share one service worker. "Refresh
// to update" in one tab (Home) posted SKIP_WAITING at once: the tab scoring a
// match moved to the new worker on the old code, its lazy files gone with the
// old precache (language, backup key, passkey sign-in...).

const originalLocation = window.location
const originalSW = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
const others = []

// Another tab of the origin: its own channel of the same name
function otherTab({ busy }) {
  const channel = new BroadcastChannel(UPDATE_CHANNEL)
  channel.unref?.()
  const asked = []
  channel.onmessage = (e) => {
    if (e.data?.type !== 'update-ask') return
    asked.push(e.data)
    if (busy) channel.postMessage({ type: 'update-busy', id: e.data.id })
  }
  others.push(channel)
  return { channel, asked }
}

function waitingWorker() {
  let onControllerChange
  const waiting = { postMessage: vi.fn(() => onControllerChange?.()) }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: vi.fn().mockResolvedValue({ waiting }),
      addEventListener: vi.fn((type, cb) => { if (type === 'controllerchange') onControllerChange = cb })
    }
  })
  const replace = vi.fn()
  Object.defineProperty(window, 'location', { value: { href: 'https://host/?x=1', replace }, configurable: true, writable: true })
  return { waiting, replace }
}

beforeEach(() => {
  resetUpdateChannelForTests()
  resetAppUpdateNeededForTests()
})
afterEach(() => {
  for (const c of others.splice(0)) c.close()
  resetUpdateChannelForTests()
  Object.defineProperty(window, 'location', { value: originalLocation, configurable: true, writable: true })
  if (originalSW) Object.defineProperty(navigator, 'serviceWorker', originalSW)
  else delete navigator.serviceWorker
  vi.restoreAllMocks()
})

describe('an update while another tab has a match open', () => {
  it('waits: no SKIP_WAITING, no reload, a notice says why', async () => {
    const tab = otherTab({ busy: true })
    const { waiting, replace } = waitingWorker()
    const info = vi.spyOn(toast, 'info')
    expect(await applyServiceWorkerUpdate()).toBe(UPDATE_DEFERRED)
    expect(tab.asked).toHaveLength(1)
    expect(waiting.postMessage).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0]).toMatch(/another window/)
  })

  it('no tab with a match open: activates the new worker and reloads, as before', async () => {
    otherTab({ busy: false })
    const { waiting, replace } = waitingWorker()
    await applyServiceWorkerUpdate({ notify: false })
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('asks nobody when there is nothing to activate (a plain reload of this tab)', async () => {
    const tab = otherTab({ busy: true })
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(undefined), addEventListener: vi.fn() } })
    const replace = vi.fn()
    Object.defineProperty(window, 'location', { value: { href: 'https://host/', replace }, configurable: true, writable: true })
    await applyServiceWorkerUpdate()
    expect(tab.asked).toHaveLength(0)
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('a page answers while its match is on show, not otherwise, and not while it needs the update itself', async () => {
    let open = true
    answerUpdateQuestions({ isBusy: () => open })
    const asker = new BroadcastChannel(UPDATE_CHANNEL)
    asker.unref?.()
    others.push(asker)
    const ask = (id) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 200)
      asker.onmessage = (e) => { if (e.data?.type === 'update-busy' && e.data.id === id) { clearTimeout(timer); resolve(true) } }
      asker.postMessage({ type: 'update-ask', id })
    })
    expect(await ask('a')).toBe(true)
    open = false
    expect(await ask('b')).toBe(false)
    open = true
    noteAppUpdateNeeded('server', { check: () => {} })
    expect(await ask('c')).toBe(false)
  })

  it('a page never answers its own question', async () => {
    answerUpdateQuestions({ isBusy: () => true })
    expect(await otherTabHasOpenMatch({ timeoutMs: 100 })).toBe(false)
  })
})

describe('files of this build gone from the site (vite:preloadError)', () => {
  beforeEach(() => resetPreloadErrorNoticeForTests())

  it('marks the page as needing an update, asks the worker for the newer build, and tells the scorer once', async () => {
    const update = vi.fn(async () => {})
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn(async () => ({ update })) } })
    const info = vi.spyOn(toast, 'info')
    installPreloadErrorNotice(window)
    for (let i = 0; i < 2; i++) window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    expect(appUpdateNeeded()).toBe('files')
    await Promise.resolve()
    await Promise.resolve()
    expect(update).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0]).toMatch(/after this rally/)
  })

  it('never cancels the event: the failed import still fails for its caller', () => {
    installPreloadErrorNotice(window)
    const e = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})
