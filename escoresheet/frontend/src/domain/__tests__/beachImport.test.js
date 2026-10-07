// The Excel/CSV import in the browser (domain/beachImport.js, plan 3.4,
// phase T2): columns found loosely in four languages, CSV, Excel's numbers
// for dates and times, which sheet is which, and the template read back.
// What the values mean is checked on the server (backend tests).
import { describe, it, expect } from 'vitest'
import {
  ENTRY_COLUMNS, MATCH_COLUMNS, IMPORT_MAX_ENTRIES, cellText, columnLabel, decodeText, excelSerial, headerFields, parseCsv,
  readImportSheets, templateSheets, templateFileName
} from '../beachImport'
import { readWorkbook, writeWorkbook } from '../../lib/xlsxCodec'

const fieldsOf = (cells, kind) => [...headerFields(cells, kind).fields.values()]
const INFO = {
  title: 'OpenBeach import',
  lines: ['one', 'two'],
  exampleHead: 'Example',
  sheetNames: { entries: 'Entries', matches: 'Matches', info: 'Info' },
  examples: { draw: 'A1', gender: 'Women', p1_last: 'Muster', game: '1' }
}

describe('columns', () => {
  it('knows the template headers of every language and common other names', () => {
    for (const lang of ['en', 'de', 'fr', 'it']) {
      expect(fieldsOf(ENTRY_COLUMNS.map((c) => c.labels[lang]), 'entries')).toEqual(ENTRY_COLUMNS.map((c) => c.key))
      expect(fieldsOf(MATCH_COLUMNS.map((c) => c.labels[lang]), 'matches')).toEqual(MATCH_COLUMNS.map((c) => c.key))
    }
    expect(fieldsOf(['Kategorie', 'Sex', 'Nachname 1', 'Vorname 1', 'Lizenz 1', 'Nation 1', 'P2 Last', 'P2 First', 'Player 2 License', 'Nationality Player 2', 'WC'], 'entries'))
      .toEqual(['draw', 'gender', 'p1_last', 'p1_first', 'p1_licence', 'p1_country', 'p2_last', 'p2_first', 'p2_licence', 'p2_country', 'wildcard'])
    expect(fieldsOf(['Nr.', 'Datum', 'Beginn', 'Platz', 'Schiedsrichter'], 'matches')).toEqual(['game', 'date', 'time', 'court', 'referee'])
  })

  it('takes a field once and lists the columns it does not know', () => {
    const h = headerFields(['Draw', 'Category', 'Comment', '', 'Gender'], 'entries')
    expect([...h.fields]).toEqual([[0, 'draw'], [4, 'gender']])
    expect(h.unknown).toEqual(['Category', 'Comment'])
  })

  it('names a field in the language of the screen', () => {
    expect(columnLabel('p1_last', 'de-CH')).toBe('Spieler 1 Nachname')
    expect(columnLabel('game', 'fr')).toBe('Match n°')
    expect(columnLabel('referee', 'xx')).toBe('1st referee')
  })
})

describe('CSV', () => {
  it('reads Excel\'s Swiss CSV (semicolons), commas and tabs, quotes and line breaks', () => {
    expect(parseCsv('﻿Draw;Gender\r\nA1;"Damen; Senior"\r\n')).toEqual([['Draw', 'Gender'], ['A1', 'Damen; Senior']])
    expect(parseCsv('a,b\n"x ""y""",2')).toEqual([['a', 'b'], ['x "y"', '2']])
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('"multi\nline";x\n')).toEqual([['multi\nline', 'x']])
    expect(parseCsv('')).toEqual([])
  })

  it('decodes UTF-8, else Windows-1252', () => {
    expect(decodeText(new TextEncoder().encode('Zürich'))).toBe('Zürich')
    expect(decodeText(new Uint8Array([0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68]))).toBe('Zürich')
  })
})

describe('cells', () => {
  it('turns Excel\'s day numbers into dates and times by the column', () => {
    expect(excelSerial(46214)).toEqual({ day: '2026-07-11', time: null })
    expect(cellText(46214, 'date')).toBe('2026-07-11')
    expect(cellText(46214.5833333, 'date')).toBe('2026-07-11 14:00')
    expect(cellText(44752, 'date', { date1904: true })).toBe('2026-07-11')
    expect(cellText(0.395833333, 'time')).toBe('09:30')
    expect(cellText(46214.75, 'time')).toBe('18:00')
    expect(cellText('2026-07-11T00:00:00', 'date')).toBe('2026-07-11')
    expect(cellText('2026-07-11T09:30:00', 'date')).toBe('2026-07-11 09:30')
    // a time-only number in the Date column is no day (the server says bad_date), never 30.12.1899
    expect(cellText(0.375, 'date')).toBe('0.375')
  })

  it('keeps other numbers as written, booleans as yes / no, text trimmed', () => {
    expect(cellText(12345, 'p1_licence')).toBe('12345')
    expect(cellText(3, 'seed')).toBe('3')
    expect(cellText(0.1 + 0.2, 'seed')).toBe('0.3')
    expect(cellText(true, 'wildcard')).toBe('yes')
    expect(cellText('  Muster \n Anna ', 'p1_last')).toBe('Muster Anna')
    expect(cellText(null, 'draw')).toBe('')
  })
})

