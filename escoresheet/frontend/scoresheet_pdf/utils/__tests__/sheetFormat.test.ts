import { describe, it, expect } from 'vitest'
import {
  buildScoresheetFilename,
  buildScoresheetTitle,
  displayShortName,
  findOfficial,
  formatClockHoursMinutes,
  formatDob,
  formatHoursMinutes,
  formatPersonName,
  formatSheetDate,
  gameNumberOf,
  isPlaceholderTeamName,
  localDateStamp,
  normalizeOfficials,
  sanitizeFilenamePart
} from '../sheetFormat'

// Dates built from LOCAL parts: the expectations hold in any time zone
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString()

describe('formatDob (field-spec 12.3)', () => {
  it('prints every stored format as DD.MM.YYYY', () => {
    expect(formatDob('19.04.1982')).toBe('19.04.1982') // MatchSetup
    expect(formatDob('1979-09-02')).toBe('02.09.1979') // referee DB / sync (ISO)
    expect(formatDob('1979-09-02T00:00:00.000Z')).toBe('02.09.1979')
    expect(formatDob('7.6.1988')).toBe('07.06.1988') // typed short
    expect(formatDob('03/12/1985')).toBe('03.12.1985') // test seeds
    expect(formatDob('03-12-1985')).toBe('03.12.1985')
  })
  it('leaves the 01.01.1900 placeholder and nothing empty', () => {
    for (const p of ['01.01.1900', '1900-01-01', '01/01/1900', '', '  ', null, undefined]) expect(formatDob(p)).toBe('')
  })
  it('prints anything else verbatim, never "Invalid Date"', () => {
    expect(formatDob('unknown')).toBe('unknown')
    expect(formatDob('31.02.2001')).toBe('31.02.2001')
    expect(formatDob('1990')).toBe('1990')
  })
})

describe('dates and times of the sheet', () => {
  it('the header date is the LOCAL day, DD.MM.YYYY (a match at 00:30 is not the day before)', () => {
    expect(formatSheetDate(local(2026, 10, 8, 0, 30))).toBe('08.10.2026')
    expect(formatSheetDate(local(2026, 10, 7, 23, 59))).toBe('07.10.2026')
    expect(formatSheetDate(undefined)).toBe('')
    expect(formatSheetDate('nonsense')).toBe('')
    expect(localDateStamp(local(2026, 10, 8, 0, 30))).toBe('20261008')
  })
  it('match times as "HH h MM min" and durations as "H h MM min"', () => {
    expect(formatClockHoursMinutes(local(2026, 10, 7, 19, 4))).toBe('19 h 04 min')
    expect(formatHoursMinutes(112)).toBe('1 h 52 min')
    expect(formatHoursMinutes(59)).toBe('0 h 59 min')
    expect(formatHoursMinutes(0)).toBe('')
    expect(formatHoursMinutes(-5)).toBe('')
  })
})

describe('game number and team names', () => {
  it('one game number for the header, the file name and the storage path', () => {
    expect(gameNumberOf({ gameNumber: '382208', game_n: 7 })).toBe('382208')
    expect(gameNumberOf({ gameNumber: '', game_n: 77 })).toBe('77')
    expect(gameNumberOf({ externalId: 'SV/2026-27 #12' })).toBe('SV-2026-27--12')
    expect(gameNumberOf({})).toBe('')
    expect(gameNumberOf(null)).toBe('')
  })
  it('placeholders (HOME / AWAY / Team A ...) never stand for a team', () => {
    for (const p of ['HOME', 'Away', 'home', 'Team A', 'TEAM B', 'teamB', '', null]) expect(isPlaceholderTeamName(p)).toBe(true)
    for (const n of ['KSCW', 'Homeland Volley', 'Team Aarau']) expect(isPlaceholderTeamName(n)).toBe(false)
    expect(displayShortName('HOME', 'KSC Wiedikon H1')).toBe('KSC Wiedikon H1')
    expect(displayShortName('', 'KSC Wiedikon H1')).toBe('KSC Wiedikon H1')
    expect(displayShortName('KSCW', 'KSC Wiedikon H1')).toBe('KSCW')
    expect(displayShortName('HOME', '')).toBe('HOME')
    expect(displayShortName(undefined, undefined)).toBe('')
  })
})

