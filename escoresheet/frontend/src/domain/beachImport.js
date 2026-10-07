/**
 * The Excel/CSV import of an OpenBeach tournament, in the browser
 * (manager-beach, plan 3.4, phase T2). Pure: no React, no network.
 *
 *   ENTRY_COLUMNS / MATCH_COLUMNS  the template's columns (their names in
 *                                   en, de, fr, it) and the other names a
 *                                   column may have; matched loosely
 *                                   (lower case, no accents, no spaces or
 *                                   punctuation), as openbeach's old
 *                                   excelParser_beach.js findCol/norm did
 *   parseCsv(text)                  one sheet (';', ',' or tab; quotes)
 *   readImportSheets(sheets)        the sheets of the files: which is Entries,
 *                                   which Matches, their header row, the rows
 *                                   as { row, field: text } for the server
 *   templateSheets(lang, info)      the sheets of the downloadable template
 *
 * Everything the values mean (genders, seeds, dates, the diff) is checked on
 * the server (backend lib/beachImport.js); this module only finds the columns
 * and turns the cells into text. Excel stores dates and times as numbers
 * (days since 1899-12-30, or 1904): they become 'YYYY-MM-DD' and 'HH:MM' by
 * their column.
 */

export const IMPORT_MAX_ENTRIES = 600
export const IMPORT_MAX_MATCHES = 1200
const MAX_CELL = 200

/** Letters and digits only, lower case, no accents: 'Spieler 1 Nachname' -> 'spieler1nachname'. */
export const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

const LANGS = ['en', 'de', 'fr', 'it']
const PLAYER_PREFIX = (i) => [`player ${i}`, `p${i}`, `spieler ${i}`, `spielerin ${i}`, `joueur ${i}`, `joueuse ${i}`, `giocatore ${i}`, `giocatrice ${i}`]
const PLAYER_WORDS = {
  last: ['last name', 'lastname', 'last', 'surname', 'family name', 'name', 'nachname', 'familienname', 'nom', 'nom de famille', 'cognome'],
  first: ['first name', 'firstname', 'first', 'given name', 'vorname', 'prenom', 'nome'],
  licence: ['licence', 'license', 'licence no', 'licence number', 'license number', 'lizenz', 'lizenznummer', 'lizenz nr', 'licenza', 'numero licenza', 'lic'],
  country: ['country', 'nation', 'nationality', 'nat', 'land', 'nationalitat', 'pays', 'nationalite', 'nazione', 'paese', 'nazionalita']
}
const PLAYER_LABEL = {
  last: { en: 'last name', de: 'Nachname', fr: 'nom', it: 'cognome' },
  first: { en: 'first name', de: 'Vorname', fr: 'prénom', it: 'nome' },
  licence: { en: 'licence', de: 'Lizenz', fr: 'licence', it: 'licenza' },
  country: { en: 'country', de: 'Land', fr: 'pays', it: 'nazione' }
}
const PLAYER_HEAD = { en: 'Player', de: 'Spieler', fr: 'Joueur', it: 'Giocatore' }
const DRAW = { key: 'draw', labels: { en: 'Draw', de: 'Tableau', fr: 'Tableau', it: 'Tabellone' }, aliases: ['category', 'kategorie', 'categorie', 'categoria', 'cat', 'serie', 'klasse'], width: 10 }
const GENDER = { key: 'gender', labels: { en: 'Gender', de: 'Geschlecht', fr: 'Genre', it: 'Genere' }, aliases: ['sex', 'sexe', 'sesso'], width: 11 }

function playerColumns(i) {
  return ['last', 'first', 'licence', 'country'].map((k) => ({
    key: `p${i}_${k}`,
    labels: Object.fromEntries(LANGS.map((l) => [l, `${PLAYER_HEAD[l]} ${i} ${PLAYER_LABEL[k][l]}`])),
    aliases: PLAYER_PREFIX(i).flatMap((p) => PLAYER_WORDS[k].flatMap((w) => [`${p} ${w}`, `${w} ${p}`, `${w} ${i}`])),
    width: k === 'country' ? 10 : k === 'licence' ? 13 : 18
  }))
}

