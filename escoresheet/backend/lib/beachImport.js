/**
 * beachImport — the Excel/CSV import of an OpenBeach tournament
 * (~/ov-ops/openbeach-separation-tournaments-PLAN.md 3.4, phase T2;
 * docs/beach-tournaments-spec.md section 9). Pure: no database, no clock.
 *
 * The browser reads the file (manager-beach: the template's sheets Entries
 * and, optionally, Matches; one CSV per sheet), matches its columns loosely
 * and sends the rows as text under the field names below. Everything else
 * happens here, on the server:
 *
 *   normalizeImport(body)   the rows' values, checked (per row: error or warning)
 *   planImport(state, in)   what the import would change, against the
 *                           tournament as it is now: per row OK / warning /
 *                           error, and a diff (new, changed, unchanged,
 *                           removed). The same plan is applied, field by field.
 *   importHash(plan)        the hash of the plan: the preview's hash, which
 *                           the apply call sends back; a different plan
 *                           (other rows, or the tournament changed
 *                           meanwhile) is refused.
 *
 * Entries (one row per pair): Draw (the category, e.g. A1) and Gender name
 * the draw, which is created when the tournament has none of that category
 * and gender. A row finds its pair in the draw by both licence numbers,
 * else by both players' names (in either order); a pair of the draw missing
 * from the file is withdrawn. A blank cell keeps what the pair has; seeds:
 * when any row of a draw has a seed, the file's seeds are the draw's seeds
 * (blank = none), else the pairs keep theirs. A new pair whose two licences
 * are exactly those of one saved beach pair (db/009) is linked to it.
 * Once a draw's bracket is drawn, only names, players and wildcards change
 * (as PATCH /api/beach/entries/:id); a new, withdrawn or re-seeded pair is
 * an error, and a pair missing from the file stays (a warning).
 *
 * Matches (optional, an organiser's own plan): a row finds its game by the
 * game number (Draw and Gender, when given, must be that game's draw) and
 * sets its date and time (Europe/Zurich), its court (created when missing)
 * and the officials. A blank cell keeps the value. A draw named in the
 * Matches sheet that has no bracket yet gets one in the same import, as
 * "Draw the bracket" would draw it, after every pair is seeded (unseeded
 * pairs take the next seeds in the file's order). Team 1 / Team 2 (a seed or
 * a pair) and Phase are only compared with the bracket (warnings). A slot
 * is checked like a hand move (lib/beachSchedule.js slotIssues): clashes are
 * warnings, since the organiser's plan wins.
 */

import { createHash } from 'node:crypto'
import { DE_MAX_TEAMS, DE_MIN_TEAMS, boardSizeFor, doubleElimination, drawWarnings } from './beachBracket.js'
import { slotIssues, zurichToIso } from './beachSchedule.js'

export const IMPORT_MAX_ENTRIES = 600
export const IMPORT_MAX_MATCHES = 1200
const MAX_CELL = 200
export const ENTRY_FIELDS = Object.freeze(['draw', 'gender', 'seed', 'team', 'p1_last', 'p1_first', 'p1_licence', 'p1_country',
  'p2_last', 'p2_first', 'p2_licence', 'p2_country', 'wildcard'])
export const MATCH_FIELDS = Object.freeze(['draw', 'gender', 'game', 'date', 'time', 'court', 'phase', 'round', 'team1', 'team2', 'referee', 'scorer'])
// statuses of a tournament match that lock its slot (lib/beachTournaments.js)
const BEGUN = ['called', 'in_progress', 'finished', 'walkover']
const OPEN_DRAW = ['entries', 'seeded']

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
/** Letters and digits only, lower case, no accents: 'Männer ' -> 'manner'. */
export const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

const GENDER_WORDS = {
  men: ['m', 'men', 'man', 'male', 'h', 'herren', 'herr', 'manner', 'maenner', 'hommes', 'homme', 'masculin', 'uomini', 'uomo', 'maschile'],
  women: ['w', 'f', 'd', 'women', 'woman', 'female', 'ladies', 'damen', 'dame', 'frauen', 'frau', 'femmes', 'femme', 'feminin', 'donne', 'donna', 'femminile'],
  mixed: ['x', 'mx', 'mix', 'mixed', 'mixte', 'misto', 'misti', 'gemischt']
}
const GENDER_OF = new Map(Object.entries(GENDER_WORDS).flatMap(([g, words]) => words.map((w) => [w, g])))
const YES = new Set(['yes', 'y', 'ja', 'j', 'oui', 'o', 'si', 'true', 'wahr', 'vrai', 'vero', '1', 'x', 'wc', 'wildcard'])
const NO = new Set(['no', 'n', 'nein', 'non', 'false', 'falsch', 'faux', 'falso', '0'])
const PHASE_WORDS = {
  winners: ['winners', 'winner', 'w', 'wb', 'winnersbracket', 'gewinner', 'gewinnerrunde', 'hauptrunde', 'vainqueurs', 'gagnants', 'vincenti', 'vincitori'],
  losers: ['losers', 'loser', 'l', 'lb', 'losersbracket', 'verlierer', 'verliererrunde', 'hoffnungsrunde', 'trostrunde', 'perdants', 'perdenti', 'repechage', 'ripescaggio'],
  final: ['final', 'finals', 'finale', 'finali', 'f', 'sf', 'semifinal', 'semifinals', 'semifinale', 'semifinali', 'halbfinal', 'halbfinale', 'halbfinals', 'demifinale', 'demifinales'],
  placement: ['placement', 'p3', '3rdplace', 'thirdplace', 'platz3', 'spielumplatz3', 'petitefinale', 'finale3', 'finaleper3', 'klassierung', 'classement', 'classifica'],
  pool: ['pool', 'pools', 'gruppe', 'poule', 'girone']
}
const PHASE_OF = new Map(Object.entries(PHASE_WORDS).flatMap(([p, words]) => words.map((w) => [w, p])))

