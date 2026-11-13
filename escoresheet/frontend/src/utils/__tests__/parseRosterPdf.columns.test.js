import { describe, it, expect, vi } from 'vitest'

// The pdf.js stand-in: a document of `pages` pages, each with no text
const pdfjsMock = vi.hoisted(() => ({
  GlobalWorkerOptions: { workerSrc: '' },
  pages: 1,
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: pdfjsMock.pages,
      getPage: async () => ({ getTextContent: async () => ({ items: [] }) })
    }),
    destroy: vi.fn()
  }))
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min-TEST.mjs' }))
vi.mock('pdfjs-dist', () => pdfjsMock)

import { parseRosterContent, parseRosterPdf, parseRosterText, playersFromColumns, ROSTER_PDF_MAX_BYTES, ROSTER_PDF_MAX_PAGES } from '../parseRosterPdf'

// Positioned text items as pdf.js gives them: one row per y, a cell per item
// (or a word per item, as some PDFs split them). Made-up people and numbers.
const at = (y, cells) => cells.map(([x, str]) => ({ str, x, y, width: str.length * 5, page: 1 }))
const text = (items) => items.map((it) => it.str).join(' ')

// An Einsatzliste: SV number | first name | last name | gender | date of birth | LFP
const einsatzliste = [
  ...at(800, [[40, 'Einsatzliste'], [140, 'VBC'], [170, 'Musterdorf'], [260, 'Saison'], [300, '2026'], [340, '01.09.2026']]),
  ...at(760, [[40, 'SV-Nr'], [100, 'Vorname'], [200, 'Name'], [330, 'G'], [360, 'Geburtsdatum'], [450, 'LFP']]),
  ...at(740, [[40, '123456'], [100, 'Sofia'], [200, 'Garcia'], [237, 'Lopez'], [330, 'F'], [360, '14.03.2008'], [452, 'X']]),
  ...at(720, [[40, '234567'], [100, 'Anna'], [126, 'Maria'], [200, 'Muster'], [330, 'F'], [360, '02.07.2007']]),
  ...at(700, [[40, '345678'], [100, 'Noel'], [200, 'von Beispiel'], [330, 'M'], [360, '29.09.2006'], [451, 'X']]),
  // a licence row without the gender letter, and the line of the club
  ...at(680, [[40, '456789'], [100, 'Lea'], [200, 'Exemple'], [360, '07.10'], [385, '.2007']]),
  ...at(660, [[40, '987654'], [100, 'VBC'], [200, 'Musterdorf'], [330, 'H1']])
]

describe('playersFromColumns: the cells by their x positions', () => {
  it('an Einsatzliste: multi-word names stay in their cell, LFP by its column, no header or club line', () => {
    const players = playersFromColumns(einsatzliste)
    expect(players.map((p) => [p.licence, p.firstName, p.lastName, p.dob, p.isLfp, p.number])).toEqual([
      ['123456', 'Sofia', 'Garcia Lopez', '14/03/2008', true, null],
      ['234567', 'Anna Maria', 'Muster', '02/07/2007', false, null],
      ['345678', 'Noel', 'von Beispiel', '29/09/2006', true, null],
      ['456789', 'Lea', 'Exemple', '07/10/2007', false, null]
    ])
  })

  it('wins over the text patterns (which split by words)', () => {
    const r = parseRosterContent(text(einsatzliste), einsatzliste)
    expect(r.players.map((p) => [p.firstName, p.lastName, p.isLfp])).toEqual([
      ['Sofia', 'Garcia Lopez', true], ['Anna Maria', 'Muster', false], ['Noel', 'von Beispiel', true], ['Lea', 'Exemple', false]
    ])
    // the text alone splits by words: what the columns are for
    expect(parseRosterText(text(einsatzliste)).players[0]).toMatchObject({ firstName: 'Sofia Garcia', lastName: 'Lopez' })
  })

  it('a list with shirt numbers: last name first (the header says so), no digit run or date as a number', () => {
    const items = [
      ...at(800, [[40, 'Runde'], [80, '3'], [100, 'Volley'], [150, 'Musterdorf'], [300, '01.09.2026']]),
      ...at(760, [[40, 'Nr'], [80, 'Nachname'], [200, 'Vorname'], [330, 'Geburtsdatum']]),
      ...at(740, [[40, '7'], [80, 'Muster'], [200, 'Anna'], [226, 'Maria'], [330, '14.03.2008']]),
      ...at(720, [[40, '12'], [80, 'Garcia'], [117, 'Lopez'], [200, 'Sofia'], [330, '02.07.2007']]),
      ...at(700, [[40, '123456'], [80, 'Exemple'], [200, 'Lea'], [330, '03.04.2006']])
    ]
    expect(playersFromColumns(items).map((p) => [p.number, p.lastName, p.firstName])).toEqual([
      [7, 'Muster', 'Anna Maria'], [12, 'Garcia Lopez', 'Sofia']
    ])
  })

  it('no columns to tell apart: [] (the text patterns answer)', () => {
    expect(playersFromColumns([])).toEqual([])
    expect(playersFromColumns(at(740, [[40, '123456'], [100, 'Sofia Garcia Lopez'], [330, 'F'], [360, '14.03.2008']]))).toEqual([])
  })
})

