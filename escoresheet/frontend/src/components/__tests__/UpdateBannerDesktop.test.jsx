import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../../i18n/locales/en.json'
import UpdateBanner from '../UpdateBanner'

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
    render(<UpdateBanner />)
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('browser: still asks', async () => {
    const { waiting, replace } = withWaitingWorker()
    render(<UpdateBanner />)
    expect(await screen.findByRole('dialog')).toHaveTextContent('Update available!')
    expect(waiting.postMessage).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
})
