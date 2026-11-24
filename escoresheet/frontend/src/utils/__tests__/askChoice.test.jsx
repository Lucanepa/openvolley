// askChoice: the in-app dialog with a third answer (the desktop app's close:
// Hide window / Quit completely / Keep open).
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConfirmDialog } from '../../ui/ConfirmDialog.jsx'
import { askChoice, askConfirm } from '../askConfirm.js'

const QUESTION = { title: 'Keep it running?', confirmLabel: 'Hide', cancelLabel: 'Keep open', altLabel: 'Quit completely', altTone: 'danger' }

describe('askChoice', () => {
  it('shows the third button between cancel and confirm', async () => {
    render(<ConfirmDialog />)
    let answer
    act(() => { askChoice(QUESTION).then((a) => { answer = a }) })
    const buttons = (await screen.findByTestId('confirm-dialog')).querySelectorAll('button')
    expect([...buttons].map((b) => b.textContent)).toEqual(['Keep open', 'Quit completely', 'Hide'])
    await act(async () => { fireEvent.click(screen.getByTestId('confirm-alt')) })
    expect(answer).toBe('alt')
  })

  it("confirm is 'confirm', cancel and Escape are 'cancel'", async () => {
    render(<ConfirmDialog />)
    let answer
    act(() => { askChoice(QUESTION).then((a) => { answer = a }) })
    await act(async () => { fireEvent.click(await screen.findByTestId('confirm-accept')) })
    expect(answer).toBe('confirm')
    act(() => { askChoice(QUESTION).then((a) => { answer = a }) })
    await act(async () => { fireEvent.click(await screen.findByTestId('confirm-cancel')) })
    expect(answer).toBe('cancel')
    act(() => { askChoice(QUESTION).then((a) => { answer = a }) })
    await screen.findByTestId('confirm-dialog')
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(answer).toBe('cancel')
  })

  it('askConfirm has no third button', async () => {
    render(<ConfirmDialog />)
    act(() => { askConfirm({ title: 'Delete?' }) })
    await screen.findByTestId('confirm-dialog')
    expect(screen.queryByTestId('confirm-alt')).toBeNull()
  })
})
