import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../../i18n/locales/en.json'
import UpdateBanner from '../UpdateBanner'
import { AUTO_UPDATE_KEY } from '../../hooks/useServiceWorker'
import { forgetDesktopWindowRole } from '../../diagnostics/popupForward'

// On the desktop app the binary IS the update: its first start still runs the
// previous build from the service worker, with the new one waiting. The app
// then applies it at once instead of asking "Update available!".

const originalLocation = window.location
const originalSW = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')

function withWaitingWorker() {
  const waiting = { postMessage: vi.fn() }
  const listeners = {}
  const sw = {
    controller: {},
    getRegistration: vi.fn(async () => ({ waiting, installing: null, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    addEventListener: vi.fn((type, fn) => { listeners[type] = fn }),
  }
  waiting.postMessage.mockImplementation(() => listeners.controllerchange?.())
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw })
  const replace = vi.fn()
  Object.defineProperty(window, 'location', { value: { href: 'http://127.0.0.1:1/', replace }, configurable: true, writable: true })
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ version: '9.9.9' }) })))
  return { waiting, replace }
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } } })
})

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  forgetDesktopWindowRole(window)
  document.body.inert = false
  delete window.__TAURI_INTERNALS__
  Object.defineProperty(window, 'location', { value: originalLocation, configurable: true, writable: true })
  if (originalSW) Object.defineProperty(navigator, 'serviceWorker', originalSW)
  else delete navigator.serviceWorker
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('UpdateBanner', () => {
  it('desktop app: applies the waiting build at once, no question', async () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn(), metadata: { currentWindow: { label: 'main' } } }
    const { waiting, replace } = withWaitingWorker()
    let inertAtSkip = null
    const skip = waiting.postMessage.getMockImplementation()
    waiting.postMessage.mockImplementation((msg) => { inertAtSkip = document.body.inert; skip(msg) })
    render(<UpdateBanner />)
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // no tap reaches the page between the apply and its reload
    expect(inertAtSkip).toBe(true)
  })

  it('browser: still asks', async () => {
    const { waiting, replace } = withWaitingWorker()
    render(<UpdateBanner />)
    expect(await screen.findByRole('dialog')).toHaveTextContent('Update available!')
    expect(waiting.postMessage).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('desktop app, a second time right after its own try: asks instead (no reload loop)', async () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn(), metadata: { currentWindow: { label: 'main' } } }
    sessionStorage.setItem(AUTO_UPDATE_KEY, String(Date.now() - 4000))
    const { waiting, replace } = withWaitingWorker()
    render(<UpdateBanner />)
    expect(await screen.findByRole('dialog')).toHaveTextContent('Update available!')
    expect(waiting.postMessage).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('a desktop pop-up (Linux: its metadata says "main"; the app refuses it): asks, never applies on its own', async () => {
    const invoke = vi.fn(async (cmd) => {
      if (cmd === 'diagnostics_append') throw 'diagnostics_append not allowed on window "popup-1", webview "popup-1", URL: http://127.0.0.1:1/referee/'
      return null
    })
    window.__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label: 'main' } } }
    const { waiting, replace } = withWaitingWorker()
    render(<UpdateBanner />)
    expect(await screen.findByRole('dialog')).toHaveTextContent('Update available!')
    expect(invoke).toHaveBeenCalledWith('diagnostics_append', { lines: [] })
    expect(waiting.postMessage).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
})
