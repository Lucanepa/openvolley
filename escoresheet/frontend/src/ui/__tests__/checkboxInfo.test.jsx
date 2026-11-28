// ui/Checkbox's `info`: the explanation in an (i) beside the row, outside its
// <label> (28.11.2026: Match setup's sponsors on clothing), so a tap on the
// (i) never ticks the box.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { Checkbox } from '../Checkbox.jsx'
import { resetInfoPopoversForTests } from '../infoPopover.js'

afterEach(() => resetInfoPopoversForTests())

describe('Checkbox info', () => {
  it('the (i) beside the label, not in it: a tap opens the text and leaves the box as it was', () => {
    const onChange = vi.fn()
    render(<Checkbox className="mt-3" data-testid="box" label="Sponsors on clothing" info="Marked (+) or (-) after the team name." checked={false} onChange={onChange} />)
    const box = screen.getByTestId('box')
    const dot = screen.getByRole('button', { name: 'More information' })
    expect(box.closest('label').contains(dot)).toBe(false)
    // the spacing goes on the row around both
    expect(box.closest('label').parentElement.className).toContain('mt-3')
    act(() => { fireEvent.click(dot) })
    expect(screen.getByText('Marked (+) or (-) after the team name.')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
    // the label still ticks the box
    act(() => { fireEvent.click(screen.getByText('Sponsors on clothing')) })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('without info: the label as before, the hint as its second line', () => {
    render(<Checkbox className="mt-3" data-testid="box" label="A" hint="Second line" checked={false} onChange={() => {}} />)
    expect(screen.getByTestId('box').closest('label').className).toContain('mt-3')
    expect(screen.getByText('Second line')).toBeTruthy()
    expect(screen.queryByRole('button')).toBe(null)
  })
})
