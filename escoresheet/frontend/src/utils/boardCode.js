/**
 * What the scoreboard page (/board, components/board/BoardApp) follows: a
 * scoreboard code (docs/scoreboard-code-spec.md §2) or a league game number.
 *
 * Kept apart from utils/boardFeed so the livescore entry can read (and clean)
 * the address before the board's lazy chunk loads: a code given as `?code=`
 * leaves the address at once and moves to the fragment, which never reaches
 * a server, its logs or a later request's Referer.
 *
 *   /board#ABCD2345          a code (also #ABCD-2345, #code=ABCD-2345)
 *   /board#12345             a game number (also #game=12345)
 *   /board?code=ABCD-2345    moved to #ABCD2345 by takeBoardTargetFromUrl
 *
 * Pure apart from takeBoardTargetFromUrl / setBoardTargetInUrl (window).
 */

/** The relay's code alphabet: 32 symbols, no 0/O/1/I (electron/displayCodeCore.cjs). */
export const BOARD_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const BOARD_CODE_LEN = 8
const GAME_NUMBER = /^[0-9]{1,7}$/

/**
 * A code as the relay compares it (upper case, spaces and dashes removed), or
 * null when it is not 8 symbols of the alphabet.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeBoardCode(value) {
  if (typeof value !== 'string' || value.length > 32) return null
  const s = value.toUpperCase().replace(/[\s-]/g, '')
  if (s.length !== BOARD_CODE_LEN) return null
  for (const ch of s) if (!BOARD_CODE_ALPHABET.includes(ch)) return null
  return s
}

/** ABCD2345 -> ABCD-2345 (what people read and type). */
export function formatBoardCode(code) {
  const c = normalizeBoardCode(code)
  return c ? `${c.slice(0, 4)}-${c.slice(4)}` : ''
}

/**
 * What a typed or linked value names: { kind: 'game', game } for 1–7 digits,
 * { kind: 'code', code } for a scoreboard code, else null.
 * @param {unknown} value
 * @returns {{ kind: 'code', code: string } | { kind: 'game', game: string } | null}
 */
export function parseBoardTarget(value) {
  if (typeof value !== 'string') return null
  let s = value.trim()
  try { s = decodeURIComponent(s) } catch { /* keep it as typed */ }
  s = s.trim().replace(/^#/, '')
  const kv = /^(code|game)=(.*)$/i.exec(s)
  if (kv) s = kv[2]
  const compact = s.replace(/[\s-]/g, '')
  if (GAME_NUMBER.test(compact)) {
    // Leading zeros name the same game ("0123" is game 123)
    return { kind: 'game', game: String(Number(compact)) }
  }
  const code = normalizeBoardCode(s)
  return code ? { kind: 'code', code } : null
}

/** The fragment of a target: '#ABCD2345' or '#12345' ('' for none). */
export function boardTargetHash(target) {
  if (target?.kind === 'code' && normalizeBoardCode(target.code)) return `#${normalizeBoardCode(target.code)}`
  if (target?.kind === 'game' && GAME_NUMBER.test(String(target.game))) return `#${target.game}`
  return ''
}

/** Is this path the board page? /board, /livescore/board, /x/board/ */
export function isBoardPath(pathname) {
  return /(^|\/)board\/?$/.test(String(pathname || ''))
}

/**
 * The target named by an address (the fragment first, then ?code=). A
 * `?code=` (and `?game=`) is removed from the address with
 * history.replaceState and the target put in the fragment instead.
 * @param {{ location?: Location, history?: History }} [env]
 */
export function takeBoardTargetFromUrl({
  location = typeof window !== 'undefined' ? window.location : null,
  history = typeof window !== 'undefined' ? window.history : null
} = {}) {
  if (!location) return null
  const fromHash = parseBoardTarget(location.hash || '')
  let params
  try { params = new URLSearchParams(location.search || '') } catch { params = null }
  const queried = params && (params.has('code') || params.has('game'))
  const fromQuery = queried ? parseBoardTarget(params.get('code') || params.get('game') || '') : null
  const target = fromHash || fromQuery
  if (queried && history?.replaceState) {
    params.delete('code')
    params.delete('game')
    const search = params.toString()
    const hash = target ? boardTargetHash(target) : (location.hash || '')
    try { history.replaceState(history.state ?? null, '', `${location.pathname}${search ? `?${search}` : ''}${hash}`) } catch { /* the address stays */ }
  }
  return target
}

/**
 * Put a target in the address (or clear it: null), without a reload.
 * @param {object|null} target
 */
export function setBoardTargetInUrl(target, {
  location = typeof window !== 'undefined' ? window.location : null,
  history = typeof window !== 'undefined' ? window.history : null
} = {}) {
  if (!location || !history?.replaceState) return
  const url = `${location.pathname}${location.search || ''}${boardTargetHash(target)}`
  try { history.replaceState(history.state ?? null, '', url) } catch { /* the address stays */ }
}
