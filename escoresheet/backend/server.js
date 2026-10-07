/**
 * Optional Backend Server for eScoresheet
 * Provides WebSocket relay for local network connections
 * This is OPTIONAL - the app works fully offline without this server
 *
 * Use cases:
 * 1. Local network: Scoreboard ↔ Referee/Bench sync (no internet needed)
 * 2. Cloud relay: Multiple locations (requires internet)
 *

 * Or run locally for local network only
 */

import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import nodemailer from 'nodemailer'
import ical from 'node-ical'
import { randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { isIP, BlockList } from 'net'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'
import QRCode from 'qrcode'
import PocketBase from 'pocketbase'
import { SECRET_COLUMNS, redactSecrets } from './lib/secrets.js'
// realtimeHub only needs `ws` and node core, so the LAN/SEA bundle can import it
// statically. It is only *instantiated* in DATABASE_URL mode.
import { createRealtimeHub, createLiveStateRelay, createHeartbeat, isLiveRequest, matchKeyFromSyncedMatch } from './lib/realtimeHub.js'
// What anonymous readers (live sockets, /api/db without a session) may see.
import { projectLiveRow, hasAnonPolicy, anonSelectCheck, publicRelayMatch, publicPeople, relaySummaryBundle, relayMatchListRow, cloudListsMatch, projectAnonDbRows, projectNonOwnerRows } from './lib/publicColumns.js'
// PIN-proved access to a relayed match (full bundle) and its capability tokens.
import { createMatchTokens, pinGrantsAccess, matchTokenSecretFromEnv, isTokenRole, connectionPinType } from './lib/matchAccess.js'
// Pure helpers only (no pg, no I/O at import): safe in the LAN / SEA build.
import { ipBucketKey, createConcurrencyGate, bearerFromHeaders } from './lib/auth.js'
import { createAttemptLimiter } from './lib/matchRestore.js'
import { newRequestId, formatDbRejection, createLogLimiter, createConnectionSummary } from './lib/opsLog.js'
import { renderLandingPage, INDOOR_ROLES, BEACH_ROLES } from './lib/landingPage.js'
import { createOriginPolicy, parsePublicOrigins } from './lib/cors.js'

const PORT = process.env.PORT || 8080

// --- Runtime mode -----------------------------------------------------------
// DATABASE_URL set (and no --local flag): the backend serves /api/db, auth,
// storage and realtime from its own Postgres + filesystem (self-hosted cloud).
// Otherwise it is the LAN / desktop relay exactly as before: no database, the
// data endpoints answer 503 and the relay is all there is.
const IS_LOCAL = !process.env.DATABASE_URL || process.argv.includes('--local')
const DATABASE_URL = IS_LOCAL ? null : process.env.DATABASE_URL
const DB_MODE = !!DATABASE_URL
// A DATABASE_URL deployment is a public cloud deployment (strict CORS, HSTS,
// no client IPs in /api/server/connections) even without IS_CLOUD.
const IS_CLOUD = !!process.env.IS_CLOUD || DB_MODE
// TRUST_PROXY=cloudflare: the origin is only reachable through Cloudflare, so
// cf-connecting-ip is the client address. Unset: the socket peer address.
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').trim().toLowerCase()
if (TRUST_PROXY && TRUST_PROXY !== 'cloudflare') {
  console.error(`[Config] TRUST_PROXY must be "cloudflare" or unset (got ${JSON.stringify(process.env.TRUST_PROXY)})`)
  process.exit(1)
}
// TRUST_PROXY_FROM (comma list of CIDRs): cf-connecting-ip is honored only when
// the socket peer (cloudflared / Traefik) is inside one of them, so a caller
// that reaches the origin port directly cannot forge its client address.
let TRUST_PROXY_FROM = null
try {
  TRUST_PROXY_FROM = parseCidrList(process.env.TRUST_PROXY_FROM)
} catch (err) {
  console.error(`[Config] TRUST_PROXY_FROM: ${err.message}`)
  process.exit(1)
}
if (TRUST_PROXY_FROM && TRUST_PROXY !== 'cloudflare') {
  console.error('[Config] TRUST_PROXY_FROM needs TRUST_PROXY=cloudflare')
  process.exit(1)
}
if (DB_MODE && !TRUST_PROXY) {
  console.warn('⚠️  [Config] DATABASE_URL is set but TRUST_PROXY is not: every per-IP limit keys on the socket peer. ' +
    'Behind cloudflared/Traefik that is the proxy, so all clients share ONE bucket. Set TRUST_PROXY=cloudflare (and TRUST_PROXY_FROM).')
} else if (TRUST_PROXY && !TRUST_PROXY_FROM) {
  console.warn('⚠️  [Config] TRUST_PROXY=cloudflare without TRUST_PROXY_FROM: cf-connecting-ip is trusted from ANY peer. ' +
    'The origin port must be reachable only through the tunnel/proxy.')
}
// Extra trusted browser origins (comma list), on top of *.openvolley.app.
const PUBLIC_ORIGINS = parsePublicOrigins(process.env.PUBLIC_ORIGINS)
// Object storage root (bind mount with a .ovdata sentinel). STORAGE_DIR is the
// older name used by lib/storage.js and its README; STORAGE_ROOT wins.
const STORAGE_ROOT = process.env.STORAGE_ROOT || process.env.STORAGE_DIR || '/data/storage'
// Read-only directory holding `last_backup` (UTC timestamp written by the host's backup job).
const STATUS_DIR = process.env.STATUS_DIR || '/var/lib/openvolley-status'
// A host backup older than this (or missing) makes /health 503 (backup:
// stale|unknown) and pauses the 30-day backup/ sweep, so rotation never deletes
// the only copies while the nightly snapshot is failing. 0 disables both (dev).
const BACKUP_MAX_AGE_HOURS = process.env.BACKUP_MAX_AGE_HOURS === undefined || process.env.BACKUP_MAX_AGE_HOURS === ''
  ? 36
  : Number(process.env.BACKUP_MAX_AGE_HOURS)
if (!Number.isFinite(BACKUP_MAX_AGE_HOURS) || BACKUP_MAX_AGE_HOURS < 0) {
  console.error(`[Config] BACKUP_MAX_AGE_HOURS must be a number >= 0 (got ${JSON.stringify(process.env.BACKUP_MAX_AGE_HOURS)})`)
  process.exit(1)
}
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'support@openvolley.app'
// Match access tokens (lib/matchAccess.js): answered by the PIN checks, accepted
// by the relay, GET /api/match/:id and anonymous /api/db reads. A too short
// OV_MATCH_TOKEN_SECRET stops the start (like OV_PIN_SECRET); unset, the
// secret is derived from OV_PIN_SECRET, else random per process.
let matchTokens
try {
  matchTokens = createMatchTokens({ secret: matchTokenSecretFromEnv(process.env) })
} catch (err) {
  console.error(`[Config] ${err.message}`)
  process.exit(1)
}
// X-OV-Proto this server requires for writes (pgQuery minWriteProto).
const MIN_WRITE_PROTO = 2

// --- PocketBase backup client (server-side only, parallel to Supabase) ---
const POCKETBASE_URL = process.env.POCKETBASE_URL
const POCKETBASE_ADMIN_EMAIL = process.env.POCKETBASE_ADMIN_EMAIL
const POCKETBASE_ADMIN_PASSWORD = process.env.POCKETBASE_ADMIN_PASSWORD

let pbClient = null
let pbReady = false

async function ensurePocketBaseCollection() {
  if (!pbReady || !pbClient) return
  try {
    await pbClient.collections.getOne('matches')
  } catch (err) {
    if (err.status === 404) {
      console.log('[PocketBase] Creating "matches" collection...')
      await pbClient.collections.create({
        name: 'matches',
        type: 'base',
        fields: [
          { name: 'match_id', type: 'text', required: true },
          { name: 'external_id', type: 'text' },
          { name: 'status', type: 'text' },
          { name: 'sport_type', type: 'text' },
          { name: 'game_number', type: 'number' },
          { name: 'match_data', type: 'json' },
          { name: 'home_team', type: 'json' },
          { name: 'away_team', type: 'json' },
          { name: 'home_players', type: 'json' },
          { name: 'away_players', type: 'json' },
          { name: 'sets', type: 'json' },
          { name: 'events', type: 'json' },
          { name: 'updated_at', type: 'text' }
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_match_id ON matches (match_id)'
        ]
      })
      console.log('[PocketBase] "matches" collection created successfully')
    } else {
      throw err
    }
  }
}

async function initPocketBase() {
  if (!POCKETBASE_URL || !POCKETBASE_ADMIN_EMAIL || !POCKETBASE_ADMIN_PASSWORD) return
  try {
    pbClient = new PocketBase(POCKETBASE_URL)
    pbClient.autoCancellation(false)
    await pbClient.collection('_superusers').authWithPassword(POCKETBASE_ADMIN_EMAIL, POCKETBASE_ADMIN_PASSWORD)
    pbReady = true
    console.log('[PocketBase] Admin client: CONFIGURED and AUTHENTICATED')
    await ensurePocketBaseCollection()
    await loadMatchesFromPocketBase()
  } catch (err) {
    if (pbReady) {
      console.error('[PocketBase] Post-auth initialization error:', err.message)
    } else {
      pbClient = null
      console.warn('[PocketBase] Admin client: FAILED to authenticate -', err.message)
    }
  }
}

// Initialize asynchronously (non-blocking — server starts regardless)
if (POCKETBASE_URL) initPocketBase()

// Tables /api/db may touch ('teams' was dropped: the table no longer exists;
// beach_competition_matches is not read or written by any client and stays
// server-side). Columns are checked against the live catalog by
// lib/pgQuery.js, which also refuses any filter/order on a secret column (no
// PIN oracle).
const ALLOWED_TABLES = ['matches', 'sets', 'events', 'match_live_state', 'profiles', 'referee_database', 'user_matches', 'svrz_games']
// Reference data a client may read but not change: the official game schedule
// (written by the server's own vm-sync job). Admins only.
const READ_ONLY_TABLES = new Set(['svrz_games'])
// The shared referee directory: any account may add a referee (Match Setup),
// and add a sport to one (sport_type of a single row, by id); changing or
// deleting anything else is for admins.
const REFEREE_DIRECTORY = 'referee_database'
const REFEREE_DIRECTORY_UPDATABLE = new Set(['sport_type'])
const DB_RATE_LIMIT_MAX = 200 // relay reads (/api/match/list, /api/match/:id, ...)
const AUTH_RATE_LIMIT_MAX = 10 // PocketBase PIN proof
const EMAIL_RATE_LIMIT_MAX = 3
const ICAL_RATE_LIMIT_MAX = 10
// Venue-NAT sized buckets (plan §4 Phase 2/3, §9): one address may carry a whole hall.
const DB_READ_RATE_LIMIT_MAX = 600   // /api/db reads per IP and minute
const DB_WRITE_RATE_LIMIT_MAX = 600  // /api/db writes per user id and minute
const DB_WRITE_IP_RATE_LIMIT_MAX = 1200 // /api/db writes per IP, checked before the token lookup
const STORAGE_IP_RATE_LIMIT_MAX = 600 // /api/storage/* per IP (per-user write quota lives in lib/storage.js)
const PIN_RATE_LIMIT_MAX = 20        // validate-connection-pin per IP (/64) + PIN type
const PIN_IP_RATE_LIMIT_MAX = 60     // validate-connection-pin per IP (/64), coarse total
// validate-connection-pin FAILED guesses per IP (/64): the brute-force budget.
// A success is refunded, so a venue NAT pairing many devices is not affected.
const PIN_FAILURES = { max: 20, windowMs: 10 * 60 * 1000 }
const pinFailureLimiter = createAttemptLimiter(PIN_FAILURES)
const DB_IP_RATE_LIMIT_MAX = 1200    // /api/db per IP (/64), any action, checked BEFORE the body is read
// /api/match/restore bodies (up to MAX_RESTORE_BODY_SIZE) parsed at once, per process
const restoreGate = createConcurrencyGate({ maxConcurrent: 2, maxQueue: 4 })
const RESTORE_RATE_LIMIT_MAX = 30    // /api/match/restore per user
// POST /api/match/event-revisions bodies (at most 200 revisions, lib/eventRevisions.js)
const EVENT_REVISIONS_MAX_BODY = 256 * 1024
const RESTORE_PIN_IP_RATE_LIMIT_MAX = 60 // /api/match/restore-by-pin per IP (the attempt limiter is inside)
// docs/scorer-accounts-spec.md section 5
const MANAGE_RATE_LIMIT_MAX = 300        // /api/admin/* and /api/saved-teams* per user and minute
const OFFICIAL_CHECK_RATE_LIMIT_MAX = 120 // /api/match/official-check per user and minute
// Invite redemption: FAILED attempts per account and per IP (/64); a success is refunded
const redeemLimiter = createAttemptLimiter({ max: 10, windowMs: 10 * 60 * 1000 })
// Account approvals (docs/account-approval-spec.md 3.0, lib/approvals.js)
const APPROVAL_PIN_RATE_LIMIT_MAX = 30   // /api/account/approval-pin* per user and minute
const APPROVALS_RATE_LIMIT_MAX = 60      // /api/approvals* per user and minute
// Wrong passwords on set/remove PIN and wrong PINs on approve, per account and
// per IP (/64); every other answer is refunded.
const APPROVAL_PASSWORD_FAILURES = { max: 5, windowMs: 15 * 60 * 1000 }
const APPROVAL_PIN_FAILURES = { max: 10, windowMs: 10 * 60 * 1000 }
const approvalPasswordLimiter = createAttemptLimiter(APPROVAL_PASSWORD_FAILURES)
const approvalPinFailLimiter = createAttemptLimiter(APPROVAL_PIN_FAILURES)
// The paths of lib/manageApi.js (same as its manageFamilyOf, which loads with the data layer)
function manageFamilyOf(pathname) {
  if (pathname === '/api/me') return 'me'
  if (pathname === '/api/account/join') return 'join'
  if (pathname === '/api/account/redeem-invite') return 'account'
  if (pathname === '/api/match/official-check') return 'officialCheck'
  if (pathname.startsWith('/api/admin/')) return 'admin'
  if (pathname === '/api/saved-teams' || pathname.startsWith('/api/saved-teams/')) return 'savedTeams'
  if (pathname.startsWith('/api/beach/')) return 'beach'
  if (pathname === '/api/account/approval-pin' || pathname === '/api/account/approval-pin/remove') return 'approvalPin'
  if (pathname === '/api/approvals' || pathname.startsWith('/api/approvals/') || pathname === '/api/account/approvals') return 'approvals'
  return null
}
// GET /api/public/beach/t/:slug (lib/beachTournaments.js publicTournament): anonymous, per IP
const PUBLIC_BEACH_RATE_LIMIT_MAX = 120
const PUBLIC_BEACH_RE = /^\/api\/public\/beach\/t\/([a-z0-9-]{1,80})$/
// Internal scan of setup/live matches for validate-connection-pin
const PIN_SCAN_MAX_ROWS = 20000

// Columns/JSONB keys that must NEVER be returned to a client (SECRET_COLUMNS,
// redactSecrets) live in lib/secrets.js, shared with lib/realtimeHub.js.

// --- Self-hosted data layer (DATABASE_URL mode only) ------------------------
// pg, lib/pgQuery.js, lib/matchRestore.js, lib/auth.js and lib/storage.js are
// loaded with a dynamic import() the first time they are needed, never at the
// top level: the SEA build bundles to CJS (no top-level await), and the LAN
// binary must start without a database. Nothing here connects at load time;
// the pg Pool connects lazily and the catalog loads on first use with backoff.
let dataLayer = null
let dataLayerPromise = null
function getDataLayer() {
  if (!DB_MODE) return null
  dataLayerPromise ??= Promise.all([
    import('./lib/pgQuery.js'),
    import('./lib/matchRestore.js'),
    import('./lib/auth.js'),
    import('./lib/storage.js'),
    import('./lib/pinHash.js'),
    import('./lib/access.js'),
    import('./lib/accounts.js'),
    import('./lib/savedTeams.js'),
    import('./lib/manageApi.js'),
    import('./lib/officialGame.js'),
    import('./lib/mailer.js'),
    import('./lib/approvals.js'),
    import('./lib/beachTournaments.js'),
    import('./lib/eventRevisions.js')
  ]).then(([pgq, mr, au, st, ph, ac, acc, svt, mg, og, ml, apv, bt, evr]) => {
    const poolMax = Number(process.env.PG_POOL_MAX) > 0 ? Math.floor(Number(process.env.PG_POOL_MAX)) : undefined
    const db = pgq.createPgQuery({
      connectionString: DATABASE_URL,
      allowedTables: ALLOWED_TABLES,
      secretColumns: SECRET_COLUMNS,
      minWriteProto: MIN_WRITE_PROTO,
      ...(poolMax ? { poolMax } : {})
    })
    // PINs at rest: HMAC with OV_PIN_SECRET (lib/pinHash.js); unset = plaintext as before.
    const pins = ph.pinHasherFromEnv(process.env)
    if (!pins.enabled) {
      console.warn('⚠️  [Config] OV_PIN_SECRET is not set: game and connection PINs are stored in plaintext in the database (README "PINs at rest").')
    }
    const restore = mr.createMatchRestore(db, { pinHasher: pins })
    const storage = st.createStorage({
      ...st.storageOptionsFromEnv({ ...process.env, STORAGE_DIR: STORAGE_ROOT }),
      checkQuota: st.createWriteQuota()
    })
    // One pg Pool for everything (auth shares pgQuery's pool). delete-account
    // removes the account's files too (README "Deleting an account").
    // Account emails (reset / confirmation links; lib/mailer.js). Without
    // SMTP_HOST or SMTP_PASS: reset answers 503, sign-up confirms at once.
    const mailer = ml.mailerFromEnv(process.env)
    if (mailer.enabled) {
      console.log(`[Mail] account emails on: SMTP ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 465} as ${process.env.SMTP_USER}, from ${mailer.from}, links to ${mailer.managerUrl}; OpenBeach from ${mailer.fromFor('beach')}, links to ${mailer.managerUrlFor('beach')}`)
      for (const w of mailer.warnings || []) console.warn(`[Mail] ${w}`)
    } else {
      console.log(`[Mail] account emails off (${mailer.reason}): password reset answers 503, sign-up confirms accounts at once`)
    }
    const auth = au.createAuth({
      pool: db.pool,
      mailer,
      contactEmail: CONTACT_EMAIL,
      onAccountDeleted: async (userId) => {
        const r = await storage.deleteUserData(userId)
        if (r.objectsRemoved || r.ownerRecordsUpdated || r.ownerRecordsRemoved) {
          console.log('[Auth] delete-account files', JSON.stringify(r))
        }
        return r
      }
    })
    // Roles from public.profiles (never the request), 30 s per process (lib/access.js)
    const access = ac.createAccessResolver({ pool: db.pool })
    // Account approvals (lib/approvals.js): the approval PINs need OV_PIN_SECRET
    // (never plaintext); without it every endpoint answers 503.
    const approvals = apv.createApprovals({ pool: db.pool, auth, mailer, secret: pins.enabled ? String(process.env.OV_PIN_SECRET) : null })
    if (!approvals.enabled) console.warn('⚠️  [Config] OV_PIN_SECRET is not set: approval with an account is off (503 OV_APPROVAL_UNAVAILABLE).')
    const accounts = acc.createAccounts({ pool: db.pool, db, restore, access, approvalsForMatches: approvals.approvalsForMatches })
    const savedTeams = svt.createSavedTeams({ pool: db.pool })
    const beach = bt.createBeachTournaments({ pool: db.pool, accounts })
    // Undo / delete / edit history of events (db/015)
    const revisions = evr.createEventRevisions(db)
    const manage = mg.createManageApi({ accounts, savedTeams, beach, approvals, revisions })
    dataLayer = { db, restore, auth, storage, pins, access, accounts, savedTeams, beach, approvals, manage, revisions, publicClaim: og.publicClaim, sendAuthResult: au.sendAuthResult, AUTH_ACTIONS: au.AUTH_ACTIONS, ipKey: au.ipBucketKey }
    return dataLayer
  })
  return dataLayerPromise
}

// Realtime (Supabase Realtime replacement): `?purpose=live` sockets get
// db-change events from /api/db + /api/match/restore write-through and from the
// scoreboard's relay live-state-update. DATABASE_URL mode only: a LAN relay
// answers live sockets with its normal 'connected' (mode local) hello, which
// the frontend shim treats as "realtime not supported".
// Live sockets are anonymous: rows are redacted (PINs) and then projected to
// the public columns (no rosters, dates of birth, signatures, officials,
// connection data, event payloads), see lib/publicColumns.js.
const realtimeHub = DB_MODE
  ? createRealtimeHub({ redact: redactSecrets, project: projectLiveRow, getClientIp: (req) => getClientIp(req) })
  : null
let liveStateRelay = null // created below, once activeMatches exists

/**
 * Publish pgQuery/matchRestore `changes` ([{table, eventType, row}]) to live
 * subscribers. Consecutive rows of the same table and type go out as one
 * publish, so the hub's per-channel coalescing applies. Never throws.
 */
function publishChanges(changes) {
  if (!realtimeHub || !Array.isArray(changes) || changes.length === 0) return
  try {
    let i = 0
    while (i < changes.length) {
      const { table, eventType } = changes[i]
      const rows = []
      while (i < changes.length && changes[i].table === table && changes[i].eventType === eventType) {
        rows.push(changes[i].row)
        i++
      }
      // UPDATE too: the relay caches closed_at (a closed match publishes nothing)
      if (table === 'matches' && (eventType === 'DELETE' || eventType === 'UPDATE') && liveStateRelay) {
        for (const r of rows) liveStateRelay.invalidate(r?.id, r?.external_id)
      }
      realtimeHub.broadcastDbChange(table, eventType, rows)
    }
  } catch (err) {
    console.warn('[realtime] broadcast failed:', err.message)
  }
}

// Tables that are per-user private: every action requires a valid token AND is
// constrained to rows the caller owns (user_id === auth user id).
const OWNER_SCOPED_TABLES = new Set(['profiles', 'user_matches'])

// Columns a client may never write (privilege / identity fields).
// matches.created_by is set by pgQuery's ownership guard (the session's user);
// closed_at / closed_by by db/007's trigger; official_game_exempt by an admin;
// created_at by the database default (it is part of the official-game key when
// scheduled_at is empty, so a client must not pick the season through it).
const WRITE_DENYLIST = {
  profiles: ['roles', 'user_id', 'id'],
  user_matches: ['user_id', 'id'],
  // tournament_match_id (db/014): the link to a beach tournament match is the server's
  matches: ['created_by', 'closed_at', 'closed_by', 'official_game_exempt', 'created_at', 'tournament_match_id'],
  // db/015: an event is voided / edited only through POST /api/match/event-revisions
  // (which keeps the revision); /api/db can never void or unvoid one
  events: ['voided_at', 'voided_by', 'void_reason', 'rev']
}

// Match ownership (db/005_match_ownership.sql, lib/pgQuery.js opts.matchOwner):
// writes to these tables need the match's creator or an editor; an admin
// (profiles.roles contains admin or super_admin, read from the database, never
// from the request) writes unguarded. An account that is not an approved
// scorer writes test matches only (db/007, docs/scorer-accounts-spec.md).
const MATCH_OWNED_TABLES = new Set(['matches', 'sets', 'events', 'match_live_state'])

/** Is this account an admin? (lib/access.js, cached 30 s); a database error counts as "no". */
async function isAdminUser(layer, userId) {
  try {
    return (await layer.access.get(userId)).isAdmin
  } catch (err) {
    console.warn('[auth] admin check failed:', err?.message)
    return false
  }
}

/**
 * The only /api/db writes of the referee directory a non-admin may make:
 * inserts, and an update of sport_type alone on one row by id.
 */
function refereeDirectoryWriteAllowed(table, action, params) {
  if (table !== REFEREE_DIRECTORY) return false
  if (action === 'insert') return true
  if (action !== 'update') return false
  const data = params?.data
  const filters = params?.filters
  return !!data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0 &&
    Object.keys(data).every((k) => REFEREE_DIRECTORY_UPDATABLE.has(k)) &&
    Array.isArray(filters) && filters.length === 1 && filters[0]?.type === 'eq' && filters[0]?.column === 'id' &&
    (typeof filters[0].value === 'string' || typeof filters[0].value === 'number')
}

/**
 * Inline take-over of /api/db match inserts/upserts (see the /api/db route):
 * every row of the refused write must carry an external_id and the game PIN
 * of that stored match. Each attempt is a counted guess in the shared
 * brute-force budget (refunded when it proves the PIN). Returns true when the
 * user was made an editor of every such match.
 */
async function claimByUpsertPin(layer, userId, data, clientIp) {
  const rows = (Array.isArray(data) ? data : [data]).filter((r) => r && typeof r === 'object')
  if (rows.length === 0 || rows.length > 20) return false
  const claims = []
  for (const row of rows) {
    const ext = typeof row.external_id === 'string' ? row.external_id.trim() : ''
    const pin = row.game_pin == null ? '' : String(row.game_pin).trim()
    if (!ext || ext.length > 200 || !pin) return false
    claims.push({ ext, pin })
  }
  const ipKey = ipBucketKey(clientIp)
  if (pinFailureLimiter.isLimited(ipKey)) return false
  // Only a wrong PIN keeps the attempt counted
  let wrongPin = false
  try {
    const found = await layer.db.runQuery({
      table: 'matches',
      action: 'select',
      params: { columns: 'id, external_id, game_pin', filters: [{ type: 'in', column: 'external_id', value: [...new Set(claims.map((c) => c.ext))] }] }
    }, { internal: true })
    if (found.body.error) return false
    const byExt = new Map((found.body.data || []).map((m) => [m.external_id, m]))
    const proved = []
    for (const c of claims) {
      const m = byExt.get(c.ext)
      // A new row is not the reason for the refusal; an existing one needs its PIN
      if (!m) continue
      if (!layer.pins.matches('game', c.pin, m.game_pin)) {
        wrongPin = true
        return false
      }
      proved.push(m.id)
    }
    if (proved.length === 0) return false
    for (const id of new Set(proved)) {
      if (!(await layer.restore.addEditor(id, userId, 'game_pin'))) return false
    }
    console.log(`[match/claim] inline take-over of ${proved.length} match(es) by game PIN`)
    for (const id of new Set(proved)) await layer.accounts.auditClaimPin({ actorId: userId, matchId: id, via: 'upsert-pin' })
    return true
  } catch (err) {
    console.warn('[match/claim] inline take-over failed:', err?.message)
    return false
  } finally {
    if (!wrongPin) pinFailureLimiter.refund(ipKey)
  }
}

// The sports of a match (db/012): OpenVolley 'indoor', OpenBeach 'beach'.
const MATCH_SPORTS = ['indoor', 'beach']

/**
 * pgQuery opts.matchOwner for this user: an admin's records the creator and
 * checks nothing; otherwise the sports the account cannot score in
 * (testOnlySports, lib/access.js apps.<sport>.canScore) are limited to test
 * matches, judged by the sport of the ROW (lib/pgQuery.js). testOnly: it
 * cannot score in any sport.
 * THROWS when the roles cannot be read (callers answer 503, never "not a scorer").
 */
async function matchOwnerFor(layer, user) {
  const a = await layer.access.get(user.id)
  if (a.isAdmin) return { userId: user.id, admin: true }
  const canScoreIn = (sport) => (a.apps ? a.apps[sport]?.canScore === true : sport === 'indoor' && a.canScore === true)
  const testOnlySports = MATCH_SPORTS.filter((sport) => !canScoreIn(sport))
  return { userId: user.id, testOnly: testOnlySports.length === MATCH_SPORTS.length, testOnlySports }
}

/** The sports in which a matchOwner may write non-test matches (undefined: every sport). */
function scoringSportsOf(matchOwner) {
  if (!matchOwner || matchOwner.admin) return undefined
  return MATCH_SPORTS.filter((sport) => !(matchOwner.testOnlySports || MATCH_SPORTS).includes(sport))
}

/**
 * The sport of a scoresheet path: OpenBeach writes under beach/ (the first
 * segment, compared like a case-insensitive file system would), everything
 * else is indoor. Malformed paths are refused by lib/storage.js anyway.
 */
function scoresheetSportOf(path) {
  if (typeof path !== 'string') return 'indoor'
  const first = path.normalize('NFKC').split('/')[0]
  return first.toLowerCase() === 'beach' ? 'beach' : 'indoor'
}

const DB_UNAVAILABLE_BODY = { data: null, error: { message: 'Service unavailable', code: 'OV_DB_UNAVAILABLE', retryable: true } }
const GAME_TAKEN_MESSAGE = 'This official game is already scored by another account.'

/** The 409 body of a game another match already holds (lib/officialGame.js publicClaim). */
function gameTakenBody(layer, claim) {
  return { data: null, error: { message: GAME_TAKEN_MESSAGE, code: 'OV_GAME_TAKEN', claim: claim ? layer.publicClaim(claim) : null } }
}

/**
 * A 409 OV_GAME_TAKEN from the database (a race, or an update onto a taken
 * game): add the claim when the payload names a game. Never throws.
 */
async function enrichGameTaken(layer, userId, result, rows, matchOwner) {
  if (result?.status !== 409 || result.body?.error?.code !== 'OV_GAME_TAKEN') return result
  let claim = null
  try {
    // only the sports the caller can score in: never who holds a game of the other sport
    claim = await layer.accounts.findTakenGame({ userId, rows, sports: scoringSportsOf(matchOwner) })
  } catch { claim = null }
  if (claim) await layer.accounts.auditGameTaken({ actorId: userId, claim })
  return { ...result, body: gameTakenBody(layer, claim) }
}

// Secret fields on an in-memory match object that must never reach a client.
// The team1*/team2* ones are openbeach's names for the bench and upload PINs
// (team1Pin, older builds team1TeamPin); matchPin is openbeach's PIN that
// protects the match on the scorer's device.
const MATCH_SECRET_FIELDS = ['refereePin', 'homeTeamPin', 'awayTeamPin', 'homeTeamUploadPin', 'awayTeamUploadPin', 'connection_pins', 'connectionPins', 'game_pin', 'gamePin',
  'team1Pin', 'team2Pin', 'team1TeamPin', 'team2TeamPin', 'team1UploadPin', 'team2UploadPin', 'team1TeamUploadPin', 'team2TeamUploadPin', 'matchPin']
function stripMatchSecrets(match) {
  if (!match || typeof match !== 'object') return match
  const clean = { ...match }
  for (const k of MATCH_SECRET_FIELDS) delete clean[k]
  return clean
}

// Room / activeMatches key: always String(matchId). The scoreboard sends the
// numeric Dexie id, subscribers send a string; without this they ended up in
// different rooms (Map treats 5 and "5" as different keys).
function normalizeMatchId(id) {
  if (id === undefined || id === null) return null
  const s = String(id).trim()
  return s && s.length <= 128 ? s : null
}

// Room key of a synced match: its seed_key when it carries one, else the id the
// scoreboard sent (same rule as frontend/electron/lanRelayCore.cjs). Every
// device's first match is Dexie id 1, so keying by it made concurrent scorers
// fight over room '1', and the tablets (which know the seed key from the PIN
// check / QR code) sat in an empty room. The scoreboard's own id stays usable
// on that socket as an alias (clientInfo.aliases, see resolveMatchKey).
function relayKeyOf(rawId, match) {
  const seed = match && typeof match === 'object' ? (match.seed_key ?? match.seedKey) : null
  return (typeof seed === 'string' && normalizeMatchId(seed)) || normalizeMatchId(rawId)
}
const MAX_ALIASES = 16
function resolveMatchKey(clientInfo, rawId) {
  const id = normalizeMatchId(rawId)
  if (!id) return null
  return clientInfo?.aliases?.get(id) || id
}

// A scoreboard that already proved the match sends its PINs only when they
// change: fields it leaves out keep the stored values (a present field, even
// null, replaces them).
function carryMatchSecrets(prevMatch, nextMatch) {
  if (!prevMatch || typeof prevMatch !== 'object' || !nextMatch || typeof nextMatch !== 'object') return nextMatch
  let out = nextMatch
  for (const k of MATCH_SECRET_FIELDS) {
    if (!(k in nextMatch) && prevMatch[k] !== undefined) {
      if (out === nextMatch) out = { ...nextMatch }
      out[k] = prevMatch[k]
    }
  }
  return out
}
const hasGamePinField = (match) => !!match && typeof match === 'object' && ('gamePin' in match || 'game_pin' in match)
const hasAnyPinField = (match) => !!match && typeof match === 'object' && MATCH_SECRET_FIELDS.some(k => k in match)
// Remember a key in a bounded Set (oldest dropped first)
function rememberKey(set, key, max) {
  set.delete(key)
  if (set.size >= max) set.delete(set.values().next().value)
  set.add(key)
}

// subscribe-match { device, team }: a label for /api/server/connections (the
// scorer's tablet status). Grants nothing; 'referee'/'bench' as `role` still
// need the PIN.
const DEVICE_LABELS = ['referee', 'bench', 'livescore']

// The match's game PIN as a comparable string, or null (test matches have none).
function gamePinOf(match) {
  if (!match || typeof match !== 'object') return null
  const v = match.gamePin != null && match.gamePin !== '' ? match.gamePin : match.game_pin
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s || null
}

function safeEqualStr(a, b) {
  const x = Buffer.from(String(a), 'utf8')
  const y = Buffer.from(String(b), 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

// A match object as the relay hands it out: no PINs, no personal data (see
// publicRelayMatch). Joining a room needs no PIN and its key is public.
function publicMatch(match) {
  return publicRelayMatch(stripMatchSecrets(match))
}

// The PIN-free, personal-data-free bundle every match-full-data /
// match-data-update and GET /api/match/:id carries — the same flat shape the
// LAN relays send (frontend/electron/lanRelayCore.cjs). Only the scorer, who
// sent it, has the full bundle.
function wireBundle(entry) {
  const out = {
    match: publicMatch(entry.match),
    homeTeam: entry.homeTeam ?? null,
    awayTeam: entry.awayTeam ?? null,
    homePlayers: publicPeople(entry.homePlayers || []),
    awayPlayers: publicPeople(entry.awayPlayers || []),
    sets: entry.sets || [],
    events: entry.events || []
  }
  if (entry.liveState !== undefined) out.liveState = entry.liveState
  return out
}

// match-full-data / match-data-update. A stored liveState is mirrored under
// `data` (and nothing else is) for the LedBox bridge, which reads
// msg.data.liveState — same as the LAN relays. `access` 'summary' (no PIN
// proved): teams, status, set scores and live state only (relaySummaryBundle).
function matchDataMessage(type, matchId, entry, scoreboardTs, access = 'full') {
  const now = Date.now()
  const bundle = access === 'full' ? { access: 'full', ...wireBundle(entry) } : relaySummaryBundle(entry)
  const msg = { type, matchId, ...bundle, _timestamp: now, _scoreboardTimestamp: scoreboardTs || now }
  if (entry.liveState !== undefined) msg.data = { liveState: entry.liveState }
  return msg
}


// Option 1: Resend API (recommended - uses HTTPS, never blocked)
// RESEND_API_KEY
// Option 2: SMTP (may be blocked by some cloud providers)
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, CONTACT_EMAIL
// The SMTP settings are the account-email mailbox (lib/mailer.js). These two
// legacy routes (/api/contact, /api/match/send-info) mail addresses that an
// anonymous request supplies, so they use it only with SMTP_LEGACY_ROUTES=1:
// otherwise configuring password-reset mail would turn them into an open
// relay of the noreply mailbox.
const LEGACY_SMTP = !!process.env.SMTP_HOST && process.env.SMTP_LEGACY_ROUTES === '1'
if (process.env.RESEND_API_KEY || LEGACY_SMTP) {
  console.log('[Email Config] RESEND_API_KEY:', process.env.RESEND_API_KEY ? 'SET' : 'NOT SET')
  console.log('[Email Config] SMTP_HOST:', process.env.SMTP_HOST ? 'SET' : 'NOT SET')
  console.log('[Email Config] SMTP_PORT:', process.env.SMTP_PORT || 'NOT SET')
  console.log('[Email Config] SMTP_USER:', process.env.SMTP_USER ? 'SET' : 'NOT SET')
  console.log('[Email Config] SMTP_PASS:', process.env.SMTP_PASS ? 'SET' : 'NOT SET')
}

// Resend email helper (uses HTTPS - works on all cloud platforms)
async function sendViaResend(to, subject, text) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000) // 10s timeout
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'eScoresheet <escoresheet@openvolley.app>',
        to: [to],
        subject: subject,
        text: text
      }),
      signal: controller.signal
    })
    const data = await response.json()
    if (!response.ok) {
      throw new Error(data.message || 'Resend API error')
    }
    return data
  } finally {
    clearTimeout(timeout)
  }
}
const emailTransporter = LEGACY_SMTP ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  connectionTimeout: 10000, // 10 seconds max to connect
  greetingTimeout: 10000,
  socketTimeout: 15000,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
}) : null
// IS_CLOUD / IS_LOCAL are defined at the top (runtime mode).

