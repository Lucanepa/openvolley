import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useRef, useState } from 'react'
import { MenuPopover } from '../MenuPopover.jsx'
import { menusAsModal, MENU_MODAL_BELOW } from '../menuLayout.js'
import { setSummaryFit } from '../../components/scoreboard/setSummaryFit.js'

const setWindow = (width, height) => {
  window.innerWidth = width
  window.innerHeight = height
}

// jsdom has no layout: the button's box and the panel's size are given here
function mockLayout ({ anchor, panelHeight = 400, panelWidth = 240 }) {
  const rect = (r) => ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r })
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      if (this.dataset?.anchor !== undefined) return rect(anchor)
      return rect({ top: 0, left: 0, right: 0, bottom: 0 })
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      return this.dataset?.menuPopover !== undefined ? panelHeight : 0
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
      return this.dataset?.menuPopover !== undefined ? panelWidth : 0
    })
  ]
  return () => spies.forEach((s) => s.mockRestore())
}

function Harness ({ initiallyOpen = true, onClose = () => {}, side = 'bottom' }) {
  const anchorRef = useRef(null)
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <div>
      <p>page</p>
      <button ref={anchorRef} data-anchor="" type="button" onClick={() => setOpen(!open)}>Match</button>
      <MenuPopover
        open={open}
        onClose={(reason) => { onClose(reason); setOpen(false) }}
        anchorRef={anchorRef}
        label="Match"
        side={side}
        closeLabel="Close"
      >
        <button type="button" role="menuitem">Show PINs</button>
        <button type="button" role="menuitem">Options</button>
      </MenuPopover>
    </div>
  )
}

describe('menusAsModal (ui/menuLayout.js)', () => {
  it('phones and small tablets, either way round, get the centred modal', () => {
    expect(menusAsModal({ width: 1005, height: 600 })).toBe(true) // Galaxy Tab A7 Lite, density 1.33
    expect(menusAsModal({ width: 893, height: 533 })).toBe(true) // the same at density 1.5
    expect(menusAsModal({ width: 962, height: 601 })).toBe(true) // 8" tablet sideways
    expect(menusAsModal({ width: 390, height: 844 })).toBe(true) // phone
    expect(menusAsModal({ width: 844, height: 390 })).toBe(true) // phone sideways
  })

  it('a 10" tablet, a laptop (also in a short window) and a desktop keep the popover', () => {
    expect(menusAsModal({ width: 1280, height: 800 })).toBe(false)
    expect(menusAsModal({ width: 1366, height: 650 })).toBe(false)
    expect(menusAsModal({ width: 820, height: 1180 })).toBe(false)
    expect(menusAsModal({ width: 1440, height: 900 })).toBe(false)
    expect(menusAsModal({ width: 0, height: 0 })).toBe(false)
  })

  it('shares its size with the scoring screen\'s centred court menus', async () => {
    const { CENTRED_DIALOGS_BELOW } = await import('../../components/scoreboard/phoneLayout.js')
    expect(CENTRED_DIALOGS_BELOW).toEqual(MENU_MODAL_BELOW)
  })
})

describe('MenuPopover as a popover (large screen)', () => {
  let restore = () => {}
  beforeEach(() => setWindow(1440, 900))
  afterEach(() => restore())

  it('hangs under its button and stays inside the window', () => {
    restore = mockLayout({ anchor: { top: 60, bottom: 92, left: 1300, right: 1400 } })
    render(<Harness />)
    const panel = document.querySelector('[data-menu-popover="popover"]')
    expect(panel).toHaveAttribute('role', 'menu')
    expect(panel.style.top).toBe('98px') // 92 + 6
    expect(panel.style.left).toBe('1160px') // right edges lined up: 1400 - 240
    expect(panel.style.maxHeight).toBe('')
  })

  it('opens upwards when there is more room above, and scrolls inside the room it has (innerHeight, not 100vh)', () => {
    setWindow(1440, 700)
    restore = mockLayout({ anchor: { top: 600, bottom: 640, left: 100, right: 200 }, panelHeight: 800 })
    render(<Harness />)
    const panel = document.querySelector('[data-menu-popover="popover"]')
    // above: 600 - 6 - 8 = 586px of room
    expect(panel.style.maxHeight).toBe('586px')
    expect(panel.style.top).toBe('8px')
  })

  it('a press outside closes it, a press on its button or inside does not; Escape closes and refocuses the button', () => {
    restore = mockLayout({ anchor: { top: 60, bottom: 92, left: 100, right: 200 } })
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Options' }))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Match' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByText('page'))
    expect(onClose).toHaveBeenCalledWith('outside')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Match' }))
    screen.getAllByRole('menuitem')[1].focus()
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenLastCalledWith('escape')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Match' }))
  })

  it('is rendered into the document body (no ancestor can move or clip it)', () => {
    restore = mockLayout({ anchor: { top: 60, bottom: 92, left: 100, right: 200 } })
    const { container } = render(<Harness />)
    const panel = document.querySelector('[data-menu-popover]')
    expect(container.contains(panel)).toBe(false)
    expect(panel.parentElement).toBe(document.body)
  })
})

