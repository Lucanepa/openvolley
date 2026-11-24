import { useLayoutEffect } from 'react'

// Anchored menus on the scoring screen (player action menu, sanction
// dropdown, bench menu) open next to the tapped player and are drawn at 1.5x.
// Low on the court, or once a section (Sanction) is expanded, they ran off
// the bottom of the screen (the board: 1280x800 at page zoom 1.5). The hook
// moves the menu back inside the window, and lets it scroll when it is taller
// than the window. It runs before paint (layout effect) and again whenever
// the menu's content changes size, so the menu never shows in the wrong place.

export const VIEWPORT_MARGIN = 12

// How far to move a box [start, end] along one axis to fit [0, size].
// A box larger than the room is pinned to the start (top / left).
export function fitShift(start, end, size, margin = VIEWPORT_MARGIN) {
  const room = size - 2 * margin
  if (end - start > room) return margin - start
  if (end > size - margin) return size - margin - end
  if (start < margin) return margin - start
  return 0
}

// wrapper: the positioned element; its first child is the drawn (scaled) menu
export function fitInViewport(wrapper, margin = VIEWPORT_MARGIN) {
  const menu = wrapper.firstElementChild || wrapper
  const viewW = window.innerWidth
  const viewH = window.innerHeight
  menu.style.maxHeight = ''
  menu.style.overflowY = ''
  wrapper.style.translate = ''
  let rect = menu.getBoundingClientRect()
  const scale = menu.offsetHeight ? rect.height / menu.offsetHeight : 1
  if (rect.height > viewH - 2 * margin && scale > 0) {
    menu.style.maxHeight = `${(viewH - 2 * margin) / scale}px`
    menu.style.overflowY = 'auto'
    rect = menu.getBoundingClientRect()
  }
  const dx = fitShift(rect.left, rect.right, viewW, margin)
  const dy = fitShift(rect.top, rect.bottom, viewH, margin)
  if (dx || dy) wrapper.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`
  return { dx, dy }
}

export function useKeepInViewport(ref, active = true) {
  useLayoutEffect(() => {
    const wrapper = ref.current
    if (!active || !wrapper) return undefined
    const fit = () => fitInViewport(wrapper)
    fit()
    const menu = wrapper.firstElementChild
    const ro = typeof ResizeObserver === 'function' && menu ? new ResizeObserver(fit) : null
    // ResizeObserver reports layout size; our own maxHeight change can
    // re-trigger it once, which settles (same result the second time)
    if (ro) ro.observe(menu)
    window.addEventListener('resize', fit)
    return () => {
      if (ro) ro.disconnect()
      window.removeEventListener('resize', fit)
    }
  }, [ref, active])
}