// --- Static file serving for standalone/local mode ---
const __filename = fileURLToPath(import.meta.url)
const __dirname = join(__filename, '..')
const STATIC_DIR = join(__dirname, 'public')
const HAS_STATIC_ON_DISK = existsSync(STATIC_DIR)

// Check for embedded SEA assets (files packed into the binary at build time)
let HAS_EMBEDDED_ASSETS = false
let embeddedAssetSet = null
let seaGetAsset = null
try {
  const sea = require('node:sea')
  if (sea.isSea()) {
    const keys = sea.getAssetKeys()
    if (keys.length > 0) {
      embeddedAssetSet = new Set(keys)
      seaGetAsset = sea.getAsset.bind(sea)
      HAS_EMBEDDED_ASSETS = true
    }
  }
} catch { /* not running as SEA binary */ }

const HAS_STATIC = HAS_EMBEDDED_ASSETS || HAS_STATIC_ON_DISK

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp'
}

if (HAS_EMBEDDED_ASSETS) {
  console.log(`[Static] Serving ${embeddedAssetSet.size} embedded frontend files`)
} else if (HAS_STATIC_ON_DISK) {
  console.log('[Static] Serving frontend files from:', STATIC_DIR)
} else {
  console.log('[Static] No public/ directory found — static file serving disabled')
}

// --- Local IP detection ---
// Virtual/VPN interfaces to hide from the default banner
const HIDDEN_INTERFACES = /^(tailscale|tun|tap|docker|br-|veth|virbr|wg|zt|utun)/i

function getLocalIPs() {
  const ips = []
  const interfaces = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal && !HIDDEN_INTERFACES.test(name)) {
        ips.push({ name, address: addr.address })
      }
    }
  }
  return ips
}

// In-memory storage for active matches
// NOTE: This resets on server restart - the database (cloud) or the scoreboard's
// IndexedDB (LAN) is the source of truth for persistence
const activeMatches = new Map()
const connections = new Map()
const rooms = new Map() // Match rooms for isolated communication

// relay live-state-update -> match_live_state db-change for live subscribers
// (livescore, the referee's scorer alarm) even while the scorer's HTTP sync is down.
if (realtimeHub) {
  liveStateRelay = createLiveStateRelay({
    hub: realtimeHub,
    getSyncedMatch: (id) => activeMatches.get(String(id)),
    // Any socket that proved the match may publish (the scorer can hold two:
    // App's periodic sync and the Scoreboard's live one). message.matchId is
    // already the resolved room key.
    isAuthorized: (client, message, synced) =>
      !!synced && message?.matchId != null && client?.ownedMatches?.has(String(message.matchId)) === true,
    // game_pin is read (internal) only to bind the relay room to the database
    // row below; carryColumns never copies it into the published row.
    lookupMatch: async (key) => {
      const layer = await getDataLayer()
      const r = await layer.db.runQuery({
        table: 'matches',
        action: 'select',
        params: { columns: 'id, sport_type, game_pin, closed_at', filters: [{ type: 'eq', column: key.column, value: key.value }], limit: 1 }
      }, { internal: true })
      if (r.body.error) throw new Error(r.body.error.code || 'lookup failed')
      return r.body.data?.[0] || null
    },
    // Owning a relay room proves the room's game PIN, not the database row the
    // synced match points at (match.externalId / seed_key are public): the
    // synced game PIN must be the row's, else nothing is published. A row
    // without a game PIN cannot be bound and gets nothing either (the
    // scorer's HTTP sync still updates it).
    // A closed match (db/007) is frozen for livescore too: nothing is published.
    // This relay is gated by the game PIN, not by an account: a socket carries
    // no session, so the approved-scorer rule (docs/scorer-accounts-spec.md
    // decision 1) does not apply to it. Nothing it relays is stored.
    verifyMatch: (row, synced) => {
      if (row?.closed_at != null) return false
      const pin = gamePinOf(synced?.match)
      return !!(pin && dataLayer?.pins && dataLayer.pins.matches('game', pin, row?.game_pin))
    }
  })
}

// --- Capacity limits ---
const MAX_ROOMS = 500
const MAX_CONNECTIONS = 2000
// Role sockets (scoreboard/referee/bench/livescore relay) per IP. A cloud relay
// sits behind venue NATs (plan §4 Phase 3: 200); the LAN relay keeps 50.
// `?purpose=live` sockets are counted separately by the realtime hub (500/IP, 3000 total).
const MAX_CONNECTIONS_PER_IP = IS_CLOUD ? 200 : 50
const ROOM_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
// Dexie match ids restart at 1 on every device, so ids collide across
// devices/venues: a match nobody owns may be claimed by another scoreboard —
// after ORPHAN_TAKEOVER_MS when it is finished, after STALE_TAKEOVER_MS when it
// is still in play (a scorer offline through a set break keeps its match), and
// then its own game PIN may reclaim it once. Same rules as the LAN relays
// (frontend/electron/lanRelayCore.cjs).
const ORPHAN_TAKEOVER_MS = 60 * 1000
const STALE_TAKEOVER_MS = 10 * 60 * 1000
// Wrong game-PIN claims per socket and minute before claims needing proof are
// refused without comparing the PIN (no guessing oracle). Only a claim that
// carries a PIN counts. Per address (IPv6 /64) they share the brute-force
// budget of every other PIN check (pinFailureLimiter: 20 wrong PINs in 10
// minutes); a right PIN is refunded, so every scorer of a venue NAT may
// reconnect at once.
const CLAIM_FAILURE_LIMIT = 5
// Distinct match ids one IP's sockets may own at once / claim per minute
// (higher than the LAN relays: a club's courts can share one NAT address).
const MAX_OWNED_PER_IP = 20
const NEW_CLAIM_LIMIT = 30
const FINISHED_STATUSES = new Set(['final', 'ended', 'completed', 'finished'])

// --- PocketBase sync (5s trailing-edge debounce) ---
const PB_SYNC_DEBOUNCE_MS = 5000
const pbPendingSync = new Map() // matchId → { data, timer }
const pbSyncedMatches = new Set() // track which matches have been synced at least once

function syncToPocketBase(matchId, matchData) {
  if (!pbReady || !pbClient) return
  const existing = pbPendingSync.get(matchId)
  if (existing) {
    existing.data = matchData // overwrite with latest snapshot
    return // timer already running
  }
  const entry = { data: matchData, timer: null }
  entry.timer = setTimeout(() => {
    pbPendingSync.delete(matchId)
    executePocketBaseSync(matchId, entry.data)
  }, PB_SYNC_DEBOUNCE_MS)
  pbPendingSync.set(matchId, entry)
}

async function executePocketBaseSync(matchId, matchData) {
  if (!pbReady || !pbClient) return
  try {
    const payload = {
      match_id: String(matchId),
      external_id: matchData.match?.external_id || matchData.match?.seed_key || '',
      status: matchData.match?.status || 'unknown',
      sport_type: matchData.sportType || matchData.match?.sport_type || 'indoor',
      game_number: matchData.match?.gameN || matchData.match?.gameNumber || matchData.match?.game_n || 0,
      match_data: matchData.match || {},
      home_team: matchData.homeTeam || {},
      away_team: matchData.awayTeam || {},
      home_players: matchData.homePlayers || [],
      away_players: matchData.awayPlayers || [],
      sets: matchData.sets || [],
      events: matchData.events || [],
      updated_at: new Date().toISOString()
    }
    try {
      const existing = await pbClient.collection('matches').getFirstListItem(
        pbClient.filter('match_id = {:id}', { id: String(matchId) })
      )
      await pbClient.collection('matches').update(existing.id, payload)
    } catch (findErr) {
      if (findErr.status === 404) {
        await pbClient.collection('matches').create(payload)
      } else {
        throw findErr
      }
    }
    // Only log first sync per match to keep logs clean
    if (!pbSyncedMatches.has(matchId)) {
      pbSyncedMatches.add(matchId)
      console.log(`[PocketBase] First sync for match ${matchId}`)
    }
  } catch (err) {
    if (err.status === 401) {
      console.warn('[PocketBase] Auth expired, re-authenticating...')
      pbReady = false
      try {
        await pbClient.collection('_superusers').authWithPassword(POCKETBASE_ADMIN_EMAIL, POCKETBASE_ADMIN_PASSWORD)
        pbReady = true
        executePocketBaseSync(matchId, matchData)
      } catch (reAuthErr) {
        console.error('[PocketBase] Re-authentication failed:', reAuthErr.message)
      }
      return
    }
    console.error(`[PocketBase] Sync failed for match ${matchId}:`, err.message)
  }
}

// Relay room cleanup must not destroy the backup: mark the record retired
// (skipped by startup recovery) instead of deleting it.
async function retirePocketBaseMatch(matchId) {
  // Cancel any pending debounced sync
  const pending = pbPendingSync.get(matchId)
  if (pending) { clearTimeout(pending.timer); pbPendingSync.delete(matchId) }
  pbSyncedMatches.delete(matchId)
  if (!pbReady || !pbClient) return
  try {
    const existing = await pbClient.collection('matches').getFirstListItem(
      pbClient.filter('match_id = {:id}', { id: String(matchId) })
    )
    try {
      await pbClient.collection('matches').update(existing.id, { status: 'deleted', updated_at: new Date().toISOString() })
    } catch (err) {
      // executePocketBaseSync stores any match status ('unknown' included), so
      // `status` is free text in practice; a deployment whose schema made it a
      // select field would reject 'deleted'. 'final' is skipped by recovery too.
      if (err.status !== 400) throw err
      await pbClient.collection('matches').update(existing.id, { status: 'final', updated_at: new Date().toISOString() })
    }
    // Retired records stay in the restore list (with their status): retiring
    // exists precisely so a cleared relay match can still be restored.
    console.log(`[PocketBase] Retired match ${matchId}`)
  } catch (err) {
    if (err.status !== 404) console.error(`[PocketBase] Retire failed for match ${matchId}:`, err.message)
  }
}

