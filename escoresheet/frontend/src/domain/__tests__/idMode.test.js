import { describe, it, expect } from 'vitest'
import { idModeOf, cleanIdValue, typedIdValue, isDateValue, licenceOf, dateValueText, isPlaceholderValue, personLicence, importedIdValue, idLabelOf, ID_SHEET_HEADING, ID_LABEL_FALLBACK } from '../idMode'

describe('idMode', () => {
  it('a Swiss match (anything not Global) carries the licence, whatever idMode it has', () => {
    expect(idModeOf(null)).toBe('licence')
    expect(idModeOf({})).toBe('licence')
    expect(idModeOf({ test: true })).toBe('licence')
    expect(idModeOf({ global: false, idMode: 'text' })).toBe('licence')
  })
  it('a Global match keeps its choice, dob for anything unknown', () => {
    expect(idModeOf({ global: true })).toBe('dob')
    expect(idModeOf({ global: true, idMode: 'zzz' })).toBe('dob')
    expect(idModeOf({ global: true, idMode: 'licence' })).toBe('dob')
    expect(idModeOf({ global: true, idMode: 'text' })).toBe('text')
    expect(idModeOf({ global: true, idMode: 'number' })).toBe('number')
  })
  it('cleans what is typed (Global modes unchanged)', () => {
    expect(cleanIdValue('number', ' 12 34!x ')).toBe('1234x')
    expect(cleanIdValue('text', '7b (Klasse)')).toBe('7b (Klasse)')
    expect(cleanIdValue('text', 'x'.repeat(80))).toHaveLength(40)
  })
  it('has a heading and a label per mode', () => {
    expect(ID_SHEET_HEADING).toEqual({ dob: 'DoB', number: 'ID', text: 'Info', licence: 'Licence' })
    expect(ID_LABEL_FALLBACK.licence).toBe('Licence')
  })
})

describe('the licence value rule', () => {
  it('a date is told by its separator (".", "/", "-") or the ISO shape', () => {
    for (const v of ['14.03.2008', '1.3.2008', '14/03/2008', '14-03-2008', '14.03.08', '2008-03-14', '2008-03-14T00:00:00.000Z', ' 14.03.2008 ']) {
      expect(isDateValue(v)).toBe(true)
    }
    for (const v of ['123456', '1403', '14.03', '14.03.2', '', null, undefined, 'abc', '12 345']) {
      expect(isDateValue(v)).toBe(false)
    }
  })
  it('dates are written dd.mm.yyyy', () => {
    expect(dateValueText('1.3.2008')).toBe('01.03.2008')
    expect(dateValueText('14/03/2008')).toBe('14.03.2008')
    expect(dateValueText('2008-03-14')).toBe('14.03.2008')
    expect(dateValueText('14.03.08')).toBe('14.03.2008')
    expect(dateValueText('14.03.95')).toBe('14.03.1995')
    expect(dateValueText('123456')).toBe(null)
  })
  it('a licence: digits only, at most 10', () => {
    expect(licenceOf('123456')).toBe('123456')
    expect(licenceOf(123456)).toBe('123456')
    expect(licenceOf(' 12 345 ')).toBe('12345')
    expect(licenceOf('12345678901234')).toBe('1234567890')
    expect(licenceOf('14.03.2008')).toBe(null)
    expect(licenceOf('SV 12345')).toBe(null)
    expect(licenceOf('')).toBe(null)
    expect(licenceOf(null)).toBe(null)
  })
  it('cleanIdValue("licence"): a date dd.mm.yyyy, else the digits, the placeholder empty', () => {
    expect(cleanIdValue('licence', '14.03.2008')).toBe('14.03.2008')
    expect(cleanIdValue('licence', '1/3/2008')).toBe('01.03.2008')
    expect(cleanIdValue('licence', '2008-03-14')).toBe('14.03.2008')
    expect(cleanIdValue('licence', ' 123456 ')).toBe('123456')
    expect(cleanIdValue('licence', 'SV-123 456')).toBe('123456')
    expect(cleanIdValue('licence', '14.03')).toBe('1403')
    expect(cleanIdValue('licence', '12345678901234')).toBe('1234567890')
    for (const p of ['01.01.1900', '1.1.1900', '01/01/1900', '1900-01-01', '', '   ', null, undefined]) {
      expect(cleanIdValue('licence', p)).toBe('')
    }
  })
  it('typedIdValue keeps a date being typed (the dot) and drops letters', () => {
    expect(typedIdValue('licence', '14.')).toBe('14.')
    expect(typedIdValue('licence', '14.03.20')).toBe('14.03.20')
    expect(typedIdValue('licence', '14.03.2008x')).toBe('14.03.2008')
    expect(typedIdValue('licence', 'ab12c3')).toBe('123')
    expect(typedIdValue('licence', '12345678901')).toBe('1234567890')
    expect(typedIdValue('number', ' 12 34!x ')).toBe('1234x')
  })
  it('isPlaceholderValue knows every spelling of 01.01.1900', () => {
    for (const p of ['01.01.1900', '1.1.1900', '01/01/1900', '1900-01-01']) expect(isPlaceholderValue(p)).toBe(true)
    for (const v of ['01.01.1901', '123456', '']) expect(isPlaceholderValue(v)).toBe(false)
  })
  it('personLicence: the value when it is a licence, else an older scorer\'s own licence field', () => {
    expect(personLicence({ dob: '123456' })).toBe('123456')
    expect(personLicence({ dob: '14.03.2008', licence: '7654' })).toBe('7654')
    expect(personLicence({ dob: '', licence: ' 7654 ' })).toBe('7654')
    expect(personLicence({ dob: '14.03.2008' })).toBe(null)
    expect(personLicence(null)).toBe(null)
  })
})

describe('what comes into the value', () => {
  it('an Einsatzliste brings the licence, never the date of birth it prints (owner 2026-11-19)', () => {
    expect(importedIdValue({ dob: '14/03/2008', licence: '123456' }, 'licence')).toBe('123456')
    expect(importedIdValue({ dob: '14/03/2008' }, 'licence')).toBe('')
    expect(importedIdValue({ dob: '', birthYear: '1970', licence: '7654' }, 'licence')).toBe('7654')
    // a Global match on numbers takes the licence too; on birthdates nothing
    expect(importedIdValue({ licence: '123456' }, 'number')).toBe('123456')
    expect(importedIdValue({ dob: '14/03/2008', licence: '123456' }, 'dob')).toBe('')
  })
  it('idLabelOf: the screen\'s date label for dob, else the mode\'s', () => {
    const t = (key, fallback) => `${key}|${fallback}`
    expect(idLabelOf(t, 'dob', 'Date of birth')).toBe('Date of birth')
    expect(idLabelOf(t, 'licence', 'Date of birth')).toBe('idMode.label.licence|Licence')
    expect(idLabelOf(t, 'number', 'x')).toBe('idMode.label.number|ID number')
  })
})
