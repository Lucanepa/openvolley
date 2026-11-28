// The (i) of every app (ui/InfoDot, ui/InfoHint through ui/infoPopover): its
// panel stays inside the visible screen (owner 28.11.2026, a 393 px phone: the
// Device check's ran off the left edge), and closes on a tap elsewhere,
// Escape, a scroll, another (i) or focus moving away.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { InfoDot } from '../InfoDot.jsx'
import { InfoHint } from '../InfoHint.jsx'
import { INFO_GAP, VIEWPORT_MARGIN, placeInfoPanel, positionInfoPanel, resetInfoPopoversForTests, visibleViewport } from '../infoPopover.js'

const PHONE = { left: 0, top: 0, width: 393, height: 852 }
const box = (left, top, width = 20, height = 20) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top })
const withI18n = (ui) => <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>

beforeEach(async () => {
  await i18n.changeLanguage('en')
  resetInfoPopoversForTests()
})
afterEach(() => {
  vi.restoreAllMocks()
  resetInfoPopoversForTests()
})

describe('placeInfoPanel: inside the visible screen', () => {
  it('under the (i), centred on it, when there is room', () => {
    const at = placeInfoPanel(box(180, 300), { width: 200, height: 80 }, PHONE)
    expect(at).toEqual({ left: 90, top: 320 + INFO_GAP, maxHeight: null, side: 'below' })
  })

  it('an (i) near the left edge (Options › Device check on a 393 px phone): pulled right to the margin, never cut off', () => {
    const at = placeInfoPanel(box(24, 300), { width: 260, height: 90 }, PHONE)
    expect(at.left).toBe(VIEWPORT_MARGIN)
    expect(at.left + 260).toBeLessThanOrEqual(PHONE.width - VIEWPORT_MARGIN)
  })

  it('an (i) near the right edge: pulled left to the margin', () => {
    const at = placeInfoPanel(box(360, 300), { width: 260, height: 90 }, PHONE)
    expect(at.left + 260).toBe(PHONE.width - VIEWPORT_MARGIN)
  })

  it('wider than the screen: as wide as the room, from the left margin', () => {
    const at = placeInfoPanel(box(100, 300), { width: 900, height: 90 }, PHONE)
    expect(at.left).toBe(VIEWPORT_MARGIN)
  })

  it('no room under the (i): above it', () => {
    const at = placeInfoPanel(box(180, 780), { width: 200, height: 120 }, PHONE)
    expect(at.side).toBe('above')
    expect(at.top).toBe(780 - INFO_GAP - 120)
    expect(at.maxHeight).toBe(null)
  })

  it('room on neither side: on the side with more, as tall as that room (it scrolls)', () => {
    const at = placeInfoPanel(box(180, 500), { width: 200, height: 700 }, PHONE)
    expect(at.side).toBe('above')
    expect(at.top).toBe(VIEWPORT_MARGIN)
    expect(at.maxHeight).toBe(500 - INFO_GAP - VIEWPORT_MARGIN)
    const below = placeInfoPanel(box(180, 300), { width: 200, height: 700 }, PHONE)
    expect(below.side).toBe('below')
    expect(below.top).toBe(320 + INFO_GAP)
    expect(below.top + below.maxHeight).toBe(PHONE.height - VIEWPORT_MARGIN)
  })

  it('a zoomed-in phone: the visible part of the page (visual viewport) is the limit', () => {
    const view = { left: 100, top: 50, width: 200, height: 400 }
    const at = placeInfoPanel(box(110, 100), { width: 180, height: 80 }, view)
    expect(at.left).toBe(100 + VIEWPORT_MARGIN)
    expect(at.left + Math.min(180, 200 - 2 * VIEWPORT_MARGIN)).toBeLessThanOrEqual(300 - VIEWPORT_MARGIN)
    expect(visibleViewport({ visualViewport: { offsetLeft: 100, offsetTop: 50, width: 200, height: 400 } })).toEqual(view)
    expect(visibleViewport({ innerWidth: 393, innerHeight: 852 })).toEqual(PHONE)
  })
})

