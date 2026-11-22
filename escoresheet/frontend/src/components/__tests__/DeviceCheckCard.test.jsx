// The device check's recommendation on Home (DeviceCheckCard) and Options ›
// Effects and speed (LookOptions): shown, applied, kept, switched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import DeviceCheckCard, { joinList } from '../DeviceCheckCard'
import LookOptions from '../options/LookOptions'
import { CHECK_KEY, CHECK_VERSION, RECOMMENDED, checkDeviceNow, deviceCheckRunning, getDeviceCheck, resetDeviceCheckForTests, setDeviceCheck } from '../../utils/deviceCheck'
import { clearOpenMatch, noteOpenMatch } from '../../utils/deviceSelfCheck'
import { LOOK_KEYS, NO_MOTION_ATTR, getLook, resetLookForTests, setLook } from '../../utils/lookSettings'
import { LITE_GRAPHICS_CLASS, liteGraphicsOn } from '../../utils/liteGraphics'

const result = (over = {}) => ({
  v: CHECK_VERSION, at: Date.UTC(2026, 10, 22, 20, 0), tier: 'slow', score: 140, workMs: 95, workRunsMs: [95, 96, 94], layoutMs: 45, layoutRunsMs: [45, 44, 46],
  hints: { platform: 'web', cores: 8, memoryGb: 2, dpr: 1, screen: '1280x800', reducedMotion: false },
  recommended: { ...RECOMMENDED.slow }, answer: null, ...over
})
const ALL_ON = { blur: true, motion: true, clockSeconds: true, pdfSharp: true }
const root = () => document.documentElement
const withI18n = (ui) => <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>

beforeEach(async () => {
  await i18n.changeLanguage('en')
  localStorage.clear()
  resetLookForTests()
  resetDeviceCheckForTests()
})
afterEach(() => {
  clearOpenMatch()
  root().classList.remove(LITE_GRAPHICS_CLASS)
  root().removeAttribute(NO_MOTION_ATTR)
  localStorage.clear()
  resetLookForTests()
  resetDeviceCheckForTests()
  vi.restoreAllMocks()
})

