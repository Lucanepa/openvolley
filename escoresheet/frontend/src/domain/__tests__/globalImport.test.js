import { describe, it, expect } from 'vitest'
import { parseRosters, parseGames, toIsoDate, toTime, rosterTemplate, gamesTemplate } from '../globalImport'

describe('globalImport', () => {
  it('reads the roster template back, with roles', () => {
    const r = parseRosters(rosterTemplate().rows)
    expect(r.ok).toBe(true)
    expect(r.teams.map(t => t.name)).toEqual(['Team A', 'Team B'])
    const a = r.teams[0]
    expect(a.players).toHaveLength(3)
    expect(a.players[0]).toMatchObject({ number: 1, isCaptain: true, dob: '14/03/2008' })
    expect(a.players[1].libero).toBe('libero1')
    expect(a.bench).toEqual([{ role: 'Coach', firstName: 'Chris', lastName: 'Coach', dob: '' }])
  })
  it('finds German columns and a header below a title row', () => {
    const r = parseRosters([['Turnier'], [], ['Mannschaft', 'Nr', 'Vorname', 'Nachname', 'Rolle'], ['Wiking', 4, 'Jan', 'Roth', 'Spieler']])
    expect(r.ok).toBe(true)
    expect(r.teams[0].players[0]).toMatchObject({ number: 4, firstName: 'Jan', lastName: 'Roth' })
  })
  it('flags a bad number, rejects a sheet without a name column', () => {
    expect(parseRosters([['Team', 'Number', 'Last name'], ['A', 123, 'X']]).warnings).toHaveLength(1)
    expect(parseRosters([['foo', 'bar'], [1, 2]]).ok).toBe(false)
  })
  it('reads games with Excel dates and times', () => {
    const g = parseGames([['Game', 'Date', 'Time', 'Home', 'Away', 'Best of', '1st referee'], [5, 46340, 0.375, 'A', 'B', 'Best of 3', 'Muster, Max']])
    expect(g.ok).toBe(true)
    expect(g.games[0]).toMatchObject({ gameN: '5', date: '2026-11-14', time: '09:00', home: 'A', away: 'B', bestOf: 3, referee1First: 'Max', referee1Last: 'Muster' })
  })
  it('reads the games template', () => {
    const g = parseGames(gamesTemplate().rows)
    expect(g.games[0]).toMatchObject({ date: '2026-11-14', time: '09:00', bestOf: 3, referee2Last: 'Beispiel' })
  })
  it('dates and times in text form', () => {
    expect(toIsoDate('14.11.26')).toBe('2026-11-14')
    expect(toIsoDate('2026-1-4')).toBe('2026-01-04')
    expect(toTime('9.05')).toBe('09:05')
    expect(toTime('25:00')).toBe('')
  })
})
