import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}))
vi.mock('../../contexts/AlertContext', () => ({
  useAlert: () => ({ showAlert: vi.fn() })
}))
vi.mock('../SupportFeedbackModal', () => ({ default: () => null }))

import HomeOptionsModal from '../options/HomeOptionsModal'

const noop = () => {}

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

// Guards the App version section through the merge with the desktop updater
// (feat/auto-update-desktop wraps the same web version row): Android shows
// its own rows and never the web build's version.json check, which in the
// APK always answers "latest".
describe('Options → App version', () => {
  afterEach(() => {
    delete window.Capacitor
  })

  it('in the Android app: the Android rows instead of the web version check', () => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' }
    renderOptions()
    expect(screen.getByTestId('android-version-rows')).toBeInTheDocument()
    // exactly one version row: the web one is not rendered next to it
    expect(screen.getAllByText('options.checkForUpdates')).toHaveLength(1)
    expect(screen.getAllByText('options.currentVersion')).toHaveLength(1)
  })

  it('in a browser: the web version check only', () => {
    renderOptions()
    expect(screen.queryByTestId('android-version-rows')).not.toBeInTheDocument()
    expect(screen.getAllByText('options.checkForUpdates')).toHaveLength(1)
  })
})
