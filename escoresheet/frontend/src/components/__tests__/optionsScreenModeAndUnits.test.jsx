// UI tour 14.11 (s02): in Options, "Auto (Desktop)" wrapped to two lines in
// the screen mode strip, and the set 2-3 interval duration showed bare ' and
// '' as its units. The strip's Auto segment says "Auto" (the detected mode in
// a line under it while Auto is chosen) and the fields say min / s.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts && typeof opts === 'object' && !Array.isArray(opts) && Object.keys(opts).length ? `${key}:${Object.values(opts).join('|')}` : (typeof opts === 'string' ? key : key)) })
}))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../SupportFeedbackModal', () => ({ default: () => null }))

import HomeOptionsModal from '../options/HomeOptionsModal'
import ScoreboardOptionsModal from '../options/ScoreboardOptionsModal'

const noop = () => {}
const matchOptions = {
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
const renderOptions = (displayMode = 'auto') => render(
  <HomeOptionsModal
    open
    onClose={noop}
    matchOptions={matchOptions}
    displayOptions={{ displayMode, setDisplayMode: noop, detectedDisplayMode: 'desktop', activeDisplayMode: 'desktop', enterDisplayMode: noop, exitDisplayMode: noop }}
    wakeLock={{ wakeLockActive: false, toggleWakeLock: noop }}
  />
)

describe('Options: screen mode strip and interval units', () => {
  it('the Auto segment is short; the detected mode is a line under the strip while Auto is chosen', () => {
    renderOptions('auto')
    const strip = screen.getByRole('group', { name: 'options.screenMode' })
    const auto = within(strip).getAllByRole('button')[0]
    expect(auto).toHaveTextContent(/^options\.auto$/)
    expect(screen.getByTestId('screen-mode-auto-detected')).toHaveTextContent('options.autoDetectedMode:Desktop')
  })

  it('no detected-mode line when a mode is chosen by hand', () => {
    renderOptions('phone')
    expect(screen.queryByTestId('screen-mode-auto-detected')).toBeNull()
  })

  it('the interval duration names its units', () => {
    renderOptions()
    expect(screen.getByRole('spinbutton', { name: /options\.durationMinutesAria/ })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: /options\.durationSecondsAria/ })).toBeInTheDocument()
    expect(screen.getByText('options.unitMin')).toBeInTheDocument()
    expect(screen.getByText('options.unitSec')).toBeInTheDocument()
    expect(screen.queryByText("'")).toBeNull()
    expect(screen.queryByText("''")).toBeNull()
  })

  it('the scoring screen\'s Options use the same labels', () => {
    const src = readFileSync(resolve(__dirname, '../options/ScoreboardOptionsModal.jsx'), 'utf8')
    expect(src).not.toMatch(/>''<|>'<\/span>/)
    expect(src).toMatch(/t\('options\.unitMin'/)
    expect(src).toMatch(/t\('options\.unitSec'/)
    expect(src).not.toMatch(/options\.autoWithMode/)
    expect(src).toMatch(/screen-mode-auto-detected/)
  })
})

// Options › Point entry (owner 22.11.2026): Rallies (as always) or
// Continuous play, at the top of the match options in both dialogs; this
// device only (localStorage rallyMode). Continuous play has no Start rally
// and its point is held, so the two accidental-tap checks are hidden there
// (their values are kept).
describe('Options: Point entry (rallies or continuous play)', () => {
  afterEach(() => localStorage.removeItem('rallyMode'))
  const both = (rallyMode, setRallyMode = noop) => [
    () => render(<HomeOptionsModal open onClose={noop} matchOptions={{ ...matchOptions, rallyMode, setRallyMode }} displayOptions={{ displayMode: 'auto', setDisplayMode: noop, detectedDisplayMode: 'desktop', activeDisplayMode: 'desktop', enterDisplayMode: noop, exitDisplayMode: noop }} wakeLock={{ wakeLockActive: false, toggleWakeLock: noop }} />),
    () => render(<ScoreboardOptionsModal open onClose={noop} matchId={7} matchOptions={{ ...matchOptions, rallyMode, setRallyMode }} displayOptions={{}} />)
  ]

  it.each([0, 1])('dialog %i: Rallies by default, with both accidental-tap checks', (i) => {
    const { unmount } = both(undefined)[i]()
    const strip = screen.getByRole('radiogroup', { name: 'options.rallyMode' })
    const [rallies, continuous] = within(strip).getAllByRole('radio')
    expect(rallies).toHaveTextContent('options.rallyModeRallies')
    expect(rallies.getAttribute('aria-checked')).toBe('true')
    expect(continuous).toHaveTextContent('options.rallyModeContinuous')
    expect(screen.getByText('options.checkAccidentalRallyStart')).toBeInTheDocument()
    expect(screen.getByText('options.checkAccidentalPointAward')).toBeInTheDocument()
    unmount()
  })

  it.each([0, 1])('dialog %i: Continuous play hides the accidental-tap checks and is kept on this device', (i) => {
    const setRallyMode = vi.fn()
    const { unmount } = both('continuous', setRallyMode)[i]()
    const strip = screen.getByRole('radiogroup', { name: 'options.rallyMode' })
    expect(within(strip).getAllByRole('radio')[1].getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText('options.checkAccidentalRallyStart')).toBeNull()
    expect(screen.queryByText('options.checkAccidentalPointAward')).toBeNull()
    expect(screen.getByTestId('rally-mode-hint')).toHaveTextContent('options.rallyModeContinuousHint:2')
    fireEvent.click(within(strip).getAllByRole('radio')[0])
    expect(setRallyMode).toHaveBeenCalledWith('rallies')
    expect(localStorage.getItem('rallyMode')).toBe('rallies')
    fireEvent.click(within(strip).getAllByRole('radio')[1])
    expect(setRallyMode).toHaveBeenLastCalledWith('continuous')
    expect(localStorage.getItem('rallyMode')).toBe('continuous')
    unmount()
  })

  it('at the top of the match options in both dialogs', () => {
    for (const file of ['HomeOptionsModal.jsx', 'ScoreboardOptionsModal.jsx']) {
      const src = readFileSync(resolve(__dirname, `../options/${file}`), 'utf8')
      const at = src.indexOf('<RallyModeOption kit={{ Row, InfoDot }} value={rallyMode} onChange={setRallyMode} />')
      expect(at, file).toBeGreaterThan(-1)
      expect(at, file).toBeLessThan(src.indexOf("t('options.checkAccidentalRallyStart')"))
      expect(src.slice(at, src.indexOf("t('options.checkAccidentalRallyStart')"))).toContain("{rallyMode !== 'continuous' && (<>")
    }
  })
})