async function loadMatchesFromPocketBase() {
  if (!pbReady || !pbClient) return
  try {
    const records = await pbClient.collection('matches').getFullList({ sort: '-updated_at' })
    let loaded = 0
    for (const record of records) {
      const matchId = record.match_id
      if (!matchId || record.status === 'final' || record.status === 'deleted' || activeMatches.has(matchId)) continue
      activeMatches.set(matchId, {
        matchId,
        match: record.match_data || {},
        homeTeam: record.home_team || {},
        awayTeam: record.away_team || {},
        homePlayers: record.home_players || [],
        awayPlayers: record.away_players || [],
        sets: record.sets || [],
        events: record.events || [],
        gameNumber: record.game_number || record.match_data?.gameN,
        sportType: record.sport_type === 'beach' ? 'beach' : 'indoor',
        updatedAt: record.updated_at || record.updated,
        updatedBy: 'pocketbase-recovery',
        orphanedAt: Date.now() // no scoreboard connected yet
      })
      rooms.set(matchId, {
        matchId,
        clients: new Set(),
        createdAt: new Date().toISOString(),
        lastActivity: Date.now()
      })
      loaded++
    }
    if (loaded > 0) console.log(`[PocketBase] Recovered ${loaded} active match(es) from backup`)
  } catch (err) {
    console.error('[PocketBase] Failed to load matches on startup:', err.message)
  }
}

// --- Input validation constants ---
const VALID_ROLES = ['scoreboard', 'referee', 'bench', 'subscriber', 'livescore']
const VALID_TEAMS = ['home', 'away']

// --- Security helpers ---
function isValidEmail(email) {
  if (!email || typeof email !== 'string' || email.length > 254) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function isValidPin(pin) {
  return /^\d{6}$/.test(String(pin).trim())
}

// --- Client IP extraction (X-Forwarded-For hardening) ---
// SECURITY: client-supplied X-Forwarded-For is never trusted. Only the
// Cloudflare CF-Connecting-IP header (set by the proxy, stripped from client
// input) is honored, and only with TRUST_PROXY=cloudflare, i.e. when the origin
// is reachable through Cloudflare only (Traefik ov-cf-only allowlist). In every
// other mode we key on the real socket address so per-IP rate limits cannot be
// defeated by spoofing headers.
function getClientIp(req) {
  const addr = (req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '')
  if (TRUST_PROXY === 'cloudflare' && (!TRUST_PROXY_FROM || peerInList(TRUST_PROXY_FROM, addr))) {
    const cfIp = String(req.headers['cf-connecting-ip'] || '').trim()
    if (cfIp && isIP(cfIp)) return cfIp.replace(/^::ffff:/, '')
  }
  return addr
}

/** "10.0.0.0/8, fd00::/8, 172.18.0.5" -> BlockList, or null when empty. Throws on a bad entry. */
function parseCidrList(value) {
  const items = String(value || '').split(',').map(s => s.trim()).filter(Boolean)
  if (items.length === 0) return null
  const list = new BlockList()
  for (const item of items) {
    const [ip, bits, extra] = item.split('/')
    const family = isIP(ip)
    const max = family === 4 ? 32 : 128
    const prefix = bits === undefined ? max : Number(bits)
    if (!family || extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > max || (bits !== undefined && !/^\d+$/.test(bits))) {
      throw new Error(`invalid CIDR ${JSON.stringify(item)}`)
    }
    list.addSubnet(ip, prefix, family === 4 ? 'ipv4' : 'ipv6')
  }
  return list
}

function peerInList(list, addr) {
  const family = isIP(addr)
  if (!family) return false
  try { return list.check(addr, family === 4 ? 'ipv4' : 'ipv6') } catch { return false }
}

/**
 * True for a caller that reached this process directly from loopback or a
 * private network (Uptime Kuma on the status network, docker exec curl), not
 * through cloudflared / Traefik: a proxied request always carries
 * cf-connecting-ip or X-Forwarded-For, which a client cannot remove.
 */
function isInternalCaller(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['forwarded']) return false
  const addr = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
  return addr === '::1' || /^127\./.test(addr) || /^10\./.test(addr) || /^192\.168\./.test(addr) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(addr) || /^f[cd][0-9a-f]{2}:/i.test(addr)
}

// --- Rate limiting (per-category isolation) ---
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX_REQUESTS = 10
const CONTACT_RATE_LIMIT_MAX = 3
// One Map per category so counters don't interfere across endpoint types
const rateLimitMaps = {
  default: new Map(),   // validate-pin, etc.
  relay: new Map(),     // relay reads: /api/match/list|:id, /api/server/connections, /api/pocketbase/*
  contact: new Map(),   // /api/contact
  email: new Map(),     // /api/match/send-info
  auth: new Map(),      // PocketBase PIN proof (lib/auth.js has its own buckets)
  ical: new Map(),      // /api/official-matches
  db: new Map(),        // /api/db reads, per IP
  dbWrite: new Map(),   // /api/db writes, per user id
  dbWriteIp: new Map(), // /api/db writes, per IP (before the token lookup)
  storage: new Map(),   // /api/storage/*, per IP
  dbIp: new Map(),      // /api/db, per IP (/64), before the body is read
  pin: new Map(),       // validate-connection-pin, per IP (/64) + type
  pinIp: new Map(),     // validate-connection-pin, per IP (/64)
  restore: new Map(),   // /api/match/restore, per user id
  restorePin: new Map(), // /api/match/restore-by-pin, per IP
  manage: new Map(),    // /api/admin/*, /api/saved-teams*, per user id
  officialCheck: new Map(), // /api/match/official-check, per user id
  publicBeach: new Map() // /api/public/beach/t/:slug, per IP
}

function isRateLimited(ip, maxRequests = RATE_LIMIT_MAX_REQUESTS, category = 'default') {
  const map = rateLimitMaps[category] || rateLimitMaps.default
  const now = Date.now()
  const entry = map.get(ip)

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    map.set(ip, { count: 1, windowStart: now })
    return false
  }

  entry.count++
  return entry.count > maxRequests
}

setInterval(() => {
  const now = Date.now()
  for (const map of Object.values(rateLimitMaps)) {
    for (const [ip, entry] of map.entries()) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
        map.delete(ip)
      }
    }
  }
  // lib/auth.js in-memory counters (sign-in/sign-up/session buckets, lockouts)
  try { dataLayer?.auth.sweep() } catch { /* ignore */ }
}, 5 * 60 * 1000)

// --- Request body reader ---
// Reads at most maxSize bytes. A larger body is NOT destroyed mid-stream (that
// lost the error response with the socket): the promise rejects with
// code BODY_TOO_LARGE, the rest of the body is discarded, and the handler sends
// its 413 (see sendBodyError) with `Connection: close`.
function readJsonBody(req, maxSize = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const tooLarge = () => {
      settled = true
      chunks.length = 0
      const err = new Error('Body too large')
      err.code = 'BODY_TOO_LARGE'
      reject(err)
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxSize) {
      tooLarge()
      req.resume() // drain and discard
      return
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxSize) return tooLarge()
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

/**
 * Answer a readJsonBody failure: 413 (connection closed after the response)
 * for an oversized body, else 400. `tooLargeBody` overrides the 413 body.
 */
function sendBodyError(res, err, { tooLargeBody, invalidBody } = {}) {
  if (res.headersSent) return
  if (err?.code === 'BODY_TOO_LARGE') {
    res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
    res.end(JSON.stringify(tooLargeBody || { data: null, error: { message: 'Request body too large', code: 'OV_BODY_TOO_LARGE' } }))
    return
  }
  res.writeHead(400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(invalidBody || { data: null, error: { message: 'Invalid request', code: 'OV_INVALID_REQUEST' } }))
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

// --- Proportionate operational logs (lib/opsLog.js) ---
// Rejected /api/db requests: one value-free line each (status, code, table,
// action, request id), at most 30 a minute per error code, so anonymous probes
// cannot flood the log and a flood of 401/429 cannot hide the rare codes
// (OV_UNSCOPED_EXTERNAL_ID, OV_CLIENT_TOO_OLD). Dropped lines are reported per
// code once a minute. Socket churn (connectivity checks open and close a socket every few
// seconds) and /api/match/list polls: one summary line a minute.
// OV_LOG_CONNECTIONS=1 restores the per-socket lines for debugging.
const LOG_EACH_CONNECTION = process.env.OV_LOG_CONNECTIONS === '1'
const logDbRejection = createLogLimiter({ max: 30, windowMs: 60_000 })
const relaySummary = createConnectionSummary({ label: '[WS]', intervalMs: 60_000 })
setInterval(() => { relaySummary.flush(); logDbRejection.flush() }, 60_000).unref()

// --- Log sanitizer (prevent log injection via newlines/control chars) ---
function sanitizeLog(str) {
  if (typeof str !== 'string') return String(str)
  return str.replace(/[\r\n\t]/g, ' ').substring(0, 200)
}

// --- WebSocket per-client rate limiting ---
const WS_RATE_LIMIT_MAX = 120 // messages per window
const WS_RATE_LIMIT_WINDOW_MS = 60 * 1000
const wsRateLimitMap = new Map()

function isWsRateLimited(clientId) {
  const now = Date.now()
  const entry = wsRateLimitMap.get(clientId)

  if (!entry || now - entry.windowStart > WS_RATE_LIMIT_WINDOW_MS) {
    wsRateLimitMap.set(clientId, { count: 1, windowStart: now })
    return false
  }

  entry.count++
  return entry.count > WS_RATE_LIMIT_MAX
}

// --- TTL cleanup for stale rooms, matches, and WS rate limit entries ---
setInterval(() => {
  const now = Date.now()

  // Clean up rooms inactive for >24h
  for (const [matchId, room] of rooms.entries()) {
    if (room.clients.size === 0 && now - (room.lastActivity || 0) > ROOM_TTL_MS) {
      rooms.delete(matchId)
      activeMatches.delete(matchId)
      console.log(`🧹 TTL cleanup: removed stale room ${matchId}`)
    }
  }

  // Clean up WS rate limit entries
  for (const [id, entry] of wsRateLimitMap.entries()) {
    if (now - entry.windowStart > WS_RATE_LIMIT_WINDOW_MS * 2) {
      wsRateLimitMap.delete(id)
    }
  }
}, 15 * 60 * 1000) // Every 15 minutes

const MAX_BODY_SIZE = 1024 * 1024 // 1MB
const MAX_MATCH_BODY_SIZE = 5 * 1024 * 1024 // 5MB for match data with email
// A whole match backup (match + sets + up to 20000 events) for /api/match/restore
const MAX_RESTORE_BODY_SIZE = 16 * 1024 * 1024

// iCal feed configuration for Swiss VolleyManager
const ICAL_FEEDS = {
  SV: {
    national: true,
    leagues: {
      '1LD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/ae02358a6a06486238124a59f1449e8a82606f70', gender: 'women' },
      '1LM': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/c0bef7b2b63c41841fd9857fb641a0384f126b50', gender: 'men' }
    }
  },
  SVRZ: {
    national: false,
    leagues: {
      '2LD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/845ac49df3bd9411aa3094ec5fb58c934c3351a3', gender: 'women' },
      '2LM': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/10d3dbb456d62789fbb5f324d6b2977fa31a2142', gender: 'men' },
      '3LD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/64059c25792dea0dc30d5d9f63d17a5a8b4030a4', gender: 'women' },
      '3LM': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/06dbdddc56b1792558dcc02e00db9d5eb35197d9', gender: 'men' },
      '4LD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/fdff38685c5166350b903f1238e7510185f8bbcc', gender: 'women' },
      '4LM': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/7fe2162c7ce91df5ab10dc3466fb6252315b25a4', gender: 'men' },
      '5LD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/52e4678e8e476857aeb96b45c8c953fa4c1da1d8', gender: 'women' },
      'U23D-1': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/ae87559b2b0ccb924e5f4c8a12299fdbd2946623', gender: 'women', level: 'U23' },
      'U23D-2': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/2876c11fa736b4b88eb1f3038a37e075563e515e', gender: 'women', level: 'U23' },
      'U23D-3': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/82e03b16627e47d941e2d95a3d5e8a0d1bcc8249', gender: 'women', level: 'U23' },
      'U23M': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/1bb02aaf2b8acad94d5d440c6ce44fb6fa4eb3c5', gender: 'men', level: 'U23' },
      'ZCD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/e0567aa2b79236b9dc5bf69b575e537beb670ec4', gender: 'women', cup: true },
      'ZCM': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/749f56450d476e450c5391106b95d151a0b53ee9', gender: 'men', cup: true }
    }
  }
}

// Cache for iCal data (5 minute TTL)
const icalCache = new Map()
const ICAL_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Helper functions for iCal parsing
function extractGameNumber(uid) {
  const match = uid?.match(/game-(\d+)/)
  return match ? match[1] : ''
}

function extractCity(location) {
  if (!location) return ''
  // Match pattern: "..., POSTCODE CITY" where POSTCODE is 4 digits for Switzerland
  const match = location.match(/,\s*(\d{4})\s+(.+)$/)
  if (match) {
    return match[2].trim()
  }
  // Fallback: return everything after last comma
  const parts = location.split(',')
  if (parts.length > 1) {
    return parts[parts.length - 1].trim()
  }
  return location
}

function parseIcalDescription(description) {
  if (!description) return {}
  const data = {}
  const lines = description.split(/\\n|\n/)

  for (const line of lines) {
    if (line.includes('Risultato:')) {
      data.result = line.replace(/.*Risultato:\s*/, '').trim()
    }
    if (line.includes('Lega:')) {
      // Parse: "#6655 | 3L | ♀"
      const legaMatch = line.match(/#(\d+)\s*\|\s*([^|]+)\s*\|\s*([♂♀])/)
      if (legaMatch) {
        data.leagueId = legaMatch[1]
        data.leagueName = legaMatch[2].trim()
        data.genderSymbol = legaMatch[3]
      }
    }
    if (line.includes('Palestra:')) {
      data.venue = line.replace(/.*Palestra:\s*/, '').trim()
    }
    if (line.includes('Indirizzo:')) {
      data.address = line.replace(/.*Indirizzo:\s*/, '').trim()
    }
  }

  return data
}

async function fetchAndParseIcal(feedUrl, federation, leagueCode, leagueConfig) {
  // Check cache first
  const cacheKey = `${federation}-${leagueCode}`
  const cached = icalCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < ICAL_CACHE_TTL) {
    console.log(`[iCal] Using cached data for ${cacheKey}`)
    return cached.matches
  }

  console.log(`[iCal] Fetching fresh data for ${cacheKey} from ${feedUrl}`)

  try {
    const events = await Promise.race([
      ical.fromURL(feedUrl),
      new Promise((_, reject) => setTimeout(() => reject(new Error('iCal fetch timeout')), 15000))
    ])
    const now = new Date()
    now.setHours(0, 0, 0, 0) // Start of today

    const matches = []

    for (const [key, event] of Object.entries(events)) {
      if (event.type !== 'VEVENT') continue

      // Skip past events
      const startDate = event.start
      if (!startDate || startDate < now) continue

      // Parse SUMMARY for teams: "Home Team - Away Team (League)"
      const summaryMatch = event.summary?.match(/^(.+?)\s*-\s*(.+?)\s*\(([^)]+)\)$/)
      const home = summaryMatch?.[1]?.trim() || ''
      const away = summaryMatch?.[2]?.trim() || ''
      const leagueInSummary = summaryMatch?.[3]?.trim() || ''

      // Parse DESCRIPTION for structured data
      const parsedDesc = parseIcalDescription(event.description)

      // Determine match type
      const isCup = leagueConfig.cup === true || leagueCode.startsWith('ZC')
      const isNational = ICAL_FEEDS[federation]?.national === true
      const isU23 = leagueConfig.level === 'U23' || leagueCode.includes('U23')

      matches.push({
        gameN: extractGameNumber(event.uid),
        dtstart: startDate.toISOString(),
        home,
        away,
        league: parsedDesc.leagueName || leagueInSummary || leagueCode,
        venue: parsedDesc.venue || '',
        city: extractCity(event.location),
        address: event.location || '',
        type1: isCup ? 'cup' : 'championship',
        type2: leagueConfig.gender,
        type3: isU23 ? 'U23' : 'senior',
        championshipType: isNational ? 'national' : 'regional',
        result: parsedDesc.result || '-'
      })
    }

    // Sort by date ascending
    matches.sort((a, b) => new Date(a.dtstart) - new Date(b.dtstart))

    // Cache the results
    icalCache.set(cacheKey, {
      matches,
      timestamp: Date.now()
    })

    console.log(`[iCal] Parsed ${matches.length} upcoming matches for ${cacheKey}`)
    return matches
  } catch (err) {
    console.error(`[iCal] Error fetching ${feedUrl}:`, err.message)
    throw err
  }
}

// CORS: the trusted origins (lib/cors.js; manager.openvolley.app included)
const { getCorsOrigin } = createOriginPolicy({ isCloud: IS_CLOUD, publicOrigins: PUBLIC_ORIGINS })

// connect-src for pages this server serves itself (same-origin bundle).
// No *.supabase.co any more: realtime runs over this server's own socket.
const CLOUD_CONNECT_SRC = [
  "'self'",
  'https://*.openvolley.app',
  'wss://*.openvolley.app',
  ...PUBLIC_ORIGINS,
  ...PUBLIC_ORIGINS.filter(o => o.startsWith('https://')).map(o => 'wss://' + o.slice('https://'.length))
].join(' ')

// --- Health ------------------------------------------------------------------
// /health/live: process is up (Docker healthcheck). Never touches the database.
// /health:      monitors. DATABASE_URL mode: db ping, catalog, storage sentinel,
//               free space (floor), last backup age, socket pools, account-email
//               counters (mail). 503 when the
//               db, catalog, floor, sentinel or backup is not ok. Cached for 2 s.
//               Full body for internal callers only (isInternalCaller).
const HEALTH_CACHE_MS = 2000
const HEALTH_DB_TIMEOUT_MS = 3000
let healthCache = null // { at, status, body }
let healthInFlight = null

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); timer.unref?.() })
  ]).finally(() => clearTimeout(timer))
}

async function readLastBackup() {
  try {
    const text = (await readFile(join(STATUS_DIR, 'last_backup'), 'utf8')).trim().split(/\s+/)[0]
    const at = Date.parse(text)
    if (!Number.isFinite(at)) return { lastBackupAt: null, lastBackupAgeMin: null }
    return { lastBackupAt: new Date(at).toISOString(), lastBackupAgeMin: Math.max(0, Math.floor((Date.now() - at) / 60000)) }
  } catch {
    return { lastBackupAt: null, lastBackupAgeMin: null }
  }
}

/** 'ok' | 'stale' | 'unknown' (no readable last_backup), or 'unchecked' when BACKUP_MAX_AGE_HOURS=0. */
function backupState(lastBackupAgeMin) {
  if (BACKUP_MAX_AGE_HOURS === 0) return 'unchecked'
  if (lastBackupAgeMin == null) return 'unknown'
  return lastBackupAgeMin <= BACKUP_MAX_AGE_HOURS * 60 ? 'ok' : 'stale'
}

function relayStats() {
  return {
    connections: { role: connections.size, live: realtimeHub ? realtimeHub.stats().sockets : 0 },
    activeRooms: rooms.size
  }
}

async function computeCloudHealth() {
  const body = { status: 'ok', mode: 'cloud', uptime: process.uptime(), db: 'down', catalog: { ok: false, tables: 0 } }
  let layer = null
  try {
    layer = await getDataLayer()
  } catch (err) {
    body.status = 'down'
    body.error = 'data layer failed to load'
    console.error('[Health] data layer:', err.message)
  }
  if (layer) {
    try {
      body.db = (await withTimeout(layer.db.ping(), HEALTH_DB_TIMEOUT_MS, 'db ping')) ? 'ok' : 'down'
    } catch {
      body.db = 'down'
    }
    if (body.db === 'ok') {
      try { await withTimeout(layer.db.ensureCatalog(), HEALTH_DB_TIMEOUT_MS, 'catalog') } catch { /* reported below */ }
    }
    const cat = layer.db.catalogStatus()
    body.catalog = { ok: !!cat.ok, tables: cat.tables ?? 0, loadedAt: cat.loadedAt ?? null }
    const st = await layer.storage.health()
    body.sentinel = st.sentinel ? 'ok' : 'missing'
    body.storageWritable = !!st.storageWritable
    body.diskFreeMB = st.diskFreeMB
    body.floor = st.lowSpace === true ? 'low' : (st.lowSpace === false ? 'ok' : 'unknown')
  }
  Object.assign(body, await readLastBackup(), relayStats())
  body.backup = backupState(body.lastBackupAgeMin)
  // Account emails (lib/mailer.js): budgets used / dropped this hour, failed
  // sends. Informational: a used-up budget does not make the server unhealthy.
  if (layer?.auth?.mailer?.stats) {
    try { body.mail = layer.auth.mailer.stats() } catch { body.mail = { enabled: null } }
  }
  if (realtimeHub) body.realtime = realtimeHub.stats()
  const healthy = body.db === 'ok' && body.catalog.ok && body.sentinel === 'ok' && body.floor === 'ok' &&
    (body.backup === 'ok' || body.backup === 'unchecked')
  if (!healthy) body.status = 'degraded'
  return { status: healthy ? 200 : 503, body }
}

function cloudHealth() {
  const now = Date.now()
  if (healthCache && now - healthCache.at < HEALTH_CACHE_MS) return Promise.resolve(healthCache)
  healthInFlight ??= computeCloudHealth()
    .then((r) => { healthCache = { at: Date.now(), ...r }; return healthCache })
    .finally(() => { healthInFlight = null })
  return healthInFlight
}

