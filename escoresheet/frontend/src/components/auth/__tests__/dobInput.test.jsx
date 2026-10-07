// Date of birth: typed DD.MM.YYYY text, EMPTY until the user types (an empty
// native date field showed today's date in WebKit: 06.10.2026 on a new account).
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}))

import DateOfBirthInput from '../DateOfBirthInput'
import { isoToDobText, parseDobText, shapeDobText } from '../dobInput'

const TODAY = new Date(2026, 9, 7) // 07.10.2026

describe('dobInput', () => {
  it('shapes typed digits into DD.MM.YYYY, separators end a group early', () => {
    expect(shapeDobText('06101990')).toBe('06.10.1990')
    expect(shapeDobText('6.10.1990')).toBe('6.10.1990')
    expect(shapeDobText('6/1/1990')).toBe('6.1.1990')
    expect(shapeDobText('0610')).toBe('06.10')
    expect(shapeDobText('06.')).toBe('06.')
    expect(shapeDobText('ab06x10y1990z99')).toBe('06.10.1990')
    expect(shapeDobText('')).toBe('')
  })

  it('reads a full, real, past date as ISO; empty is fine (optional)', () => {
    expect(parseDobText('06.10.1990', TODAY)).toEqual({ iso: '1990-10-06', valid: true })
    expect(parseDobText('6.1.1990', TODAY)).toEqual({ iso: '1990-01-06', valid: true })
    expect(parseDobText('', TODAY)).toEqual({ iso: '', valid: true })
    expect(parseDobText('07.10.2026', TODAY)).toEqual({ iso: '2026-10-07', valid: true })
  })

  it('refuses unfinished, impossible, future and pre-1900 dates', () => {
    for (const bad of ['06.10', '06.10.199', '31.02.1990', '29.02.2023', '08.10.2026', '01.01.1899', '00.01.1990', '01.13.1990']) {
      expect(parseDobText(bad, TODAY), bad).toEqual({ iso: null, valid: false })
    }
    expect(parseDobText('29.02.2024', TODAY).valid).toBe(true)
  })

  it('shows a stored ISO date (or timestamp) as DD.MM.YYYY, anything else as empty', () => {
    expect(isoToDobText('1990-10-06')).toBe('06.10.1990')
    expect(isoToDobText('1990-10-06T00:00:00Z')).toBe('06.10.1990')
    expect(isoToDobText(null)).toBe('')
    expect(isoToDobText('')).toBe('')
  })
})

function Harness({ initial = '', onValue }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <DateOfBirthInput value={value} onChange={(v) => { setValue(v); onValue?.(v) }} aria-label="Date of birth" />
      <button type="button" onClick={() => setValue('1985-03-04')}>load profile</button>
    </>
  )
}

describe('DateOfBirthInput', () => {
  it('starts EMPTY: a text field with a DD.MM.YYYY hint, never today\'s date', () => {
    render(<Harness />)
    const input = screen.getByLabelText('Date of birth')
    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('placeholder', 'DD.MM.YYYY')
    expect(input).toHaveAttribute('inputmode', 'numeric')
    expect(input).toHaveAttribute('autocomplete', 'bday')
  })

  it('reports null while unfinished, the ISO date once complete, \'\' when cleared', () => {
    const onValue = vi.fn()
    render(<Harness onValue={onValue} />)
    const input = screen.getByLabelText('Date of birth')
    fireEvent.change(input, { target: { value: '0610' } })
    expect(input).toHaveValue('06.10')
    expect(onValue).toHaveBeenLastCalledWith(null)
    fireEvent.change(input, { target: { value: '06.10.1990' } })
    expect(onValue).toHaveBeenLastCalledWith('1990-10-06')
    fireEvent.change(input, { target: { value: '' } })
    expect(onValue).toHaveBeenLastCalledWith('')
  })

  it('keeps an autofilled ISO date whole, and follows a value set from outside (a loaded profile)', () => {
    render(<Harness />)
    const input = screen.getByLabelText('Date of birth')
    fireEvent.change(input, { target: { value: '1990-10-06' } })
    expect(input).toHaveValue('06.10.1990')
    fireEvent.click(screen.getByRole('button', { name: 'load profile' }))
    expect(input).toHaveValue('04.03.1985')
  })
})
