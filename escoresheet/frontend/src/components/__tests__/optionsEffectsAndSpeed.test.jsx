// Options › Effects and speed in both option dialogs (owner 22.11.2026): the
// Home options with Check this device (no match open), the scoring screen's
// without it; the four switches apply to <html> at once.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en' } })
}))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../SupportFeedbackModal', () => ({ default: () => null }))
vi.mock('../../diagnostics/reload', () => ({ reloadWithReason: vi.fn() }))
vi.mock('../../utils/activity', () => ({ canOpenLogFolder: async () => false, openLogFolder: async () => false }))

import HomeOptionsModal from '../options/HomeOptionsModal'
import ScoreboardOptionsModal from '../options/ScoreboardOptionsModal'
import { NO_MOTION_ATTR, resetLookForTests } from '../../utils/lookSettings'
import { LITE_GRAPHICS_CLASS } from '../../utils/liteGraphics'
import { resetDeviceCheckForTests } from '../../utils/deviceCheck'

const noop = () => {}
const MATCH_OPTIONS = {
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
}
const DISPLAY = { displayMode: 'auto', setDisplayMode: noop, detectedDisplayMode: 'desktop', activeDisplayMode: 'desktop', enterDisplayMode: noop, exitDisplayMode: noop }

const homeOptions = (props = {}) => render(
  <HomeOptionsModal open onClose={noop} onOpenConnectionSetup={noop} matchOptions={MATCH_OPTIONS} displayOptions={DISPLAY} wakeLock={{ wakeLockActive: false, toggleWakeLock: noop }} {...props} />
)

afterEach(() => {
  document.documentElement.classList.remove(LITE_GRAPHICS_CLASS)
  document.documentElement.removeAttribute(NO_MOTION_ATTR)
  localStorage.clear()
  resetLookForTests()
  resetDeviceCheckForTests()
})

describe('Options › Effects and speed', () => {
  it('Home options on Home: the section, the check button and the four switches', () => {
    homeOptions({ canCheckDevice: true })
    expect(screen.getByText('options.look.title')).toBeTruthy()
    expect(screen.getByTestId('device-check-run')).toBeTruthy()
    for (const name of ['blur', 'motion', 'clockSeconds', 'pdfSharp']) expect(screen.getByTestId(`look-${name}`).dataset.on).toBe('true')
  })

  it('both dialogs name the four switches (the kit Switch asks for a name)', () => {
    homeOptions({ canCheckDevice: true })
    for (const name of ['blur', 'motion', 'clockSeconds', 'pdfSharp']) {
      expect(screen.getByTestId(`look-${name}`).querySelector('[role=switch]').getAttribute('aria-label')).toBe(`options.look.${name}`)
    }
  })

  it('the scoring screen\'s dialog names them too', () => {
    render(<ScoreboardOptionsModal open onClose={noop} matchId={7} matchOptions={{}} displayOptions={{}} />)
    for (const name of ['blur', 'motion', 'clockSeconds', 'pdfSharp']) {
      expect(screen.getByTestId(`look-${name}`).querySelector('[role=switch]').getAttribute('aria-label')).toBe(`options.look.${name}`)
    }
  })

  it('Home options over a match (set-up): no check button', () => {
    homeOptions({ canCheckDevice: false })
    expect(screen.queryByTestId('device-check-run')).toBe(null)
    expect(screen.getByText('options.look.checkFromHome')).toBeTruthy()
  })

  it('the scoring screen\'s options: the switches, no check; a switch applies at once', () => {
    render(<ScoreboardOptionsModal open onClose={noop} matchId={7} matchOptions={{}} displayOptions={{}} />)
    expect(screen.getByText('options.look.title')).toBeTruthy()
    expect(screen.queryByTestId('device-check-run')).toBe(null)
    act(() => { fireEvent.click(screen.getByTestId('look-motion').querySelector('[role=switch], button')) })
    expect(document.documentElement.hasAttribute(NO_MOTION_ATTR)).toBe(true)
    act(() => { fireEvent.click(screen.getByTestId('look-blur').querySelector('[role=switch], button')) })
    expect(document.documentElement.classList.contains(LITE_GRAPHICS_CLASS)).toBe(true)
    expect(localStorage.getItem('ov.look.blur')).toBe('false')
  })
})
