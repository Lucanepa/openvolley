/**
 * A roster from the words the text recognition read in a photo of a list
 * (Tesseract's lines and words with their boxes; utils/rosterPhoto/ocr.js),
 * by the PDF importer's own reader: the words become the positioned items
 * pdf.js gives (parseRosterContent's `items`: str, x, y, width, page), so the
 * same columns, rows, SV numbers, LFP marks and officials are found.
 *
 * What a photo has and a PDF has not:
 *   - reading slips: an O for a 0 in an SV number, a table rule read as "|";
 *   - what the team wrote in (owner 2026-11-23): a shirt number before the
 *     SV number or after the date, a C (or K, Kapitän) for the captain and an
 *     L for a libero; taken out of the row before the reader sees it, and
 *     given back to the player with that SV number;
 *   - a confidence per word (0..100): each field gets the lowest of its words
 *     (0..1). Handwritten marks never count as sure (HANDWRITTEN_MAX).
 *
 * Plain functions, no Tesseract: tests run on recorded word lists. Whether
 * a number is circled is asked of the page's pixels (opts.circled).
 */

import { parseRosterContent, officialRoleOf } from '../parseRosterPdf'

// the reader's items are PDF units: a line of text is about 10 high there
// (Y_TOLERANCE 3, LFP_TOLERANCE 15 in parseRosterPdf.js)
const LINE_HEIGHT = 10
// words whose left edges are this close (in those units) start one column
const COLUMN_SNAP = 4
// a mark the team wrote by hand is never sure: the scorer checks it
export const HANDWRITTEN_MAX = 0.7

const LICENCE = /^\d{5,6}$/
// an SV number with a digit lost or added in the reading
const LOOSE_LICENCE = /^\d{4,7}$/
const STAND_IN_DATE = '01.01.2000'
// a date the reader takes as a date of birth (parseRosterPdf birthDate: born 1900 up to 4 years ago)
const birthDateLike = (t) => {
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(t)
  return !!m && +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1900 && +m[3] <= new Date().getFullYear() - 4
}
const GENDER_WORD = /^[MFH]$/
// the LFP column's header (parseRosterPdf LFP_HEADER_RE) and its mark
const LFP_HEADER = /^(GFL|LAS|JFL|LFP)$/i
const LFP_MARK = /^[Xx×]$/
// the name columns' headers (parseRosterPdf FIRST_NAME_HEADER, LAST_NAME_HEADER)
const NAME_HEADER = /^(vorname|nachname|prénom|prenom|nome|cognome)$/i
const FIRST_NAME_COL = /^(vorname|prénom|prenom|nome|first)$/i
const LAST_NAME_COL = /^(nachname|name|nom|cognome|last)$/i
// a name the photo lost (a circle drawn over it): a stand-in word the reader
// takes, emptied again after (the confirm screen shows the gap)
const NO_NAME = 'Xqzname'
const SHIRT = /^\d{1,2}$/
// a circled number as the recognition may write it: "(7)", "(7", "7)", "©7", "@7"
const CIRCLED_TEXT = /^(?:[(©®@](\d{1,2})\)?|(\d{1,2})\))$/
// a handwritten digit read as a letter ("IJ" for an italic 11), trusted only
// before the SV number, where nothing but a number or a mark stands
const HAND_DIGIT = { I: '1', l: '1', i: '1', J: '1', j: '1', '|': '1', '/': '1', O: '0', o: '0', D: '0', S: '5', s: '5', Z: '2', z: '2', B: '8', G: '6', b: '6', g: '9', q: '9', T: '7', A: '4' }
const handNumber = (text) => (text.length <= 2 && [...text].every((c) => /\d/.test(c) || c in HAND_DIGIT)
  ? [...text].map((c) => HAND_DIGIT[c] ?? c).join('')
  : null)
const DATE = /^\d{1,2}[./]\d{1,2}[./]\d{4}$/
// a printed name's word: a capital, then letters with at least one small one
// ("Müller", "McLean", "D'Angelo", "Garcia-Lopez"), or a particle
const NAME_WORD = /^\p{Lu}[\p{L}\p{M}'’.-]*\p{Ll}[\p{L}\p{M}'’.-]*$/u
const PARTICLE = /^(von|vom|van|zu|zur|de|del|della|dello|dei|degli|di|da|dal|dos|das|do|du|des|der|den|la|le|lo|ten|ter|al|el|bin|ibn|st)$/
const nameLike = (w) => PARTICLE.test(w.text) || (NAME_WORD.test(w.text) && !(w.text.length <= 2 && w.conf < 70)) ||
  // a name read with a small first letter ("anna"): letters only, long enough to be no mark
  /^\p{Ll}\p{L}{3,}$/u.test(w.text)