/** The Entries sheet: one row per pair. */
export const ENTRY_COLUMNS = Object.freeze([
  DRAW,
  GENDER,
  { key: 'seed', labels: { en: 'Seed', de: 'Setzung', fr: 'Tête de série', it: 'Testa di serie' }, aliases: ['seeding', 'setzplatz', 'setzposition', 'tds'], width: 8 },
  ...playerColumns(1),
  ...playerColumns(2),
  { key: 'team', labels: { en: 'Team name', de: 'Teamname', fr: "Nom d'équipe", it: 'Nome squadra' }, aliases: ['team', 'pair', 'paar', 'equipe', 'squadra', 'coppia', 'team name'], width: 22 },
  { key: 'wildcard', labels: { en: 'Wildcard', de: 'Wildcard', fr: 'Wildcard', it: 'Wildcard' }, aliases: ['wild card', 'wc'], width: 10 }
])

/** The Matches sheet (optional): the organiser's own plan, one row per game. */
export const MATCH_COLUMNS = Object.freeze([
  DRAW,
  GENDER,
  { key: 'game', labels: { en: 'Game #', de: 'Spiel-Nr.', fr: 'Match n°', it: 'Partita n.' }, aliases: ['game no', 'game number', 'match', 'match no', 'match number', 'spiel', 'spielnummer', 'nr', 'no', 'number', 'numero', 'partita'], width: 9 },
  { key: 'date', labels: { en: 'Date', de: 'Datum', fr: 'Date', it: 'Data' }, aliases: ['day', 'tag', 'jour', 'giorno', 'match date', 'spieldatum'], width: 12 },
  { key: 'time', labels: { en: 'Time', de: 'Zeit', fr: 'Heure', it: 'Ora' }, aliases: ['start', 'start time', 'beginn', 'spielbeginn', 'uhrzeit', 'debut', 'inizio'], width: 8 },
  { key: 'court', labels: { en: 'Court', de: 'Feld', fr: 'Terrain', it: 'Campo' }, aliases: ['court no', 'court number', 'platz', 'spielfeld'], width: 8 },
  { key: 'phase', labels: { en: 'Phase', de: 'Phase', fr: 'Phase', it: 'Fase' }, aliases: ['stage'], width: 14 },
  { key: 'round', labels: { en: 'Round', de: 'Runde', fr: 'Tour', it: 'Turno' }, aliases: [], width: 8 },
  { key: 'team1', labels: { en: 'Team 1', de: 'Team 1', fr: 'Équipe 1', it: 'Squadra 1' }, aliases: ['team a', 'home', 'home team', 'pair 1', 'paar 1'], width: 22 },
  { key: 'team2', labels: { en: 'Team 2', de: 'Team 2', fr: 'Équipe 2', it: 'Squadra 2' }, aliases: ['team b', 'away', 'away team', 'pair 2', 'paar 2'], width: 22 },
  { key: 'referee', labels: { en: '1st referee', de: '1. Schiedsrichter', fr: '1er arbitre', it: '1° arbitro' }, aliases: ['referee', 'first referee', 'ref', 'ref 1', '1st ref', 'schiedsrichter', 'sr', 'sr1', 'arbitre', 'arbitro'], width: 20 },
  { key: 'scorer', labels: { en: 'Scorer', de: 'Schreiber', fr: 'Marqueur', it: 'Segnapunti' }, aliases: ['scorekeeper', 'score keeper', 'secretary', 'sekretar'], width: 20 }
])

export const REQUIRED = Object.freeze({ entries: ['draw', 'gender', 'p1_last', 'p2_last'], matches: ['game'] })
const COLUMNS = { entries: ENTRY_COLUMNS, matches: MATCH_COLUMNS }
// the names a sheet may have (else its columns decide)
const SHEET_NAMES = {
  entries: ['entries', 'entry', 'anmeldungen', 'anmeldung', 'meldungen', 'teams', 'paare', 'pairs', 'setzliste', 'seedlist', 'inscriptions', 'equipes', 'iscrizioni', 'squadre', 'coppie'],
  matches: ['matches', 'games', 'spiele', 'spielplan', 'plan', 'schedule', 'matchs', 'programme', 'partite', 'programma', 'calendario']
}

