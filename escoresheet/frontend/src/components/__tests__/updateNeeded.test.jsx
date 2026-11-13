import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../../i18n/locales/en.json'

vi.mock('../../db/db', () => ({ db: {} }))
const live = vi.hoisted(() => ({ value: { pending: 0, error: 0, failed: 0 } }))
vi.mock('../../hooks/useSyncQueue', () => ({ useSyncQueueStats: () => live.value }))
vi.mock('../../utils/localNetwork', () => ({ backendOnLocalNetwork: () => false }))
const sw = vi.hoisted(() => ({ apply: null }))
vi.mock('../../hooks/useServiceWorker', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, applyServiceWorkerUpdate: (...args) => (sw.apply ? sw.apply(...args) : real.applyServiceWorkerUpdate(...args)) }
})

import ConnectionStatus from '../ConnectionStatus'
import UpdateBanner from '../UpdateBanner'
import { noteAppUpdateNeeded, resetAppUpdateNeededForTests } from '../../utils/appUpdate'
import { UPDATE_CHANNEL, resetUpdateChannelForTests } from '../../hooks/useServiceWorker'

// fe-shell-pwa-5 / x-rollout-ops-9: a build too old for the server, or a
// server older than the app, showed as a sync that never completes, or as
// "Error"; the update banner was on Home only, never on the match screens

const CONNECTED = { api: 'connected', server: 'connected', websocket: 'connected', match: 'live', supabase: 'connected' }
const noCheck = { check: () => {} }
const originalSW = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
const originalLocation = window.location
const others = []

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } } })
})

afterEach(() => {
  cleanup()
  act(() => resetAppUpdateNeededForTests())
  live.value = { pending: 0, error: 0, failed: 0 }
  sw.apply = null
  for (const c of others.splice(0)) c.close()
  resetUpdateChannelForTests()
  if (originalSW) Object.defineProperty(navigator, 'serviceWorker', originalSW)
  else delete navigator.serviceWorker
  Object.defineProperty(window, 'location', { value: originalLocation, configurable: true, writable: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ConnectionStatus', () => {
  it('"Update needed" while the server refuses this version, with what to do and a reload', () => {
    live.value = { pending: 4, error: 0, failed: 0 }
    render(<ConnectionStatus connectionStatuses={CONNECTED} />)
    expect(screen.getByText('Connected')).toBeInTheDocument()
    act(() => noteAppUpdateNeeded('server', noCheck))
    fireEvent.click(screen.getByText('Update needed'))
    expect(screen.getByText(/reload the app after this rally/)).toBeInTheDocument()
    expect(screen.getByText('Cloud sync:').parentElement).toHaveTextContent(/Update needed/)
    sw.apply = vi.fn()
    fireEvent.click(screen.getByText('Reload now'))
    expect(sw.apply).toHaveBeenCalledWith({ checkForUpdate: true })
  })

  it('the Android or desktop app: install the update (a reload keeps the same build)', () => {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn() }
    try {
      render(<ConnectionStatus connectionStatuses={CONNECTED} queueStats="update_required" />)
      fireEvent.click(screen.getByText('Update needed'))
      expect(screen.getByText(/install the app update after this match/)).toBeInTheDocument()
      expect(screen.queryByText('Reload now')).toBeNull()
    } finally {
      delete window.__TAURI_INTERNALS__
    }
  })

  it('refusals for data the server lacks: "Server update pending", counted apart', () => {
    live.value = { pending: 0, error: 0, failed: 2, serverBehind: 2 }
    render(<ConnectionStatus connectionStatuses={CONNECTED} />)
    fireEvent.click(screen.getByText('Server update pending'))
    expect(screen.getByText('Waiting for a server update:').parentElement).toHaveTextContent('2')
  })

  it('any other refusal among them: still "Error"', () => {
    live.value = { pending: 0, error: 0, failed: 2, serverBehind: 1 }
    render(<ConnectionStatus connectionStatuses={CONNECTED} />)
    expect(screen.getByText('Error')).toBeInTheDocument()
  })
})

describe('UpdateBanner on the match screens (whenUpdateNeeded)', () => {
  function waitingWorker() {
    let onControllerChange
    const waiting = { postMessage: vi.fn(() => onControllerChange?.()) }
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: {},
        getRegistration: vi.fn(async () => ({ waiting, installing: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), update: vi.fn(async () => {}) })),
        addEventListener: vi.fn((type, cb) => { if (type === 'controllerchange') onControllerChange = cb })
      }
    })
    const replace = vi.fn()
    Object.defineProperty(window, 'location', { value: { href: 'https://host/', replace }, configurable: true, writable: true })
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ version: '9.9.9' }) })))
    return { waiting, replace }
  }

  it('shows nothing mid-match while the build works, then "Update needed" with the reason', async () => {
    waitingWorker()
    render(<UpdateBanner whenUpdateNeeded />)
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => noteAppUpdateNeeded('server', noCheck))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Update needed')
    expect(dialog).toHaveTextContent(/too old for the server/)
  })

  it('Refresh while another tab has a match open: says the update waits, activates nothing', async () => {
    const { waiting, replace } = waitingWorker()
    const other = new BroadcastChannel(UPDATE_CHANNEL)
    other.unref?.()
    others.push(other)
    other.onmessage = (e) => { if (e.data?.type === 'update-ask') other.postMessage({ type: 'update-busy', id: e.data.id }) }
    act(() => noteAppUpdateNeeded('files', noCheck))
    render(<UpdateBanner whenUpdateNeeded />)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/could not be loaded/)
    fireEvent.click(screen.getByText('Refresh to update'))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/another window/))
    expect(waiting.postMessage).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })
})
