import { describe, it, expect } from 'vitest'
import { cleanWord, ocrLines, rosterFromOcr, HANDWRITTEN_MAX } from '../ocrRoster'
import vmSkew from './fixtures/ocr-vm-de-skew.json'
import vmShot from './fixtures/ocr-vm-de-screenshot.json'
import tableDe from './fixtures/ocr-table-de-skew.json'
import tableIt from './fixtures/ocr-table-it-flat.json'
import vmDegraded from './fixtures/ocr-vm-de-degraded.json'
import { fieldIssues, importedRosterOf } from '../../../domain/importedRoster'

// The fixtures are Tesseract's answers (tesseract.js 7, deu+fra+ita, PSM 6)
// for made-up lists rendered from fixtures/source/*.html, turned into a
// skewed, unevenly lit "photo" (or a phone screenshot) and flattened by
// scan.js, as the app does (fixtures/README.md). vm-de is VolleyManager's
// layout (no rules, officials above the table, LK / LAS / E / ⚠ columns);
// table-* a ruled table. Numbers, C / K / L marks and a circle are written in
// a hand-like script.

const summary = (r) => r.players.map(p => `${p.number ?? '-'}${p.isCaptain ? 'C' : ''}${p.isLibero ? 'L' : ''}${p.isLfp ? 'X' : ''} ${p.licence}`)

describe('rosterFromOcr: VolleyManager\'s Einsatzliste in a photo', () => {
  for (const [name, data] of [['skewed photo', vmSkew], ['phone screenshot', vmShot]]) {
    it(`reads every row, the LAS column and the officials (${name})`, () => {
      const r = rosterFromOcr(data)
      // the circled 8 needs the page's pixels (opts.ringAt): without them no number, no captain
      expect(summary(r)).toEqual([
        '5X 91811', '- 323411', '11X 99122', '3LX 100311', '- 312922',
        '14X 174933', '7X 88544', '2L 328966', '9X 157011', '1 317644'
      ])
      expect(r.coach).toMatchObject({ firstName: 'Petra', lastName: 'Exempel', licence: '312977' })
      expect(r.ac1).toMatchObject({ firstName: 'Anna Maria', lastName: 'Mustermann', licence: '182399' })
      // "2. Assistant Coach: -"
      expect(r.ac2).toBeNull()
    })
  }

  it('the rest of a name on the line below goes to that name', () => {
    const last = rosterFromOcr(vmShot).players.find(p => p.licence === '317644')
    expect(last.firstName).toBe('Elena')
    expect(last.lastName).toMatch(/^Ram.rez-Cort.s Delgado$/)
  })

  it('a circle left of the SV number makes the captain; the number inside is left to be read again', () => {
    const asked = []
    const ringAt = (region, line) => {
      asked.push({ region, line })
      // the circle of the made-up list: left of 323411 only
      return region.x1 < 300 && region.y0 < 500 && region.y1 > 490 ? { ring: { x0: 120, y0: 470, x1: 180, y1: 535 }, inner: { x0: 142, y0: 490, x1: 158, y1: 515 } } : null
    }
    const r = rosterFromOcr(vmShot, { ringAt })
    const dora = r.players.find(p => p.licence === '323411')
    expect(dora).toMatchObject({ isCaptain: true, number: null, ringAt: { x0: 142, y0: 490, x1: 158, y1: 515 } })
    expect(dora.confidence.isCaptain).toBeLessThanOrEqual(HANDWRITTEN_MAX)
    // only rows without a number in front are asked about
    expect(r.players.filter(p => p.isCaptain)).toHaveLength(1)
    expect(asked.length).toBeLessThanOrEqual(2)
  })

  it('confidences: the reading\'s own, handwritten marks never above HANDWRITTEN_MAX', () => {
    const r = rosterFromOcr(vmShot)
    for (const p of r.players) {
      expect(p.confidence.licence).toBeGreaterThan(0.5)
      if (p.number !== null) expect(p.confidence.number).toBeLessThanOrEqual(HANDWRITTEN_MAX)
      if (p.isLibero) expect(p.confidence.isLibero).toBeLessThanOrEqual(HANDWRITTEN_MAX)
    }
  })
})

