// Owner 17.11 on the Point Hub board: a court player's menu "opens very slowly
// (almost like a fade in), then flickers and becomes solid". The board's
// WebKitGTK composites in software: the 0.15 s roll-in (rollDown / rollUp,
// styles.css) put the menu on a layer of its own that faded in slowly and was
// dropped, with one blank frame, when the animation ended. On the board
// (window.__OV_POINTHUB_BOARD__, utils/pointHubBoard) <html> carries
// no-popover-motion and the menus just appear; tablets, phones and the
// desktop keep the roll-in. keepInViewport still places the menu.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useRef } from 'react'
import { render, cleanup } from '@testing-library/react'
import { POPOVER_NO_MOTION_CLASS, stillPopoversOnBoard } from '../../utils/pointHubBoard'
import { useKeepInViewport } from '../../ui/keepInViewport'

const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8')
// The roll-in rules at the top level, the @media (prefers-reduced-motion)
// block left out (jsdom applies a rule's body, not its media query)
const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
const rules = topLevel.match(/[^{}]*\.modal-wrapper-roll-(down|up)>div[^{}]*\{[^{}]*animation:[^{}]*\}/g).join('\n')

function Menu({ className = 'modal-wrapper-roll-down', top = 700 }) {
  const ref = useRef(null)
  useKeepInViewport(ref)
  return (
    <div ref={ref} data-testid="wrap" className={className} style={{ position: 'fixed', left: 100, top }}>
      <div data-testid="menu">menu</div>
    </div>
  )
}

function mount(props) {
  const style = document.createElement('style')
  style.textContent = rules
  document.head.appendChild(style)
  return render(<Menu {...props} />)
}

const animationOf = (el) => getComputedStyle(el).animation || getComputedStyle(el).animationName

afterEach(() => {
  cleanup()
  document.head.querySelectorAll('style').forEach(s => s.remove())
  document.documentElement.classList.remove(POPOVER_NO_MOTION_CLASS)
  delete window.__OV_POINTHUB_BOARD__
})

describe('menus on the Point Hub board open without the roll-in', () => {
  it('the board flag puts no-popover-motion on <html>; elsewhere nothing changes', () => {
    expect(stillPopoversOnBoard()).toBe(false)
    expect(document.documentElement.classList.contains(POPOVER_NO_MOTION_CLASS)).toBe(false)
    window.__OV_POINTHUB_BOARD__ = true
    expect(stillPopoversOnBoard()).toBe(true)
    expect(document.documentElement.classList.contains(POPOVER_NO_MOTION_CLASS)).toBe(true)
  })

  for (const className of ['modal-wrapper-roll-down', 'modal-wrapper-roll-up']) {
    it(`${className}: rolls in on a tablet, none on the board`, () => {
      const { getByTestId, unmount } = mount({ className })
      expect(animationOf(getByTestId('menu'))).toMatch(/roll(Down|Up)/)
      unmount()
      window.__OV_POINTHUB_BOARD__ = true
      stillPopoversOnBoard()
      const again = mount({ className })
      expect(animationOf(again.getByTestId('menu'))).toMatch(/^none/)
    })
  }

  it('the stylesheet: the board rule disables both, after the roll-in rules', () => {
    const board = css.indexOf('.no-popover-motion .modal-wrapper-roll-down>div')
    expect(board).toBeGreaterThan(css.indexOf('.modal-wrapper-roll-down>div {'))
    expect(css.slice(board, css.indexOf('}', board))).toMatch(/\.no-popover-motion \.modal-wrapper-roll-up>div\s*\{\s*animation: none;/)
  })

  it('keepInViewport still moves a menu low on the screen back inside it, with no animation', () => {
    window.__OV_POINTHUB_BOARD__ = true
    stillPopoversOnBoard()
    window.innerWidth = 1280
    window.innerHeight = 800
    const orig = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.dataset?.testid === 'menu') return { left: 100, right: 300, top: 700, bottom: 900, width: 200, height: 200 }
      return orig.call(this)
    }
    try {
      const { getByTestId } = mount({})
      expect(getByTestId('wrap').style.translate).toBe('0px -112px')
      expect(animationOf(getByTestId('menu'))).toMatch(/^none/)
    } finally {
      HTMLElement.prototype.getBoundingClientRect = orig
    }
  })
})
