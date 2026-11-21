import { describe, it, expect } from 'vitest'
import { CHAMPIONSHIP_TYPES, championshipTypeFields, championshipTypeToSave } from '../championshipType'

describe('championshipTypeFields', () => {
  it('keeps the four stored values', () => {
    for (const v of CHAMPIONSHIP_TYPES) {
      expect(championshipTypeFields({ championshipType: v }).championshipType).toBe(v)
    }
  })

  it('maps a value typed by hand case-insensitively ("Regional", " NATIONAL ")', () => {
    expect(championshipTypeFields({ championshipType: 'Regional' })).toEqual({ championshipType: 'regional', championshipTypeOther: '' })
    expect(championshipTypeFields({ championshipType: ' NATIONAL ' }).championshipType).toBe('national')
    expect(championshipTypeFields({ championshipType: 'International' }).championshipType).toBe('international')
  })

  it('any other text is "Other" with that text, unless the match has its own', () => {
    expect(championshipTypeFields({ championshipType: 'Kantonal' })).toEqual({ championshipType: 'other', championshipTypeOther: 'Kantonal' })
    expect(championshipTypeFields({ championshipType: 'Kantonal', championshipTypeOther: 'Cup ZH' })).toEqual({ championshipType: 'other', championshipTypeOther: 'Cup ZH' })
  })

  it('none: empty, the legacy snake_case field read too', () => {
    expect(championshipTypeFields({})).toEqual({ championshipType: '', championshipTypeOther: '' })
    expect(championshipTypeFields(null)).toEqual({ championshipType: '', championshipTypeOther: '' })
    expect(championshipTypeFields({ championship_type: 'national' }).championshipType).toBe('national')
  })
})

describe('championshipTypeToSave', () => {
  it('the "Other" text only with other; nothing as null', () => {
    expect(championshipTypeToSave({ championshipType: 'regional', championshipTypeOther: 'left over' })).toEqual({ championshipType: 'regional', championshipTypeOther: null })
    expect(championshipTypeToSave({ championshipType: 'other', championshipTypeOther: 'Kantonal' })).toEqual({ championshipType: 'other', championshipTypeOther: 'Kantonal' })
    expect(championshipTypeToSave({ championshipType: 'other', championshipTypeOther: '' })).toEqual({ championshipType: 'other', championshipTypeOther: null })
    expect(championshipTypeToSave({ championshipType: '' })).toEqual({ championshipType: null, championshipTypeOther: null })
    expect(championshipTypeToSave({ championshipType: 'Regional' })).toEqual({ championshipType: 'regional', championshipTypeOther: null })
  })
})