// Create HTTP server
const server = createServer((req, res) => {
  // Enable CORS with proper origin handling
  const cors = getCorsOrigin(req)
  res.setHeader('Access-Control-Allow-Origin', cors.origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  // X-OV-Proto: the client protocol version; /api/db writes and
  // /api/match/restore need >= 2. Without it here every browser write would
  // fail the CORS preflight.
  // X-OV-Match-Token / X-OV-Match-Pin: the PIN-proved match access of the
  // referee/bench apps (GET /api/match/:id, anonymous /api/db reads).
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-OV-Proto, X-OV-Match-Token, X-OV-Match-Pin')
  // X-Request-Id (/api/db): readable by the cross-origin frontend, so a sync
  // error can be matched to the server's rejection log line.
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id')
  if (cors.credentials) res.setHeader('Access-Control-Allow-Credentials', 'true')
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (IS_CLOUD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  // Content Security Policy — emitted in all modes so LAN/self-hosted deployments
  // are not left without a policy. connect-src is widened in non-cloud mode so LAN
  // clients can reach arbitrary same-network IPs.
  const connectSrc = IS_CLOUD
    ? `connect-src ${CLOUD_CONNECT_SRC}`
    : "connect-src 'self' ws: wss: http: https:"
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    connectSrc,
    "font-src 'self'",
    "frame-ancestors 'none'"
  ].join('; '))

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch {
    res.writeHead(400)
    res.end('Bad Request')
    return
  }

  // Liveness (Docker healthcheck): no database, no disk, always cheap.
  if (url.pathname === '/health/live') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }))
    return
  }

  // Health check
  // Proxied (public) callers get only the verdict; the full body (disk space,
  // backup times, socket counts) is for monitors on loopback / the status network.
  if (url.pathname === '/health' && DB_MODE) {
    const detailed = isInternalCaller(req)
    cloudHealth().then(
      (h) => sendJson(res, h.status,
        detailed ? h.body : { status: h.body.status, mode: 'cloud', db: h.body.db, backup: h.body.backup },
        { 'Cache-Control': 'no-store' }),
      (err) => {
        console.error('[Health] failed:', err?.message)
        sendJson(res, 503, { status: 'down', mode: 'cloud' }, { 'Cache-Control': 'no-store' })
      }
    )
    return
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'healthy',
      mode: IS_CLOUD ? 'cloud' : 'local',
      uptime: process.uptime(),
      connections: connections.size,
      activeRooms: rooms.size
    }))
    return
  }

  // Server status
  if (url.pathname === '/api/server/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'online',
      mode: IS_CLOUD ? 'cloud' : 'local',
      wsPort: PORT,
      connections: connections.size,
      matches: activeMatches.size,
      rooms: rooms.size,
      uptime: process.uptime(),
      pocketbase: pbReady ? 'connected' : (POCKETBASE_URL ? 'configured' : 'not_configured')
    }))
    return
  }

  // PocketBase matches list (for restore UI)
  if (url.pathname === '/api/pocketbase/matches' && req.method === 'GET') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, DB_RATE_LIMIT_MAX, 'relay')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ data: [], error: 'Rate limited' }))
      return
    }
    if (!pbReady || !pbClient) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [], error: 'pocketbase_not_available' }))
      return
    }
    ;(async () => {
      try {
        const gameNumber = url.searchParams.get('game_number')
        const sportType = url.searchParams.get('sport_type')
        const filterParams = {}
        const filterParts = []
        if (gameNumber) {
          filterParts.push('game_number = {:gn}')
          filterParams.gn = parseInt(gameNumber)
        }
        if (sportType && /^(indoor|beach)$/.test(sportType)) {
          filterParts.push('sport_type = {:st}')
          filterParams.st = sportType
        }
        const filter = filterParts.length
          ? pbClient.filter(filterParts.join(' && '), filterParams)
          : undefined
        const records = await pbClient.collection('matches').getFullList({
          sort: '-updated_at',
          filter,
          fields: 'id,match_id,external_id,status,sport_type,game_number,updated_at,home_team,away_team,sets'
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: records }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [], error: err.message }))
      }
    })()
    return
  }

  // PocketBase single match (full snapshot for restore)
  if (url.pathname.startsWith('/api/pocketbase/matches/') && req.method === 'GET') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, DB_RATE_LIMIT_MAX, 'relay')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ data: null, error: 'Rate limited' }))
      return
    }
    if (!pbReady || !pbClient) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: null, error: 'pocketbase_not_available' }))
      return
    }
    const matchId = decodeURIComponent(url.pathname.split('/api/pocketbase/matches/')[1])
    if (!matchId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: null, error: 'match_id required' }))
      return
    }
    // The backup's match_data holds every connection PIN. Anonymous callers get
    // it stripped; a restore that presents the match's game PIN gets it whole.
    const proofPin = url.searchParams.get('gamePin')
    const pinIpKey = ipBucketKey(clientIp)
    if (proofPin && isRateLimited(pinIpKey, AUTH_RATE_LIMIT_MAX, 'auth')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ data: null, error: 'Rate limited' }))
      return
    }
    // A game PIN offered here is a guess like any other PIN check: counted in
    // the shared brute-force budget (refunded when it proves the backup).
    if (proofPin && pinFailureLimiter.isLimited(pinIpKey)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '600' })
      res.end(JSON.stringify({ data: null, error: 'Too many failed attempts. Please wait 10 minutes before trying again.' }))
      return
    }
    ;(async () => {
      try {
        const record = await pbClient.collection('matches').getFirstListItem(
          pbClient.filter('match_id = {:id}', { id: String(matchId) })
        )
        const storedPin = gamePinOf(record.match_data)
        const proven = !!(proofPin && storedPin && safeEqualStr(String(proofPin).trim(), storedPin))
        if (proofPin && (proven || !storedPin)) pinFailureLimiter.refund(pinIpKey)
        if (proofPin && storedPin && !proven) {
          // A restore with the wrong game PIN gets a clear refusal, not a
          // silently PIN-less match.
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: null, error: 'Game PIN does not match this backup' }))
          return
        }
        // Without the game PIN: no PINs and no personal data (rosters' dates
        // of birth, officials, signatures), like the relay.
        const data = proven ? record : {
          ...record,
          match_data: publicMatch(record.match_data),
          home_players: publicPeople(record.home_players),
          away_players: publicPeople(record.away_players)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data }))
      } catch (err) {
        if (proofPin) pinFailureLimiter.refund(pinIpKey) // no PIN was compared
        if (err.status === 404) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: null, error: 'Match not found' }))
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: null, error: err.message }))
        }
      }
    })()
    return
  }

  // Validate PIN for referee/bench access
  if (url.pathname === '/api/match/validate-pin' && req.method === 'POST') {
    const ipKey = ipBucketKey(getClientIp(req))
    if (isRateLimited(ipKey, RATE_LIMIT_MAX_REQUESTS, 'default')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ success: false, error: 'Too many attempts. Please wait a minute before trying again.' }))
      return
    }
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
      if (body.length > MAX_BODY_SIZE) {
        req.destroy()
        return
      }
    })
    req.on('end', () => {
      try {
        if (!body || body.trim() === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Empty request body' }))
          return
        }

        const { pin, type = 'referee', sport = 'indoor' } = JSON.parse(body)

        // The sport of the asking app (openbeach: 'beach'); a PIN never finds
        // a room of the other sport. Without it: indoor, as before.
        if (sport !== 'indoor' && sport !== 'beach') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Invalid request' }))
          return
        }

        if (!isValidPin(pin)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Invalid PIN format' }))
          return
        }

        const pinStr = String(pin).trim()

        // The brute-force budget shared with every PIN check (failed guesses
        // per address bucket); a success is refunded below.
        if (pinFailureLimiter.isLimited(ipKey)) {
          sendJson(res, 429, { success: false, error: 'Too many failed attempts. Please wait 10 minutes before trying again.' }, { 'Retry-After': '600' })
          return
        }

        // Search active matches for matching PIN
        let matchFound = null
        for (const [matchId, matchData] of activeMatches.entries()) {
          const match = matchData.match || matchData
          if (!match) continue
          if ((matchData.sportType || 'indoor') !== sport) continue

          let matchPin = null
          if (type === 'referee') {
            matchPin = match.refereePin
          } else if (type === 'homeTeam') {
            matchPin = match.homeTeamPin
          } else if (type === 'awayTeam') {
            matchPin = match.awayTeamPin
          }

          if (matchPin && safeEqualStr(String(matchPin).trim(), pinStr)) {
            let connectionEnabled = true
            if (type === 'referee') {
              connectionEnabled = match.refereeConnectionEnabled === true
            } else if (type === 'homeTeam') {
              connectionEnabled = match.homeTeamConnectionEnabled === true
            } else if (type === 'awayTeam') {
              connectionEnabled = match.awayTeamConnectionEnabled === true
            }

            if (connectionEnabled && match.status !== 'final') {
              matchFound = { ...match, id: matchId }
              break
            }
          }
        }

        if (matchFound) {
          pinFailureLimiter.refund(ipKey)
          console.log(`[API] PIN validated for ${type}: match ${matchFound.id}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          // Strip all PINs from the response — knowing one PIN must not disclose the others.
          res.end(JSON.stringify({
            success: true,
            // A beach answer names its sport (the indoor answer is unchanged)
            match: sport === 'beach' ? { ...publicMatch(matchFound), sportType: 'beach' } : publicMatch(matchFound),
            // Capability for this match's full bundle (relay, GET /api/match/:id)
            token: isTokenRole(type) ? matchTokens.issue({ matchKey: String(matchFound.id), role: type, pin: pinStr }) : null
          }))
        } else {
          console.log(`[API] PIN validation failed for ${type}`)
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: false,
            error: 'No match found with this PIN. Make sure the main scoresheet is running and connected.'
          }))
        }
      } catch (err) {
        console.error('[API] Error validating PIN:', err)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Invalid request body' }))
      }
    })
    return
  }

  // List the matches scorers currently publish here (ephemeral, this session):
  // every scheduled/live one, whatever its referee connection — display
  // devices (the point-hub LedBox bridge) pick their match from it. Public
  // fields only (relayMatchListRow). Not listed: a match whose scoreboard has
  // been gone longer than the relay holds it for (STALE_TAKEOVER_MS), and on
  // the cloud a test (rehearsal) match: those belong to the venue's relay.
  // The cloud shows a match with the referee connection off only to its own
  // venue's address (cloudListsMatch), never to anonymous callers worldwide.
  // ?finished=1 lists finished matches too: the livescore served by a venue
  // relay (frontend utils/relayLivescore), which then subscribes without a PIN.
  if (url.pathname === '/api/match/list') {
    if (isRateLimited(getClientIp(req), DB_RATE_LIMIT_MAX, 'relay')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ success: false, error: 'Rate limited', matches: [] }))
      return
    }
    try {
      const now = Date.now()
      const requesterIp = getClientIp(req)
      const requesterIpKey = ipBucketKey(requesterIp)
      // ?finished=1: finished matches too (the livescore on a venue relay)
      const includeFinished = url.searchParams.get('finished') === '1'
      const matches = []
      for (const entry of activeMatches.values()) {
        if (IS_CLOUD && entry.match?.test === true) continue
        const owners = ownersOf(entry.matchId)
        if (entry.orphanedAt && now - entry.orphanedAt >= STALE_TAKEOVER_MS && owners.length === 0) continue
        // The cloud: a match without the referee connection only to its own
        // venue (same public address as its scoreboard), see cloudListsMatch
        if (IS_CLOUD && !cloudListsMatch({
          refereeConnectionEnabled: entry.match?.refereeConnectionEnabled === true,
          requesterIp,
          requesterIpKey,
          ownerIpKeys: owners.map(c => c.ipKey)
        })) continue
        const row = relayMatchListRow(entry, { includeFinished })
        if (row) matches.push(row)
      }
      const at = (m) => (m.scheduledAt ? new Date(m.scheduledAt).getTime() || 0 : 0)
      matches.sort((a, b) => at(b) - at(a))
      // Polled every few seconds by every referee/bench device: counted in the
      // per-minute [WS] summary, not logged per request.
      relaySummary.count('match-list polls')
      if (LOG_EACH_CONNECTION) {
        console.log(`[API] /api/match/list - Total: ${activeMatches.size}, Listed: ${matches.length}`)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, matches }))
    } catch (error) {
      console.error('[API] Error in /api/match/list:', error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: false,
        error: 'Internal server error',
        matches: []
      }))
    }
    return
  }

  // Get match data by ID
  if (url.pathname.startsWith('/api/match/') &&
      url.pathname !== '/api/match/list' &&
      url.pathname !== '/api/match/validate-pin' &&
      url.pathname !== '/api/match/by-game-number' &&
      url.pathname !== '/api/match/official-check' &&
      req.method === 'GET') {
    if (isRateLimited(getClientIp(req), DB_RATE_LIMIT_MAX, 'relay')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ success: false, error: 'Rate limited' }))
      return
    }
    let matchId = null
    try { matchId = normalizeMatchId(decodeURIComponent(url.pathname.replace('/api/match/', ''))) } catch { /* bad escape */ }

    if (!matchId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: 'Match ID required' }))
      return
    }

    // activeMatches is keyed by String(matchId) everywhere
    const matchData = activeMatches.get(matchId)

    if (matchData) {
      console.log(`[API] /api/match/${matchId} - Found match`)
      // The bundle (rosters, events) only after the PIN step: a match token
      // from the PIN check, or one of the match's PINs. Else the summary.
      let full = tokenGrantsRelay(req.headers['x-ov-match-token'], matchId, matchData.match)
      const offeredPin = req.headers['x-ov-match-pin']
      if (!full && typeof offeredPin === 'string' && offeredPin.trim()) {
        const ipKey = ipBucketKey(getClientIp(req))
        if (pinFailureLimiter.isLimited(ipKey)) {
          sendJson(res, 429, { success: false, error: 'Too many failed attempts. Please wait 10 minutes before trying again.' }, { 'Retry-After': '600' })
          return
        }
        full = pinGrantsAccess(matchData.match, offeredPin)
        if (full) pinFailureLimiter.refund(ipKey)
      }
      const bundle = full ? { access: 'full', ...wireBundle(matchData) } : relaySummaryBundle(matchData)
      // Ensure team objects have the correct format
      const homeTeam = typeof bundle.homeTeam === 'object' && bundle.homeTeam ? bundle.homeTeam : { name: matchData.homeTeam || 'Home' }
      const awayTeam = typeof bundle.awayTeam === 'object' && bundle.awayTeam ? bundle.awayTeam : { name: matchData.awayTeam || 'Away' }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: true,
        // Never PINs; personal data never; rosters/events only with access.
        ...bundle,
        homeTeam,
        awayTeam
      }))
    } else {
      console.log(`[API] /api/match/${sanitizeLog(matchId)} - Match not found (${activeMatches.size} active)`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: false,
        error: 'Match not found. Make sure the main scoresheet is running and connected.'
      }))
    }
    return
  }

  // Who watches a match (tablet status on the scorer, LAN server dashboard).
  // LAN: the full list (ids, IPs, rooms), as before. Cloud: an anonymous
  // caller gets counts only: without matchId the totals, with matchId one
  // entry per watching tablet of THAT match carrying just its role and team
  // (no id, no IP, no connect time, no list of rooms). The detail (ids,
  // connect times) of one match needs that match's PIN or match token
  // (X-OV-Match-Pin / X-OV-Match-Token, as GET /api/match/:id).
  if (url.pathname === '/api/server/connections') {
    if (isRateLimited(getClientIp(req), DB_RATE_LIMIT_MAX, 'relay')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Rate limited' }))
      return
    }
    const matchIdParam = url.searchParams.get('matchId')
    const matchId = matchIdParam ? normalizeMatchId(matchIdParam) : null

    // Cloud: the detail of one match only with its PIN or match token
    let detail = !IS_CLOUD
    if (IS_CLOUD && matchId) {
      const entry = activeMatches.get(matchId)
      detail = tokenGrantsRelay(req.headers['x-ov-match-token'], matchId, entry?.match)
      const offeredPin = req.headers['x-ov-match-pin']
      if (!detail && entry && typeof offeredPin === 'string' && offeredPin.trim()) {
        const ipKey = ipBucketKey(getClientIp(req))
        if (pinFailureLimiter.isLimited(ipKey)) {
          sendJson(res, 429, { error: 'Too many failed attempts. Please wait 10 minutes before trying again.' }, { 'Retry-After': '600' })
          return
        }
        detail = pinGrantsAccess(entry.match, offeredPin)
        if (detail) pinFailureLimiter.refund(ipKey)
      }
    }

    // Dashboard clients (referee, bench, livescore...) - not the scoreboard
    const watchers = []
    connections.forEach((client) => {
      if (!client.role || client.role === 'scoreboard') return
      if (matchId && String(client.matchId) !== String(matchId)) return
      watchers.push(client)
    })
    // A PIN-verified role wins over the subscribe-match label
    const roleOf = (client) => client.role === 'subscriber' && client.device ? client.device : client.role
    const refereesCount = watchers.filter(c => roleOf(c) === 'referee').length
    const benchCount = watchers.filter(c => roleOf(c) === 'bench').length

    let clients
    if (detail) {
      clients = watchers.map((client) => ({
        id: client.id,
        // LAN scorers see which tablet is which; a public cloud relay must
        // not hand every client's IP to anonymous callers.
        ip: IS_CLOUD ? null : client.ip,
        role: roleOf(client),
        team: client.team || client.deviceTeam,
        matchId: client.matchId,
        connectedAt: client.connectedAt
      }))
    } else if (matchId) {
      // Counts, in the shape the scorer's tablet status reads (role, team)
      clients = watchers.map((client) => ({ role: roleOf(client), team: client.team || client.deviceTeam || null, matchId: client.matchId }))
    } else {
      clients = []
    }

    const body = {
      access: detail ? 'detail' : 'counts',
      totalClients: connections.size,
      dashboardClients: watchers.length,
      referees: refereesCount,
      benches: benchCount,
      clients
    }
    if (!IS_CLOUD) {
      // Watchers only, like the LAN relays (the scoreboard's sockets are room members too)
      body.matchSubscriptions = Object.fromEntries(
        Array.from(rooms.entries()).map(([roomId, room]) => [
          roomId,
          [...room.clients].filter((id) => connections.get(id)?.role !== 'scoreboard').length
        ])
      )
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }

  // Contact/Support form endpoint
  if (url.pathname === '/api/contact' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, CONTACT_RATE_LIMIT_MAX, 'contact')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ success: false, error: 'Too many requests. Please wait before submitting again.' }))
      return
    }
    // Parse multipart form data (simplified - just log for now, email via mailto fallback)
    let body = ''
    const chunks = []
    let totalSize = 0
    req.on('data', chunk => {
      totalSize += chunk.length
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks)
        const contentType = req.headers['content-type'] || ''

        // Extract form data
        let formData = {}
        if (contentType.includes('multipart/form-data')) {
          // Simple multipart parser for text fields only
          const boundary = contentType.split('boundary=')[1]
          if (boundary) {
            const parts = buffer.toString().split('--' + boundary)
            parts.forEach(part => {
              const nameMatch = part.match(/name="([^"]+)"/)
              if (nameMatch && !part.includes('filename=')) {
                const name = nameMatch[1]
                const valueMatch = part.split('\r\n\r\n')
                if (valueMatch[1]) {
                  formData[name] = valueMatch[1].replace(/\r\n--$/, '').trim()
                }
              }
            })
          }
        } else {
          try {
            formData = JSON.parse(buffer.toString())
          } catch {
            formData = {}
          }
        }

        // Validate email to prevent header injection
        if (formData.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email) || /[\r\n]/.test(formData.email))) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Invalid email address' }))
          return
        }

        console.log('[Contact] Received feedback:', {
          contactType: sanitizeLog(formData.contactType),
          area: sanitizeLog(formData.area),
          supportType: sanitizeLog(formData.supportType),
          severity: sanitizeLog(formData.severity),
          email: sanitizeLog(formData.email),
          comments: sanitizeLog(formData.comments?.substring(0, 100)),
          timestamp: formData.timestamp
        })

        // Sanitize all form fields to prevent CRLF/header injection in email
        const sanitizeField = (str, maxLen = 500) =>
          typeof str === 'string' ? str.replace(/[\r\n]/g, ' ').substring(0, maxLen).trim() : String(str || '')

        // Build email content
        const contactEmail = process.env.CONTACT_EMAIL || 'support@openvolley.app'
        const typeLabels = { support: 'Support', feedback: 'Feedback', request: 'Feature Request' }
        const supportTypeLabels = { bug: 'Bug Report', help: 'Help / Question' }
        const severityLabels = {
          '1': '1 - Tool breaks completely',
          '2': '2 - Very limited functionality',
          '3': '3 - Inconvenience',
          '4': '4 - Nice-to-have'
        }

        const safeContactType = sanitizeField(formData.contactType, 50)
        const safeArea = sanitizeField(formData.area, 100)
        const safeSupportType = sanitizeField(formData.supportType, 50)
        const safeSeverity = sanitizeField(formData.severity, 10)
        const safeComments = sanitizeField(formData.comments, 5000)
        const safeUrl = sanitizeField(formData.url, 500)
        const safeUserAgent = sanitizeField(formData.userAgent, 300)

        const subject = `[eScoresheet ${(typeLabels[safeContactType] || safeContactType).toUpperCase()}] ${safeArea}${safeSupportType ? ` - ${supportTypeLabels[safeSupportType] || safeSupportType}` : ''}`

        const emailBody = `
New ${typeLabels[safeContactType] || safeContactType} from eScoresheet

Contact Type: ${typeLabels[safeContactType] || safeContactType}
Area: ${safeArea}
${safeSupportType ? `Support Type: ${supportTypeLabels[safeSupportType] || safeSupportType}\n` : ''}${safeSeverity ? `Severity: ${severityLabels[safeSeverity] || safeSeverity}\n` : ''}
From: ${formData.email}
URL: ${safeUrl || 'N/A'}
User Agent: ${safeUserAgent || 'N/A'}
Timestamp: ${formData.timestamp || new Date().toISOString()}

Comments:
${safeComments || 'No comments provided'}
`.trim()

        // Send email if configured
        if (emailTransporter) {
          try {
            // Send to contact email
            await emailTransporter.sendMail({
              from: process.env.SMTP_USER,
              to: contactEmail,
              replyTo: formData.email,
              subject: subject,
              text: emailBody
            })

            // Send confirmation copy to user
            if (formData.email) {
              const confirmationBody = `
Thank you for contacting eScoresheet support!

This is a confirmation that your message has been received. I'll review it as soon as possible and will contact you if I have any questions.

--- Your message ---
${emailBody}
---

Best regards,
Luca
eScoresheet Developer
`.trim()

              await emailTransporter.sendMail({
                from: process.env.SMTP_USER,
                to: formData.email,
                subject: `Re: ${subject} - Message Received`,
                text: confirmationBody
              })
            }

            console.log('[Contact] Emails sent successfully')
          } catch (emailErr) {
            console.error('[Contact] Failed to send email:', emailErr)
            // Continue anyway - the form data is logged
          }
        } else {
          console.log('[Contact] Email not configured (SMTP_HOST with SMTP_LEGACY_ROUTES=1 not set). Form data logged only.')
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          message: 'Feedback received. Thank you!'
        }))
      } catch (err) {
        console.error('[Contact] Error processing form:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: false,
          error: 'Failed to process feedback'
        }))
      }
    })
    return
  }

  // Send match info email
  if (url.pathname === '/api/match/send-info' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, EMAIL_RATE_LIMIT_MAX, 'email')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > MAX_MATCH_BODY_SIZE) {
        req.destroy()
        return
      }
    })
    req.on('end', async () => {
      try {
        const matchData = JSON.parse(body)

        if (!isValidEmail(matchData.email)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Invalid email address' }))
          return
        }

        console.log('[Match Email] Sending match info to:', sanitizeLog(matchData.email))

        // Check if any email method is configured
        const hasResend = !!process.env.RESEND_API_KEY
        const hasSmtp = !!emailTransporter

        if (!hasResend && !hasSmtp) {
          console.log('[Match Email] ERROR: No email method configured (need RESEND_API_KEY or SMTP)')
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: false,
            error: 'Email not configured on server'
          }))
          return
        }

        // Format date and time
        const formatDate = (dateStr) => {
          if (!dateStr) return 'TBD'
          const [year, month, day] = dateStr.split('-')
          return `${day}.${month}.${year}`
        }

        const formatTime = (timeStr) => {
          if (!timeStr) return 'TBD'
          return timeStr.substring(0, 5) // HH:MM
        }

        // Build email content
        const subject = `Game ${matchData.gameN || 'N/A'} eScoresheet`

        const emailBody = `
Match Information
=================

Game Number: ${matchData.gameN || 'N/A'}
Game PIN: ${matchData.gamePin}

Teams
-----
Home: ${matchData.home || 'N/A'}${matchData.homeShortName ? ` (${matchData.homeShortName})` : ''}
Away: ${matchData.away || 'N/A'}${matchData.awayShortName ? ` (${matchData.awayShortName})` : ''}

Match Details
-------------
Date: ${formatDate(matchData.date)}
Time: ${formatTime(matchData.time)}
Venue: ${matchData.hall || 'N/A'}
City: ${matchData.city || 'N/A'}
League: ${matchData.league || 'N/A'}

---
Generated by eScoresheet
`.trim()

        // Send email - try Resend first (HTTPS), then SMTP as fallback
        if (hasResend) {
          console.log('[Match Email] Using Resend API...')
          await sendViaResend(matchData.email, subject, emailBody)
        } else {
          console.log('[Match Email] Using SMTP...')
          await emailTransporter.sendMail({
            from: process.env.SMTP_USER,
            to: matchData.email,
            subject: subject,
            text: emailBody
          })
        }

        console.log('[Match Email] Sent successfully to:', matchData.email)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          message: 'Match info sent to email'
        }))
      } catch (err) {
        console.error('[Match Email] Error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: false,
          error: 'Failed to send email'
        }))
      }
    })
    return
  }

  // POST /api/verify-reopen-password was removed (db/007): reopening a closed
  // match is an admin action (POST /api/admin/matches/:id/reopen, audit-logged).

  // Get official matches from iCal feeds
  if (url.pathname === '/api/official-matches' && req.method === 'GET') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, ICAL_RATE_LIMIT_MAX, 'ical')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    const federation = url.searchParams.get('federation')
    const league = url.searchParams.get('league')

    // Validate federation
    if (!federation || !ICAL_FEEDS[federation]) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: false,
        error: 'Invalid federation. Use SV or SVRZ.'
      }))
      return
    }

    // Validate league
    const leagueConfig = ICAL_FEEDS[federation].leagues[league]
    if (!league || !leagueConfig) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: false,
        error: `Invalid league for ${federation}. Available: ${Object.keys(ICAL_FEEDS[federation].leagues).join(', ')}`
      }))
      return
    }

    // Use async IIFE since the request handler isn't async
    ;(async () => {
      try {
        const matches = await fetchAndParseIcal(leagueConfig.url, federation, league, leagueConfig)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          federation,
          league,
          matches
        }))
      } catch (err) {
        console.error('[API] Error fetching official matches:', err)
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: false,
          error: 'Failed to fetch matches from VolleyManager. Please try again.'
        }))
      }
    })()
    return
  }

  // Get available leagues for official matches (flat list)
  if (url.pathname === '/api/official-matches/leagues' && req.method === 'GET') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, ICAL_RATE_LIMIT_MAX, 'ical')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    const leagues = []
    for (const [federation, config] of Object.entries(ICAL_FEEDS)) {
      for (const [leagueCode, leagueConfig] of Object.entries(config.leagues)) {
        leagues.push({
          code: leagueCode,
          gender: leagueConfig.gender,
          federation: federation,
          level: leagueConfig.level || 'senior',
          cup: leagueConfig.cup || false
        })
      }
    }

    // Sort leagues: by gender (men first), then by code
    leagues.sort((a, b) => {
      if (a.gender !== b.gender) return a.gender === 'men' ? -1 : 1
      return a.code.localeCompare(b.code)
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      success: true,
      leagues
    }))
    return
  }

  // ==================== DATA ENDPOINTS (self-hosted Postgres) ====================
  // /api/db, /api/match/restore*, /api/match/validate-connection-pin,
  // /api/storage/*, /api/auth/*. They need DATABASE_URL; without it (LAN relay,
  // desktop binary) they answer 503, as the old Supabase proxy did when it was
  // not configured.
  const TOO_MANY = { data: null, error: { message: 'Too many requests', code: 'OV_RATE_LIMITED' } }
  const sendTooMany = (body = TOO_MANY, retryAfter = '60') => sendJson(res, 429, body, { 'Retry-After': retryAfter })
  const sendNoDb = (body = { data: null, error: { message: 'Database not configured on server', code: 'OV_DB_NOT_CONFIGURED' } }) => sendJson(res, 503, body)
  const sendLayerError = (where, err, body = { data: null, error: { message: 'Service unavailable', code: 'OV_DB_UNAVAILABLE', retryable: true } }) => {
    console.error(`[${where}] error:`, err?.message || err)
    sendJson(res, 503, body)
  }

  // Server-side connection-PIN validation. The PIN is compared server-side and
  // never returned to the client. Reads run as trusted server code (internal:
  // no redaction of connection_pins), never through the client contract.
  if (url.pathname === '/api/match/validate-connection-pin' && req.method === 'POST') {
    // IPv6 callers are keyed by /64: one subscriber holds a whole /64.
    const ipKey = ipBucketKey(getClientIp(req))
    const tooMany = { success: false, error: 'Too many attempts. Please wait a minute before trying again.' }
    if (isRateLimited(ipKey, PIN_IP_RATE_LIMIT_MAX, 'pinIp')) {
      sendTooMany(tooMany)
      return
    }
    if (!DB_MODE) {
      sendNoDb({ success: false, error: 'Database not configured on server' })
      return
    }
    ;(async () => {
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendBodyError(res, err, { invalidBody: { success: false, error: 'Invalid request' }, tooLargeBody: { success: false, error: 'Invalid request' } })
        return
      }
      try {
        // sport: 'indoor' (default, the OpenVolley apps) or 'beach' (openbeach).
        // A PIN only ever finds a match of the sport asked for.
        const { pin, type = 'referee', matchExternalId, sport = 'indoor' } = body || {}
        // Own bucket per IP + PIN type, so a venue NAT validating several
        // device kinds is not starved by one bucket. (A client-sent match id is
        // not part of the key: it would only hand an attacker fresh buckets.)
        if (isRateLimited(`${ipKey}|${String(type).slice(0, 20)}`, PIN_RATE_LIMIT_MAX, 'pin')) {
          sendTooMany(tooMany)
          return
        }
        if (!isValidPin(pin)) {
          sendJson(res, 400, { success: false, error: 'Invalid PIN format' })
          return
        }
        // pinKeys: the connection_pins keys that may hold this PIN type;
        // enabledKey null => no enable flag gates it (upload PINs). See
        // lib/matchAccess.js CONNECTION_PIN_TYPES.
        const cfg = connectionPinType(sport, type)
        const isBeach = sport === 'beach'
        const matchFilter = matchExternalId === undefined || matchExternalId === null ? null : matchExternalId
        if (!cfg || (matchFilter !== null && (typeof matchFilter !== 'string' || !matchFilter || matchFilter.length > 128))) {
          sendJson(res, 400, { success: false, error: 'Invalid request' })
          return
        }
        // The brute-force budget: failed guesses per IP (/64). isLimited counts
        // this attempt up front (parallel guesses cannot all slip through);
        // a success or a server error is refunded below.
        if (pinFailureLimiter.isLimited(ipKey)) {
          sendTooMany({ success: false, error: 'Too many failed attempts. Please wait 10 minutes before trying again.' }, '600')
          return
        }
        let counted = true
        const refund = () => { if (counted) { counted = false; pinFailureLimiter.refund(ipKey) } }
        res.once('finish', () => { if (res.statusCode !== 404) refund() })
        const pinStr = String(pin).trim()
        const layer = await getDataLayer()
        const { status, body: out } = await layer.db.runQuery({
          table: 'matches',
          action: 'select',
          params: {
            columns: isBeach
              ? 'id, external_id, game_n, status, scheduled_at, team1_data, team2_data, connections, connection_pins'
              : 'id, external_id, game_n, status, scheduled_at, home_team, away_team, connections, connection_pins',
            filters: [
              { type: 'in', column: 'status', value: ['setup', 'live'] },
              { type: 'eq', column: 'sport_type', value: isBeach ? 'beach' : 'indoor' },
              // Optional: the match the caller is about to write to (roster
              // upload). The PIN must then belong to THAT match, not any.
              ...(matchFilter !== null ? [{ type: 'eq', column: 'external_id', value: matchFilter }] : [])
            ],
            order: [{ column: 'scheduled_at', ascending: false, nullsFirst: false }]
          }
        }, { internal: true, maxRows: PIN_SCAN_MAX_ROWS })
        if (status !== 200) {
          sendJson(res, 500, { success: false, error: 'Validation failed' })
          return
        }
        const data = out.data
        // constant time; the stored PIN may be hashed (lib/pinHash.js, hashed
        // under its connection_pins key): the typed PIN's hash is computed
        // once per key for the whole scan
        const pinMatchers = cfg.pinKeys.map((k) => [k, layer.pins.matcher(k, pinStr)])
        const matchRow = (data || []).find(m => {
          const pins = m.connection_pins || {}
          const conns = m.connections || {}
          if (cfg.enabledKey && !conns[cfg.enabledKey]) return false
          return pinMatchers.some(([k, matches]) => matches(pins[k]))
        })
        if (!matchRow) {
          sendJson(res, 404, { success: false, error: 'Invalid PIN code' })
          return
        }
        const conns = matchRow.connections || {}
        // Capability for this match (relay bundle, GET /api/match/:id, its
        // rosters on anonymous /api/db reads), see lib/matchAccess.js
        // (none for the upload PINs: the Upload Roster app reads nothing with it)
        const token = matchRow.external_id && isTokenRole(type) ? matchTokens.issue({ matchKey: matchRow.external_id, role: type, matchUuid: matchRow.id, pin: pinStr }) : null
        if (isBeach) {
          // openbeach's names: teams are team1 / team2 (matches.team1_data / team2_data)
          sendJson(res, 200, {
            success: true,
            token,
            match: {
              id: matchRow.external_id || matchRow.id,
              sportType: 'beach',
              gameNumber: matchRow.game_n || matchRow.external_id,
              status: matchRow.status,
              scheduledAt: matchRow.scheduled_at,
              refereeConnectionEnabled: conns.referee_enabled,
              team1TeamConnectionEnabled: conns.team1_bench_enabled === true,
              team2TeamConnectionEnabled: conns.team2_bench_enabled === true,
              team1Team: matchRow.team1_data?.name || 'Team 1',
              team2Team: matchRow.team2_data?.name || 'Team 2',
              team1TeamColor: matchRow.team1_data?.color,
              team2TeamColor: matchRow.team2_data?.color
            }
          })
          return
        }
        sendJson(res, 200, {
          success: true,
          token,
          match: {
            id: matchRow.external_id || matchRow.id,
            gameNumber: matchRow.game_n || matchRow.external_id,
            status: matchRow.status,
            scheduledAt: matchRow.scheduled_at,
            refereeConnectionEnabled: conns.referee_enabled,
            homeTeamConnectionEnabled: conns.home_bench_enabled === true,
            awayTeamConnectionEnabled: conns.away_bench_enabled === true,
            homeTeam: matchRow.home_team?.name || 'Home',
            awayTeam: matchRow.away_team?.name || 'Away',
            homeTeamColor: matchRow.home_team?.color,
            awayTeamColor: matchRow.away_team?.color
          }
        })
      } catch (err) {
        console.error('[validate-connection-pin] Error:', err.message)
        sendJson(res, 500, { success: false, error: 'Validation failed' })
      }
    })()
    return
  }

  // OpenBeach tournaments, public (lib/beachTournaments.js publicTournament,
  // decision D9): names and countries only, tournaments marked public and no
  // longer in draft. Anonymous, rate-limited per IP, cached 15 s here and in
  // the browser.
  const publicBeach = req.method === 'GET' ? PUBLIC_BEACH_RE.exec(url.pathname) : null
  if (publicBeach) {
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    if (isRateLimited(ipBucketKey(getClientIp(req)), PUBLIC_BEACH_RATE_LIMIT_MAX, 'publicBeach')) {
      sendTooMany()
      return
    }
    ;(async () => {
      try {
        const layer = await getDataLayer()
        const r = await layer.beach.publicTournament({ slug: publicBeach[1] })
        const cache = r.status === 200 ? { 'Cache-Control': 'public, max-age=15' } : { 'Cache-Control': 'no-store' }
        sendJson(res, r.status, r.body, { ...cache, ...(r.status >= 500 ? { 'Retry-After': '5' } : {}) })
      } catch (err) {
        sendLayerError('public-beach', err)
      }
    })()
    return
  }

  // Approved scorers, admin console and saved teams (lib/manageApi.js,
  // docs/scorer-accounts-spec.md section 5): /api/account/redeem-invite,
  // /api/match/official-check, /api/admin/*, /api/saved-teams*, and (db/012)
  // GET /api/me and POST /api/account/join. Every call
  // needs a session; the roles come from the database (lib/access.js). The
  // UI hides what an account may not do, but the check is here.
  const manageFamily = manageFamilyOf(url.pathname)
  if (manageFamily) {
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    const clientIp = getClientIp(req)
    ;(async () => {
      const noStore = { 'Cache-Control': 'no-store' }
      try {
        const layer = await getDataLayer()
        const user = await layer.auth.requireUser(req, res)
        if (!user) return
        const limited = manageFamily === 'officialCheck'
          ? isRateLimited(user.id, OFFICIAL_CHECK_RATE_LIMIT_MAX, 'officialCheck')
          : manageFamily === 'approvalPin'
            ? isRateLimited(user.id, APPROVAL_PIN_RATE_LIMIT_MAX, 'approvalPin')
            : manageFamily === 'approvals'
              ? isRateLimited(user.id, APPROVALS_RATE_LIMIT_MAX, 'approvals')
              : (manageFamily === 'admin' || manageFamily === 'savedTeams' || manageFamily === 'me' || manageFamily === 'join' || manageFamily === 'beach') &&
                isRateLimited(user.id, MANAGE_RATE_LIMIT_MAX, 'manage')
        if (limited) {
          req.resume()
          sendJson(res, 429, TOO_MANY, { 'Retry-After': '60', ...noStore })
          return
        }
        let access
        try {
          access = await layer.access.get(user.id)
        } catch (err) {
          req.resume()
          console.warn('[manage] access check failed:', err?.message)
          sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5', ...noStore })
          return
        }
        // Invite codes: failed attempts per account AND per IP (/64), refunded on success
        const redeemKeys = manageFamily === 'account' ? [`u:${user.id}`, `ip:${ipBucketKey(clientIp)}`] : []
        if (redeemKeys.length) {
          const overUser = redeemLimiter.isLimited(redeemKeys[0])
          const overIp = redeemLimiter.isLimited(redeemKeys[1])
          if (overUser || overIp) {
            req.resume()
            sendJson(res, 429, { data: null, error: { message: 'Too many attempts. Please wait a few minutes.', code: 'OV_TOO_MANY_ATTEMPTS' } }, { 'Retry-After': '600', ...noStore })
            return
          }
        }
        // Approval PIN set/remove (wrong passwords) and approve (wrong PINs):
        // failed attempts per account AND per IP (/64), counted before the
        // body is read; every answer but the failure is refunded.
        const failure = req.method !== 'POST'
          ? null
          : manageFamily === 'approvalPin'
            ? { limiter: approvalPasswordLimiter, code: 'OV_PASSWORD_INVALID', retryAfter: String(APPROVAL_PASSWORD_FAILURES.windowMs / 1000) }
            : manageFamily === 'approvals' && url.pathname === '/api/approvals'
              ? { limiter: approvalPinFailLimiter, code: 'OV_APPROVAL_PIN_INVALID', retryAfter: String(APPROVAL_PIN_FAILURES.windowMs / 1000) }
              : null
        const failureKeys = failure ? [`u:${user.id}`, `ip:${ipBucketKey(clientIp)}`] : []
        if (failure) {
          const overUser = failure.limiter.isLimited(failureKeys[0])
          const overIp = failure.limiter.isLimited(failureKeys[1])
          if (overUser || overIp) {
            req.resume()
            sendJson(res, 429, { data: null, error: { message: 'Too many attempts. Please wait a few minutes.', code: 'OV_TOO_MANY_ATTEMPTS' } }, { 'Retry-After': failure.retryAfter, ...noStore })
            return
          }
        }
        let body = {}
        if (req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'HEAD') {
          try {
            body = await readJsonBody(req)
          } catch (err) {
            if (failure) for (const k of failureKeys) failure.limiter.refund(k)
            sendBodyError(res, err)
            return
          }
        } else {
          req.resume()
        }
        let r
        try {
          r = await layer.manage.route({ method: req.method, pathname: url.pathname, query: url.searchParams, body, user, access, ip: clientIp, lang: String(req.headers['accept-language'] || '').slice(0, 512) })
        } finally {
          if (failure && !(r?.status === 403 && r.body?.error?.code === failure.code)) {
            for (const k of failureKeys) failure.limiter.refund(k)
          }
        }
        if (redeemKeys.length && r.status === 200) for (const k of redeemKeys) redeemLimiter.refund(k)
        if (r.status === 200 && r.changes?.length) publishChanges(r.changes)
        const headers = { ...noStore, ...(r.status >= 500 ? { 'Retry-After': '5' } : {}), ...(r.headers || {}) }
        sendJson(res, r.status, r.body, headers)
      } catch (err) {
        console.error('[manage] error:', err?.message || err)
        sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5', ...noStore })
      }
    })()
    return
  }

  // POST /api/db — the PostgREST-shaped contract of apiClient.js, served by
  // lib/pgQuery.js. Reads are anonymous (secret columns redacted and never
  // filterable; matches without a session: public columns only, see
  // lib/publicColumns.js); writes need a session and X-OV-Proto >= 2; profiles and
  // user_matches are scoped to the caller. Successful writes on matches, sets,
  // events and match_live_state are published to live subscribers.
  if (url.pathname === '/api/db' && req.method === 'POST') {
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    // Request id: echoed as X-Request-Id and printed on every rejection line,
    // so a client-side sync error can be matched to the server log.
    const reqId = newRequestId()
    res.setHeader('X-Request-Id', reqId)
    let logTable = null
    let logAction = null
    // Value-free: never the payload, filters, PINs or tokens.
    const logRejected = (status, code) => logDbRejection(formatDbRejection({ reqId, status, code, table: logTable, action: logAction }), code || `status_${status}`)
    const clientIp = getClientIp(req)
    // Coarse per-IP (/64) bucket before the body (up to MAX_MATCH_BODY_SIZE)
    // is buffered; the per-action buckets below need the parsed body.
    if (isRateLimited(ipBucketKey(clientIp), DB_IP_RATE_LIMIT_MAX, 'dbIp')) {
      logRejected(429, 'OV_RATE_LIMITED')
      sendTooMany()
      return
    }
    ;(async () => {
      let request
      try {
        request = await readJsonBody(req, MAX_MATCH_BODY_SIZE)
      } catch (err) {
        logRejected(err?.code === 'BODY_TOO_LARGE' ? 413 : 400, err?.code === 'BODY_TOO_LARGE' ? 'OV_BODY_TOO_LARGE' : 'OV_INVALID_REQUEST')
        sendBodyError(res, err)
        return
      }
      try {
        const { table, action } = request || {}
        const params = request?.params ?? {}
        if (typeof table !== 'string' || !ALLOWED_TABLES.includes(table) ||
            !['select', 'insert', 'update', 'upsert', 'delete'].includes(action) ||
            params === null || typeof params !== 'object' || Array.isArray(params)) {
          logRejected(400, 'OV_INVALID_REQUEST')
          sendJson(res, 400, { data: null, error: { message: 'Invalid request', code: 'OV_INVALID_REQUEST' } })
          return
        }
        logTable = table
        logAction = action
        const isWrite = action !== 'select'
        const ownerScoped = OWNER_SCOPED_TABLES.has(table)
        if (isWrite
          ? isRateLimited(clientIp, DB_WRITE_IP_RATE_LIMIT_MAX, 'dbWriteIp')
          : isRateLimited(clientIp, DB_READ_RATE_LIMIT_MAX, 'db')) {
          logRejected(429, 'OV_RATE_LIMITED')
          sendTooMany()
          return
        }

        const layer = await getDataLayer()
        // A session is required for any write, and for ALL actions on
        // owner-scoped tables. requireUser answers 401 / 503 itself.
        let authUser = null
        if (isWrite || ownerScoped) {
          authUser = await layer.auth.requireUser(req, res)
          if (!authUser) {
            // requireUser already answered: 401 missing/invalid token, 503 auth
            // down. Same rule as requireUser: no well-formed Bearer token is
            // missing_token, a token that did not verify is invalid_token.
            const status = res.statusCode || 401
            logRejected(status, status === 503 ? 'auth_unavailable' : (bearerFromHeaders(req.headers) ? 'invalid_token' : 'missing_token'))
            return
          }
        }
        if (isWrite && isRateLimited(authUser.id, DB_WRITE_RATE_LIMIT_MAX, 'dbWrite')) {
          logRejected(429, 'OV_RATE_LIMITED')
          sendTooMany()
          return
        }

        // Reference tables: admins write, everyone else reads.
        if (isWrite && (READ_ONLY_TABLES.has(table) || table === REFEREE_DIRECTORY) &&
            !refereeDirectoryWriteAllowed(table, action, params) && !(await isAdminUser(layer, authUser.id))) {
          logRejected(403, 'OV_READ_ONLY_TABLE')
          sendJson(res, 403, { data: null, error: { message: 'This table is read-only for your account', code: 'OV_READ_ONLY_TABLE' } })
          return
        }

        // Anonymous reads of tables with personal data (matches: rosters with
        // dates of birth, signatures, officials; referee_database and
        // svrz_games: referees' dates of birth) get the public columns only
        // (lib/publicColumns.js ANON_DB_COLUMNS), and may filter/order on
        // plain columns only. A signed-in caller reads full referee rows, and
        // full matches / events rows only of the matches it created or edits
        // (an admin: all); other matches' rows get the anonymous projection,
        // and a filter on a non-public column then only matches its own rows
        // (no probing of hidden data). The token is only checked when the
        // request asks for more than the public view, so the scorer's frequent
        // id lookups cost nothing.
        let anonView = false
        let readOwner = null
        // events: who may ask for voided rows too (params.include_voided, lib/pgQuery.js)
        let includeVoided = null
        if (!isWrite && hasAnonPolicy(table)) {
          const check = anonSelectCheck(table, params)
          // Voided events are never public: asking for them needs the session
          const wantsVoided = table === 'events' && params?.include_voided === true
          if (check.needsMore || check.badFilter || wantsVoided) {
            let reader = null
            if (bearerFromHeaders(req.headers)) {
              try {
                reader = await layer.auth.verifyToken(req)
              } catch (err) {
                // Auth database down: a signed-in scorer must not silently get
                // the cut-down row (a read-modify-write of signatures would
                // then wipe them). 503 like requireUser; only a missing or
                // invalid token gets the public view.
                console.error('[auth] verifyToken failed:', err?.message)
                logRejected(503, 'auth_unavailable')
                sendJson(res, 503, { data: null, error: { message: 'Authentication service unavailable. Please try again.', code: 'auth_unavailable', retryable: true } }, { 'Retry-After': '5' })
                return
              }
            }
            if (!reader) {
              if (check.badFilter) {
                logRejected(400, 'OV_SECRET_FILTER')
                sendJson(res, 400, { data: null, error: { message: 'This column cannot be used as a filter without a session', code: 'OV_SECRET_FILTER' } })
                return
              }
              anonView = true
            } else if (MATCH_OWNED_TABLES.has(table) && !(await isAdminUser(layer, reader.id))) {
              readOwner = { userId: reader.id, restrict: !!check.badFilter }
              includeVoided = 'owned'
            } else {
              includeVoided = 'all'
            }
          }
        }

        // Strip columns a client may never write; owner-scoped rows get the
        // caller's user_id (pgQuery's scope forces it as well).
        const sanitizeWriteData = (data) => {
          const deny = WRITE_DENYLIST[table] || []
          const one = (row) => {
            if (!row || typeof row !== 'object') return row
            const clean = { ...row }
            for (const k of deny) delete clean[k]
            if (ownerScoped && authUser) clean.user_id = authUser.id
            return clean
          }
          return Array.isArray(data) ? data.map(one) : one(data)
        }
        const p = { ...params }
        if (p.data !== undefined) p.data = sanitizeWriteData(p.data)
        // PINs at rest (lib/pinHash.js): game_pin / connection_pins values are
        // stored hashed when OV_PIN_SECRET is set.
        if (p.data !== undefined && layer.pins.enabled) {
          p.data = Array.isArray(p.data) ? p.data.map((r) => layer.pins.hashMatchRow(r)) : layer.pins.hashMatchRow(p.data)
        }
        // The roles decide the guard: a database error is 503 (retryable),
        // never a silent "not a scorer".
        let matchOwner
        if (isWrite && MATCH_OWNED_TABLES.has(table)) {
          try {
            matchOwner = await matchOwnerFor(layer, authUser)
          } catch (err) {
            console.warn('[DB] access check failed:', err?.message)
            logRejected(503, 'OV_DB_UNAVAILABLE')
            sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
            return
          }
        }

        // Never an unfiltered update/delete (pgQuery refuses it too). On
        // owner-scoped tables the forced user_id filter is the filter.
        if ((action === 'update' || action === 'delete') && !ownerScoped && !(Array.isArray(p.filters) && p.filters.length > 0)) {
          logRejected(400, 'OV_UNFILTERED_WRITE')
          sendJson(res, 400, { data: null, error: { message: 'A filter is required for update/delete', code: 'OV_UNFILTERED_WRITE' } })
          return
        }

        // One cloud match per official game (db/007): the friendly answer
        // before the write, with who holds the game. Approved scorers only:
        // a pending account gets pgQuery's 403 OV_SCORER_REQUIRED first, so
        // it never sees a scorer's name.
        // An update that moves a match onto another game or season gets the
        // same check (the stored rows with the update over them).
        const officialWrite = (action === 'insert' || action === 'upsert') ? p.data !== undefined : action === 'update'
        if (table === 'matches' && officialWrite && matchOwner && !matchOwner.testOnly) {
          let claim
          try {
            // only the sports the caller can score in: the others get pgQuery's 403 first
            const sports = scoringSportsOf(matchOwner)
            claim = action === 'update'
              ? await layer.accounts.findTakenGameForUpdate({ userId: authUser.id, filters: p.filters, data: p.data, sports })
              : await layer.accounts.findTakenGame({ userId: authUser.id, rows: p.data, sports })
          } catch (err) {
            console.warn('[DB] official-game check failed:', err?.message)
            logRejected(503, 'OV_DB_UNAVAILABLE')
            sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
            return
          }
          if (claim) {
            await layer.accounts.auditGameTaken({ actorId: authUser.id, claim })
            logRejected(409, 'OV_GAME_TAKEN')
            sendJson(res, 409, gameTakenBody(layer, claim))
            return
          }
        }

        const runOpts = {
          proto: req.headers['x-ov-proto'],
          scope: ownerScoped ? { column: 'user_id', value: authUser.id } : undefined,
          matchOwner,
          // the acting account for db/007's triggers (closed_by)
          ...(isWrite ? { actorId: authUser.id } : {}),
          ...(readOwner ? { readOwner } : {}),
          ...(includeVoided ? { includeVoided } : {})
        }
        let r = await layer.db.runQuery({ table, action, params: p }, runOpts)
        // Take-over inline: a scorer's match insert/upsert refused only for
        // ownership (a match set up before ownership existed, or created by
        // another account) that carries the match's own game PIN proves it,
        // like POST /api/match/claim: the account becomes an editor and the
        // write is retried once. Old apps get the take-over without a client
        // change.
        if (r.status === 403 && r.body?.error?.code === 'OV_NOT_MATCH_OWNER' && table === 'matches' &&
            (action === 'insert' || action === 'upsert') && matchOwner && !matchOwner.admin) {
          if (await claimByUpsertPin(layer, authUser.id, params.data, clientIp)) {
            r = await layer.db.runQuery({ table, action, params: p }, runOpts)
          }
        }
        if (table === 'matches' && isWrite) r = await enrichGameTaken(layer, authUser.id, r, p.data, matchOwner)
        if (r.status === 200 && r.changes?.length) {
          publishChanges(r.changes)
          if (table === 'matches') await layer.accounts.auditClaimedGames({ actorId: authUser.id, changes: r.changes })
        }
        // 4xx/5xx from pgQuery (OV_UNSCOPED_EXTERNAL_ID, OV_CLIENT_TOO_OLD,
        // OV_UNSCOPED_WRITE, constraint errors, ...): code only, no details
        // (they can quote row values).
        if (r.status >= 400) logRejected(r.status, r.body?.error?.code)
        // redactSecrets is belt and braces: pgQuery never returns secret columns.
        const redacted = redactSecrets(table, r.body.data)
        // Anonymous: public columns; a match's rosters only with the match
        // token of its PIN check (referee/bench fallback, lib/matchAccess.js).
        // The token is bound to its role: the role's connection must still be on.
        const granted = anonView || readOwner ? matchTokens.verify(req.headers['x-ov-match-token']) : null
        const grantOpts = { grantedExternalId: granted?.m || null, grantRow: (row) => matchTokens.stillGrantsRow(granted, row) }
        const data = anonView ? projectAnonDbRows(table, redacted, grantOpts)
          : readOwner ? projectNonOwnerRows(table, redacted, grantOpts)
            : redacted
        sendJson(res, r.status, { ...r.body, data }, r.status >= 500 ? { 'Retry-After': '5' } : {})
      } catch (err) {
        console.error(`[DB] Error req=${reqId}:`, err.message)
        sendJson(res, 500, { data: null, error: { message: 'Database operation failed', code: 'OV_INTERNAL' } })
      }
    })()
    return
  }

  // Removed with the Supabase proxy: no caller, never worked under service_role.
  if (url.pathname === '/api/db/rpc') {
    sendJson(res, 404, { data: null, error: { message: 'Not found', code: 'OV_REMOVED' } })
    return
  }

  // POST /api/match/restore {match, sets, events, liveState} — a cloud restore
  // in ONE transaction (replaces the client's multi-step upsert/delete/upsert).
  if (url.pathname === '/api/match/restore' && req.method === 'POST') {
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    ;(async () => {
      try {
        const layer = await getDataLayer()
        const user = await layer.auth.requireUser(req, res)
        if (!user) return
        if (isRateLimited(user.id, RESTORE_RATE_LIMIT_MAX, 'restore')) {
          sendTooMany()
          return
        }
        // At most 2 restore bodies (16 MB each, several times that once
        // parsed) in memory at once, a short queue behind them, 503 beyond.
        await restoreGate.run(async () => {
          let body
          try {
            body = await readJsonBody(req, MAX_RESTORE_BODY_SIZE)
          } catch (err) {
            sendBodyError(res, err)
            return
          }
          let matchOwner
          try {
            matchOwner = await matchOwnerFor(layer, user)
          } catch (err) {
            console.warn('[match/restore] access check failed:', err?.message)
            sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
            return
          }
          // One cloud match per official game: the same friendly pre-check as /api/db
          if (!matchOwner.testOnly && body && typeof body === 'object' && body.match && typeof body.match === 'object') {
            let claim
            try {
              claim = await layer.accounts.findTakenGame({ userId: user.id, rows: [body.match], sports: scoringSportsOf(matchOwner) })
            } catch (err) {
              console.warn('[match/restore] official-game check failed:', err?.message)
              sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
              return
            }
            if (claim) {
              await layer.accounts.auditGameTaken({ actorId: user.id, claim })
              sendJson(res, 409, gameTakenBody(layer, claim))
              return
            }
          }
          let r = await layer.restore.restoreMatch(body, { proto: req.headers['x-ov-proto'], matchOwner, actorId: user.id })
          r = await enrichGameTaken(layer, user.id, r, body?.match ? [body.match] : [], matchOwner)
          if (r.status === 200) {
            publishChanges(r.changes)
            await layer.accounts.auditClaimedGames({ actorId: user.id, changes: r.changes })
          }
          sendJson(res, r.status, r.body, r.status >= 500 ? { 'Retry-After': '5' } : {})
        })
      } catch (err) {
        if (err?.code === 'AUTH_BUSY') {
          req.resume() // discard the unread body
          sendJson(res, 503, { data: null, error: { message: 'Server busy, retry shortly', code: 'OV_BUSY', retryable: true } }, { 'Retry-After': '5', Connection: 'close' })
          return
        }
        sendLayerError('match/restore', err)
      }
    })()
    return
  }

  // POST /api/match/event-revisions {match_external_id, revisions} — the undo /
  // delete / edit / restore history of a match's events (lib/eventRevisions.js,
  // db/015): the server voids or edits its copy and keeps the revision.
  // Same owner / editor rule as an /api/db write of the match's events.
  if (url.pathname === '/api/match/event-revisions' && req.method === 'POST') {
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    ;(async () => {
      try {
        const layer = await getDataLayer()
        const user = await layer.auth.requireUser(req, res)
        if (!user) return
        if (isRateLimited(user.id, DB_WRITE_RATE_LIMIT_MAX, 'dbWrite')) {
          req.resume()
          sendTooMany()
          return
        }
        let body
        try {
          body = await readJsonBody(req, EVENT_REVISIONS_MAX_BODY)
        } catch (err) {
          sendBodyError(res, err)
          return
        }
        let matchOwner
        try {
          matchOwner = await matchOwnerFor(layer, user)
        } catch (err) {
          console.warn('[match/event-revisions] access check failed:', err?.message)
          sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
          return
        }
        const r = await layer.revisions.apply({ body, user, matchOwner })
        if (r.status === 200) publishChanges(r.changes)
        sendJson(res, r.status, r.body, r.status >= 500 ? { 'Retry-After': '5' } : {})
      } catch (err) {
        sendLayerError('match/event-revisions', err)
      }
    })()
    return
  }

  // POST /api/match/claim {externalId, pin} — take-over: a signed-in caller who
  // proves the match's game PIN becomes an editor (may write the match from
  // now on). The scorer app calls it when a write comes back
  // OV_NOT_MATCH_OWNER (another account on this device, a restored match).
  if (url.pathname === '/api/match/claim' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, RESTORE_PIN_IP_RATE_LIMIT_MAX, 'restorePin')) {
      sendTooMany()
      return
    }
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    ;(async () => {
      try {
        const layer = await getDataLayer()
        const user = await layer.auth.requireUser(req, res)
        if (!user) return
        let body
        try {
          body = await readJsonBody(req)
        } catch (err) {
          sendBodyError(res, err)
          return
        }
        const r = await layer.restore.claimMatch(body, { userId: user.id, limitKey: layer.ipKey(clientIp) })
        if (r.status === 200 && r.body.data?.role === 'editor') {
          await layer.accounts.auditClaimPin({ actorId: user.id, matchId: r.body.data.id, via: 'claim', role: r.body.data.role })
        }
        sendJson(res, r.status, r.body, r.status === 429 ? { 'Retry-After': '600' } : {})
      } catch (err) {
        sendLayerError('match/claim', err)
      }
    })()
    return
  }

  // POST /api/match/upload-roster {matchExternalId, team, pin, roster,
  // coachSignature?, captainSignature?} — the Upload Roster app's cloud write.
  // Authorised by the team's upload PIN of THAT match (no account: coaches are
  // not the match's scorer, and the ownership guard would refuse them). Writes
  // only connections.pending_{home|away}_roster and the team's coach/captain
  // signatures; the scorer accepts the pending roster in Match Setup.
  if (url.pathname === '/api/match/upload-roster' && req.method === 'POST') {
    const ipKey = ipBucketKey(getClientIp(req))
    if (isRateLimited(ipKey, PIN_IP_RATE_LIMIT_MAX, 'pinIp')) {
      sendTooMany({ success: false, error: 'Too many attempts. Please wait a minute before trying again.' })
      return
    }
    if (!DB_MODE) {
      sendNoDb({ success: false, error: 'Database not configured on server' })
      return
    }
    ;(async () => {
      let body
      try {
        body = await readJsonBody(req, MAX_MATCH_BODY_SIZE)
      } catch (err) {
        sendBodyError(res, err, { invalidBody: { success: false, error: 'Invalid request' }, tooLargeBody: { success: false, error: 'Roster too large' } })
        return
      }
      try {
        const { matchExternalId, team, pin, roster, coachSignature, captainSignature } = body || {}
        if (typeof matchExternalId !== 'string' || !matchExternalId || matchExternalId.length > 128 ||
            (team !== 'home' && team !== 'away') || !isValidPin(pin) ||
            !roster || typeof roster !== 'object' || Array.isArray(roster) ||
            [coachSignature, captainSignature].some((s) => s != null && typeof s !== 'string')) {
          sendJson(res, 400, { success: false, error: 'Invalid request' })
          return
        }
        if (pinFailureLimiter.isLimited(ipKey)) {
          sendTooMany({ success: false, error: 'Too many failed attempts. Please wait 10 minutes before trying again.' }, '600')
          return
        }
        let counted = true
        res.once('finish', () => { if (res.statusCode !== 403 && counted) { counted = false; pinFailureLimiter.refund(ipKey) } })
        const layer = await getDataLayer()
        const pinKey = team === 'home' ? 'upload_home' : 'upload_away'
        const found = await layer.db.runQuery({
          table: 'matches',
          action: 'select',
          params: {
            columns: 'id, status, connection_pins, signatures',
            filters: [{ type: 'eq', column: 'external_id', value: matchExternalId }],
            limit: 1
          }
        }, { internal: true })
        if (found.status !== 200) {
          sendJson(res, 500, { success: false, error: 'Upload failed' })
          return
        }
        const row = found.body.data?.[0]
        if (!row || !layer.pins.matches(pinKey, String(pin).trim(), row.connection_pins?.[pinKey])) {
          sendJson(res, 403, { success: false, error: 'Invalid upload PIN' })
          return
        }
        if (row.status !== 'setup') {
          sendJson(res, 409, { success: false, error: 'The roster of this match is locked (coin toss done)' })
          return
        }
        const pendingKey = team === 'home' ? 'pending_home_roster' : 'pending_away_roster'
        const pending = { ...roster, coachSignature: coachSignature || null, captainSignature: captainSignature || null }
        const data = { connections: { [pendingKey]: pending } } // merged into the stored object (pgQuery mergeJsonColumns)
        const sig = {}
        if (coachSignature) sig[team === 'home' ? 'home_coach' : 'away_coach'] = coachSignature
        if (captainSignature) sig[team === 'home' ? 'home_captain' : 'away_captain'] = captainSignature
        if (Object.keys(sig).length) {
          const stored = row.signatures && typeof row.signatures === 'object' && !Array.isArray(row.signatures) ? row.signatures : {}
          data.signatures = { ...stored, ...sig }
        }
        const r = await layer.db.runQuery({
          table: 'matches',
          action: 'update',
          params: { data, filters: [{ type: 'eq', column: 'id', value: row.id }] }
        }, { internal: true })
        if (r.status !== 200) {
          sendJson(res, r.status >= 500 ? 503 : 500, { success: false, error: 'Upload failed' })
          return
        }
        publishChanges(r.changes)
        sendJson(res, 200, { success: true })
      } catch (err) {
        console.error('[upload-roster] Error:', err.message)
        sendJson(res, 500, { success: false, error: 'Upload failed' })
      }
    })()
    return
  }

  // POST /api/match/restore-by-pin {gameN, pin} — anonymous, exact match on
  // game number AND game PIN, attempt-limited per caller (lib/matchRestore.js).
  if (url.pathname === '/api/match/restore-by-pin' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, RESTORE_PIN_IP_RATE_LIMIT_MAX, 'restorePin')) {
      sendTooMany()
      return
    }
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    ;(async () => {
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendBodyError(res, err)
        return
      }
      try {
        const layer = await getDataLayer()
        // Signed in: proving the game PIN also makes the caller an editor of
        // the match (take-over by a new scoring device). Optional: without a
        // session, or with the auth database down, it is a plain lookup.
        let editorUserId = null
        if (bearerFromHeaders(req.headers)) {
          try { editorUserId = (await layer.auth.verifyToken(req))?.id || null } catch { editorUserId = null }
        }
        const r = await layer.restore.restoreByPin(body, { limitKey: layer.ipKey(clientIp), editorUserId })
        if (r.status === 200 && editorUserId && r.body.data?.access === 'editor') {
          await layer.accounts.auditClaimPin({ actorId: editorUserId, matchId: r.body.data.match?.id, via: 'restore-by-pin' })
        }
        sendJson(res, r.status, r.body, r.status === 429 ? { 'Retry-After': '600' } : {})
      } catch (err) {
        sendLayerError('match/restore-by-pin', err)
      }
    })()
    return
  }

  // POST /api/storage/{upload,download,list} — lib/storage.js on STORAGE_ROOT.
  // signed-url answers 404 (removed). Every call needs a session. Scoresheets
  // (player names, dates of birth, signatures) are read, replaced and listed
  // only by the account that created them (STORAGE_UPLOADER_READ_BUCKETS,
  // default 'scoresheets'; README "Who can read a scoresheet"); a download of
  // a missing object answers 200 with
  // OV_STORAGE_NOT_FOUND (no log/backup yet is normal, not a browser error).
  if (url.pathname.startsWith('/api/storage/') && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, STORAGE_IP_RATE_LIMIT_MAX, 'storage')) {
      sendTooMany()
      return
    }
    if (!DB_MODE) {
      sendNoDb({ data: null, error: { message: 'Storage not configured on server', code: 'OV_STORAGE_NOT_CONFIGURED' } })
      return
    }
    const action = url.pathname.slice('/api/storage/'.length)
    ;(async () => {
      try {
        const layer = await getDataLayer()
        const user = await layer.auth.requireUser(req, res)
        if (!user) return
        let body
        try {
          body = await readJsonBody(req, layer.storage.maxBodyBytes)
        } catch (err) {
          sendBodyError(res, err, { tooLargeBody: layer.storage.bodyTooLarge().body })
          return
        }
        // Scoresheets of official matches: approved scorers only (backups stay
        // open), of the sport of the path (beach/... needs beach scoring rights)
        if (action === 'upload' && body && body.bucket === 'scoresheets') {
          let canScore
          try {
            const a = await layer.access.get(user.id)
            const sport = scoresheetSportOf(body.path)
            canScore = a.apps ? a.apps[sport]?.canScore === true : sport === 'indoor' && a.canScore === true
          } catch (err) {
            console.warn('[Storage] access check failed:', err?.message)
            sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
            return
          }
          if (!canScore) {
            sendJson(res, 403, { data: null, error: { message: 'Your account is not approved for official matches yet', code: 'OV_SCORER_REQUIRED' } })
            return
          }
        }
        const { status, body: out } = await layer.storage.handle(action, body, { userId: user.id })
        sendJson(res, status, out)
      } catch (err) {
        sendLayerError('Storage', err, { data: null, error: { message: 'Storage unavailable', code: 'OV_STORAGE_UNAVAILABLE' } })
      }
    })()
    return
  }

  // POST /api/auth/* — lib/auth.js (auth.users + opaque sessions in
  // auth.app_sessions). It applies its own per-IP / per-email buckets and
  // lockout, so the old 10/min per-IP 'auth' limit (which broke a venue NAT)
  // does not apply here.
  if (url.pathname.startsWith('/api/auth/') && req.method === 'POST') {
    if (!DB_MODE) {
      sendNoDb({ data: null, error: { message: 'Auth not configured', code: 'auth_unavailable' } })
      return
    }
    const clientIp = getClientIp(req)
    const action = url.pathname.slice('/api/auth/'.length)
    ;(async () => {
      let layer
      try {
        layer = await getDataLayer()
      } catch (err) {
        sendLayerError('Auth', err, { data: null, error: { message: 'Authentication is temporarily unavailable', code: 'auth_unavailable' } })
        return
      }
      if (!layer.AUTH_ACTIONS.includes(action)) {
        layer.sendAuthResult(res, { status: 404, body: { data: null, error: { message: 'Invalid request' } } })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendBodyError(res, err, { invalidBody: { data: null, error: { message: 'Invalid request' } } })
        return
      }
      layer.sendAuthResult(res, await layer.auth.handleAuthRequest(action, body, { ip: clientIp, headers: req.headers }))
    })()
    return
  }

  // --- Dynamic landing page (root only) --- (markup: lib/landingPage.js)
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    ;(async () => {
      try {
        const host = req.headers.host || `localhost:${PORT}`
        const baseUrl = `http://${host}`

        // Generate QR codes as inline SVG
        const generateQRCodes = async (roles) => Promise.all(
          roles.map(async (role) => {
            const url = `${baseUrl}${role.path}`
            const svg = await QRCode.toString(url, { type: 'svg', width: 200, margin: 1 })
            return { ...role, url, svg }
          })
        )
        const [indoorQR, beachQR] = await Promise.all([
          generateQRCodes(INDOOR_ROLES),
          generateQRCodes(BEACH_ROLES)
        ])

        // Active matches info
        const matchList = []
        for (const [matchId, matchData] of activeMatches.entries()) {
          // Synced matches store { homeTeam, awayTeam, ... }; the legacy path
          // stored { data: {...} }. Read both so names actually render.
          const d = matchData.data || {}
          const homeName = (typeof matchData.homeTeam === 'object' ? matchData.homeTeam?.name : matchData.homeTeam)
            || d.homeTeamName || d.home_team_name || 'Home'
          const awayName = (typeof matchData.awayTeam === 'object' ? matchData.awayTeam?.name : matchData.awayTeam)
            || d.awayTeamName || d.away_team_name || 'Away'
          matchList.push({
            id: matchId,
            home: homeName,
            away: awayName,
            updatedAt: matchData.updatedAt
          })
        }

        const html = renderLandingPage({
          baseUrl,
          clientCount: connections.size,
          matchCount: activeMatches.size,
          indoor: indoorQR,
          beach: beachQR,
          matches: matchList
        })
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch (err) {
        console.error('[Landing] Error generating landing page:', err.message)
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      }
    })()
    return
  }

  // --- Static file serving (for standalone/local server) ---
  if (HAS_STATIC) {
    const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname
    // Build asset key (strip leading slash)
    let assetKey = pathname.replace(/^\//, '')
    // SPA fallback: /referee → referee/index.html
    if (!extname(assetKey)) {
      const withIndex = assetKey ? `${assetKey}/index.html` : 'index.html'
      if ((HAS_EMBEDDED_ASSETS && embeddedAssetSet.has(withIndex)) ||
          (HAS_STATIC_ON_DISK && existsSync(join(STATIC_DIR, withIndex)))) {
        assetKey = withIndex
      }
    }
    // Handle trailing slash: referee/ → referee/index.html
    if (assetKey.endsWith('/')) {
      assetKey = `${assetKey}index.html`
    }

    // Try embedded SEA assets first
    if (HAS_EMBEDDED_ASSETS && embeddedAssetSet.has(assetKey)) {
      const data = seaGetAsset(assetKey)
      const ext = extname(assetKey)
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': contentType })
      res.end(Buffer.from(data))
      return
    }

    // Fallback to disk (for development / non-SEA usage)
    if (HAS_STATIC_ON_DISK) {
      const filePath = join(STATIC_DIR, assetKey)
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const ext = extname(filePath)
        const contentType = MIME_TYPES[ext] || 'application/octet-stream'
        const content = readFileSync(filePath)
        res.writeHead(200, { 'Content-Type': contentType })
        res.end(content)
        return
      }
    }
  }

  res.writeHead(404)
  res.end('Not Found')
})