describe('sheets', () => {
  const entries = [
    ['Draw', 'Gender', 'Seed', 'Player 1 last name', 'Player 2 last name', 'Notes'],
    ['A1', 'W', 1, 'Muster', 'Beispiel', 'x'],
    [],
    ['A1', 'W', '', 'Keller', 'Frei']
  ]
  it('finds Entries and Matches by name or by their columns, also below a title row', () => {
    const r = readImportSheets([
      { name: 'Anmeldungen', rows: [['Züri Open 2026'], ...entries] },
      { name: 'Tabelle2', file: 'plan.xlsx', rows: [['Game #', 'Date', 'Time', 'Court'], [1, 46214, 0.375, 1]] },
      { name: 'Info', rows: [['Draw', 'A1'], ['Gender', 'Women']] }
    ])
    expect(r.problems).toEqual([])
    expect(r.found).toEqual([
      { name: 'Anmeldungen', kind: 'entries', rows: 2, unknown: ['Notes'] },
      { name: 'plan.xlsx · Tabelle2', kind: 'matches', rows: 1, unknown: [] }
    ])
    expect(r.payload.entries).toEqual([
      { row: 3, draw: 'A1', gender: 'W', seed: '1', p1_last: 'Muster', p2_last: 'Beispiel' },
      { row: 5, draw: 'A1', gender: 'W', seed: '', p1_last: 'Keller', p2_last: 'Frei' }
    ])
    expect(r.payload.matches).toEqual([{ row: 2, game: '1', date: '2026-07-11', time: '09:00', court: '1' }])
  })

  it('names what blocks the preview', () => {
    expect(readImportSheets([{ name: 'Sheet1', rows: [['a', 'b']] }]).problems).toEqual([{ code: 'nothing_found' }])
    expect(readImportSheets([{ name: 'Entries', rows: [['Draw', 'Player 1 last name']] }]).problems)
      .toEqual([{ code: 'missing_columns', kind: 'entries', sheet: 'Entries', columns: ['gender', 'p2_last'] }])
    expect(readImportSheets([{ name: 'Entries', rows: entries.slice(0, 1) }]).problems).toEqual([{ code: 'no_rows' }])
    const two = readImportSheets([{ name: 'a', file: 'a.csv', rows: entries }, { name: 'b', file: 'b.csv', rows: entries }])
    expect(two.problems).toEqual([{ code: 'duplicate_sheet', kind: 'entries', sheet: 'b.csv' }])
    const many = readImportSheets([{ name: 'Entries', rows: [entries[0], ...Array(IMPORT_MAX_ENTRIES + 1).fill(entries[1])] }])
    expect(many.problems[0].code).toBe('too_many_rows')
  })

  it('sends no empty sheet (an empty Entries sheet must not withdraw every pair)', () => {
    const r = readImportSheets([
      { name: 'Entries', rows: entries.slice(0, 1) },
      { name: 'Matches', rows: [['Game #', 'Court'], [3, 2]] }
    ])
    expect(r.problems).toEqual([])
    expect(r.payload).toEqual({ matches: [{ row: 2, game: '3', court: '2' }] })
  })
})

describe('template', () => {
  it('reads back as an import with every column, in every language', () => {
    for (const lang of ['en', 'de-CH', 'fr', 'it']) {
      const sheets = templateSheets(lang, INFO)
      const book = readWorkbook(writeWorkbook(sheets))
      expect(book.sheets.map((s) => s.name)).toEqual(['Entries', 'Matches', 'Info'])
      const head = readImportSheets(book.sheets.slice(0, 2).map((s) => ({ ...s, rows: [...s.rows, s.rows[0].map(() => 'x')] })))
      expect(head.problems).toEqual([])
      expect(head.found.map((f) => [f.kind, f.unknown])).toEqual([['entries', []], ['matches', []]])
      // the Info sheet is never taken for a sheet to import
      expect(readImportSheets([book.sheets[2]]).problems).toEqual([{ code: 'nothing_found' }])
    }
    expect(templateFileName({ slug: 'zuri-open-2026' })).toBe('zuri-open-2026-import.xlsx')
  })
})