describe('positionInfoPanel: fixed, and the offset of a transformed dialog taken out', () => {
  it('a dialog that moves the point fixed boxes start from (100, 40): the panel still lands where it should', () => {
    const panel = document.createElement('div')
    const trigger = document.createElement('button')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(box(24, 300))
    // put at 0, 0, it shows at 100, 40 (a transformed ancestor)
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(box(100, 40, 260, 90))
    const at = positionInfoPanel(panel, trigger, { maxWidth: 260, win: { innerWidth: 393, innerHeight: 852 } })
    expect(at.left).toBe(VIEWPORT_MARGIN)
    expect(panel.style.left).toBe(`${VIEWPORT_MARGIN - 100}px`)
    expect(panel.style.top).toBe(`${320 + INFO_GAP - 40}px`)
    expect(panel.style.maxWidth).toBe('260px')
    expect(panel.style.visibility).toBe('')
    expect(panel.dataset.side).toBe('below')
  })

  it('on a phone the panel is never wider than the screen less the margins', () => {
    const panel = document.createElement('div')
    const trigger = document.createElement('button')
    positionInfoPanel(panel, trigger, { maxWidth: 320, win: { innerWidth: 300, innerHeight: 600 } })
    expect(panel.style.maxWidth).toBe(`${300 - 2 * VIEWPORT_MARGIN}px`)
  })
})

function TwoDots() {
  return (
    <div data-testid="page">
      <label data-testid="label">
        Device check <InfoDot title="The app measures how fast this device works." />
      </label>
      <InfoDot title="Second explanation." label="About the second" />
      <button type="button" data-testid="elsewhere">Elsewhere</button>
      <div data-testid="scroller" style={{ overflow: 'auto', height: 50 }}><div style={{ height: 500 }} /></div>
    </div>
  )
}

const dot = () => screen.getByRole('button', { name: 'More information' })
const second = () => screen.getByRole('button', { name: 'About the second' })

describe('InfoDot: opens on a tap, closes on everything else', () => {
  it('a tap opens it (aria-expanded, aria-controls on its panel), another tap on it closes it', () => {
    render(withI18n(<TwoDots />))
    expect(dot().getAttribute('aria-expanded')).toBe('false')
    act(() => { fireEvent.click(dot()) })
    expect(dot().getAttribute('aria-expanded')).toBe('true')
    const panel = document.getElementById(dot().getAttribute('aria-controls'))
    expect(panel.textContent).toBe('The app measures how fast this device works.')
    expect(panel.style.position).toBe('fixed')
    // right after the (i): a screen reader's next item
    expect(dot().nextElementSibling).toBe(panel)
    act(() => { fireEvent.click(dot()) })
    expect(dot().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('The app measures how fast this device works.')).toBe(null)
  })

  it('in a <label>: the tap opens the (i) only', () => {
    const onLabel = vi.fn()
    render(withI18n(<div onClick={onLabel}><TwoDots /></div>))
    act(() => { fireEvent.click(dot()) })
    expect(onLabel).not.toHaveBeenCalled()
    act(() => { fireEvent.click(screen.getByText('The app measures how fast this device works.')) })
    expect(onLabel).not.toHaveBeenCalled()
    expect(dot().getAttribute('aria-expanded')).toBe('true')
  })

  it('a tap anywhere else closes it (pointer, mouse or touch), a tap on its own text does not', () => {
    render(withI18n(<TwoDots />))
    for (const press of [fireEvent.pointerDown, fireEvent.mouseDown, fireEvent.touchStart]) {
      act(() => { fireEvent.click(dot()) })
      act(() => { press(screen.getByText('The app measures how fast this device works.')) })
      expect(dot().getAttribute('aria-expanded')).toBe('true')
      act(() => { press(screen.getByTestId('elsewhere')) })
      expect(dot().getAttribute('aria-expanded')).toBe('false')
    }
  })

  it('a tap that the dialog under it stops (capture): still closes it', () => {
    render(withI18n(<div><TwoDots /><div data-testid="swallow" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} /></div>))
    act(() => { fireEvent.click(dot()) })
    act(() => { fireEvent.pointerDown(screen.getByTestId('swallow')) })
    expect(dot().getAttribute('aria-expanded')).toBe('false')
  })

  it('Escape closes it and gives the focus back to the (i); the dialog around it does not hear that Escape', () => {
    const onDialogKey = vi.fn()
    render(withI18n(<div onKeyDown={onDialogKey}><TwoDots /></div>))
    act(() => { dot().focus() })
    act(() => { fireEvent.click(dot()) })
    act(() => { fireEvent.keyDown(document.activeElement, { key: 'Escape' }) })
    expect(dot().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(dot())
    expect(onDialogKey).not.toHaveBeenCalled()
    // closed, Escape is the dialog's again
    act(() => { fireEvent.keyDown(document.activeElement, { key: 'Escape' }) })
    expect(onDialogKey).toHaveBeenCalledTimes(1)
  })

  it('a scroll of the page or of the dialog around it closes it', () => {
    render(withI18n(<TwoDots />))
    act(() => { fireEvent.click(dot()) })
    act(() => { fireEvent.scroll(screen.getByTestId('scroller')) })
    expect(dot().getAttribute('aria-expanded')).toBe('false')
    act(() => { fireEvent.click(dot()) })
    act(() => { fireEvent.scroll(document) })
    expect(dot().getAttribute('aria-expanded')).toBe('false')
  })

  it('a long text scrolling inside its own panel does not close it', () => {
    render(withI18n(<TwoDots />))
    act(() => { fireEvent.click(dot()) })
    act(() => { fireEvent.scroll(screen.getByText('The app measures how fast this device works.')) })
    expect(dot().getAttribute('aria-expanded')).toBe('true')
  })

  it('opening another (i) closes the first, also from the keyboard (no tap)', () => {
    render(withI18n(<TwoDots />))
    act(() => { fireEvent.click(dot()) })
    // Enter on a button: a click, no pointer
    act(() => { fireEvent.click(second()) })
    expect(second().getAttribute('aria-expanded')).toBe('true')
    expect(dot().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('The app measures how fast this device works.')).toBe(null)
    expect(screen.getByText('Second explanation.')).toBeTruthy()
  })

  it('focus moving away (Tab) closes it', () => {
    render(withI18n(<TwoDots />))
    act(() => { dot().focus() })
    act(() => { fireEvent.click(dot()) })
    act(() => { screen.getByTestId('elsewhere').focus() })
    expect(dot().getAttribute('aria-expanded')).toBe('false')
  })

  it('named in the app\'s language', async () => {
    render(withI18n(<TwoDots />))
    // the language's bundle loads after the switch (src/i18n loadLocale)
    await act(async () => { await i18n.changeLanguage('de') })
    expect(await screen.findByRole('button', { name: 'Mehr Informationen' })).toBeTruthy()
  })
})