/** fold(name) -> field key, for one kind of sheet (the labels first, then the other names). */
function lookupOf(kind) {
  const map = new Map()
  for (const c of COLUMNS[kind]) for (const l of Object.values(c.labels)) if (fold(l) && !map.has(fold(l))) map.set(fold(l), c.key)
  for (const c of COLUMNS[kind]) for (const a of [c.key, ...c.aliases]) if (fold(a) && !map.has(fold(a))) map.set(fold(a), c.key)
  return map
}
const LOOKUP = { entries: lookupOf('entries'), matches: lookupOf('matches') }

/** The fields of a header row: Map(column index -> field) and the columns no field knows. */
export function headerFields(cells, kind) {
  const fields = new Map()
  const unknown = []
  const used = new Set()
  cells.forEach((h, i) => {
    const f = fold(h)
    if (!f) return
    const key = LOOKUP[kind].get(f)
    if (key && !used.has(key)) {
      fields.set(i, key)
      used.add(key)
    } else unknown.push(String(h).trim())
  })
  return { fields, unknown }
}

// ------------------------------------------------------------------ CSV
/** The delimiter of a CSV text: the one of ';', ',' and tab seen most often in its first line, outside quotes. */
function delimiterOf(text) {
  const counts = { ';': 0, ',': 0, '\t': 0 }
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && ch in counts) counts[ch]++
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return n > 0 ? best : ','
}

/** A CSV text as rows of cells (Excel's CSV: ';' in Switzerland, quotes doubled inside quotes). */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '')
  const sep = delimiterOf(src)
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === sep) { row.push(cell); cell = '' } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** The text of a file's bytes: UTF-8, else Windows-1252 (Excel's "CSV" on Windows). */
export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8)
  } catch {
    return new TextDecoder('windows-1252').decode(u8)
  }
}

// ------------------------------------------------------------------ cells
const pad = (n) => String(n).padStart(2, '0')
/** An Excel serial day (1900 or 1904 system) as 'YYYY-MM-DD' and its time as 'HH:MM' (or null at midnight). */
export function excelSerial(n, date1904 = false) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const ms = Math.round((n * 86400) / 60) * 60000
  const d = new Date(epoch + ms)
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
  return { day, time: minutes ? `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}` : null }
}

/** One cell as the text the server reads, by its field. */
export function cellText(v, field, { date1904 = false } = {}) {
  if (v == null) return ''
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return ''
    if (field === 'date' && v > 0) {
      const { day, time } = excelSerial(v, date1904)
      return time ? `${day} ${time}` : day
    }
    if (field === 'time' && v >= 0) {
      const minutes = Math.round((v % 1) * 1440) % 1440
      return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
    }
    return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)))
  }
  const s = String(v).replace(/\s+/g, ' ').trim()
  // an ISO date-time cell (t="d"): the date, and its time unless midnight
  const iso = field === 'date' && /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s)
  if (iso) return iso[2] === '00:00' ? iso[1] : `${iso[1]} ${iso[2]}`
  return s.slice(0, MAX_CELL + 1)
}

// ------------------------------------------------------------------ sheets
/** The kind a sheet's name suggests: 'entries', 'matches' or null. */
function kindOfName(name) {
  const f = fold(name)
  for (const [kind, names] of Object.entries(SHEET_NAMES)) if (names.includes(f)) return kind
  return null
}

/** The header row (one of the first 10) and the kind of a sheet: the row and kind with the most known columns. */
function headerOf(rows, hint) {
  let best = null
  for (let r = 0; r < Math.min(10, rows.length); r++) {
    for (const kind of hint ? [hint] : ['matches', 'entries']) {
      const h = headerFields(rows[r] || [], kind)
      // the Matches sheet needs its game number, the Entries sheet its players
      const decisive = kind === 'matches' ? [...h.fields.values()].includes('game') : [...h.fields.values()].includes('p1_last')
      if (!hint && !decisive) continue
      if (h.fields.size >= 2 && (!best || h.fields.size > best.h.fields.size)) best = { r, kind, h }
    }
  }
  return best
}

/**
 * The import rows of the files' sheets.
 * @param {Array<{ name: string, file?: string, rows: Array<Array<any>>, date1904?: boolean }>} sheets
 * @returns {{ payload: { entries?: object[], matches?: object[] }, found: Array<{ name, file, kind, rows, unknown }>, problems: Array<{ code, ... }> }}
 *   problems block the preview (missing columns, two sheets of a kind,
 *   too many rows, nothing found); `unknown` columns are only shown
 */
