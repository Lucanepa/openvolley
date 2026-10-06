import { describe, it, expect, vi } from 'vitest'
import { FORM_STACK_CLASS, FORM_STACK_QUERY, isFormStacked, isViewportTooSmall, watchFormStack } from '../formLayout'

// A MediaQueryList stand-in whose orientation the test turns.
function fakeMatchMedia(initial) {
  const listeners = new Set()
  const mq = {
    matches: initial,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
  }
  const matchMedia = vi.fn(() => mq)
  const turn = (matches) => { mq.matches = matches; listeners.forEach(fn => fn()) }
  return { matchMedia, turn, listeners }
}

describe('watchFormStack', () => {
  it('asks for the form-stack query', () => {
    const { matchMedia } = fakeMatchMedia(false)
    watchFormStack(document.createElement('div'), matchMedia)
    expect(matchMedia).toHaveBeenCalledWith(FORM_STACK_QUERY)
  })

  it('never sets the class in landscape', () => {
    const el = document.createElement('div')
    watchFormStack(el, fakeMatchMedia(false).matchMedia)
    expect(el.className).toBe('')
  })

  it('follows the device as it turns, and stops when unsubscribed', () => {
    const el = document.createElement('div')
    const { matchMedia, turn, listeners } = fakeMatchMedia(true)
    const stop = watchFormStack(el, matchMedia)
    expect(el.classList.contains(FORM_STACK_CLASS)).toBe(true)
    turn(false)
    expect(el.classList.contains(FORM_STACK_CLASS)).toBe(false)
    turn(true)
    expect(el.classList.contains(FORM_STACK_CLASS)).toBe(true)
    stop()
    expect(listeners.size).toBe(0)
  })

  it('does nothing without matchMedia', () => {
    const el = document.createElement('div')
    expect(() => watchFormStack(el, undefined)()).not.toThrow()
    expect(el.className).toBe('')
  })
})

// Portrait tablets the owner scores on (CSS px), plus a 1200x1920 panel at 2x.
const PORTRAIT_TABLETS = [[800, 1280], [768, 1024], [834, 1194], [600, 960], [1200, 1920]]
// Landscape screens whose layout must not change.
const LANDSCAPE = [[1280, 800], [1024, 768], [800, 600], [1366, 768], [1920, 1080]]

describe('isViewportTooSmall (scorer app size gate)', () => {
  it.each(PORTRAIT_TABLETS)('lets a %ix%i portrait tablet in', (w, h) => {
    expect(isViewportTooSmall(w, h)).toBe(false)
  })

  it.each(LANDSCAPE)('lets a %ix%i landscape screen in', (w, h) => {
    expect(isViewportTooSmall(w, h)).toBe(false)
  })

  it.each([[390, 844], [844, 390], [700, 700], [599, 1000], [1000, 599]])('blocks %ix%i', (w, h) => {
    expect(isViewportTooSmall(w, h)).toBe(true)
  })
})

describe('isFormStacked (one field per row)', () => {
  it.each(PORTRAIT_TABLETS)('stacks on a %ix%i portrait tablet', (w, h) => {
    expect(isFormStacked(w, h)).toBe(true)
  })

  it.each(LANDSCAPE)('keeps the columns on a %ix%i landscape screen', (w, h) => {
    expect(isFormStacked(w, h)).toBe(false)
  })

  it('stacks a square viewport (CSS calls it portrait)', () => {
    expect(isFormStacked(1000, 1000)).toBe(true)
  })

  it('stacks a landscape viewport narrower than 800 (fullscreen only)', () => {
    expect(isFormStacked(780, 500)).toBe(true)
  })

  it('agrees with the media query a browser evaluates', () => {
    expect(FORM_STACK_QUERY).toBe('(orientation: portrait), (max-width: 799.98px)')
  })
})
