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
 * A token is bound to the role it was issued for (referee, home / away bench)
 * and carries a fingerprint of that role's PIN: it grants a match only while
 * the role's connection is on and (on the relay, which holds the PINs) the PIN
 * is unchanged (stillGrants / stillGrantsRow). A device the scorer disconnects
 * or whose PIN is regenerated loses access at once, not when the token expires.
 *
 * The token secret is OV_MATCH_TOKEN_SECRET (at least 32 characters, else
 * matchTokenSecretFromEnv throws), else one derived from OV_PIN_SECRET, else
 * random per process (tokens then end with a restart; the apps re-check their
 * stored PIN on reload).
 * Pure module: node:crypto only, safe in the LAN / SEA bundle.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const pinText = (v) => (v === undefined || v === null ? '' : String(v).trim())

export const MATCH_TOKEN_TTL_MS = 6 * 60 * 60 * 1000
export const MIN_TOKEN_SECRET_LENGTH = 32

/**
 * Token roles -> the relay match fields (scorer's Dexie match) and the
 * matches.connections flag that keep the role's access alive.
 * validate-connection-pin issues referee / bench_home / bench_away,
 * the relay's /api/match/validate-pin referee / homeTeam / awayTeam.
 */
const TOKEN_ROLES = Object.freeze({
  referee: Object.freeze({ enabled: 'refereeConnectionEnabled', pin: 'refereePin', dbEnabled: 'referee_enabled' }),
  bench_home: Object.freeze({ enabled: 'homeTeamConnectionEnabled', pin: 'homeTeamPin', dbEnabled: 'home_bench_enabled' }),
  bench_away: Object.freeze({ enabled: 'awayTeamConnectionEnabled', pin: 'awayTeamPin', dbEnabled: 'away_bench_enabled' }),
  homeTeam: Object.freeze({ enabled: 'homeTeamConnectionEnabled', pin: 'homeTeamPin', dbEnabled: 'home_bench_enabled' }),
  awayTeam: Object.freeze({ enabled: 'awayTeamConnectionEnabled', pin: 'awayTeamPin', dbEnabled: 'away_bench_enabled' })
})
/** May a token be issued for this role (PIN check type)? Upload PINs get none. */
export const isTokenRole = (role) => typeof role === 'string' && Object.prototype.hasOwnProperty.call(TOKEN_ROLES, role)

/**
 * The match token secret of this environment: OV_MATCH_TOKEN_SECRET, else one
 * derived from OV_PIN_SECRET (tokens then survive restarts with no extra
 * setting), else null (random per process). Throws on a set but too short
 * OV_MATCH_TOKEN_SECRET, like OV_PIN_SECRET does.
 */
export function matchTokenSecretFromEnv (env = process.env) {
  const own = env.OV_MATCH_TOKEN_SECRET ? String(env.OV_MATCH_TOKEN_SECRET) : ''
  if (own) {
    if (own.length < MIN_TOKEN_SECRET_LENGTH) throw new TypeError(`OV_MATCH_TOKEN_SECRET must be at least ${MIN_TOKEN_SECRET_LENGTH} characters`)
    return own
  }
  const pinSecret = env.OV_PIN_SECRET ? String(env.OV_PIN_SECRET) : ''
  if (pinSecret.length >= MIN_TOKEN_SECRET_LENGTH) return createHmac('sha256', pinSecret).update('ov-match-token-secret:v1', 'utf8').digest('base64url')
  return null
}
const TOKEN_RE = /^v1\.([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/

function safeEqual (a, b) {
  const x = Buffer.from(String(a), 'utf8')
  const y = Buffer.from(String(b), 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * @param {{ secret?: string|null, ttlMs?: number, now?: () => number }} [options]
 *        secret: at least 32 characters (a shorter one throws); none = random per process
 */
export function createMatchTokens ({ secret = null, ttlMs = MATCH_TOKEN_TTL_MS, now = Date.now } = {}) {
  if (secret && String(secret).length < MIN_TOKEN_SECRET_LENGTH) {
    throw new TypeError(`match token secret must be at least ${MIN_TOKEN_SECRET_LENGTH} characters`)
  }
  const key = secret ? String(secret) : randomBytes(32).toString('base64url')
  const sign = (body) => createHmac('sha256', key).update(`ov-match-access:${body}`, 'utf8').digest('base64url')
  const fingerprint = (pin) => createHmac('sha256', key).update(`ov-match-pin-fp:${pinText(pin)}`, 'utf8').digest('base64url').slice(0, 22)

  /**
   * A token for one match key (room key = external_id), bound to `role`; with
   * `pin` (the PIN just proved) it carries that PIN's fingerprint.
   */
  function issue ({ matchKey, role = 'viewer', matchUuid = null, pin = null }) {
    if (typeof matchKey !== 'string' || !matchKey) return null
    const payload = { m: matchKey, r: String(role).slice(0, 20), exp: now() + ttlMs }
    if (typeof matchUuid === 'string' && matchUuid) payload.u = matchUuid
    if (pinText(pin)) payload.f = fingerprint(pin)
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return `v1.${body}.${sign(body)}`
  }

  /**
   * Does a verified token payload still grant the relayed match (the scorer's
   * Dexie match object)? Its role's connection must be on, and its PIN
   * fingerprint (if any) must match the role's current PIN.
   */
  function stillGrants (payload, match) {
    const role = payload && isTokenRole(payload.r) ? TOKEN_ROLES[payload.r] : null
    if (!role || !match || typeof match !== 'object') return false
    if (match[role.enabled] !== true) return false
    const current = pinText(match[role.pin])
    if (payload.f && current && !safeEqual(fingerprint(current), payload.f)) return false
    return true
  }

  /** The same for a matches row (its connections flags; the PINs there may be hashed). */
  function stillGrantsRow (payload, row) {
    const role = payload && isTokenRole(payload.r) ? TOKEN_ROLES[payload.r] : null
    const conns = row?.connections
    return !!role && !!conns && typeof conns === 'object' && conns[role.dbEnabled] === true
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

  return { issue, verify, grants, stillGrants, stillGrantsRow, ttlMs }
}

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
