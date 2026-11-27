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
  // globalImport.rostersHint / gamesHint name the columns and roles in the
  // app's language: a French or Italian sheet written from the hint reads the same
  it('reads the columns and roles the French hint names', () => {
    const r = parseRosters([
      ['Équipe', 'Numéro', 'Prénom', 'Nom', 'Rôle', 'Date de naissance'],
      ['Lions', 1, 'Anne', 'Exemple', 'Capitaine', '14.03.2008'],
      ['Lions', 2, 'Berthe', 'Exemple', 'joueuse', ''],
      ['Lions', 7, 'Claire', 'Exemple', 'libéro', ''],
      ['Lions', '', 'Chris', 'Exemple', 'Entraîneur', ''],
      ['Lions', '', 'Dana', 'Exemple', 'coach-adjoint', ''],
      ['Lions', '', 'Eva', 'Exemple', 'Physiothérapeute', ''],
      ['Lions', '', 'Fanny', 'Exemple', 'Médecin', '']
    ])
    expect(r.warnings).toEqual([])
    const [team] = r.teams
    expect(team.players.map(p => [p.number, p.isCaptain, p.libero, p.dob])).toEqual([[1, true, '', '14/03/2008'], [2, false, '', ''], [7, false, 'libero1', '']])
    expect(team.bench.map(b => b.role)).toEqual(['Coach', 'Assistant Coach 1', 'Physiotherapist', 'Medic'])
    const g = parseGames([['Match', 'Date', 'Heure', 'Salle', 'Ville', 'Ligue', 'Domicile', 'Visiteur', 'Best of', 'Arbitres'], [3, '14.11.2026', '09:00', 'Salle 1', 'Lausanne', 'M18', 'A', 'B', 3, 'Max Muster']])
    expect(g.games[0]).toMatchObject({ gameN: '3', time: '09:00', hall: 'Salle 1', city: 'Lausanne', league: 'M18', home: 'A', away: 'B', referee1Last: 'Muster' })
  })
  it('reads the columns and roles the Italian hint names', () => {
    const r = parseRosters([
      ['Squadra', 'Numero', 'Nome', 'Cognome', 'Ruolo', 'Data di nascita'],
      ['Leoni', 1, 'Anna', 'Esempio', 'capitano', '14.03.2008'],
      ['Leoni', 4, 'Bianca', 'Esempio', 'giocatrice', ''],
      ['Leoni', '', 'Carlo', 'Esempio', 'allenatore', '']
    ])
    expect(r.warnings).toEqual([])
    expect(r.teams[0].players.map(p => [p.firstName, p.isCaptain, p.dob])).toEqual([['Anna', true, '14/03/2008'], ['Bianca', false, '']])
    expect(r.teams[0].bench).toEqual([{ role: 'Coach', firstName: 'Carlo', lastName: 'Esempio', dob: '' }])
    const g = parseGames([['Partita', 'Data', 'Ora', 'Palestra', 'Città', 'Lega', 'Casa', 'Ospite', 'Best of', 'Arbitri'], [3, '14.11.2026', '09:00', 'P', 'Lugano', 'U18', 'A', 'B', 5, 'Max Muster']])
    expect(g.games[0]).toMatchObject({ gameN: '3', date: '2026-11-14', time: '09:00', hall: 'P', city: 'Lugano', home: 'A', away: 'B', bestOf: 5 })
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

describe('globalImport: what is printed beside a name', () => {
  const rows = [['Team', 'Number', 'Last name', 'Class'], ['A', 4, 'Roth', '9b'], ['A', 5, 'Lang', '10a']]
  it('keeps the cell as typed when the match uses text or numbers', () => {
    const r = parseRosters(rows, { idMode: 'text' })
    expect(r.teams[0].players.map(p => p.dob)).toEqual(['9b', '10a'])
    expect(parseRosters([['Team', 'No', 'Last name', 'ID'], ['A', 1, 'X', 100234]], { idMode: 'number' }).teams[0].players[0].dob).toBe('100234')
  })
  it('reads a date as a birthdate only in dob mode', () => {
    const d = [['Team', 'No', 'Last name', 'Date of birth'], ['A', 1, 'X', '14.03.2008']]
    expect(parseRosters(d).teams[0].players[0].dob).toBe('14/03/2008')
    expect(parseRosters(d, { idMode: 'text' }).teams[0].players[0].dob).toBe('14.03.2008')
  })
  it('the template follows the mode', () => {
    expect(rosterTemplate('number').rows[0][5]).toBe('ID number')
    expect(rosterTemplate('text').rows[1][5]).toBe('Class 9b')
  })
})