describe('MenuPopover as a centred modal (phone, small tablet)', () => {
  beforeEach(() => setWindow(1005, 600))

  it('is a modal dialog named like the menu, with a close button, never taller than the window', () => {
    render(<Harness />)
    const dialog = screen.getByRole('dialog', { name: 'Match' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('data-menu-popover', 'modal')
    expect(dialog.style.maxHeight).toBe('576px') // 600 - 24
    // the rows keep their menu
    expect(screen.getByRole('menu', { name: 'Match' })).toContainElement(screen.getByRole('menuitem', { name: 'Show PINs' }))
    expect(screen.getByText('Match', { selector: 'p' })).toBeInTheDocument()
  })

  it('closes with its close button, Escape or a tap on the scrim; a tap inside does not', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Harness onClose={onClose} />)
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Options' }))
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Options' }))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenLastCalledWith('close')

    rerender(<Harness onClose={onClose} key="2" />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenLastCalledWith('escape')

    rerender(<Harness onClose={onClose} key="3" />)
    const scrim = document.querySelector('[data-menu-modal] > [aria-hidden="true"]')
    fireEvent.pointerDown(scrim)
    fireEvent.pointerUp(scrim)
    fireEvent.click(scrim)
    expect(onClose).toHaveBeenLastCalledWith('outside')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('turns back into a popover when the window grows (rotation, a larger window)', () => {
    render(<Harness />)
    expect(document.querySelector('[data-menu-popover="modal"]')).not.toBeNull()
    act(() => {
      setWindow(1440, 900)
      window.dispatchEvent(new Event('resize'))
    })
    expect(document.querySelector('[data-menu-popover="modal"]')).toBeNull()
    expect(document.querySelector('[data-menu-popover="popover"]')).not.toBeNull()
  })
})

describe('setSummaryFit (scoring screen set tables)', () => {
  // A row's height for a table box of `box` px (scale factor 1), as the CSS computes it
  const rowHeight = (box, rows, usual, ratio, border) => {
    const share = box / rows
    const font = Math.min(usual, share * ratio)
    const pad = Math.min(4, share * 0.08)
    return font * 1.2 + 2 * pad + border
  }

  it('the header and all five set rows fit the same box, down to a 40px table box', () => {
    for (const box of [40, 60, 80, 100, 128, 160]) {
      for (let sets = 1; sets <= 5; sets++) {
        const { rows } = setSummaryFit(sets)
        expect(rows).toBe(sets + 1)
        const total = rowHeight(box, rows, 13, 0.5, 2) + sets * rowHeight(box, rows, 15, 0.56, 1)
        expect(total, `${sets} sets in ${box}px`).toBeLessThanOrEqual(box)
      }
    }
  })

  it('keeps the usual sizes while there is room (set 1 on a 128px box)', () => {
    const fit = setSummaryFit(1)
    expect(fit.td.fontSize).toBe('min(calc(15px * var(--scale-factor)), calc((100cqh / 2) * 0.56))')
    expect(fit.th.fontSize).toBe('min(calc(13px * var(--scale-factor)), calc((100cqh / 2) * 0.5))')
    expect(fit.tableBox.containerType).toBe('size')
    expect(rowHeight(128 - 0, 2, 15, 0.56, 1)).toBeCloseTo(15 * 1.2 + 8 + 1)
  })
})
