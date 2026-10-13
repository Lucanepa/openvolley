import { describe, it, expect } from 'vitest'
import { accessFromRoles, normalizeRoles, accessChanged, clubVerdict, matchClubBlock, NO_ACCESS } from '../access'

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

describe('clubs (db/018)', () => {
  const ksc = { id: 'c1', name: 'KSC Wiedikon', teams: ['KSC Wiedikon H1', 'KSC Wiedikon D2'] }
  const scorer = (clubs, clubRule = true) => ({ ...accessFromRoles(['scorer']), clubs, clubRule })

  it('clubVerdict: nothing while the rule is off, for admins, or before a home team is known', () => {
    expect(clubVerdict(scorer([], false), 'VBC Other H1')).toBeNull()
    expect(clubVerdict({ ...accessFromRoles(['admin']), clubs: [], clubRule: true }, 'VBC Other H1')).toBeNull()
    expect(clubVerdict(scorer([ksc]), '')).toBeNull()
  })

  it('clubVerdict: no club, a home game of a club (any spelling of spaces and case), another club', () => {
    expect(clubVerdict(scorer([]), 'KSC Wiedikon H1')).toEqual({ code: 'OV_CLUB_REQUIRED', home_team: 'KSC Wiedikon H1', clubs: [] })
    expect(clubVerdict(scorer([ksc]), ' ksc  wiedikon d2 ')).toBeNull()
    expect(clubVerdict(scorer([ksc]), 'VBC Other H1')).toEqual({ code: 'OV_NOT_YOUR_CLUB', home_team: 'VBC Other H1', clubs: ['KSC Wiedikon'] })
  })

  it('accessChanged: a club added or removed, or the rule switched, is a change (blocked jobs may go)', () => {
    const a = scorer([ksc])
    expect(accessChanged(a, scorer([ksc]))).toBe(false)
    expect(accessChanged(a, scorer([]))).toBe(true)
    expect(accessChanged(a, scorer([ksc], false))).toBe(true)
    // a team added to the same club is a change too (CodeRabbit on #11)
    expect(accessChanged(a, scorer([{ ...ksc, teams: [...ksc.teams, 'KSC Wiedikon H2'] }]))).toBe(true)
    expect(accessChanged(a, scorer([{ ...ksc, teams: [...ksc.teams].reverse() }]))).toBe(false)
    expect(accessChanged(accessFromRoles(['scorer']), accessFromRoles(['scorer']))).toBe(false)
  })
})

describe('matchClubBlock (match setup, db/018)', () => {
  const ksc = { id: 'c1', name: 'KSC Wiedikon', teams: ['KSC Wiedikon H1'] }
  const access = { ...accessFromRoles(['scorer']), clubs: [ksc], clubRule: true }
  const away = { ok: false, code: 'OV_NOT_YOUR_CLUB', home_team: 'VBC Other H1', clubs: ['KSC Wiedikon'] }

  it('the server\'s answer wins, both ways', () => {
    expect(matchClubBlock({ access, server: away, homeTeam: 'KSC Wiedikon H1' })).toBe(away)
    expect(matchClubBlock({ access, server: { ok: true }, homeTeam: 'VBC Other H1', scheduleHome: 'VBC Other H1' })).toBeNull()
    expect(matchClubBlock({ access, server: null, homeTeam: 'VBC Other H1', scheduleHome: 'VBC Other H1' })).toBeNull()
  })

  it('offline: a schedule game of another club is blocked; a typed name only without any club', () => {
    expect(matchClubBlock({ access, server: undefined, homeTeam: 'VBC Other H1', scheduleHome: 'VBC Other H1' })?.code).toBe('OV_NOT_YOUR_CLUB')
    expect(matchClubBlock({ access, server: undefined, homeTeam: 'VBC Othr H1', scheduleHome: null })).toBeNull()
    expect(matchClubBlock({ access: { ...access, clubs: [] }, server: undefined, homeTeam: 'whatever' })?.code).toBe('OV_CLUB_REQUIRED')
  })

  it('a test match is never blocked', () => {
    expect(matchClubBlock({ access, server: away, homeTeam: 'VBC Other H1', isTest: true })).toBeNull()
  })
})