describe('rosterFromOcr: a poor reading loses no row', () => {
  // the skewed photo once more, re-saved as JPEG: an SV number with a digit
  // lost ("9122"), a date read as "16101083", the coach's name as "E==mp=!",
  // a gender "F" as "FF"
  const r = rosterFromOcr(vmDegraded)

  it('every row is there; what was misread is red or amber for the scorer', () => {
    expect(r.players.map(p => p.licence)).toEqual(['91811', '323411', '9122', '100311', '312922', '174933', '88544', '328966', '157011', '317644'])
    const issues = fieldIssues(importedRosterOf(r, 'ocr'))
    expect(issues.players[2].licence).toEqual({ level: 'invalid', reason: 'licence' })
    expect(issues.blocking).toBe(true)
  })

  it('a stand-in date found the row and is not kept', () => {
    const p = r.players.find(q => q.licence === '174933')
    expect(p).toMatchObject({ firstName: 'Ivana Sofia', number: 14, isLfp: true, dob: '' })
  })

  it('the coach with a misread name is kept, to check', () => {
    expect(r.coach).toMatchObject({ firstName: 'Petra', licence: '312977' })
    expect(r.coach.confidence.lastName).toBeLessThan(0.8)
  })

  it('"FF" is the gender F, not part of the name', () => {
    expect(r.players.find(q => q.licence === '328966').lastName).not.toMatch(/FF/)
  })
})

describe('rosterFromOcr: a ruled table (German, Italian)', () => {
  it('German: numbers in front, C and L after the date, LFP, the coach and assistant', () => {
    const r = rosterFromOcr(tableDe)
    expect(summary(r)).toEqual([
      '4 123451', '7C 123452', '9 123453', '-X 123454', '12 123455', '1L 123456',
      '15 123457', '3 123458', '- 123459', '10LX 123460', '6 123461', '2 123462'
    ])
    // the particle goes to the last name, as for a PDF
    expect(r.players[5].firstName).toBe('Tim')
    expect(r.players[5].lastName).toMatch(/^von Watten/)
    expect(r.coach).toMatchObject({ firstName: 'Hans', lastName: 'Muster', licence: '10001' })
    expect(r.ac1).toMatchObject({ firstName: 'Petra', lastName: 'Beispiel', licence: '10002' })
  })

  it('Italian headers (Nome / Cognome); "2. Allenatore assistente" is assistant 2 even with its words misread', () => {
    const r = rosterFromOcr(tableIt)
    expect(r.players).toHaveLength(12)
    expect(r.players[0]).toMatchObject({ firstName: 'Luca', lastName: 'Exempel', licence: '123451', number: 4 })
    expect(r.coach).toMatchObject({ firstName: 'Paolo', lastName: 'Bianchi', licence: '10003' })
    expect(r.ac1).toBeNull()
    expect(r.ac2).toMatchObject({ firstName: 'Giulia', lastName: 'Neri', licence: '10004' })
  })
})

// a line of words for rosterFromOcr: [text, x0] pairs on one row, confidence 90
const line = (y, words) => ({
  words: words.map(([text, x0, w = 10 * text.length]) => ({ text, confidence: 90, bbox: { x0, y0: y, x1: x0 + w, y1: y + 20 } }))
})
const page = (...lines) => ({ blocks: [{ paragraphs: [{ lines }] }] })

