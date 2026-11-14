// UI tour 14.11 (s02): in Options, "Auto (Desktop)" wrapped to two lines in
// the screen mode strip, and the set 2-3 interval duration showed bare ' and
// '' as its units. The strip's Auto segment says "Auto" (the detected mode in
// a line under it while Auto is chosen) and the fields say min / s.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts && typeof opts === 'object' && !Array.isArray(opts) && Object.keys(opts).length ? `${key}:${Object.values(opts).join('|')}` : (typeof opts === 'string' ? key : key)) })
}))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
vi.mock('../SupportFeedbackModal', () => ({ default: () => null }))

import HomeOptionsModal from '../options/HomeOptionsModal'

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
