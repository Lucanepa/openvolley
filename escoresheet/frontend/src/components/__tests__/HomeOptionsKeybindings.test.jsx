// Options > Keyboard shortcuts: a click on a binding waits for its key
// ("Press key..."). The listener was added on the click and removed only by
// the next key: closing the dialog left it armed, and the next key pressed
// anywhere (during the match) was swallowed and silently became that
// binding, also when another action had it (two actions on one key, and the
// scoring screen tests "point left" first). It now lives only while the
// binding is edited, and a key of another action is refused.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
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
  keybindingsEnabled: true, setKeybindingsEnabled: noop,
  lfpTrackingEnabled: false, setLfpTrackingEnabled: noop,
  lfpMinimumOnCourt: 0, setLfpMinimumOnCourt: noop
}
const renderOptions = () => render(
  <HomeOptionsModal
    open
    onClose={noop}
    matchOptions={matchOptions}
    displayOptions={{ displayMode: 'auto', setDisplayMode: noop, detectedDisplayMode: 'desktop', activeDisplayMode: 'desktop', enterDisplayMode: noop, exitDisplayMode: noop }}
    wakeLock={{ wakeLockActive: false, toggleWakeLock: noop }}
  />
)
const press = (key) => {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  document.body.dispatchEvent(ev)
  return ev
}
const saved = () => JSON.parse(localStorage.getItem('keyBindings') || 'null')

describe('Options > Keyboard shortcuts', () => {
  beforeEach(() => { localStorage.clear(); cleanup() })

  it('a binding left waiting: closing the dialog stops waiting, the next key goes on as usual', () => {
    const { getByText, getAllByRole } = renderOptions()
    fireEvent.click(getByText('options.keybindings'))
    const pointLeft = getAllByRole('button').find(b => b.textContent === 'A')
    fireEvent.click(pointLeft)
    expect(pointLeft.textContent).toBe('options.pressKey')
    fireEvent.click(getByText('common.close'))

    let reached = false
    const later = () => { reached = true }
    window.addEventListener('keydown', later)
    const ev = press('l')
    window.removeEventListener('keydown', later)
    expect(ev.defaultPrevented).toBe(false)
    expect(reached).toBe(true)
    expect(saved()).toBeNull()
  })

  it('a key of another action is refused; a free key is taken', () => {
    const { getByText, getAllByRole, queryByRole } = renderOptions()
    fireEvent.click(getByText('options.keybindings'))
    const pointLeft = getAllByRole('button').find(b => b.textContent === 'A')
    fireEvent.click(pointLeft)
    fireEvent.keyDown(document.body, { key: 'l' })
    expect(saved()).toBeNull()
    expect(pointLeft.textContent).toBe('options.pressKey')
    expect(queryByRole('alert')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'x' })
    expect(saved().pointLeft).toBe('x')
    expect(saved().pointRight).toBe('l')
    expect(pointLeft.textContent).toBe('X')
  })
})
