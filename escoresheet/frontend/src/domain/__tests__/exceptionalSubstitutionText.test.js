import { describe, it, expect } from 'vitest'
import { exceptionalSubstitutionText } from '../remarks'

describe('exceptionalSubstitutionText (FIVB 15.7, 15.8)', () => {
  it('names an expulsion or a disqualification: a sanction, already on the sheet', () => {
    expect(exceptionalSubstitutionText(1, 10, 'expulsion')).toBe('#1 exceptionally substituted by #10 (expulsion)')
    expect(exceptionalSubstitutionText('4', '2', 'disqualification')).toBe('#4 exceptionally substituted by #2 (disqualification)')
  })
  it('never names an injury or an illness (no diagnosis in the record)', () => {
    expect(exceptionalSubstitutionText(9, 4, 'injury')).toBe('#9 exceptionally substituted by #4')
    expect(exceptionalSubstitutionText(9, 4, 'illness')).toBe('#9 exceptionally substituted by #4')
    expect(exceptionalSubstitutionText(9, 4)).toBe('#9 exceptionally substituted by #4')
  })
})