// ------------------------------------------------------------------ values
/** A cell as text: trimmed, inner whitespace collapsed ('' when empty). */
function cell (v) {
  if (v == null) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  return String(v).replace(/\s+/g, ' ').trim()
}
const intText = (s, max) => {
  const m = /^(\d{1,4})(?:\.0+)?$/.exec(s)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= max ? n : null
}
/** '3', '#3', 'Seed 3', 'S3', '3.' -> 3 (1..128), else null. */
export function parseSeed (s) {
  const m = /^(?:#|seed|setzung|setz|s|nr|no|n°|tds|ts|ts\.)?\s*\.?\s*(\d{1,3})\.?$/i.exec(s)
  if (m) return intText(m[1], 128)
  return intText(s, 128)
}
/** 'Court 3', 'Platz 3', '3' -> 3 (1..99), else null. */
export function parseCourt (s) {
  const m = /^(?:court|platz|feld|terrain|campo|c|p)?\s*\.?\s*(\d{1,2})(?:\.0+)?$/i.exec(s)
  return m ? intText(m[1], 99) : null
}
/** '12', '#12', 'Game 12', 'Spiel 12' -> 12 (1..9999), else null. */
export function parseGame (s) {
  const m = /^(?:#|game|spiel|match|partita|nr|no|n°)?\s*\.?\s*(\d{1,4})\.?(?:0+)?$/i.exec(s)
  return m ? intText(m[1], 9999) : null
}
export function parseGender (s) {
  return GENDER_OF.get(fold(s)) ?? null
}
/** yes / no in five languages (and 1/0, x): true, false, or null when it is neither. */
export function parseYesNo (s) {
  const f = fold(s)
  if (YES.has(f)) return true
  if (NO.has(f) || s === '-') return false
  return null
}
function validDay (s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}
/** '2026-07-11', '11.07.2026', '11/7/2026', '11.7.26' -> '2026-07-11', else null. */
export function parseDate (s) {
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  let out = null
  if (m) out = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(s)
  if (m) out = `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return out && validDay(out) ? out : null
}
/** '9:30', '09:30', '9.30', '9h30', '09:30:00' -> minutes after midnight, else null. */
export function parseTime (s) {
  const m = /^(\d{1,2})[:.hH](\d{2})(?::\d{2})?$/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h <= 23 && min <= 59 ? h * 60 + min : null
}
export function parsePhase (s) {
  return PHASE_OF.get(fold(s)) ?? null
}
/** The default name of a pair: 'Muster/Beispiel' (as lib/beachTournaments.js). */
const pairName = (p1, p2) => [p1?.last, p2?.last].filter(Boolean).join('/').slice(0, 120) || 'Pair'
const drawKey = (category, gender) => `${category.toLowerCase()}|${gender}`

// ------------------------------------------------------------------ the request
/**
 * The import body { entries?: [row], matches?: [row] } as checked rows:
 * { error } (400: the body's shape) or { entries, matches }, each row
 * { row, msgs: [{ level, code, field?, ... }], ...values }.
 */
export function normalizeImport (body) {
  if (!isPlainObject(body)) return { error: 'body: must be an object' }
  const lists = {}
  for (const [k, max] of [['entries', IMPORT_MAX_ENTRIES], ['matches', IMPORT_MAX_MATCHES]]) {
    const v = body[k]
    if (v == null) { lists[k] = []; continue }
    if (!Array.isArray(v)) return { error: `${k}: a list of rows` }
    if (v.length > max) return { error: `${k}: at most ${max} rows` }
    if (!v.every(isPlainObject)) return { error: `${k}: every row is an object` }
    lists[k] = v
  }
  if (!lists.entries.length && !lists.matches.length) return { error: 'entries or matches: at least one row' }
  return {
    entries: lists.entries.map((r, i) => entryRow(r, i)),
    matches: lists.matches.map((r, i) => matchRow(r, i))
  }
}

/** The texts of a row's known fields (bad values and long ones are row errors). */
function texts (raw, fields, msgs) {
  const out = {}
  for (const f of fields) {
    const v = raw[f]
    if (v != null && !['string', 'number', 'boolean'].includes(typeof v)) {
      msgs.push({ level: 'error', code: 'bad_value', field: f })
      out[f] = ''
      continue
    }
    const s = cell(v)
    if (s.length > MAX_CELL) {
      msgs.push({ level: 'error', code: 'too_long', field: f, max: MAX_CELL })
      out[f] = ''
      continue
    }
    out[f] = s
  }
  return out
}
const rowNumber = (raw, i) => (Number.isInteger(raw.row) && raw.row >= 1 && raw.row <= 1e6 ? raw.row : i + 2)

function textField (s, field, max, msgs, { required = false } = {}) {
  if (!s) {
    if (required) msgs.push({ level: 'error', code: 'required', field })
    return null
  }
  if (s.length > max) {
    msgs.push({ level: 'error', code: 'too_long', field, max })
    return null
  }
  return s
}

function drawOf (v, msgs) {
  const category = textField(v.draw, 'draw', 20, msgs, { required: true })
  let gender = null
  if (!v.gender) msgs.push({ level: 'error', code: 'required', field: 'gender' })
  else if (!(gender = parseGender(v.gender))) msgs.push({ level: 'error', code: 'bad_gender', field: 'gender', value: v.gender.slice(0, 40) })
  return category && gender ? { category, gender, key: drawKey(category, gender) } : null
}

function entryRow (raw, i) {
  const msgs = []
  const v = texts(raw, ENTRY_FIELDS, msgs)
  const draw = drawOf(v, msgs)
  let seed = null
  if (v.seed) {
    seed = parseSeed(v.seed)
    if (seed == null) msgs.push({ level: 'error', code: 'bad_seed', field: 'seed', value: v.seed.slice(0, 40) })
  }
  const player = (p) => {
    const last = textField(v[`${p}_last`], `${p}_last`, 80, msgs, { required: true })
    const first = textField(v[`${p}_first`], `${p}_first`, 80, msgs)
    const licence = textField(v[`${p}_licence`], `${p}_licence`, 40, msgs)
    let country = null
    if (v[`${p}_country`]) {
      const c = v[`${p}_country`].toUpperCase()
      if (/^[A-Z]{3}$/.test(c)) country = c
      else msgs.push({ level: 'error', code: 'bad_country', field: `${p}_country`, value: v[`${p}_country`].slice(0, 40) })
    }
    return { first, last, licence, country }
  }
  const p1 = player('p1')
  const p2 = player('p2')
  if (p1.last && p2.last && (!p1.licence || !p2.licence)) msgs.push({ level: 'warning', code: 'no_licence' })
  let wildcard = null
  if (v.wildcard) {
    wildcard = parseYesNo(v.wildcard)
    if (wildcard == null) msgs.push({ level: 'error', code: 'bad_yes_no', field: 'wildcard', value: v.wildcard.slice(0, 40) })
  }
  const team = textField(v.team, 'team', 120, msgs)
  return { row: rowNumber(raw, i), msgs, draw, seed, team, p1, p2, wildcard }
}

function matchRow (raw, i) {
  const msgs = []
  const v = texts(raw, MATCH_FIELDS, msgs)
  // Draw and Gender are optional here (a check); both or none
  let draw = null
  if (v.draw || v.gender) draw = drawOf(v, msgs)
  let game = null
  if (!v.game) msgs.push({ level: 'error', code: 'required', field: 'game' })
  else if ((game = parseGame(v.game)) == null) msgs.push({ level: 'error', code: 'bad_game', field: 'game', value: v.game.slice(0, 40) })
  // a date cell may carry the time too ('2026-07-11 09:30')
  let dateText = v.date
  let timeText = v.time
  const both = /^(.+?)[ T](\d{1,2}[:.]\d{2}(?::\d{2})?)$/.exec(dateText)
  if (both) {
    dateText = both[1]
    if (!timeText) timeText = both[2]
  }
  let date = null
  let minutes = null
  if (dateText && (date = parseDate(dateText)) == null) msgs.push({ level: 'error', code: 'bad_date', field: 'date', value: v.date.slice(0, 40) })
  if (timeText && (minutes = parseTime(timeText)) == null) msgs.push({ level: 'error', code: 'bad_time', field: 'time', value: timeText.slice(0, 40) })
  if ((dateText && !timeText) || (!dateText && timeText)) msgs.push({ level: 'error', code: 'date_time_pair' })
  let court = null
  if (v.court && (court = parseCourt(v.court)) == null) msgs.push({ level: 'error', code: 'bad_court', field: 'court', value: v.court.slice(0, 40) })
  return {
    row: rowNumber(raw, i),
    msgs,
    draw,
    game,
    scheduled_at: date && minutes != null ? zurichToIso(date, minutes) : null,
    court,
    phase: v.phase ? v.phase.slice(0, 120) : null,
    team1: v.team1 ? v.team1.slice(0, 120) : null,
    team2: v.team2 ? v.team2.slice(0, 120) : null,
    referee: textField(v.referee, 'referee', 120, msgs),
    scorer: textField(v.scorer, 'scorer', 120, msgs)
  }
}

// ------------------------------------------------------------------ the plan
const personKey = (p) => `${fold(p?.last)}|${fold(p?.first)}`
const licenceKey = (a, b) => {
  const l1 = fold(a?.licence)
  const l2 = fold(b?.licence)
  return l1 && l2 ? [l1, l2].sort().join('|') : null
}
const namesKey = (a, b) => [personKey(a), personKey(b)].sort().join('||')
const samePerson = (x, y) => {
  const lx = fold(x?.licence)
  const ly = fold(y?.licence)
  if (lx && ly) return lx === ly
  return personKey(x) === personKey(y)
}
const playerOut = (p) => ({ first: p?.first || '', last: p?.last || '', licence: p?.licence ?? null, country: p?.country ?? null })
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const isoOf = (v) => (v == null ? null : new Date(v).toISOString())

/**
 * @param {object} state  the tournament as it is now (ordered lists)
 * @param {{ id, starts_on, ends_on, day_start, day_end }} state.tournament  days 'YYYY-MM-DD', hours 'HH:MM'
 * @param {Array<{ id, category, gender, status, board_size, slot_minutes, rest_minutes }>} state.draws  by created_at, id
 * @param {Array<{ id, draw_id, seed, team_id, name, player1, player2, wildcard, status }>} state.entries  by created_at, id
 * @param {Array<{ id, number }>} state.courts
 * @param {Array<{ id, draw_id, game_n, code, phase, source1, source2, entry1_id, entry2_id, court_id, scheduled_at,
 *   duration_min, status, match_id, referee, scorer }>} state.matches  by game_n
 * @param {Array<{ id, name, season, licences: string[] }>} state.savedPairs  saved beach pairs with two licensed players
 * @param {{ entries: object[], matches: object[] }} input  normalizeImport()
 */
export function planImport (state, input) {
  const t = state.tournament
  const warnings = []
  const drawsByKey = new Map(state.draws.map((d) => [drawKey(d.category, d.gender), d]))
  const drawById = new Map(state.draws.map((d) => [d.id, d]))
  const entriesOf = (drawId) => state.entries.filter((e) => e.draw_id === drawId)

  // ---- draws: the existing ones, then the new ones in the file's order
  const plannedDraws = [] // { key, category, gender, op, draw }
  const plannedByKey = new Map()
  const planDraw = (d) => {
    if (plannedByKey.has(d.key)) return plannedByKey.get(d.key)
    const existing = drawsByKey.get(d.key)
    const p = existing
      ? { key: d.key, category: existing.category, gender: existing.gender, op: 'existing', draw: existing }
      : { key: d.key, category: d.category, gender: d.gender, op: 'new', draw: null }
    plannedByKey.set(d.key, p)
    plannedDraws.push(p)
    return p
  }
  const isOpen = (p) => !p.draw || OPEN_DRAW.includes(p.draw.status)

  // ---- entries, per draw
  const entryRows = input.entries
  const byDraw = new Map()
  for (const r of entryRows) {
    if (!r.draw) continue
    const p = planDraw(r.draw)
    if (!byDraw.has(p.key)) byDraw.set(p.key, [])
    byDraw.get(p.key).push(r)
  }
  const entryOps = [] // { op, row, key, entry_id, name, values?, changes? }
  const finalEntries = new Map() // key -> [{ id|null, op|null, row|null, seed }]: the draw's pairs after the import
  const rowOps = new Map() // row object -> { op, name }

  const savedByLicences = new Map()
  for (const s of state.savedPairs || []) {
    if (!Array.isArray(s.licences) || s.licences.length !== 2) continue
    const k = s.licences.map(fold).sort().join('|')
    if (!savedByLicences.has(k)) savedByLicences.set(k, [])
    savedByLicences.get(k).push(s)
  }
  const year = String(t.starts_on || '').slice(0, 4)
  const savedPairFor = (p1, p2) => {
    const k = licenceKey(p1, p2)
    const list = k ? savedByLicences.get(k) : null
    if (!list?.length) return null
    // the tournament's season first, then the first by id (deterministic)
    const ranked = [...list].sort((a, b) => (b.season === year) - (a.season === year) || (a.id < b.id ? -1 : 1))
    return ranked[0]
  }

  for (const p of plannedDraws) {
    const rows = byDraw.get(p.key) || []
    if (!rows.length) continue
    const open = isOpen(p)
    // registered pairs first: a row finds the pair that plays before a withdrawn namesake
    const existing = (p.draw ? entriesOf(p.draw.id) : []).sort((a, b) => (a.status !== 'registered') - (b.status !== 'registered'))
    const fileSeeds = rows.some((r) => r.seed != null)
    // duplicates in the file
    const seenPair = new Map()
    const seenSeed = new Map()
    const seenLicence = new Map()
    for (const r of rows) {
      if (r.msgs.some((m) => m.level === 'error')) continue
      const k = licenceKey(r.p1, r.p2) || namesKey(r.p1, r.p2)
      if (seenPair.has(k)) {
        r.msgs.push({ level: 'error', code: 'duplicate_pair', first_row: seenPair.get(k) })
        continue
      }
      seenPair.set(k, r.row)
      if (r.seed != null) {
        if (seenSeed.has(r.seed)) r.msgs.push({ level: 'error', code: 'duplicate_seed', seed: r.seed, first_row: seenSeed.get(r.seed) })
        else seenSeed.set(r.seed, r.row)
      }
      for (const pl of [r.p1, r.p2]) {
        const l = fold(pl.licence)
        if (!l) continue
        if (seenLicence.has(l)) r.msgs.push({ level: 'error', code: 'player_twice', licence: pl.licence, first_row: seenLicence.get(l) })
        else seenLicence.set(l, r.row)
      }
    }
    // match the rows to the draw's pairs: both licences, then both names
    const matched = new Map() // row -> entry
    const taken = new Set()
    for (const pass of ['licence', 'names']) {
      for (const r of rows) {
        if (matched.has(r)) continue
        const k = pass === 'licence' ? licenceKey(r.p1, r.p2) : namesKey(r.p1, r.p2)
        if (!k) continue
        const e = existing.find((x) => !taken.has(x.id) &&
          (pass === 'licence' ? licenceKey(x.player1, x.player2) === k : namesKey(x.player1, x.player2) === k))
        if (e) {
          matched.set(r, e)
          taken.add(e.id)
        }
      }
    }
    const final = []
    for (const r of rows) {
      const e = matched.get(r)
      if (!e) {
        const pair = savedPairFor(r.p1, r.p2)
        const values = {
          name: r.team || pairName(r.p1, r.p2),
          seed: r.seed,
          wildcard: r.wildcard ?? false,
          team_id: pair ? pair.id : null,
          player1: playerOut(r.p1),
          player2: playerOut(r.p2)
        }
        if (!open) r.msgs.push({ level: 'error', code: 'draw_drawn', category: p.category, gender: p.gender })
        const op = { op: 'new', row: r.row, key: p.key, entry_id: null, name: values.name, values, changes: [] }
        if (pair) op.saved_pair = pair.name
        rowOps.set(r, op)
        entryOps.push(op)
        final.push({ id: null, op, row: r.row, seed: values.seed })
        continue
      }
      // the file's players in the pair's order
      const swap = !samePerson(r.p1, e.player1) && samePerson(r.p1, e.player2)
      const [f1, f2] = swap ? [r.p2, r.p1] : [r.p1, r.p2]
      const merge = (f, cur) => playerOut({
        first: f.first || cur?.first || '',
        last: f.last,
        licence: f.licence || cur?.licence || null,
        country: f.country || cur?.country || null
      })
      const to = {
        seed: fileSeeds ? r.seed : (e.seed ?? null),
        name: r.team || e.name,
        player1: merge(f1, e.player1),
        player2: merge(f2, e.player2),
        wildcard: r.wildcard ?? (e.wildcard === true),
        status: 'registered'
      }
      const from = {
        seed: e.seed ?? null,
        name: e.name,
        player1: playerOut(e.player1),
        player2: playerOut(e.player2),
        wildcard: e.wildcard === true,
        status: e.status
      }
      const changes = []
      for (const k of ['seed', 'name', 'player1', 'player2', 'wildcard', 'status']) {
        if (!sameJson(from[k], to[k])) changes.push({ field: k, from: from[k], to: to[k] })
      }
      if (open && !e.team_id) {
        const pair = savedPairFor(to.player1, to.player2)
        if (pair) changes.push({ field: 'team_id', from: null, to: pair.id, saved_pair: pair.name })
      }
      // once drawn: names, players and wildcards only
      if (!open && changes.some((c) => ['seed', 'status'].includes(c.field))) {
        r.msgs.push({ level: 'error', code: 'draw_drawn', category: p.category, gender: p.gender })
      }
      const op = { op: changes.length ? 'changed' : 'unchanged', row: r.row, key: p.key, entry_id: e.id, name: to.name, changes }
      rowOps.set(r, op)
      entryOps.push(op)
      final.push({ id: e.id, op, row: r.row, seed: to.seed })
    }
    // the draw's pairs missing from the file
    const missing = existing.filter((e) => !taken.has(e.id) && e.status === 'registered')
    if (missing.length && !open) {
      warnings.push({ level: 'warning', code: 'kept_drawn', category: p.category, gender: p.gender, count: missing.length })
      for (const e of missing) final.push({ id: e.id, op: null, row: null, seed: e.seed ?? null })
    } else {
      for (const e of missing) {
        entryOps.push({ op: 'removed', row: null, key: p.key, entry_id: e.id, name: e.name, changes: [{ field: 'status', from: 'registered', to: 'withdrawn' }] })
      }
    }
    finalEntries.set(p.key, final)
  }
  // draws not in the Entries sheet keep their registered pairs
  const registeredOf = (p) => {
    if (finalEntries.has(p.key)) return finalEntries.get(p.key)
    return (p.draw ? entriesOf(p.draw.id) : []).filter((e) => e.status === 'registered')
      .map((e) => ({ id: e.id, op: null, row: null, seed: e.seed ?? null }))
  }

  // ---- matches: which draws get their bracket in this import
  const matchRows = input.matches
  const existingGames = new Set(state.matches.map((m) => m.game_n))
  for (const r of matchRows) {
    if (!r.draw) continue
    const known = plannedByKey.get(r.draw.key) || (drawsByKey.has(r.draw.key) ? planDraw(r.draw) : null)
    if (!known) {
      r.msgs.push({ level: 'error', code: 'unknown_draw', category: r.draw.category, gender: r.draw.gender })
      r.unknownDraw = true
    }
  }
  const toDraw = []
  for (const p of plannedDraws) {
    if (!isOpen(p)) continue
    const wanted = matchRows.some((r) => r.draw?.key === p.key && r.game != null && !existingGames.has(r.game))
    if (wanted) toDraw.push(p)
  }
  const generated = [] // the matches of the brackets drawn here
  let base = Math.max(0, ...state.matches.map((m) => m.game_n))
  const brackets = new Map() // key -> { teams, board_size, first_game, last_game }
  for (const p of toDraw) {
    const list = registeredOf(p).filter((x) => !(x.op && x.op.op === 'removed'))
    const n = list.length
    if (n < DE_MIN_TEAMS || n > DE_MAX_TEAMS) {
      for (const r of matchRows) {
        if (r.draw?.key === p.key) r.msgs.push({ level: 'error', code: 'draw_size', category: p.category, gender: p.gender, teams: n, min: DE_MIN_TEAMS, max: DE_MAX_TEAMS })
      }
      continue
    }
    // every pair seeded: seeds first, then the pairs without one (the draw's
    // order, then the file's); the generator numbers them 1..n
    const ordered = [...list].sort((a, b) => (a.seed ?? Infinity) - (b.seed ?? Infinity) ||
      ((a.row ?? -1) - (b.row ?? -1)))
    let assigned = 0
    ordered.forEach((x, i) => {
      const seed = i + 1
      if (x.seed === seed) return
      assigned++
      if (x.op?.op === 'new') x.op.values.seed = seed
      else if (x.op) {
        const c = x.op.changes.find((y) => y.field === 'seed')
        const e = state.entries.find((y) => y.id === x.id)
        if (c) c.to = seed
        else x.op.changes.push({ field: 'seed', from: e?.seed ?? null, to: seed })
        if ((e?.seed ?? null) === seed) x.op.changes = x.op.changes.filter((y) => y.field !== 'seed')
        x.op.op = x.op.changes.length ? 'changed' : 'unchanged'
      } else {
        const e = state.entries.find((y) => y.id === x.id)
        entryOps.push({ op: 'changed', row: null, key: p.key, entry_id: x.id, name: e?.name ?? '', changes: [{ field: 'seed', from: e?.seed ?? null, to: seed }] })
      }
      x.seed = seed
    })
    if (assigned) warnings.push({ level: 'warning', code: 'seeds_assigned', category: p.category, gender: p.gender, count: assigned })
    const stored = p.draw?.board_size ?? null
    const size = stored != null && stored >= n ? stored : boardSizeFor(n)
    const bracket = doubleElimination(n, { boardSize: size })
    const slot = p.draw?.slot_minutes || 50
    for (const m of bracket.matches) {
      generated.push({
        id: `new:${p.key}:${m.code}`, key: p.key, draw_id: p.draw?.id ?? `new:${p.key}`, game_n: base + m.n, code: m.code, phase: m.phase,
        source1: m.source1, source2: m.source2, court_id: null, scheduled_at: null, duration_min: slot, status: 'scheduled',
        match_id: null, referee: null, scorer: null
      })
    }
    const courts = state.courts.length + new Set(matchRows.map((r) => r.court).filter((c) => c != null && !state.courts.some((x) => x.number === c))).size
    for (const w of drawWarnings({ teams: n, category: p.category, courts, boardSize: size })) {
      warnings.push({ level: 'warning', ...w, category: p.category, gender: p.gender })
    }
    brackets.set(p.key, { teams: n, board_size: size, first_game: base + 1, last_game: base + bracket.matches.length })
    base += bracket.matches.length
  }

  // ---- matches: the rows against the games
  const keyOfDrawId = new Map(plannedDraws.filter((p) => p.draw).map((p) => [p.draw.id, p.key]))
  for (const d of state.draws) if (!keyOfDrawId.has(d.id)) keyOfDrawId.set(d.id, drawKey(d.category, d.gender))
  const games = new Map()
  for (const m of state.matches) games.set(m.game_n, { ...m, key: keyOfDrawId.get(m.draw_id), existing: true })
  for (const m of generated) games.set(m.game_n, { ...m, existing: false })
  const courtByNumber = new Map(state.courts.map((c) => [c.number, c]))
  const courtNumberById = new Map(state.courts.map((c) => [c.id, c.number]))
  const newCourts = []
  const seenGame = new Map()
  const matchOps = [] // { op, row, game_n, code, key, tmatch_id, set, changes }
  const opOfRow = new Map()
  // the pairs of the planned seeds (for Team 1 / Team 2)
  const seedEntry = new Map() // key -> Map(seed -> { name, p1, p2 })
  for (const p of plannedDraws) {
    const map = new Map()
    for (const x of registeredOf(p)) {
      if (x.op?.op === 'removed' || x.seed == null) continue
      if (x.op?.op === 'new') map.set(x.seed, { name: x.op.values.name })
      else {
        const e = state.entries.find((y) => y.id === x.id)
        map.set(x.seed, { name: x.op?.name ?? e?.name ?? '' })
      }
    }
    seedEntry.set(p.key, map)
  }
  for (const d of state.draws) {
    const key = drawKey(d.category, d.gender)
    if (seedEntry.has(key)) continue
    const map = new Map()
    for (const e of entriesOf(d.id)) if (e.status === 'registered' && e.seed != null) map.set(e.seed, { name: e.name })
    seedEntry.set(key, map)
  }
  const entryName = new Map(state.entries.map((e) => [e.id, e.name]))

  for (const r of matchRows) {
    if (r.game == null || r.unknownDraw) continue
    if (seenGame.has(r.game)) {
      r.msgs.push({ level: 'error', code: 'duplicate_game', game: r.game, first_row: seenGame.get(r.game) })
      continue
    }
    seenGame.set(r.game, r.row)
    const g = games.get(r.game)
    if (!g) {
      r.msgs.push({ level: 'error', code: 'unknown_game', game: r.game })
      continue
    }
    const gp = plannedByKey.get(g.key) || state.draws.map((d) => ({ key: drawKey(d.category, d.gender), category: d.category, gender: d.gender })).find((x) => x.key === g.key)
    if (r.draw && r.draw.key !== g.key) {
      r.msgs.push({ level: 'error', code: 'game_other_draw', game: r.game, category: gp?.category ?? '', gender: gp?.gender ?? '', match_code: g.code })
      continue
    }
    const set = {}
    const changes = []
    if (r.court != null) {
      const cur = g.court_id ? courtNumberById.get(g.court_id) ?? null : null
      if (cur !== r.court) {
        set.court = r.court
        changes.push({ field: 'court', from: cur, to: r.court })
        if (!courtByNumber.has(r.court) && !newCourts.includes(r.court)) newCourts.push(r.court)
      }
    }
    if (r.scheduled_at) {
      const cur = isoOf(g.scheduled_at)
      if (cur !== r.scheduled_at) {
        set.scheduled_at = r.scheduled_at
        changes.push({ field: 'scheduled_at', from: cur, to: r.scheduled_at })
      }
    }
    for (const k of ['referee', 'scorer']) {
      if (r[k] && r[k] !== (g[k] ?? null)) {
        set[k] = r[k]
        changes.push({ field: k, from: g[k] ?? null, to: r[k] })
      }
    }
    const begun = BEGUN.includes(g.status) || g.match_id != null
    if (begun && (set.court != null || set.scheduled_at)) r.msgs.push({ level: 'error', code: 'match_begun', game: r.game, match_code: g.code })
    // checks against the bracket (warnings)
    const seeds = seedEntry.get(g.key) || new Map()
    for (const [side, text, source, entryId] of [[1, r.team1, g.source1, g.entry1_id], [2, r.team2, g.source2, g.entry2_id]]) {
      if (!text) continue
      const seedM = /^seed:(\d+)$/.exec(source || '')
      const fileSeed = parseSeed(text)
      if (fileSeed != null) {
        if (seedM && Number(seedM[1]) !== fileSeed) r.msgs.push({ level: 'warning', code: 'team_mismatch', side, expected: `#${seedM[1]}` })
        continue
      }
      const expected = entryId ? entryName.get(entryId) : seedM ? seeds.get(Number(seedM[1]))?.name : null
      if (expected && fold(expected) !== fold(text)) r.msgs.push({ level: 'warning', code: 'team_mismatch', side, expected })
    }
    const phase = r.phase ? parsePhase(r.phase) : null
    if (phase && phase !== g.phase) r.msgs.push({ level: 'warning', code: 'phase_mismatch', expected: g.phase })
    const op = {
      op: changes.length ? 'changed' : 'unchanged',
      row: r.row,
      game_n: r.game,
      code: g.code,
      key: g.key,
      tmatch_id: g.existing ? g.id : null,
      set,
      changes
    }
    opOfRow.set(r, op)
    matchOps.push(op)
  }

  // ---- slots of the final plan, checked like a hand move (warnings); a
  // row with an error moves nothing
  const failed = (r) => r.msgs.some((m) => m.level === 'error')
  const goodOps = new Map(matchRows.filter((r) => opOfRow.has(r) && !failed(r)).map((r) => [r.game, opOfRow.get(r)]))
  const finalGames = [...games.values()].map((g) => {
    const op = goodOps.get(g.game_n)
    const courtNo = op?.set.court ?? (g.court_id ? courtNumberById.get(g.court_id) : null)
    return {
      ...g,
      court_id: courtNo != null ? `court:${courtNo}` : null,
      scheduled_at: op?.set.scheduled_at ?? isoOf(g.scheduled_at),
      dur: g.duration_min || drawById.get(g.draw_id)?.slot_minutes || 50
    }
  }).filter((g) => g.status !== 'cancelled')
  for (const r of matchRows) {
    const op = opOfRow.get(r)
    if (!op || failed(r) || op.op !== 'changed' || !(op.set.court != null || op.set.scheduled_at)) continue
    const g = finalGames.find((x) => x.game_n === op.game_n)
    if (!g?.scheduled_at) continue
    const d = drawById.get(g.draw_id)
    const issues = slotIssues({
      match: { ...g, duration_min: g.dur },
      others: finalGames.filter((x) => x.game_n !== g.game_n && x.scheduled_at),
      tournament: { starts_on: t.starts_on, ends_on: t.ends_on, day_start: t.day_start, day_end: t.day_end },
      slotMinutes: d?.slot_minutes || 50,
      restMinutes: d?.rest_minutes || 0
    })
    for (const i of issues) r.msgs.push({ level: 'warning', code: 'slot_conflict', reason: i.reason, ...(i.game_n ? { game: i.game_n, match_code: i.code } : {}) })
  }

  // ---- the answer
  const status = (msgs) => (msgs.some((m) => m.level === 'error') ? 'error' : msgs.some((m) => m.level === 'warning') ? 'warning' : 'ok')
  const rows = {
    entries: entryRows.map((r) => ({
      row: r.row,
      status: status(r.msgs),
      op: rowOps.get(r)?.op ?? null,
      category: r.draw ? plannedByKey.get(r.draw.key)?.category ?? r.draw.category : null,
      gender: r.draw?.gender ?? null,
      name: rowOps.get(r)?.name ?? (r.p1?.last || r.p2?.last ? (r.team || pairName(r.p1, r.p2)) : null),
      messages: r.msgs
    })),
    matches: matchRows.map((r) => ({
      row: r.row,
      status: status(r.msgs),
      op: opOfRow.get(r)?.op ?? null,
      game_n: r.game,
      code: opOfRow.get(r)?.code ?? null,
      messages: r.msgs
    }))
  }
  const errors = [...rows.entries, ...rows.matches].filter((x) => x.status === 'error').length
  const count = (list, op) => list.filter((x) => x.op === op).length
  const summary = {
    draws_new: plannedDraws.filter((p) => p.op === 'new').length,
    entries_new: count(entryOps, 'new'),
    entries_changed: count(entryOps, 'changed'),
    entries_unchanged: count(entryOps, 'unchanged'),
    entries_removed: count(entryOps, 'removed'),
    brackets: brackets.size,
    matches_changed: count(matchOps, 'changed'),
    matches_unchanged: count(matchOps, 'unchanged'),
    courts_new: newCourts.length,
    errors,
    warnings: [...rows.entries, ...rows.matches].filter((x) => x.status === 'warning').length + warnings.length
  }
  const changes = summary.draws_new + summary.entries_new + summary.entries_changed + summary.entries_removed +
    summary.brackets + summary.matches_changed + summary.courts_new
  return {
    summary,
    can_apply: errors === 0 && changes > 0,
    warnings,
    rows,
    draws: plannedDraws.map((p) => ({
      key: p.key, category: p.category, gender: p.gender, op: p.op, draw_id: p.draw?.id ?? null, bracket: brackets.get(p.key) ?? null
    })),
    entries: entryOps.filter((o) => o.op !== 'unchanged'),
    matches: matchOps.filter((o) => o.op === 'changed'),
    courts: [...newCourts].sort((a, b) => a - b).map((number) => ({ number }))
  }
}

/** The hash of a plan (hex sha256 of its JSON): what the preview shows and the apply call sends back. */
export function importHash (plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}
