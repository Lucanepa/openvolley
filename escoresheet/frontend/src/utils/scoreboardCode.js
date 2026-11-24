/**
 * The scorer's scoreboard code (docs/scoreboard-code-spec.md): "Show on a
 * scoreboard" in the Match menu. The scoring device makes a short read-only
 * code for the match, keeps it with the match in its own database
 * (db.scoreboard_codes, keyed by the match id; it never travels in the
 * match's sync, backups or exports) and tells its relay on the scorer socket
 * (display-code-set). Any scoreboard then finds the match by it, on any
 * network, and follows its public live state.
 *
 *   - The relay is told again on every scorer socket's first accepted sync
 *     (the relay's display-presence answer comes right after it), so the code
 *     survives an app restart and a relay restart.
 *   - "New code" replaces it (the boards that followed the old one stop);
 *     "Stop sharing" revokes it; the match closed (approved / final) or gone
 *     from the device revokes it too (ScoreboardCodeHost checks).
 *   - It runs out MAX_LIFE_MS after it was made, here and on the relay.
 *
 * The code is never logged, never sent anywhere but the relay socket and
 * the QR link's fragment (which no server sees).
 */
import { scorerRelay } from './relayPublisher'
import { getBackendOverride, getLocalServerStatusUrl, isLanBackendUrl, isLocalRelayUrl } from './backendConfig'
import { LIVESCORE_SITE } from './globalLive'

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 symbols, no 0/O/1/I
export const CODE_LEN = 8 // 40 bits
export const MAX_LIFE_MS = 12 * 60 * 60 * 1000 // the relays' displayCodeCore MAX_LIFE_MS

/** 8 symbols of CODE_ALPHABET from 5 random bytes (as electron/displayCodeCore.cjs codeFromBytes). */
export function codeFromBytes(bytes) {
  let bits = 0
  let acc = 0
  let out = ''
  for (let i = 0; i < 5; i++) {
    acc = (acc << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CODE_ALPHABET[(acc >> bits) & 31]
    }
    acc &= (1 << bits) - 1
  }
  return out
}

/** A new code from the device's CSPRNG. */
export function newScoreboardCode(random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  return codeFromBytes(random(5))
}