describe('playersFromColumns: the headers of the row above the table, not the first such word', () => {
  // Labels in a team block above the table: "Name" (of the team) and "GFL" (a rule)
  const teamBlock = at(820, [[40, 'Name'], [100, 'Volley'], [150, 'Musterdorf'], [200, 'GFL'], [230, 'Regeln']])
  const expected = [
    ['123456', 'Sofia', 'Garcia Lopez', true], ['234567', 'Anna Maria', 'Muster', false],
    ['345678', 'Noel', 'von Beispiel', true], ['456789', 'Lea', 'Exemple', false]
  ]

  it('a "Name" or "GFL" label above the table swaps no names and moves no LFP mark', () => {
    for (const items of [[...teamBlock, ...einsatzliste], [...einsatzliste, ...teamBlock]]) {
      expect(playersFromColumns(items).map((p) => [p.licence, p.firstName, p.lastName, p.isLfp])).toEqual(expected)
    }
  })

  it('no row above the players holds both name headers: the Einsatzliste order (first name first)', () => {
    const noHeader = einsatzliste.filter((it) => it.y !== 760)
    const items = [...at(820, [[40, 'Name'], [100, 'Volley'], [150, 'Musterdorf']]), ...noHeader]
    expect(playersFromColumns(items).map((p) => [p.firstName, p.lastName])).toEqual(expected.map(([, f, l]) => [f, l]))
  })

  it('the text patterns take the LFP marks by the table\'s column too', () => {
    // one item per name: no columns to tell apart, the text answers
    const items = [
      ...teamBlock,
      ...at(760, [[40, 'SV-Nr'], [100, 'Vorname Name'], [330, 'G'], [360, 'Geburtsdatum'], [450, 'LFP']]),
      ...at(740, [[40, '123456'], [100, 'Sofia Garcia'], [330, 'F'], [360, '14.03.2008'], [452, 'X']]),
      ...at(720, [[40, '234567'], [100, 'Anna Muster'], [330, 'F'], [360, '02.07.2007']])
    ]
    expect(playersFromColumns(items)).toEqual([])
    const r = parseRosterContent(text(items), items)
    expect(r.players.map((p) => [p.licence, p.isLfp])).toEqual([['123456', true], ['234567', false]])
  })
})

describe('parseRosterText: numbers, header lines, LFP and the officials', () => {
  it('a shirt number is 1 to 99 on its own, and a header line with the match date is no player', () => {
    const r = parseRosterText('Saison 2026 Volley Musterdorf 01.09.2026 Runde 3 Volley Musterdorf 01.09.2026 7 Muster Anna 14.03.2008 123456 Garcia Sofia 02.07.2007')
    expect(r.players.map((p) => [p.number, p.lastName, p.firstName])).toEqual([[7, 'Muster', 'Anna']])
  })

  it('"1. Name First name" still reads', () => {
    const r = parseRosterText('1. Muster Anna 14.03.2008 2. Beispiel Eva 02.07.2007')
    expect(r.players.map((p) => [p.number, p.lastName])).toEqual([[1, 'Muster'], [2, 'Beispiel']])
  })

  it('LFP goes by the licence, also for a name with a particle or two words', () => {
    const r = parseRosterText('Einsatzliste 345678 Noel von Beispiel M 29.09.2006 123456 Sofia Garcia Lopez F 14.03.2008 234567 Lea Exemple F 03.04.2006', new Set(['345678', '123456']))
    expect(r.players.map((p) => [p.licence, p.isLfp])).toEqual([['345678', true], ['123456', true], ['234567', false]])
  })

  it('a name stops at the next label: "Coach: Hans Muster Assistant Coach 1: Anna Beispiel"', () => {
    const r = parseRosterText('Coach: Hans Muster Assistant Coach 1: Anna Beispiel')
    expect(r.coach).toEqual({ firstName: 'Hans', lastName: 'Muster', dob: '' })
    expect(r.ac1).toEqual({ firstName: 'Anna', lastName: 'Beispiel', dob: '' })
  })

  it('an assistant alone is no head coach', () => {
    for (const line of ['Assistant Coach: Anna Beispiel 14.03.1990', 'Assistenztrainer: Anna Beispiel 14.03.1990', 'Entraîneur adjoint: Anna Beispiel 14.03.1990']) {
      const r = parseRosterText(line)
      expect(r.coach, line).toBeNull()
      expect(r.ac1, line).toEqual({ firstName: 'Anna', lastName: 'Beispiel', dob: '14/03/1990' })
    }
  })
})

describe('parseRosterText: time', () => {
  // Two unbounded name groups in a row tried every split of a long run of
  // words: 8000 short words took about 2 s, a page-limit text a minute
  it('a long run of short words takes no time', () => {
    const t0 = performance.now()
    parseRosterText('1 ' + 'Ab '.repeat(8000) + 'end')
    parseRosterText('123456 ' + 'Ab '.repeat(8000) + 'M 14.03.2008')
    expect(performance.now() - t0).toBeLessThan(400)
  })
})

describe('parseRosterPdf: size and page limits before parsing', () => {
  it('a file over the size limit is refused unread', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(8))
    await expect(parseRosterPdf({ size: ROSTER_PDF_MAX_BYTES + 1, arrayBuffer })).rejects.toThrow(/not a roster/)
    expect(arrayBuffer).not.toHaveBeenCalled()
    await expect(parseRosterPdf({ arrayBuffer: async () => new ArrayBuffer(ROSTER_PDF_MAX_BYTES + 1) })).rejects.toThrow(/not a roster/)
    expect(pdfjsMock.getDocument).not.toHaveBeenCalled()
  })

  it('a document with too many pages is refused before its pages are read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    pdfjsMock.pages = ROSTER_PDF_MAX_PAGES + 1
    await expect(parseRosterPdf({ size: 10, arrayBuffer: async () => new ArrayBuffer(10) })).rejects.toThrow(/pages/)
    pdfjsMock.pages = 1
    await expect(parseRosterPdf({ size: 10, arrayBuffer: async () => new ArrayBuffer(10) })).resolves.toMatchObject({ players: [] })
  })
})
