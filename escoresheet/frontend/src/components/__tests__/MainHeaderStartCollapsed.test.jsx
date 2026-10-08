// The app header on the scoring screen's phone layout: folded away from its
// first frame (startCollapsed). Folding it in an effect after the first paint
// showed it open for a frame and slid the phone layout up by its height on
// every load (a size jump).
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import '../../i18n'
import { ScaleProvider } from '../../contexts/ScaleContext'
import MainHeader from '../MainHeader'

// The account button needs the auth provider: not what this is about
vi.mock('../auth/UserButton', () => ({ default: () => null }))

// The thin bar that opens the folded header again
const foldedBar = (root) => [...root.querySelectorAll('div.h-4')].find(d => d.querySelector('svg'))

describe('MainHeader startCollapsed (phone scoring layout)', () => {
  it('is folded in the first commit: no open frame, no fold afterwards', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const seen = []
    const observer = new MutationObserver(records => seen.push(...records))
    observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] })
    render(<ScaleProvider><MainHeader collapsible startCollapsed matchId={1} /></ScaleProvider>, { container })
    seen.push(...observer.takeRecords())
    observer.disconnect()
    expect(foldedBar(container)).toBeTruthy()
    // The first commit inserts the header; nothing is re-styled or added after it
    const after = seen.slice(1)
    expect(after.filter(r => r.type === 'attributes')).toEqual([])
    expect(after.filter(r => r.type === 'childList')).toEqual([])
    container.remove()
  })

  it('its thin bar still opens it, and the desktop / tablet header starts open', () => {
    const { container, unmount } = render(<ScaleProvider><MainHeader collapsible startCollapsed matchId={1} /></ScaleProvider>)
    fireEvent.click(foldedBar(container))
    expect(foldedBar(container)).toBeFalsy()
    unmount()
    const open = render(<ScaleProvider><MainHeader collapsible matchId={1} /></ScaleProvider>)
    expect(foldedBar(open.container)).toBeFalsy()
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0)
  })
})