// a name and a handwritten mark read as one word ("Anna(1)", "Anna©")
const GLUED = /^(\p{L}[\p{L}'’-]{2,})([([©®@].*)$/u
function unglue (w) {
  const m = GLUED.exec(String(w.text || '').trim())
  if (!m) return [w]
  const cut = w.x0 + ((w.x1 - w.x0) * m[1].length) / m[0].length
  return [{ ...w, text: m[1], x1: cut }, { ...w, text: m[2], x0: cut }]
}
/**
 * Whether a word between the SV number and the date is print (a name, the
 * gender) and not handwriting the recognition made letters of ("AT", "(x",
 * "2g", "\\X", a short "Ss" it was unsure of: real photos, 2026-11-26), which
 * would end up in a name.
 */
export const printedWord = (w) => GENDER_WORD.test(w.text) || nameLike(w)
// how far left of the SV number a team writes the shirt number, in lines
const LEAD_REACH = 7
// before the SV number or after the date a mark may be read small or twice
// ("c", "Cc" for one handwritten C)
const MARK = /^[([]?([CKL])\1?[)\].]?$/i
const BARE_MARK = /^[CKL]$/
// a date with a dot lost ("11.122000", "14032004")
const LOOSE_DATE = /^(\d{2})[./-]?(\d{2})[./-]?(\d{4})$/
// a table rule or a speck read as a character of its own
const RULE = /^[|¦!I[\]{}_~•·,;'"`‘’“”„✓✔√/\\]+$/
// characters read for digits, in a word that is mostly digits
const DIGIT_LOOKALIKE = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6' }

/**
 * The lines of Tesseract's answer ({ blocks } or { lines }), top to bottom,
 * each { words, top, bottom }. Lines that lie mostly beside each other (one
 * table row Tesseract read as two: a number written a little higher, a wide
 * gap between the columns) are one.
 */
export function ocrLines (data) {
  const found = []
  // a line's middle and the height of its letters: the median of its words
  // that are text (a page edge read as a tall "|", a big handwritten number
  // reaching into the next row: real photos, 2026-11-26), not their extremes
  const middleOf = (words) => {
    const text = words.filter((w) => !RULE.test(w.text.trim()))
    const use = text.length ? text : words
    return { mid: median(use.map((w) => (w.y0 + w.y1) / 2)), h: Math.max(1, median(use.map((w) => w.y1 - w.y0))) }
  }
  const take = (line) => {
    const words = (line?.words || [])
      .filter((w) => w && typeof w.text === 'string' && w.bbox)
      .map((w) => ({ text: w.text, conf: Number.isFinite(w.confidence) ? w.confidence : 0, ...w.bbox }))
    if (!words.length) return
    found.push({ words, top: Math.min(...words.map((w) => w.y0)), bottom: Math.max(...words.map((w) => w.y1)), ...middleOf(words) })
  }
  if (Array.isArray(data?.blocks) && data.blocks.length) {
    for (const b of data.blocks) for (const p of b?.paragraphs || []) for (const l of p?.lines || []) take(l)
  } else if (Array.isArray(data?.lines)) {
    for (const l of data.lines) take(l)
  }
  // A page a little askew (a photo's corners not quite right, the page
  // bent) slopes its rows, the lower ones often more: across a wide table
  // the end of one row lies as low as the start of the next, and Tesseract
  // puts words of two rows in one line (real photos, 2026-11-26). The slope
  // of the lines it read well (four words or more, wide), as it changes
  // down the page; when it tilts a row by a third of a line or more across
  // the page, the words are regrouped by their height along it.
  const slopes = [] // { y, slope }
  for (const l of found) {
    // (print only: a handwritten number sits higher or lower than its row)
    const ws = l.words.filter((w) => w.text.trim().length >= 3 && w.conf >= 60 && !RULE.test(w.text.trim()))
    if (ws.length < 4) continue
    const xs = ws.map((w) => (w.x0 + w.x1) / 2)
    const ys = ws.map((w) => (w.y0 + w.y1) / 2)
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length
    const my = ys.reduce((a, b) => a + b, 0) / ys.length
    let sxx = 0
    let sxy = 0
    xs.forEach((x, i) => { sxx += (x - mx) ** 2; sxy += (x - mx) * (ys[i] - my) })
    if (Math.max(...xs) - Math.min(...xs) > 10 * l.h && sxx > 0) slopes.push({ y: l.mid, slope: sxy / sxx })
  }
  const skew = slopes.length >= 3 ? median(slopes.map((v) => v.slope)) : 0
  // the slope down the page: a straight line through the lines' slopes, the
  // odd ones (a line of two rows) left out
  const spread = median(slopes.map((v) => Math.abs(v.slope - skew)))
  const fit = slopes.filter((v) => Math.abs(v.slope - skew) <= 3 * spread + 1e-4)
  let slopeAt = () => skew
  if (fit.length >= 4) {
    const my = fit.reduce((a, v) => a + v.y, 0) / fit.length
    const ms = fit.reduce((a, v) => a + v.slope, 0) / fit.length
    let syy = 0
    let sys = 0
    for (const v of fit) { syy += (v.y - my) ** 2; sys += (v.y - my) * (v.slope - ms) }
    const b = syy > 0 ? sys / syy : 0
    slopeAt = (y) => ms + b * (y - my)
  }
  const allWords = found.flatMap((l) => l.words)
  const left = allWords.length ? Math.min(...allWords.map((w) => w.x0)) : 0
  const across = allWords.length ? Math.max(...allWords.map((w) => w.x1)) - left : 0
  const textHeight = median(found.map((l) => l.h)) || 1
  const ys = found.map((l) => l.mid)
  if (Math.max(Math.abs(skew), Math.abs(slopeAt(Math.min(...ys))), Math.abs(slopeAt(Math.max(...ys)))) * across > textHeight / 3) {
    const level = (w) => {
      const y = (w.y0 + w.y1) / 2
      return y - slopeAt(y) * ((w.x0 + w.x1) / 2 - left)
    }
    const sorted = [...allWords].sort((a, b) => level(a) - level(b))
    found.length = 0
    let group = []
    for (const w of sorted) {
      if (group.length && level(w) - median(group.map(level)) > 0.5 * textHeight) {
        found.push(group)
        group = []
      }
      group.push(w)
    }
    if (group.length) found.push(group)
    // a short word alone (a handwritten number, a mark: it sits off its
    // row's middle) goes to the row nearest it
    const middle = (ws) => median(ws.map(level))
    for (let i = found.length - 1; i >= 0; i--) {
      const ws = found[i]
      if (ws.length > 2 || !ws.every((w) => w.text.trim().length <= 3) || found.length < 2) continue
      const m = middle(ws)
      const near = [i - 1, i + 1].filter((k) => k >= 0 && k < found.length).sort((a, b) => Math.abs(middle(found[a]) - m) - Math.abs(middle(found[b]) - m))[0]
      if (near !== undefined && Math.abs(middle(found[near]) - m) < 1.1 * textHeight) {
        found[near].push(...ws)
        found.splice(i, 1)
      }
    }
    found.forEach((ws, i) => {
      ws.sort((a, b) => a.x0 - b.x0)
      found[i] = { words: ws, top: Math.min(...ws.map((w) => w.y0)), bottom: Math.max(...ws.map((w) => w.y1)), ...middleOf(ws) }
    })
  }
  found.sort((a, b) => a.mid - b.mid)
  const span = (l) => [Math.min(...l.words.map((w) => w.x0)), Math.max(...l.words.map((w) => w.x1))]
  const hasLicence = (l) => l.words.some((w) => LICENCE.test(cleanWord(w.text)))
  const lines = []
  for (const l of found) {
    const prev = lines[lines.length - 1]
    let one = false
    if (prev && Math.abs(prev.mid - l.mid) < 0.6 * Math.min(prev.h, l.h) && !(hasLicence(prev) && hasLicence(l))) {
      // beside each other, not one over the other (two rows read close together)
      const [a0, a1] = span(prev)
      const [b0, b1] = span(l)
      one = Math.min(a1, b1) - Math.max(a0, b0) < 0.2 * Math.min(a1 - a0, b1 - b0)
    }
    if (one) {
      prev.words.push(...l.words)
      prev.top = Math.min(prev.top, l.top)
      prev.bottom = Math.max(prev.bottom, l.bottom)
      Object.assign(prev, middleOf(prev.words))
    } else lines.push({ ...l, words: [...l.words] })
  }
  return lines
}

/** A word as the list meant it: specks and rules gone, digits read for look-alikes in a number. */
export function cleanWord (text) {
  // (a tick column's ✓ is read as a quote and glued to the next mark: "“L")
  let s = String(text ?? '').trim().replace(/^[|¦[\]{},;:"'`‘’“”„✓✔√]+|[|¦[\]{},;"'`‘’“”„✓✔√]+$/g, '')
  if (!s || RULE.test(s)) return ''
  // a bracket left of a rule ("(LFP"); kept round a number, where it may be a circle ("(7")
  if (!/^\(?\d{1,2}\)?$/.test(s)) {
    if (s.startsWith('(') && !s.includes(')')) s = s.slice(1)
    if (s.endsWith(')') && !s.includes('(')) s = s.slice(0, -1)
    if (!s) return ''
  }
  // a date or a number with a letter read for a digit ("1O.03.2OO4", "12B45")
  const bare = s.replace(/[./]/g, '')
  const realDigits = (bare.match(/\d/g) || []).length
  if (bare.length >= 4 && realDigits >= bare.length / 2 && [...bare].every((c) => /\d/.test(c) || c in DIGIT_LOOKALIKE)) {
    s = [...s].map((c) => (c in DIGIT_LOOKALIKE ? DIGIT_LOOKALIKE[c] : c)).join('')
  }
  // the gender column's letter read twice ("FF")
  s = s.replace(/^([MFH])\1+$/, '$1')
  s = s.replace(/[.,]$/, (m) => (DATE.test(s.slice(0, -1)) || /^\d{5,6}$/.test(s.slice(0, -1)) ? '' : m))
  const loose = !DATE.test(s) && LOOSE_DATE.exec(s)
  if (loose) return `${loose[1]}.${loose[2]}.${loose[3]}`
  // a date with a handwritten digit run into it ("1171220078"): the one
  // date of birth inside, if exactly one is
  if (/^\d{9,10}$/.test(s)) {
    const found = []
    for (let i = 0; i + 8 <= s.length; i++) {
      const d = `${s.slice(i, i + 2)}.${s.slice(i + 2, i + 4)}.${s.slice(i + 4, i + 8)}`
      if (birthDateLike(d)) found.push(d)
    }
    if (found.length === 1) return found[0]
  }
  return s
}

/**
 * The marks a team wrote in a player row, taken out of it (owner
 * 2026-11-23: "coaches can write next (left) or between name and licence,
 * kinda everywhere"):
 *   - a shirt number: before the SV number (the nearest one), else anywhere
 *     between the SV number and the date (a number there would break the
 *     name), else after the date but right of the printed table; circled =
 *     the captain;
 *   - C or K the captain, L a libero: before the SV number, right after it,
 *     after the date, or as a bare capital anywhere between (an "L." there
 *     is a middle name's initial).
 * circled(word): whether a ring of ink lies around the word (scan.js ringScore).
 * @returns {{ words, number, numberConf, numberWord, captain, libero, markConf }}
 */
function takeMarks (words, circled = () => false, tableRight = Infinity) {
  const at = words.findIndex((w) => LICENCE.test(w.text))
  if (at < 0) return { words, number: null, numberConf: 1, numberWord: null, captain: false, libero: false, markConf: 1, hand: [] }
  const dateAt = words.findIndex((w, i) => i > at && DATE.test(w.text))
  const end = dateAt >= 0 ? dateAt : words.length
  // (a word far left of the SV number is the page's edge or the table under it)
  const reach = words[at].x0 - LEAD_REACH * (words[at].y1 - words[at].y0)
  // where a number stood: before the SV number wins, then between, then after the date
  const RANK = { leading: 3, inside: 2, trailing: 1 }
  const out = []
  const hand = [] // words of handwriting the recognition misread (read again: ocr.js)
  let found = null // { number, conf, word, where, ringed }
  let captain = false
  let libero = false
  let markConf = 1
  words.forEach((w, i) => {
    if (i < at && w.x1 < reach) return
    const leading = i < at
    const inside = i > at && i < end
    const trailing = dateAt >= 0 && i > dateAt
    const mark = MARK.exec(w.text)
    const markHere = leading || trailing || (inside && (i === at + 1 || BARE_MARK.test(w.text) || /^[([].+[)\]]$/.test(w.text)))
    if (mark && markHere) {
      if (mark[1].toUpperCase() === 'L') libero = true
      else captain = true
      markConf = Math.min(markConf, w.conf / 100)
      return
    }
    const ringed = CIRCLED_TEXT.exec(w.text)
    const shirt = ringed ? ringed[1] || ringed[2] : (SHIRT.test(w.text) ? w.text : (leading ? handNumber(w.text) : null))
    // (between the SV number and the date: not a piece of a split date, "14" "03.2004")
    const brokenDate = inside && /^(\d{1,2}[./]|\d{4}$)/.test(words[i + 1]?.text || '')
    // after the date only right of the printed table (its tick and mark
    // columns read as digits: a ✓ comes out as "4")
    const where = leading ? 'leading' : inside && !brokenDate ? 'inside' : trailing && w.x0 > tableRight ? 'trailing' : null
    if (shirt && Number(shirt) >= 1 && where) {
      const prev = found
      // "1" "1" side by side before the SV number is one 11 (the recognition split it)
      const joined = where === 'leading' && prev?.where === 'leading' && w.x0 - prev.word.x1 < 0.5 * (w.y1 - w.y0) && String(prev.number).length === 1 && shirt.length === 1
      if (joined) found = { ...prev, number: Number(`${prev.number}${shirt}`), conf: Math.min(prev.conf, w.conf / 100), word: { ...w, x0: prev.word.x0 }, ringed: prev.ringed || !!ringed }
      else if (!prev || RANK[where] > RANK[prev.where] || (where === 'leading' && prev.where === 'leading')) {
        found = { number: Number(shirt), conf: w.conf / 100, word: w, where, ringed: !!ringed }
      }
      // taken out of the row in any case: a number between the names would break them
      return
    }
    // whatever else stands before the SV number is no part of the row
    if (leading) { hand.push(w); return }
    // between the SV number and the date only print stays (the names)
    // (a date's pieces stay: "14" "03.2004")
    if (inside && !printedWord(w) && !/^[\d./,]+$/.test(w.text)) { hand.push(w); return }
    out.push(w)
  })
  // no printed name at all: a row written in by hand under the table (its
  // words are the names, read as well as they could be; the row is shown,
  // every field to check, never dropped: owner, 2026-11-26)
  const named = out.some((w) => w.x0 > words[at].x1 && /\p{L}{2,}/u.test(w.text) && !GENDER_WORD.test(w.text))
  if (!named) {
    const back = hand.filter((w) => w.x0 > words[at].x1 && /\p{L}{2,}/u.test(w.text))
    for (const w of back) { out.push(w); hand.splice(hand.indexOf(w), 1) }
    out.sort((a, b) => a.x0 - b.x0)
  }
  if (found && (found.ringed || circled(found.word))) {
    captain = true
    markConf = Math.min(markConf, found.conf)
  }
  return { words: out, number: found?.number ?? null, numberConf: found?.conf ?? 1, numberWord: found?.word ?? null, captain, libero, markConf, hand }
}

// "Trainer: #12345 | Anna Muster (1980)" as read: the "#" or the "|" lost or
// read as something else, the colon lost ("coach #12345"), the year in
// brackets cut or garbled (a birth year, never part of the name)
const OFFICIAL_LINE = /^(.{1,80}?)\s*[:;]?\s*[#H*]\s*(\d{3,7})\s*[|Il1!/]?\s*([^\d()]+?)\s*(?:\(?\s*(\d{4})\s*\)?)?\s*$/u
const OFFICIAL_LINE_NO_HASH = /^(.{1,80}?)\s*[:;]\s*(\d{3,7})\s*[|Il1!/]\s*([^\d()]+?)\s*(?:\(?\s*(\d{4})\s*\)?)?\s*$/u
// a name's word that starts its last name: "Ruedi von Beispiel", "Marco De Esempio"
const LAST_NAME_START = /^(von|vom|van|de|del|della|dello|dei|degli|di|da|dal|dos|das|do|du|des|der|den|la|le|lo|ten|ter|zu|zur|mc|st)$/i

/**
 * The role of an official's label as read: parseRosterPdf officialRoleOf,
 * else by what is left of its words ("oach" for a Coach whose C the photo
 * lost, real photo 2026-11-27): 'coach', 'ac1', 'ac2', 'ac' or null.
 */
function roleOfLabel (label) {
  const role = officialRoleOf(label)
  if (role) return role
  if (!/oach|rainer|llenat|ntra[iî]n|ssist/i.test(label)) return null
  if (/ssist|djoint|iuto/i.test(label)) return /(^|\D)2(\D|$)/.test(label) ? 'ac2' : /(^|\D)1(\D|$)/.test(label) ? 'ac1' : 'ac'
  return 'coach'
}

/**
 * An official's line ("<role>: #<SV number> | <first> <last> (<year>)",
 * VolleyManager's, the role in English or the list's language) as read:
 * { label, slot, licence, names } or null. "1." / "2." in front is that
 * assistant, whatever became of the role's words ("2. Allenatore
 * ===}+<nte"): VolleyManager numbers only the assistants.
 */
function officialOf (text) {
  const m = OFFICIAL_LINE.exec(text) || OFFICIAL_LINE_NO_HASH.exec(text)
  if (!m) return null
  const label = m[1].trim().split(/\s+/).slice(-4).join(' ')
  const nth = /^\s*([12])\s*[.)]/.exec(m[1])
  const slot = nth ? `ac${nth[1]}` : roleOfLabel(label)
  if (!slot) return null
  // a name misread with signs in it ("E==mp=!") keeps its letters, so the
  // official is not lost: the confirm screen shows it to check
  const names = m[3].split(/\s+/)
    .map((w) => w.replace(/[^\p{L}'’-]/gu, ''))
    .filter((w) => /\p{L}{2,}/u.test(w))
  if (names.length < 2) return null
  return { label: nth ? `${nth[1]}. Assistant Coach` : m[1].trim(), slot, licence: m[2], names, year: m[4] || '' }
}

/** The line written back the way parseLabelledOfficials reads it (each name word capitalised). */
function officialLine (text) {
  const o = officialOf(text)
  if (!o) return null
  const names = o.names.map((w) => w.charAt(0).toLocaleUpperCase() + w.slice(1))
  return `${o.label}: #${o.licence} | ${names.join(' ')} (${o.year || '1900'})`
}

/**
 * First and last name of an official as VolleyManager writes them ("<first>
 * <last>"): the player row with the same SV number knows them (its names
 * are in columns of their own), else the last name starts at a particle
 * ("von", "De") or is the last word. sure: false when the split is a guess
 * (three words or more, no player to tell): both names to check.
 */
function officialNames (names, player) {
  const joined = names.join(' ')
  if (player && `${player.firstName} ${player.lastName}`.replace(/\s+/g, ' ').trim().toLowerCase() === joined.toLowerCase()) {
    return { firstName: player.firstName, lastName: player.lastName, sure: true }
  }
  // (two words: one each; more: a particle starts the last name, else the last word is it)
  const at = names.findIndex((w, i) => i > 0 && i < names.length - 1 && LAST_NAME_START.test(w))
  const cut = at > 0 ? at : names.length - 1
  return { firstName: names.slice(0, cut).join(' '), lastName: names.slice(cut).join(' '), sure: names.length === 2 }
}

const median = (values) => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

/** Each left edge moved to the first of its column (edges COLUMN_SNAP apart or closer are one). */
function snapColumns (items) {
  const xs = [...new Set(items.map((it) => it.x))].sort((a, b) => a - b)
  const start = new Map()
  let first = null
  let prev = null
  for (const x of xs) {
    if (prev === null || x - prev > COLUMN_SNAP) first = x
    start.set(x, first)
    prev = x
  }
  for (const it of items) it.x = start.get(it.x)
}

/**
 * The roster in Tesseract's answer: parseRosterContent's result
 * ({ players, coach, ac1, ac2 }) with, per player, the number, captain and
 * libero the team wrote in and a confidence per field; null fields where the
 * photo had nothing.
 */
export function rosterFromOcr (data, { circled, ringAt, struck } = {}) {
  const lines = ocrLines(data)
  const height = median(lines.flatMap((l) => l.words.map((w) => w.y1 - w.y0))) || 1
  const scale = LINE_HEIGHT / height
  const items = []
  const textLines = []
  const rows = new Map() // licence -> what the row had beside the reader's fields
  // The table's header (the line with the LFP column): an X belongs to the
  // column whose header starts nearest left of it (a PDF's tolerance is for
  // a narrow column; in a photo the X sits in the middle of a wide one)
  let headers = null
  let tableRight = Infinity // the right end of the table's header row
  let nameCols = null // where the first and last name columns start (their headers)
  // stand-in SV numbers for misread ones: six digits no row of the page has
  const read = new Set(lines.flatMap((l) => l.words.map((w) => cleanWord(w.text))).filter((t) => LICENCE.test(t)))
  let standIns = 0
  const standIn = () => {
    let n
    do n = String(990000 + (++standIns)); while (read.has(n))
    return n
  }
  let lastRow = null // the player row just above: { licence, words, bottom }
  let headerBottom = Infinity // where the table's header row ends
  const lostStruck = [] // struck rows no player came of: { top, bottom, names, licence }
  const officialsRead = [] // officials' lines above the table (officialOf)
  const printedBoxes = [] // every word of print on the page (not the handwriting)
  lines.forEach((line, index) => {
    const words = line.words
      .flatMap(unglue)
      .map((w) => ({ ...w, text: cleanWord(w.text) }))
      .filter((w) => w.text)
      .sort((a, b) => a.x0 - b.x0)
    // a name that went on in the line below its row ("Sánchez-Robles" /
    // "Herrero"): a short line of letters only, right under a player row
    // (a number or a mark written beside it counts for that row)
    // (print only: handwriting under the last row is no name's end)
    const nameBit = (w) => nameLike(w) && !BARE_MARK.test(w.text)
    const markBit = (w) => SHIRT.test(w.text) || BARE_MARK.test(w.text)
    if (lastRow && words.length && words.length <= 4 && words.some(nameBit) && words.every((w) => nameBit(w) || markBit(w)) &&
        // (in the name columns, read with some certainty: not a scrap at the page's edge)
        words.filter(nameBit).every((w) => w.conf >= 40 && w.x0 > lastRow.words[0].x1) &&
        line.top - lastRow.bottom < 0.8 * height) {
      const names = words.filter(nameBit)
      const under = lastRow.words.reduce((best, w) => (Math.abs(w.x0 - names[0].x0) < Math.abs(best.x0 - names[0].x0) ? w : best))
      const row = rows.get(lastRow.licence)
      row.more.push({ under: under.text, text: names.map((w) => w.text).join(' ') })
      for (const w of words.filter(markBit)) {
        if (BARE_MARK.test(w.text)) {
          if (w.text === 'L') row.libero = true
          else row.captain = true
          row.markConf = Math.min(row.markConf, w.conf / 100, HANDWRITTEN_MAX)
        } else if (row.number === null && Number(w.text) >= 1) {
          row.number = Number(w.text)
          row.numberConf = Math.min(w.conf / 100, HANDWRITTEN_MAX)
        }
      }
      lastRow = { ...lastRow, bottom: line.bottom }
      return
    }
    lastRow = null
    // the table's header row: its columns (LFP among them) and where it ends
    if (words.some((w) => LFP_HEADER.test(w.text) || NAME_HEADER.test(w.text))) {
      headerBottom = line.bottom
      headers = words.map((w) => ({ x: w.x0, lfp: LFP_HEADER.test(w.text) }))
      tableRight = Math.max(...words.map((w) => w.x1))
      const first = words.find((w) => FIRST_NAME_COL.test(w.text))
      const last = words.find((w) => LAST_NAME_COL.test(w.text) && w !== first)
      nameCols = first && last ? { first: first.x0, last: last.x0 } : nameCols
    }
    // An SV number read with a digit too few or too many ("9122"): the row
    // is kept all the same, under a stand-in the reader accepts, and gets
    // the digits as read back (red on the confirm screen), never dropped
    let rawLicence = null
    if (!words.some((w) => LICENCE.test(w.text))) {
      const i = words.findIndex((w, k) => k <= 3 && LOOSE_LICENCE.test(w.text) && /^\p{L}{2,}/u.test(words[k + 1]?.text || ''))
      if (i >= 0) {
        rawLicence = words[i].text
        words[i] = { ...words[i], text: standIn() }
      } else if (headers) {
        // a row of the table whose SV number the photo lost (cut off at the
        // page's edge, a pen over it): names and a date of birth below the
        // table's header. Kept, its SV number empty or as read (real photos,
        // 2026-11-26: such rows were dropped without a word)
        const first = words.findIndex((w) => NAME_WORD.test(w.text))
        const dateAt = words.findIndex((w) => birthDateLike(w.text))
        if (first >= 0 && dateAt > first) {
          const before = words[first - 1]
          rawLicence = before && /^\d{1,7}$/.test(before.text) && words[first].x0 - before.x1 < 3 * height ? before.text : ''
          const x0 = Math.min(headers[0].x, words[first].x0 - 3 * height)
          words.splice(0, first, { ...words[first], text: standIn(), x0, x1: x0 + 2.5 * height, conf: 0 })
        }
      }
    }
    const marks = takeMarks(words, circled, tableRight)
    const kept = marks.words
    if (!kept.length) return
    const licenceWord = kept.find((w) => LICENCE.test(w.text))
    // a row of the table the recognition could not make a player of, a pen
    // line through it (the line garbles the reading): left out all the same,
    // and named on the confirm screen with what was read of it (real photos,
    // 2026-11-27); kept if it lies within the table (checked below)
    if (!licenceWord && headers && struck && line.top > headerBottom) {
      const named = kept.filter((w) => w.conf > 0 && nameLike(w) && w.text.length >= 3 && !NAME_HEADER.test(w.text))
      const dated = kept.some((w) => birthDateLike(w.text) || /\d{2}\D?\d{2}\D?\d{4}/.test(w.text))
      if ((named.length || dated) && struck(kept.filter((w) => w.conf >= 0))) {
        lostStruck.push({ top: line.top, bottom: line.bottom, names: named.map((w) => w.text), licence: (kept.map((w) => w.text.replace(/\D/g, '')).find((d) => LOOSE_LICENCE.test(d)) || '') })
      }
    }
    if (licenceWord) {
      const at0 = kept.indexOf(licenceWord)
      // signs that are no name and no number between the SV number and the
      // date (a circle read as "@)")
      for (let k = kept.length - 1; k > at0; k--) {
        if (!/[\p{L}\d]/u.test(kept[k].text) && !(DATE.test(kept[k].text))) kept.splice(k, 1)
      }
      // one name only (the other lost): a stand-in in the missing column
      let n = at0 + 1
      while (n < kept.length && /^\p{L}{2,}/u.test(kept[n].text) && !GENDER_WORD.test(kept[n].text)) n++
      if (n === at0 + 2) {
        const only = kept[at0 + 1]
        const inLast = nameCols ? Math.abs(only.x0 - nameCols.last) < Math.abs(only.x0 - nameCols.first) : true
        const x0 = inLast ? (nameCols ? nameCols.first : Math.max(licenceWord.x1 + 4, only.x0 - 4 * height)) : (nameCols ? nameCols.last : only.x1 + 4 * height)
        kept.splice(inLast ? at0 + 1 : at0 + 2, 0, { ...only, text: NO_NAME, x0, x1: x0 + 3 * height, conf: 0 })
      }
      // A date of birth misread ("16101083") or missing: the reader finds a
      // player row by its date, never keeps it (db/048). A stand-in date
      // keeps the row; the date is dropped again below.
      let dateGuessed = false
      const at = kept.indexOf(licenceWord)
      if (!kept.slice(at + 1).some((w) => birthDateLike(w.text))) {
        // the names: the words of letters right after the SV number, up to the gender or a number
        let lastName = at
        while (lastName + 1 < kept.length && /^\p{L}{2,}/u.test(kept[lastName + 1].text) && !GENDER_WORD.test(kept[lastName + 1].text)) lastName++
        if (lastName > at) {
          // (the misread date itself, all its pieces when the reading split it
          // ("14" "03.2004"), else a new word after the name and gender)
          const gender = GENDER_WORD.test(kept[lastName + 1]?.text || '') ? lastName + 1 : lastName
          let first = gender + 1
          let last = first
          while (last < kept.length && /^[\d./,]+$/.test(kept[last].text)) last++
          const pieces = kept.slice(first, last)
          if (pieces.length && (pieces.map((w) => w.text).join('').match(/\d/g) || []).length >= 4) {
            kept.splice(first, pieces.length, { ...pieces[0], text: STAND_IN_DATE, x1: pieces[pieces.length - 1].x1 })
          } else if ((first = kept.findIndex((w, k) => k > lastName && (w.text.match(/\d/g) || []).length >= 4)) >= 0) {
            kept[first] = { ...kept[first], text: STAND_IN_DATE }
          } else {
            const w = kept[gender]
            kept.splice(gender + 1, 0, { ...w, text: STAND_IN_DATE, x0: w.x1 + 6, x1: w.x1 + 60, conf: 0 })
          }
          dateGuessed = true
        }
      }
      lastRow = { licence: licenceWord.text, words: kept, bottom: line.bottom }
      // no number read in front of the SV number: a circle there (the
      // recognition skips many circled numbers) still makes the captain
      let ring = null
      if (marks.number === null && ringAt) {
        // anywhere a team writes (left of the SV number up to the date); a
        // circle is drawn bigger than the row: two lines above and below, its
        // middle on this row (not the neighbour's circle)
        const dateWord = kept.find((w) => DATE.test(w.text))
        const right = dateWord ? dateWord.x0 - 2 : Math.max(...kept.map((w) => w.x1))
        const found = ringAt({ x0: licenceWord.x0 - 7 * height, y0: line.top - 2 * height, x1: right, y1: line.bottom + 2 * height }, height)
        const middle = found ? (found.ring.y0 + found.ring.y1) / 2 : NaN
        ring = found && middle >= line.top - 0.5 * height && middle <= line.bottom + 0.5 * height ? found : null
        if (ring) {
          marks.captain = true
          marks.markConf = Math.min(marks.markConf, HANDWRITTEN_MAX)
          // the number inside the circle is read again (ocr.js), not one from after the date
          marks.number = null
        }
      }
      const nameWords = kept.filter((w) => /\p{L}{2,}/u.test(w.text))
      // what the photo shows of the row (no stand-in): the print, where the
      // team's handwriting is read again (ocr.js), and whether a pen struck it out
      const printed = kept.filter((w) => w.conf > 0 && w.text !== NO_NAME && w.text !== STAND_IN_DATE)
      const dateWord = kept.find((w) => DATE.test(w.text) && w.conf > 0)
      const hand = {
        left: licenceWord.x0,
        x0: licenceWord.x0 - LEAD_REACH * height,
        x1: dateWord ? dateWord.x0 - 0.2 * height : Math.max(...kept.map((w) => w.x1)) + 4 * height,
        // (the SV number's middle: always print, where the line's may lean on a big handwritten number)
        y: (licenceWord.y0 + licenceWord.y1) / 2,
        line: height,
        // every printed word near the row (filled in below: the rows above and under it too)
        skip: [],
        beyond: Number.isFinite(tableRight) ? tableRight + 0.5 * height : null
      }
      const struckOut = !!struck && struck(printed.filter((w) => !dateWord || w.x1 <= dateWord.x1))
      const lfpWord = headers && kept.find((w) => w.x0 > licenceWord.x1 && LFP_MARK.test(w.text))
      const column = lfpWord && headers.filter((h) => h.x <= (lfpWord.x0 + lfpWord.x1) / 2).pop()
      rows.set(licenceWord.text, {
        lfp: !!column?.lfp,
        licenceConf: licenceWord.conf / 100,
        licenceX: licenceWord.x0,
        licenceBox: { x0: licenceWord.x0, y0: licenceWord.y0, x1: licenceWord.x1, y1: licenceWord.y1 },
        nameConf: nameWords.length ? Math.min(...nameWords.map((w) => w.conf)) / 100 : 0,
        number: marks.number,
        numberConf: Math.min(marks.numberConf, HANDWRITTEN_MAX),
        captain: marks.captain,
        libero: marks.libero,
        markConf: Math.min(marks.markConf, HANDWRITTEN_MAX),
        ring: ring?.inner || null,
        rawLicence,
        dateGuessed,
        hand,
        struck: struckOut,
        more: []
      })
    }
    for (const w of kept) if (w.conf > 0 && w.text !== NO_NAME && w.text !== STAND_IN_DATE) printedBoxes.push({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })
    const joined = kept.map((w) => w.text).join(' ')
    // (an official's line above the table: the coach and the assistants)
    const official = headers ? null : officialOf(joined)
    if (official) officialsRead.push({ ...official, words: kept })
    textLines.push({ text: officialLine(joined) || joined, words: kept })
    // one y per line (its order): the reader's rows are Tesseract's lines,
    // however a photo's rows slope
    const y = -index * LINE_HEIGHT * 2
    for (const w of kept) items.push({ str: w.text, x: Math.round(w.x0 * scale), y, width: (w.x1 - w.x0) * scale, page: 1 })
  })
  snapColumns(items)
  // SV numbers start where the column does: one starting a digit further
  // right lost its first digit at the page's edge or under a pen ("23456"
  // for 123456: real photos, 2026-11-26), and still looks like one
  const column = median([...rows.values()].map((r) => r.licenceX))
  for (const row of rows.values()) {
    const { y, line } = row.hand
    row.hand.skip = printedBoxes.filter((b) => b.y1 > y - 2.5 * line && b.y0 < y + 2.5 * line)
    if (rows.size >= 3 && row.licenceX - column > 0.4 * height) {
      row.licenceConf = Math.min(row.licenceConf, 0.4)
      // read again from where the column starts (ocr.js): the lost digit may be there
      row.licenceAt = { ...row.licenceBox, x0: column - 0.2 * height, lost: true }
    }
  }

  const result = parseRosterContent(textLines.map((l) => l.text).join('\n'), items)
  result.players = result.players.map((p) => {
    const row = p.licence ? rows.get(p.licence) : null
    if (!row) return { ...p, confidence: { licence: 0.5, firstName: 0.5, lastName: 0.5 } }
    // the rest of a name from the line below goes to the name it stood under
    // (a stand-in for a lost name out again, also beside a real word)
    // (a name read with a small first letter, "anna", gets its capital back)
    const real = (name) => String(name || '').split(/\s+/).filter((w) => w && w !== NO_NAME)
      .map((w) => (/^\p{Ll}\p{L}{2,}/u.test(w) && !PARTICLE.test(w) ? w.charAt(0).toLocaleUpperCase() + w.slice(1) : w)).join(' ')
    const names = { firstName: real(p.firstName), lastName: real(p.lastName) }
    for (const m of row.more) {
      const key = String(p.firstName).split(/\s+/).includes(m.under) ? 'firstName' : 'lastName'
      names[key] = `${names[key]} ${m.text}`.trim()
    }
    // a row without a printed date of birth is no row VolleyManager printed
    // as read (one written in by hand, a row the photo garbled): every field
    // to check (real photos, 2026-11-26)
    const cap = row.dateGuessed ? HANDWRITTEN_MAX : 1
    return {
      ...p,
      ...names,
      ...(row.rawLicence !== null ? { licence: row.rawLicence } : {}),
      ...(row.dateGuessed ? { dob: '' } : {}),
      number: row.number ?? p.number ?? null,
      isLfp: p.isLfp || row.lfp,
      isCaptain: row.captain,
      isLibero: row.libero,
      // the box inside a circle whose number was not read (ocr.js reads it again)
      ...(row.ring && row.number === null ? { ringAt: row.ring } : {}),
      // where the team's handwriting is read again (ocr.js); struck out by hand
      handAt: row.hand,
      ...(row.licenceAt ? { licenceAt: row.licenceAt } : {}),
      ...(row.struck ? { struck: true } : {}),
      confidence: {
        licence: Math.min(row.rawLicence !== null ? Math.min(row.licenceConf, 0.3) : row.licenceConf, cap),
        firstName: Math.min(row.nameConf, cap),
        lastName: Math.min(row.nameConf, cap),
        ...(row.number !== null ? { number: row.numberConf } : {}),
        ...(row.captain ? { isCaptain: row.markConf } : {}),
        ...(row.libero ? { isLibero: row.markConf } : {})
      }
    }
  })
  // The officials as read on their lines (the reader's text pattern loses
  // a name with a particle, a role whose first letter the photo lost): each
  // into its slot, an assistant without its number into the first free one;
  // names split as VolleyManager writes them (officialNames)
  const taken = new Set()
  for (const o of officialsRead) {
    let slot = o.slot
    if (slot === 'ac' || (slot === 'coach' && taken.has('coach'))) slot = ['ac1', 'ac2'].find((k) => !taken.has(k)) || null
    if (!slot || taken.has(slot)) continue
    taken.add(slot)
    const player = result.players.find((p) => p.licence === o.licence)
    const { firstName, lastName, sure } = officialNames(o.names, player)
    result[slot] = { firstName, lastName, dob: '', birthYear: o.year, licence: o.licence, guessedSplit: !sure }
  }
  for (const k of ['coach', 'ac1', 'ac2']) {
    const o = result[k]
    if (!o) continue
    // each field by its own words (the role's label is no part of them)
    const line = textLines.find((l) => o.licence && l.text.includes(`#${o.licence}`))
    const confOf = (pred) => {
      const ws = line ? line.words.filter(pred) : []
      return ws.length ? Math.min(...ws.map((w) => w.conf)) / 100 : 0.5
    }
    const nameWords = (name) => new Set(String(name || '').toLowerCase().split(/\s+/).filter(Boolean))
    const first = nameWords(o.firstName)
    const last = nameWords(o.lastName)
    const has = (set) => (w) => set.has(w.text.toLowerCase().replace(/[^\p{L}'’-]/gu, ''))
    // (first and last name split by a guess: both to check)
    const split = o.guessedSplit ? 0.6 : 1
    const { guessedSplit, ...person } = o
    result[k] = {
      ...person,
      confidence: {
        licence: confOf((w) => w.text.includes(o.licence)),
        firstName: Math.min(split, confOf(has(first))),
        lastName: Math.min(split, confOf(has(last)))
      }
    }
  }
  // a row struck out by hand is no player of this game (owner): left out,
  // and named on the confirm screen, never imported as playing
  result.struck = result.players.filter((p) => p.struck).map(({ firstName, lastName, licence }) => ({ firstName, lastName, licence }))
  // the struck rows no player came of, inside the table (between its first
  // and last player row, or a row's height below the last)
  const tops = [...rows.values()].map((r) => r.hand.y).sort((a, b) => a - b)
  if (tops.length) {
    const pitch = tops.length > 1 ? median(tops.slice(1).map((y, i) => y - tops[i])) : 2 * height
    for (const l of lostStruck) {
      const mid = (l.top + l.bottom) / 2
      if (mid < tops[0] - 1.5 * pitch || mid > tops[tops.length - 1] + 1.5 * pitch) continue
      const [firstName = '', ...rest] = l.names
      result.struck.push({ firstName, lastName: rest.join(' '), licence: l.licence })
    }
  }
  result.players = result.players.filter((p) => !p.struck)
  return result
}

/**
 * The marks in what a second reading of a row's handwriting gave (ocr.js:
 * a group of ink no printed word explains, read alone, digits and C K L
 * only): "3K" the number 3 and the captain, "7 L1" 7 and a libero ("L1",
 * "L2": the libero's sign, not a number), "L" a libero, "C" or "K" the
 * captain. unsure: more than one number, or one of three digits.
 */
export function marksOfHand (text) {
  let t = String(text || '').toUpperCase().replace(/[^0-9CKL ]/g, '')
  let libero = false
  let captain = false
  t = t.replace(/L[12]?/g, () => { libero = true; return ' ' })
  t = t.replace(/[CK]/g, () => { captain = true; return ' ' })
  const numbers = t.split(/\s+/).filter(Boolean)
  const one = numbers.length === 1 && /^\d{1,2}$/.test(numbers[0]) && Number(numbers[0]) >= 1 ? Number(numbers[0]) : null
  return { number: one, captain, libero, unsure: numbers.length > 1 || numbers.some((n) => n.length > 2) }
}

/**
 * A player with the marks a second reading of their row's handwriting found
 * (reads: [{ text, conf 0..1, ringed }], left to right): its number wins
 * over the first reading's (which read handwriting with the print's eyes),
 * two different numbers keep the first and are unsure; C, K, L and a ring
 * add to what the first reading found. Every mark at most HANDWRITTEN_MAX.
 */
export function withHandReadings (player, reads) {
  const found = (reads || []).map((r) => ({ ...marksOfHand(r.text), conf: Math.min(Number(r.conf) || 0, HANDWRITTEN_MAX), ringed: !!r.ringed }))
  if (!found.length) return player
  const out = { ...player, confidence: { ...(player.confidence || {}) } }
  const numbers = found.filter((f) => f.number !== null)
  if (numbers.length) {
    const differ = numbers.some((f) => f.number !== numbers[0].number)
    out.number = numbers[0].number
    out.confidence.number = Math.min(numbers[0].conf, differ || numbers[0].unsure ? 0.4 : HANDWRITTEN_MAX)
  }
  if (found.some((f) => f.captain || f.ringed)) {
    out.isCaptain = true
    out.confidence.isCaptain = Math.min(out.confidence.isCaptain ?? HANDWRITTEN_MAX, ...found.filter((f) => f.captain || f.ringed).map((f) => f.conf))
  }
  if (found.some((f) => f.libero)) {
    out.isLibero = true
    out.confidence.isLibero = Math.min(out.confidence.isLibero ?? HANDWRITTEN_MAX, ...found.filter((f) => f.libero).map((f) => f.conf))
  }
  return out
}

