import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      const fallback = typeof opts === 'string' ? opts : opts?.defaultValue
      const text = typeof fallback === 'string' ? fallback : key
      return typeof opts === 'object' && opts ? text.replace(/\{\{(\w+)\}\}/g, (_, k) => opts[k] ?? '') : text
    },
  }),
}))
vi.mock('../../contexts/AlertContext', () => ({
  useAlert: () => ({ showAlert: vi.fn() })
}))
vi.mock('../SupportFeedbackModal', () => ({ default: () => null }))

import HomeOptionsModal from '../options/HomeOptionsModal'

const noop = () => {}

const STATUS = {
  kind: 'nsis',
  phase: 'ready',
  current: '2.2.0',
  available: { version: '2.2.1', notes: 'Fixes for the scoresheet PDF.', date: '2026-10-20' },
  autoCheck: true,
  autoInstall: true,
  blockers: [{ kind: 'matchLive' }],
  canRestart: false,
  manual: false,
}

function renderOptions() {
  return render(
    <HomeOptionsModal
      open
      onClose={noop}
      onOpenConnectionSetup={noop}
      matchOptions={{
        checkAccidentalRallyStart: false, setCheckAccidentalRallyStart: noop,
        accidentalRallyStartDuration: 3, setAccidentalRallyStartDuration: noop,
        checkAccidentalPointAward: false, setCheckAccidentalPointAward: noop,
        accidentalPointAwardDuration: 3, setAccidentalPointAwardDuration: noop,
        manageCaptainOnCourt: false, setManageCaptainOnCourt: noop,
        liberoExitConfirmation: true, setLiberoExitConfirmation: noop,
        liberoEntrySuggestion: true, setLiberoEntrySuggestion: noop,
        setIntervalDuration: 180, setSetIntervalDuration: noop,
        keybindingsEnabled: false, setKeybindingsEnabled: noop,
        lfpTrackingEnabled: false, setLfpTrackingEnabled: noop,
        lfpMinimumOnCourt: 0, setLfpMinimumOnCourt: noop
      }}
      displayOptions={{
        displayMode: 'auto', setDisplayMode: noop, detectedDisplayMode: 'desktop',
        activeDisplayMode: 'desktop', enterDisplayMode: noop, exitDisplayMode: noop
      }}
      wakeLock={{ wakeLockActive: false, toggleWakeLock: noop }}
    />
  )
}

afterEach(() => {
  delete window.__TAURI_INTERNALS__
  vi.restoreAllMocks()
})

describe('Options > App version in the desktop app', () => {
  it('asks the app, not the bundled version.json', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ json: async () => ({ version: '0.0.0-test' }) })
    const invoke = vi.fn(async (cmd, args) => {
      if (cmd === 'update_check_now') return { ...STATUS, phase: 'checking', manual: true }
      if (cmd === 'update_set_prefs') return { ...STATUS, ...args }
      return STATUS
    })
    window.__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label: 'main' } } }
    renderOptions()

    await screen.findByText('Update 2.2.1 is ready')
    expect(screen.getByText('v2.2.0')).toBeInTheDocument()
    // the gate is closed: the reason, no restart button
    expect(screen.getByTestId('desktop-update-blocker')).toHaveTextContent('The update waits until the match is over.')
    expect(screen.queryByRole('button', { name: /Restart and update/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'options.checkForUpdates' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_check_now', { reason: 'manual' }))
    expect(fetchSpy).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('switch', { name: 'Install updates automatically' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_set_prefs', { autoInstall: false }))
    expect(screen.getByText(/Fixes for the scoresheet PDF/)).toBeInTheDocument()
  })

  it('the gate open: "Restart and update"', async () => {
    const invoke = vi.fn(async () => ({ ...STATUS, blockers: [], canRestart: true }))
    window.__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label: 'main' } } }
    renderOptions()
    fireEvent.click(await screen.findByRole('button', { name: /Restart and update/ }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('update_install_now', undefined))
  })

  it('a Flatpak / Snap / AUR copy: its package manager updates it, no check button', async () => {
    const invoke = vi.fn(async () => ({ ...STATUS, kind: 'managed', phase: 'idle', available: null, blockers: [] }))
    window.__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label: 'main' } } }
    renderOptions()
    await screen.findByText(/Updates come from your package manager/)
    expect(screen.queryByRole('button', { name: 'options.checkForUpdates' })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Check for updates automatically' })).toBeNull()
  })

  it('a browser keeps the web check', () => {
    renderOptions()
    expect(screen.getByRole('button', { name: 'options.checkForUpdates' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Install updates automatically' })).toBeNull()
  })
})
