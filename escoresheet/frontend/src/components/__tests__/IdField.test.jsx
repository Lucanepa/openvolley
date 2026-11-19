// The value beside a person's name (components/IdField, domain/idMode): a
// Swiss match's licence or date of birth in a text field (owner 2026-11-19),
// a Global match's own choice. Made-up values.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key), i18n: { language: 'en', resolvedLanguage: 'en' } })
}))

import IdField from '../IdField'

afterEach(() => cleanup())

function Controlled({ idMode = 'licence', initial = '', onValue = () => {} }) {
  const [v, setV] = useState(initial)
  return (
    <IdField
      idMode={idMode}
      rawValue={v}
      onRawChange={(next) => { setV(next); onValue(next) }}
      aria-label="value"
      value=""
      onChange={() => {}}
    />
  )
}

describe('IdField', () => {
  it('licence mode: a text field (the iPad numeric keypad has no "."), the hint as its title', () => {
    render(<Controlled />)
    const input = screen.getByLabelText('value')
    expect(input).toHaveAttribute('inputMode', 'text')
    expect(input).toHaveAttribute('maxLength', '10')
    expect(input).toHaveAttribute('title', 'or date of birth (dd.mm.yyyy)')
  })

  it('keeps the dots while a date is typed and tidies it when the field is left', () => {
    const onValue = vi.fn()
    render(<Controlled onValue={onValue} />)
    const input = screen.getByLabelText('value')
    fireEvent.change(input, { target: { value: '14.3.' } })
    expect(input).toHaveValue('14.3.')
    fireEvent.change(input, { target: { value: '14.3.2008' } })
    fireEvent.blur(input)
    expect(input).toHaveValue('14.03.2008')
    expect(onValue).toHaveBeenLastCalledWith('14.03.2008')
  })

  it('a licence keeps its digits; letters never get in', () => {
    render(<Controlled />)
    const input = screen.getByLabelText('value')
    fireEvent.change(input, { target: { value: 'SV 123 456' } })
    fireEvent.blur(input)
    expect(input).toHaveValue('123456')
  })

  it('shows the 01.01.1900 placeholder of an older match empty', () => {
    render(<Controlled initial="01.01.1900" />)
    expect(screen.getByLabelText('value')).toHaveValue('')
  })

  it('a Global match on birthdates gets the date field; on numbers the numeric keypad', () => {
    const { unmount } = render(<IdField idMode="dob" aria-label="dob" value="2008-03-14" onChange={() => {}} />)
    expect(screen.getByLabelText('dob')).toHaveValue('14.03.2008')
    expect(screen.getByLabelText('dob')).toHaveAttribute('inputMode', 'numeric')
    unmount()
    render(<Controlled idMode="number" />)
    expect(screen.getByLabelText('value')).toHaveAttribute('inputMode', 'numeric')
  })
})