describe('InfoHint (the licence column): the same panel and the same closing', () => {
  const Hint = () => (
    <div>
      <InfoHint eyebrow="Licence" label="What goes in the licence column" closeLabel="Close">The licence number.</InfoHint>
      <InfoDot title="Other explanation." />
      <button type="button" data-testid="elsewhere">Elsewhere</button>
    </div>
  )
  const hint = () => screen.getByRole('button', { name: 'What goes in the licence column' })

  it('opens fixed and inside the screen, closes on its ×, a tap elsewhere, Escape and another (i)', () => {
    render(withI18n(<Hint />))
    act(() => { fireEvent.click(hint()) })
    expect(hint().getAttribute('aria-expanded')).toBe('true')
    const panel = document.getElementById(hint().getAttribute('aria-controls'))
    expect(panel.style.position).toBe('fixed')
    expect(panel.textContent).toContain('The licence number.')
    // ×: closed, the focus back on the (i)
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) })
    expect(hint().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(hint())
    act(() => { fireEvent.click(hint()) })
    act(() => { fireEvent.pointerDown(screen.getByTestId('elsewhere')) })
    expect(hint().getAttribute('aria-expanded')).toBe('false')
    act(() => { fireEvent.click(hint()) })
    act(() => { fireEvent.keyDown(document.body, { key: 'Escape' }) })
    expect(hint().getAttribute('aria-expanded')).toBe('false')
    act(() => { fireEvent.click(hint()) })
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'More information' })) })
    expect(hint().getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('Other explanation.')).toBeTruthy()
  })

  it('Tab from the (i) into its × keeps it open', () => {
    render(withI18n(<Hint />))
    act(() => { hint().focus() })
    act(() => { fireEvent.click(hint()) })
    act(() => { screen.getByRole('button', { name: 'Close' }).focus() })
    expect(hint().getAttribute('aria-expanded')).toBe('true')
  })
})
