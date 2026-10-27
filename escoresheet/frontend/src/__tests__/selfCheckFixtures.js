// What AppSelfCheck and AppOpenAndResume share: an official match as the
// owner's PC had it (match 406970 on its third set), a session on this
// device, and the server, answered through fetch (/api/db for the rows of
// matches, /api/match/scorer for the scoring device, /api/match/restore-by-pin
// for the server's copy). Every other request fails as offline.
import { vi } from 'vitest'
import { db } from '../db/db'

export const SEED = 'match_1792518507614_u2sbmb'
export const MIN = 60 * 1000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
export const ago = (ms) => new Date(Date.now() - ms).toISOString()

// The sessionStorage marker of the match screen on show (utils/deviceSelfCheck
// OPEN_MATCH_KEY): written by hand, it is the page a reload left behind
export const OPEN_MATCH_KEY = 'ov.openMatch'
export const reloadInto = (id, view = 'scoreboard') => sessionStorage.setItem(OPEN_MATCH_KEY, JSON.stringify({ id, view }))

// An official match on its third set (25:20, 20:25, 12:10), last scored `at`
export async function seedMatch({ at = ago(HOUR), created = at, names = ['Home', 'Away'], shorts = ['HOM', 'AWA'], ...fields } = {}) {
  const home = await db.teams.add({ name: names[0], shortName: shorts[0] })
  const away = await db.teams.add({ name: names[1], shortName: shorts[1] })
  await db.players.bulkAdd([1, 2, 3, 4, 5, 6, 7].flatMap(n => [
    { teamId: home, number: n, firstName: 'H', lastName: `Home${n}`, isCaptain: n === 1 },
    { teamId: away, number: n, firstName: 'A', lastName: `Away${n}`, isCaptain: n === 1 }
  ]))
  const matchId = await db.matches.add({
    homeTeamId: home, awayTeamId: away, status: 'live', createdAt: created, matchInfoConfirmedAt: created,
    seed_key: SEED, gameN: 406970, gamePin: '482915',
    firstServe: 'home', coinTossTeamA: 'home', coinTossTeamB: 'away', coinTossServeA: true, coinTossServeB: false,
    homeCoachSignature: 'x', homeCaptainSignature: 'x', awayCoachSignature: 'x', awayCaptainSignature: 'x',
    ...fields
  })
  await db.sets.bulkAdd([
    { matchId, index: 1, homePoints: 25, awayPoints: 20, finished: true, startTime: created, endTime: created },
    { matchId, index: 2, homePoints: 20, awayPoints: 25, finished: true, startTime: created, endTime: created },
    { matchId, index: 3, homePoints: 12, awayPoints: 10, finished: false, startTime: created }
  ])
  await db.events.add({ matchId, setIndex: 1, type: 'coin_toss', payload: {}, seq: 1, ts: at })
  return matchId
}

// A session on this device (the self-check reads the server only signed in)
export function signIn() {
  localStorage.setItem('api_auth_token', JSON.stringify({
    access_token: 'token-test', expires_at: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    user: { id: '00000000-0000-4000-8000-0000000000aa' }
  }))
}

export const jsonResponse = (body, status = 200) => ({
  ok: status < 400, status, headers: { get: (h) => (/content-type/i.test(h) ? 'application/json' : null) }, json: async () => body
})
const bodyOf = (init) => {
  try { return JSON.parse(init?.body || 'null') } catch { return null }
}
// The self-check's read: the matches of these external ids, in one request
const isRowsRead = (body) => body?.table === 'matches' && body?.action === 'select' &&
  (body.params?.filters || []).some(f => f.type === 'in' && f.column === 'external_id')
export const rowsReads = () => globalThis.fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/api/db') && isRowsRead(bodyOf(init)))
export const callsTo = (path) => globalThis.fetch.mock.calls.filter(([url]) => String(url).endsWith(path)).map(([, init]) => bodyOf(init))

/**
 * The server: answer(keys, n) -> rows | { status, body } | an Error (network)
 * | a promise. scorer: the body of /api/match/scorer's data (a function of
 * the request body too). restore: /api/match/restore-by-pin's data, a
 * function of the request body.
 */
export function answerServer(answer, { scorer = { mine: true }, restore = null } = {}) {
  let n = 0
  globalThis.fetch.mockImplementation(async (url, init) => {
    const body = bodyOf(init)
    const path = String(url)
    if (path.endsWith('/api/db') && isRowsRead(body)) {
      const out = await answer(body.params.filters.find(f => f.type === 'in').value, ++n)
      if (out instanceof Error) throw out
      if (out && !Array.isArray(out) && out.status) return jsonResponse(out.body, out.status)
      return jsonResponse({ data: out })
    }
    if (path.endsWith('/api/match/scorer') && scorer) {
      return jsonResponse({ data: typeof scorer === 'function' ? scorer(body) : scorer })
    }
    if (path.endsWith('/api/match/restore-by-pin') && restore) {
      return jsonResponse({ data: restore(body) })
    }
    throw new TypeError('offline (test)')
  })
}

export const closedRow = { id: 'c0ffee00-0000-4000-8000-000000000001', external_id: SEED, status: 'final', closed_at: '2026-10-20T18:40:00.000Z' }
export const openRow = { ...closedRow, status: 'live', closed_at: null }

export function offlineDevice() {
  return vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
}

/**
 * The page hidden and shown again, on a clock of its own: hide(), then
 * advance(ms), then show(). Date.now runs on with the offset.
 */
export function backgroundClock() {
  let visibility = 'visible'
  const state = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => visibility === 'hidden')
  const realNow = Date.now.bind(Date)
  let offset = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset)
  const set = (v) => {
    visibility = v
    document.dispatchEvent(new Event('visibilitychange'))
  }
  return {
    hide: () => set('hidden'),
    show: () => set('visible'),
    advance: (ms) => { offset += ms },
    restore: () => { clock.mockRestore(); hiddenSpy.mockRestore(); state.mockRestore() }
  }
}