describe('DeviceCheckCard on Home', () => {
  it('nothing before a check, nothing when the look already matches', () => {
    const { container, rerender } = render(withI18n(<DeviceCheckCard />))
    expect(container.textContent).toBe('')
    setLook(RECOMMENDED.slow)
    act(() => { setDeviceCheck(result()) })
    rerender(withI18n(<DeviceCheckCard />))
    expect(screen.queryByTestId('device-check-card')).toBe(null)
  })

  it('a slow device: the recommendation in plain words, Apply and Keep as is', () => {
    setDeviceCheck(result())
    render(withI18n(<DeviceCheckCard />))
    const card = screen.getByTestId('device-check-card')
    expect(card.textContent).toContain('This device is on the slow side.')
    expect(card.textContent).toContain('For smoother scoring we recommend: no blur behind dialogs, no animations, the clock without seconds, and a lighter PDF.')
    expect(screen.getByTestId('device-check-apply').textContent).toBe('Apply')
    expect(screen.getByTestId('device-check-keep').textContent).toBe('Keep as is')
  })

  it('Apply sets exactly the listed switches, answers the result, and the card goes', () => {
    // the Android app's defaults: blur and the sharp PDF already off; the
    // scorer turned the seconds off himself
    localStorage.setItem(LOOK_KEYS.blur, 'false')
    localStorage.setItem(LOOK_KEYS.pdfSharp, 'false')
    localStorage.setItem(LOOK_KEYS.clockSeconds, 'false')
    setDeviceCheck(result())
    render(withI18n(<DeviceCheckCard />))
    expect(screen.getByTestId('device-check-card').textContent).toContain('we recommend: no animations.')
    const writes = vi.spyOn(localStorage, 'setItem')
    act(() => { fireEvent.click(screen.getByTestId('device-check-apply')) })
    const lookWrites = writes.mock.calls.filter(([k]) => k.startsWith('ov.look.'))
    expect(lookWrites).toEqual([[LOOK_KEYS.motion, 'false']])
    expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(true)
    expect(getDeviceCheck().answer).toBe('applied')
    expect(JSON.parse(localStorage.getItem(CHECK_KEY)).answer).toBe('applied')
    expect(screen.queryByTestId('device-check-card')).toBe(null)
  })

  it('Keep as is: the look stays, the answer is kept, the card goes and stays gone', () => {
    setDeviceCheck(result())
    const { unmount } = render(withI18n(<DeviceCheckCard />))
    act(() => { fireEvent.click(screen.getByTestId('device-check-keep')) })
    expect(getLook()).toMatchObject(ALL_ON)
    expect(liteGraphicsOn()).toBe(false)
    expect(Object.keys(localStorage).filter((k) => k.startsWith('ov.look.'))).toEqual([])
    expect(JSON.parse(localStorage.getItem(CHECK_KEY)).answer).toBe('kept')
    expect(screen.queryByTestId('device-check-card')).toBe(null)
    // the next start
    unmount()
    resetDeviceCheckForTests()
    render(withI18n(<DeviceCheckCard />))
    expect(screen.queryByTestId('device-check-card')).toBe(null)
  })

  it('a fast device whose blur is off: it can show the full look', () => {
    setLook({ blur: false })
    setDeviceCheck(result({ tier: 'fast', recommended: { ...ALL_ON } }))
    render(withI18n(<DeviceCheckCard />))
    const card = screen.getByTestId('device-check-card')
    expect(card.textContent).toContain('This device is fast.')
    expect(card.textContent).toContain('It can show the full look: blur behind dialogs.')
    act(() => { fireEvent.click(screen.getByTestId('device-check-apply')) })
    expect(liteGraphicsOn()).toBe(false)
  })

  it('Apply and Keep as is are touch size (44 px)', () => {
    setDeviceCheck(result())
    render(withI18n(<DeviceCheckCard />))
    for (const id of ['device-check-apply', 'device-check-keep']) expect(screen.getByTestId(id).className).toMatch(/\bh-11\b/)
  })

  it('a fast device that asks for less motion: said as its own setting, not "for smoother scoring"', () => {
    const hints = { platform: 'web', cores: 8, memoryGb: 8, dpr: 1, screen: '1280x800', reducedMotion: true }
    setDeviceCheck(result({ tier: 'fast', hints, recommended: { ...ALL_ON, motion: false } }))
    render(withI18n(<DeviceCheckCard />))
    const card = screen.getByTestId('device-check-card')
    expect(card.textContent).toContain('This device is fast.')
    expect(card.textContent).not.toContain('For smoother scoring')
    expect(screen.getByTestId('device-check-less-motion').textContent).toBe('Your device is set to show less motion, so we recommend: no animations.')
    act(() => { fireEvent.click(screen.getByTestId('device-check-apply')) })
    expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(true)
  })

  it('less motion asked for, and something else to change: both lines', () => {
    const hints = { platform: 'android-app', cores: 8, memoryGb: 4, dpr: 1.5, screen: '1340x800', reducedMotion: true }
    setLook({ blur: false })
    setDeviceCheck(result({ tier: 'fast', hints, recommended: { ...ALL_ON, motion: false } }))
    render(withI18n(<DeviceCheckCard />))
    const card = screen.getByTestId('device-check-card')
    expect(card.textContent).toContain('It can show the full look: blur behind dialogs.')
    expect(screen.getByTestId('device-check-less-motion')).toBeTruthy()
  })

  it('a slow device that also asks for less motion: no animations stays in the speed list', () => {
    setDeviceCheck(result({ hints: { ...result().hints, reducedMotion: true } }))
    render(withI18n(<DeviceCheckCard />))
    expect(screen.getByTestId('device-check-card').textContent).toContain('no blur behind dialogs, no animations, the clock')
    expect(screen.queryByTestId('device-check-less-motion')).toBe(null)
  })

  it('in the scorer\'s language', async () => {
    setDeviceCheck(result({ tier: 'ok', recommended: { ...RECOMMENDED.ok } }))
    render(withI18n(<DeviceCheckCard />))
    // the language's bundle loads after the switch (src/i18n loadLocale)
    await act(async () => { await i18n.changeLanguage('de') })
    await waitFor(() => expect(screen.getByTestId('device-check-card').textContent).toContain('Dieses Gerät ist mittelschnell.'))
    expect(screen.getByTestId('device-check-card').textContent).toContain('Für eine flüssigere Erfassung empfehlen wir: keine Unschärfe hinter Dialogen.')
    expect(screen.getByTestId('device-check-apply').textContent).toBe('Übernehmen')
    expect(screen.getByTestId('device-check-keep').textContent).toBe('So lassen')
  })

  it('joinList', () => {
    expect(joinList(['a', 'b', 'c'], 'en')).toBe('a, b, and c')
    expect(joinList(['a'], 'en')).toBe('a')
    expect(joinList(['a', 'b'], 'not a language!')).toMatch(/^a.*b$/)
  })
})