// Create WebSocket server. HTTP and WebSocket share one port (PORT): upgrades
// are routed here. `?purpose=live` sockets (DATABASE_URL mode) go to the
// realtime hub's own small-frame, no-deflate server; everything else is a role
// socket (scoreboard/referee/bench/livescore relay) on this one.
const wss = new WebSocketServer({
  noServer: true,
  // Increase limits for match data
  maxPayload: 10 * 1024 * 1024, // 10MB
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024
  }
})

wss.on('error', (err) => {
  // Listen errors (EADDRINUSE) reach server.on('error'); a noServer wss never sees them.
  console.error('❌ WebSocket server error:', err.message)
})

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => { /* client went away mid-handshake */ })
  if (realtimeHub && isLiveRequest(req)) {
    relaySummary.count('live upgrades')
    realtimeHub.handleUpgrade(req, socket, head, { ip: getClientIp(req) })
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

// Server-side ping for role sockets behind Cloudflare (it closes WebSockets idle
// for 100 s): every 30 s, and a socket that missed the previous pong is
// terminated. Cloud only; the LAN relay keeps its old behaviour.
const roleHeartbeat = IS_CLOUD ? (realtimeHub ? realtimeHub.heartbeat : createHeartbeat({ intervalMs: 30000 })) : null

wss.on('connection', (ws, req) => {
  // Enforce global connection cap
  if (connections.size >= MAX_CONNECTIONS) {
    ws.close(1013, 'Server connection limit reached')
    return
  }

  const clientId = randomBytes(8).toString('hex')
  const ip = getClientIp(req)
  // Every relay limit (connections, claims, wrong PINs) is keyed on the
  // address bucket: IPv4 as is, IPv6 by /64 (one subscriber holds a whole /64,
  // so a per-address key would be no limit at all).
  const ipKey = ipBucketKey(ip)

  // Enforce per-IP connection cap (a LAN relay counts per address: every
  // tablet of a venue LAN shares one IPv6 /64)
  let connectionsFromIp = 0
  for (const c of connections.values()) {
    if (IS_CLOUD ? c.ipKey === ipKey : c.ip === ip) connectionsFromIp++
  }
  if (connectionsFromIp >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1008, 'Too many connections from this IP')
    return
  }

  const clientInfo = {
    ws,
    id: clientId,
    ip,
    ipKey,
    matchId: null,
    role: null, // 'scoreboard', 'referee', 'bench'
    team: null, // 'home' or 'away' for bench clients
    // Matches this socket proved the scoreboard role for (game PIN in sync-match-data)
    ownedMatches: new Set(),
    // Id this socket synced under (its Dexie id) -> room key (seed_key)
    aliases: new Map(),
    // Room keys this socket sent PINs for: a later PIN-less sync of one the
    // relay no longer holds is refused with 'pins-required'
    pinKeys: new Set(),
    // Room key -> { pin?, token?, verified }: the PIN / match token this socket
    // offered (subscribe-match). Full bundles and match actions only with one
    // that grants the match (hasRelayAccess); the summary otherwise.
    matchAccess: new Map(),
    device: null, // subscribe-match label: 'referee' | 'bench' | 'livescore'
    deviceTeam: null,
    connectedAt: new Date().toISOString()
  }

  connections.set(clientId, clientInfo)
  roleHeartbeat?.track(ws)

  relaySummary.count('sockets opened')
  relaySummary.setGauge('open', connections.size)
  if (LOG_EACH_CONNECTION) console.log(`✅ Client connected: ${clientId} (Total: ${connections.size})`)

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    mode: IS_CLOUD ? 'cloud' : 'local',
    timestamp: new Date().toISOString()
  }))

  ws.on('message', (data) => {
    // Per-client WebSocket rate limiting
    if (isWsRateLimited(clientId)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }))
      ws.close(1008, 'Rate limit exceeded')
      return
    }
    // While a sync-match-data waits for its database check (cloud claims, see
    // verifyRelayClaim), this socket's later messages wait behind it: a
    // scoreboard's live-state-update must not overtake the sync that makes it
    // the match's owner.
    if (clientInfo.backlog) {
      if (clientInfo.backlog.length >= MAX_SOCKET_BACKLOG) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }))
        ws.close(1008, 'Rate limit exceeded')
        return
      }
      clientInfo.backlog.push(data)
      return
    }
    runSocketMessage(clientInfo, data)
  })

  ws.on('close', () => {
    handleClientDisconnect(clientInfo)
  })

  ws.on('error', (err) => {
    console.error(`❌ WebSocket error for ${clientId}:`, err.message)
  })
})