describe('rosterFromOcr: marks the team wrote in', () => {
  const header = line(100, [['SV-Nr.', 100], ['Vorname', 200], ['Name', 320], ['G', 460], ['Geburtsdatum', 500], ['LAS', 660]])
  const row = (y, before, after = []) => line(y, [...before, ['123456', 100], ['Anna', 200], ['Muster', 320], ['F', 460], ['14.03.2004', 500], ...after])

  it('K is the captain as C is; L a libero; read small or twice', () => {
    for (const [mark, captain, libero] of [['K', true, false], ['C', true, false], ['c', true, false], ['Cc', true, false], ['(C)', true, false], ['L', false, true], ['l', false, true]]) {
      const p = rosterFromOcr(page(header, row(140, [], [[mark, 900]]))).players[0]
      expect([mark, p.isCaptain, p.isLibero]).toEqual([mark, captain, libero])
    }
  })

  it('a number in front: the one nearest the SV number, split digits joined, look-alike letters read as digits', () => {
    expect(rosterFromOcr(page(header, row(140, [['7', 40]]))).players[0].number).toBe(7)
    expect(rosterFromOcr(page(header, row(140, [['K', 20], ['7', 50]]))).players[0]).toMatchObject({ number: 7, isCaptain: true })
    expect(rosterFromOcr(page(header, row(140, [['1', 40, 12], ['1', 55, 12]]))).players[0].number).toBe(11)
    expect(rosterFromOcr(page(header, row(140, [['IJ', 40, 24]]))).players[0].number).toBe(11)
  })

  it('a circled number: "(7)" as read, or a ring round its box (opts.circled)', () => {
    expect(rosterFromOcr(page(header, row(140, [['(7)', 40]]))).players[0]).toMatchObject({ number: 7, isCaptain: true })
    const circled = (w) => w.text === '9'
    expect(rosterFromOcr(page(header, row(140, [['9', 40]])), { circled }).players[0]).toMatchObject({ number: 9, isCaptain: true })
    expect(rosterFromOcr(page(header, row(140, [['8', 40]])), { circled }).players[0]).toMatchObject({ number: 8, isCaptain: false })
  })

  it('after the date a number counts only right of the printed table (a ✓ read as "4" does not)', () => {
    expect(rosterFromOcr(page(header, row(140, [], [['4', 665]]))).players[0].number).toBeNull()
    expect(rosterFromOcr(page(header, row(140, [], [['4', 900]]))).players[0].number).toBe(4)
  })

  it('the X under LAS is the LFP mark; under another column it is not', () => {
    const wide = line(100, [['SV-Nr.', 100], ['Vorname', 200], ['Name', 320], ['G', 460], ['Geburtsdatum', 500], ['LAS', 660], ['E', 760]])
    expect(rosterFromOcr(page(wide, row(140, [], [['X', 690]]))).players[0].isLfp).toBe(true)
    expect(rosterFromOcr(page(wide, row(140, [], [['X', 780]]))).players[0].isLfp).toBe(false)
  })
})

describe('cleanWord and ocrLines', () => {
  it('cleanWord: rules and specks out, digits for look-alikes in numbers and dates, a lost dot back', () => {
    expect(cleanWord('|')).toBe('')
    expect(cleanWord('[123451')).toBe('123451')
    expect(cleanWord('12O45l')).toBe('120451')
    expect(cleanWord('1O.03.2OO4')).toBe('10.03.2004')
    expect(cleanWord('11.122000')).toBe('11.12.2000')
    expect(cleanWord('“L')).toBe('L')
    expect(cleanWord('(LFP')).toBe('LFP')
    expect(cleanWord('(7')).toBe('(7')
    expect(cleanWord('Müller')).toBe('Müller')
    expect(cleanWord('(1980)')).toBe('(1980)')
  })

  it('ocrLines: lines that lie beside each other are one row', () => {
    const lines = ocrLines(page(line(100, [['123456', 100]]), line(104, [['Anna', 200]]), line(140, [['234567', 100]])))
    expect(lines).toHaveLength(2)
    expect(lines[0].words.map(w => w.text)).toEqual(['123456', 'Anna'])
  })
})
