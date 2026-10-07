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
  // The icons are Lucide (ISC) and Phosphor (MIT), the packs wiedisync uses:
  // both are credited in every build, including the Android app. The Game
  // Icons (CC BY 3.0) artwork is gone, so its credit must be gone too.
  it('credits the icon packs with their licences and links the source code', () => {
    renderOptions()
    const credits = screen.getByTestId('credits')
    expect(credits).toHaveTextContent('GPL-3.0')
    expect(credits).toHaveTextContent('Lucide (ISC)')
    expect(credits).toHaveTextContent('Phosphor (MIT)')
    expect(credits).not.toHaveTextContent('Game Icons')
    const hrefs = [...credits.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('https://lucide.dev/license')
    expect(hrefs).toContain('https://github.com/phosphor-icons/react/blob/master/LICENSE')
    expect(hrefs).not.toContain('https://game-icons.net/')
    expect(hrefs).toContain('https://github.com/Lucanepa/openvolley')
  })

  it('links the privacy policy, terms, legal notice and open-source notice', () => {
    renderOptions()
    const hrefs = [...screen.getByTestId('legal-links').querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual([
      'https://openvolley.app/en/privacy', 'https://openvolley.app/en/terms',
      'https://openvolley.app/en/imprint', 'https://openvolley.app/en/open-source'
    ])
  })
})