const MAX_SOCKET_BACKLOG = 64

/** Handle one socket message; one that returns a promise holds the socket's later messages back. */
function runSocketMessage(clientInfo, data) {
  const pending = handleSocketMessage(clientInfo, data)
  if (!pending || typeof pending.then !== 'function') return
  clientInfo.backlog = []
  pending.catch((err) => console.error('❌ Error handling message:', err?.message || err)).finally(() => {
    const backlog = clientInfo.backlog || []
    clientInfo.backlog = null
    while (backlog.length) {
      if (clientInfo.ws.readyState !== 1) return
      if (clientInfo.backlog) {
        // Held back again: the rest waits behind the new check, in order
        clientInfo.backlog.push(...backlog)
        return
      }
      runSocketMessage(clientInfo, backlog.shift())
    }
  })
}

function handleSocketMessage(clientInfo, data) {
  const ws = clientInfo.ws
  try {
    const message = JSON.parse(data.toString())

    // Handle different message types
    switch (message.type) {
      case 'join_match':
        // Client joins a match room
        handleJoinMatch(clientInfo, message)
        break

      case 'leave_match':
        // Client leaves match room
        handleLeaveMatch(clientInfo)
        break

      case 'match_update':
        // Scoreboard sends match state update
        handleMatchUpdate(clientInfo, message)
        break

      case 'sync-match-data':
        // Scoreboard sends match data sync (frontend uses this format)
        return handleSyncMatchData(clientInfo, message)

      case 'match-action':
        // Scoreboard sends action (timeout, substitution, etc.) - frontend format
        handleMatchAction(clientInfo, message)
        break

      case 'action':
        // Scoreboard sends action (timeout, substitution, etc.) - legacy format
        handleAction(clientInfo, message)
        break

      case 'live-state-update':
        // Scoreboard's computed live-state (same message as the LAN relays)
        handleLiveStateUpdate(clientInfo, message)
        // DATABASE_URL mode: also a match_live_state db-change for live
        // subscribers (livescore, scorer alarm), even when HTTP sync is down.
        if (liveStateRelay) {
          liveStateRelay.handle(clientInfo, { ...message, matchId: resolveMatchKey(clientInfo, message.matchId) }).then((r) => {
            // pin_mismatch: the synced game PIN is not the row's (or the row has
            // none); expected for a forged room, so not logged per update
            if (!r.ok && !['forbidden', 'not_synced', 'no_match_key', 'unknown_match', 'pin_mismatch'].includes(r.reason)) {
              console.warn('[realtime] live-state-update not published:', r.reason)
            }
          }, (err) => console.warn('[realtime] live-state relay failed:', err?.message))
        }
        break

      case 'clear-all-matches':
        // Clear all matches (or all except one)
        handleClearMatches(clientInfo, message)
        break

      case 'delete-match':
        // Delete a specific match
        handleDeleteMatch(clientInfo, message)
        break

      case 'ping':
        // Heartbeat
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
        break

      case 'subscribe-match':
        // Frontend format for joining a match room (used by referee/bench/livescore)
        // Adapt to join_match format
        handleJoinMatch(clientInfo, {
          ...message,
          matchId: message.matchId,
          role: message.role || 'subscriber'
        })
        clientInfo.device = DEVICE_LABELS.includes(message.device) ? message.device : clientInfo.device
        clientInfo.deviceTeam = VALID_TEAMS.includes(message.team) ? message.team : clientInfo.deviceTeam
        break

      default:
        console.log(`❓ Unknown message type: ${message.type}`)
    }
  } catch (err) {
    console.error('❌ Error parsing message:', err)
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Invalid message format'
    }))
  }
  return undefined
}