/** ABCD2345 -> ABCD-2345. */
export function displayScoreboardCode(code) {
  const c = String(code || '')
  return c.length === CODE_LEN ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

/**
 * The board page for a code: the cloud's livescore site, or the venue relay's
 * own /livescore/board when the scorer scores on a relay of the hall (the
 * relay's LAN address, which a TV on the hall Wi-Fi can open). The code goes
 * in the fragment: a server never sees it.
 * @param {string} code
 * @param {{ relayUrl?: string|null, relayStatus?: object|null }} [where]
 */
export function boardPageUrl(code, { relayUrl = scorerRelay.url, relayStatus = null } = {}) {
  const hash = `#${code}`
  if (relayUrl && isLocalRelayUrl(relayUrl)) {
    const s = relayStatus && typeof relayStatus === 'object' ? relayStatus : null
    const base = s?.urls?.livescoreIP || (s?.localIP && s?.port ? `${s.protocol || 'http'}://${s.localIP}:${s.port}/livescore` : null)
    if (base) return `${String(base).replace(/\/+$/, '')}/board${hash}`
    try {
      const u = new URL(relayUrl)
      if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return `http://${u.host.replace(/:\d+$/, '')}/livescore/board${hash}`
    } catch { /* no URL */ }
    return null
  }
  return `${LIVESCORE_SITE}board${hash}`
}

/** Where a LAN relay says its pages are (/api/server/status), or null. */
export function relayStatusUrl() {
  const override = getBackendOverride()
  if (override && isLanBackendUrl(override)) return `${String(override).replace(/\/+$/, '')}/api/server/status`
  return getLocalServerStatusUrl()
}

const STATE_REASONS = new Set(['expired', 'taken', 'bad-code', 'busy', 'rate-limited', 'revoked'])

/**
 * The codes of this device, one per match: { matchId, relayKey, code, issuedAt }
 * in db.scoreboard_codes; the relay's answer per match in memory.
 *
 * state(matchId): { code, issuedAt, endsAt, relayKey, relay: 'waiting'|'active'|'refused'|'offline', reason, following }
 *
 * @param {{ relay?: typeof scorerRelay, table?: () => any, now?: () => number, random?: (n: number) => Uint8Array }} [opts]
 */
export function createScoreboardCodes({
  relay = scorerRelay,
  table = null,
  now = () => Date.now(),
  random = undefined
} = {}) {
  const states = new Map() // matchId -> state
  const watchers = new Set()
  let tablePromise = null
  const getTable = async () => {
    if (table) return table()
    tablePromise ??= import('../db/db').then((m) => m.db.scoreboard_codes)
    return tablePromise
  }
  const emit = () => { for (const fn of [...watchers]) { try { fn() } catch { /* a watcher's own trouble */ } } }
  const set = (matchId, patch) => {
    const prev = states.get(matchId) || null
    const next = patch === null ? null : { ...(prev || {}), ...patch }
    if (next === null) states.delete(matchId)
    else states.set(matchId, next)
    emit()
    return next
  }
  const isLive = (row) => !!row && typeof row.code === 'string' && Number.isFinite(row.issuedAt) && now() - row.issuedAt < MAX_LIFE_MS
  const byRelayKey = (key) => [...states.entries()].find(([, s]) => s.relayKey === key)

  /** Tell the relay (on the open scorer socket) this match's code, or its revoke. */
  function tell(relayKey, code, issuedAt) {
    if (!relayKey) return false
    return relay.send(code ? { type: 'display-code-set', matchId: relayKey, code, issuedAt } : { type: 'display-code-set', matchId: relayKey, code: null })
  }

  async function save(row) {
    const t = await getTable()
    await t.put(row)
  }

  /**
   * The match's code: the stored one when it is still live, else a new one.
   * Told to the relay when the scorer socket is open.
   * @param {{ matchId: number|string, relayKey: string|null }} match
   */
  async function ensure({ matchId, relayKey }) {
    if (matchId == null) return null
    const t = await getTable()
    let row = await t.get(matchId)
    if (row && relayKey && row.relayKey !== relayKey) row = { ...row, relayKey }
    if (!isLive(row)) row = { matchId, relayKey: relayKey || null, code: newScoreboardCode(random), issuedAt: now() }
    await t.put(row)
    const known = states.get(matchId)
    const sameCode = known && known.code === row.code
    set(matchId, {
      code: row.code,
      issuedAt: row.issuedAt,
      endsAt: row.issuedAt + MAX_LIFE_MS,
      relayKey: row.relayKey,
      relay: sameCode && known.relay === 'active' ? 'active' : (relay.isOpen() ? 'waiting' : 'offline'),
      reason: sameCode ? known.reason || null : null,
      following: known?.following || false
    })
    if (!(sameCode && known.relay === 'active')) tell(row.relayKey, row.code, row.issuedAt)
    return states.get(matchId)
  }

  /** "New code": the old one ends on the relay (its boards stop). */
  async function renew({ matchId, relayKey }) {
    const row = { matchId, relayKey: relayKey || states.get(matchId)?.relayKey || null, code: newScoreboardCode(random), issuedAt: now() }
    await save(row)
    set(matchId, { code: row.code, issuedAt: row.issuedAt, endsAt: row.issuedAt + MAX_LIFE_MS, relayKey: row.relayKey, relay: relay.isOpen() ? 'waiting' : 'offline', reason: null })
    tell(row.relayKey, row.code, row.issuedAt)
    return states.get(matchId)
  }

  /** "Stop sharing", the match closed or gone: revoke on the relay, forget here. */
  async function stop({ matchId, relayKey = null }) {
    const known = states.get(matchId)
    const t = await getTable()
    const row = await t.get(matchId).catch(() => null)
    const key = relayKey || known?.relayKey || row?.relayKey || null
    await t.delete(matchId)
    tell(key, null)
    set(matchId, null)
  }

  /** The stored codes (ScoreboardCodeHost checks their matches). */
  async function stored() {
    const t = await getTable()
    return t.toArray()
  }

  // The relay's answers. display-presence comes right after a scorer socket's
  // first accepted sync of the room: the moment to (re)tell the room's code.
  relay.listen((message) => {
    if (!message || typeof message !== 'object' || message.matchId == null) return
    const key = String(message.matchId)
    if (message.type === 'display-presence') {
      const hit = byRelayKey(key)
      if (hit) set(hit[0], { following: message.present === true })
      void (async () => {
        let row = null
        try {
          const t = await getTable()
          row = await t.where('relayKey').equals(key).first()
        } catch { row = null }
        if (!isLive(row)) return
        if (!states.has(row.matchId)) {
          set(row.matchId, { code: row.code, issuedAt: row.issuedAt, endsAt: row.issuedAt + MAX_LIFE_MS, relayKey: key, relay: 'waiting', reason: null, following: message.present === true })
        }
        tell(key, row.code, row.issuedAt)
      })()
      return
    }
    if (message.type === 'display-code-state') {
      const hit = byRelayKey(key)
      if (!hit) return
      const [matchId, s] = hit
      if (message.active === true) {
        set(matchId, { relay: 'active', reason: null, endsAt: Number.isFinite(message.endsAt) ? message.endsAt : s.endsAt })
        return
      }
      const reason = STATE_REASONS.has(message.reason) ? message.reason : (message.reason === 'not-match-owner' ? null : 'refused')
      // not the room's scorer socket yet (its first sync not answered): told again on display-presence
      if (reason === null) return
      // our own revoke, answered
      if (reason === 'revoked') return
      // another room has this code (40 bits: once in a lifetime): a new one at once
      if (reason === 'taken' && !s.renewedForTaken) {
        set(matchId, { renewedForTaken: true })
        void renew({ matchId, relayKey: key })
        return
      }
      set(matchId, { relay: 'refused', reason })
    }
  })

  return {
    ensure,
    renew,
    stop,
    stored,
    get: (matchId) => (matchId == null ? null : states.get(matchId) || null),
    subscribe(fn) {
      watchers.add(fn)
      return () => watchers.delete(fn)
    }
  }
}

export const scoreboardCodes = createScoreboardCodes()
