/**
 * Global tool: the two Excel/CSV uploads of Match Setup. Pure: no React, no
 * network, nothing stored. Rosters and games live in the file and on the
 * device only (owner 2026-11-14).
 *
 *   parseRosters(rows)  one sheet: Team, Number, First name, Last name,
 *                       Role (Player, Libero, Captain, Coach, Assistant
 *                       coach, Physiotherapist, Medic), Date of birth
 *   parseGames(rows)    one sheet: Game, Date, Time, Hall, City, League,
 *                       Home, Away, Best of, 1st referee, 2nd referee
 *   rosterTemplate() / gamesTemplate()  the sheets of the downloadable files
 *
 * Columns are found by name (en, de), loosely: lower case, no accents, no
 * punctuation. Excel dates are day counts (1899-12-30), times day fractions.
 */

export const MAX_ROWS = 600
const MAX_CELL = 120

export const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
const text = (v) => (v == null ? '' : String(v).trim().slice(0, MAX_CELL))

const ROSTER_COLUMNS = {
  team: ['team', 'mannschaft', 'equipe', 'squadra'],
  number: ['number', 'no', 'nr', 'nummer', 'trikot', 'shirt', 'numero'],
  first: ['firstname', 'first', 'vorname', 'prenom', 'nome'],
  last: ['lastname', 'last', 'surname', 'nachname', 'name', 'nom', 'cognome'],
  role: ['role', 'rolle', 'position', 'funktion', 'ruolo'],
  dob: ['dateofbirth', 'dob', 'birthdate', 'geburtsdatum', 'geboren', 'birthday']
}
const GAME_COLUMNS = {
  gameN: ['game', 'gamenumber', 'gameno', 'spiel', 'spielnummer', 'spielnr', 'match', 'matchnumber', 'nr', 'no', 'number'],
  date: ['date', 'datum'],
  time: ['time', 'zeit', 'uhrzeit', 'kickoff', 'start'],
  hall: ['hall', 'halle', 'venue', 'court', 'feld', 'location'],
  city: ['city', 'ort', 'stadt', 'town'],
  league: ['league', 'liga', 'category', 'kategorie', 'competition', 'group', 'gruppe', 'pool'],
  home: ['home', 'hometeam', 'heim', 'heimteam', 'teama', 'team1'],
  away: ['away', 'awayteam', 'gast', 'gastteam', 'teamb', 'team2', 'guest'],
  bestOf: ['bestof', 'sets', 'format', 'modus'],
  ref1: ['1streferee', 'firstreferee', 'referee1', 'ref1', '1sr', 'referee', 'schiedsrichter', '1schiedsrichter', 'sr1'],
  ref2: ['2ndreferee', 'secondreferee', 'referee2', 'ref2', '2sr', '2schiedsrichter', 'sr2']
}

/** Column index per field from the header row; the first column wins. */
function findColumns(header, spec) {
  const folded = header.map(fold)
  const cols = {}
  for (const [field, names] of Object.entries(spec)) {
    const i = folded.findIndex((h, idx) => h && names.includes(h) && !Object.values(cols).includes(idx))
    if (i >= 0) cols[field] = i
  }
  return cols
}

/** The header is the first row (of the first 10) that names at least `need` known columns. */
function findHeader(rows, spec, need) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cols = findColumns(rows[r] || [], spec)
    if (Object.keys(cols).length >= need) return { index: r, cols }
  }
  return null
}

export function excelDateToIso(n, date1904 = false) {
  const base = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30)
  const d = new Date(base + Math.floor(n) * 86400000)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/** '2026-11-14', 14.11.2026, 14/11/26, 46340 (Excel) -> 'YYYY-MM-DD', else ''. */
export function toIsoDate(v, date1904 = false) {
  if (v == null || v === '') return ''
  if (typeof v === 'number') return v > 20000 && v < 80000 ? excelDateToIso(v, date1904) : ''
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/)
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return /^\d{5}$/.test(s) ? excelDateToIso(Number(s), date1904) : ''
}

/** '18:30', '18.30', 0.7708 (Excel) -> 'HH:MM', else ''. */
export function toTime(v) {
  if (v == null || v === '') return ''
  if (typeof v === 'number') {
    if (v < 0 || v >= 1) return ''
    const mins = Math.round(v * 1440) % 1440
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
  }
  const m = String(v).trim().match(/^(\d{1,2})[:.h](\d{2})/)
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : ''
}

/** Display dob (DD/MM/YYYY, as the roster editor keeps it) from a cell. */
function toDisplayDob(v, date1904) {
  const iso = toIsoDate(v, date1904)
  return iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : ''
}

const BENCH_ROLE = (r) => {
  const f = fold(r)
  if (['coach', 'headcoach', 'trainer', 'cheftrainer'].includes(f)) return 'Coach'
  if (['assistantcoach', 'assistantcoach1', 'ac1', 'co-trainer', 'cotrainer', 'assistent', 'assistenztrainer', 'assistenztrainer1'].includes(f)) return 'Assistant Coach 1'
  if (['assistantcoach2', 'ac2', 'assistenztrainer2'].includes(f)) return 'Assistant Coach 2'
  if (['physiotherapist', 'physio', 'physiotherapeut', 'p'].includes(f)) return 'Physiotherapist'
  if (['medic', 'doctor', 'arzt', 'sanitaeter', 'sanitater', 'm'].includes(f)) return 'Medic'
  return ''
}

/**
 * @param {Array<Array<string|number|null>>} rows the sheet's cells
 * @returns {{ ok: boolean, error?: string, teams: Array<{ name: string, players: object[], bench: object[] }>, warnings: string[] }}
 */
