import { describe, it, expect } from 'vitest'
import { cleanWord, ocrLines, rosterFromOcr, marksOfHand, withHandReadings, HANDWRITTEN_MAX } from '../ocrRoster'
import vmSkew from './fixtures/ocr-vm-de-skew.json'
import vmShot from './fixtures/ocr-vm-de-screenshot.json'
import tableDe from './fixtures/ocr-table-de-skew.json'
import tableIt from './fixtures/ocr-table-it-flat.json'
import vmDegraded from './fixtures/ocr-vm-de-degraded.json'
import vmAnywhere from './fixtures/ocr-vm-de-anywhere-skew.json'
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

  it('a circle on the row makes the captain; the number inside is left to be read again; a neighbour\'s circle does not', () => {
    const asked = []
    const ringAt = (region, line) => {
      asked.push({ region, line })
      // the circle of the made-up list, left of 323411: found by any search over that row
      return region.x0 < 150 && region.x1 > 180 && region.y0 < 470 && region.y1 > 535 ? { ring: { x0: 120, y0: 470, x1: 180, y1: 535 }, inner: { x0: 142, y0: 490, x1: 158, y1: 515 } } : null
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

describe('rosterFromOcr: marks written anywhere on the row (skewed photo)', () => {
  // vm-de-anywhere: numbers in the margin, between SV number and first name,
  // between the names and after the last name; a K beside a first name, an L
  // in the margin and after the date; a circle round an 8 over the first name
  const r = rosterFromOcr(vmAnywhere)
  const by = (licence) => r.players.find(p => p.licence === licence)

  it('keeps every row, also the one whose first name the circle covered', () => {
    expect(r.players).toHaveLength(10)
    expect(by('323411')).toMatchObject({ firstName: '', lastName: 'Muster' })
  })

  it('takes the numbers and marks wherever they stand', () => {
    expect(by('91811').number).toBe(5) // margin
    expect(by('174933')).toMatchObject({ number: 14, lastName: expect.stringMatching(/^Kova/) }) // between the names
    expect(by('88544')).toMatchObject({ number: 7, isCaptain: true, firstName: 'Fiona' }) // K beside the first name
    expect(by('328966')).toMatchObject({ number: 2, isLibero: true, firstName: 'Carla' }) // before the first name, L after the date
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

  it('anywhere a coach writes (owner: "next (left) or between name and licence, kinda everywhere")', () => {
    const at = (words) => rosterFromOcr(page(header, line(140, words))).players[0]
    const base = { licence: '123456', firstName: 'Anna', lastName: 'Muster' }
    // between the SV number and the first name
    expect(at([['123456', 100], ['7', 170], ['Anna', 200], ['Muster', 320], ['F', 460], ['14.03.2004', 500]])).toMatchObject({ ...base, number: 7 })
    // between first and last name, and after the last name
    expect(at([['123456', 100], ['Anna', 200], ['12', 280], ['Muster', 320], ['F', 460], ['14.03.2004', 500]])).toMatchObject({ ...base, number: 12 })
    expect(at([['123456', 100], ['Anna', 200], ['Muster', 320], ['9', 420], ['F', 460], ['14.03.2004', 500]])).toMatchObject({ ...base, number: 9 })
    // a mark right after the SV number (any form) or a bare capital between the names
    expect(at([['123456', 100], ['(K)', 165], ['Anna', 200], ['Muster', 320], ['F', 460], ['14.03.2004', 500]])).toMatchObject({ ...base, isCaptain: true })
    expect(at([['123456', 100], ['l', 165], ['Anna', 200], ['Muster', 320], ['F', 460], ['14.03.2004', 500]])).toMatchObject({ ...base, isLibero: true })
    expect(at([['123456', 100], ['Anna', 200], ['L', 290], ['Muster', 320], ['F', 460], ['14.03.2004', 500]])).toMatchObject({ ...base, isLibero: true })
    // the one in front wins over one further in
    expect(at([['4', 40], ['123456', 100], ['Anna', 200], ['12', 280], ['Muster', 320], ['F', 460], ['14.03.2004', 500]]).number).toBe(4)
  })

  it('a date the reading split ("14" "03.2004") is no shirt number, and the row stays', () => {
    const p = rosterFromOcr(page(header, line(140, [['123456', 100], ['Anna', 200], ['Muster', 320], ['F', 460], ['14', 500, 20], ['03.2004', 525]]))).players[0]
    expect(p).toMatchObject({ licence: '123456', firstName: 'Anna', lastName: 'Muster', number: null, dob: '' })
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

// The failure patterns of the owner's real photos (2026-11-26), on made-up
// lists: words with their own box ([text, x0, width?, conf?, dy?, height?]).
const wl = (y, words) => ({
  words: words.map(([text, x0, w = 10 * text.length, conf = 92, dy = 0, h = 20]) => ({ text, confidence: conf, bbox: { x0, y0: y + dy, x1: x0 + w, y1: y + dy + h } }))
})
const listHead = wl(100, [['SV-Nr.', 100], ['Vorname', 200], ['Nachname', 400], ['M/F', 600], ['Geburtsdatum', 660], ['LK', 820], ['LAS', 880]])
const person = (y, licence, first, last, dob, { before = [], between = [], after = [] } = {}) =>
  wl(y, [...before, [licence, 100], [first, 200], ...between, [last, 400], ['F', 610], [dob, 660], ['RLL', 820], ...after])
const players = (r) => r.players.map((p) => `${p.licence} ${p.firstName} ${p.lastName}`)

describe('rosterFromOcr: real photos\' failure patterns (made-up lists)', () => {
  it('two rows read close together, a big handwritten number reaching into the next, stay two rows', () => {
    const r = rosterFromOcr(page(listHead,
      person(140, '123456', 'Anna', 'Muster', '14.03.2004', { between: [['33', 300, 20, 90, -14, 44]] }),
      person(164, '234567', 'Bea', 'Beispiel', '02.05.2003', { between: [['12', 300, 20, 90, -8, 40]] })))
    expect(players(r)).toEqual(['123456 Anna Muster', '234567 Bea Beispiel'])
    expect(r.players.map((p) => p.number)).toEqual([33, 12])
  })

  it('a page edge read as a tall "|" does not join a line to the one above it', () => {
    const lines = ocrLines(page(wl(40, [['Generiert', 100], ['am:', 200]]), wl(60, [['|', 0, 4, 90, -30, 60], ['Coach:', 100], ['#312977', 170], ['Petra', 260], ['Exempel', 320], ['(1980)', 400]])))
    expect(lines).toHaveLength(2)
  })

  it('handwriting between the names stays out of them and is kept aside to read again', () => {
    const r = rosterFromOcr(page(listHead, person(140, '123456', 'Anna', 'Muster', '14.03.2004', { between: [['AT', 300, 20, 68], ['(x', 340, 20, 85]] })))
    expect(players(r)).toEqual(['123456 Anna Muster'])
    expect(r.players[0].handAt).toMatchObject({ left: 100, line: 20 })
  })

  it('a name and a circled number read as one word: the name stays ("Anna(1)")', () => {
    const r = rosterFromOcr(page(listHead, wl(140, [['123456', 100], ['Anna(1)', 200, 90], ['Muster', 400], ['F', 610], ['14.03.2004', 660]])))
    expect(r.players[0]).toMatchObject({ firstName: 'Anna', lastName: 'Muster', number: 1, isCaptain: true })
  })

  it('a name read with a small first letter gets its capital back', () => {
    const r = rosterFromOcr(page(listHead, person(140, '123456', 'anna', 'Muster', '14.03.2004')))
    expect(r.players[0].firstName).toBe('Anna')
  })

  it('a row whose SV number the photo cut off is kept, its SV number empty (to check), never dropped', () => {
    const r = rosterFromOcr(page(listHead,
      person(140, '123456', 'Anna', 'Muster', '14.03.2004'),
      wl(180, [['Bea', 200], ['Beispiel', 400], ['F', 610], ['02.05.2003', 660]])))
    expect(r.players).toHaveLength(2)
    const bea = r.players[1]
    expect(bea).toMatchObject({ licence: '', firstName: 'Bea', lastName: 'Beispiel' })
    expect(fieldIssues(importedRosterOf(r, 'ocr')).players[1].licence).toBeTruthy()
  })

  it('a row written in by hand under the table is shown, every field to check', () => {
    const r = rosterFromOcr(page(listHead,
      person(140, '123456', 'Anna', 'Muster', '14.03.2004'),
      wl(220, [['345678', 100, 60, 59], ['MEIER', 210, 50, 40], ['LINA', 400, 40, 92]])))
    const hand = r.players.find((p) => p.licence === '345678')
    expect(hand).toBeTruthy()
    expect(`${hand.firstName} ${hand.lastName}`).toMatch(/MEIER.*LINA/)
    for (const f of ['licence', 'firstName', 'lastName']) expect(hand.confidence[f]).toBeLessThanOrEqual(HANDWRITTEN_MAX)
  })

  it('an SV number starting a digit right of its column lost that digit: to check, read again from the column', () => {
    const r = rosterFromOcr(page(listHead,
      person(140, '123456', 'Anna', 'Muster', '14.03.2004'),
      person(180, '234567', 'Bea', 'Beispiel', '02.05.2003'),
      wl(220, [['23456', 117], ['Cleo', 200], ['Exempel', 400], ['F', 610], ['01.06.2001', 660]])))
    const cleo = r.players.find((p) => p.firstName === 'Cleo')
    expect(cleo.confidence.licence).toBeLessThanOrEqual(0.4)
    expect(cleo.licenceAt).toMatchObject({ lost: true })
    expect(cleo.licenceAt.x0).toBeLessThan(117)
  })

  it('a row struck out by hand is left out and named, never imported as playing', () => {
    const r = rosterFromOcr(page(listHead,
      person(140, '123456', 'Anna', 'Muster', '14.03.2004'),
      person(180, '234567', 'Bea', 'Beispiel', '02.05.2003')), { struck: (words) => words.some((w) => w.y0 >= 180) })
    expect(players(r)).toEqual(['123456 Anna Muster'])
    expect(r.struck).toEqual([{ firstName: 'Bea', lastName: 'Beispiel', licence: '234567' }])
    expect(importedRosterOf(r, 'ocr').struck).toHaveLength(1)
  })

  it('a page askew, its lower rows sloping more: the words of two rows Tesseract put in one line go back to their rows', () => {
    // each row drops more to the right; the reading put the end of row 3 with the start of row 4
    const slope = (row) => 0.012 + 0.004 * row
    const at = (row, x) => Math.round(140 + 44 * row + slope(row) * (x - 100))
    const words = (row, list) => list.map(([text, x]) => ({ text, confidence: 92, bbox: { x0: x, y0: at(row, x), x1: x + 10 * text.length, y1: at(row, x) + 20 } }))
    const people = [['123456', 'Anna', 'Muster', '14.03.2004'], ['234567', 'Bea', 'Beispiel', '02.05.2003'], ['345678', 'Cleo', 'Exempel', '01.06.2001'], ['456789', 'Dora', 'Probst', '09.09.1999'], ['567890', 'Ella', 'Platz', '10.10.1998']]
    const cells = (i) => [[people[i][0], 100], [people[i][1], 200], [people[i][2], 400], ['F', 610], [people[i][3], 660], ['RLL', 820], ['X', 900]]
    const lines = [listHead, ...[0, 1, 2].map((i) => ({ words: words(i, cells(i)) }))]
    lines.push({ words: words(3, cells(3).slice(0, 3)) })
    lines.push({ words: [...words(4, cells(4).slice(0, 2)), ...words(3, cells(3).slice(3))] })
    lines.push({ words: words(4, cells(4).slice(2)) })
    const r = rosterFromOcr(page(...lines))
    expect(players(r)).toEqual(people.map(([l, f, n]) => `${l} ${f} ${n}`))
    expect(r.players.every((p) => p.dob)).toBe(true)
  })
})

describe('the handwriting read again (ocr.js) and what it gives', () => {
  it('marksOfHand: a number, C or K the captain, L / L1 / L2 a libero (not a number)', () => {
    expect(marksOfHand('3K')).toMatchObject({ number: 3, captain: true, libero: false })
    expect(marksOfHand('7 L1')).toMatchObject({ number: 7, libero: true })
    expect(marksOfHand('L2')).toMatchObject({ number: null, libero: true })
    expect(marksOfHand('99 L2')).toMatchObject({ number: 99, libero: true })
    expect(marksOfHand('1 2')).toMatchObject({ number: null, unsure: true })
    expect(marksOfHand('333')).toMatchObject({ number: null, unsure: true })
  })

  it('withHandReadings: its number wins, a ring is the captain, two numbers are unsure, nothing above HANDWRITTEN_MAX', () => {
    const p = { number: 2, isCaptain: false, isLibero: false, confidence: { licence: 0.9 } }
    const a = withHandReadings(p, [{ text: '27', conf: 0.95 }])
    expect(a).toMatchObject({ number: 27, isCaptain: false })
    expect(a.confidence.number).toBeLessThanOrEqual(HANDWRITTEN_MAX)
    const b = withHandReadings(p, [{ text: '', conf: 0.5, ringed: true }, { text: '5', conf: 0.9 }])
    expect(b).toMatchObject({ number: 5, isCaptain: true })
    expect(b.confidence.isCaptain).toBeLessThanOrEqual(HANDWRITTEN_MAX)
    const c = withHandReadings(p, [{ text: '14', conf: 0.9 }, { text: '41', conf: 0.9 }])
    expect(c.number).toBe(14)
    expect(c.confidence.number).toBeLessThanOrEqual(0.4)
    expect(withHandReadings(p, [])).toBe(p)
  })
})

describe('cleanWord: what real photos misread', () => {
  it('a date with a dash, a date with a digit run into it, an SV number with a full stop', () => {
    expect(cleanWord('14.03-2004')).toBe('14.03.2004')
    expect(cleanWord('1281120058')).toBe('28.11.2005')
    expect(cleanWord('345671.')).toBe('345671')
  })
})

// (owner, 2026-11-27: "did not read the coach correctly") made-up officials, as read
describe('rosterFromOcr: the officials above the table, in every list language', () => {
  const words = (y, text) => line(y, text.split(' ').map((t, i, all) => [t, 100 + all.slice(0, i).join(' ').length * 10 + 10 * i]))
  const table = (y, header) => [line(y, header.map((h, i) => [h, 100 + 120 * i])), line(y + 40, [['123456', 100], ['Anna', 220], ['Muster', 340], ['F', 460], ['14.03.2004', 580]])]
  const de = ['SV-Nr.', 'Vorname', 'Nachname', 'M/F', 'Geburtsdatum', 'LAS']
  const pick = (r) => ['coach', 'ac1', 'ac2'].map((k) => (r[k] ? `${k}:${r[k].licence}|${r[k].firstName}|${r[k].lastName}` : `${k}:-`))

  it('German list: Coach and two assistants in English, "2. Assistant Coach: -" is none', () => {
    const r = rosterFromOcr(page(
      words(20, 'Coach: #310001 | Petra Exempel (1980)'),
      words(50, '1. Assistant Coach: #20002 | Hans Beispiel (1975)'),
      words(80, '2. Assistant Coach: -'),
      ...table(120, de)))
    expect(pick(r)).toEqual(['coach:310001|Petra|Exempel', 'ac1:20002|Hans|Beispiel', 'ac2:-'])
  })

  it('French and Italian roles ("1er coach assistant", "Allenatore", "2. Assistente allenatore")', () => {
    const fr = rosterFromOcr(page(
      words(20, 'Coach: #310003 | Léa Exemple (1990)'),
      words(50, '1er coach assistant: #310004 | Jean Modèle (1985)'),
      ...table(120, ['N° SV', 'Prénom', 'Nom', 'M/F', 'Date de naissance', 'LFP'])))
    expect(pick(fr)).toEqual(['coach:310003|Léa|Exemple', 'ac1:310004|Jean|Modèle', 'ac2:-'])
    const it = rosterFromOcr(page(
      words(20, 'Allenatore: #310005 | Marco Esempio (1982)'),
      words(80, '2. Assistente allenatore: #310006 | Giulia Prova (1999)'),
      ...table(120, ['N. SV', 'Nome', 'Cognome', 'M/F', 'Data di nascita', 'LFP'])))
    expect(pick(it)).toEqual(['coach:310005|Marco|Esempio', 'ac1:-', 'ac2:310006|Giulia|Prova'])
  })

  it('as a photo reads it: the colon, the "#", the "|" or the year lost, the role\'s first letter gone', () => {
    const r = rosterFromOcr(page(
      words(20, 'coach #310007 I Petra Exempel 1980)'),
      words(50, '1. Assistant Coach: H20008 | Hans Beispiel'),
      ...table(120, de)))
    expect(pick(r)).toEqual(['coach:310007|Petra|Exempel', 'ac1:20008|Hans|Beispiel', 'ac2:-'])
    const lost = rosterFromOcr(page(words(20, 'oach: #310009 | Lea Muster (1998)'), ...table(120, de)))
    expect(pick(lost)[0]).toBe('coach:310009|Lea|Muster')
  })

  it('a role word blurred past reading ("SOAEN" for "Coach:"): the line\'s shape keeps the official, in the first free slot, its names to check', () => {
    const r = rosterFromOcr(page(
      words(20, 'SOAEN #310012 | Petra Exempel (1980)'),
      words(50, '1. Assistant Coach: #310013 | Hans Beispiel (1975)'),
      ...table(120, de)))
    expect(pick(r)).toEqual(['coach:310012|Petra|Exempel', 'ac1:310013|Hans|Beispiel', 'ac2:-'])
    expect(r.coach.confidence.firstName).toBeLessThan(0.8)
    expect(r.coach.confidence.lastName).toBeLessThan(0.8)
    expect(r.ac1.confidence.firstName).toBeGreaterThanOrEqual(0.8)
    // without that shape (no year, a short number, words before the "#") it is no official
    for (const text of ['SOAEN #310014 | Petra Exempel', 'SOAEN #3100 | Petra Exempel (1980)', 'Halle Seewiese Nord #310015 | Petra Exempel (1980)']) {
      expect(pick(rosterFromOcr(page(words(20, text), ...table(120, de))))[0]).toBe('coach:-')
    }
  })

  it('first name first, the year is no name; a particle starts the last name; a guessed split is to check', () => {
    const r = rosterFromOcr(page(
      words(20, 'Coach: #310010 | Ruedi von Beispiel (1988)'),
      words(50, '1. Assistant Coach: #310011 | Anna Maria Muster (1997)'),
      ...table(120, de)))
    expect(pick(r)).toEqual(['coach:310010|Ruedi|von Beispiel', 'ac1:310011|Anna Maria|Muster', 'ac2:-'])
    expect(r.ac1.confidence.firstName).toBeLessThan(0.8)
    expect(r.ac1.confidence.lastName).toBeLessThan(0.8)
    expect(r.coach.confidence.firstName).toBeLessThan(0.8)
  })

  it('a coach who is also on the list: the names as the player row has them', () => {
    const r = rosterFromOcr(page(
      words(20, 'Coach: #123456 | Anna Muster (2004)'),
      ...table(120, de)))
    expect(r.coach).toMatchObject({ licence: '123456', firstName: 'Anna', lastName: 'Muster' })
    expect(r.coach.confidence.firstName).toBeGreaterThanOrEqual(0.8)
  })
})