// The dialog's own pieces, as the Home options pass them
function Row({ children }) {
  return <div className="row">{children}</div>
}
function InfoDot({ title }) {
  return <span data-info={title} />
}
function ToggleSwitch({ value, onToggle }) {
  return <button type="button" role="switch" aria-checked={!!value} onClick={onToggle} />
}
const KIT = { Row, InfoDot, ToggleSwitch }

describe('LookOptions: Options › Effects and speed', () => {
  it('the four switches as they are, and today\'s default on the web: all on', () => {
    render(withI18n(<LookOptions kit={KIT} canCheck />))
    for (const name of ['blur', 'motion', 'clockSeconds', 'pdfSharp']) {
      expect(screen.getByTestId(`look-${name}`).dataset.on).toBe('true')
    }
    expect(screen.getByText('Blur behind dialogs')).toBeTruthy()
    expect(screen.getByText('Animations')).toBeTruthy()
    expect(screen.getByText('Seconds on the clock')).toBeTruthy()
    expect(screen.getByText('Sharp PDF')).toBeTruthy()
    expect(screen.getByTestId('device-check-result').textContent).toBe('Not checked yet.')
  })

  it('a switch applies at once: <html> and the stored switch', () => {
    render(withI18n(<LookOptions kit={KIT} />))
    act(() => { fireEvent.click(screen.getByTestId('look-blur').querySelector('[role=switch]')) })
    expect(liteGraphicsOn()).toBe(true)
    expect(localStorage.getItem(LOOK_KEYS.blur)).toBe('false')
    expect(screen.getByTestId('look-blur').dataset.on).toBe('false')
    act(() => { fireEvent.click(screen.getByTestId('look-motion').querySelector('[role=switch]')) })
    expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(true)
    act(() => { fireEvent.click(screen.getByTestId('look-motion').querySelector('[role=switch]')) })
    expect(root().hasAttribute(NO_MOTION_ATTR)).toBe(false)
  })

  it('the last result in plain words, and its recommendation with Apply', () => {
    setDeviceCheck(result({ answer: 'kept' }))
    render(withI18n(<LookOptions kit={KIT} canCheck />))
    expect(screen.getByTestId('device-check-result').textContent).toBe('Checked on 22.11.2026: this device is on the slow side.')
    // answered on Home, still offered here
    expect(screen.getByTestId('device-check-options-card').textContent).toContain('no blur behind dialogs')
    expect(screen.queryByTestId('device-check-keep')).toBe(null)
    act(() => { fireEvent.click(screen.getByTestId('device-check-apply')) })
    expect(getLook()).toEqual(RECOMMENDED.slow)
    expect(screen.queryByTestId('device-check-options-card')).toBe(null)
    expect(screen.getByTestId('device-check-result').textContent).toContain('Your settings match the recommendation.')
  })

  it('Check this device runs the check and shows the new result', async () => {
    render(withI18n(<LookOptions kit={KIT} canCheck />))
    const button = screen.getByTestId('device-check-run')
    expect(button.textContent).toBe('Check this device')
    // the real check (quick in jsdom); the button says it is checking meanwhile
    act(() => { fireEvent.click(button) })
    expect(screen.getByTestId('device-check-run').textContent).toBe('Checking…')
    expect(screen.getByTestId('device-check-run').disabled).toBe(true)
    await screen.findByText(/^Checked on \d{2}\.\d{2}\.\d{4}: this device is /, {}, { timeout: 10000 })
    expect(JSON.parse(localStorage.getItem(CHECK_KEY)).v).toBe(CHECK_VERSION)
    await waitFor(() => expect(screen.getByTestId('device-check-run').disabled).toBe(false))
  })

  it('a match opened while the check started here runs (Match Setup noted open): it stops, nothing is kept', async () => {
    render(withI18n(<LookOptions kit={KIT} canCheck />))
    act(() => { fireEvent.click(screen.getByTestId('device-check-run')) })
    expect(deviceCheckRunning()).toBe(true)
    noteOpenMatch({ id: 7, view: 'matchSetup' })
    await waitFor(() => expect(deviceCheckRunning()).toBe(false), { timeout: 10000 })
    expect(getDeviceCheck()).toBe(null)
    expect(localStorage.getItem(CHECK_KEY)).toBe(null)
    expect(screen.getByTestId('device-check-result').textContent).toBe('Not checked yet.')
    expect(screen.getByTestId('device-check-run').disabled).toBe(false)
  })

  it('Options closed while the check started there runs: it stops, nothing is kept', async () => {
    const { unmount } = render(withI18n(<LookOptions kit={KIT} canCheck />))
    act(() => { fireEvent.click(screen.getByTestId('device-check-run')) })
    unmount()
    await waitFor(() => expect(deviceCheckRunning()).toBe(false), { timeout: 10000 })
    expect(getDeviceCheck()).toBe(null)
  })

  it('the check no longer offered (a match being opened): it stops, nothing is kept', async () => {
    const { rerender } = render(withI18n(<LookOptions kit={KIT} canCheck />))
    act(() => { fireEvent.click(screen.getByTestId('device-check-run')) })
    rerender(withI18n(<LookOptions kit={KIT} canCheck={false} />))
    await waitFor(() => expect(deviceCheckRunning()).toBe(false), { timeout: 10000 })
    expect(getDeviceCheck()).toBe(null)
  })

  it('opened while the automatic check runs: Checking..., and the button comes back when that check stops', async () => {
    let finish
    let auto
    act(() => { auto = checkDeviceNow({ run: () => new Promise((resolve) => { finish = resolve }) }) })
    render(withI18n(<LookOptions kit={KIT} canCheck />))
    expect(screen.getByTestId('device-check-run').textContent).toBe('Checking…')
    expect(screen.getByTestId('device-check-run').disabled).toBe(true)
    // Options open: the automatic check stops at its next step and keeps nothing
    await act(async () => {
      await Promise.resolve()
      finish(null)
      await auto
    })
    expect(screen.getByTestId('device-check-run').textContent).toBe('Check this device')
    expect(screen.getByTestId('device-check-run').disabled).toBe(false)
    expect(screen.getByTestId('device-check-result').textContent).toBe('Not checked yet.')
  })

  it('on the scoring screen (canCheck false): no check, where to find it', () => {
    render(withI18n(<LookOptions kit={KIT} />))
    expect(screen.queryByTestId('device-check-run')).toBe(null)
    expect(screen.getByText('To check again, open Options on the home screen.')).toBeTruthy()
  })
})
