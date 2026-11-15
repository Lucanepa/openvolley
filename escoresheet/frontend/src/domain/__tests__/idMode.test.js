import { describe, it, expect } from 'vitest'
import { idModeOf, cleanIdValue, ID_SHEET_HEADING } from '../idMode'

describe('idMode', () => {
  it('defaults to dob for anything unknown', () => {
    expect(idModeOf(null)).toBe('dob')
    expect(idModeOf({ idMode: 'zzz' })).toBe('dob')
    expect(idModeOf({ idMode: 'text' })).toBe('text')
    expect(idModeOf({ idMode: 'number' })).toBe('number')
  })
  it('cleans what is typed', () => {
    expect(cleanIdValue('number', ' 12 34!x ')).toBe('1234x')
    expect(cleanIdValue('text', '7b (Klasse)')).toBe('7b (Klasse)')
    expect(cleanIdValue('text', 'x'.repeat(80))).toHaveLength(40)
  })
  it('has a heading per mode', () => {
    expect(ID_SHEET_HEADING).toEqual({ dob: 'DoB', number: 'ID', text: 'Info' })
  })
})
