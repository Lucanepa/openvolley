// The roster editor's note on dates of birth on 1 January (owner 2026-11-15:
// in the roster only, not at the coin toss). Made-up names.
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import i18n from '../../i18n'
import JanuaryDobNotice from '../JanuaryDobNotice'

const roster = [
  { number: 4, lastName: 'Muster', firstName: 'Anna', dob: '01.01.1900' },
  { number: 7, lastName: 'Beispiel', firstName: 'Bea', dob: '14.03.2005' }
]
const bench = [{ role: 'Coach', lastName: 'Trainer', firstName: 'Tom', dob: '01.01.1975' }]

beforeAll(async () => { await i18n.changeLanguage('en') })
afterEach(() => cleanup())

describe('JanuaryDobNotice', () => {
  it('names the people and their dates', () => {
    const { container } = render(<JanuaryDobNotice roster={roster} bench={bench} />)
    expect(container.textContent).toContain('Dates of birth on 1 January: Muster Anna (01.01.1900), Trainer Tom (01.01.1975).')
  })
  it('one person', () => {
    const { container } = render(<JanuaryDobNotice roster={roster.slice(0, 1)} bench={[]} />)
    expect(container.textContent).toContain('Date of birth on 1 January: Muster Anna (01.01.1900). It is often a placeholder')
  })
  it('a Swiss match (licence mode): the dates among the licences', () => {
    const swiss = [{ number: 2, lastName: 'Licence', firstName: 'Lia', dob: '123456' }, ...roster]
    const { container } = render(<JanuaryDobNotice roster={swiss} bench={bench} idMode="licence" />)
    expect(container.textContent).toContain('Dates of birth on 1 January: Muster Anna (01.01.1900), Trainer Tom (01.01.1975).')
    expect(container.textContent).not.toContain('123456')
    expect(render(<JanuaryDobNotice roster={[swiss[0]]} bench={[]} idMode="licence" />).container.textContent).toBe('')
  })
  it('nothing without such a date, or where the column holds ID numbers or text (Global)', () => {
    expect(render(<JanuaryDobNotice roster={roster.slice(1)} bench={[]} />).container.textContent).toBe('')
    expect(render(<JanuaryDobNotice roster={roster} bench={bench} idMode="number" />).container.textContent).toBe('')
  })
})
