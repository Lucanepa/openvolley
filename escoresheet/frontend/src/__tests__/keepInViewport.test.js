import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fitShift, fitInViewport } from '../ui/keepInViewport.js'

describe('fitShift', () => {
  it('leaves a box that fits alone', () => {
    expect(fitShift(100, 300, 800, 12)).toBe(0)
  })
  it('moves a box running off the end back in', () => {
    expect(fitShift(600, 900, 800, 12)).toBe(-112)
  })
  it('moves a box starting before the start back in', () => {
    expect(fitShift(-40, 200, 800, 12)).toBe(52)
  })
  it('pins a box larger than the room to the start', () => {
    expect(fitShift(300, 1300, 800, 12)).toBe(-288)
  })
})

describe('fitInViewport', () => {
  const realW = window.innerWidth
  const realH = window.innerHeight
  afterEach(() => {
    window.innerWidth = realW
    window.innerHeight = realH
  })

  const setup = (rect, offsetHeight) => {
    window.innerWidth = 1280
    window.innerHeight = 800
    const wrapper = document.createElement('div')
    const menu = document.createElement('div')
    wrapper.appendChild(menu)
    Object.defineProperty(menu, 'offsetHeight', { configurable: true, get: () => offsetHeight })
    menu.getBoundingClientRect = () => {
      // with maxHeight set, the drawn (1.5x) height is maxHeight * 1.5
      const mh = parseFloat(menu.style.maxHeight)
      const h = Number.isFinite(mh) ? mh * (rect.height / offsetHeight) : rect.height
      return { left: rect.left, right: rect.left + rect.width, top: rect.top, bottom: rect.top + h, width: rect.width, height: h }
    }
    return { wrapper, menu }
  }

  it('lifts a menu that runs off the bottom (expanded Sanction low on the court)', () => {
    const { wrapper } = setup({ left: 200, top: 500, width: 300, height: 450 }, 300)
    expect(fitInViewport(wrapper, 12)).toEqual({ dx: 0, dy: -162 })
    expect(wrapper.style.translate).toBe('0px -162px')
  })

  it('makes a menu taller than the window scroll, pinned to the top', () => {
    const { wrapper, menu } = setup({ left: 200, top: 100, width: 300, height: 1200 }, 800)
    fitInViewport(wrapper, 12)
    expect(menu.style.overflowY).toBe('auto')
    expect(parseFloat(menu.style.maxHeight)).toBeCloseTo((800 - 24) / 1.5)
    expect(wrapper.style.translate).toBe('0px -88px')
  })

  it('leaves a menu that fits untouched', () => {
    const { wrapper } = setup({ left: 200, top: 100, width: 300, height: 300 }, 200)
    expect(fitInViewport(wrapper, 12)).toEqual({ dx: 0, dy: 0 })
    expect(wrapper.style.translate).toBe('')
  })
})

describe('Scoreboard anchored menus', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../components/Scoreboard.jsx'), 'utf8')

  it('every anchored menu wrapper keeps itself inside the window', () => {
    const wrappers = src.match(/<div [^>]*className="(modal-wrapper-roll-(down|up)|sb-anchored-popover)"/g) || []
    expect(wrappers.length).toBeGreaterThan(0)
    for (const w of wrappers) expect(w).toMatch(/ref=\{\w+WrapRef\}/)
  })

  it('a team warned once gets no warning item (no disabled warning left)', () => {
    expect(src).not.toMatch(/\('warning'\)\}\s+disabled=/)
  })
})
