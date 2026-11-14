// UI tour 14.11: the success toast "Away team synced to database!" landed
// over Match setup's Coin toss button; with the mouse resting on it, the
// toast paused and caught the clicks on Coin toss for over a minute. A toast
// never takes a click meant for the screen under it (at any width), and a
// pointer over its body does not keep it open: only its own close button
// takes the pointer.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ToastStack } from '../Toast.jsx'
import { toast } from '../index.js'

describe('a toast never blocks the screen under it', () => {
  afterEach(async () => {
    vi.useRealTimers()
    await act(async () => { toast.clear() })
    cleanup()
  })

  it('the card lets clicks through at every width; only the close button takes them', async () => {
    render(<ToastStack />)
    await act(async () => { toast.success('Away team synced to database!') })
    const card = screen.getByTestId('toast')
    const classes = card.className.split(/\s+/)
    expect(classes).toContain('pointer-events-none')
    expect(classes.filter((c) => /pointer-events-auto/.test(c))).toEqual([])
    expect(screen.getByTestId('toast-dismiss').className).toContain('pointer-events-auto')
  })

  it('a mouse resting on the card does not keep it open', async () => {
    vi.useFakeTimers()
    render(<ToastStack />)
    await act(async () => { toast.success('Away team synced to database!', { duration: 4000 }) })
    const card = screen.getByTestId('toast')
    fireEvent.pointerEnter(card, { pointerType: 'mouse' })
    await act(async () => { vi.advanceTimersByTime(4500) })
    expect(screen.queryByTestId('toast')).toBeNull()
  })
})