export function parseRosters(rows, { date1904 = false } = {}) {
  const head = findHeader(rows || [], ROSTER_COLUMNS, 3)
  if (!head || head.cols.last === undefined) return { ok: false, error: 'columns', teams: [], warnings: [] }
  const { cols } = head
  const teams = new Map()
  const warnings = []
  let seen = 0
  for (let r = head.index + 1; r < rows.length && seen < MAX_ROWS; r++) {
    const row = rows[r] || []
    const get = (f) => (cols[f] === undefined ? '' : row[cols[f]])
    const last = text(get('last')); const first = text(get('first'))
    if (!last && !first) continue
    seen++
    const teamName = text(get('team')) || ''
    if (!teams.has(teamName)) teams.set(teamName, { name: teamName, players: [], bench: [] })
    const team = teams.get(teamName)
    const role = text(get('role'))
    const roleFold = fold(role)
    const benchRole = role && !['player', 'spieler', 'spielerin', 'libero', 'captain', 'kapitan', 'kapitaen', 'c', 'l'].includes(roleFold) ? BENCH_ROLE(role) : ''
    if (benchRole) {
      team.bench.push({ role: benchRole, firstName: first, lastName: last, dob: toDisplayDob(get('dob'), date1904) })
      continue
    }
    if (role && !benchRole && !['player', 'spieler', 'spielerin', 'libero', 'captain', 'kapitan', 'kapitaen', 'c', 'l'].includes(roleFold)) {
      warnings.push(`row ${r + 1}: role "${role}"`)
    }
    const rawNumber = get('number')
    const number = rawNumber === '' || rawNumber == null ? null : Number(rawNumber)
    if (number !== null && (!Number.isInteger(number) || number < 0 || number > 99)) {
      warnings.push(`row ${r + 1}: number "${rawNumber}"`)
    }
    team.players.push({
      number: Number.isInteger(number) && number >= 0 && number <= 99 ? number : null,
      firstName: first,
      lastName: last,
      dob: toDisplayDob(get('dob'), date1904),
      libero: roleFold === 'libero' || roleFold === 'l' ? 'libero1' : '',
      isCaptain: roleFold === 'captain' || roleFold === 'kapitan' || roleFold === 'kapitaen' || roleFold === 'c',
      isLfp: false
    })
  }
  const list = [...teams.values()]
  if (!list.length) return { ok: false, error: 'empty', teams: [], warnings }
  // a second libero in a team becomes libero2, a third is dropped to a player
  for (const t of list) {
    let n = 0
    for (const p of t.players) if (p.libero) { n++; p.libero = n === 1 ? 'libero1' : n === 2 ? 'libero2' : '' }
  }
  return { ok: true, teams: list, warnings }
}

const splitName = (full) => {
  const s = text(full)
  if (!s) return { first: '', last: '' }
  if (s.includes(',')) { const [l, f] = s.split(','); return { first: f.trim(), last: l.trim() } }
  const parts = s.split(/\s+/)
  return parts.length === 1 ? { first: '', last: parts[0] } : { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] }
}

/**
 * @returns {{ ok: boolean, error?: string, games: object[] }} games in the shape
 * MatchSetup's schedule picker applies: { gameN, date, time, hall, city,
 * league, home, away, bestOf, referee1First, referee1Last, referee2First, referee2Last }
 */
export function parseGames(rows, { date1904 = false } = {}) {
  const head = findHeader(rows || [], GAME_COLUMNS, 3)
  if (!head || head.cols.home === undefined || head.cols.away === undefined) return { ok: false, error: 'columns', games: [] }
  const { cols } = head
  const games = []
  for (let r = head.index + 1; r < rows.length && games.length < MAX_ROWS; r++) {
    const row = rows[r] || []
    const get = (f) => (cols[f] === undefined ? '' : row[cols[f]])
    const home = text(get('home')); const away = text(get('away'))
    if (!home && !away) continue
    const bo = Number(String(get('bestOf')).match(/[35]/)?.[0])
    const r1 = splitName(get('ref1')); const r2 = splitName(get('ref2'))
    games.push({
      gameN: text(get('gameN')),
      date: toIsoDate(get('date'), date1904),
      time: toTime(get('time')),
      hall: text(get('hall')),
      city: text(get('city')),
      league: text(get('league')),
      home,
      away,
      bestOf: bo === 3 || bo === 5 ? bo : null,
      referee1First: r1.first, referee1Last: r1.last,
      referee2First: r2.first, referee2Last: r2.last
    })
  }
  return games.length ? { ok: true, games } : { ok: false, error: 'empty', games: [] }
}

export const rosterTemplate = () => ({
  name: 'Rosters',
  rows: [
    ['Team', 'Number', 'First name', 'Last name', 'Role', 'Date of birth'],
    ['Team A', 1, 'Anna', 'Example', 'Captain', '14.03.2008'],
    ['Team A', 7, 'Berta', 'Example', 'Libero', ''],
    ['Team A', 9, 'Clara', 'Example', 'Player', ''],
    ['Team A', '', 'Chris', 'Coach', 'Coach', ''],
    ['Team B', 3, 'Dora', 'Example', 'Player', '']
  ],
  widths: [18, 9, 16, 18, 16, 16]
})

export const gamesTemplate = () => ({
  name: 'Games',
  rows: [
    ['Game', 'Date', 'Time', 'Hall', 'City', 'League', 'Home', 'Away', 'Best of', '1st referee', '2nd referee'],
    [1, '14.11.2026', '09:00', 'Court 1', 'Munich', 'U16 girls', 'Team A', 'Team B', 3, 'Max Muster', 'Eva Beispiel']
  ],
  widths: [8, 12, 8, 12, 14, 14, 18, 18, 9, 18, 18]
})