export function readImportSheets(sheets) {
  const payload = {}
  const found = []
  const problems = []
  for (const sheet of sheets) {
    const rows = sheet.rows || []
    const head = headerOf(rows, kindOfName(sheet.name))
    if (!head) continue
    const { r: headerRow, kind, h } = head
    // a CSV file is its one sheet: its file name; a workbook's sheet: 'file.xlsx · Sheet'
    const label = !sheet.file ? sheet.name : sheet.file.replace(/\.[^.]+$/, '') === sheet.name ? sheet.file : `${sheet.file} · ${sheet.name}`
    if (payload[kind]) {
      problems.push({ code: 'duplicate_sheet', kind, sheet: label })
      continue
    }
    const keys = new Set(h.fields.values())
    const missing = REQUIRED[kind].filter((k) => !keys.has(k))
    if (missing.length) {
      problems.push({ code: 'missing_columns', kind, sheet: label, columns: missing })
      continue
    }
    const out = []
    for (let i = headerRow + 1; i < rows.length; i++) {
      const cells = rows[i] || []
      const row = { row: i + 1 }
      let empty = true
      for (const [col, key] of h.fields) {
        const text = cellText(cells[col], key, { date1904: sheet.date1904 })
        row[key] = text
        if (text) empty = false
      }
      if (!empty) out.push(row)
    }
    const max = kind === 'entries' ? IMPORT_MAX_ENTRIES : IMPORT_MAX_MATCHES
    if (out.length > max) {
      problems.push({ code: 'too_many_rows', kind, sheet: label, max })
      continue
    }
    payload[kind] = out
    found.push({ name: label, kind, rows: out.length, unknown: h.unknown })
  }
  if (!found.length && !problems.length) problems.push({ code: 'nothing_found' })
  else if (found.length && !problems.length && found.every((f) => f.rows === 0)) problems.push({ code: 'no_rows' })
  // an empty sheet sends nothing (an empty Entries sheet must not read as "no pairs")
  for (const k of Object.keys(payload)) if (!payload[k].length) delete payload[k]
  return { payload, found, problems }
}

/**
 * The template's sheets in a language (de-CH: de): Entries, Matches, and an
 * Info sheet with the given lines and an example for every column.
 * @param {string} lang
 * @param {{ title: string, lines: string[], columnHead: string, exampleHead: string, sheetNames: { entries, matches, info }, examples: object }} info
 */
export function templateSheets(lang, info) {
  const l = LANGS.includes(String(lang).slice(0, 2)) ? String(lang).slice(0, 2) : 'en'
  const sheet = (name, columns) => ({ name, rows: [columns.map((c) => c.labels[l])], widths: columns.map((c) => Math.max(c.width, c.labels[l].length + 2)) })
  const example = (columns) => columns.map((c) => [c.labels[l], info.examples?.[c.key] ?? ''])
  return [
    sheet(info.sheetNames.entries, ENTRY_COLUMNS),
    sheet(info.sheetNames.matches, MATCH_COLUMNS),
    {
      name: info.sheetNames.info,
      rows: [
        [info.title],
        ...info.lines.map((x) => [x]),
        [],
        [info.sheetNames.entries, info.exampleHead],
        ...example(ENTRY_COLUMNS),
        [],
        [info.sheetNames.matches, info.exampleHead],
        ...example(MATCH_COLUMNS)
      ],
      widths: [28, 60]
    }
  ]
}

/** The name of a field's column in a language (the template's header): 'p1_last' -> 'Spieler 1 Nachname'. */
export function columnLabel(field, lang) {
  const l = LANGS.includes(String(lang).slice(0, 2)) ? String(lang).slice(0, 2) : 'en'
  const c = ENTRY_COLUMNS.find((x) => x.key === field) || MATCH_COLUMNS.find((x) => x.key === field)
  return c ? c.labels[l] : String(field ?? '')
}

/** The file name of a tournament's template: 'zuri-open-2026-import.xlsx'. */
export function templateFileName(tournament) {
  return `${tournament?.slug || 'openbeach'}-import.xlsx`
}
