import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}))
vi.mock('../../contexts/AlertContext', () => ({
  useAlert: () => ({ showAlert: vi.fn() })
}))
// Rendered closed (open=false) but still mounted; it needs a ScaleProvider.
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

describe('HomeOptionsModal licence and credits', () => {
  // The spinner's ball and whistle are Game Icons artwork (CC BY 3.0): the
  // licence needs a visible credit in every build, including the Android app.
  it('credits Game Icons with its licence and links the source code', () => {
    renderOptions()
    const credits = screen.getByTestId('credits')
    expect(credits).toHaveTextContent('GPL-3.0')
    expect(credits).toHaveTextContent('Game Icons')
    expect(credits).toHaveTextContent('CC BY 3.0')
    const hrefs = [...credits.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('https://game-icons.net/')
    expect(hrefs).toContain('https://creativecommons.org/licenses/by/3.0/')
    expect(hrefs).toContain('https://github.com/Lucanepa/openvolley')
  })
})
