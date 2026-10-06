import { describe, it, expect } from 'vitest'
import { accessFromRoles, normalizeRoles, accessChanged, NO_ACCESS } from '../access'

describe('normalizeRoles', () => {
  it('accepts arrays, Postgres array literals and comma lists', () => {
    expect(normalizeRoles([' Scorer ', 'ADMIN'])).toEqual(['scorer', 'admin'])
    expect(normalizeRoles('{scorer,"admin"}')).toEqual(['scorer', 'admin'])
    expect(normalizeRoles('referee, scorer')).toEqual(['referee', 'scorer'])
  })
  it('drops empty and duplicate values and handles junk', () => {
    expect(normalizeRoles(['scorer', 'SCORER', '', null])).toEqual(['scorer'])
    expect(normalizeRoles(null)).toEqual([])
    expect(normalizeRoles(42)).toEqual([])
    expect(normalizeRoles('{}')).toEqual([])
  })
})

describe('accessFromRoles', () => {
  it('an account without roles is pending and can do nothing', () => {
    const a = accessFromRoles([])
    expect(a).toMatchObject({ isPending: true, canScore: false, isAdmin: false, canManageTeams: false, canReadTeams: false })
  })
  it('unknown roles grant nothing and keep the account pending', () => {
    expect(accessFromRoles(['guest'])).toMatchObject({ isPending: true, canScore: false, roles: ['guest'] })
  })
  it('a scorer scores and reads saved teams but does not manage them', () => {
    expect(accessFromRoles(['scorer'])).toMatchObject({ isPending: false, canScore: true, canReadTeams: true, canManageTeams: false, isAdmin: false })
  })
  it('a referee is not pending but cannot score', () => {
    expect(accessFromRoles(['referee'])).toMatchObject({ isPending: false, canScore: false, canReadTeams: false })
  })
  it('a competition manager manages and reads teams but does not score', () => {
    expect(accessFromRoles(['competition_manager'])).toMatchObject({ canManageTeams: true, canReadTeams: true, canScore: false })
  })
  it('admins and super admins can do everything', () => {
    for (const role of ['admin', 'super_admin', ' Admin ']) {
      expect(accessFromRoles([role])).toMatchObject({ isAdmin: true, canScore: true, canManageTeams: true, canReadTeams: true, isPending: false })
    }
    expect(accessFromRoles(['super_admin']).isSuperAdmin).toBe(true)
    expect(accessFromRoles(['admin']).isSuperAdmin).toBe(false)
  })
})

describe('accessChanged', () => {
  it('compares the capabilities, not the role order', () => {
    expect(accessChanged(accessFromRoles(['scorer', 'referee']), accessFromRoles(['referee', 'scorer']))).toBe(false)
    expect(accessChanged(accessFromRoles([]), accessFromRoles(['scorer']))).toBe(true)
    expect(accessChanged(NO_ACCESS, accessFromRoles([]))).toBe(true)
  })
})