describe('file name (field-spec 13.4)', () => {
  const match = { gameNumber: '382208', homeShortName: 'KSCW-H1', awayShortName: 'Spada H1', scheduledAt: local(2026, 10, 7, 20, 0) }

  it('<YYYYMMDD>_<gameNo>_<Home>_vs_<Away>.pdf', () => {
    expect(buildScoresheetFilename({ match })).toBe('20261007_382208_KSCW-H1_vs_Spada-H1.pdf')
  })

  it('the owner\'s "match_HOME_AWAY": real team names, never "match" or the placeholders', () => {
    const quick = { gameNumber: '382208', homeShortName: 'HOME', awayShortName: 'AWAY', scheduledAt: local(2026, 10, 7, 20, 0) }
    expect(buildScoresheetFilename({ match: quick, homeTeam: { name: 'KSC Wiedikon H1' }, awayTeam: { name: 'Volley Spada Academica Zürich' } }))
      .toBe('20261007_382208_KSC-Wiedikon-H1_vs_Volley-Spada-Academica-Zuerich.pdf')
    // nothing known about the game number: left out with its "_"
    const name = buildScoresheetFilename({ match: { scheduledAt: local(2026, 10, 7, 20, 0) }, homeTeam: { name: 'A-Team' }, awayTeam: { name: 'B-Team' } })
    expect(name).toBe('20261007_A-Team_vs_B-Team.pdf')
    expect(name).not.toMatch(/match|HOME|AWAY/)
  })

  it('the local match date (not the UTC day), else set 1, else today', () => {
    expect(buildScoresheetFilename({ match: { ...match, scheduledAt: local(2026, 10, 8, 0, 30) } })).toMatch(/^20261008_/)
    expect(buildScoresheetFilename({ match: { ...match, scheduledAt: undefined }, sets: [{ index: 1, startTime: local(2026, 9, 1, 18, 0) }] })).toMatch(/^20260901_/)
    expect(buildScoresheetFilename({ match: { ...match, scheduledAt: undefined } }, new Date(2026, 0, 2, 9))).toMatch(/^20260102_/)
  })

  it('every part sanitised: no dots, slashes, spaces, umlauts; bounded length', () => {
    const name = buildScoresheetFilename({
      match: { externalId: 'SV/2026-27 #12', homeShortName: 'VBC SCHÖNENWERD-AARAU HERREN EINS', awayShortName: 'Lindaren Volley Amriswil Nachwuchs', scheduledAt: local(2026, 10, 7, 20) }
    })
    expect(name).toBe('20261007_SV-2026-27-12_VBC-SCHOENENWERD-AARAU-HERREN_vs_Lindaren-Volley-Amriswil-Nachw.pdf')
    expect(name.length).toBeLessThanOrEqual(120)
    expect(name.slice(0, -4)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(sanitizeFilenamePart('Zürich Genève Ça va', 60)).toBe('Zuerich-Geneve-Ca-va')
    expect(sanitizeFilenamePart('../a/b:c.d', 60)).toBe('a-b-c-d')
    expect(sanitizeFilenamePart('---', 60)).toBe('')
  })

  it('the PDF title names the match, never a federation', () => {
    const title = buildScoresheetTitle({ match, homeTeam: { name: 'KSC Wiedikon H1' }, awayTeam: { name: 'Volley Spada' } })
    expect(title).toBe('OpenVolley eScoresheet: KSC Wiedikon H1 vs Volley Spada, 07.10.2026, game 382208')
    expect(title).not.toMatch(/swiss/i)
  })
})

describe('names and officials', () => {
  it('"Lastname, F." for officials and players', () => {
    expect(formatPersonName('Moser', 'Claudia')).toBe('Moser, C.')
    expect(formatPersonName('de Montmollin', 'Jean-Baptiste')).toBe('de Montmollin, J.-B.')
    expect(formatPersonName('Hollenstein', 'maria theresia')).toBe('Hollenstein, M. T.')
    expect(formatPersonName('Moser', '')).toBe('Moser')
    expect(formatPersonName('', 'Claudia')).toBe('Claudia')
    expect(formatPersonName(null, undefined)).toBe('')
  })

  it('reads every stored shape of match.officials, never throws', () => {
    const array = normalizeOfficials([
      { role: '1st referee', firstName: 'Claudia', lastName: 'Moser', country: 'CHE', dob: '19.04.1982' },
      { role: 'scorer', first_name: 'Anna', last_name: 'Brun', dob: '1999-02-07' },
      { role: 'line judge 1', name: 'Marie Claire de la Fontaine' }
    ])
    expect(findOfficial(array, '1st Referee')).toMatchObject({ lastName: 'Moser', firstName: 'Claudia', country: 'CHE', dob: '19.04.1982' })
    expect(findOfficial(array, 'Scorer')).toMatchObject({ lastName: 'Brun', firstName: 'Anna' })
    expect(findOfficial(array, 'line judge 1')?.name).toBe('Marie Claire de la Fontaine')
    // the older role-keyed object (ManualAdjustments)
    const legacy = normalizeOfficials({ ref1: { firstName: 'Paul', lastName: 'Kunz' }, asstScorer: { first_name: 'Lea', last_name: 'Baumann' } })
    expect(findOfficial(legacy, '1st Referee')?.lastName).toBe('Kunz')
    expect(findOfficial(legacy, 'Assistant Scorer')?.lastName).toBe('Baumann')
    // aliases of the role
    expect(findOfficial(normalizeOfficials([{ role: 'ref2', lastName: 'X' }]), '2nd Referee')?.lastName).toBe('X')
    for (const bad of [null, undefined, 'x', 5, [null, 7]]) expect(() => normalizeOfficials(bad)).not.toThrow()
  })
})
