import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { FitText } from '../components/FitText'

// A browser with a minimum font size (Android's WebView: 8px; a user's minimum
// in Chrome, Safari or Firefox) draws any smaller font-size at that minimum.
// jsdom lays nothing out: this test double measures one line of text as
// 0.5em per character, in a 100px box, with or without such a minimum.

let minimum = 0
const usedFont = (el: HTMLElement): number => {
  let e: HTMLElement | null = el
  while (e && !e.style.fontSize) e = e.parentElement
  const px = e ? parseFloat(e.style.fontSize) : 16
  return Math.max(minimum, px)
}
const realGetComputedStyle = window.getComputedStyle.bind(window)

beforeEach(() => {
  minimum = 0
  vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element, pseudo?: string | null) => {
    const real = realGetComputedStyle(el, pseudo)
    const font = `${usedFont(el as HTMLElement)}px`
    return new Proxy(real, {
      get (t, p) {
        if (p === 'fontSize') return font
        if (p === 'getPropertyValue') return (name: string) => (name === 'font-size' ? font : /^padding-/.test(name) ? '0px' : t.getPropertyValue(name))
        const v = (t as any)[p]
        return typeof v === 'function' ? v.bind(t) : v
      }
    })
  }) as any)
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get () { return (this as HTMLElement).style.width ? parseFloat((this as HTMLElement).style.width) : 100 } })
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get () { return ((this as HTMLElement).textContent || '').length * usedFont(this as HTMLElement) * 0.5 } })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (HTMLElement.prototype as any).clientWidth
  delete (HTMLElement.prototype as any).scrollWidth
})

// 32 characters: 16px per px of font, so 6px (96px) is the size that fits
const NAME = 'Schwarzenbach-Oberholzer1, M.-A.'

describe('FitText and the browser\'s minimum font size', () => {
  it('no minimum: the font shrinks, no inner box (the sheet as before)', () => {
    const clipped: boolean[] = []
    const { getByTestId } = render(<FitText max={9} min={5} data-testid="t" onClipped={c => clipped.push(c)}>{NAME}</FitText>)
    const el = getByTestId('t')
    expect(el.style.fontSize).toBe('6px')
    expect(el.querySelector('[data-fit-scale]')).toBeNull()
    expect(clipped.at(-1)).toBe(false)
  })

  it('held at 8px: the text is drawn at 8px in a box 1/k as wide, scaled by k = 6/8, and nothing is cut off', () => {
    minimum = 8
    const clipped: boolean[] = []
    const { getByTestId } = render(<FitText max={9} min={5} data-testid="t" onClipped={c => clipped.push(c)}>{NAME}</FitText>)
    const el = getByTestId('t')
    const inner = el.querySelector<HTMLElement>('[data-fit-scale]')!
    expect(inner).toBeTruthy()
    expect(inner.textContent).toBe(NAME)
    expect(el.style.fontSize).toBe('6px')
    expect(inner.dataset.fitScale).toBe('0.75')
    expect(inner.style.fontSize).toBe('8px')
    expect(parseFloat(inner.style.width)).toBeCloseTo(100 / 0.75, 3)
    // the outer size stays the box's own: the margin takes back what the width added
    expect(parseFloat(inner.style.width) + parseFloat(inner.style.marginRight)).toBeCloseTo(100, 3)
    expect(inner.style.transform).toBe('scale(0.75)')
    expect(clipped.at(-1)).toBe(false)
  })

  it('held at 8px but the text fits there: no inner box', () => {
    minimum = 8
    const { getByTestId } = render(<FitText max={9} min={5} data-testid="t">Anna Player</FitText>)
    expect(getByTestId('t').querySelector('[data-fit-scale]')).toBeNull()
  })

  it('still too long at min even scaled: told it is cut off', () => {
    minimum = 8
    const clipped: boolean[] = []
    const { getByTestId } = render(<FitText max={9} min={5} data-testid="t" onClipped={c => clipped.push(c)}>{NAME + NAME}</FitText>)
    expect(getByTestId('t').querySelector<HTMLElement>('[data-fit-scale]')!.dataset.fitScale).toBe('0.625')
    expect(clipped.at(-1)).toBe(true)
  })
})