// Handle client joining a match room
function handleJoinMatch(clientInfo, message) {
  const { team } = message
  const matchId = normalizeMatchId(message.matchId)

  if (!matchId) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID required'
    }))
    return
  }

  // Validate role and team. 'scoreboard' cannot be self-declared: it is earned
  // by proving the match's game PIN in sync-match-data. The role and team only
  // label the socket (like the LAN relays): joining is PIN-free, and access to
  // the bundle comes only from registerRelayAccess (PIN or token, every wrong
  // PIN counted against the socket and the caller's address).
  const requestedRole = joinRole(message.role)
  const validatedRole = (requestedRole && VALID_ROLES.includes(requestedRole)) ? requestedRole : 'unknown'
  const validatedTeam = (team && VALID_TEAMS.includes(team)) ? team : null

  // Leave previous room if any
  if (clientInfo.matchId) {
    handleLeaveMatch(clientInfo)
  }

  // Enforce room cap
  if (!rooms.has(matchId) && rooms.size >= MAX_ROOMS) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Server room limit reached'
    }))
    return
  }

  // Update client info
  clientInfo.matchId = matchId
  clientInfo.role = validatedRole
  clientInfo.team = validatedTeam

  // Create room if doesn't exist
  if (!rooms.has(matchId)) {
    rooms.set(matchId, {
      matchId,
      clients: new Set(),
      createdAt: new Date().toISOString(),
      lastActivity: Date.now()
    })
  }

  // Add client to room
  const room = rooms.get(matchId)
  room.clients.add(clientInfo.id)
  room.lastActivity = Date.now()

  console.log(`🎯 ${clientInfo.id} (${validatedRole}) joined match ${matchId} (Room size: ${room.clients.size})`)

  // Notify client
  clientInfo.ws.send(JSON.stringify({
    type: 'joined_match',
    matchId,
    role: validatedRole,
    roomSize: room.clients.size
  }))

  // The PIN / token this socket offers for the match (subscribe-match).
  registerRelayAccess(clientInfo, matchId, message)

  // Initial snapshot, like the LAN relays: late subscribers don't wait for the
  // scoreboard's next sync. PIN-free; the summary unless a PIN was proved.
  const stored = activeMatches.get(matchId)
  if (stored?.match) {
    const access = hasRelayAccess(clientInfo, matchId, stored) ? 'full' : 'summary'
    clientInfo.ws.send(JSON.stringify(matchDataMessage('match-full-data', matchId, stored, undefined, access)))
  }

  // Notify other clients in room
  broadcastToRoom(matchId, {
    type: 'client_joined',
    clientId: clientInfo.id,
    role: validatedRole,
    roomSize: room.clients.size
  }, clientInfo.id) // Exclude sender
}

// --- PIN-proved relay access (lib/matchAccess.js) ---------------------------
// Every PIN the relay compares for a caller (subscribe-match / join_match pin,
// a scoreboard's game-PIN claim) is limited twice: per socket (5 wrong PINs a
// minute) and in the brute-force budget the HTTP PIN checks share
// (pinFailureLimiter: 20 wrong PINs per 10 minutes per address bucket, IPv6 by
// /64). Over either limit nothing is compared (no guessing oracle).
const RELAY_PIN_FAILURE_LIMIT = 5
const MAX_ACCESS_KEYS = 16

/**
 * One counted PIN comparison for this socket.
 * @param {() => boolean} compare
 * @returns {'ok'|'wrong'|'rate-limited'}
 */
function relayPinAttempt(clientInfo, compare) {
  const wsKey = `pin-ws:${clientInfo.id}`
  if ((windowEntry(claimFailures, wsKey)?.count || 0) >= RELAY_PIN_FAILURE_LIMIT) return 'rate-limited'
  // isLimited counts the attempt up front; a right PIN is refunded
  if (pinFailureLimiter.isLimited(clientInfo.ipKey)) return 'rate-limited'
  if (compare()) {
    pinFailureLimiter.refund(clientInfo.ipKey)
    return 'ok'
  }
  bumpWindow(claimFailures, wsKey)
  return 'wrong'
}

/**
 * Does a match token grant the relay copy of `matchId` right now? The token
 * names the match and the role it was issued for: the role's connection must
 * still be on, and when the token carries the fingerprint of the role's PIN,
 * that PIN must still be the match's (a device the scorer disconnected, or
 * whose PIN was regenerated, loses access at once, not when the token expires).
 */
function tokenGrantsRelay(token, matchId, match) {
  const p = matchTokens.verify(token)
  if (!p || matchId == null || p.m !== String(matchId)) return false
  return match ? matchTokens.stillGrants(p, match) : true
}

/**
 * subscribe-match { pin?, token? }: remember what the socket offers for the
 * room. A token must grant this room; a PIN is checked now when the relay
 * holds the match, else when it arrives (once: a wrong one is then dropped
 * and counted). With both, the PIN is kept as well, so the device keeps its
 * access when the token expires. Answers 'pin-invalid' / 'rate-limited' errors.
 */
function registerRelayAccess(clientInfo, matchId, message) {
  const token = typeof message.token === 'string' && message.token ? message.token : null
  const pin = message.pin !== undefined && message.pin !== null && String(message.pin).trim() !== ''
    ? String(message.pin).trim().slice(0, 32) : null
  if (!token && !pin) return
  const remember = (value) => {
    clientInfo.matchAccess.delete(matchId)
    if (clientInfo.matchAccess.size >= MAX_ACCESS_KEYS) clientInfo.matchAccess.delete(clientInfo.matchAccess.keys().next().value)
    clientInfo.matchAccess.set(matchId, value)
  }
  const entry = activeMatches.get(matchId)
  if (token && tokenGrantsRelay(token, matchId, entry?.match)) {
    // The PIN alongside is compared only if the token stops granting
    remember({ token, pin, verified: false })
    return
  }
  if (!pin) {
    clientInfo.ws.send(JSON.stringify({ type: 'error', code: 'access-denied', message: 'This match token is not valid (any more): check the PIN again', matchId }))
    return
  }
  if (entry?.match) {
    const r = relayPinAttempt(clientInfo, () => pinGrantsAccess(entry.match, pin))
    if (r === 'rate-limited') {
      clientInfo.ws.send(JSON.stringify({ type: 'error', code: 'rate-limited', message: 'Too many wrong PINs. Wait a few minutes.', matchId }))
      return
    }
    if (r === 'wrong') {
      clientInfo.ws.send(JSON.stringify({ type: 'error', code: 'pin-invalid', message: 'Wrong PIN for this match', matchId }))
      return
    }
    remember({ pin, verified: true })
  } else {
    remember({ pin, verified: false })
  }
}

/** May this socket get the match's bundle and actions (not just the summary)? */
function hasRelayAccess(clientInfo, matchId, entry) {
  if (!clientInfo || !matchId) return false
  if (clientInfo.ownedMatches.has(matchId)) return true
  const a = clientInfo.matchAccess.get(matchId)
  if (!a) return false
  if (a.token && tokenGrantsRelay(a.token, matchId, entry?.match)) return true
  if (a.pin && entry?.match) {
    // A PIN already proved: a plain re-check (it may have been changed or its
    // connection switched off since), never counted
    if (a.verified) {
      if (pinGrantsAccess(entry.match, a.pin)) return true
      return false
    }
    // A PIN not compared yet (offered before the match reached the relay, or
    // next to a token that no longer grants): one counted comparison
    const r = relayPinAttempt(clientInfo, () => pinGrantsAccess(entry.match, a.pin))
    if (r === 'ok') {
      a.verified = true
      a.token = null
      return true
    }
    clientInfo.matchAccess.delete(matchId)
    if (r === 'rate-limited' && clientInfo.ws.readyState === 1) {
      clientInfo.ws.send(JSON.stringify({ type: 'error', code: 'rate-limited', message: 'Too many wrong PINs. Wait a few minutes.', matchId }))
    }
  }
  return false
}

/** match-full-data / match-data-update to a room: full or summary per socket. */
function broadcastMatchData(matchId, type, entry, scoreboardTs, excludeClientId = null, extra = {}) {
  const room = rooms.get(normalizeMatchId(matchId))
  if (!room || !entry) return
  let full = null
  let summary = null
  let sent = 0
  room.clients.forEach((clientId) => {
    if (clientId === excludeClientId) return
    const clientInfo = connections.get(clientId)
    if (!clientInfo || clientInfo.ws.readyState !== 1) return
    if (hasRelayAccess(clientInfo, matchId, entry)) {
      full ??= JSON.stringify({ ...matchDataMessage(type, matchId, entry, scoreboardTs, 'full'), ...extra })
      clientInfo.ws.send(full)
    } else {
      summary ??= JSON.stringify({ ...matchDataMessage(type, matchId, entry, scoreboardTs, 'summary'), ...extra })
      clientInfo.ws.send(summary)
    }
    sent++
  })
  if (LOG_EACH_CONNECTION) console.log(`📡 Match data to ${sent} clients in room ${matchId}`)
}

// 'scoreboard' is never accepted from a join message
function joinRole(requested) {
  return requested === 'scoreboard' ? 'subscriber' : requested
}

// Handle client leaving match room
function handleLeaveMatch(clientInfo) {
  if (!clientInfo.matchId) return

  const room = rooms.get(clientInfo.matchId)
  if (room) {
    room.clients.delete(clientInfo.id)

    console.log(`👋 ${clientInfo.id} left match ${clientInfo.matchId} (Room size: ${room.clients.size})`)

    // Notify other clients
    broadcastToRoom(clientInfo.matchId, {
      type: 'client_left',
      clientId: clientInfo.id,
      role: clientInfo.role,
      roomSize: room.clients.size
    }, clientInfo.id)

    // Clean up empty room
    if (room.clients.size === 0) {
      rooms.delete(clientInfo.matchId)
      activeMatches.delete(clientInfo.matchId)
      console.log(`🗑️  Empty room deleted: ${clientInfo.matchId}`)
    }
  }

  clientInfo.matchId = null
  clientInfo.role = null
}

// Only the socket that proved the match's game PIN (see claimMatch) may
// write to, act on or delete a match.
function requireMatchOwner(clientInfo, matchId, what) {
  if (matchId && clientInfo.ownedMatches.has(matchId)) return true
  clientInfo.ws.send(JSON.stringify({
    type: 'error',
    code: 'not-match-owner',
    message: `Only the match's scoreboard may send ${what}`,
    ...(matchId ? { matchId } : {})
  }))
  return false
}

// Handle match update from scoreboard (legacy message; no current client sends
// it). Relayed only from the match's proven scoreboard and never stored, so it
// cannot replace the synced match (and its PINs / owner).
function handleMatchUpdate(clientInfo, message) {
  const matchId = resolveMatchKey(clientInfo, message.matchId)
  const { data } = message

  if (!matchId || !data || typeof data !== 'object') {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID and data required'
    }))
    return
  }
  if (!requireMatchOwner(clientInfo, matchId, 'match_update')) return

  // Broadcast to the room's sockets with access (PIN proved)
  broadcastToRoom(matchId, {
    type: 'match_update',
    matchId,
    data,
    timestamp: new Date().toISOString()
  }, clientInfo.id, true) // Exclude sender to avoid echo

  console.log(`📤 Match update broadcasted to room ${matchId}`)
}

// Handle action (timeout, substitution, etc.) — legacy format
function handleAction(clientInfo, message) {
  const matchId = resolveMatchKey(clientInfo, message.matchId)
  const { action } = message

  if (!matchId || !action) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID and action required'
    }))
    return
  }
  if (!requireMatchOwner(clientInfo, matchId, 'action')) return

  // Broadcast action to all clients in the room
  broadcastToRoom(matchId, {
    type: 'action',
    matchId,
    action,
    timestamp: new Date().toISOString(),
    from: clientInfo.id
  }, clientInfo.id, true) // Exclude sender; access only

  console.log(`⚡ Action broadcasted to room ${matchId}: ${action.type}`)
}

// Handle client disconnect
function handleClientDisconnect(clientInfo) {
  // Matches no other connected socket owns become claimable after a grace period
  for (const matchId of clientInfo.ownedMatches) {
    const entry = activeMatches.get(matchId)
    const stillOwned = [...connections.values()].some(c => c !== clientInfo && c.ownedMatches.has(matchId))
    if (entry && !stillOwned) entry.orphanedAt = Date.now()
  }
  handleLeaveMatch(clientInfo)
  connections.delete(clientInfo.id)
  wsRateLimitMap.delete(clientInfo.id)
  claimFailures.delete(`ws:${clientInfo.id}`)
  claimFailures.delete(`pin-ws:${clientInfo.id}`)
  relaySummary.count('sockets closed')
  relaySummary.setGauge('open', connections.size)
  if (LOG_EACH_CONNECTION) console.log(`❌ Client disconnected: ${clientInfo.id} (Total: ${connections.size})`)
}

// Per-IP / per-socket bookkeeping for scoreboard claims (see claimMatch)
const claimFailures = new Map() // key -> { count, windowStart }
const newClaims = new Map() // ip -> { count, windowStart }
const displacedPins = new Map() // matchId -> game PIN an unfinished match had before a stale takeover

function windowEntry(map, key) {
  const e = map.get(key)
  if (e && Date.now() - e.windowStart <= RATE_LIMIT_WINDOW_MS) return e
  map.delete(key)
  return null
}
const MAX_WINDOW_KEYS = 50000
function bumpWindow(map, key) {
  const e = windowEntry(map, key)
  // Bound memory under a flood: evict the oldest windows (Map insertion
  // order), never the whole map (that would reset every limit at once).
  if (!e) while (map.size >= MAX_WINDOW_KEYS) map.delete(map.keys().next().value)
  if (e) e.count++
  else map.set(key, { count: 1, windowStart: Date.now() })
  return e ? e.count : 1
}
setInterval(() => {
  for (const map of [claimFailures, newClaims]) for (const key of [...map.keys()]) windowEntry(map, key)
}, 5 * 60 * 1000).unref()

const isFinishedMatch = (match) => !!match && FINISHED_STATUSES.has(String(match.status || '').toLowerCase())
const isLoopbackIp = (ip) => ip === '::1' || /^(::ffff:)?127\./.test(String(ip || ''))

function ownersOf(matchId) {
  return [...connections.values()].filter(c => c.ownedMatches.has(matchId))
}

// Squatting limits for a socket about to own an id it did not own.
function newClaimDenied(clientInfo, matchId) {
  if (!clientInfo.ip || isLoopbackIp(clientInfo.ip)) return null
  const ids = new Set()
  for (const c of connections.values()) {
    if (c.ipKey !== clientInfo.ipKey) continue
    for (const id of c.ownedMatches) if (id !== matchId) ids.add(id)
  }
  if (ids.size >= MAX_OWNED_PER_IP) return 'too-many-matches'
  if (bumpWindow(newClaims, clientInfo.ipKey) > NEW_CLAIM_LIMIT) return 'rate-limited'
  return null
}

/**
 * SECURITY: the scoreboard role is proved with the match's own game PIN, not
 * self-declared. Returns { ok:true, kind } or { ok:false, code }.
 * - a match new to the relay is claimed by its first scoreboard;
 * - a stored match with a game PIN requires the same PIN;
 * - a stored match without one (test match) may be written by anyone, but only
 *   an existing owner may attach a game PIN to it;
 * - a match nobody has owned for ORPHAN_TAKEOVER_MS (finished) or
 *   STALE_TAKEOVER_MS (in play) may be taken over; an unfinished one taken
 *   over with another PIN may be reclaimed once by its own PIN.
 * A socket that never proved the match and leaves the game PIN out is asked
 * for it ('pins-required'): the scorer's sync after a reconnect or relay
 * restart, not a guess, so it is not counted.
 * Wrong-PIN claims are limited per socket and in the brute-force budget the
 * HTTP PIN checks share (pinFailureLimiter, per address bucket); over either
 * limit a claim needing proof is refused BEFORE the PIN is compared (no
 * guessing oracle). A granted claim is refunded.
 * opts.dbProved: the game PIN was just proved against the match's database
 * row (cloud, see verifyRelayClaim): the database is the authority, so a relay
 * copy held under another PIN (a squatter) is reclaimed.
 */
