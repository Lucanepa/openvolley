import { describe, it, expect } from 'vitest'
import { FORM_STACK_QUERY, isFormStacked, isViewportTooSmall } from '../formLayout'

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
