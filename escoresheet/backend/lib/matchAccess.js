/**
 * Match access after the PIN step (referee, bench, scorer).
 *
 * Before a PIN is proved, the relay and GET /api/match/:id hand out a public
 * summary only (lib/publicColumns.js relaySummaryBundle). Two ways to prove it:
 *
 *   PIN        subscribe-match { matchId, pin } on the relay socket, or the
 *              X-OV-Match-Pin header on GET /api/match/:id. Checked against the
 *              PINs the scoreboard synced to the relay (pinGrantsAccess). Works
 *              the same on every relay (LAN ones included: no setup).
 *   token      what the backend's PIN checks (validate-pin, validate-connection-pin)
 *              answer with: a short-lived HMAC capability for one match,
 *              `v1.<base64url payload>.<base64url sig>`, payload { m: room key /
 *              external_id, r: role, u?: matches.id, exp }. Sent as
 *              subscribe-match { token }, X-OV-Match-Token on GET /api/match/:id
 *              and on anonymous /api/db reads (the referee/bench fallback when
 *              the relay has no copy: rosters of that match only).
 *
 * The token secret is OV_MATCH_TOKEN_SECRET, else random per process (tokens
 * then end with a restart; the apps re-check their stored PIN on reload).
 * Pure module: node:crypto only, safe in the LAN / SEA bundle.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const MATCH_TOKEN_TTL_MS = 12 * 60 * 60 * 1000
const TOKEN_RE = /^v1\.([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/

function safeEqual (a, b) {
  const x = Buffer.from(String(a), 'utf8')
  const y = Buffer.from(String(b), 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * @param {{ secret?: string|null, ttlMs?: number, now?: () => number }} [options]
 */
export function createMatchTokens ({ secret = null, ttlMs = MATCH_TOKEN_TTL_MS, now = Date.now } = {}) {
  const key = secret && String(secret).length >= 32 ? String(secret) : randomBytes(32).toString('base64url')
  const sign = (body) => createHmac('sha256', key).update(`ov-match-access:${body}`, 'utf8').digest('base64url')

  /** A token for one match key (room key = external_id). */
  function issue ({ matchKey, role = 'viewer', matchUuid = null }) {
    if (typeof matchKey !== 'string' || !matchKey) return null
    const payload = { m: matchKey, r: String(role).slice(0, 20), exp: now() + ttlMs }
    if (typeof matchUuid === 'string' && matchUuid) payload.u = matchUuid
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return `v1.${body}.${sign(body)}`
  }

  /** The payload of a valid, unexpired token, else null. Never throws. */
  function verify (token) {
    if (typeof token !== 'string') return null
    const m = TOKEN_RE.exec(token.trim())
    if (!m) return null
    if (!safeEqual(sign(m[1]), m[2])) return null
    try {
      const p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'))
      if (!p || typeof p.m !== 'string' || !Number.isFinite(p.exp) || p.exp <= now()) return null
      return p
    } catch {
      return null
    }
  }

  /** Does the token grant `matchKey`? */
  function grants (token, matchKey) {
    const p = verify(token)
    return !!p && matchKey != null && p.m === String(matchKey)
  }

  return { issue, verify, grants, ttlMs }
}

const pinText = (v) => (v === undefined || v === null ? '' : String(v).trim())

/**
 * Does `pin` prove access to a relayed match (the scorer's Dexie match object)?
 * Accepted: the referee PIN while the referee connection is on, a team's bench
 * PIN while that bench connection is on, and the game PIN (the scorer's own
 * devices). Constant-time compares. A match without any of these PINs grants
 * nothing (there is no PIN step to have passed).
 */
export function pinGrantsAccess (match, pin) {
  const p = pinText(pin)
  if (!p || !match || typeof match !== 'object') return false
  const candidates = []
  if (match.refereeConnectionEnabled === true) candidates.push(match.refereePin)
  if (match.homeTeamConnectionEnabled === true) candidates.push(match.homeTeamPin)
  if (match.awayTeamConnectionEnabled === true) candidates.push(match.awayTeamPin)
  candidates.push(match.gamePin != null && match.gamePin !== '' ? match.gamePin : match.game_pin)
  let ok = false
  for (const c of candidates) {
    const s = pinText(c)
    if (s && safeEqual(s, p)) ok = true
  }
  return ok
}
