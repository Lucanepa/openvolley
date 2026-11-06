/**
 * OpenVolley on a Point Hub board's own screen. pointhub-screen starts the
 * desktop app with OPENVOLLEY_POINTHUB_BOARD, and the app sets the flag before
 * the page loads (src-tauri/src/main.rs).
 *
 * The board fetches tonight's match info and home roster from wiedisync, and
 * answers only its own screen (loopback, /api/scoresheet/* in point-hub's
 * controlServer.js). Birthdates stay behind the board's rules: a scorer PIN set
 * on the board, home games only, kickoff -6 h to +3 h.
 */
import { isoDobToDisplay } from '../domain/officials'

const BOARD = 'http://127.0.0.1:8890'

export const onPointHubBoard = () => typeof window !== 'undefined' && window.__OV_POINTHUB_BOARD__ === true

async function ask(path, init) {
  const res = await fetch(`${BOARD}/api/scoresheet/${path}`, init)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** Today's KSCW home games: { ok, date, games, error? } */
export const boardGames = () => ask('games')

/** One game's sheet: { ok, info, roster: { ok, players, officials } | { ok: false, error } } */
export const boardGameSheet = (gameId) => ask('sheet', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ gameId })
})

/** The board's game info as a schedule pick (MatchSetup handleOfficialMatchSelect). */
export function sheetToMatchData(info = {}) {
  const [ref1 = '', ref2 = ''] = Array.isArray(info.referees) ? info.referees : []
  return {
    date: info.date || '',
    time: String(info.time || '').slice(0, 5),
    city: '',
    hall: info.hall || '',
    type1: 'championship',
    championshipType: 'regional',
    gameN: info.number != null ? String(info.number) : '',
    league: info.league || '',
    home: info.home || '',
    away: info.away || '',
    // The schedule has one name per referee, not first and last
    referee1Last: ref1,
    referee2Last: ref2
  }
}

/** The sheet's players as MatchSetup's roster rows. wiedisync sends the first initial only. */
export function sheetToRoster(players = []) {
  let liberos = 0
  return players.map((p) => ({
    number: p.number ?? null,
    firstName: p.initial || '',
    lastName: p.lastName || '',
    dob: p.birthdate ? isoDobToDisplay(p.birthdate) : '',
    libero: p.libero && liberos < 2 ? `libero${++liberos}` : '',
    isCaptain: p.captain === true,
    isLfp: false
  }))
}

const BENCH_ROLE = {
  coach: 'Coach',
  assistant_coach_1: 'Assistant Coach 1',
  assistant_coach_2: 'Assistant Coach 2',
  physio: 'Physiotherapist',
  doctor: 'Medic'
}

/** The sheet's officials as MatchSetup's bench rows; always a coach row, as a new match has. */
export function sheetToBench(officials = []) {
  const bench = officials
    .filter((o) => BENCH_ROLE[o.role])
    .map((o) => ({
      role: BENCH_ROLE[o.role],
      firstName: o.initial || '',
      lastName: o.lastName || '',
      dob: o.birthdate ? isoDobToDisplay(o.birthdate) : ''
    }))
  return bench.some((b) => b.role === 'Coach') ? bench : [{ role: 'Coach', firstName: '', lastName: '', dob: '' }, ...bench]
}