function claimMatch(clientInfo, matchId, incomingMatch, opts = {}) {
  const existing = activeMatches.get(matchId)
  const wasOwner = clientInfo.ownedMatches.has(matchId)
  const incomingPin = gamePinOf(incomingMatch)
  const grant = (kind) => ({ ok: true, kind })
  const denyNew = () => (wasOwner ? null : newClaimDenied(clientInfo, matchId))

  if (!existing || !existing.match) {
    const denied = denyNew()
    return denied ? { ok: false, code: denied } : grant(wasOwner ? 'owner' : 'new')
  }
  const storedPin = gamePinOf(existing.match)
  if (storedPin === null && (incomingPin === null || wasOwner)) {
    const denied = denyNew()
    return denied ? { ok: false, code: denied } : grant(wasOwner ? 'owner' : 'open')
  }
  // An owner re-sending its own PIN proved it already: never rate limited.
  // Leaving the PIN out is fine too (PINs are sent only when they change).
  if (wasOwner && storedPin !== null && !hasGamePinField(incomingMatch)) return grant('owner')
  if (wasOwner && storedPin !== null && incomingPin !== null && safeEqualStr(incomingPin, storedPin)) return grant('owner')
  // Proof takes the game PIN; nothing is compared without one
  if (storedPin !== null && !hasGamePinField(incomingMatch)) return { ok: false, code: 'pins-required' }
  const wsKey = `ws:${clientInfo.id}`
  if ((windowEntry(claimFailures, wsKey)?.count || 0) >= CLAIM_FAILURE_LIMIT) return { ok: false, code: 'rate-limited' }
  // Only a claim with a PIN is a guess (a null PIN proves nothing either way):
  // counted up front, refunded unless it ends as a wrong PIN.
  const counted = incomingPin !== null
  if (counted && pinFailureLimiter.isLimited(clientInfo.ipKey)) return { ok: false, code: 'rate-limited' }
  const refund = () => { if (counted) pinFailureLimiter.refund(clientInfo.ipKey) }
  const granted = (kind) => { refund(); return grant(kind) }
  if (storedPin !== null && incomingPin !== null && safeEqualStr(incomingPin, storedPin)) {
    return granted(wasOwner ? 'owner' : 'proved')
  }
  const reclaimPin = displacedPins.get(matchId)
  if (reclaimPin !== undefined && incomingPin !== null && safeEqualStr(incomingPin, reclaimPin)) {
    displacedPins.delete(matchId)
    for (const c of connections.values()) if (c !== clientInfo) c.ownedMatches.delete(matchId)
    return granted('reclaim')
  }
  if (opts.dbProved && incomingPin !== null) {
    displacedPins.delete(matchId)
    for (const c of connections.values()) if (c !== clientInfo) c.ownedMatches.delete(matchId)
    return granted('reclaim')
  }
  const grace = isFinishedMatch(existing.match) ? ORPHAN_TAKEOVER_MS : STALE_TAKEOVER_MS
  if (ownersOf(matchId).length === 0 && existing.orphanedAt && Date.now() - existing.orphanedAt >= grace) {
    refund()
    const denied = denyNew()
    if (denied) return { ok: false, code: denied }
    if (storedPin !== null && incomingPin !== storedPin && !isFinishedMatch(existing.match)) displacedPins.set(matchId, storedPin)
    else displacedPins.delete(matchId)
    return grant('takeover')
  }
  if (counted) bumpWindow(claimFailures, wsKey)
  else refund()
  return { ok: false, code: 'not-match-owner' }
}

/**
 * Cloud (DATABASE_URL): may this socket speak for `matchId`? The relay alone
 * cannot tell (a room key new to it is claimed by its first scoreboard, e.g.
 * after a relay restart), but the database can: when the match is stored
 * there with a game PIN (looked up by the room key = external_id, and by the
 * key the live-state relay would publish to, matchKeyFromSyncedMatch), the
 * synced game PIN must be that one. A wrong PIN is a counted guess
 * (relayPinAttempt). A match not in the database, or stored without a game
 * PIN, is left to the relay's own rules; a database error fails open (the
 * live-state relay checks the PIN again before publishing anything).
 * @returns {Promise<{ ok: true, dbProved: boolean } | { ok: false, code: string }>}
 */
async function verifyRelayClaim(clientInfo, matchId, match) {
  const keys = [{ column: 'external_id', value: matchId }]
  const synced = matchKeyFromSyncedMatch(match)
  if (synced && !(synced.column === 'external_id' && synced.value === matchId)) keys.push(synced)
  let layer
  let rows
  try {
    layer = await getDataLayer()
    rows = await Promise.all(keys.map(async (key) => {
      const r = await layer.db.runQuery({
        table: 'matches',
        action: 'select',
        params: { columns: 'id, game_pin', filters: [{ type: 'eq', column: key.column, value: key.value }], limit: 1 }
      }, { internal: true })
      if (r.body.error) throw new Error(r.body.error.code || 'lookup failed')
      return r.body.data?.[0] || null
    }))
  } catch (err) {
    console.warn('[relay] database check of a scoreboard claim failed (allowed):', err?.message)
    return { ok: true, dbProved: false }
  }
  const stored = rows.filter((r) => r && r.game_pin != null && String(r.game_pin).trim() !== '')
  if (stored.length === 0) return { ok: true, dbProved: false }
  const pin = gamePinOf(match)
  if (pin === null) return { ok: false, code: 'pins-required' }
  const r = relayPinAttempt(clientInfo, () => stored.every((row) => layer.pins.matches('game', pin, row.game_pin)))
  if (r === 'rate-limited') return { ok: false, code: 'rate-limited' }
  if (r === 'wrong') return { ok: false, code: 'not-match-owner' }
  return { ok: true, dbProved: true }
}

const CLAIM_ERRORS = {
  'not-match-owner': 'Match is owned by another scoreboard (game PIN mismatch)',
  'rate-limited': 'Too many failed scoreboard claims. Wait a minute.',
  'too-many-matches': 'This address already drives the maximum number of matches',
  'pins-required': 'Send this match again with its PINs (the relay lost it, or this connection has not proved it yet)',
  'room-limit': 'Server room limit reached'
}

// Handle sync-match-data from frontend scoreboard
function handleSyncMatchData(clientInfo, message, opts = {}) {
  // Only scoreboard clients can sync match data
  if (clientInfo.role && clientInfo.role !== 'scoreboard' && clientInfo.role !== 'unknown') {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Only scoreboard can sync match data'
    }))
    return
  }

  // Support both formats:
  // Frontend format: { matchId, match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events }
  // Legacy format: { matchId, match, teams, players, sets, events }
  // Beach (openbeach before its home/away wire adapter): team1Team / team2Team /
  // team1Players / team2Players, stored as home / away (team1 = home). The
  // wire out stays home/away, the same on every relay.
  const { teams, players, sets, events } = message
  let { match } = message
  const rawMatchId = normalizeMatchId(message.matchId)
  const matchId = relayKeyOf(rawMatchId, match)
  // openbeach names its teams team1Team / team2Team (team1 / team2)
  const homeTeam = message.homeTeam || message.team1Team || message.team1 || teams?.[0]
  const awayTeam = message.awayTeam || message.team2Team || message.team2 || teams?.[1]
  const homePlayers = message.homePlayers || message.team1Players || players?.filter(p => p.teamId === match?.homeTeamId) || []
  const awayPlayers = message.awayPlayers || message.team2Players || players?.filter(p => p.teamId === match?.awayTeamId) || []

  if (!matchId || !match || typeof match !== 'object') {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID and match required'
    }))
    return
  }

  // A scoreboard leaves its PINs out once the relay holds them. If the relay
  // lost the match meanwhile, a PIN-less sync would recreate it without PINs
  // (claimable by anyone, LAN PIN check broken): ask for them instead.
  if (hasAnyPinField(match)) {
    rememberKey(clientInfo.pinKeys, matchId, MAX_ALIASES)
  } else if (!activeMatches.get(matchId)?.match && clientInfo.pinKeys.has(matchId)) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      code: 'pins-required',
      message: CLAIM_ERRORS['pins-required'],
      matchId
    }))
    return
  }

  // Cloud: a claim of a room this socket does not own yet is checked against
  // the database first (verifyRelayClaim), then made. Returns the promise, so
  // the socket's next messages wait for it.
  if (DB_MODE && !opts.dbChecked && !clientInfo.ownedMatches.has(matchId)) {
    return verifyRelayClaim(clientInfo, matchId, match).then((v) => {
      if (clientInfo.ws.readyState !== 1 || !connections.has(clientInfo.id)) return
      if (!v.ok) {
        clientInfo.ws.send(JSON.stringify({ type: 'error', code: v.code, message: CLAIM_ERRORS[v.code] || 'Refused', matchId }))
        return
      }
      handleSyncMatchData(clientInfo, message, { dbChecked: true, dbProved: v.dbProved })
    })
  }

  const claimed = claimMatch(clientInfo, matchId, match, { dbProved: opts.dbProved === true })
  if (!claimed.ok) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      code: claimed.code,
      message: CLAIM_ERRORS[claimed.code] || 'Refused',
      matchId
    }))
    return
  }

  // Enforce room cap before storing anything
  if (!rooms.has(matchId) && rooms.size >= MAX_ROOMS) {
    clientInfo.ws.send(JSON.stringify({ type: 'error', code: 'room-limit', message: CLAIM_ERRORS['room-limit'], matchId }))
    return
  }

  // A scoreboard switching matches leaves its previous room first
  if (clientInfo.matchId && clientInfo.matchId !== matchId) {
    handleLeaveMatch(clientInfo)
  }

  if (rawMatchId && rawMatchId !== matchId) {
    clientInfo.aliases.delete(rawMatchId)
    if (clientInfo.aliases.size >= MAX_ALIASES) clientInfo.aliases.delete(clientInfo.aliases.keys().next().value)
    clientInfo.aliases.set(rawMatchId, matchId)
  }

  // Store/update match in activeMatches with all the data. A sync carries no
  // live-state: keep the last one pushed only while the same scoreboard / game
  // PIN keeps the match — never across a takeover, reclaim or PIN change (it
  // would describe another match: sides, sets won, 'ended', ...).
  const previous = activeMatches.get(matchId)
  if (previous?.match && (claimed.kind === 'owner' || claimed.kind === 'proved')) {
    match = carryMatchSecrets(previous.match, match)
  }
  const carryLiveState = (claimed.kind === 'owner' || claimed.kind === 'proved') &&
    gamePinOf(previous?.match) === gamePinOf(match)
  // The sport of the room: openbeach syncs team1/team2 (or names its sport);
  // a sync without teams keeps the sport the same scorer set before.
  const beachSync = !!(message.team1Team || message.team2Team || message.team1Players || message.team2Players) ||
    match.sportType === 'beach' || match.sport_type === 'beach'
  const sportType = beachSync
    ? 'beach'
    : ((claimed.kind === 'owner' || claimed.kind === 'proved') && previous?.sportType) || 'indoor'
  activeMatches.set(matchId, {
    matchId,
    sportType,
    match,
    homeTeam,
    awayTeam,
    homePlayers,
    awayPlayers,
    sets,
    events,
    liveState: carryLiveState ? previous?.liveState : undefined,
    gameNumber: match?.gameN || match?.gameNumber || match?.game_n,
    updatedAt: new Date().toISOString(),
    updatedBy: clientInfo.id
  })
  clientInfo.ownedMatches.add(matchId)

  // Ensure room exists
  if (!rooms.has(matchId)) {
    rooms.set(matchId, {
      matchId,
      clients: new Set(),
      createdAt: new Date().toISOString(),
      lastActivity: Date.now()
    })
  }

  // Add client to room if not already there
  const room = rooms.get(matchId)
  room.lastActivity = Date.now()
  room.clients.add(clientInfo.id)
  clientInfo.matchId = matchId
  clientInfo.role = 'scoreboard'

  // Broadcast to other clients in the room. Subscribers (referee/bench/livescore)
  // must never receive the connection PINs — wireBundle strips them — and get
  // the bundle only after the PIN step (the summary otherwise).
  broadcastMatchData(matchId, 'match-data-update', activeMatches.get(matchId), message._timestamp, clientInfo.id, { timestamp: new Date().toISOString() })

  console.log(`📤 Match data synced for ${matchId} (Game #${match?.gameN || 'unknown'})`)

  // Queue PocketBase backup sync (fire-and-forget, debounced)
  syncToPocketBase(matchId, { match, sportType, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events })
}

// Handle match-action from frontend
function handleMatchAction(clientInfo, message) {
  const matchId = resolveMatchKey(clientInfo, message.matchId)
  const { action } = message

  if (!matchId || !action || typeof action !== 'string') {
    return
  }
  if (!requireMatchOwner(clientInfo, matchId, 'match-action')) return

  // Broadcast action to all clients in the room. The scoreboard sends the
  // payload as `data` (`actionData` is the legacy name).
  const now = Date.now()
  broadcastToRoom(matchId, {
    type: 'match-action',
    matchId,
    action,
    data: message.data !== undefined ? message.data : message.actionData,
    timestamp: message.timestamp ?? new Date().toISOString(),
    _timestamp: now,
    _scoreboardTimestamp: message._timestamp || message.timestamp || now,
    from: clientInfo.id
  }, clientInfo.id, true) // access only: actions carry players and sanctions

  console.log(`⚡ Match action broadcasted to room ${matchId}: ${action}`)
}

// Handle live-state-update (scoreboard's computed live state)
function handleLiveStateUpdate(clientInfo, message) {
  const matchId = resolveMatchKey(clientInfo, message.matchId)
  if (!requireMatchOwner(clientInfo, matchId, 'live-state-update')) return
  if (!message.liveState || typeof message.liveState !== 'object') return
  const stored = activeMatches.get(matchId)
  // A test (rehearsal) match publishes its live state to the venue's relay
  // only (the scorer never sends it here): the cloud drops it.
  if (IS_CLOUD && stored?.match?.test === true) return
  if (stored) stored.liveState = message.liveState
  broadcastToRoom(matchId, { type: 'live-state-update', matchId, liveState: message.liveState }, clientInfo.id)
}

// Remove a match from the relay: tell its room first, then drop room + state.
// The PocketBase backup is retired, not deleted.
function removeMatch(matchId) {
  if (liveStateRelay) {
    const key = matchKeyFromSyncedMatch(activeMatches.get(matchId)?.match)
    if (key) liveStateRelay.invalidate(key.value)
  }
  broadcastToRoom(matchId, { type: 'match-deleted', matchId })
  const room = rooms.get(matchId)
  if (room) {
    for (const id of room.clients) {
      const member = connections.get(id)
      if (member && member.matchId === matchId) member.matchId = null
    }
  }
  rooms.delete(matchId)
  activeMatches.delete(matchId)
  displacedPins.delete(matchId)
  for (const c of connections.values()) c.ownedMatches.delete(matchId)
  retirePocketBaseMatch(matchId)
}

// Handle clear-all-matches: only ever the sender's OWN (proven) matches —
// never other scoreboards' / venues' matches.
function handleClearMatches(clientInfo, message) {
  if (!clientInfo || clientInfo.ownedMatches.size === 0) {
    clientInfo?.ws?.send(JSON.stringify({ type: 'error', code: 'not-scoreboard', message: 'Not authorized to clear matches' }))
    return
  }
  const keepMatchId = resolveMatchKey(clientInfo, message.keepMatchId)
  let cleared = 0
  for (const matchId of [...clientInfo.ownedMatches]) {
    if (matchId === keepMatchId) continue
    // Another live socket still drives this match: just drop our claim.
    const coOwned = [...connections.values()].some(c => c !== clientInfo && c.ws.readyState === 1 && c.ownedMatches.has(matchId))
    if (coOwned) {
      clientInfo.ownedMatches.delete(matchId)
      continue
    }
    removeMatch(matchId)
    cleared++
  }
  console.log(`🗑️  Cleared ${cleared} match(es) owned by ${clientInfo.id}${keepMatchId ? ` (kept ${keepMatchId})` : ''}`)
}

// Handle delete-match
function handleDeleteMatch(clientInfo, message) {
  const matchId = resolveMatchKey(clientInfo, message.matchId)
  if (!matchId) return
  if (!requireMatchOwner(clientInfo, matchId, 'delete-match')) return

  removeMatch(matchId)
  console.log(`🗑️  Deleted match ${matchId}`)
}

// Broadcast message to all clients in a specific room
function broadcastToRoom(matchId, message, excludeClientId = null, accessOnly = false) {
  const room = rooms.get(normalizeMatchId(matchId))
  if (!room) return
  const entry = accessOnly ? activeMatches.get(normalizeMatchId(matchId)) : null

  const data = JSON.stringify(message)
  let sent = 0

  room.clients.forEach((clientId) => {
    if (clientId === excludeClientId) return

    const clientInfo = connections.get(clientId)
    if (clientInfo && clientInfo.ws.readyState === 1) { // WebSocket.OPEN
      if (accessOnly && !hasRelayAccess(clientInfo, normalizeMatchId(matchId), entry)) return
      clientInfo.ws.send(data)
      sent++
    }
  })

  console.log(`📡 Broadcasted to ${sent} clients in room ${matchId}`)
}

// Periodic cleanup of stale connections
setInterval(() => {
  connections.forEach((clientInfo, clientId) => {
    if (clientInfo.ws.readyState === 3) { // WebSocket.CLOSED
      handleClientDisconnect(clientInfo)
    }
  })
}, 30000) // Every 30 seconds

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`)
    console.error(`   Another instance of the server may be running.`)
    console.error(`   Stop it first, or set a different port: PORT=8081 ./openvolley-server-*\n`)
    process.exit(1)
  }
  throw err
})

// --- DATABASE_URL mode: load the data layer at startup -----------------------
// Loading does not connect: a database that is down only makes /health say so
// (and requests answer 503) until it is back. A configuration error (bad
// STORAGE_OWNER_SCOPE, unloadable module) stops the process instead of serving
// half a backend.
if (DB_MODE) {
  getDataLayer().then((layer) => {
    console.log('[DB] data layer ready (pgQuery, auth, storage at ' + STORAGE_ROOT + ')')
    layer.db.ensureCatalog().then(
      (cat) => console.log(`[DB] catalog loaded: ${cat.allowed.length} tables`),
      (err) => console.warn('[DB] catalog not loaded yet (retrying on demand):', err.message)
    )
    // Expired sessions, hourly
    setInterval(() => {
      layer.auth.sweepExpiredSessions().catch((err) => console.warn('[Auth] session sweep failed:', err.message))
      layer.auth.sweepExpiredTokens().catch((err) => console.warn('[Auth] email-link sweep failed:', err.message))
    }, 60 * 60 * 1000).unref()
    // backup/backups/** older than 30 days and stale temp files: 5 min after start, then daily
    // While the host backup is stale or missing, keep every backup/ file (the
    // nightly snapshot may be the only other copy, and it is not being made):
    // maxAgeMs Infinity deletes no file but still clears stale temp files.
    const runSweep = async () => {
      try {
        const { lastBackupAgeMin } = await readLastBackup()
        const state = backupState(lastBackupAgeMin)
        const paused = state === 'stale' || state === 'unknown'
        if (paused) {
          console.error(`❌ [Storage] backup/ sweep PAUSED: host backup is ${state} ` +
            `(last_backup age ${lastBackupAgeMin ?? 'n/a'} min, limit ${BACKUP_MAX_AGE_HOURS} h, STATUS_DIR ${STATUS_DIR}). ` +
            'No backup file is deleted until the backup job runs again.')
        }
        const r = await layer.storage.sweep(paused ? { maxAgeMs: Infinity } : undefined)
        console.log('[Storage] sweep', JSON.stringify({ ...r, backupSweep: paused ? 'paused' : 'ran' }))
      } catch (err) {
        console.error('[Storage] sweep failed:', err.message)
      }
    }
    setTimeout(runSweep, 5 * 60 * 1000).unref()
    setInterval(runSweep, 24 * 60 * 60 * 1000).unref()
    // VolleyManager -> svrz_games, daily at 06:00 Zurich (replaces the Supabase
    // vm-sync Edge Function). Cloud only; needs VM credentials; VM_SYNC=off disables.
    if (!IS_LOCAL && process.env.VM_USERNAME && process.env.VM_PASSWORD && process.env.VM_SYNC !== 'off') {
      import('./lib/vmSync.js').then(({ runVmSync, scheduleVmSync, windowFromEnv }) => {
        const vmWindow = windowFromEnv() // throws on a bad VM_SYNC_DAYS_* value
        const schedule = scheduleVmSync({
          hourLocal: 6,
          tz: 'Europe/Zurich',
          run: () => runVmSync({
            pool: layer.db.pool,
            window: vmWindow,
            credentials: { username: process.env.VM_USERNAME, password: process.env.VM_PASSWORD }
          }).catch((err) => console.error('[VM sync] run failed:', err.message))
        })
        console.log('[VM sync] scheduled, next run ' + (schedule.nextRunAt()?.toISOString() ?? 'n/a'))
      }).catch((err) => {
        console.error('❌ [VM sync] not started:', err.message)
      })
    }
  }, (err) => {
    console.error('❌ [DB] could not initialise the data layer:', err.message)
    process.exit(1)
  })
}

// --- Graceful shutdown (docker stop / systemd) -------------------------------
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[Server] ${signal}: shutting down`)
  const force = setTimeout(() => process.exit(0), 5000)
  force.unref()
  try { realtimeHub?.close() } catch { /* ignore */ }
  for (const c of connections.values()) {
    try { c.ws.close(1001, 'Server shutting down') } catch { /* ignore */ }
  }
  server.close()
  Promise.resolve(dataLayer?.db.close()).catch(() => {}).finally(() => process.exit(0))
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.listen(PORT, () => {
  const ips = getLocalIPs()
  const primaryIP = ips[0]?.address || 'localhost'
  const mode = DB_MODE ? 'CLOUD (DATABASE_URL)' : IS_CLOUD ? 'CLOUD RELAY' : 'LOCAL'

  const ipLines = ips.map(ip => `  📡 ${ip.name}: http://${ip.address}:${PORT}`).join('\n')

  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🏐 OpenVolley Server — ${mode} MODE
║
║  Port: ${PORT}   Status: READY
║  Static files: ${HAS_STATIC ? 'YES' : 'NO'}
║  PocketBase: ${pbReady ? 'CONNECTED' : POCKETBASE_URL ? 'CONNECTING...' : 'NOT CONFIGURED'}
║
${ipLines || `  📡 http://localhost:${PORT}`}
║
║  Indoor Volleyball:
║  Referee:   http://${primaryIP}:${PORT}/referee
║  Bench:     http://${primaryIP}:${PORT}/bench
║  Roster:    http://${primaryIP}:${PORT}/roster
║
║  Beach Volleyball:
║  Referee:    http://${primaryIP}:${PORT}/beach-referee
║  Scoreboard: http://${primaryIP}:${PORT}/beach-scoreboard
║
║  Dashboard: http://${primaryIP}:${PORT}
╚════════════════════════════════════════════════════════════╝
  `)
})
