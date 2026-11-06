import { afterEach, describe, expect, it } from 'vitest'
import { onPointHubBoard, sheetToBench, sheetToMatchData, sheetToRoster } from '../pointHubBoard'

describe('pointHubBoard', () => {
  afterEach(() => { delete window.__OV_POINTHUB_BOARD__ })

  it('is a board only when the desktop app says so', () => {
    expect(onPointHubBoard()).toBe(false)
    window.__OV_POINTHUB_BOARD__ = true
    expect(onPointHubBoard()).toBe(true)
  })

  it('turns game info into a schedule pick', () => {
    const m = sheetToMatchData({ date: '2026-11-06', time: '20:00:00', hall: 'KWI A', number: 812, league: '3L', home: 'KSC Wiedikon H3', away: 'VBC Luzern', referees: ['Referee One', 'Referee Two'] })
    expect(m).toMatchObject({ date: '2026-11-06', time: '20:00', hall: 'KWI A', gameN: '812', league: '3L', home: 'KSC Wiedikon H3', away: 'VBC Luzern', referee1Last: 'Referee One', referee2Last: 'Referee Two' })
    expect(sheetToMatchData({}).gameN).toBe('')
  })

  it('numbers at most two liberos and keeps the captain', () => {
    const r = sheetToRoster([
      { number: 7, lastName: 'A', initial: 'B.', birthdate: '2000-02-01', captain: true },
      { number: 8, lastName: 'C', libero: true },
      { number: 9, lastName: 'D', libero: true },
      { number: 10, lastName: 'E', libero: true }
    ])
    expect(r.map((p) => p.libero)).toEqual(['', 'libero1', 'libero2', ''])
    expect(r[0]).toMatchObject({ number: 7, lastName: 'A', firstName: 'B.', isCaptain: true })
    expect(r[0].dob).toMatch(/2000/)
    expect(r[1].dob).toBe('')
  })

  it('maps bench roles, skips unknown ones and always has a coach row', () => {
    expect(sheetToBench([{ role: 'physio', lastName: 'P' }, { role: null, lastName: 'X' }]).map((b) => b.role)).toEqual(['Coach', 'Physiotherapist'])
    expect(sheetToBench([{ role: 'coach', lastName: 'C', initial: 'D.' }])).toEqual([{ role: 'Coach', firstName: 'D.', lastName: 'C', dob: '' }])
  })
})
