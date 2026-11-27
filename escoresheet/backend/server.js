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

import { createGlobalLive, isLiveCode, isCourtToken, pickLiveSummaryFields, courtSummary, gameSummary, screenNumber, screenOf } from './lib/globalLive.js'
import { pageKindOf } from './lib/globalQuota.js'
import { tvPageHtml, tvEntryHtml, TV_JS } from './lib/tvPage.js'
import { createServer } from 'http'
import { monitorEventLoopDelay, PerformanceObserver, constants as perfConstants } from 'perf_hooks'
import { gzip } from 'zlib'
import { WebSocketServer } from 'ws'
import ical from 'node-ical'
import { randomBytes, timingSafeEqual, createHash } from 'crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { isIP, BlockList } from 'net'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'
import { getHeapStatistics } from 'v8'
import QRCode from 'qrcode'
import { SECRET_COLUMNS, redactSecrets } from './lib/secrets.js'
// realtimeHub only needs `ws` and node core, so the LAN/SEA bundle can import it
// statically. It is only *instantiated* in DATABASE_URL mode.
import { createRealtimeHub, createLiveStateRelay, createHeartbeat, isLiveRequest, matchKeyFromSyncedMatch, jsonTooDeep } from './lib/realtimeHub.js'
// What anonymous readers (live sockets, /api/db without a session) may see.
import { projectLiveRow, projectLiveGrantedRow, projectLiveSummaryRow, hasAnonPolicy, anonSelectCheck, relayBundleView, relayMatchView, relayLiveStateView, publicLiveState, coveredLiveLineupTeam, relayViewOf, relaySummaryBundle, relayMatchListRow, cloudListsMatch, isPublicIp, projectAnonDbRows, projectNonOwnerRows, withoutDobColumns, dobColumnFilter, DOB_COLUMNS, OFFICIALS_ONLY_COLUMNS, withoutColumns, columnFilterOf } from './lib/publicColumns.js'
// PIN-proved access to a relayed match (full bundle) and its capability tokens.
import { createMatchTokens, pinGrantsAccess, pinTypeOf, relayPinsByType, matchTokenSecretFromEnv, isTokenRole, connectionPinType, findMatchByConnectionPin, isConnectionPinMatch, pinRoleOf, tokenRoleOf, pinOnlyLookupFromEnv } from './lib/matchAccess.js'
// Bench requests (line-up, time-out, substitution) from a bench tablet to the scorer
import { normalizeBenchRequest, normalizeBenchResponse, createBenchRequestStore, createWindowLimiter, currentSetOfBundle, benchView, refereeInfo } from './lib/benchRequests.js'
// Pure helpers only (no pg, no I/O at import): safe in the LAN / SEA build.
import { ipBucketKey, createConcurrencyGate, bearerFromHeaders, EMAIL_CONFIRMATION_MARK } from './lib/auth.js'
import { createAttemptLimiter, createPinFailureBudget, pinScope, PIN_MATCH_FAILURE_MAX, PIN_SEARCH_FAILURE_MAX, PIN_RANGE_FAILURE_MAX, MATCH_SERVER_ONLY_COLUMNS, RESTORE_DEFAULTS } from './lib/matchRestore.js'
import { accessForSport } from './lib/access.js'
import { newRequestId, formatDbRejection, createLogLimiter, createConnectionSummary } from './lib/opsLog.js'
import { plainHttpAnswer, isPlainVisitor, formatPlainHttpLine, plainHttpLogKey } from './lib/plainHttp.js'
import { renderLandingPage, landingMatchRow, roleUrl, INDOOR_ROLES, BEACH_ROLES } from './lib/landingPage.js'
import { createOriginPolicy, parsePublicOrigins, withoutDevOrigins } from './lib/cors.js'
import { pageContentSecurityPolicy } from './lib/pageCsp.js'
import { LIVESCORE_JS, embedPage } from './lib/publicEmbed.js'
import { createLiveStreams, listParams, MATCH_ID_RE as PUBLIC_MATCH_ID_RE } from './lib/publicApi.js'
import { createVectorPdf } from './lib/vectorPdf.js'
import { isEmailAddress } from './lib/emailAddress.js'
import { createSignSessions, signEndpointOf, signBodyLimit, signError, isSignPagePath, SIGN_API_HEADERS, SIGN_PAGE_HEADERS, SLOTS as SIGN_SLOTS } from './lib/signSessions.js'
import { signPageFile } from './lib/signPage.js'
import { createPairSessions, pairEndpointOf, pairBodyLimit, pairError, isPairPagePath, PAIR_API_HEADERS } from './lib/pairSessions.js'
import { createDisplayCodes, displayEndpointOf, displayError, codeStateMessage, codeAnswerMessage, codeEndedMessage, DISPLAY_PREFLIGHT_HEADERS, BODY_MAX as DISPLAY_BODY_MAX } from './lib/displayCodes.js'
import { pairPageFile } from './lib/pairPage.js'
// The scoring-device handover's pure helpers (the pg part runs in DATABASE_URL mode only)
import { SCORER_TABLES, deviceOf, matchRefsOfWrite, scorerMovedBody } from './lib/scorerDevice.js'
// The support form (POST /api/contact): its body, checks and the one mail to CONTACT_EMAIL
import { BUSY_BODY, CONTACT_IDLE_MS, CONTACT_TOTAL_MS, contactMailerFromEnv, contactNetworkKey, createContactSlots, handleContact, LIVE_MATCH_SQL, matchMailDateTime, MAX_CONTACT_BODY_BYTES, SENDER_SQL } from './lib/contact.js'
import { pinFromBody, pinMailText } from './lib/matchPinMail.js'
import { mailErrorReason } from './lib/mailer.js'
// What an address bucket proved recently (a match token / PIN check), for the live hub
import { createAddressProofs } from './lib/addressProofs.js'
// What the relay keeps of an anonymous socket's bundles and live states
import { admissionHeapPressure, approxHeapBytes, createFrameBudget, frameTooLarge, relayBundleProblem, relayEvents, relayMemoryBudget, relayRoomIsLocal, MAX_RELAY_BUNDLE_BYTES, MAX_LIVE_STATE_BYTES, RELAY_ANON_SHARE } from './lib/relayLimits.js'
// A team's uploaded roster: the app's rules, the signatures it may fill in, its end at the coin toss
import { checkUploadedRoster, signaturesAfterUpload, uploadedRosterProblemText, withPendingRostersCleared } from './lib/uploadedRoster.js'
import { DISPLAY_DEVICE, displaySettingsUrl, displayPresenceMessage, displayStateOf, displayStateKey } from './lib/displayPresence.js'

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
} else if (TRUST_PROXY && !TRUST_PROXY_FROM && process.env.IS_CLOUD && DB_MODE) {
  // The cloud deployment (IS_CLOUD=1 with DATABASE_URL, deploy/compose.yaml) shares its proxy
  // network with other containers: trusting cf-connecting-ip from every peer
  // there lets any of them pick its own client address for every limit.
  console.error('[Config] IS_CLOUD with TRUST_PROXY=cloudflare needs TRUST_PROXY_FROM (the tunnel\'s address, deploy/compose.yaml)')
  process.exit(1)
} else if (TRUST_PROXY && !TRUST_PROXY_FROM) {
  console.warn('⚠️  [Config] TRUST_PROXY=cloudflare without TRUST_PROXY_FROM: cf-connecting-ip is trusted from ANY peer. ' +
    'The origin port must be reachable only through the tunnel/proxy.')
}
// Extra trusted browser origins (comma list), on top of the sites of
// lib/cors.js. On the cloud without its dev-branch sites (SEC-60): dev builds
// use the test backend (OV_ALLOW_DEV_ORIGINS=1 there). Dropped with a loud
// line, never a stop: production's .env may still list them.
const PUBLIC_ORIGINS = (() => {
  const { kept, dropped } = withoutDevOrigins(parsePublicOrigins(process.env.PUBLIC_ORIGINS), {
    isCloud: IS_CLOUD,
    allowDev: process.env.OV_ALLOW_DEV_ORIGINS === '1'
  })
  if (dropped.length) {
    console.error(`⚠️  [Config] PUBLIC_ORIGINS: ${dropped.length} dev-branch origin(s) NOT trusted on this cloud backend: ${dropped.join(', ')}. ` +
      'Remove them from .env (dev builds use the test backend; a test backend sets OV_ALLOW_DEV_ORIGINS=1).')
  }
  return kept
})()
// Object storage root (bind mount with a .ovdata sentinel). STORAGE_DIR is the
// older name used by lib/storage.js and its README; STORAGE_ROOT wins.
const STORAGE_ROOT = process.env.STORAGE_ROOT || process.env.STORAGE_DIR || '/data/storage'
// Read-only directory holding `last_backup` and `last_files_backup` (UTC
// timestamps the host's database run and files run write on success).
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
// PINs at rest (lib/pinHash.js): with a database the secret is required. An
// empty one used to start fine and store every PIN in plaintext.
if (DB_MODE && !process.env.OV_PIN_SECRET) {
  console.error('[Config] OV_PIN_SECRET is required with DATABASE_URL (at least 32 characters; README "PINs at rest")')
  process.exit(1)
}
let matchTokens
try {
  matchTokens = createMatchTokens({ secret: matchTokenSecretFromEnv(process.env) })
} catch (err) {
  console.error(`[Config] ${err.message}`)
  process.exit(1)
}
// X-OV-Proto this server requires for writes (pgQuery minWriteProto).
const MIN_WRITE_PROTO = 2

// Tables /api/db may touch ('teams' was dropped: the table no longer exists;
// beach_competition_matches is not read or written by any client and stays
// server-side). Columns are checked against the live catalog by
// lib/pgQuery.js, which also refuses any filter/order on a secret column (no
// PIN oracle).
const ALLOWED_TABLES = ['matches', 'sets', 'events', 'match_live_state', 'profiles', 'referee_database', 'user_matches', 'svrz_games']
// Reference data a client may read but not change: the official game schedule
// (written by the server's own vm-sync job). Admins only.
const READ_ONLY_TABLES = new Set(['svrz_games'])
// The shared referee directory: an account that scores (or an admin) may add
// a referee (Match Setup), and add a sport to one (sport_type of a single row,
// by id, keeping every sport it had); removing a sport (which hides the
// referee from a picker), changing or deleting anything else is for admins.
const REFEREE_DIRECTORY = 'referee_database'
const REFEREE_DIRECTORY_UPDATABLE = new Set(['sport_type'])
// db/056: read by admins only (the account that added a row)
const REFEREE_DIRECTORY_ADMIN_COLUMNS = Object.freeze(['created_by'])
// Relay reads (/api/match/list, /api/match/:id, /api/server/connections, ...)
// per IP and minute, sized for a hall of 64 matches behind one address (see
// MAX_OWNED_PER_IP): about 16 a minute per match (the scorer's tablet status
// every 10 s, referee and bench fetches). 200 ran out at about 12 matches in
// the national peak load test (2026-10-26, literal halls).
const DB_RATE_LIMIT_MAX = 1000
const EMAIL_RATE_LIMIT_MAX = 3
const ICAL_RATE_LIMIT_MAX = 10
// Venue-NAT sized buckets (plan §4 Phase 2/3, §9): one address may carry a whole hall.
const DB_READ_RATE_LIMIT_MAX = 600   // /api/db reads per IP and minute
const DB_WRITE_RATE_LIMIT_MAX = 600  // /api/db writes per user id and minute
const DB_WRITE_IP_RATE_LIMIT_MAX = 1200 // /api/db writes per IP, checked before the token lookup
// /api/db reads answered without a checked session (no token, or a read that
// needs none, so it was not looked up), and those of an account without any
// role (anyone may sign up for one: a session alone proves nothing). They
// share the database pool with sign-in and every scorer's writes (5
// connections by default), and ten such reads with count:true or an
// unindexed order held all of it for the 10 s statement timeout. Each counts
// at most ANON_DB_COUNT_CAP rows, ends after ANON_DB_STATEMENT_TIMEOUT_MS, at
// most ANON_DB_CONCURRENCY run at once (two connections stay free) with at
// most ANON_DB_QUEUE waiting, each at most ANON_DB_QUEUE_WAIT_MS (then a
// retryable 503, well within the apps' 20 s request timeout; one whose caller
// left meanwhile is not run), and one of the big child tables (events, sets)
// without a filter on one match or row returns at most ANON_DB_SCAN_ROWS
// rows. The apps' anonymous reads fit in these: the livescore and picker
// lists, the archive (500 rows), the referee and schedule directories (pages
// of 1000), one match by its id.
const ANON_DB_COUNT_CAP = 1000
const ANON_DB_STATEMENT_TIMEOUT_MS = 3000
const ANON_DB_SCAN_ROWS = 100
const ANON_DB_SCAN_TABLES = new Set(['events', 'sets'])
const ANON_DB_KEY_COLUMNS = new Set(['id', 'external_id', 'match_id'])
const ANON_DB_CONCURRENCY = Math.max(1, (Number(process.env.PG_POOL_MAX) > 0 ? Math.floor(Number(process.env.PG_POOL_MAX)) : 5) - 2)
const ANON_DB_QUEUE = 40
const ANON_DB_QUEUE_WAIT_MS = 5000
const anonDbGate = createConcurrencyGate({ maxConcurrent: ANON_DB_CONCURRENCY, maxQueue: ANON_DB_QUEUE, maxWaitMs: ANON_DB_QUEUE_WAIT_MS })
// POST /api/global/{save,load} (lib/globalStore.js, the Global tool): anonymous, per IP (/64) and minute
const GLOBAL_IP_RATE_LIMIT_MAX = 120
// GET /api/global/live/<code> (lib/globalLive.js, the Global tool's live page
// for TVs): anonymous, per IP (/64) and minute. A TV polls about every 5 s; a
// school's TVs behind one address share the budget.
const GLOBAL_LIVE_RATE_LIMIT_MAX = 600
// POST /api/global/live/<code>: a scorer device whose relay is not the cloud
// (desktop app, venue relay) sends its court summary itself, about every 2 s
const GLOBAL_LIVE_PUSH_RATE_LIMIT_MAX = 240
const GLOBAL_LIVE_PUSH_BODY_MAX = 16 * 1024
// Global bodies (a save is up to ~16 MB, several times that once parsed, from
// anyone) in memory at once, per process, like /api/match/restore's: a short
// queue behind them, 503 beyond. The read ends for a body that goes silent or
// trickles (RESTORE_BODY_IDLE_MS / RESTORE_BODY_TOTAL_MS), so slots come back.
// Saves and loads have a gate each (a restore by code never waits behind
// uploads), and one address holds ONE slot of a gate at a time (its next
// requests wait in its own short queue): an anonymous client that trickles
// its bodies no longer holds every slot for everyone (audit 2026-11-14).
const globalGates = {
  save: createConcurrencyGate({ maxConcurrent: 2, maxQueue: 6, maxWaitMs: 15 * 1000 }),
  load: createConcurrencyGate({ maxConcurrent: 2, maxQueue: 6, maxWaitMs: 15 * 1000 })
}
const GLOBAL_ADDRESS_QUEUE = 3
const globalAddressGates = new Map() // `${action}\n${address}` -> { gate, users }
async function runGlobalGated(action, address, fn, opts) {
  const id = `${action}\n${address}`
  let entry = globalAddressGates.get(id)
  if (!entry) {
    entry = { gate: createConcurrencyGate({ maxConcurrent: 1, maxQueue: GLOBAL_ADDRESS_QUEUE, maxWaitMs: 15 * 1000 }), users: 0 }
    globalAddressGates.set(id, entry)
  }
  entry.users++
  try {
    return await entry.gate.run(() => globalGates[action].run(fn, opts), opts)
  } finally {
    if (--entry.users === 0) globalAddressGates.delete(id)
  }
}
// A load's body is a key and a kind
const GLOBAL_LOAD_BODY_MAX = 4 * 1024
// GET /api/global/shared|organizer/* (the share link and the organizer list):
// anonymous, per IP (/64), minute and kind of page (requestPageKind), apart
// from the cloud writes (POST /api/global/cloud/*, GLOBAL_IP_RATE_LIMIT_MAX)
const GLOBAL_CLOUD_READ_RATE_LIMIT_MAX = 600
/** 'app' | 'other' | 'plain' (lib/globalQuota.js pageKindOf): the anonymous GET budgets per address and kind. */
function requestPageKind(req) {
  return pageKindOf(req.headers, (origin) => isTrustedOrigin(origin, { host: req.headers.host }))
}
// POST /api/global/cloud/* (db/046, lib/globalMatches.js, the opt-in cloud
// copy of a Global match): a save carries the match export and the PDF (base64)
const GLOBAL_CLOUD_BODY_MAX = 4 * 1024 * 1024
const GLOBAL_CLOUD_SMALL_BODY_MAX = 4 * 1024
const STORAGE_IP_RATE_LIMIT_MAX = 600 // /api/storage/* per IP (per-user write quota lives in lib/storage.js)
// /api/storage/* bodies (audit 2026-11-23 SEC-18), like /api/match/restore's:
// read with an idle and a total timeout (a body that goes silent or trickles
// gives its slot back, 408), at most STORAGE_ACCOUNT_CONCURRENCY of a kind
// per account at once with a short queue behind them, 503 OV_BUSY beyond. An
// upload's total time grows with its size at the apps' slowest assumed uplink
// (20 KB/s, frontend apiClient storageUploadTimeoutMs), below Node's own
// 5-minute requestTimeout, and after its first STORAGE_UPLOAD_RATE_GRACE_MS it
// must average STORAGE_UPLOAD_FLOOR_BYTES_PER_S; a download, list or remove
// body is a path or a list of paths (STORAGE_SMALL_BODY_MAX, 20 s at most).
// GCS-R5 (the review of that fix): the process-wide gate was held while the
// body was read, so 4 accounts trickling bodies held all 16 slots and the
// queue, and every other account got 503 for its backups and PDFs. Now the
// read holds only its account's slot, and a lease on the bytes all storage
// bodies of its kind hold in memory (STORAGE_BODY_BYTES_MAX: what the gate
// bounded before; a trickle holds almost none, 503 OV_BUSY when a chunk
// would pass it); the process gate (STORAGE_GATE_CONCURRENCY) is taken after
// the read, for the checks and the write. The idle time is the restore's
// (RESTORE_BODY_IDLE_MS); OV_STORAGE_BODY_TEST_MS (tests only, not in
// production) shortens the times.
const STORAGE_SMALL_BODY_MAX = 256 * 1024
const STORAGE_BODY_TEST_MS = process.env.NODE_ENV !== 'production' && Number(process.env.OV_STORAGE_BODY_TEST_MS) > 0 ? Number(process.env.OV_STORAGE_BODY_TEST_MS) : 0
const STORAGE_BODY_IDLE_MS = STORAGE_BODY_TEST_MS || 30 * 1000
const STORAGE_BODY_TOTAL_MS = STORAGE_BODY_TEST_MS ? 2 * STORAGE_BODY_TEST_MS : 2 * 60 * 1000
const STORAGE_SMALL_BODY_TOTAL_MS = STORAGE_BODY_TEST_MS ? 2 * STORAGE_BODY_TEST_MS : 20 * 1000
const STORAGE_UPLOAD_TOTAL_MAX_MS = STORAGE_BODY_TEST_MS ? 2 * STORAGE_BODY_TEST_MS : 280 * 1000
const STORAGE_UPLOAD_MIN_BYTES_PER_S = 20 * 1000
const STORAGE_UPLOAD_FLOOR_BYTES_PER_S = 1024
const STORAGE_UPLOAD_RATE_GRACE_MS = STORAGE_BODY_TEST_MS || 10 * 1000
/** The read limits of a storage body: { idleMs, totalMs, minBytesPerSec, minRateGraceMs }. */
function storageBodyLimits(req, upload) {
  if (!upload) return { idleMs: STORAGE_BODY_IDLE_MS, totalMs: STORAGE_SMALL_BODY_TOTAL_MS }
  const len = Number(req.headers['content-length'])
  const byLength = Number.isFinite(len) && len > 0 ? STORAGE_BODY_TOTAL_MS + Math.ceil(len / STORAGE_UPLOAD_MIN_BYTES_PER_S) * 1000 : STORAGE_UPLOAD_TOTAL_MAX_MS
  return {
    idleMs: STORAGE_BODY_IDLE_MS,
    totalMs: Math.min(STORAGE_UPLOAD_TOTAL_MAX_MS, Math.max(STORAGE_BODY_TOTAL_MS, byLength)),
    minBytesPerSec: STORAGE_UPLOAD_FLOOR_BYTES_PER_S,
    minRateGraceMs: STORAGE_UPLOAD_RATE_GRACE_MS
  }
}
const STORAGE_GATE_CONCURRENCY = 16
const STORAGE_ACCOUNT_CONCURRENCY = 4
const STORAGE_ACCOUNT_QUEUE = 16
const storageGates = {
  upload: createConcurrencyGate({ maxConcurrent: STORAGE_GATE_CONCURRENCY, maxQueue: 64, maxWaitMs: 30 * 1000 }),
  read: createConcurrencyGate({ maxConcurrent: STORAGE_GATE_CONCURRENCY, maxQueue: 64, maxWaitMs: 15 * 1000 })
}
// the bytes of storage bodies held in memory, by kind: 16 uploads near the
// limit (about 6.8 MiB each) as the process gate held before, 16 small bodies
const STORAGE_BODY_BYTES_MAX = { upload: 112 * 1024 * 1024, read: 16 * STORAGE_SMALL_BODY_MAX }
/** A byte budget: lease() gives a holder with take(n) (false when it would pass max) and release(). */
function createByteBudget(max) {
  let held = 0
  return {
    lease() {
      let mine = 0
      return {
        take(n) {
          if (held + n > max) return false
          held += n
          mine += n
          return true
        },
        release() { held -= mine; mine = 0 }
      }
    },
    get held() { return held }
  }
}
const storageBodyBytes = { upload: createByteBudget(STORAGE_BODY_BYTES_MAX.upload), read: createByteBudget(STORAGE_BODY_BYTES_MAX.read) }
const storageAccountGates = new Map() // `${kind}\n${userId}` -> { gate, users }
/** fn in the account's gate of its kind ('upload' or 'read'); AUTH_BUSY when full. The process gate (storageGates) is the caller's, after the body. */
async function runStorageAccountGated(kind, userId, fn, opts) {
  const id = `${kind}\n${userId}`
  let entry = storageAccountGates.get(id)
  if (!entry) {
    entry = { gate: createConcurrencyGate({ maxConcurrent: STORAGE_ACCOUNT_CONCURRENCY, maxQueue: STORAGE_ACCOUNT_QUEUE, maxWaitMs: 30 * 1000 }), users: 0 }
    storageAccountGates.set(id, entry)
  }
  entry.users++
  try {
    return await entry.gate.run(fn, opts)
  } finally {
    if (--entry.users === 0) storageAccountGates.delete(id)
  }
}
const PIN_RATE_LIMIT_MAX = 20        // validate-connection-pin per IP (/64) + PIN type
const PIN_IP_RATE_LIMIT_MAX = 60     // validate-connection-pin per IP (/64), coarse total
// FAILED PIN guesses, the brute-force budget of every PIN check
// (lib/matchRestore.js createPinFailureBudget): 20 per IP (/64) and scope
// (pinScope: what the check compares against), 60 per IP across scopes. A
// success is refunded, so a venue NAT pairing many devices is not affected,
// and one tablet's typos lock only what it was guessing, not the whole hall.
// Across addresses (guesses spread over many of them, an IPv6 /48 is 65,536
// /64 buckets, passed every per-address limit), per match and PIN type, per
// game number of restore-by-pin and per PIN-only search:
// - per address range of the caller (OV_PIN_RANGE_FAILURES, 20 wrong PINs
//   for an IPv4 address or IPv6 /64, 30 for a /56, 40 for an IPv4 /24 or an
//   IPv6 /48, in 10 minutes): that range is refused that check for 10
//   minutes, the right PIN too (one [PIN] log line); every other range goes
//   on, and the right PIN from there passes;
// - from all callers together, 30 (OV_PIN_MATCH_FAILURES) per match and PIN
//   type or game number, 100 (OV_PIN_SEARCH_FAILURES) per PIN-only search:
//   one ops alert per 10 minutes (a [PIN] line and an error-tracker event,
//   pinBudgetAlert), and nobody is refused for it. A hard refusal for every
//   caller let 30 anonymous guesses lock out a match's referee, benches and
//   scorer, and 100 every OpenBeach referee (audit 2026-11, SEC-05 / SEC-06).
// pinScope (lib/matchRestore.js) names what a check compares against.
const pinFailureCount = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}
/**
 * The ops alert of the PIN budget (all callers past their threshold, a full
 * table): an error-tracker event (the error digest and its push), never a
 * PIN and never an address. Its message is the [PIN] log line; the match
 * key, PIN type, count and ranges (their pseudonyms, lib/matchRestore.js
 * pinRangeLabel: privacy section 14) travel as data.
 */
function pinBudgetAlert({ scope, key, type, count, windowMinutes, ranges, otherRanges, message }) {
  const err = new Error(String(message || 'PIN guessing').replace(/^\[PIN\] /, 'PIN guessing: ').slice(0, 400))
  err.name = 'PinGuessing'
  captureServerError(err, {
    kind: 'server.exception',
    view: `pin budget ${scope}`,
    data: { scope, match: key, kind: type, count, windowMinutes, ranges: (ranges || []).slice(0, 10).map((r) => `${r.range} x${r.count}`), otherRanges }
  })
}
const PIN_FAILURES = {
  max: 20,
  ipMax: 60,
  windowMs: 10 * 60 * 1000,
  matchMax: pinFailureCount('OV_PIN_MATCH_FAILURES', PIN_MATCH_FAILURE_MAX),
  searchMax: pinFailureCount('OV_PIN_SEARCH_FAILURES', PIN_SEARCH_FAILURE_MAX),
  rangeMax: pinFailureCount('OV_PIN_RANGE_FAILURES', PIN_RANGE_FAILURE_MAX),
  alert: (a) => pinBudgetAlert(a)
}
const pinFailureLimiter = createPinFailureBudget(PIN_FAILURES)
// The PIN checks that name no match (validate-connection-pin without
// matchExternalId, the relay's validate-pin without matchId): older apps and
// OpenBeach up to its ob-officials-pins build still use them. One
// '[PIN] lookup without a match' line each for the operator, at most
// PIN_LOOKUP_LOG_MAX per sport and PIN type in 10 minutes (then one line
// saying the rest are not logged). Never the PIN, never an address.
const PIN_LOOKUP_LOG_MAX = 60
const pinLookupLog = new Map() // sport:type -> { start, n }
// Which sports still get those lookups (OV_PIN_ONLY_LOOKUP on | beach | off,
// lib/matchAccess.js pinOnlyLookupFromEnv; default on, as the apps in the
// field need): the switch that ends them once the old builds are gone
// (audit 2611 review, SEC06-RESIDUAL-PIN-ONLY). A refused one answers 409
// match-required before any PIN is compared or counted.
const PIN_ONLY_LOOKUP = pinOnlyLookupFromEnv()
if (PIN_ONLY_LOOKUP.mode !== 'on') console.log(`[PIN] lookups without a match: ${PIN_ONLY_LOOKUP.mode === 'beach' ? 'OpenBeach only' : 'none'} (OV_PIN_ONLY_LOOKUP=${PIN_ONLY_LOOKUP.mode})`)
const PIN_ONLY_REFUSED = Object.freeze({ success: false, code: 'match-required', error: 'Pick your match in the list first, then enter the PIN again.' })
function logPinOnlyLookup(path, sport, type, outcome) {
  try {
    const key = `${sport}:${String(type).replace(/[^A-Za-z0-9_]/g, '').slice(0, 20)}`
    const t = Date.now()
    let w = pinLookupLog.get(key)
    if (!w || t - w.start >= PIN_FAILURES.windowMs) {
      if (pinLookupLog.size > 50) pinLookupLog.clear()
      w = { start: t, n: 0 }
      pinLookupLog.set(key, w)
    }
    w.n++
    if (w.n <= PIN_LOOKUP_LOG_MAX) console.log(`[PIN] lookup without a match: ${key} on ${path}: ${outcome} (an app that names no match)`)
    else if (w.n === PIN_LOOKUP_LOG_MAX + 1) console.log(`[PIN] lookup without a match: ${key}: more than ${PIN_LOOKUP_LOG_MAX} in ${Math.round(PIN_FAILURES.windowMs / 60000)} min, the rest of this window is not logged`)
  } catch { /* a log line never fails a PIN check */ }
}
// The relay's validate-pin types under validate-connection-pin's names: one
// typed PIN is checked by both (the apps' backend check, then the relay's),
// in one scope, and the repeat is not counted again (pinFailureLimiter.repeated)
const RELAY_PIN_TYPE = {
  indoor: { referee: 'referee', homeTeam: 'bench_home', awayTeam: 'bench_away' },
  beach: { referee: 'referee', homeTeam: 'bench_team1', awayTeam: 'bench_team2' }
}
const DB_IP_RATE_LIMIT_MAX = 1200    // /api/db per IP (/64), any action, checked BEFORE the body is read
// /api/match/restore bodies (up to MAX_RESTORE_BODY_SIZE) parsed at once, per process
const restoreGate = createConcurrencyGate({ maxConcurrent: 2, maxQueue: 4 })
const RESTORE_RATE_LIMIT_MAX = 30    // /api/match/restore per user
// POST /api/match/event-revisions bodies (at most 200 revisions, lib/eventRevisions.js)
const EVENT_REVISIONS_MAX_BODY = 256 * 1024
const RESTORE_PIN_IP_RATE_LIMIT_MAX = 60 // /api/match/restore-by-pin per IP (the attempt limiter is inside)
// docs/scorer-accounts-spec.md section 5
const MANAGE_RATE_LIMIT_MAX = 300        // /api/admin/* and /api/saved-teams* per user and minute
const ACTIVITY_RATE_LIMIT_MAX = 30       // POST /api/activity per user and minute (one batch per 10 s in a match)
const ACTIVITY_MAX_BODY = 512 * 1024     // POST /api/activity body (<= 500 entries)
const ERRORS_MAX_BODY = 64 * 1024        // POST /api/errors body (<= 20 events; lib/errorTracker.js)
const ERRORS_RATE_LIMIT_MAX = 60         // POST /api/errors requests per address (/64) and minute (the events have their own limits)
const OFFICIAL_CHECK_RATE_LIMIT_MAX = 120 // /api/match/official-check per user and minute
// Invite redemption and preview (/api/account/redeem-invite, invite-preview):
// every call per account and minute (PERM-14: a sequence of successful calls
// was unlimited, a DB transaction each) ...
const ACCOUNT_RATE_LIMIT_MAX = 30
// ... and the FAILED attempts (a code refused: wrong, expired, used up ...)
// per account, and per IP (/64) with a higher ceiling: a hall's Wi-Fi is one
// address, and one account's typos must not lock everyone behind it. Only a
// failure counts: a success, a refused call (429) and a server error are refunded.
const REDEEM_FAILURES = { max: 10, windowMs: 10 * 60 * 1000 }
const REDEEM_IP_FAILURES = { max: 50, windowMs: 10 * 60 * 1000 }
const redeemLimiter = createAttemptLimiter(REDEEM_FAILURES)
const redeemIpLimiter = createAttemptLimiter(REDEEM_IP_FAILURES)
/** A redeem / preview answer that counts as a failed attempt: a code refused (4xx), not a bad body or a 429. */
const isRedeemFailure = (r) => !!r && r.status >= 401 && r.status < 500 && r.status !== 429
// Approval with a PIN was removed (owner 27.11.2026: officials sign by hand).
// Its old paths answer 410 at once, without a session (lib/manageApi.js APPROVAL_REMOVED).
const APPROVAL_REMOVED_BODY = { data: null, error: { message: 'Approval with a PIN was removed. Officials sign by hand.', code: 'OV_APPROVAL_REMOVED' } }
// /api/club/v1/* (lib/clubApi.js): refused tokens per IP (/64), counted BEFORE
// the token lookup (a refused token costs no query once the address is over),
// every other answer refunded
const CLUB_API_TOKEN_FAILURES = { max: 60, windowMs: 60 * 1000 }
const clubApiTokenFailLimiter = createAttemptLimiter(CLUB_API_TOKEN_FAILURES)
const CLUB_API_IP_RATE_LIMIT_MAX = 1200  // /api/club/v1/* per IP (/64) and minute, all tokens
const CLUB_API_TOKEN_RATE_LIMIT_MAX = 240 // /api/club/v1/* per token and minute
// The paths of lib/manageApi.js (same as its manageFamilyOf, which loads with the data layer)
function manageFamilyOf(pathname) {
  if (pathname === '/api/me') return 'me'
  if (pathname === '/api/account/join') return 'join'
  if (pathname === '/api/account/redeem-invite' || pathname === '/api/account/invite-preview') return 'account'
  if (pathname === '/api/match/official-check') return 'officialCheck'
  if (pathname === '/api/approvals' || pathname.startsWith('/api/approvals/') || pathname === '/api/account/approvals' ||
    pathname === '/api/account/approval-pin' || pathname === '/api/account/approval-pin/remove' || pathname === '/api/admin/approvals') return 'approvals'
  if (pathname.startsWith('/api/admin/')) return 'admin'
  if (pathname === '/api/saved-teams' || pathname.startsWith('/api/saved-teams/')) return 'savedTeams'
  if (pathname.startsWith('/api/beach/')) return 'beach'
  if (pathname === '/api/scoresheets' || pathname.startsWith('/api/scoresheets/')) return 'scoresheets'
  if (pathname.startsWith('/api/club/')) return 'club'
  if (pathname === '/api/games/today') return 'games'
  if (pathname.startsWith('/api/team/')) return 'team'
  if (pathname === '/api/game-rosters' || pathname.startsWith('/api/game-rosters/')) return 'gameRosters'
  if (pathname === '/api/club-licences' || pathname.startsWith('/api/club-licences/')) return 'clubLicences'
  if (pathname === '/api/settings') return 'settings'
  if (pathname === '/api/notifications' || pathname === '/api/notifications/read') return 'notifications'
  if (pathname.startsWith('/api/match-editors/')) return 'matchEditors'
  return null
}
// GET /api/public/clubs (lib/accountRequests.js publicClubs, db/025): the sign-up
// form's clubs and teams (ids and names only), anonymous, per IP
const PUBLIC_CLUBS_RATE_LIMIT_MAX = 30
// GET /api/public/beach/t/:slug (lib/beachTournaments.js publicTournament): anonymous, per IP
const PUBLIC_BEACH_RATE_LIMIT_MAX = 120
const PUBLIC_BEACH_RE = /^\/api\/public\/beach\/t\/([a-z0-9-]{1,80})$/
// GET /api/scoresheet-view/:token/:name (lib/scoresheets.js readViewLink): a
// stored scoresheet PDF by its short-lived link, for the browser's viewer;
// anonymous (the token is the capability), per IP
const SCORESHEET_VIEW_RATE_LIMIT_MAX = 60
const SCORESHEET_VIEW_RE = /^\/api\/scoresheet-view\/([A-Za-z0-9_-]{1,64})\/([^/]{1,200})$/
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
// The Global tool's store (lib/globalStore.js): files only, so it needs no database
// It writes on the volume of lib/storage.js: never below the highest of that
// store's free-space floors (STORAGE_*_MIN_FREE_MB), so it stops no later
// than the official matches' backups do.
// The Global tool's live page (lib/globalLive.js): a court summary per
// tournament code, in memory only. The secret keys the courts of relay rooms
// that send no court token (an older scorer app), so nobody else can make it.
const globalLive = createGlobalLive({ secret: matchTokenSecretFromEnv(process.env) })
// A venue relay (not the cloud) forwards its Global courts to the cloud's
// live page as well, when it has internet, so TVs anywhere can follow a hall
// whose scorers use the venue relay. OV_GLOBAL_LIVE_FORWARD: the cloud URL,
// or 'off'. At most one request per court every GLOBAL_LIVE_FORWARD_MS (the
// newest state wins), 5 s timeout, failures ignored (the venue's own /tv page
// keeps working without internet).
const GLOBAL_LIVE_FORWARD = IS_CLOUD ? null : (() => {
  const v = String(process.env.OV_GLOBAL_LIVE_FORWARD ?? 'https://backend.openvolley.app').trim()
  return v === '' || v === 'off' ? null : v.replace(/\/+$/, '')
})()
const GLOBAL_LIVE_FORWARD_MS = 2000
const globalLiveForwards = new Map() // code\0court -> { timer, payload }
function forwardGlobalLive(code, court, liveState, entry, screen = null, listed = false) {
  if (!GLOBAL_LIVE_FORWARD || !isLiveCode(code) || !isCourtToken(court)) return
  const key = `${code}\0${court}`
  const m = entry?.match || {}
  const payload = {
    court,
    screen: screenNumber(screen),
    listed: listed === true,
    liveState: pickLiveSummaryFields(liveState),
    match: { coinTossTeamA: m.coinTossTeamA ?? null, hall: m.hall ?? m.venue ?? null, court: m.court ?? null, scheduledAt: m.scheduledAt ?? null, gameN: m.gameN ?? null },
    homeTeam: { name: entry?.homeTeam?.name ?? null },
    awayTeam: { name: entry?.awayTeam?.name ?? null },
    sets: (Array.isArray(entry?.sets) ? entry.sets : []).filter((x) => x?.finished === true).slice(0, 5).map((x) => ({ index: x.index, homePoints: x.homePoints, awayPoints: x.awayPoints, finished: true }))
  }
  const pending = globalLiveForwards.get(key)
  if (pending) { pending.payload = payload; return }
  const slot = { payload, timer: null }
  globalLiveForwards.set(key, slot)
  const send = () => {
    fetch(`${GLOBAL_LIVE_FORWARD}/api/global/live/${code}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(slot.payload), signal: AbortSignal.timeout(5000) })
      .catch(() => { /* no internet at the venue: its own /tv page still works */ })
  }
  send()
  // newer states that came meanwhile go out once the window ends
  const sent = slot.payload
  slot.timer = setTimeout(() => {
    globalLiveForwards.delete(key)
    if (slot.payload !== sent) forwardGlobalLive(code, court, slot.payload.liveState, { match: { ...slot.payload.match }, homeTeam: slot.payload.homeTeam, awayTeam: slot.payload.awayTeam, sets: slot.payload.sets }, slot.payload.screen, slot.payload.listed)
  }, GLOBAL_LIVE_FORWARD_MS)
  slot.timer.unref?.()
}
// An operator alert of the Global stores (a store over half full, full, a PIN
// lock): the error tracker (mail / push to the admins, at most hourly per kind)
function globalAlert(where) {
  return (message) => captureServerError(new Error(`${where}: ${String(message).slice(0, 300)}`), { view: where })
}
let globalStorePromise = null
function getGlobalStore() {
  globalStorePromise ||= Promise.all([import('./lib/globalStore.js'), import('./lib/storage.js')]).then(([m, st]) => {
    const floors = { ...st.DEFAULTS.minFreeBytes, ...(st.storageOptionsFromEnv({ ...process.env, STORAGE_DIR: STORAGE_ROOT }).minFreeBytes || {}) }
    const minFreeBytes = Math.max(0, ...Object.values(floors).map(Number).filter(Number.isFinite))
    // a share per network and day, eviction when full, alerts (audit 2026-11-23 SEC-17)
    return m.createGlobalStore({ root: STORAGE_ROOT, minFreeBytes, onAlert: globalAlert('Global store') })
  })
  // a failed load (a bad STORAGE_* value) is tried again on the next request
  globalStorePromise.catch(() => { globalStorePromise = null })
  return globalStorePromise
}
// The Global store's retention (privacy policy: deleted 180 days after the
// last change) also when nobody uses the Global tool any more: a sweep soon
// after start and then hourly (the store's maybeSweep runs at most hourly
// whoever asks), only where the store has files
function sweepGlobalStore() {
  if (!existsSync(join(STORAGE_ROOT, 'global'))) return
  getGlobalStore()
    .then((store) => store.maybeSweep())
    .then((n) => { if (n) console.log(`[Global] retention: ${n} key(s) deleted`) })
    .catch((err) => console.warn('[Global] retention sweep failed:', String(err?.message || err).slice(0, 200)))
}
setTimeout(sweepGlobalStore, 2000).unref()
setInterval(sweepGlobalStore, 60 * 60 * 1000).unref()
// The opt-in cloud copies of Global matches (db/046, lib/globalMatches.js):
// DATABASE_URL mode only, the store made on first use
let globalMatchesPromise = null
function getGlobalMatches() {
  if (!DB_MODE) return null
  // its ceiling, budgets and PIN lock (audit 2026-11-23 SEC-01, SEC-30):
  // OV_GLOBAL_CLOUD_MAX_MB / _MAX_ROWS / _WRITE_MB_DAY / _WAL_MAX_MB; alerts
  // reach the error tracker. The WAL guard (GCS-R1) measures the WAL written
  // since the host's last backup run (STATUS_DIR/last_backup), which the
  // archive on the database volume holds until the next run takes it away.
  const lastBackupAt = async () => {
    const { at } = await readStatusStamp('last_backup')
    return at ? Date.parse(at) : null
  }
  globalMatchesPromise ||= Promise.all([getDataLayer(), import('./lib/globalMatches.js')])
    .then(([layer, gm]) => gm.createGlobalMatches({ pool: layer.db.pool, onAlert: globalAlert('Global cloud'), walGuard: { lastBackupAt }, ...gm.cloudLimitsFromEnv(process.env) }))
  globalMatchesPromise.catch(() => { globalMatchesPromise = null })
  return globalMatchesPromise
}
// deleted 180 days after the last save (privacy policy), also when nobody saves:
// 5 min after start, then hourly
if (DB_MODE) {
  const sweepGlobalMatches = () => getGlobalMatches()
    ?.then((gm) => gm.sweepExpired())
    .then((n) => { if (n) console.log(`[Global cloud] retention: ${n} match(es) deleted`) })
    .catch((err) => console.warn('[Global cloud] sweep failed:', String(err?.code || err?.message || err).slice(0, 120)))
  setTimeout(sweepGlobalMatches, 5 * 60 * 1000).unref()
  setInterval(sweepGlobalMatches, 60 * 60 * 1000).unref()
}

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
    import('./lib/beachTournaments.js'),
    import('./lib/eventRevisions.js'),
    import('./lib/activityLog.js'),
    import('./lib/scoresheets.js'),
    import('./lib/clubs.js'),
    import('./lib/scorerDevice.js'),
    import('./lib/finalMail.js'),
    import('./lib/teams.js'),
    import('./lib/licences.js'),
    import('./lib/accountRequests.js'),
    import('./lib/signupNotices.js'),
    import('./lib/publicApi.js'),
    import('./lib/retention.js'),
    import('./lib/clubApi.js'),
    import('./lib/dataAdmin.js'),
    import('./lib/sqlWorkspace.js'),
    import('./lib/rosterSaveBack.js'),
    import('./lib/errorTracker.js'),
    import('./lib/errorAlerts.js'),
    import('./lib/sourceMaps.js')
  ]).then(([pgq, mr, au, st, ph, ac, acc, svt, mg, og, ml, bt, evr, act, ss, cl, sd, fm, tms, lic, arq, sn, pub, ret, cla, dta, sqw, rsb, ert, era, smp]) => {
    const poolMax = Number(process.env.PG_POOL_MAX) > 0 ? Math.floor(Number(process.env.PG_POOL_MAX)) : undefined
    const db = pgq.createPgQuery({
      connectionString: DATABASE_URL,
      allowedTables: ALLOWED_TABLES,
      secretColumns: SECRET_COLUMNS,
      // db/048 / db/049: the date-of-birth columns read as NULL and are never
      // stored, whether the table still has them or not (installed apps select them)
      nullColumns: DOB_COLUMNS,
      minWriteProto: MIN_WRITE_PROTO,
      ...(poolMax ? { poolMax } : {})
    })
    // PINs at rest: HMAC with OV_PIN_SECRET (lib/pinHash.js); unset = plaintext as before.
    // (required in DB mode: the start stops without it, see above)
    const pins = ph.pinHasherFromEnv(process.env)
    // restore-by-pin and claim count in the budget of every other PIN check
    const restore = mr.createMatchRestore(db, { pinHasher: pins, pinBudget: pinFailureLimiter })
    const storage = st.createStorage({
      ...st.storageOptionsFromEnv({ ...process.env, STORAGE_DIR: STORAGE_ROOT }),
      checkQuota: st.createWriteQuota()
    })
    // One pg Pool for everything (auth shares pgQuery's pool). delete-account
    // removes the account's files too (README "Deleting an account").
    // Account emails (reset / confirmation links; lib/mailer.js). Without
    // SMTP_HOST and SMTP_PASS: reset answers 503, sign-up confirms at once.
    // With either set, an unusable mail setting stops the startup (throws).
    const mailer = ml.mailerFromEnv(process.env)
    if (mailer.enabled) {
      console.log(`[Mail] account emails on: SMTP ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 465} as ${process.env.SMTP_USER}, from ${mailer.from}, links to ${mailer.managerUrl}; OpenBeach from ${mailer.fromFor('beach')}, links to ${mailer.managerUrlFor('beach')}`)
      for (const w of mailer.warnings || []) console.warn(`[Mail] ${w}`)
    } else {
      console.log(`[Mail] account emails off (${mailer.reason}): password reset answers 503, sign-up confirms accounts at once`)
    }
    // db/028: "a new account signed up", to its admins and approvers (mail and the manager's bell)
    const notices = sn.createSignupNotices({ pool: db.pool, mailer })
    const ceilingSlots = au.ceilingSlotsFromEnv(process.env)
    if (ceilingSlots.warning) console.warn(`⚠️  [Config] ${ceilingSlots.warning}`)
    else if (ceilingSlots.slots !== 'account') console.log(`[Config] OV_SIGN_IN_CEILING_SLOTS=${ceilingSlots.slots}: past an address's ceiling every client lane gets its own try per interval`)
    const auth = au.createAuth({
      pool: db.pool,
      mailer,
      onAccountConfirmed: (userId) => notices.notify(userId),
      contactEmail: CONTACT_EMAIL,
      // Sign-up needs the licence number (owner 23.11.2026); OV_SIGNUP_LICENCE=optional
      // keeps it optional (the e2e servers, tests/helpers/e2eServer.js)
      licenceRequired: process.env.OV_SIGNUP_LICENCE !== 'optional',
      // bcrypt in worker threads, off the relay's event loop (lib/bcryptPool.js,
      // audit 2611 SEC-03): OV_BCRYPT_WORKERS threads (default 1: the backend
      // has one CPU, deploy/compose.yaml; at most 8), 0 = on the main thread as
      // before. The sign-in gate runs one job per thread.
      bcryptWorkers: /^\d{1,2}$/.test(process.env.OV_BCRYPT_WORKERS || '') ? Math.min(8, Number(process.env.OV_BCRYPT_WORKERS)) : 1,
      // Sign-ins turned away (auth_busy) for 30 s on end: a flood, or a server
      // too small for its load. To the error tracker (mail, push, bell).
      onGateSaturated: (info) => captureServerError(
        new Error(`auth: the sign-in gate is at capacity (${info.rejected} sign-ins answered auth_busy in ${info.seconds} s)`),
        { view: 'POST /api/auth/sign-in', status: 503, data: info }),
      // db/057: an address past its account-wide ceiling of failed sign-ins
      // (SEC-13); lib/auth.js mails the account itself
      onSignInAttack: ({ userId, failures, windowHours }) => captureServerError(
        new Error(`auth: ${failures} failed sign-ins on one account within ${windowHours} h; new sources are slowed down`),
        { view: 'POST /api/auth/sign-in', status: 429, accountId: userId }),
      // db/057 auth.sign_in_sources: the sources that signed in to an
      // account, so the owner's own still pass the ceiling after a restart;
      // HMACs keyed with a key derived from OV_PIN_SECRET (none written without it)
      signInSourceSecret: process.env.OV_PIN_SECRET || null,
      // Past the ceiling, the tries of the sources that never signed in to
      // the address: one for all of them (account, the default) or one per
      // client lane (lane): OV_SIGN_IN_CEILING_SLOTS, the owner's choice
      accountCeiling: { slots: ceilingSlots.slots },
      // db/025: what a new account asks for at sign-up (nothing is granted then)
      // (list: their names for the reset link's page, which keeps or drops
      // them when its new password confirms the address; `requests` is made below)
      signUpRequests: { parse: arq.parseSignUpRequests, store: (client, userId, rows) => arq.storeSignUpRequests(client, userId, rows), list: (client, userId) => (requests ? requests.mine(client, userId) : []) },
      // The account's own delete-account: the admin path's last-super-admin
      // refusal and audit entry, in the deletion's transaction (accounts is
      // made below; this runs only on a request)
      selfDelete: (client, userId) => accounts.selfDeleteIn(client, userId),
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
    // Clubs (db/018, lib/clubs.js) audit through accounts, which asks them for /api/me
    let clubs = null
    // An admin's delete / reject of an account runs delete-account's own deletion (files included)
    // Team managers and sent game rosters (db/023, lib/teams.js), the same way
    let teams = null
    // Sign-up requests and who approves them (db/025, lib/accountRequests.js), the same way
    let requests = null
    const accounts = acc.createAccounts({ pool: db.pool, db, restore, access, clubs: () => clubs, teams: () => teams, requests: () => requests, eraseAccount: auth.eraseAccount, mailer,
      // an admin's new game PIN (POST /api/admin/matches/:id/pin): hashed like every PIN, its old count ends
      pins, onGamePinChanged: (externalId) => pinFailureLimiter.pinChanged(externalId, ['game']) })
    // db/029: a club manager link for someone not linked to the club, mailed
    clubs = cl.createClubs({ pool: db.pool, audit: accounts.audit, access, createInvite: accounts.createInvite, mailer })
    // Saved teams; deletes and roster replacements are audited
    const savedTeams = svt.createSavedTeams({ pool: db.pool, audit: accounts.audit })
    // A club's licence lists (db/024, lib/licences.js): My club, "Add from club", the gender check
    const licences = lic.createLicences({ pool: db.pool, audit: accounts.audit, clubs })
    teams = tms.createTeams({ pool: db.pool, audit: accounts.audit, savedTeams, clubs, licences })
    // An official match's rosters fill the teams' saved teams and the clubs'
    // lists (lib/rosterSaveBack.js, owner 2026-11-19), after each matches write
    // (saveBack.note below). OV_SAVE_BACK_TEST_MS: tests only, a shorter quiet
    // time; never in production
    const saveBackQuietMs = process.env.NODE_ENV !== 'production' && Number(process.env.OV_SAVE_BACK_TEST_MS) > 0 ? Number(process.env.OV_SAVE_BACK_TEST_MS) : undefined
    const saveBack = rsb.createRosterSaveBack({ pool: db.pool, teams, savedTeams, licences, audit: accounts.audit, ...(saveBackQuietMs ? { quietMs: saveBackQuietMs } : {}) })
    requests = arq.createAccountRequests({ pool: db.pool, accounts, access })
    const beach = bt.createBeachTournaments({ pool: db.pool, accounts })
    // Undo / delete / edit history of events (db/015)
    const revisions = evr.createEventRevisions(db)
    // The match activity log (db/016)
    const activity = act.createActivityLog({ pool: db.pool, accounts })
    // The manager's Scoresheets tab: stored PDFs for admins and competition managers (audited);
    // a PDF is stored only for a match its uploader may write (db/033)
    // The official sheet as a vector PDF (lib/vectorPdf.js, escoresheet/render; field-spec 17.20):
    // off unless OV_RENDER_URL and OV_RENDER_TOKEN are set (the raster PDFs stay as before)
    const vector = createVectorPdf({ url: process.env.OV_RENDER_URL, token: process.env.OV_RENDER_TOKEN })
    const scoresheets = ss.createScoresheets({
      pool: db.pool, db, storage, accounts,
      readMatch: (id) => restore.readWhole(id),
      vector,
      // a refused vector copy is an ops error (the error tracker), the device's PDF staying official (LOG-09)
      captureError: (err, opts) => captureServerError(err, opts),
      // tests only (tests/vectorPdf.e2e.test.js): shorter waits for the vector copy; never in production
      vectorTimes: process.env.NODE_ENV !== 'production' && process.env.OV_VECTOR_TEST_TIMES ? JSON.parse(process.env.OV_VECTOR_TEST_TIMES) : null
    })
    // The final scoresheet by email (db/021): its switch and the minute sweep below
    const finalMail = fm.createFinalMail({ pool: db.pool, mailer, scoresheets, audit: accounts.audit, ...(process.env.FINAL_MAIL_LANG ? { lang: process.env.FINAL_MAIL_LANG } : {}) })
    const publicApi = pub.createPublicApi({ pool: db.pool })
    // Club API tokens (db/044, lib/clubApi.js): the manager's API tab, and /api/club/v1/*
    const clubApi = cla.createClubApi({ pool: db.pool, audit: accounts.audit, clubs, teams, licences, publicApi, auth })
    // The manager's Data tab (lib/dataAdmin.js): super admins, one row at a time, audited
    const dataAdmin = dta.createDataAdmin({ pool: db.pool, audit: accounts.audit })
    // The manager's SQL tab (lib/sqlWorkspace.js): super admins; read mode as ov_readonly (roles.sql)
    const sqlWorkspace = sqw.createSqlWorkspace({ pool: db.pool, audit: accounts.audit, ...(process.env.OV_SQL_READER_ROLE ? { readerRole: process.env.OV_SQL_READER_ROLE } : {}), ...(process.env.OV_SQL_WRITER_ROLE ? { writerRole: process.env.OV_SQL_WRITER_ROLE } : {}) })
    // The error tracker (db/050, lib/errorTracker.js): every page's and app's
    // errors and the server's own; the Errors tab (super admins); the digest
    // by mail, push and bell (lib/errorAlerts.js, scheduled below)
    const errors = ert.createErrorTracker({
      pool: db.pool,
      audit: accounts.audit,
      clubsOfMany: (client, ids) => clubs.clubsOfMany(client, ids),
      // readable stacks from the web builds' hidden source maps (lib/sourceMaps.js); ERROR_SOURCE_MAPS=off: none
      ...(String(process.env.ERROR_SOURCE_MAPS || '').toLowerCase() === 'off' ? {} : { sourceMaps: smp.createSourceMaps() }),
      ...(Number(process.env.ERROR_ALERT_DEBOUNCE_MS) >= 0 && process.env.ERROR_ALERT_DEBOUNCE_MS ? { debounceMs: Number(process.env.ERROR_ALERT_DEBOUNCE_MS) } : {}),
      // the ceiling of what the error tables hold (default 512 MB; 0: none): past it reports are counted, not stored
      ...(Number(process.env.OV_ERRORS_MAX_BYTES) >= 0 && process.env.OV_ERRORS_MAX_BYTES ? { maxStoreBytes: Number(process.env.OV_ERRORS_MAX_BYTES) } : {})
    })
    const errorAlerts = era.createErrorAlerts({
      tracker: errors,
      pool: db.pool,
      mailer,
      to: process.env.ERROR_ALERT_EMAIL || '',
      managerUrl: mailer.managerUrl,
      ntfy: { url: process.env.NTFY_URL || '', topic: process.env.NTFY_TOPIC || '', token: process.env.NTFY_TOKEN || '', address: process.env.NTFY_ADDRESS || '' },
      audit: accounts.audit,
      // ERROR_ALERTS=log: nothing is sent, the log says what would have been
      suppressed: String(process.env.ERROR_ALERTS || '').toLowerCase() === 'log',
      // tests only: a shorter cooldown than the hour
      ...(process.env.NODE_ENV !== 'production' && Number(process.env.ERROR_ALERT_COOLDOWN_MS) >= 0 && process.env.ERROR_ALERT_COOLDOWN_MS ? { cooldownMs: Number(process.env.ERROR_ALERT_COOLDOWN_MS) } : {})
    })
    const manage = mg.createManageApi({ accounts, savedTeams, beach, revisions, activity, scoresheets, clubs, finalMail, teams, licences, requests, notices, clubApi, dataAdmin, sqlWorkspace, errors, saveBack })
    // The active scoring device of each match (db/019, the scoring-device handover)
    const scorer = sd.createScorerDevices({ pool: db.pool, db, audit: accounts.audit })
    // The end of the match records (db/042, lib/retention.js): the daily sweep below
    const retention = ret.createRetention({ pool: db.pool, storage, audit: accounts.audit })
    dataLayer = { errors, errorAlerts, publicApi, clubApi, retention, db, restore, auth, storage, pins, access, accounts, savedTeams, licences, teams, saveBack, beach, manage, requests, revisions, activity, scoresheets, scorer, finalMail, isScoresheetPdf: ss.isScoresheetPdf, isMatchScoresheetFile: ss.isMatchScoresheetFile, isScoresheetUploadPath: ss.isScoresheetUploadPath, activityCsvLine: act.csvLine, activityCsvColumns: act.CSV_COLUMNS, publicClaim: og.publicClaim, sendAuthResult: au.sendAuthResult, AUTH_ACTIONS: au.AUTH_ACTIONS, ipKey: au.ipBucketKey }
    return dataLayer
  })
  return dataLayerPromise
}

// The server's own errors (lib/errorTracker.js, db/050): stored as error
// events (source server), held until the data layer is up (at most 50).
// The same message at most 10 times a minute (a database outage makes every
// request fail alike, and each capture is a write). Database mode only; never
// throws, never waits.
const SERVER_BUILD = String(process.env.OV_REVISION || '').slice(0, 12) || null
const pendingServerErrors = []
const serverErrorBursts = new Map() // message -> { start, n }
function captureServerError(err, opts = {}) {
  if (!DB_MODE) return
  try {
    const key = `${opts.view || ''}|${String(err?.message || err).slice(0, 120)}`
    const t = Date.now()
    const burst = serverErrorBursts.get(key)
    if (!burst || t - burst.start >= 60 * 1000) {
      if (serverErrorBursts.size > 500) serverErrorBursts.clear()
      serverErrorBursts.set(key, { start: t, n: 1 })
    } else if (++burst.n > 10) {
      return
    }
    const o = { build: SERVER_BUILD, ...opts }
    if (dataLayer?.errors) void dataLayer.errors.captureServer(err, o)
    else if (pendingServerErrors.length < 50) pendingServerErrors.push([err, o])
  } catch { /* an error path must never fail */ }
}
/** "POST /api/match/:id": the route of a request, ids and codes masked (no query). */
function routeLabel(req) {
  let path = String(req?.url || '').split('?')[0].slice(0, 200)
  path = path.split('/').map((seg) => (/\d/.test(seg) || seg.length > 24 ? ':id' : seg)).join('/')
  return `${String(req?.method || '').slice(0, 8)} ${path}`
}

// Realtime (Supabase Realtime replacement): `?purpose=live` sockets get
// db-change events from /api/db + /api/match/restore write-through and from the
// scoreboard's relay live-state-update. DATABASE_URL mode only: a LAN relay
// answers live sockets with its normal 'connected' (mode local) hello, which
// the frontend shim treats as "realtime not supported".
// Live sockets are anonymous: rows are redacted (PINs) and then projected to
// the public columns (no rosters, dates of birth, signatures, officials,
// connection data, event payloads), see lib/publicColumns.js.
const LIVE_PER_NET = Object.freeze({ v6net56: 200, v6net48: 400, v4net24: 400 })
// live sockets in total (the hub's default 3000; the e2e tests lower it)
const LIVE_MAX_CONNECTIONS = Number(process.env.OV_LIVE_MAX_CONNECTIONS) > 0 ? Math.floor(Number(process.env.OV_LIVE_MAX_CONNECTIONS)) : 3000
const realtimeHub = DB_MODE
  ? createRealtimeHub({
    redact: redactSecrets,
    maxTotal: LIVE_MAX_CONNECTIONS,
    project: projectLiveRow,
    summaryProject: projectLiveSummaryRow,
    // one subscriber holds a whole IPv6 /64, as for the role sockets
    bucketOf: (ip) => ipBucketKey(ip),
    // ...and one customer a /56 or /48: 30 /64s of one /56 held all 3000
    // live slots (audit 2611 SEC-08). Per IPv6 /56 twice one /64's 100, per
    // /48 and per IPv4 /24 four times; at the total cap a socket that holds
    // no channel makes room, and one without a channel for 10 s is closed.
    netsOf: (ip) => roleNetsOf(ip, ipBucketKey(ip)),
    maxPerNet: LIVE_PER_NET,
    // a live state's private columns only to a channel that may have them (liveRowGranted)
    privateRows: { project: projectLiveGrantedRow, grants: (channel, table, row, socketChannels, socket) => liveRowGranted(channel, table, row, socketChannels, socket) },
    grantChannel: (msg, socket) => liveChannelGrant(msg, socket),
    // the slots kept for match devices (20 %): a socket with a match token on
    // a channel, or one (no viewer) whose address proved a match recently
    // (review of the SEC-08 fix: any subscribe-db was a channel, and sockets
    // without client=viewer took the tablets' share)
    socketProof: (socket) => liveSocketProof(socket),
    getClientIp: (req) => getClientIp(req)
  })
  : null

// --- A live state's private columns on the live hub (audit 2611 PERM-03) -----
// Live sockets prove nothing: a live state goes out in its public columns
// (LIVE_COLUMNS), as on anonymous /api/db and the relay's PIN-less summary.
// Before, every anonymous subscribe-db (sport_type=indoor: every live match)
// got the line-ups, substitutions, sanctions and last event's data. The
// private columns (LIVE_STATE_PRIVATE_COLUMNS) go to:
//   - a channel whose subscribe-db carries the match token of that match
//     (`token`: the X-OV-Match-Token of the PIN check, issued for matches.id),
//     checked on every publish: the token must still verify, and the match
//     row must still grant it (stillGrantsRow: the role's connection on, its
//     PIN unchanged; the row read again at most every LIVE_GRANT_RECHECK_MS);
//   - unless OV_LIVE_PRIVATE=token: a channel without a token that follows
//     ONE match by its match_id, the only match the socket follows so, on a
//     socket that did not open as a livescore viewer (client=viewer), from an
//     address bucket that proved that match in the last 12 h (addressProofs:
//     a PIN check of validate-connection-pin, an X-OV-Match-Token read on
//     /api/db, a PIN or token the relay accepted on a role socket), and only
//     while that proof still grants the match row as its token would. The
//     apps in the halls (OpenVolley 26.11.x and 3.x) send no token on their
//     live sockets: their referee's scorer alarm and the referee / bench
//     live-state fallback check the PIN from the same device first. A
//     scraper's socket per match, or a public livescore page, proves no
//     match (review of the PERM-03 fix: one anonymous socket per match got
//     every match's line-ups). A channel whose token no longer grants (its
//     connection switched off, its PIN changed) is judged by this rule, and
//     the address's proof is checked against the same row: it ends with it
//     (it used to grant without any proof). A channel by sport_type, or a
//     socket that follows several matches so, gets the public columns only.
const LIVE_PRIVATE_NEEDS_TOKEN = process.env.OV_LIVE_PRIVATE === 'token'
const LIVE_GRANT_RECHECK_MS = 30 * 1000
// a subscribe reads the row again when it is older than this (subscribe-db
// is a cheap message: no database read per message)
const LIVE_GRANT_SUBSCRIBE_RECHECK_MS = 2 * 1000
const LIVE_GRANT_ROWS_MAX = 2000
const liveGrantRows = new Map() // matches.id -> { at, row: { id, connections } | null, pins }
const liveGrantPending = new Set()
// What each address bucket proved (match token payloads), see lib/addressProofs.js
const addressProofs = createAddressProofs()

/** `ipKey` proved the match of a verified token payload (u = matches.id) just now (cloud only). */
function noteAddressProof(ipKey, payload) {
  if (!DB_MODE || !payload || typeof payload.u !== 'string') return
  addressProofs.note(ipKey, payload)
}

/** Read the match row of `matchUuid` again when it is older than `maxAgeMs`. */
function freshenLiveGrantRow(matchUuid, maxAgeMs) {
  const known = liveGrantRows.get(matchUuid)
  if (!known || Date.now() - known.at > maxAgeMs) refreshLiveGrantRow(matchUuid)
  return known
}

/**
 * A subscribe-db's match token, verified: { token, payload, matchUuid } or
 * null. A token-less channel that follows a match its socket's address
 * proved has that match's row read (only then: an anonymous subscribe of any
 * id reads nothing).
 */
function liveChannelGrant(msg, socket = null) {
  const token = typeof msg?.token === 'string' && msg.token.length <= 2048 ? msg.token : null
  if (!token) {
    if (!LIVE_PRIVATE_NEEDS_TOKEN && socket && !socket.viewer && Array.isArray(msg?.subs)) {
      for (const sub of msg.subs.slice(0, 10)) {
        const id = sub?.table === 'match_live_state' && sub.column === 'match_id' && sub.value != null ? String(sub.value) : null
        if (id && addressProofs.proofOf(socket.bucket, id)) freshenLiveGrantRow(id, LIVE_GRANT_SUBSCRIBE_RECHECK_MS)
      }
    }
    return null
  }
  const payload = matchTokens.verify(token)
  if (!payload || typeof payload.u !== 'string' || !payload.u || !isTokenRole(payload.r)) return null
  freshenLiveGrantRow(payload.u, LIVE_GRANT_SUBSCRIBE_RECHECK_MS)
  return { token, payload, matchUuid: payload.u }
}

/** Read the match row a token is checked against (connections, connection_pins) again; never throws. */
function refreshLiveGrantRow(matchUuid) {
  if (liveGrantPending.has(matchUuid)) return
  liveGrantPending.add(matchUuid)
  ;(async () => {
    try {
      const layer = await getDataLayer()
      const { status, body } = await layer.db.runQuery({
        table: 'matches',
        action: 'select',
        params: { columns: 'id, connections, connection_pins', filters: [{ type: 'eq', column: 'id', value: matchUuid }] }
      }, { internal: true, maxRows: 1 })
      const found = status === 200 && Array.isArray(body?.data) ? body.data[0] : null
      liveGrantRows.delete(matchUuid)
      if (liveGrantRows.size >= LIVE_GRANT_ROWS_MAX) liveGrantRows.delete(liveGrantRows.keys().next().value)
      liveGrantRows.set(matchUuid, {
        at: Date.now(),
        row: found ? { id: found.id, connections: found.connections } : null,
        pins: found?.connection_pins && typeof found.connection_pins === 'object' ? found.connection_pins : null
      })
    } catch { /* the next publish asks again */ } finally {
      liveGrantPending.delete(matchUuid)
    }
  })()
}

/** Does a token payload still grant its match row (as on /api/db, stillGrantsRow)? */
function livePayloadStillGrants(payload, matchUuid) {
  const known = freshenLiveGrantRow(matchUuid, LIVE_GRANT_RECHECK_MS)
  return !!known?.row && matchTokens.stillGrantsRow(payload, known.row, known.pins)
}

/** Does the channel's match token still grant its match? */
function liveTokenStillGrants(grant) {
  if (!matchTokens.verify(grant.token)) return false
  return livePayloadStillGrants(grant.payload, grant.matchUuid)
}

/** The match_ids the socket's channels follow match_live_state by (any other filter: '*'). */
function liveStateMatchesOf(channels) {
  const ids = new Set()
  for (const ch of channels.values()) {
    for (const s of ch.subs) if (s.table === 'match_live_state') ids.add(s.column === 'match_id' ? s.value : '*')
  }
  return ids
}

/** May this channel get the private columns of this live-state row (see above)? */
function liveRowGranted(channel, table, row, socketChannels, socket = null) {
  if (table !== 'match_live_state' || row?.match_id == null) return false
  const id = String(row.match_id)
  if (channel.grant && channel.grant.matchUuid === id && liveTokenStillGrants(channel.grant)) return true
  if (LIVE_PRIVATE_NEEDS_TOKEN || !socket || socket.viewer) return false
  const own = liveStateMatchesOf(new Map([['c', channel]]))
  if (own.size !== 1 || !own.has(id)) return false
  const all = liveStateMatchesOf(socketChannels)
  if (all.size !== 1 || !all.has(id)) return false
  const proof = addressProofs.proofOf(socket.bucket, id)
  return !!proof && livePayloadStillGrants(proof, id)
}

/**
 * What a live socket proved, for the slots the hub keeps for match devices
 * (realtimeHub socketProof): the match of a match token on one of its
 * channels; else, for a socket that is no livescore viewer, its address
 * bucket when that proved a match recently (addressProofs). Null: nothing.
 */
function liveSocketProof(socket) {
  for (const ch of socket.channels.values()) if (ch.grant?.matchUuid) return `token:${ch.grant.matchUuid}`
  if (!socket.viewer && addressProofs.provedAny(socket.bucket)) return `address:${socket.bucket}`
  return null
}
let publicStreams = null // lib/publicApi.js createLiveStreams, on first stream
// open public streams per address (default 100 in lib/publicApi.js; the e2e test lowers it)
const PUBLIC_STREAMS_PER_ADDRESS = Number(process.env.PUBLIC_STREAMS_PER_ADDRESS) > 0 ? Math.floor(Number(process.env.PUBLIC_STREAMS_PER_ADDRESS)) : undefined
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
// matches: lib/matchRestore.js MATCH_SERVER_ONLY_COLUMNS (created_by by
// pgQuery's ownership guard, closed_at / closed_by by db/007's trigger,
// official_game_exempt and released_at by an admin's release-game, created_at
// by the database default), the same list a restore drops (PERM-10).
const WRITE_DENYLIST = {
  // dob: no date of birth is kept (db/048, owner 2026-11-19); an older app's
  // profile save still sends one. license_number (db/048) is the owner's
  profiles: ['roles', 'user_id', 'id', 'dob'],
  // db/048: the referee directory keeps names, country and sports only;
  // db/056: who added a row and when are the server's (an older app sends
  // created_at, which is dropped: the daily cap counts by it)
  referee_database: ['dob', 'created_by', 'created_at'],
  user_matches: ['user_id', 'id'],
  // tournament_match_id (db/014): the link to a beach tournament match is the server's
  matches: MATCH_SERVER_ONLY_COLUMNS,
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

// The referee directory (referee_database: names, country, sports; no date
// of birth since db/048) is for the accounts that fill a scoresheet's
// officials (Match setup's referee picker), i.e. admins and the accounts that
// can score indoor or beach (it serves OpenBeach too).
const REFEREE_DIRECTORY_SPORTS = Object.freeze(['indoor', 'beach'])

/**
 * Does this account fill a scoresheet's officials (REFEREE_DIRECTORY_SPORTS)?
 * THROWS when the roles cannot be read (callers answer 503, never "no").
 */
async function fillsOfficials(layer, userId) {
  const a = await layer.access.get(userId)
  if (a.isAdmin) return true
  return REFEREE_DIRECTORY_SPORTS.some((sport) => accessForSport(a, sport).canScore === true)
}

/**
 * May this account read the referees' licence numbers of the schedule
 * (svrz_games, the indoor VolleyManager schedule; db/051,
 * publicColumns.OFFICIALS_ONLY_COLUMNS)? Admins and indoor scorers: the
 * accounts that fill an official match's referees (Match setup's "Load
 * official match"). THROWS when the roles cannot be read (the caller leaves
 * the licences out).
 */
async function readsRefereeLicences(layer, userId) {
  const a = await layer.access.get(userId)
  return a.isAdmin === true || accessForSport(a, 'indoor').canScore === true
}

/**
 * Does this account's /api/db read get the limits of an anonymous one
 * (anonReadOptions, anonDbGate)? An account without any role: anyone may
 * sign up for one. When the roles cannot be read, yes: the limits only bound
 * the read.
 */
async function readsLikeAnonymous(layer, userId) {
  try {
    return (await layer.access.get(userId)).roles.length === 0
  } catch (err) {
    console.warn('[DB] access check failed (read limited like an anonymous one):', err?.message)
    return true
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
 * Does a non-admin's sport_type update of one referee (refereeDirectoryWriteAllowed)
 * keep every sport the row has? Adding is open, removing is for admins. A
 * database error or an unknown row counts as "no" (an admin can still do it).
 */
async function refereeSportsKept(layer, params) {
  const next = params?.data?.sport_type
  if (!Array.isArray(next)) return false
  try {
    const { rows: [r] } = await layer.db.pool.query(
      'SELECT sport_type FROM public.referee_database WHERE id::text = $1', [String(params.filters[0].value)])
    if (!r) return false
    const have = Array.isArray(r.sport_type) ? r.sport_type : []
    return have.every((s) => next.includes(s))
  } catch (err) {
    console.warn('[DB] referee directory check failed:', err?.message)
    return false
  }
}

// PERM-07 (audit 2611): the directory is league-wide and only admins delete
// from it (row by row). An approved scorer used to insert any number of rows
// at once: 201,000 in 2.5 s, and every indoor picker loaded 200 pages and
// then showed none (frontend lib/selectAll.js SELECT_ALL_MAX_PAGES). A
// non-admin's insert takes 1 to REFEREE_DIRECTORY_INSERT_MAX rows, each with
// a first and a last name, none already there (refereeDirectoryInsert), and
// at most REFEREE_DIRECTORY_DAILY_MAX rows per account and 24 h (db/056
// created_by). The apps add one referee at a time (Match setup's officials,
// after their own "is the name there?" lookup), a few per match.
const REFEREE_DIRECTORY_INSERT_MAX = 5
const REFEREE_DIRECTORY_DAILY_MAX = 50
const REFEREE_NAME_MAX = 100
const refereeNameKey = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').toLowerCase() : '')
/** The sports of a directory row as written (an array; a JSON text of one), unique. */
function refereeSportsOf(row) {
  let v = row?.sport_type
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { v = [] }
  }
  return Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))] : []
}
const refereeRefusal = (status, code, message) => ({ status, body: { data: null, error: { message, code } } })

/**
 * The rows of a non-admin's referee directory insert, checked before
 * anything is read: { rows } or { refusal }.
 */
function refereeDirectoryRows(data) {
  const rows = Array.isArray(data) ? data : [data]
  if (rows.length < 1 || rows.length > REFEREE_DIRECTORY_INSERT_MAX || !rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    return { refusal: refereeRefusal(400, 'OV_REFEREE_DIRECTORY_ROWS', `Add 1 to ${REFEREE_DIRECTORY_INSERT_MAX} referees at a time`) }
  }
  const seen = new Set()
  for (const r of rows) {
    const first = refereeNameKey(r.first_name)
    const last = refereeNameKey(r.last_name)
    if (!first || !last || r.first_name.length > REFEREE_NAME_MAX || r.last_name.length > REFEREE_NAME_MAX) {
      return { refusal: refereeRefusal(400, 'OV_INVALID_DATA', 'A referee needs a first and a last name') }
    }
    const key = `${first}\u0000${last}`
    if (seen.has(key)) return { refusal: refereeRefusal(409, 'OV_REFEREE_DUPLICATE', 'This referee is twice in the request (duplicate)') }
    seen.add(key)
  }
  return { rows }
}

/**
 * The referee directory insert of /api/db (`p` checked and stripped), in one
 * transaction serialised per account: the account is recorded as the rows'
 * creator (db/056, when the column is there) and, for a non-admin
 * (`capped`), a referee already in the directory (the same first and last
 * name, any case and spacing, and a sport in common, or no sport given) is
 * refused 409 OV_REFEREE_DUPLICATE ("duplicate": the older apps' save then
 * stays quiet), and more than REFEREE_DIRECTORY_DAILY_MAX new rows in 24 h
 * 429 OV_REFEREE_DIRECTORY_DAILY_LIMIT. Returns pgQuery's { status, body }.
 */
async function refereeDirectoryInsert(layer, userId, p, runOpts, { capped }) {
  const rows = Array.isArray(p.data) ? p.data : [p.data]
  return layer.db.withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ov:referee-directory:${userId}`])
    const cols = (await layer.db.ensureCatalog()).tables.get(REFEREE_DIRECTORY)?.columns
    const owned = cols?.has('created_by') === true && cols.has('created_at')
    if (capped && owned) {
      const { rows: [c] } = await client.query(
        "SELECT count(*)::int AS n FROM public.referee_database WHERE created_by = $1 AND created_at::timestamptz > now() - interval '24 hours'", [userId])
      if (c.n + rows.length > REFEREE_DIRECTORY_DAILY_MAX) {
        return refereeRefusal(429, 'OV_REFEREE_DIRECTORY_DAILY_LIMIT', `At most ${REFEREE_DIRECTORY_DAILY_MAX} new referees a day per account`)
      }
    }
    if (capped) {
      const norm = (expr) => `lower(regexp_replace(btrim(coalesce(${expr}, '')), '\\s+', ' ', 'g'))`
      for (const r of rows) {
        const { rows: dup } = await client.query(
          `SELECT 1 FROM public.referee_database
            WHERE ${norm('first_name')} = ${norm('$1::text')} AND ${norm('last_name')} = ${norm('$2::text')}
              AND (cardinality($3::text[]) = 0
                   OR coalesce(jsonb_typeof(to_jsonb(sport_type)) = 'array' AND to_jsonb(sport_type) ?| $3::text[], false))
            LIMIT 1`, [r.first_name, r.last_name, refereeSportsOf(r)])
        if (dup.length) return refereeRefusal(409, 'OV_REFEREE_DUPLICATE', 'This referee is already in the directory (duplicate)')
      }
    }
    const data = owned ? rows.map((r) => ({ ...r, created_by: userId })) : rows
    return layer.db.runQuery({ table: REFEREE_DIRECTORY, action: 'insert', params: { ...p, data: Array.isArray(p.data) ? data : data[0] } }, { ...runOpts, client })
  })
}

/**
 * Inline take-over of /api/db match inserts/upserts (see the /api/db route):
 * every row of the refused write must carry an external_id and the game PIN
 * of that stored match. Each stored match whose PIN is compared is a counted
 * guess in the brute-force budget, in that match's game-PIN scope (refunded
 * when it proves the PIN). Returns 'claimed' when the user was made an editor
 * of every such match, 'closed' when a match whose PIN it proved closed longer
 * ago than POST /api/match/claim allows (lib/matchRestore.js
 * closedClaimWindowMs: the game PIN is retired at the close; no editor is
 * added, PERM-16), else null.
 */
const CLOSED_MATCH_BODY = { data: null, error: { message: 'This match is closed: its game PIN no longer gives access', code: 'OV_MATCH_CLOSED' } }
async function claimByUpsertPin(layer, userId, data, clientIp) {
  const rows = (Array.isArray(data) ? data : [data]).filter((r) => r && typeof r === 'object')
  if (rows.length === 0 || rows.length > 20) return null
  const claims = []
  for (const row of rows) {
    const ext = typeof row.external_id === 'string' ? row.external_id.trim() : ''
    const pin = row.game_pin == null ? '' : String(row.game_pin).trim()
    if (!ext || ext.length > 200 || !pin) return null
    claims.push({ ext, pin })
  }
  const ipKey = ipBucketKey(clientIp)
  try {
    const cat = await layer.db.ensureCatalog()
    const hasClosed = cat.tables.get('matches')?.columns.has('closed_at') === true
    const found = await layer.db.runQuery({
      table: 'matches',
      action: 'select',
      params: { columns: `id, external_id, game_pin${hasClosed ? ', closed_at' : ''}`, filters: [{ type: 'in', column: 'external_id', value: [...new Set(claims.map((c) => c.ext))] }] }
    }, { internal: true })
    if (found.body.error) return null
    const byExt = new Map((found.body.data || []).map((m) => [m.external_id, m]))
    const proved = []
    let closed = false
    for (const c of claims) {
      const m = byExt.get(c.ext)
      // A new row is not the reason for the refusal; an existing one needs its PIN
      if (!m) continue
      // Counted before the comparison; only a wrong PIN keeps it counted
      const scope = pinScope.match(c.ext, 'game')
      if (pinFailureLimiter.isLimited(ipKey, scope)) return null
      if (!layer.pins.matches('game', c.pin, m.game_pin)) return null
      pinFailureLimiter.refund(ipKey, scope)
      // the same window as POST /api/match/claim (matchRestore claimMatch)
      const closedAt = m.closed_at != null ? new Date(m.closed_at).getTime() : null
      if (closedAt !== null && !(Date.now() - closedAt <= RESTORE_DEFAULTS.closedClaimWindowMs)) closed = true
      proved.push(m.id)
    }
    if (proved.length === 0) return null
    if (closed) return 'closed'
    for (const id of new Set(proved)) {
      if (!(await layer.restore.addEditor(id, userId, 'game_pin'))) return null
    }
    console.log(`[match/claim] inline take-over of ${proved.length} match(es) by game PIN`)
    for (const id of new Set(proved)) await layer.accounts.auditClaimPin({ actorId: userId, matchId: id, via: 'upsert-pin' })
    return 'claimed'
  } catch (err) {
    console.warn('[match/claim] inline take-over failed:', err?.message)
    return null
  }
}

/**
 * The relay's claim on the key `externalId`, as { key, pin, device } (pin
 * null: a room without a game PIN), or null when the relay knows none. Of a
 * key with an origin (roomOriginOf: synced within ROOM_TTL_MS), the game PIN
 * and the scoring device of its first sync: a take-over past the grace puts
 * another PIN in the room, and a finished match's claim goes 60 s after its
 * scorer did. Else the room that holds the key (an active room, a held one
 * within its grace, or a lapsed one that kept its game PIN), no device.
 */
function relayRoomOfKey(externalId) {
  const key = normalizeMatchId(externalId)
  if (!key) return null
  const origin = roomOriginOf(key)
  if (origin) return { key, pin: origin.pin, device: origin.device }
  const room = activeMatches.get(key) || heldRoomOf(key)
  if (room?.match) return { key, pin: gamePinOf(room.match), device: null }
  const lapsed = heldRooms.get(key)
  return lapsed?.lapsed ? { key, pin: lapsed.pin ?? null, device: null } : null
}

// A row's external_id as the database stores it (text, which a number or a
// boolean is cast to): a room's key may be any of them (normalizeMatchId)
function rowKeyOf(row) {
  const v = row && typeof row === 'object' ? row.external_id : undefined
  if (typeof v === 'string') return v
  if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') return String(v)
  return null
}

const MATCH_KEY_IN_USE_BODY = { data: null, error: { message: 'This match id belongs to a live match on another device: creating it here needs that match\'s game PIN', code: 'OV_MATCH_KEY_IN_USE' } }
const PIN_ATTEMPTS_BODY = { data: null, error: { message: 'Too many attempts. Please wait a few minutes before trying again.', code: 'OV_TOO_MANY_ATTEMPTS' } }

/**
 * PERM-01 (audit 2611): a NEW matches row (/api/db insert, the INSERT half of
 * an upsert, POST /api/match/restore) whose external_id is the key of a room
 * the relay holds must carry that room's game PIN, as the room's own scorer's
 * rows do (the app sends the PIN it syncs). Room keys are public
 * (/api/match/list): a row filed first under the key of a match whose insert
 * was still pending made the filer its owner in the database, and the scorer's
 * match never reached the cloud (OV_NOT_MATCH_OWNER, and the take-over by PIN
 * compared the filer's PIN). A row with a PIN is a counted guess in that
 * room's game-PIN scope (pinFailureLimiter, refunded when right). Rows already
 * stored are the ownership guard's; the unique index stays the backstop.
 * The PIN is the key's first one (relayRoomOfKey: its origin), not the one a
 * take-over put in the room since: an anonymous socket takes a key over with
 * a PIN of its own once its scorer has been gone past the grace (60 s for a
 * finished match), and the scorer's pending first insert was then refused
 * for good. The key's first installation (`device`, the request's db/019
 * device: the relay never hands it out) files its own row without a game
 * PIN: an older app's Create match queued before Save made the PIN (OV
 * 3.2.0-3.2.9), OpenBeach's Create match before its relay made one, a
 * restore that keeps a PIN it made up off the server. A row with a PIN
 * needs the key's own: a PIN-less row proves no relay claim
 * (verifyRelayClaim), and a match's owners read its activity log, device ids
 * included, so the device is no proof of a PIN.
 * `rows`: the write's rows with their PINs in clear (before pins.hashMatchRow).
 * @returns {Promise<{ status: number, body: object, code: string } | null>} a refusal, or null
 */
async function newRowRoomRefusal(layer, rows, clientIp, device = null) {
  const held = []
  for (const row of (Array.isArray(rows) ? rows : [rows])) {
    const ext = rowKeyOf(row)
    if (ext === null) continue
    const room = relayRoomOfKey(ext)
    if (room) held.push({ row, ext, room })
  }
  if (held.length === 0) return null
  const found = await layer.db.runQuery({
    table: 'matches',
    action: 'select',
    params: { columns: 'external_id', filters: [{ type: 'in', column: 'external_id', value: [...new Set(held.map((h) => h.ext))] }] }
  }, { internal: true })
  if (found.body.error) return { status: 503, body: DB_UNAVAILABLE_BODY, code: 'OV_DB_UNAVAILABLE' }
  const stored = new Set((found.body.data || []).map((m) => String(m.external_id)))
  const ipKey = ipBucketKey(clientIp)
  for (const { row, ext, room } of held) {
    if (stored.has(ext)) continue
    const pin = gamePinOf(row)
    if (pin === null) {
      if (room.pin === null || (device && room.device !== null && device.id === room.device)) continue
      return { status: 409, body: MATCH_KEY_IN_USE_BODY, code: 'OV_MATCH_KEY_IN_USE' }
    }
    const scope = pinScope.match(room.key, 'game')
    if (pinFailureLimiter.isLimited(ipKey, scope)) return { status: 429, body: PIN_ATTEMPTS_BODY, code: 'OV_TOO_MANY_ATTEMPTS' }
    if (room.pin !== null && safeEqualStr(pin, room.pin)) {
      pinFailureLimiter.refund(ipKey, scope)
      continue
    }
    console.warn('[DB] a new match under the key of a live relay room without its game PIN: refused')
    return { status: 409, body: MATCH_KEY_IN_USE_BODY, code: 'OV_MATCH_KEY_IN_USE' }
  }
  return null
}

// connection_pins keys under the PIN types pinFailureLimiter counts them by
// (lib/matchAccess.js CONNECTION_PIN_TYPES: older beach spellings)
const PIN_TYPE_OF_KEY = { team1_data: 'bench_team1', team2_data: 'bench_team2' }

/**
 * A matches write that carries PINs (game_pin, connection_pins): each PIN it
 * changes starts its count across callers again (pinFailureLimiter
 * pinChanged). The scorer who sets a new PIN for a match under attack lifts
 * that PIN's lock; old wrong guesses say nothing about the new PIN, and a
 * write of the same PIN (the sync queue sends them whole) lifts nothing. The
 * stored PINs of the matches the write names are read before it only while
 * the budget counts anything, and again by done() after it succeeded.
 * Returns { done } or null; never throws (a failed read lifts nothing).
 */
async function watchPinWrites(layer, action, params, actorId = null) {
  if (action !== 'insert' && action !== 'upsert' && action !== 'update') return null
  const rows = params?.data == null ? [] : (Array.isArray(params.data) ? params.data : [params.data])
  // A game PIN change also ends the editors added by the old PIN, so it is watched always
  const writesGamePin = rows.some((r) => r && typeof r === 'object' && 'game_pin' in r)
  if (!writesGamePin && !pinFailureLimiter.tracksAny()) return null
  if (!rows.some((r) => r && typeof r === 'object' && ('game_pin' in r || 'connection_pins' in r))) return null
  const refs = matchRefsOfWrite('matches', action, params)
  const read = async ({ externalIds, ids }) => {
    const out = new Map()
    for (const [column, values] of [['external_id', externalIds], ['id', ids]]) {
      if (!values.length) continue
      const r = await layer.db.runQuery({
        table: 'matches',
        action: 'select',
        params: { columns: 'id, external_id, game_pin, connection_pins', filters: [{ type: 'in', column, value: values }] }
      }, { internal: true })
      if (r.body.error) throw new Error(r.body.error.code || 'lookup failed')
      for (const row of r.body.data || []) if (row.external_id) out.set(row.external_id, row)
    }
    return out
  }
  const pinsOf = (row) => ({ game_pin: row?.game_pin ?? null, ...(row?.connection_pins && typeof row.connection_pins === 'object' ? row.connection_pins : {}) })
  let before
  try {
    before = await read(refs)
  } catch (err) {
    console.warn('[DB] stored PINs not read before a match write:', err?.message)
    return null
  }
  if (before.size === 0) return null
  return {
    async done() {
      try {
        const after = await read({ externalIds: [...before.keys()], ids: [] })
        for (const [ext, row] of after) {
          const was = pinsOf(before.get(ext))
          const now = pinsOf(row)
          const changed = [...new Set([...Object.keys(was), ...Object.keys(now)])]
            .filter((k) => JSON.stringify(was[k] ?? null) !== JSON.stringify(now[k] ?? null))
            .map((k) => (k === 'game_pin' ? 'game' : PIN_TYPE_OF_KEY[k] || k))
          if (changed.length) pinFailureLimiter.pinChanged(ext, changed)
          if (changed.includes('game') && !sameGamePin(layer, was.game_pin, now.game_pin)) await dropPinEditors(layer, row.id, actorId)
        }
      } catch (err) {
        console.warn('[DB] stored PINs not read after a match write:', err?.message)
      }
    }
  }
}

/** The same game PIN, also when one side is its legacy plaintext and the other its hash. */
function sameGamePin(layer, was, now) {
  const a = was == null ? '' : String(was).trim()
  const b = now == null ? '' : String(now).trim()
  // matches() never takes a hash for the typed side: only plaintext -> its hash
  return a === b || (a !== '' && b !== '' && layer.pins.matches('game', a, b))
}

/**
 * The game PIN of a match changed: the accounts that became editors by the
 * old PIN are editors no more, except the account that changed it (a
 * take-over tablet that sets a new PIN keeps scoring).
 */
async function dropPinEditors(layer, matchUuid, actorId = null) {
  if (!matchUuid || !layer.db?.pool) return
  try {
    await layer.db.pool.query(
      "DELETE FROM public.match_editors WHERE match_id = $1 AND granted_via <> 'admin' AND ($2::uuid IS NULL OR user_id <> $2::uuid)",
      [matchUuid, actorId || null])
  } catch (err) {
    console.warn('[DB] editors by the old game PIN not removed:', err?.code || err?.message)
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

/**
 * Who asks a game-PIN check (claim, restore-by-pin), for lib/matchRestore.js
 * trustedFor: the signed-in account (`userId`, its admin role read only when
 * a range lock refuses it) and the device it names (`device`, deviceOf), or
 * null when neither. A roles read that fails trusts nothing.
 */
function pinTrustOf(layer, userId, device) {
  if (!userId && !device) return null
  return {
    userId: userId || null,
    deviceId: device?.id || null,
    isAdmin: async () => {
      if (!userId) return false
      try { return (await layer.access.get(userId))?.isAdmin === true } catch { return false }
    }
  }
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

/**
 * The scoring-device check of a write that runs its own transaction (the
 * event history, a backup restore): (client, externalId) => null or the 409
 * answer, inside that transaction (lib/scorerDevice.js lockedHolder: the
 * scorer row locked, so a take-over waits for the write or the write sees
 * it). `ageMs`: a backup restore made that long ago (movedSince). null
 * without a device: an app from before the handover is not checked.
 */
function scorerCheckOf(layer, device, matchOwner, { ageMs } = {}) {
  if (!device || !layer?.scorer) return null
  return async (client, externalId) => {
    const holder = ageMs !== undefined
      ? await layer.scorer.movedSince(client, { device, externalId, ageMs, matchOwner })
      : await layer.scorer.lockedHolder(client, { device, refs: { externalIds: [externalId], ids: [] }, matchOwner })
    return holder ? { status: 409, body: scorerMovedBody(holder) } : null
  }
}

/**
 * A take-over by `device` that came with another request (the backup
 * restore): the device scores the match from now on (db/019). Never throws,
 * never changes the request's answer.
 */
async function claimScorerDevice(layer, body, matchOwner, userId, where) {
  if (!layer?.scorer || !deviceOf(body?.device) || typeof body?.external_id !== 'string') return
  try {
    const r = await layer.scorer.claim({ body: { ...body, claim: true }, matchOwner, userId })
    if (r.status === 200 && r.body.data?.moved) scorerMoved(r, deviceOf(body.device)?.id)
  } catch (err) {
    console.warn(`[${where}] scorer-device take-over failed:`, err?.message)
  }
}

/**
 * restore-by-pin with claim: the device that proved the game PIN of `match`
 * ({ id, external_id }) scores it from now on (lib/scorerDevice.js
 * claimProved); the previous one is told. `expectedExt`: the match the app
 * continues ("Take back scoring here" names its own): another match found by
 * the same game number and PIN is never claimed. Returns the answer's
 * `scorer` ({ mine, moved }) or null (not claimed: test or closed match,
 * another match, no db/019).
 */
async function takeOverByPin(layer, match, device, userId, expectedExt) {
  if (typeof expectedExt === 'string' && expectedExt && expectedExt !== match.external_id) return null
  const r = await layer.scorer.claimProved({ matchId: match.id, device, userId })
  if (!r) return null
  if (r.data.moved) scorerMoved({ body: { data: r.data }, matchId: r.matchId }, device.id)
  return { mine: true, moved: r.data.moved }
}

/**
 * Another device scores a match now (a granted scorer claim, `r`): tell the
 * relay room (notifyScorerMoved), and order the match's live states afresh.
 * The realtime hub orders them by updated_at, the scoring device's clock: a
 * device whose clock is behind the previous one's had all its states dropped
 * as older (forgetOrder).
 */
function scorerMoved(r, deviceId) {
  notifyScorerMoved(r.body.data.external_id, deviceId)
  if (r.matchId) realtimeHub?.forgetOrder('match_live_state', r.matchId)
}

/**
 * Tell the scoreboards in the match's relay room that another device scores
 * it now (db/019). The message names the match only: each scoreboard asks
 * POST /api/match/scorer {claim: false} whether it is still the scorer (no
 * device id is ever broadcast). The new scorer asks too and stays.
 * `deviceId`: the new scorer. A socket that synced the room naming another
 * device no longer speaks for it: its next sync is checked again
 * (verifyRelayClaim) and refused, so its copy cannot replace the room before
 * its app has heard of the move. A claim of such a socket whose database
 * check is still running (clientInfo.claimCheck) is refused when the check
 * ends ('scorer-moved'): it was checked before the move.
 */
function notifyScorerMoved(externalId, deviceId = null) {
  const key = normalizeMatchId(externalId)
  if (key && deviceId) {
    for (const c of connections.values()) {
      if (!c.scorerDevice || c.scorerDevice === deviceId) continue
      c.ownedMatches.delete(key)
      if (c.claimCheck?.matchId === key) c.claimCheck.moved = true
    }
  }
  const room = key ? rooms.get(key) : null
  if (!room) return
  // Its sockets lost the claim: gone until the new scorer's socket syncs,
  // unless that one is in the room already (scorer-presence)
  updateScorerPresence(key)
  const data = JSON.stringify({ type: 'scorer-moved', matchId: key, timestamp: Date.now() })
  let sent = 0
  room.clients.forEach((clientId) => {
    const clientInfo = connections.get(clientId)
    if (clientInfo?.role === 'scoreboard' && clientInfo.ws.readyState === 1) {
      try { clientInfo.ws.send(data); sent++ } catch { /* closing */ }
    }
  })
  if (sent) console.log(`🔁 Scorer moved: told ${sent} scoreboard(s) in room ${logValue(key)}`)
}

// Secret fields on an in-memory match object that must never reach a client.
// The team1*/team2* ones are openbeach's names for the bench and upload PINs
// (team1Pin, older builds team1TeamPin); matchPin is openbeach's PIN that
// protects the match on the scorer's device.
const MATCH_SECRET_FIELDS = ['refereePin', 'homeTeamPin', 'awayTeamPin', 'homeTeamUploadPin', 'awayTeamUploadPin', 'connection_pins', 'connectionPins', 'game_pin', 'gamePin',
  'team1Pin', 'team2Pin', 'team1TeamPin', 'team2TeamPin', 'team1UploadPin', 'team2UploadPin', 'team1TeamUploadPin', 'team2TeamUploadPin', 'matchPin']
// The PINs among them that the relay compares or hands to a PIN check: text of
// at most 64 characters or a number in a sync (relayBundleProblem). The
// connection_pins objects are the database's, never compared by the relay.
// matchPin is openbeach's device lock, never compared by the relay and typed
// with no maximum length, so only its type is checked, not its length
// (MATCH_PIN_TYPE_ONLY_FIELDS): a long one must not stop a sync silently.
// Those the relay only keeps and carries over (MATCH_CARRIED_PIN_FIELDS) are
// bounded in size instead, far above what an app holds
// (MAX_RELAY_CARRIED_PIN_BYTES each).
const MATCH_PIN_TYPE_ONLY_FIELDS = ['matchPin']
const MATCH_PIN_FIELDS = MATCH_SECRET_FIELDS.filter((k) => k !== 'connection_pins' && k !== 'connectionPins' && !MATCH_PIN_TYPE_ONLY_FIELDS.includes(k))
const MATCH_CARRIED_PIN_FIELDS = MATCH_SECRET_FIELDS.filter((k) => !MATCH_PIN_FIELDS.includes(k))
function stripMatchSecrets(match) {
  if (!match || typeof match !== 'object') return match
  const clean = { ...match }
  for (const k of MATCH_SECRET_FIELDS) delete clean[k]
  return clean
}

// Room / activeMatches key: always String(matchId). The scoreboard sends the
// numeric Dexie id, subscribers send a string; without this they ended up in
// different rooms (Map treats 5 and "5" as different keys). At most 128
// characters and no control characters: a key is looked up in the database
// (verifyRelayClaim), where a NUL made the query fail.
const MATCH_KEY_CONTROL_RE = /[\u0000-\u001f\u007f]/
function normalizeMatchId(id) {
  if (id === undefined || id === null) return null
  const s = String(id).trim()
  return s && s.length <= 128 && !MATCH_KEY_CONTROL_RE.test(s) ? s : null
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
// A seed key the relay cannot take as the room key (over 128 characters,
// control characters): such a sync is refused before anything looks it up.
// It used to fall back to the id the socket sent, any match's public
// external id, while the seed key went to the database check, where a NUL
// failed the query.
function badSeedKey(match) {
  const seed = match && typeof match === 'object' ? (match.seed_key ?? match.seedKey) : null
  return typeof seed === 'string' && seed.trim() !== '' && normalizeMatchId(seed) === null
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
// need the PIN. 'display': a scoreboard display following the match
// (display-presence, lib/displayPresence.js).
const DEVICE_LABELS = ['referee', 'bench', 'livescore', DISPLAY_DEVICE]

// The match's game PIN as a comparable string, or null (test matches have
// none). Text or a number only, like the other PINs (lib/matchAccess.js).
function gamePinOf(match) {
  if (!match || typeof match !== 'object') return null
  const v = match.gamePin != null && match.gamePin !== '' ? match.gamePin : match.game_pin
  if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) return null
  const s = String(v).trim()
  return s || null
}

function safeEqualStr(a, b) {
  const x = Buffer.from(String(a), 'utf8')
  const y = Buffer.from(String(b), 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

// The PIN-free, personal-data-free bundle every match-full-data /
// match-data-update and GET /api/match/:id carries after the PIN step, by
// what the PIN proved (`view`: 'scorer', 'referee', 'home', 'away';
// lib/publicColumns.js relayBundleView) — the same flat shape the LAN relays
// send (frontend/electron/lanRelayCore.cjs). Only the scorer, who sent it,
// has the whole bundle. The stored entry goes in as it is: relayBundleView
// does its costly parts once per stored bundle.
function wireBundle(entry, view) {
  const bundle = relayBundleView(entry, view)
  return { ...bundle, match: stripMatchSecrets(bundle.match) }
}

// The match in validate-pin's answer: the match row of the bundle the PIN
// opens (relayMatchView), so a bench PIN learns no more of the other team
// here than from its bundle. `found` is the stored match under its room key.
function validatePinMatch(found, type, sport) {
  const entry = activeMatches.get(String(found.id))
  const match = { ...stripMatchSecrets(relayMatchView(entry?.match ? entry : { match: found }, relayViewOf(type))), id: found.id }
  return sport === 'beach' ? { ...match, sportType: 'beach' } : match
}

// match-full-data / match-data-update. A stored liveState is mirrored under
// `data` (and nothing else is) for the LedBox bridge, which reads
// msg.data.liveState — same as the LAN relays. `view` null (no PIN proved):
// teams, status, set scores and live state only (relaySummaryBundle), else
// the bundle of that view, `access` 'full'.
function matchDataMessage(type, matchId, entry, scoreboardTs, view = null) {
  const now = Date.now()
  const bundle = view ? { access: 'full', ...wireBundle(entry, view) } : relaySummaryBundle(entry)
  const msg = { type, matchId, ...bundle, _timestamp: now, _scoreboardTimestamp: scoreboardTs || now }
  if (entry.liveState !== undefined) msg.data = { liveState: bundle.liveState }
  return msg
}


// POST /api/match/send-info and /send-pin mail the signed-in scorer's own
// address (sendOwnMail): through the account-email mailbox (SMTP,
// lib/mailer.js), else through the Resend API (RESEND_API_KEY, a backend
// without SMTP). /api/contact mails only CONTACT_EMAIL (lib/contact.js). The
// old SMTP transport of send-info (SMTP_LEGACY_ROUTES=1) is gone.
if (process.env.RESEND_API_KEY) console.log('[Email Config] RESEND_API_KEY: SET')

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

/**
 * A mail the signed-in user asked for to its own address `to` (send-info,
 * send-pin), and the answer: 200 { success, message }. Over the account-email
 * mailbox when it is on (mailer.sendUser: hourly budget "user", at most 5 an
 * hour per inbox), else over Resend. A mail a limit holds back answers 429
 * OV_MAIL_LIMIT (the app's "too many emails, use your mail app"): the address
 * is the caller's own, so that tells nothing about anyone else, while a
 * "sent" would leave the scorer waiting for a PIN that never comes. Throws
 * when the send fails.
 */
async function sendOwnMail(res, mailer, { to, subject, text, message }) {
  if (mailer?.enabled) {
    if (!(await mailer.sendUser({ to, subject, text })).sent) {
      sendJson(res, 429, { success: false, code: 'OV_MAIL_LIMIT', error: 'Too many emails for now, try again later' })
      return
    }
  } else {
    await sendViaResend(to, subject, text)
  }
  sendJson(res, 200, { success: true, message })
}
// The support form's mail (lib/contact.js): From MAIL_FROM, To CONTACT_EMAIL,
// Reply-To the user, so FreeScout makes the user the ticket's customer.
const contactMailer = contactMailerFromEnv(process.env)
// At most 10 support requests at once, each up to 14 MB in memory for up to 2 min
const contactSlots = createContactSlots()
if (contactMailer.enabled) {
  console.log(`[Contact] support form mails ${contactMailer.to} from ${contactMailer.from} over ${contactMailer.host}${contactMailer.fallbackHost ? ` (a mail it refuses: over ${contactMailer.fallbackHost})` : ''}`)
} else if (DB_MODE || process.env.SMTP_HOST) {
  console.warn(`[Contact] support form mail off (${contactMailer.reason}): POST /api/contact answers 503`)
}
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
// The claim of a room that emptied (its PINs and scoring device), kept for
// the take-over grace (holdRoom)
const heldRooms = new Map()

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
        params: { columns: 'id, external_id, sport_type, game_pin, closed_at', filters: [{ type: 'eq', column: key.column, value: key.value }], limit: 1 }
      }, { internal: true })
      if (r.body.error) throw new Error(r.body.error.code || 'lookup failed')
      return r.body.data?.[0] || null
    },
    // Owning a relay room proves the room's game PIN, not the database row the
    // synced match points at (match.externalId / seed_key are public): the
    // synced game PIN must be the row's, else nothing is published. A row
    // without a game PIN cannot be bound and gets nothing either (the
    // scorer's HTTP sync still updates it).
    // A row the room's game PIN was not proved for yet (verifyRelayClaim, or
    // here before) is one counted comparison (relayPinAttempt, under that
    // match's game PIN in pinFailureLimiter), refused while that PIN is
    // locked: a room re-pointed at another match's row (an owner's re-sync is
    // not checked again) showed a public live subscriber whether its PIN was
    // that row's, outside every limit. Once proved, the room is bound to the
    // row (bindRoomRows) and its live states are never counted.
    // A closed match (db/007) is frozen for livescore too: nothing is published.
    // This relay is gated by the game PIN, not by an account: a socket carries
    // no session, so the approved-scorer rule (docs/scorer-accounts-spec.md
    // decision 1) does not apply to it. Nothing it relays is stored.
    verifyMatch: (row, synced, client) => {
      if (row?.closed_at != null) return false
      const pin = gamePinOf(synced?.match)
      if (!pin || !dataLayer?.pins || row?.game_pin == null || String(row.game_pin).trim() === '') return false
      const same = () => dataLayer.pins.matches('game', pin, row.game_pin)
      if (isBoundRow(synced, pin, row.id)) return same()
      if (!client) return false
      const r = relayPinAttempt(client, pinScope.match(dbPinKey(row), 'game'), same, { pin })
      if (r !== 'ok') return false
      bindRoomRows(synced, pin, [row.id])
      return true
    }
  })
}

// --- Capacity limits ---
const MAX_ROOMS = 500
const MAX_CONNECTIONS = Number(process.env.OV_MAX_CONNECTIONS) > 0 ? Math.floor(Number(process.env.OV_MAX_CONNECTIONS)) : 2000
// Admission: above this share of V8's heap limit a new socket is told "relay
// busy" (1013, the apps retry) instead of the process running into the heap
// limit or the container's memory limit and dropping every match it holds.
const ADMIT_HEAP_PCT = Number(process.env.OV_ADMIT_HEAP_PCT) > 0 ? Math.min(100, Number(process.env.OV_ADMIT_HEAP_PCT)) : 85
let admissionRefused = 0
// Heap left after the last major GC (the live data); the boot heap until the
// first one. admissionHeapPressure counts the lower of this and the heap now.
let heapAfterMajorGc = getHeapStatistics().used_heap_size
const gcObserver = new PerformanceObserver(list => {
  if (list.getEntries().some(e => e.detail?.kind === perfConstants.NODE_PERFORMANCE_GC_MAJOR)) {
    heapAfterMajorGc = getHeapStatistics().used_heap_size
  }
})
gcObserver.observe({ entryTypes: ['gc'] })
function heapPressure() {
  const h = getHeapStatistics()
  return admissionHeapPressure({ usedNow: h.used_heap_size, usedAfterMajorGc: heapAfterMajorGc, limit: h.heap_size_limit })
}
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
// (frontend/electron/lanRelayCore.cjs). OV_ORPHAN_TAKEOVER_TEST_MS: tests
// only, a shorter grace for finished matches; never in production.
const ORPHAN_TAKEOVER_MS = process.env.NODE_ENV !== 'production' && Number(process.env.OV_ORPHAN_TAKEOVER_TEST_MS) > 0
  ? Number(process.env.OV_ORPHAN_TAKEOVER_TEST_MS)
  : 60 * 1000
const STALE_TAKEOVER_MS = 10 * 60 * 1000
// Wrong game-PIN claims per socket and minute before claims needing proof are
// refused without comparing the PIN (no guessing oracle). Only a claim that
// carries a PIN counts. Per address (IPv6 /64) they are counted in the
// brute-force budget of every other PIN check, in the match's game-PIN scope
// (pinFailureLimiter: 20 wrong PINs in 10 minutes); a right PIN is refunded,
// so every scorer of a venue NAT may reconnect at once.
const CLAIM_FAILURE_LIMIT = 5
// Distinct match ids one IP's sockets may own at once / claim per minute
// (higher than the LAN relays: a club's courts can share one NAT address, a
// whole hall a school network or a mobile CGNAT address). 20 refused the
// 21st scorer of a 32-match hall for the whole set, so its referee and bench
// tablets got no bundle (national peak load test 2026-10-26). Claims per
// minute as many: after a relay restart a hall reclaims all its matches at
// once.
const MAX_OWNED_PER_IP = 64
const NEW_CLAIM_LIMIT = 64
// Rooms the syncs of one address keep (entry.relayAddress), as many as it may
// own: an address whose sockets close and reconnect cannot fill MAX_ROOMS
// with rooms a subscriber keeps open after it ('room-limit'). On the cloud
// the rooms the database did not prove count as many per /56 (entry.relayNet):
// one IPv6 customer holds 256 /64s or more. The same share bounds one
// address's held claims (heldRooms).
const MAX_ROOMS_PER_ADDRESS = MAX_OWNED_PER_IP
// Cloud (DATABASE_URL): the rooms the database did not prove (no game PIN of
// an official match) may take this many of MAX_ROOMS together, as their
// bundles may take RELAY_ANON_SHARE of the relay memory: the rest is kept for
// official matches.
const MAX_ANON_ROOMS = Math.floor(MAX_ROOMS * RELAY_ANON_SHARE)
// Rooms one socket is in or waits for (subscribe-match): the relay livescore
// follows up to 32 matches on one socket (frontend utils/relayLivescore.js).
// A 33rd leaves the oldest. Joining a match the relay does not hold creates
// no room: the socket waits for its first sync (admitWaiting).
const MAX_SOCKET_ROOMS = 32
// Emptied rooms whose claim is held for the take-over grace (heldRooms), at
// most; over it the oldest claim of the address holding the most is released
// (makeHeldRoom)
const MAX_HELD_ROOMS = 2000
const FINISHED_STATUSES = new Set(['final', 'ended', 'completed', 'finished'])
// Memory the stored bundles and live states may take (approxHeapBytes,
// lib/relayLimits.js), in total and per address: the IPv6 /64 on the cloud,
// the address on a venue relay (as MAX_CONNECTIONS_PER_IP); the relay host
// itself counts in the total only, as it is exempt from MAX_OWNED_PER_IP.
let RELAY_MEMORY
try {
  RELAY_MEMORY = relayMemoryBudget({ heapLimitBytes: getHeapStatistics().heap_size_limit, maxMb: process.env.OV_RELAY_MAX_MB })
} catch (err) {
  console.error(`[Config] ${err.message}`)
  process.exit(1)
}
console.log(`[Relay] memory for match data: ${Math.round(RELAY_MEMORY.total / 1048576)} MB, ${Math.round(RELAY_MEMORY.perAddress / 1048576)} MB per address`)

// --- Input validation constants ---
const VALID_ROLES = ['scoreboard', 'referee', 'bench', 'subscriber', 'livescore']
const VALID_TEAMS = ['home', 'away']

// --- Security helpers ---
// SEC-35: one plain address (lib/emailAddress.js EMAIL_RE): a stored
// 'x<a@b.ch>' or 'a@b.ch,c' (an admin's address change before the strict
// check) is no address to mail, as nodemailer would read a list from it
function isValidEmail(email) {
  return isEmailAddress(email)
}

// Six digits, as text or a number. An object or array is none: String() of
// { toString: 1 } throws, and the route answered 500.
function isValidPin(pin) {
  if (typeof pin !== 'string' && typeof pin !== 'number') return false
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
const TEST_MAIL_RATE_LIMIT_MAX = 10      // /api/scoresheet/test-mail per user and minute
// One Map per category so counters don't interfere across endpoint types.
// "per IP" is per address bucket (addressKey): on the cloud an IPv6 /64.
const rateLimitMaps = {
  default: new Map(),   // validate-pin, per IP (/64)
  relay: new Map(),     // relay reads: /api/match/list|:id, /api/server/connections, per IP
  contact: new Map(),   // /api/contact, per IP
  publicApi: new Map(), // /api/public/v1/*
  clubApi: new Map(),   // /api/club/v1/*, per token
  clubApiIp: new Map(), // /api/club/v1/*, per IP
  publicApiStream: new Map(), // /api/public/v1/matches/:id/stream (new streams)
  email: new Map(),     // /api/match/send-info, per IP and per user id
  pinEmail: new Map(),  // /api/match/send-pin, per IP and per user id
  ical: new Map(),      // /api/official-matches, per IP
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
  testMail: new Map(),  // /api/scoresheet/test-mail, per user id
  publicBeach: new Map(), // /api/public/beach/t/:slug, per IP
  publicClubs: new Map(), // /api/public/clubs, per IP
  scoresheetView: new Map(), // /api/scoresheet-view/*, per IP
  global: new Map(),    // /api/global/*, per IP
  activity: new Map()   // POST /api/activity, per user id
}
// Keys per category: a flood of new keys (every address of a routed IPv6
// prefix, a botnet) evicts the oldest windows (Map insertion order), never the
// whole map, and never grows the heap without bound (the backend runs with
// 256 MB; a key with its window takes about 170 bytes).
const RATE_LIMIT_MAX_KEYS = 10000

/**
 * The steps every mail to the caller's own address takes before its own
 * checks (POST /api/match/send-info and /send-pin), in this order: per address
 * (`category`, EMAIL_RATE_LIMIT_MAX), the database mode, a session
 * (layer.auth.requireUser), a way to mail (the SMTP mailer, else the Resend
 * key; sendOwnMail), per account (the same category), then the JSON body.
 * Answers the request itself and returns null on any refusal; else
 * { layer, user, body }.
 */
async function ownMailRequest(req, res, category) {
  if (isRateLimited(addressKey(req), EMAIL_RATE_LIMIT_MAX, category)) {
    req.resume()
    sendJson(res, 429, { success: false, error: 'Too many requests' }, { 'Retry-After': '60' })
    return null
  }
  if (!DB_MODE) {
    req.resume()
    sendJson(res, 503, { success: false, error: 'Email not configured on server' })
    return null
  }
  const layer = await getDataLayer()
  const user = await layer.auth.requireUser(req, res)
  if (!user) return null
  if (!layer.auth.mailer?.enabled && !process.env.RESEND_API_KEY) {
    req.resume()
    sendJson(res, 503, { success: false, error: 'Email not configured on server' })
    return null
  }
  if (isRateLimited(user.id, EMAIL_RATE_LIMIT_MAX, category)) {
    req.resume()
    sendJson(res, 429, { success: false, error: 'Too many requests' }, { 'Retry-After': '60' })
    return null
  }
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    sendJson(res, 400, { success: false, error: 'Invalid request' })
    return null
  }
  return { layer, user, body }
}

/** A match row the account ($2) created or edits (alias m). */
const OWN_MATCH_SQL = '(m.created_by = $2::uuid OR EXISTS (SELECT 1 FROM public.match_editors e WHERE e.match_id = m.id AND e.user_id = $2::uuid))'

/** May the account score a match of any sport? */
async function canScoreSomeSport(layer, userId) {
  const a = await layer.access.get(userId)
  return MATCH_SPORTS.some((sport) => accessForSport(a, sport).canScore === true)
}

/** The account's own address when it is valid and confirmed, else null. */
async function ownConfirmedAddress(layer, userId) {
  const { rows: [u] } = await layer.db.pool.query('SELECT email FROM auth.users WHERE id = $1', [userId])
  const confirmed = await layer.accounts.confirmationOf(layer.db.pool, userId)
  return u?.email && isValidEmail(u.email) && confirmed && !confirmed.unconfirmed ? u.email : null
}

/**
 * The rate-limit key of a request's address. On the cloud the address bucket
 * of lib/auth.js ipBucketKey: IPv4 as is, IPv6 by /64, since one subscriber
 * holds a whole /64 and a per-address key would be no limit at all. A venue
 * relay counts per address, like its socket cap: every tablet of a hall LAN
 * shares one IPv6 /64.
 */
/**
 * The support form's sender (lib/contact.js handleContact): its network (the
 * /56 of an IPv6 address, an IPv4 address as is), signed in (a valid session
 * in the Authorization header), trusted (that account has a confirmed
 * address and a role, SEC-31), its address, and scoring a live match (the
 * scoring device of a match that has not ended, claimed by this account in
 * the last 12 hours). Never throws: anything unclear is { signedIn: false }.
 */
async function contactSender(req) {
  const network = contactNetworkKey(ipBucketKey(getClientIp(req)))
  const anonymous = { signedIn: false, trusted: false, liveMatch: false, network }
  const token = DB_MODE ? bearerFromHeaders(req.headers) : null
  if (!token) return anonymous
  try {
    const layer = await getDataLayer()
    const user = (await layer.auth.verifyAccessToken(token))?.user
    if (!user) return anonymous
    const { rows: [who] } = await layer.db.pool.query(SENDER_SQL, [user.id, EMAIL_CONFIRMATION_MARK.key, EMAIL_CONFIRMATION_MARK.value])
    let liveMatch = false
    try {
      const { rows } = await layer.db.pool.query(
        LIVE_MATCH_SQL, [user.id])
      liveMatch = rows.length > 0
    } catch { /* no db/019: no live match known */ }
    const confirmed = who?.confirmed === true
    return { signedIn: true, trusted: confirmed && who?.has_role === true, confirmed, accountId: user.id, email: who?.email || null, liveMatch, network }
  } catch {
    return anonymous
  }
}

function addressKey(req) {
  const ip = getClientIp(req)
  return IS_CLOUD ? ipBucketKey(ip) : ip
}

function isRateLimited(key, maxRequests = RATE_LIMIT_MAX_REQUESTS, category = 'default') {
  // A category without a map of its own gets one: categories never share a
  // counter (approvals, the approval PIN and the test mail once all counted in
  // 'default', in one counter per user)
  if (!Object.hasOwn(rateLimitMaps, category)) rateLimitMaps[category] = new Map()
  const map = rateLimitMaps[category]
  const now = Date.now()
  const entry = map.get(key)

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // A new window goes to the end of the insertion order
    if (entry) map.delete(key)
    else while (map.size >= RATE_LIMIT_MAX_KEYS) map.delete(map.keys().next().value)
    map.set(key, { count: 1, windowStart: now })
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

/**
 * The pgQuery options of an /api/db read without a checked session or by an
 * account without a role (see ANON_DB_COUNT_CAP): a bounded count, a short
 * statement timeout, and on events / sets without an eq or in filter on id,
 * external_id or match_id the small row cap.
 */
function anonReadOptions(table, params) {
  const keyed = Array.isArray(params?.filters) && params.filters.some((f) =>
    f && typeof f === 'object' && (f.type === 'eq' || f.type === 'in') && ANON_DB_KEY_COLUMNS.has(f.column))
  return {
    countCap: ANON_DB_COUNT_CAP,
    statementTimeoutMs: ANON_DB_STATEMENT_TIMEOUT_MS,
    ...(ANON_DB_SCAN_TABLES.has(table) && !keyed ? { maxRows: ANON_DB_SCAN_ROWS } : {})
  }
}

/**
 * The external_id of an /api/db filter list that is exactly ONE eq on
 * external_id (the app's delete of one event), else null.
 */
/**
 * Whether a match with this external_id is stored (any owner), was deleted
 * (db/043 deleted_matches) or was never seen: 'stored' | 'deleted' | 'unknown'.
 * PERM-17 (audit 2611): 'deleted' only to an account that could write the
 * match when it went (db/056 deleted_matches.owners: its creator and its
 * editors) and to an admin; anyone else hears 'unknown', as of a match never
 * stored, so no account learns which of another club's matches were
 * deleted. The app holding the match's sent jobs hears 'deleted' too when
 * the request names a device that scored the match (`device`, db/060
 * deleted_matches.devices: its scoring device and its revisions' devices),
 * whoever is signed in on it: another scorer on the club tablet, or the
 * creator's account deleted since, made the app read 'unknown' as "lost"
 * and send an admin's deleted match back (2611 review, SR-1). A stored match
 * is answered to everyone: /api/db shows it to anyone, and an app told
 * 'unknown' sends it again. A match deleted before db/056 (no list) keeps
 * its answer.
 */
async function matchState(layer, externalId, viewerId = null, deviceId = null) {
  const { rows } = await layer.db.pool.query(
    `SELECT EXISTS (SELECT 1 FROM public.matches WHERE external_id = $1) AS stored,
            EXISTS (SELECT 1 FROM public.deleted_matches WHERE external_id = $1) AS deleted,
            (SELECT to_jsonb(d) -> 'owners' FROM public.deleted_matches d WHERE external_id = $1) AS owners,
            (SELECT to_jsonb(d) -> 'devices' FROM public.deleted_matches d WHERE external_id = $1) AS devices`, [externalId])
  const r = rows[0]
  if (r?.stored) return 'stored'
  if (!r?.deleted) return 'unknown'
  if (!Array.isArray(r.owners)) return 'deleted'
  if (typeof deviceId === 'string' && deviceId && Array.isArray(r.devices) && r.devices.includes(deviceId)) return 'deleted'
  if (typeof viewerId === 'string' && (r.owners.includes(viewerId) || await isAdminUser(layer, viewerId))) return 'deleted'
  return 'unknown'
}
const MATCH_DELETED_BODY = { data: null, error: { message: 'This match was deleted', code: 'OV_MATCH_DELETED' } }
const MATCH_UNKNOWN_BODY = { data: null, error: { message: 'This match is not on the server', code: 'OV_MATCH_UNKNOWN' } }

function singleExternalIdFilter(filters) {
  if (!Array.isArray(filters) || filters.length !== 1) return null
  const f = filters[0]
  if (!f || typeof f !== 'object' || f.type !== 'eq' || f.column !== 'external_id') return null
  return typeof f.value === 'string' && f.value !== '' ? f.value : null
}

// --- Request body reader ---
// Reads at most maxSize bytes. A larger body is NOT destroyed mid-stream (that
// lost the error response with the socket): the promise rejects with
// code BODY_TOO_LARGE, the rest of the body is discarded, and the handler sends
// its 413 (see sendBodyError) with `Connection: close`.
//
// The promise settles whatever the client does. A request read late (after a
// wait in a concurrency gate: /api/match/restore) may have lost its client
// while it waited: Node has destroyed it then, and a destroyed request emits
// nothing more, so listeners added now would wait forever, and the gate slot
// held around the read would never be given back (two such requests stopped
// every restore until the backend was restarted). A request that is already
// destroyed, or whose client leaves during the read ('close' before 'end'),
// rejects with code BODY_ABORTED. idleMs (optional): no data for that long
// rejects with code BODY_TIMEOUT (408, see sendBodyError), for an upload whose
// device vanished without closing the connection (Node's own requestTimeout
// would hold the slot for 5 minutes). totalMs (optional): the whole body not
// read within that long rejects the same way, for an upload that trickles (a
// byte now and then never trips idleMs). readBodyBuffer resolves the raw bytes
// (the multipart support form), readJsonBody the parsed JSON.
function readJsonBody(req, maxSize = MAX_BODY_SIZE, opts = {}) {
  return readBodyBuffer(req, maxSize, opts).then((buffer) => {
    let parsed
    try {
      const text = buffer.toString('utf8')
      parsed = text ? JSON.parse(text) : {}
    } catch {
      throw new Error('Invalid JSON')
    }
    return parsed
  })
}

// lease (optional, the storage bodies': GCS-R5): each chunk is taken from a
// budget of bytes held in memory (lease.take(n) false: rejects with code
// BODY_BUSY, 503); the caller gives it back when it is done with the body.
// minBytesPerSec (optional): after minRateGraceMs, a body that has averaged
// less since its start rejects with BODY_TIMEOUT (a byte every 29 s beats any
// idle timer).
function readBodyBuffer(req, maxSize = MAX_BODY_SIZE, { idleMs = 0, totalMs = 0, lease = null, minBytesPerSec = 0, minRateGraceMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    let idleTimer = null
    let totalTimer = null
    let rateTimer = null
    const started = Date.now()
    const fail = (message, code) => {
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      clearInterval(rateTimer)
      chunks.length = 0
      const err = new Error(message)
      err.code = code
      reject(err)
    }
    const tooLarge = () => fail('Body too large', 'BODY_TOO_LARGE')
    if (req.destroyed) {
      fail('Client went away', 'BODY_ABORTED')
      return
    }
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxSize) {
      tooLarge()
      req.resume() // drain and discard
      return
    }
    const armIdle = () => {
      if (!(idleMs > 0)) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => { if (!settled) fail('Body read timed out', 'BODY_TIMEOUT') }, idleMs)
    }
    armIdle()
    if (totalMs > 0) totalTimer = setTimeout(() => { if (!settled) fail('Body read timed out', 'BODY_TIMEOUT') }, totalMs)
    if (minBytesPerSec > 0) {
      rateTimer = setInterval(() => {
        const s = (Date.now() - started - minRateGraceMs) / 1000
        if (!settled && s > 0 && size < s * minBytesPerSec) fail('Body read too slow', 'BODY_TIMEOUT')
      }, Math.max(250, Math.min(1000, minRateGraceMs / 4 || 1000)))
      rateTimer.unref?.()
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxSize) return tooLarge()
      if (lease && !lease.take(chunk.length)) {
        fail('Server busy', 'BODY_BUSY')
        req.resume() // drain and discard
        return
      }
      chunks.push(chunk)
      armIdle()
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      clearInterval(rateTimer)
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      clearInterval(rateTimer)
      reject(err)
    })
    req.on('close', () => {
      if (!settled) fail('Client went away', 'BODY_ABORTED')
    })
  })
}

/**
 * Answer a readJsonBody failure: 413 (connection closed after the response)
 * for an oversized body, 408 (same) for a body that stopped arriving, else
 * 400. `tooLargeBody` overrides the 413 body.
 */
function sendBodyError(res, err, { tooLargeBody, invalidBody } = {}) {
  if (res.headersSent) return
  if (err?.code === 'BODY_TOO_LARGE') {
    res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' })
    res.end(JSON.stringify(tooLargeBody || { data: null, error: { message: 'Request body too large', code: 'OV_BODY_TOO_LARGE' } }))
    return
  }
  if (err?.code === 'BODY_TIMEOUT') {
    res.writeHead(408, { 'Content-Type': 'application/json', Connection: 'close' })
    res.end(JSON.stringify({ data: null, error: { message: 'Request body timed out', code: 'OV_BODY_TIMEOUT', retryable: true } }))
    return
  }
  if (err?.code === 'BODY_BUSY') {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5', Connection: 'close' })
    res.end(JSON.stringify({ data: null, error: { message: 'Server busy, retry shortly', code: 'OV_BUSY', retryable: true } }))
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

/** Does the request's Accept-Encoding take gzip (not refused with q=0)? */
function acceptsGzip(req) {
  return String(req.headers['accept-encoding'] || '').split(',').some((part) => {
    const [name, ...params] = part.split(';').map((s) => s.trim().toLowerCase())
    if (name !== 'gzip' && name !== '*') return false
    const q = params.find((p) => p.startsWith('q='))
    return !q || Number(q.slice(2)) > 0
  })
}

// Gzip a JSON answer above this size for a client that accepts it.
const GZIP_MIN_BYTES = 8 * 1024

/**
 * A JSON text answer, gzipped (level 1, off the event loop) when it is big
 * and the client accepts it, else as it is. A referee's or bench's GET
 * /api/match/:id carries the whole match, and a bench refetches it after
 * every database change of its match: every byte went through the tunnel
 * uncompressed (national peak load test 2026-10-26).
 */
function sendJsonText(req, res, status, text) {
  const plain = () => {
    if (res.headersSent) return
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(text)
  }
  if (text.length < GZIP_MIN_BYTES || !acceptsGzip(req)) return plain()
  gzip(text, { level: 1 }, (err, body) => {
    if (err) return plain()
    if (res.headersSent) return
    // added to the request's Vary (Origin, Authorization), not in its place
    const vary = [res.getHeader('Vary'), 'Accept-Encoding'].filter(Boolean).join(', ')
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Vary: vary })
    res.end(body)
  })
}

// --- Proportionate operational logs (lib/opsLog.js) ---
// Rejected /api/db requests: one value-free line each (status, code, table,
// action, request id), at most 30 a minute per error code, so anonymous probes
// cannot flood the log and a flood of 401/429 cannot hide the rare codes
// (OV_UNSCOPED_EXTERNAL_ID, OV_CLIENT_TOO_OLD). Dropped lines are reported per
// code once a minute. Socket churn (connectivity checks open and close a socket every few
// seconds) and /api/match/list polls: one summary line a minute.
// Per-message relay lines (room joins and leaves, bundle syncs, broadcasts,
// match fetches) are counted there too, so a match day fits the log rotation.
// OV_LOG_CONNECTIONS=1 restores the per-socket and per-message lines for debugging.
const LOG_EACH_CONNECTION = process.env.OV_LOG_CONNECTIONS === '1'
const logDbRejection = createLogLimiter({ max: 30, windowMs: 60_000 })
const relaySummary = createConnectionSummary({ label: '[WS]', intervalMs: 60_000 })
setInterval(() => { relaySummary.flush(); logDbRejection.flush() }, 60_000).unref()

// --- Sign on phone (docs/qr-signing-spec.md 4; lib/signSessions.js) --------
// POST /api/sign/start|open|submit|wait|close and the phone page at /sign.
// Sessions live in memory only (D4), created on the first request. Cloud
// (DATABASE_URL): start needs a session of a scorer, referee (indoor or beach)
// or admin account (D2), and names a stored match that account may write
// (its creator, an editor or an admin); the phone page shows that match's
// teams and game number, not the request's. LAN / SEA (--local): the relay
// host itself, or the game PIN of a match this relay holds in X-OV-Match-Pin
// (D3, wrong PINs counted in pinFailureLimiter) from the scoring device that
// holds it: a scoreboard socket at the caller's address owns the room right
// now. Such a start's caps (live sessions, starts) are the caller's address
// bucket's, and the relay host keeps a share of the total for itself
// (LAN_CAPS.localReserve). OV_SIGN_DISABLED=1: 503 OV_SIGN_UNAVAILABLE.
const SIGN_DISABLED = process.env.OV_SIGN_DISABLED === '1'
const SIGN_STARTER_ROLES = ['scorer', 'referee', 'beach:scorer', 'beach:referee']
let signSessions = null
function getSignSessions() {
  signSessions ??= createSignSessions({
    via: DB_MODE ? 'cloud' : 'lan',
    randomBytes: (n) => randomBytes(n),
    sha256: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
    log: (line) => console.log(`[Sign] ${line}`)
  })
  return signSessions
}

/** May this account start phone signing (spec D2)? A scorer or referee account, or an admin. */
function mayStartPhoneSign(access) {
  if (access?.isAdmin === true) return true
  const roles = Array.isArray(access?.roles) ? access.roles : []
  return SIGN_STARTER_ROLES.some((r) => roles.includes(r))
}

/**
 * A cloud start's match (matchKey = matches.external_id, OpenBeach's
 * seed_key): stored, and written by this account (its creator, an editor of
 * it, or an admin). { body, app } with the body's context taking the stored
 * teams and game number (a beach match's team1 / team2), and the app of the
 * phone page's name and mark (open answers app: 'beach'); { error } otherwise
 * (403 OV_SIGN_MATCH, 503 when the database does not answer). A test match
 * never reaches the server, a new one only once its insert synced: the app
 * takes the hall network then, or says so (PhoneSignPanel startFailureKey).
 */
const SIGN_MATCH_ERRORS = {
  match: () => signError(403, 'OV_SIGN_MATCH'),
  unavailable: () => signError(503, 'OV_SIGN_UNAVAILABLE', { 'Retry-After': '5' })
}
async function signMatchOf(layer, body, userId, access, errors = SIGN_MATCH_ERRORS) {
  const key = typeof body?.matchKey === 'string' ? body.matchKey.trim() : ''
  if (!key || key.length > 128) return { error: errors.match() }
  let m
  try {
    ({ rows: [m] } = await layer.db.pool.query(
      `SELECT m.created_by, m.game_n, m.sport_type::text AS sport,
              CASE WHEN m.sport_type IS NOT DISTINCT FROM 'beach' THEN m.team1_data->>'name' ELSE m.home_team->>'name' END AS home,
              CASE WHEN m.sport_type IS NOT DISTINCT FROM 'beach' THEN m.team2_data->>'name' ELSE m.away_team->>'name' END AS away,
              EXISTS (SELECT 1 FROM public.match_editors e WHERE e.match_id = m.id AND e.user_id = $2) AS editor
         FROM public.matches m WHERE m.external_id = $1 LIMIT 1`, [key, userId]))
  } catch (err) {
    console.warn('[Sign] match lookup failed:', err?.message)
    return { error: errors.unavailable() }
  }
  if (!m || !(access?.isAdmin === true || m.created_by === userId || m.editor === true)) return { error: errors.match() }
  const text = (v) => (typeof v === 'string' && v.trim() ? v : null)
  const ctx = body.context
  const context = ctx && typeof ctx === 'object' && !Array.isArray(ctx)
    ? {
        ...ctx,
        home: text(m.home) ?? ctx.home,
        away: text(m.away) ?? ctx.away,
        ...(m.game_n != null ? { matchNo: String(m.game_n) } : {})
      }
    : ctx
  return { body: { ...body, context }, app: m.sport === 'beach' ? 'beach' : null }
}

/** --local: a scoreboard socket at this address bucket owns the room of `matchKey` right now. */
const roomHeldFrom = (matchKey, ipKey) => ownersOf(matchKey).some((c) => c.ipKey === ipKey)

/** Loopback or one of this machine's own addresses. */
function isOwnAddress(value) {
  const addr = String(value || '').replace(/^::ffff:/, '')
  if (!addr) return false
  if (addr === '::1' || addr.startsWith('127.')) return true
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) if (net.address === addr) return true
    }
  } catch { /* remote */ }
  return false
}

/**
 * The request comes from this machine itself: the socket's peer is one of its
 * own addresses, and so is the client address behind a trusted proxy
 * (TRUST_PROXY, getClientIp). The forwarded address can only take that away
 * (a proxy on the same machine does not make every caller the relay host),
 * never grant it: with TRUST_PROXY and no TRUST_PROXY_FROM any peer's
 * cf-connecting-ip is believed.
 */
function isLocalCaller(req) {
  return isOwnAddress(req.socket?.remoteAddress) && isOwnAddress(getClientIp(req))
}

async function handleSignRequest(req, res, endpoint) {
  const send = (r) => sendJson(res, r.status, r.body, {
    ...SIGN_API_HEADERS,
    ...(r.headers || {}),
    ...(r.status === 413 ? { Connection: 'close' } : {})
  })
  const refuse = (r) => { req.resume(); send(r) }
  if (SIGN_DISABLED) return refuse(signError(503, 'OV_SIGN_UNAVAILABLE'))
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return refuse(signError(400, 'OV_SIGN_BAD_REQUEST'))
  const ipKey = ipBucketKey(getClientIp(req))
  let owner = null
  let layer = null
  let access = null
  let userId = null
  if (endpoint === 'start' && DB_MODE) {
    // The account first, before the body is read
    const token = bearerFromHeaders(req.headers)
    if (!token) return refuse(signError(401, 'OV_AUTH_REQUIRED'))
    let user = null
    try {
      layer = await getDataLayer()
      const v = await layer.auth.verifyAccessToken(token)
      user = v?.user || null
      if (user) access = await layer.access.get(user.id)
    } catch (err) {
      console.warn('[Sign] account check failed:', err?.message)
      return refuse(signError(503, 'OV_SIGN_UNAVAILABLE', { 'Retry-After': '5' }))
    }
    if (!user) return refuse(signError(401, 'OV_AUTH_REQUIRED'))
    if (!mayStartPhoneSign(access)) return refuse(signError(403, 'OV_SIGN_FORBIDDEN'))
    userId = user.id
    owner = `u:${user.id}`
  }
  let body
  try {
    body = await readJsonBody(req, signBodyLimit(endpoint))
  } catch (err) {
    return send(err?.code === 'BODY_TOO_LARGE' ? signError(413, 'OV_SIGN_TOO_LARGE') : signError(400, 'OV_SIGN_BAD_REQUEST'))
  }
  if (endpoint === 'start' && !DB_MODE) {
    if (isLocalCaller(req)) {
      owner = 'local'
    } else {
      const pin = String(req.headers['x-ov-match-pin'] || '').trim().slice(0, 32)
      if (!pin) return send(signError(403, 'OV_SIGN_FORBIDDEN'))
      const matchKey = typeof body?.matchKey === 'string' ? normalizeMatchId(body.matchKey) : null
      // Only the scoring device that holds the room (before any PIN is
      // compared): a device that only knows the game PIN, or a room whose
      // scoreboard is gone, starts nothing
      const stored = matchKey && roomHeldFrom(matchKey, ipKey) ? gamePinOf(activeMatches.get(matchKey)?.match) : null
      if (!stored) return send(signError(403, 'OV_SIGN_FORBIDDEN'))
      // The brute-force budget of every PIN check (this match's game PIN):
      // counted now, refunded on success
      const scope = pinScope.match(matchKey, 'game')
      if (pinFailureLimiter.isLimited(ipKey, scope)) return send(signError(429, 'OV_SIGN_RATE_LIMITED', { 'Retry-After': '600' }))
      if (!safeEqualStr(stored, pin)) return send(signError(403, 'OV_SIGN_PIN_INVALID'))
      pinFailureLimiter.refund(ipKey, scope)
      // the caps of the caller's address, however many rooms it holds
      owner = `pin:${ipKey}`
    }
  }
  const sessions = getSignSessions()
  if (endpoint === 'start') {
    // cloud: the match the account writes, its stored teams and its app
    // (the phone page's name and mark); only after the account check, and
    // after the request's own shape (a bad body or slot is the core's 400)
    let app = null
    if (DB_MODE && body && typeof body === 'object' && !Array.isArray(body) && SIGN_SLOTS.includes(body.slot)) {
      const bound = await signMatchOf(layer, body, userId, access)
      if (bound.error) return send(bound.error)
      body = bound.body
      app = bound.app
    }
    return send(sessions.start(body, { owner, app }))
  }
  if (endpoint === 'open') return send(sessions.open(body, { ipKey }))
  if (endpoint === 'submit') return send(sessions.submit(body, { ipKey }))
  if (endpoint === 'close') return send(sessions.close(body))
  // wait: dropped when the scoring device goes away
  const ac = new AbortController()
  const onGone = () => { if (!res.writableEnded) ac.abort() }
  res.on('close', onGone)
  const r = await sessions.wait(body, { signal: ac.signal })
  res.off('close', onGone)
  if (r.status !== 499) send(r)
}

// --- Pair a phone (docs/phone-keyboard-spec.md; lib/pairSessions.js) --------
// POST /api/pair/start|wait|focus|close (the scoring device: start with the
// same auth as /api/sign/start, the rest with its watch secret) and
// join|poll|input (the phone: the QR token or the short code once, then its
// own secret), and the phone page at /pair. Memory only, created on the first
// request. OV_PAIR_DISABLED=1: 503 OV_PAIR_UNAVAILABLE.
const PAIR_DISABLED = process.env.OV_PAIR_DISABLED === '1'
const PAIR_MATCH_ERRORS = {
  match: () => pairError(403, 'OV_PAIR_MATCH'),
  unavailable: () => pairError(503, 'OV_PAIR_UNAVAILABLE', { 'Retry-After': '5' })
}
let pairSessions = null
function getPairSessions() {
  pairSessions ??= createPairSessions({
    via: DB_MODE ? 'cloud' : 'lan',
    randomBytes: (n) => randomBytes(n),
    sha256: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
    log: (line) => console.log(`[Pair] ${line}`)
  })
  return pairSessions
}

// --- Scoreboard codes (docs/scoreboard-code-spec.md; lib/displayCodes.js) ----
// The scorer's socket sets its room's code (display-code-set); any board finds
// the room by it (subscribe-match { code }, POST /api/display/lookup|live),
// whatever cloudListsMatch says, and gets the public summary and live state.
// Memory only, hashes only; a scorer sets its code again after a restart.
const displayCodes = createDisplayCodes({
  via: IS_CLOUD ? 'cloud' : 'lan',
  sha256: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
  log: (line) => console.log(`[Display] ${line}`),
  onEnd: (room, hash, reason) => onDisplayCodeEnd(room, hash, reason)
})
const displayCodeFollowers = new Map() // code hash -> Set of client ids that follow its room by it

/**
 * The address bucket a display lookup counts in (the code table's budgets):
 * the address, and for a page of another site (an Origin the origin rule
 * does not trust) a bucket of its own beside it. Any page or ad opened on a
 * phone behind a hall's NAT could otherwise spend the hall's wrong-code
 * budget with a few no-cors text/plain POSTs, and every new board of the
 * hall (the native boards send no Origin, the board page is ours) was refused
 * for five minutes (audit 2611 SEC-21). Boards on other sites keep the HTTP
 * feed (docs/scoreboard-feed.md), all of them on that one bucket per address.
 */
function displayLookupKey(req) {
  const ipKey = ipBucketKey(getClientIp(req))
  const origin = req.headers.origin
  return origin !== undefined && !isTrustedOrigin(origin, { host: req.headers.host }) ? `${ipKey} cross-site` : ipKey
}

/** POST /api/display/lookup | live (read-only, CORS *, no credentials). */
async function handleDisplayRequest(req, res, endpoint) {
  const send = (r) => {
    res.removeHeader('Access-Control-Allow-Credentials')
    sendJson(res, r.status, r.body, { ...(r.headers || {}), ...(r.status === 413 ? { Connection: 'close' } : {}) })
  }
  let text
  try {
    text = (await readBodyBuffer(req, DISPLAY_BODY_MAX)).toString('utf8')
  } catch (err) {
    send(err?.code === 'BODY_TOO_LARGE' ? displayError(413, 'OV_DISPLAY_TOO_LARGE') : displayError(400, 'OV_DISPLAY_BAD_REQUEST'))
    return
  }
  send(displayCodes.http(endpoint, {
    contentType: req.headers['content-type'],
    text,
    ipKey: displayLookupKey(req),
    summaryOf: (room) => {
      const entry = activeMatches.get(room)
      return entry?.match ? relaySummaryBundle(entry) : null
    }
  }))
}

async function handlePairRequest(req, res, endpoint) {
  const send = (r) => sendJson(res, r.status, r.body, {
    ...PAIR_API_HEADERS,
    ...(r.headers || {}),
    ...(r.status === 413 ? { Connection: 'close' } : {})
  })
  const refuse = (r) => { req.resume(); send(r) }
  if (PAIR_DISABLED) return refuse(pairError(503, 'OV_PAIR_UNAVAILABLE'))
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return refuse(pairError(400, 'OV_PAIR_BAD_REQUEST'))
  const ipKey = ipBucketKey(getClientIp(req))
  let owner = null
  let layer = null
  let access = null
  let userId = null
  if (endpoint === 'start' && DB_MODE) {
    // The account first, before the body is read (the Sign on phone rule, D2)
    const token = bearerFromHeaders(req.headers)
    if (!token) return refuse(pairError(401, 'OV_AUTH_REQUIRED'))
    let user = null
    try {
      layer = await getDataLayer()
      const v = await layer.auth.verifyAccessToken(token)
      user = v?.user || null
      if (user) access = await layer.access.get(user.id)
    } catch (err) {
      console.warn('[Pair] account check failed:', err?.message)
      return refuse(pairError(503, 'OV_PAIR_UNAVAILABLE', { 'Retry-After': '5' }))
    }
    if (!user) return refuse(pairError(401, 'OV_AUTH_REQUIRED'))
    if (!mayStartPhoneSign(access)) return refuse(pairError(403, 'OV_PAIR_FORBIDDEN'))
    userId = user.id
    owner = `u:${user.id}`
  }
  let body
  try {
    body = await readJsonBody(req, pairBodyLimit(endpoint))
  } catch (err) {
    return send(err?.code === 'BODY_TOO_LARGE' ? pairError(413, 'OV_PAIR_TOO_LARGE') : pairError(400, 'OV_PAIR_BAD_REQUEST'))
  }
  if (endpoint === 'start' && !DB_MODE) {
    if (isLocalCaller(req)) {
      owner = 'local'
    } else {
      // the scoring device that holds the room, with its game PIN (as /api/sign/start)
      const pin = String(req.headers['x-ov-match-pin'] || '').trim().slice(0, 32)
      if (!pin) return send(pairError(403, 'OV_PAIR_FORBIDDEN'))
      const matchKey = typeof body?.matchKey === 'string' ? normalizeMatchId(body.matchKey) : null
      const stored = matchKey && roomHeldFrom(matchKey, ipKey) ? gamePinOf(activeMatches.get(matchKey)?.match) : null
      if (!stored) return send(pairError(403, 'OV_PAIR_FORBIDDEN'))
      const scope = pinScope.match(matchKey, 'game')
      if (pinFailureLimiter.isLimited(ipKey, scope)) return send(pairError(429, 'OV_PAIR_RATE_LIMITED', { 'Retry-After': '600' }))
      if (!safeEqualStr(stored, pin)) return send(pairError(403, 'OV_PAIR_PIN_INVALID'))
      pinFailureLimiter.refund(ipKey, scope)
      owner = `pin:${ipKey}`
    }
  }
  const sessions = getPairSessions()
  if (endpoint === 'start') {
    // cloud: the match the account writes, its stored teams and its app
    let app = null
    if (DB_MODE && body && typeof body === 'object' && !Array.isArray(body)) {
      const bound = await signMatchOf(layer, body, userId, access, PAIR_MATCH_ERRORS)
      if (bound.error) return send(bound.error)
      body = bound.body
      app = bound.app
    }
    return send(sessions.start(body, { owner, app }))
  }
  if (endpoint === 'focus') return send(sessions.focus(body))
  if (endpoint === 'close') return send(sessions.close(body))
  if (endpoint === 'join') return send(sessions.join(body, { ipKey }))
  if (endpoint === 'input') return send(sessions.input(body, { ipKey }))
  // wait / poll: dropped when the caller goes away
  const ac = new AbortController()
  const onGone = () => { if (!res.writableEnded) ac.abort() }
  res.on('close', onGone)
  const r = endpoint === 'poll'
    ? await sessions.poll(body, { ipKey, signal: ac.signal })
    : await sessions.wait(body, { signal: ac.signal })
  res.off('close', onGone)
  if (r.status !== 499) send(r)
}

// --- Log sanitizer (prevent log injection via newlines/control chars) ---
// Control characters (C0, DEL, C1, the Unicode line and paragraph
// separators) become a space, so a value can neither start a line that looks
// like the server's own nor drive the operator's terminal, and the text is cut
// at maxLength characters: one client frame wrote 9 MB to the log, and the
// container keeps 5 x 10 MB of it.
const LOG_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
function sanitizeLog(str, maxLength = 200) {
  const s = typeof str === 'string' ? str : String(str)
  return (s.length > maxLength ? `${s.slice(0, maxLength)}…` : s).replace(LOG_CONTROL_RE, ' ')
}

/** A value a client sent (a room id, a message type, an action), as a log line prints it: 64 characters at most. */
function logValue(v) {
  if (typeof v === 'string') return sanitizeLog(v, 64)
  if (v !== null && typeof v === 'object') return Array.isArray(v) ? '[array]' : '[object]'
  return String(v)
}

// --- WebSocket per-client rate limiting ---
const WS_RATE_LIMIT_MAX = 120 // messages per window
const WS_RATE_LIMIT_WINDOW_MS = 60 * 1000
const wsRateLimitMap = new Map()
// A scorer answers every bench request it receives (bench-response 'seen'
// and the outcome) on its one socket: those answers count on their own
// budget, so bench traffic cannot push the scorer over WS_RATE_LIMIT_MAX
const WS_BENCH_RESPONSE_MAX = 600 // bench-response messages per window
const WS_BENCH_RESPONSE_MAX_BYTES = 1024
// ... and bytes: the frame budget of lib/relayLimits.js (large frames of a
// socket without a proved claim, bytes per socket and address)
const frameBudget = createFrameBudget({ windowMs: WS_RATE_LIMIT_WINDOW_MS })

/**
 * What a socket owns, for the frame budget (createFrameBudget): 'none' (no
 * room), 'relay' (on the cloud, only rooms whose game PIN no database row
 * proved: anyone may sync a made-up room id and own it) or 'proved' (a room
 * the database proved, relayOfficial; any room of a venue relay, which has no
 * database and no internet callers).
 */
function frameProofOf(clientInfo) {
  if (clientInfo.ownedMatches.size === 0) return 'none'
  if (!IS_CLOUD) return 'proved'
  if (DB_MODE) {
    for (const matchId of clientInfo.ownedMatches) {
      if (activeMatches.get(matchId)?.relayOfficial === true) return 'proved'
    }
  }
  return 'relay'
}

function isWsRateLimited(clientId, key = clientId, max = WS_RATE_LIMIT_MAX) {
  const now = Date.now()
  const entry = wsRateLimitMap.get(key)

  if (!entry || now - entry.windowStart > WS_RATE_LIMIT_WINDOW_MS) {
    wsRateLimitMap.set(key, { count: 1, windowStart: now })
    return false
  }

  entry.count++
  return entry.count > max
}

const benchBudgetKey = (clientId) => `${clientId}:bench-response`

// A small frame whose type is bench-response (parsed again later; only small
// frames are looked at, so the check costs nothing on a match sync)
function isBenchResponseFrame(data) {
  if (!data || data.length > WS_BENCH_RESPONSE_MAX_BYTES) return false
  try {
    return JSON.parse(data.toString())?.type === 'bench-response'
  } catch {
    return false
  }
}

// --- TTL cleanup for stale rooms, matches, and WS rate limit entries ---
setInterval(() => {
  const now = Date.now()

  // Clean up rooms no connected socket owns and no scorer synced for >24h,
  // watchers or not: the stored match, its PINs, owners and bench requests
  // together (dropRoom). A room empties at once (holdRoom), so the empty
  // rooms this looked for never existed, and watchers kept any room for good.
  const owned = new Set()
  for (const c of connections.values()) for (const id of c.ownedMatches) owned.add(id)
  for (const [matchId, entry] of [...activeMatches.entries()]) {
    if (!owned.has(matchId) && now - (Date.parse(entry.updatedAt) || 0) > ROOM_TTL_MS) {
      dropRoom(matchId)
      console.log(`🧹 TTL cleanup: removed stale room ${logValue(matchId)}`)
    }
  }

  // Clean up WS rate limit entries
  for (const [id, entry] of wsRateLimitMap.entries()) {
    if (now - entry.windowStart > WS_RATE_LIMIT_WINDOW_MS * 2) {
      wsRateLimitMap.delete(id)
    }
  }
  frameBudget.sweep()
}, 15 * 60 * 1000) // Every 15 minutes

const MAX_BODY_SIZE = 1024 * 1024 // 1MB
const MAX_MATCH_BODY_SIZE = 5 * 1024 * 1024 // 5MB for match data with email
// A whole match backup (match + sets + up to 20000 events) for /api/match/restore
const MAX_RESTORE_BODY_SIZE = 16 * 1024 * 1024
// A restore body that sends nothing for this long gives its restoreGate slot
// back (408): its device is gone. A live upload, even on bad hall Wi-Fi, never
// pauses that long.
const RESTORE_BODY_IDLE_MS = 30 * 1000
// The whole restore body must arrive within this long, or it gives its slot
// back (408) all the same: a byte every few seconds never trips the idle
// timeout, and held a slot until Node's requestTimeout (5 minutes). The app
// gives its whole restore request 90 s (RESTORE_REQUEST_TIMEOUT_MS, upload
// and transaction) and then stops waiting, so a body still arriving after 2
// minutes is one no app waits for; a full 16 MB backup in 2 minutes takes
// about 1.1 Mbit/s of uplink, and a match backup is far smaller.
const RESTORE_BODY_TOTAL_MS = 2 * 60 * 1000

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
// GET /api/official-matches/leagues (a fixed list, no feed fetched): per
// address, minute and kind of page, apart from the feed requests ('ical'),
// which count only when they fetch (a cache miss), also per kind of page: a
// foreign page's images cannot use up the hall's "Load official match"
// (audit 2026-11-23 SEC-42)
const ICAL_LEAGUES_RATE_LIMIT_MAX = 60

/** The cached matches of a league while fresh, else null (fetchAndParseIcal's cache). */
function icalCached(federation, leagueCode) {
  const cached = icalCache.get(`${federation}-${leagueCode}`)
  return cached && Date.now() - cached.timestamp < ICAL_CACHE_TTL ? cached.matches : null
}

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
        // the feed has no number of win sets: unknown, Match setup asks (never a silent best of 5)
        bestOf: null,
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

// The origin rule (lib/cors.js): the CORS answers, the writes and the
// WebSocket upgrade below
const { getCorsOrigin, isTrustedOrigin } = createOriginPolicy({ isCloud: IS_CLOUD, publicOrigins: PUBLIC_ORIGINS })

// What the transport refused, for /health (relayStats): writes from a page of
// a foreign origin or with a body that is not JSON, WebSocket upgrades from a
// foreign origin, and role-socket frames over their size or byte budget
const transportRefusals = { origin: 0, mediaType: 0, upgradeOrigin: 0, frames: 0, socketsClosed: 0 }

// The cloud over plain http (SEC-61, lib/plainHttp.js), for /health
// (relayStats): pages sent to https, and the API calls, preflights and
// WebSocket upgrades of older apps that were still answered in the clear.
// One ops line per kind and app origin a minute (the rest is counted in the
// limiter's "suppressed" note), so the lead sees who still uses http.
const plainHttpStats = { redirected: 0, api: 0, preflight: 0, ws: 0 }
const logPlainHttp = createLogLimiter({ max: 1, windowMs: 60_000 })
setInterval(() => logPlainHttp.flush(), 60_000).unref()

/** Count and log (rate limited) a plain http call that is answered as before. */
function notePlainHttp(req, kind) {
  if (kind in plainHttpStats) plainHttpStats[kind]++
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  const p = { kind, route: routeLabel(req), origin, trusted: origin !== undefined && isTrustedOrigin(origin, { host: req.headers.host }) }
  logPlainHttp(formatPlainHttpLine(p), plainHttpLogKey(p))
}

// --- Writes: Origin and body type ---------------------------------------------
// Any web page can make its visitor's browser send a cross-site POST of a
// "simple" body type (text/plain, form-encoded, multipart) without a CORS
// preflight. The page cannot read the answer, but every such request spent the
// visitor's address budgets (a hall's PIN checks, sign-ins, /api/db), which all
// tablets behind the hall's address share. So a write to the API is refused
// before any route or rate bucket sees it:
// - from a page of an origin the origin rule does not trust (403). A request
//   without an Origin (a native app, a script, the board bridge) is no page;
// - with a body type other than JSON (415): a browser then asks first
//   (preflight), and the CORS answer refuses a foreign page. The support form
//   (/api/contact) also takes multipart/form-data; the phone-sign and
//   phone-pair APIs check their own body type (handleSignRequest, handlePairRequest).
//   The error reports (/api/errors) also take text/plain: navigator.sendBeacon
//   (a page that is closing) can send no other type across origins; a foreign
//   page is still refused by its Origin above.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const JSON_TYPE_RE = /^\s*application\/json\s*(;|$)/i
const MULTIPART_TYPE_RE = /^\s*multipart\/form-data\s*;/i
const TEXT_TYPE_RE = /^\s*text\/plain\s*(;|$)/i

/** The refusal of an API write by its Origin or body type, or null. */
function apiWriteRefusal(req, pathname) {
  if (!WRITE_METHODS.has(req.method) || !pathname.startsWith('/api/')) return null
  // Scoreboard codes: read-only lookups with no credentials, for any board
  // on any site (CORS *); the body check is the core's own. A page of another
  // site counts its wrong codes on a budget of its own (displayLookupKey).
  if (displayEndpointOf(pathname)) return null
  const origin = req.headers.origin
  if (origin !== undefined && !isTrustedOrigin(origin, { host: req.headers.host })) {
    transportRefusals.origin++
    return { status: 403, code: 'OV_ORIGIN_REFUSED', message: 'This site may not call the OpenVolley server' }
  }
  if (signEndpointOf(pathname) || pairEndpointOf(pathname)) return null
  const type = String(req.headers['content-type'] || '')
  if (JSON_TYPE_RE.test(type) || (pathname === '/api/contact' && MULTIPART_TYPE_RE.test(type)) || (pathname === '/api/errors' && TEXT_TYPE_RE.test(type))) return null
  transportRefusals.mediaType++
  return { status: 415, code: 'OV_UNSUPPORTED_MEDIA_TYPE', message: 'The request body must be application/json' }
}

// connect-src for pages this server serves itself (same-origin bundle).
// No *.supabase.co any more: realtime runs over this server's own socket.
const CLOUD_CONNECT_SRC = [
  "'self'",
  'https://*.openvolley.app',
  'wss://*.openvolley.app',
  ...PUBLIC_ORIGINS,
  ...PUBLIC_ORIGINS.filter(o => o.startsWith('https://')).map(o => 'wss://' + o.slice('https://'.length))
].join(' ')

// The Content-Security-Policy of every answer (lib/pageCsp.js: the frontend's
// own policy, frontend/csp.js, so the app a venue server or a standalone
// build hands out can seal its backups, SEC-46). The cloud: its own sites for
// connect-src, and no page may frame it; a venue server: the LAN relays and
// any backend, and the app frames its own pages (PDF capture).
const PAGE_CSP = IS_CLOUD
  ? pageContentSecurityPolicy({ connectSrc: CLOUD_CONNECT_SRC, frameAncestors: "'none'" })
  : pageContentSecurityPolicy({ frameAncestors: "'self'" })

// --- Health ------------------------------------------------------------------
// /health/live: process is up (Docker healthcheck). Never touches the database.
// /health:      monitors. DATABASE_URL mode: db ping, catalog, storage sentinel,
//               free space (floor), last backup age, socket pools, account-email
//               counters (mail), the VolleyManager sync (vmSync, informational),
//               the schema state, pg pool (waiting), process memory, heap and
//               event-loop lag, refused frames and sockets. A readiness check:
//               503 when the db, catalog, floor, sentinel or backup is not ok or
//               the schema is behind this image or broken. Cached for 2 s.
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

// { at, ageMin } of a status file the host's backup job writes on success
async function readStatusStamp(name) {
  try {
    const text = (await readFile(join(STATUS_DIR, name), 'utf8')).trim().split(/\s+/)[0]
    const at = Date.parse(text)
    if (!Number.isFinite(at)) return { at: null, ageMin: null }
    return { at: new Date(at).toISOString(), ageMin: Math.max(0, Math.floor((Date.now() - at) / 60000)) }
  } catch {
    return { at: null, ageMin: null }
  }
}

/** The hourly database run (last_backup). */
async function readLastBackup() {
  const { at, ageMin } = await readStatusStamp('last_backup')
  return { lastBackupAt: at, lastBackupAgeMin: ageMin }
}

/** The nightly files run (last_files_backup: scoresheets, owner records, snapshots, base backup). */
async function readLastFilesBackup() {
  const { at, ageMin } = await readStatusStamp('last_files_backup')
  return { lastFilesBackupAt: at, lastFilesBackupAgeMin: ageMin }
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
    activeRooms: rooms.size,
    // what the transport refused since the start (transportRefusals)
    transport: { ...transportRefusals },
    // the cloud over plain http since the start (SEC-61, plainHttpStats)
    plainHttp: { ...plainHttpStats },
    // new sockets told "relay busy" (heap above OV_ADMIT_HEAP_PCT) since the start;
    // sockets that proved nothing pushed out at a cap, or closed as idle under load
    admission: { refused: admissionRefused, heapPct: ADMIT_HEAP_PCT, maxConnections: MAX_CONNECTIONS, evicted: roleEvictions, idleClosed: roleIdleClosed },
    // the live screen for TVs (lib/globalLive.js): codes, courts, refusals since the start
    globalLive: globalLive.stats()
  }
}

// Event-loop delay since the last /health read (a stalled loop delays every
// match on this process); reset on each read so it covers the recent past.
const loopDelay = monitorEventLoopDelay({ resolution: 20 })
loopDelay.enable()

/** Memory, event loop and start of this process, for /health and the monitoring. */
function processStats() {
  const mem = process.memoryUsage()
  const heap = getHeapStatistics()
  const mb = (n) => Math.round(n / 1048576)
  const ms = (ns) => Math.round(ns / 1e6)
  const stats = {
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    revision: process.env.OV_REVISION || null,
    rssMB: mb(mem.rss),
    heapUsedMB: mb(heap.used_heap_size),
    heapLimitMB: mb(heap.heap_size_limit),
    heapPct: Math.round(heap.used_heap_size / heap.heap_size_limit * 100),
    eventLoopLagMs: { p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max) }
  }
  loopDelay.reset()
  return stats
}

/** The schema of this image (lib/schemaVersion.js) for /health: ok, behind, problems or unknown. */
async function schemaHealth() {
  let st = null
  try {
    st = await (await import('./lib/schemaVersion.js')).refreshSchemaStatus()
  } catch { /* unknown */ }
  if (!st || st.error || st.record === 'missing' || st.record === 'unreadable') return { state: 'unknown' }
  const state = st.pending?.length ? 'behind' : (st.changed?.length || st.problems?.length) ? 'problems' : st.ready ? 'ok' : 'unknown'
  return { state, applied: st.applied ?? null, expected: st.expected ?? null, pending: st.pending?.length ?? 0, problems: (st.problems?.length ?? 0) + (st.changed?.length ?? 0) }
}

// The VolleyManager schedule sync, once started (the start block at the end)
let vmSync = null // { lib, schedule }
/**
 * The schedule sync for /health (lib/vmSync.js syncHealth): 'ok' or
 * 'degraded' with the reasons, the last success and its games, the next run
 * and retry; 'off' with the reason when this backend does not run it.
 * Informational: scoring does not need it, so it never makes the backend
 * unhealthy; the monitoring alerts on state 'degraded'.
 */
async function vmSyncStatus(layer) {
  if (!vmSync) {
    const reason = IS_LOCAL ? 'local' : process.env.VM_SYNC === 'off' ? 'disabled'
      : (!process.env.VM_ICAL_FEEDS?.trim() && (!process.env.VM_USERNAME || !process.env.VM_PASSWORD)) ? 'not_configured' : 'not_started'
    return { state: 'off', reason }
  }
  const { nextRunAt, nextRetryAt, running } = vmSync.schedule.status()
  try {
    const record = await withTimeout(vmSync.lib.readSyncRecord(layer.db.pool), HEALTH_DB_TIMEOUT_MS, 'sync record')
    return { ...vmSync.lib.syncHealth(record), nextRunAt, nextRetryAt, running }
  } catch {
    return { state: 'unknown', nextRunAt, nextRetryAt, running }
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
    // Write columns the database lacks, dropped with a warning (pgQuery): a
    // web release out before its migration
    if (layer.db.droppedColumns) body.droppedColumns = layer.db.droppedColumns()
    // pg pool: a waiting count above zero means requests queue for a connection (PG_POOL_MAX)
    const pool = layer.db.pool
    if (pool) body.pool = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: pool.options?.max ?? null }
    if (body.db === 'ok') body.schema = await schemaHealth()
    const st = await layer.storage.health()
    body.sentinel = st.sentinel ? 'ok' : 'missing'
    body.storageWritable = !!st.storageWritable
    body.diskFreeMB = st.diskFreeMB
    body.floor = st.lowSpace === true ? 'low' : (st.lowSpace === false ? 'ok' : 'unknown')
  }
  Object.assign(body, await readLastBackup(), await readLastFilesBackup(), relayStats())
  body.process = processStats()
  body.backup = backupState(body.lastBackupAgeMin)
  // The nightly files run apart: a failing one no longer hides behind the
  // hourly database run. Stale degrades; unknown (no files run written yet,
  // a host from before the split) is shown but does not.
  body.filesBackup = backupState(body.lastFilesBackupAgeMin)
  // Account emails (lib/mailer.js): budgets used / dropped this hour, failed
  // sends. Informational: a used-up budget does not make the server unhealthy.
  if (layer?.auth?.mailer?.stats) {
    try { body.mail = layer.auth.mailer.stats() } catch { body.mail = { enabled: null } }
  }
  if (realtimeHub) body.realtime = realtimeHub.stats()
  // the official schedule's sync: informational, not part of `healthy`
  body.vmSync = layer && body.db === 'ok' ? await vmSyncStatus(layer) : { state: vmSync ? 'unknown' : 'off' }
  // Readiness: a schema behind this image (a migration not run) or with a
  // changed migration or a missing guard is not ready either
  const healthy = body.db === 'ok' && body.catalog.ok && body.sentinel === 'ok' && body.floor === 'ok' &&
    (body.backup === 'ok' || body.backup === 'unchecked') && body.filesBackup !== 'stale' &&
    body.schema?.state !== 'behind' && body.schema?.state !== 'problems'
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

// Create HTTP server. A route that throws answers 500 and is logged with its
// stack; it never ends the process, which holds every relay room, PIN budget
// and sign session (an anonymous GET did that). Async route bodies catch
// their own errors.
const server = createServer((req, res) => {
  // Every answer carries its request id (X-Request-Id, exposed to the
  // frontends' origins): a device's error report names it, and so does the
  // server's own (lib/errorTracker.js request_id)
  req.ovRequestId = newRequestId()
  res.setHeader('X-Request-Id', req.ovRequestId)
  try {
    handleHttpRequest(req, res)
  } catch (err) {
    console.error(`❌ ${req.method} ${sanitizeLog(String(req.url || '').split('?')[0])} failed:`, err)
    captureServerError(err, { view: routeLabel(req), requestId: req.ovRequestId, status: 500 })
    if (res.headersSent) res.destroy()
    else sendJson(res, 500, { success: false, error: 'Internal server error' })
  }
})

/** Does the request carry an account's or a match's credentials (a session or API token, a match token or PIN)? */
function hasCredentials(req) {
  return !!(req.headers.authorization || req.headers['x-ov-match-token'] || req.headers['x-ov-match-pin'])
}

function handleHttpRequest(req, res) {
  // Enable CORS with proper origin handling
  const cors = getCorsOrigin(req)
  res.setHeader('Access-Control-Allow-Origin', cors.origin)
  // Authorization too: an answer to a signed-in request is that account's.
  // A cache that keys on the URL alone (a service worker's runtime cache,
  // SEC-20) then never hands it to another account or a signed-out request,
  // and it is not stored at all (no-store below).
  res.setHeader('Vary', 'Origin, Authorization')
  if (hasCredentials(req)) res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  // X-OV-Proto: the client protocol version; /api/db writes and
  // /api/match/restore need >= 2. Without it here every browser write would
  // fail the CORS preflight.
  // X-OV-Match-Token / X-OV-Match-Pin: the PIN-proved match access of the
  // referee/bench apps (GET /api/match/:id, anonymous /api/db reads).
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-OV-Proto, X-OV-Match-Token, X-OV-Match-Pin')
  // X-Request-Id (/api/db): readable by the cross-origin frontend, so a sync
  // error can be matched to the server's rejection log line.
  // Content-Disposition: the file name of a download (the manager on its own
  // origin: activity export, scoresheet PDFs).
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Content-Disposition')
  if (cors.credentials) res.setHeader('Access-Control-Allow-Credentials', 'true')
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (IS_CLOUD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  // Content Security Policy — emitted in all modes so LAN/self-hosted
  // deployments are not left without a policy (PAGE_CSP, lib/pageCsp.js).
  res.setHeader('Content-Security-Policy', PAGE_CSP)

  // The cloud over plain http (SEC-61, lib/plainHttp.js): Cloudflare says
  // which scheme the visitor used (cf-visitor). A page, a script or an
  // address opened in the browser goes to https. An API call and a CORS
  // preflight are answered as before: older apps (3.x set to
  // http://backend.openvolley.app) would fail a redirected preflight and
  // arrive with Origin: null after a redirect; they are counted in the ops
  // log instead. The health checks, a venue server and a request without
  // cf-visitor are served as before.
  const plain = IS_CLOUD ? plainHttpAnswer(req) : null
  if (plain?.action === 'redirect') {
    plainHttpStats.redirected++
    req.resume()
    res.writeHead(plain.status, { Location: plain.location, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(req.method === 'HEAD' ? undefined : `Use ${plain.location}\n`)
    return
  }
  if (plain?.action === 'serve') notePlainHttp(req, plain.kind)

  if (req.method === 'OPTIONS') {
    // the scoreboard codes: any site (CORS *, never with credentials)
    if (displayEndpointOf(String(req.url || '').split('?')[0])) {
      res.removeHeader('Access-Control-Allow-Credentials')
      res.writeHead(204, DISPLAY_PREFLIGHT_HEADERS)
      res.end()
      return
    }
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

  // Before any route and any rate bucket (see apiWriteRefusal)
  const writeRefusal = apiWriteRefusal(req, url.pathname)
  if (writeRefusal) {
    req.resume()
    sendJson(res, writeRefusal.status, { success: false, data: null, error: { message: writeRefusal.message, code: writeRefusal.code } })
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

  // Server status. The cloud leaves out how many sockets, matches and rooms
  // it holds (as its landing page does; the internal /health has them): the
  // apps read status, mode and wsPort.
  if (url.pathname === '/api/server/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'online',
      mode: IS_CLOUD ? 'cloud' : 'local',
      wsPort: PORT,
      ...(IS_CLOUD ? {} : { connections: connections.size, matches: activeMatches.size, rooms: rooms.size }),
      uptime: process.uptime()
    }))
    return
  }

  // Sign on phone: the phone page (same-origin with its API, so no CORS) ...
  if ((req.method === 'GET' || req.method === 'HEAD') && isSignPagePath(url.pathname)) {
    const file = signPageFile(url.pathname)
    res.writeHead(file ? 200 : 404, { 'Content-Type': file ? file.type : 'text/plain', ...SIGN_PAGE_HEADERS })
    res.end(req.method === 'HEAD' ? undefined : (file ? file.body : 'Not Found'))
    return
  }
  // ... and its API (start/wait/close come from the app origins through the CORS above)
  const signEndpoint = req.method === 'POST' ? signEndpointOf(url.pathname) : null
  if (signEndpoint) {
    handleSignRequest(req, res, signEndpoint).catch((err) => {
      console.error('[Sign] request failed:', err?.message)
      sendJson(res, 503, signError(503, 'OV_SIGN_UNAVAILABLE').body, SIGN_API_HEADERS)
    })
    return
  }

  // Pair a phone: the phone page (same-origin with its API, the /sign page's headers) ...
  if ((req.method === 'GET' || req.method === 'HEAD') && isPairPagePath(url.pathname)) {
    const file = pairPageFile(url.pathname)
    res.writeHead(file ? 200 : 404, { 'Content-Type': file ? file.type : 'text/plain', ...SIGN_PAGE_HEADERS })
    res.end(req.method === 'HEAD' ? undefined : (file ? file.body : 'Not Found'))
    return
  }
  // Scoreboard codes: a board finds the match by the scorer's code
  const displayEndpoint = req.method === 'POST' ? displayEndpointOf(url.pathname) : null
  if (displayEndpoint) {
    handleDisplayRequest(req, res, displayEndpoint).catch((err) => {
      console.error('[Display] request failed:', err?.message)
      if (!res.headersSent) sendJson(res, 503, displayError(503, 'OV_DISPLAY_UNAVAILABLE').body, displayError(503, 'OV_DISPLAY_UNAVAILABLE').headers)
    })
    return
  }

  // ... and its API (start/wait/focus/close come from the app origins through the CORS above)
  const pairEndpoint = req.method === 'POST' ? pairEndpointOf(url.pathname) : null
  if (pairEndpoint) {
    handlePairRequest(req, res, pairEndpoint).catch((err) => {
      console.error('[Pair] request failed:', err?.message)
      sendJson(res, 503, pairError(503, 'OV_PAIR_UNAVAILABLE').body, PAIR_API_HEADERS)
    })
    return
  }

  // Validate PIN for referee/bench access
  if (url.pathname === '/api/match/validate-pin' && req.method === 'POST') {
    const ipKey = ipBucketKey(getClientIp(req))
    // Requests per IP (/64) and minute, as validate-connection-pin allows: the
    // apps check every typed PIN here too, and 10 a minute let one tablet's
    // typos refuse every device of a venue NAT. Guessing is bounded by the
    // failure budget below.
    if (isRateLimited(ipKey, PIN_IP_RATE_LIMIT_MAX, 'default')) {
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

        const { pin, type = 'referee', sport = 'indoor', matchId: namedMatch = null, gameNumber = null } = JSON.parse(body)

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

        // Another type never matches a PIN, and each of its spellings was a
        // counter of its own in the bounded table of the lookups across
        // callers (same answer as the LAN relays)
        if (typeof type !== 'string' || !Object.hasOwn(RELAY_PIN_TYPE[sport], type)) {
          sendJson(res, 400, { success: false, error: 'Invalid PIN type' })
          return
        }

        // The match the tablet picked (its link, the game in the list): its
        // room key, else its game number. The PIN is compared with that match
        // only. The first live match with the PIN used to answer, so of two
        // matches that share a referee PIN the second's referee got the
        // first's. Without either (older apps) every live match is searched,
        // and a PIN two of them share is refused with a request for the game.
        const isKeyValue = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
        const named = namedMatch !== null && namedMatch !== undefined && namedMatch !== ''
        const matchKey = named && isKeyValue(namedMatch) ? normalizeMatchId(namedMatch) : null
        const gameKey = !named && gameNumber !== null && gameNumber !== undefined && isKeyValue(gameNumber) ? String(gameNumber).trim().slice(0, 32) : ''
        if ((named && !matchKey) || (gameNumber !== null && gameNumber !== undefined && gameNumber !== '' && !isKeyValue(gameNumber))) {
          sendJson(res, 400, { success: false, error: 'Invalid request' })
          return
        }

        // A lookup that names neither its match nor its game (OV_PIN_ONLY_LOOKUP)
        if (!matchKey && !gameKey && !PIN_ONLY_LOOKUP.allows(sport)) {
          logPinOnlyLookup('validate-pin', sport, RELAY_PIN_TYPE[sport][type], 'refused')
          sendJson(res, 409, PIN_ONLY_REFUSED)
          return
        }

        const pinStr = String(pin).trim()

        // The brute-force budget of every PIN check (failed guesses per
        // address bucket, and per address range across buckets), in the
        // scope validate-connection-pin uses for this PIN type (of the named
        // match, or of every match); a success is refunded below.
        const pinType = RELAY_PIN_TYPE[sport][type]
        const scope = matchKey ? pinScope.match(matchKey, pinType) : pinScope.search(sport, pinType)
        if (pinFailureLimiter.isLimited(ipKey, scope)) {
          sendJson(res, 429, { success: false, error: 'Too many failed attempts. Please wait 10 minutes before trying again.' }, { 'Retry-After': '600' })
          return
        }

        // Search active matches for matching PIN. Per entry: one crafted room
        // must never make the right PIN of another match answer 400 for
        // everyone (a sync stores only validated PINs; this is a second guard).
        const candidates = matchKey ? (activeMatches.has(matchKey) ? [[matchKey, activeMatches.get(matchKey)]] : []) : activeMatches.entries()
        const found = []
        let comparable = false
        for (const [matchId, matchData] of candidates) {
          try {
            const match = matchData.match || matchData
            if (!match) continue
            if ((matchData.sportType || 'indoor') !== sport) continue
            if (gameKey && String(matchData.gameNumber ?? '').trim() !== gameKey) continue
            // A match whose PIN type is locked for the caller's range proves nothing
            if (pinFailureLimiter.locked(matchId, pinType, ipKey)) continue

            let matchPin = null
            if (type === 'referee') {
              matchPin = match.refereePin
            } else if (type === 'homeTeam') {
              matchPin = match.homeTeamPin
            } else if (type === 'awayTeam') {
              matchPin = match.awayTeamPin
            }
            if (matchPin) comparable = true

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
                found.push({ ...match, id: matchId })
              }
            }
          } catch (err) {
            console.error('[API] validate-pin skipped a room:', err?.message)
          }
        }

        if (!matchKey) logPinOnlyLookup('validate-pin', sport, pinType, found.length > 1 ? 'several matches' : found.length === 1 ? 'found' : 'wrong')
        if (found.length > 1) {
          // The PIN is right, for more than one match: nothing is issued, the
          // tablet is asked for the game (its number or the pick in the list)
          pinFailureLimiter.refund(ipKey, scope)
          console.log(`[API] PIN for ${type} matches ${found.length} matches: game number required`)
          sendJson(res, 409, { success: false, code: 'game-number-required', error: 'More than one match has this PIN. Pick your game first (its game number).' })
        } else if (found.length === 1) {
          const matchFound = found[0]
          pinFailureLimiter.refund(ipKey, scope)
          console.log(`[API] PIN validated for ${type}: match ${logValue(matchFound.id)}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          // Strip all PINs from the response — knowing one PIN must not disclose the others.
          res.end(JSON.stringify({
            success: true,
            // A beach answer names its sport (the indoor answer is unchanged)
            match: validatePinMatch(matchFound, type, sport),
            // Capability for this match's full bundle (relay, GET /api/match/:id)
            token: isTokenRole(type) ? matchTokens.issue({ matchKey: String(matchFound.id), role: type, pin: pinStr }) : null
          }))
        } else {
          console.log(`[API] PIN validation failed for ${type}`)
          // The apps check a typed PIN here after the backend's check of the
          // same PIN: one typo counts once. A named match the relay holds no
          // PIN of this type for counts nowhere across addresses (nothing to guess).
          if (!pinFailureLimiter.repeated(ipKey, scope, pinStr) && matchKey && !comparable) {
            pinFailureLimiter.matchRefund([[matchKey, pinType]], ipKey)
          }
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
  // the cloud a test (rehearsal) match, unless ?test=1 asks for those.
  // The cloud shows a match with the referee connection off only to its own
  // venue's address (cloudListsMatch), never to anonymous callers worldwide.
  // ?finished=1 lists finished matches too: the livescore served by a venue
  // relay (frontend utils/relayLivescore), which then subscribes without a PIN.
  if (url.pathname === '/api/match/list') {
    if (isRateLimited(addressKey(req), DB_RATE_LIMIT_MAX, 'relay')) {
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
      // ?test=1: only the test (rehearsal) matches, which every other list
      // leaves out on the cloud (the tablets' "Switch to test matches")
      const onlyTest = url.searchParams.get('test') === '1'
      // Every match's owners in one pass over the sockets: ownersOf per match
      // went through every socket once per match (about 4 ms per call with
      // 404 matches and 1,100 role sockets, older referee apps call this on
      // every bundle)
      const ownersByMatch = new Map()
      for (const c of connections.values()) {
        for (const id of c.ownedMatches) {
          const list = ownersByMatch.get(id)
          if (list) list.push(c)
          else ownersByMatch.set(id, [c])
        }
      }
      const matches = []
      for (const entry of activeMatches.values()) {
        // Per entry: one crafted room must never turn the whole list into 500
        // for everyone (a sync stores only validated fields; this is a second
        // guard on the read).
        try {
          if (IS_CLOUD && (entry.match?.test === true) !== onlyTest) continue
          const owners = ownersByMatch.get(entry.matchId) || []
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
        } catch (err) {
          console.error(`[API] /api/match/list skipped a room:`, err?.message)
        }
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
    if (isRateLimited(addressKey(req), DB_RATE_LIMIT_MAX, 'relay')) {
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
      if (LOG_EACH_CONNECTION) console.log(`[API] /api/match/${logValue(matchId)} - Found match`)
      else relaySummary.count('match fetches')
      // The bundle (rosters, events) only after the PIN step: a match token
      // from the PIN check, or one of the match's PINs, each its role's view
      // (relayBundleView). Else the summary.
      const offeredToken = req.headers['x-ov-match-token']
      let view = tokenGrantsRelay(offeredToken, matchId, matchData.match) ? relayViewOf(matchTokens.verify(offeredToken)?.r) : null
      const offeredPin = req.headers['x-ov-match-pin']
      if (!view && typeof offeredPin === 'string' && offeredPin.trim()) {
        const checked = relayPinCheck(ipBucketKey(getClientIp(req)), matchId, matchData, offeredPin)
        if (checked === 'rate-limited') {
          sendJson(res, 429, { success: false, error: 'Too many failed attempts. Please wait 10 minutes before trying again.' }, { 'Retry-After': '600' })
          return
        }
        if (checked === 'ok') view = relayViewOf(pinTypeOf(matchData.match, offeredPin, { sport: matchData.sportType }))
      }
      const bundle = view ? { access: 'full', ...wireBundle(matchData, view) } : relaySummaryBundle(matchData)
      // Ensure team objects have the correct format
      const homeTeam = typeof bundle.homeTeam === 'object' && bundle.homeTeam ? bundle.homeTeam : { name: matchData.homeTeam || 'Home' }
      const awayTeam = typeof bundle.awayTeam === 'object' && bundle.awayTeam ? bundle.awayTeam : { name: matchData.awayTeam || 'Away' }

      sendJsonText(req, res, 200, JSON.stringify({
        success: true,
        // Never PINs; personal data never; rosters/events only with access.
        ...bundle,
        homeTeam,
        awayTeam
      }))
    } else {
      if (LOG_EACH_CONNECTION) console.log(`[API] /api/match/${logValue(matchId)} - Match not found (${activeMatches.size} active)`)
      else relaySummary.count('match fetches (not found)')
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
  // entry per watching tablet of THAT match carrying just its role, team and
  // `proved` (no id, no IP, no connect time, no list of rooms). A tablet is a
  // referee or bench only once it proved that role (`proved`, provedRoleOf),
  // every other watcher a subscriber or livescore. The detail (ids,
  // connect times) of one match needs that match's PIN or match token
  // (X-OV-Match-Pin / X-OV-Match-Token, as GET /api/match/:id).
  if (url.pathname === '/api/server/connections') {
    if (isRateLimited(addressKey(req), DB_RATE_LIMIT_MAX, 'relay')) {
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
        const checked = relayPinCheck(ipBucketKey(getClientIp(req)), matchId, entry, offeredPin)
        if (checked === 'rate-limited') {
          sendJson(res, 429, { error: 'Too many failed attempts. Please wait 10 minutes before trying again.' }, { 'Retry-After': '600' })
          return
        }
        detail = checked === 'ok'
      }
    }

    // Dashboard clients (referee, bench, livescore...) - not the scoreboard:
    // one per socket and match it watches (or waits for)
    const watchers = []
    connections.forEach((client) => {
      if (!client.role || client.role === 'scoreboard') return
      for (const id of client.rooms) {
        if (matchId && id !== matchId) continue
        const proved = provedRoleOf(client, id)
        // Referee or bench only with that role's PIN or match token
        // (proved): the role a socket names (join_match role, subscribe-match
        // device) proves nothing, and the scorer's tablet status showed a
        // referee connected for a socket that only said so.
        const role = proved ? proved.role : (client.device === 'livescore' || client.role === 'livescore' ? 'livescore' : 'subscriber')
        watchers.push({ client, matchId: id, role, team: proved?.team ?? null, proved: !!proved })
      }
    })
    const refereesCount = watchers.filter(w => w.role === 'referee').length
    const benchCount = watchers.filter(w => w.role === 'bench').length

    let clients
    if (detail) {
      clients = watchers.map(({ client, matchId: id, role, team, proved }) => ({
        id: client.id,
        // LAN scorers see which tablet is which; a public cloud relay must
        // not hand every client's IP to anonymous callers.
        ip: IS_CLOUD ? null : client.ip,
        role,
        team,
        proved,
        matchId: id,
        connectedAt: client.connectedAt
      }))
    } else if (matchId) {
      // Counts, in the shape the scorer's tablet status reads (role, team)
      clients = watchers.map(({ matchId: id, role, team, proved }) => ({ role, team, proved, matchId: id }))
    } else {
      clients = []
    }

    const body = {
      access: detail ? 'detail' : 'counts',
      // every socket of the server: the cloud does not say (/api/server/status)
      totalClients: IS_CLOUD ? null : connections.size,
      // sockets, each once (one hall livescore follows every court)
      dashboardClients: new Set(watchers.map((w) => w.client.id)).size,
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

  // Support form (lib/contact.js): multipart with up to 5 attachments, one
  // mail to CONTACT_EMAIL with Reply-To the user (FreeScout's customer)
  if (url.pathname === '/api/contact' && req.method === 'POST') {
    // one /64 is one client here, also off the cloud
    if (isRateLimited(ipBucketKey(getClientIp(req)), CONTACT_RATE_LIMIT_MAX, 'contact')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ success: false, error: 'Too many requests. Please wait before submitting again.' }))
      return
    }
    ;(async () => {
      // Who sends (the session in the header, before the body): a trusted
      // account may use the slots and the budget share kept for it (SEC-31)
      const sender = await contactSender(req)
      // One slot per request until it is answered, however it ends (answered,
      // refused, timed out, the client gone): the slots cap the bodies held,
      // at most 2 per address
      const job = contactSlots.run(async () => {
        let body
        try {
          // A phone on hall Wi-Fi uploading 10 MB: no data for 15 s, or not
          // done in 2 minutes, gives up (408)
          body = await readBodyBuffer(req, MAX_CONTACT_BODY_BYTES, { idleMs: CONTACT_IDLE_MS, totalMs: CONTACT_TOTAL_MS })
        } catch (err) {
          sendBodyError(res, err, {
            tooLargeBody: { success: false, code: 'files_too_large', error: 'Attachments too large' },
            invalidBody: { success: false, code: 'invalid_body', error: 'Invalid request' }
          })
          return
        }
        const r = await handleContact({ body, contentType: req.headers['content-type'], mailer: contactMailer, sender })
        sendJson(res, r.status, r.body)
      }, { key: ipBucketKey(getClientIp(req)), trusted: sender.trusted === true })
      if (!job) {
        // Every slot taken (or this address's): the hourly cap's 503 busy
        // (the app offers mailto), at once. The body is drained and
        // discarded, never held; the connection stays open so the client can
        // still read the answer (closed, a client still uploading gets EPIPE
        // instead)
        console.warn(`[Contact] ${contactSlots.inFlight} messages already being received (at most ${contactSlots.perKey} per address): busy`)
        req.resume()
        sendJson(res, 503, BUSY_BODY)
        return
      }
      await job
    })().catch((err) => {
      console.error('[Contact] request failed:', err?.message)
      sendJson(res, 500, { success: false, code: 'server_error', error: 'Could not send the message' })
    })
    return
  }

  // POST /api/match/send-info { externalId }: the match's information (no
  // PIN) to the signed-in scorer's own confirmed address, built from the
  // stored match the account created or edits. It used to mail any typed
  // address a text from the request, the game PIN included.
  if (url.pathname === '/api/match/send-info' && req.method === 'POST') {
    ;(async () => {
      try {
        const ok = await ownMailRequest(req, res, 'email')
        if (!ok) return
        const { layer, user, body } = ok
        const ext = typeof body?.externalId === 'string' ? body.externalId.trim() : ''
        if (!ext || ext.length > 200) {
          sendJson(res, 400, { success: false, error: 'Invalid request: externalId is required' })
          return
        }
        if (!(await canScoreSomeSport(layer, user.id))) {
          sendJson(res, 403, { success: false, error: 'Only scorers can send match information' })
          return
        }
        const { rows: [m] } = await layer.db.pool.query(
          `SELECT m.game_n, m.home_team, m.away_team, m.scheduled_at,
                  m.match_info->>'hall' AS hall, m.match_info->>'city' AS city, m.match_info->>'league' AS league
             FROM public.matches m
            WHERE m.external_id = $1
              AND ${OWN_MATCH_SQL}
            LIMIT 1`, [ext, user.id])
        if (!m) {
          sendJson(res, 404, { success: false, error: 'Match not found' })
          return
        }
        const to = await ownConfirmedAddress(layer, user.id)
        if (!to) {
          sendJson(res, 409, { success: false, code: 'OV_EMAIL_UNCONFIRMED', error: 'Confirm your email address first' })
          return
        }
        const text = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().replace(/[\r\n]+/g, ' ').slice(0, max) : 'N/A')
        // the full name only (the short name is retired, 26.11.2026)
        const team = (t) => text(t?.name)
        const { date, time } = matchMailDateTime(m.scheduled_at)
        const gameN = m.game_n ?? 'N/A'
        const emailBody = `
Match Information
=================

Game Number: ${gameN}

Teams
-----
Home: ${team(m.home_team)}
Away: ${team(m.away_team)}

Match Details
-------------
Date: ${date}
Time: ${time}
Venue: ${text(m.hall)}
City: ${text(m.city)}
League: ${text(m.league)}

---
Generated by eScoresheet
`.trim()
        await sendOwnMail(res, layer.auth.mailer, { to, subject: `Game ${gameN} eScoresheet`, text: emailBody, message: 'Match info sent to your account email' })
      } catch (err) {
        // value-free, as send-pin: an SMTP rejection quotes the address
        console.error(`[Match Email] send failed req=${req.ovRequestId || '-'} reason=${mailErrorReason(err)}`)
        if (!res.headersSent) sendJson(res, 500, { success: false, error: 'Failed to send email' })
      }
    })()
    return
  }

  // POST /api/match/send-pin { externalId, gamePin }: the game PIN to the
  // signed-in scorer's own confirmed address (the PIN notice before the coin
  // toss, "Send to my email"). The same guards as send-info: a session, a
  // scorer, a match the account created or edits, EMAIL_RATE_LIMIT_MAX per
  // address and per account (their own counters), the SMTP mailbox (else
  // Resend; sendOwnMail). No address is read from the request. The server
  // keeps the game PIN hashed (lib/pinHash.js): the app sends the PIN it
  // shows, and it is mailed only when it matches the stored one
  // (lib/matchPinMail.js). Logs carry neither the PIN nor the address.
  if (url.pathname === '/api/match/send-pin' && req.method === 'POST') {
    ;(async () => {
      try {
        const ok = await ownMailRequest(req, res, 'pinEmail')
        if (!ok) return
        const { layer, user, body } = ok
        const ext = typeof body?.externalId === 'string' ? body.externalId.trim() : ''
        const pin = pinFromBody(body?.gamePin)
        if (!ext || ext.length > 200 || !pin) {
          sendJson(res, 400, { success: false, error: 'Invalid request: externalId and gamePin are required' })
          return
        }
        if (!(await canScoreSomeSport(layer, user.id))) {
          sendJson(res, 403, { success: false, error: 'Only scorers can send the game PIN' })
          return
        }
        const { rows: [m] } = await layer.db.pool.query(
          `SELECT m.game_n, m.home_team, m.away_team, m.scheduled_at, m.game_pin,
                  m.match_info->>'league' AS league
             FROM public.matches m
            WHERE m.external_id = $1
              AND ${OWN_MATCH_SQL}
            LIMIT 1`, [ext, user.id])
        if (!m) {
          sendJson(res, 404, { success: false, error: 'Match not found' })
          return
        }
        // never an unchecked PIN: none stored, or another one, sends nothing
        if (m.game_pin == null || String(m.game_pin).trim() === '' || !layer.pins.matches('game', pin, m.game_pin)) {
          sendJson(res, 409, { success: false, code: 'OV_PIN_MISMATCH', error: 'This is not the game PIN of the match' })
          return
        }
        const to = await ownConfirmedAddress(layer, user.id)
        if (!to) {
          sendJson(res, 409, { success: false, code: 'OV_EMAIL_UNCONFIRMED', error: 'Confirm your email address first' })
          return
        }
        const { subject, text } = pinMailText(m, pin, matchMailDateTime(m.scheduled_at))
        await sendOwnMail(res, layer.auth.mailer, { to, subject, text, message: 'Game PIN sent to your account email' })
      } catch (err) {
        // value-free (lib/opsLog.js): a provider message can name the address
        console.error(`[Match PIN Email] send failed req=${req.ovRequestId || '-'} reason=${mailErrorReason(err)}`)
        if (!res.headersSent) sendJson(res, 500, { success: false, error: 'Failed to send email' })
      }
    })()
    return
  }

  // POST /api/verify-reopen-password was removed (db/007): reopening a closed
  // match is an admin action (POST /api/admin/matches/:id/reopen, audit-logged).

  // Get official matches from iCal feeds
  if (url.pathname === '/api/official-matches' && req.method === 'GET') {
    const federation = url.searchParams.get('federation')
    const league = url.searchParams.get('league')

    // Validate federation. Own keys only: an inherited name (constructor,
    // __proto__, toString) passed a plain lookup, and reading its .leagues
    // threw in this handler, which ended the backend.
    if (!federation || !Object.hasOwn(ICAL_FEEDS, federation)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: false,
        error: 'Invalid federation. Use SV or SVRZ.'
      }))
      return
    }

    // Validate league (own keys only, as the federation)
    const leagueConfig = league && Object.hasOwn(ICAL_FEEDS[federation].leagues, league) ? ICAL_FEEDS[federation].leagues[league] : null
    if (!leagueConfig) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: false,
        error: `Invalid league for ${federation}. Available: ${Object.keys(ICAL_FEEDS[federation].leagues).join(', ')}`
      }))
      return
    }

    // a cache hit fetches nothing and counts nothing; a fetch counts per
    // address and kind of page (SEC-42)
    if (!icalCached(federation, league) && isRateLimited(`${addressKey(req)}\n${requestPageKind(req)}`, ICAL_RATE_LIMIT_MAX, 'ical')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
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
    if (isRateLimited(`${addressKey(req)}\n${requestPageKind(req)}`, ICAL_LEAGUES_RATE_LIMIT_MAX, 'ical-leagues')) {
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
    captureServerError(err, { view: `${where} ${routeLabel(req)}`, requestId: req.ovRequestId, status: 503 })
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
        if (isRateLimited(`${ipKey}|${typeof type === 'string' ? type.slice(0, 20) : ''}`, PIN_RATE_LIMIT_MAX, 'pin')) {
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
        // The upload PINs (no enable flag: every match from Create match to
        // the coin toss) are checked against the named match only, never
        // looked up among all of them. The Upload Roster app names it since
        // 2026-10-05.
        if (!cfg.enabledKey && matchFilter === null) {
          sendJson(res, 400, { success: false, error: 'Invalid request: matchExternalId is required for this PIN type' })
          return
        }
        // A lookup that names no match, of a sport the server no longer
        // serves them for (OV_PIN_ONLY_LOOKUP): nothing compared, nothing counted
        if (matchFilter === null && !PIN_ONLY_LOOKUP.allows(isBeach ? 'beach' : 'indoor')) {
          logPinOnlyLookup('validate-connection-pin', isBeach ? 'beach' : 'indoor', type, 'refused')
          sendJson(res, 409, PIN_ONLY_REFUSED)
          return
        }
        // The brute-force budget: failed guesses per IP (/64) and scope (this
        // PIN type of every live match, or of the one match asked for: a
        // reloading tablet re-checks its stored PIN for its match, untouched
        // by other tablets' typos), and per address range across buckets: per
        // match and PIN type, or per PIN-only lookup (lib/matchRestore.js
        // createPinFailureBudget: only the guessing ranges are refused).
        // isLimited counts this attempt up front (parallel guesses cannot all
        // slip through); a success or a server error is refunded below.
        const scope = matchFilter !== null ? pinScope.match(matchFilter, type) : pinScope.search(sport, type)
        if (pinFailureLimiter.isLimited(ipKey, scope)) {
          sendTooMany({ success: false, error: 'Too many failed attempts. Please wait 10 minutes before trying again.' }, '600')
          return
        }
        let counted = true
        const refund = () => { if (counted) { counted = false; pinFailureLimiter.refund(ipKey, scope) } }
        res.once('finish', () => { if (res.statusCode !== 404) refund() })
        const pinStr = String(pin).trim()
        const layer = await getDataLayer()
        const found = await findMatchByConnectionPin({
          runQuery: layer.db.runQuery,
          pins: layer.pins,
          sport: isBeach ? 'beach' : 'indoor',
          cfg,
          pin: pinStr,
          matchExternalId: matchFilter,
          maxRows: PIN_SCAN_MAX_ROWS,
          // the PIN-only lookup: a match whose PIN type is locked for the caller's range proves nothing
          skip: matchFilter === null ? (row) => pinFailureLimiter.locked(row.external_id, type, ipKey) : null
        })
        if (!found.ok) {
          sendJson(res, 500, { success: false, error: 'Validation failed' })
          return
        }
        const matchRow = found.row
        if (matchFilter === null) logPinOnlyLookup('validate-connection-pin', isBeach ? 'beach' : 'indoor', type, matchRow ? 'found' : 'wrong')
        if (!matchRow) {
          // The same wrong PIN again (the relay's check of the same typed PIN,
          // an app retry) is no new guess. A named match with no PIN to
          // compare (none, closed, another sport) counts nowhere across addresses.
          if (!pinFailureLimiter.repeated(ipKey, scope, pinStr) && matchFilter !== null &&
              await isConnectionPinMatch({ runQuery: layer.db.runQuery, sport: isBeach ? 'beach' : 'indoor', matchExternalId: matchFilter }) === false) {
            pinFailureLimiter.matchRefund([[matchFilter, type]], ipKey)
          }
          sendJson(res, 404, { success: false, error: 'Invalid PIN code' })
          return
        }
        const conns = matchRow.connections || {}
        // Capability for this match (relay bundle, GET /api/match/:id, its
        // rosters on anonymous /api/db reads), see lib/matchAccess.js
        // (none for the upload PINs: the Upload Roster app reads nothing with it)
        // storedPin: the stored form the PIN matched, so a PIN change ends the token on /api/db too
        const storedPins = matchRow.connection_pins || {}
        const storedKey = cfg.pinKeys.find((k) => layer.pins.matches(k, pinStr, storedPins[k]))
        const token = matchRow.external_id && isTokenRole(type)
          ? matchTokens.issue({ matchKey: matchRow.external_id, role: type, matchUuid: matchRow.id, pin: pinStr, storedPin: storedKey ? storedPins[storedKey] : null })
          : null
        // this address proved the match (the live hub's token-less rule, liveRowGranted)
        if (token) noteAddressProof(ipKey, matchTokens.verify(token))
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
  // A stored scoresheet PDF by its view link (POST /api/scoresheets/:id/view made
  // it, checked and audited): the browser's own PDF viewer opens it in a tab,
  // which sends no Authorization header, shows the file name and saves under it.
  if (url.pathname.startsWith('/api/scoresheet-view/')) {
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    req.resume()
    const view = SCORESHEET_VIEW_RE.exec(url.pathname)
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !view) {
      sendJson(res, req.method !== 'GET' && req.method !== 'HEAD' ? 405 : 404, { data: null, error: { message: 'Not found', code: 'OV_NOT_FOUND' } }, { 'Cache-Control': 'no-store' })
      return
    }
    if (isRateLimited(ipBucketKey(getClientIp(req)), SCORESHEET_VIEW_RATE_LIMIT_MAX, 'scoresheetView')) {
      sendTooMany()
      return
    }
    ;(async () => {
      try {
        const layer = await getDataLayer()
        let name = null
        try { name = decodeURIComponent(view[2]) } catch { /* a malformed name is not a file's */ }
        // read from storage again: the link keeps no file in memory (SEC-39)
        const r = await layer.scoresheets.readViewLink({ token: view[1], name })
        if (r.status !== 200 || !r.file) {
          sendJson(res, 404, { data: null, error: { message: 'This link has expired. Open the scoresheet again from the manager.', code: 'OV_NOT_FOUND' } }, { 'Cache-Control': 'no-store' })
          return
        }
        res.writeHead(200, {
          'Cache-Control': 'no-store, private',
          'Content-Type': r.file.contentType,
          'Content-Length': String(r.file.data.length),
          // the file names are [A-Za-z0-9_-] and ".pdf" (lib/scoresheets.js downloadName)
          'Content-Disposition': `inline; filename="${r.file.filename}"`,
          // the link must not travel on as a Referer, nor be indexed
          'Referrer-Policy': 'no-referrer',
          'X-Robots-Tag': 'noindex, nofollow'
        })
        res.end(req.method === 'HEAD' ? undefined : r.file.data)
      } catch (err) {
        sendLayerError('scoresheet-view', err)
      }
    })()
    return
  }

  // Public match API for embedding in other websites (lib/publicApi.js):
  // anonymous, read-only, names never included, CORS open to every origin
  // WITHOUT credentials (a bearer-less GET, so no ambient authority to lend).
  const publicRoute = req.method === 'GET'
    ? /^\/api\/public\/v1\/matches(?:\/([^/]+)(?:\/(live|stream|stats))?)?$/.exec(url.pathname)
    : null
  // The widget on a bare page, for an <iframe> on any site (frame-ancestors *, nothing else allowed)
  const embedFrame = req.method === 'GET' ? /^\/embed\/(match|club)\/([A-Za-z0-9_.:-]{1,200})$/.exec(url.pathname) : null
  if (embedFrame) {
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Access-Control-Allow-Credentials')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors *")
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' })
    res.end(embedPage(embedFrame[1], embedFrame[2], { theme: url.searchParams.get('theme') || '' }))
    return
  }
  if (publicRoute || (req.method === 'GET' && url.pathname === '/embed/livescore.js')) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.removeHeader('Access-Control-Allow-Credentials')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.setHeader('Vary', 'Origin')
    if (!publicRoute) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' })
      res.end(LIVESCORE_JS)
      return
    }
    if (!DB_MODE) {
      sendNoDb({ error: 'not available on this server' })
      return
    }
    const [, rawId, part] = publicRoute
    let matchId = null
    if (rawId) {
      try { matchId = decodeURIComponent(rawId) } catch { /* bad escape */ }
      if (!matchId || !PUBLIC_MATCH_ID_RE.test(matchId)) {
        sendJson(res, 400, { error: 'bad match id' })
        return
      }
    }
    // a stream is one long request: a smaller per-IP budget of new streams
    const limit = part === 'stream' ? 30 : 240
    if (isRateLimited(ipBucketKey(getClientIp(req)), limit, 'publicApi' + (part === 'stream' ? 'Stream' : ''))) {
      sendTooMany({ error: 'rate limited' })
      return
    }
    const streamKey = ipBucketKey(getClientIp(req))
    ;(async () => {
      try {
        const layer = await getDataLayer()
        const api = layer.publicApi
        if (part === 'stream') {
          publicStreams ??= createLiveStreams({ snapshot: (id) => api.liveSnapshot(id), ...(PUBLIC_STREAMS_PER_ADDRESS ? { maxPerKey: PUBLIC_STREAMS_PER_ADDRESS } : {}) })
          // a full server answers before the query and with an error status: a
          // 200 that ends at once makes EventSource reconnect every 3 s
          if (!publicStreams.canAttach(matchId, streamKey)) { sendJson(res, 503, { error: 'too many streams' }, { 'Retry-After': '60', 'Cache-Control': 'no-store' }); return }
          const first = await api.liveSnapshot(matchId)
          if (!first) { sendJson(res, 404, { error: 'match not found' }); return }
          if (res.destroyed) return
          if (!publicStreams.canAttach(matchId, streamKey)) { sendJson(res, 503, { error: 'too many streams' }, { 'Retry-After': '60', 'Cache-Control': 'no-store' }); return }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
          })
          res.write('retry: 3000\n\n')
          // no await between canAttach and attach: the check still holds
          if (!publicStreams.attach(matchId, res, { key: streamKey, first })) { res.end(); return }
          return
        }
        const r = !matchId
          ? await api.list(listParams(url))
          : part === 'live' ? await api.live(matchId) : part === 'stats' ? await api.stats(matchId) : await api.info(matchId)
        sendJson(res, r.status, r.body, r.headers || {})
      } catch (err) {
        sendLayerError('public-api', err, { error: 'temporarily unavailable' })
      }
    })()
    return
  }

  // The sign-up form's clubs and their teams (db/025): ids and names only, no
  // personal data, no counts; anonymous, per IP
  if (url.pathname === '/api/public/clubs' && req.method === 'GET') {
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    if (isRateLimited(ipBucketKey(getClientIp(req)), PUBLIC_CLUBS_RATE_LIMIT_MAX, 'publicClubs')) {
      sendTooMany()
      return
    }
    ;(async () => {
      try {
        const layer = await getDataLayer()
        const r = await layer.requests.publicClubs()
        const cache = r.status === 200 ? { 'Cache-Control': 'public, max-age=60' } : { 'Cache-Control': 'no-store' }
        sendJson(res, r.status, r.body, { ...cache, ...(r.status >= 500 ? { 'Retry-After': '5' } : {}) })
      } catch (err) {
        sendLayerError('public-clubs', err)
      }
    })()
    return
  }

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
        const headers = { ...cache, ...(r.status >= 500 ? { 'Retry-After': '5' } : {}) }
        // PERM-02: the answer's bytes (and their gzip) as built once per
        // tournament and cache period; never serialised again per request
        if (r.raw?.text) {
          if (res.headersSent) return
          const gz = r.raw.gzip && acceptsGzip(req)
          res.writeHead(r.status, {
            'Content-Type': 'application/json',
            ...headers,
            ...(r.raw.gzip ? { Vary: 'Accept-Encoding' } : {}),
            ...(gz ? { 'Content-Encoding': 'gzip' } : {})
          })
          res.end(gz ? r.raw.gzip : r.raw.text)
          return
        }
        sendJson(res, r.status, r.body, headers)
      } catch (err) {
        sendLayerError('public-beach', err)
      }
    })()
    return
  }

  // The match activity log (lib/activityLog.js, db/016): POST /api/activity
  // (upload, signed in) and GET /api/activity?match= (owner / editor; admin).
  if (url.pathname === '/api/activity' && (req.method === 'POST' || req.method === 'GET')) {
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    ;(async () => {
      const noStore = { 'Cache-Control': 'no-store' }
      try {
        const layer = await getDataLayer()
        const user = await layer.auth.requireUser(req, res)
        if (!user) return
        const limited = req.method === 'POST'
          ? isRateLimited(user.id, ACTIVITY_RATE_LIMIT_MAX, 'activity')
          : isRateLimited(user.id, MANAGE_RATE_LIMIT_MAX, 'manage')
        if (limited) {
          req.resume()
          sendJson(res, 429, TOO_MANY, { 'Retry-After': '60', ...noStore })
          return
        }
        const isAdmin = await isAdminUser(layer, user.id)
        let r
        if (req.method === 'POST') {
          let body
          try {
            body = await readJsonBody(req, ACTIVITY_MAX_BODY)
          } catch (err) {
            sendBodyError(res, err)
            return
          }
          r = await layer.activity.ingest({ user, body, isAdmin })
        } else {
          req.resume()
          r = await layer.activity.listForMatch({ user, isAdmin, query: url.searchParams })
        }
        sendJson(res, r.status, r.body, { ...noStore, ...(r.status >= 500 ? { 'Retry-After': '5' } : {}) })
      } catch (err) {
        sendLayerError('activity', err)
      }
    })()
    return
  }

  // The error tracker (lib/errorTracker.js, db/050): POST /api/errors from
  // every page and app, signed in or not; a valid Bearer session names the
  // account (never the body). Rate limited per address here and per address,
  // device and in total by the tracker; the address is never stored. Taken
  // as JSON or as the text/plain of navigator.sendBeacon.
  if (url.pathname === '/api/errors' && req.method === 'POST') {
    if (!DB_MODE) {
      req.resume()
      sendNoDb()
      return
    }
    const ipKey = ipBucketKey(getClientIp(req))
    if (isRateLimited(ipKey, ERRORS_RATE_LIMIT_MAX, 'errors')) {
      req.resume()
      sendJson(res, 429, TOO_MANY, { 'Retry-After': '60', 'Cache-Control': 'no-store' })
      return
    }
    ;(async () => {
      const noStore = { 'Cache-Control': 'no-store' }
      try {
        const layer = await getDataLayer()
        let body
        try {
          body = await readJsonBody(req, ERRORS_MAX_BODY)
        } catch (err) {
          sendBodyError(res, err)
          return
        }
        let accountId = null
        if (bearerFromHeaders(req.headers)) {
          try {
            accountId = (await layer.auth.verifyToken(req))?.id || null
          } catch { /* the database: the report goes in without the account */ }
        }
        const r = await layer.errors.ingest({ body, accountId, ipKey })
        sendJson(res, r.status, r.body, { ...noStore, ...(r.status >= 500 ? { 'Retry-After': '30' } : {}) })
      } catch (err) {
        console.error('[errors] ingest error:', err?.message || err)
        sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '30', 'Cache-Control': 'no-store' })
      }
    })()
    return
  }

  // GET /api/admin/activity/export?...&format=csv|ndjson[&emails=1] — the
  // admin's activity export, streamed page by page (at most 50,000 rows),
  // on record (audited) before the first row goes; the accounts' email
  // addresses only with emails=1.
  if (url.pathname === '/api/admin/activity/export' && req.method === 'GET') {
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    ;(async () => {
      try {
        const layer = await getDataLayer()
        const user = await layer.auth.requireUser(req, res)
        if (!user) return
        if (isRateLimited(user.id, MANAGE_RATE_LIMIT_MAX, 'manage')) {
          sendJson(res, 429, TOO_MANY, { 'Retry-After': '60', 'Cache-Control': 'no-store' })
          return
        }
        if (!(await isAdminUser(layer, user.id))) {
          sendJson(res, 403, { data: null, error: { message: 'You do not have access to this', code: 'OV_FORBIDDEN' } }, { 'Cache-Control': 'no-store' })
          return
        }
        const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'ndjson'
        const emails = url.searchParams.get('emails') === '1'
        const refused = await layer.activity.auditExport({ actorId: user.id, query: url.searchParams, format, emails })
        if (refused) {
          sendJson(res, refused.status, refused.body, { 'Cache-Control': 'no-store', ...(refused.status >= 500 ? { 'Retry-After': '5' } : {}) })
          return
        }
        const pages = layer.activity.exportPages(url.searchParams, { emails })
        const columns = layer.activity.exportColumns({ emails })
        let first
        try {
          first = await pages.next()
        } catch (err) {
          if (err?.result) {
            sendJson(res, err.result.status, err.result.body, { 'Cache-Control': 'no-store' })
            return
          }
          throw err
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        res.writeHead(200, {
          'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="openvolley-activity-${stamp}.${format}"`,
          'Cache-Control': 'no-store'
        })
        if (format === 'csv') res.write(columns.join(',') + '\n')
        const writeRows = (rows) => {
          const text = rows.map((r) => (format === 'csv' ? layer.activityCsvLine(r, columns) : JSON.stringify(r))).join('\n') + '\n'
          return res.write(text)
        }
        try {
          let page = first
          while (!page.done) {
            if (!writeRows(page.value)) await new Promise((resolve) => res.once('drain', resolve))
            page = await pages.next()
          }
        } catch (err) {
          console.warn('[activity] export stopped:', err?.message)
        }
        res.end()
      } catch (err) {
        sendLayerError('activity/export', err)
      }
    })()
    return
  }

  // The club API (lib/clubApi.js, docs/club-api.md): /api/club/v1/* with a club's
  // bearer token. Before the session routes below, which own the rest of /api/club/.
  if (url.pathname === '/api/club/v1' || url.pathname.startsWith('/api/club/v1/')) {
    if (!DB_MODE) {
      sendNoDb({ error: 'not available on this server' })
      return
    }
    const clientIp = getClientIp(req)
    const failKey = ipBucketKey(clientIp)
    if (isRateLimited(failKey, CLUB_API_IP_RATE_LIMIT_MAX, 'clubApiIp') || clubApiTokenFailLimiter.isLimited(failKey)) {
      req.resume()
      sendTooMany({ error: 'rate limited' })
      return
    }
    ;(async () => {
      const noStore = { 'Cache-Control': 'no-store' }
      try {
        const layer = await getDataLayer()
        const bearer = bearerFromHeaders(req.headers)
        const a = await layer.clubApi.authenticate(bearer)
        // only a refused token counts against the address
        if (a.error?.status !== 401) clubApiTokenFailLimiter.refund(failKey)
        if (a.error) {
          req.resume()
          sendJson(res, a.error.status, a.error.body, { ...noStore, ...(a.error.status >= 500 ? { 'Retry-After': '5' } : {}) })
          return
        }
        if (isRateLimited(a.principal.tokenId, CLUB_API_TOKEN_RATE_LIMIT_MAX, 'clubApi')) {
          req.resume()
          sendJson(res, 429, { data: null, error: { message: `Rate limit: ${CLUB_API_TOKEN_RATE_LIMIT_MAX} requests a minute per token`, code: 'OV_RATE_LIMITED' } }, { 'Retry-After': '60', ...noStore })
          return
        }
        let body = {}
        if (req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH') {
          try {
            body = await readJsonBody(req)
          } catch (err) {
            sendBodyError(res, err)
            return
          }
        } else {
          req.resume()
        }
        const r = await layer.clubApi.handle({ principal: a.principal, method: req.method, pathname: url.pathname, query: url.searchParams, body })
        if (r.status === 200 && r.changes?.length) publishChanges(r.changes)
        // an answer of lib/teams.js / licences.js is { data, error }; the public lib's is the bare body
        sendJson(res, r.status, r.body, { ...noStore, ...(r.status >= 500 ? { 'Retry-After': '5' } : {}), ...(r.headers || {}) })
      } catch (err) {
        sendLayerError('club-api', err)
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
  if (manageFamily === 'approvals') {
    req.resume()
    sendJson(res, 410, APPROVAL_REMOVED_BODY, { 'Cache-Control': 'no-store' })
    return
  }
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
          : manageFamily === 'account'
            ? isRateLimited(user.id, ACCOUNT_RATE_LIMIT_MAX, 'account')
            : (manageFamily === 'admin' || manageFamily === 'savedTeams' || manageFamily === 'me' || manageFamily === 'join' || manageFamily === 'beach' || manageFamily === 'scoresheets' || manageFamily === 'club' || manageFamily === 'games' || manageFamily === 'settings' || manageFamily === 'team' || manageFamily === 'gameRosters' || manageFamily === 'clubLicences' || manageFamily === 'notifications' || manageFamily === 'matchEditors') &&
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
        // Invite codes: failed attempts per account AND per IP (/64, a higher
        // ceiling), counted up front (parallel guesses) and refunded unless the
        // answer is a failure
        const redeemKeys = manageFamily === 'account' ? [[redeemLimiter, `u:${user.id}`], [redeemIpLimiter, `ip:${ipBucketKey(clientIp)}`]] : []
        const refundRedeem = () => { for (const [limiter, k] of redeemKeys) limiter.refund(k) }
        if (redeemKeys.length) {
          const over = redeemKeys.map(([limiter, k]) => limiter.isLimited(k))
          if (over.some(Boolean)) {
            // the refused call is no attempt: a burst never prolongs the lock
            refundRedeem()
            req.resume()
            sendJson(res, 429, { data: null, error: { message: 'Too many attempts. Please wait a few minutes.', code: 'OV_TOO_MANY_ATTEMPTS' } }, { 'Retry-After': String(REDEEM_FAILURES.windowMs / 1000), ...noStore })
            return
          }
        }
        let body = {}
        if (req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'HEAD') {
          // An admin's rebuilt scoresheet PDF (POST /api/scoresheets/:id/rebuild)
          // comes base64 in the body: the storage's limit, not the 1 MB of the rest
          const rebuild = manageFamily === 'scoresheets' && req.method === 'POST' && /\/rebuild$/.test(url.pathname)
          try {
            body = rebuild
              ? await readJsonBody(req, layer.storage.maxBodyBytes)
              : await readJsonBody(req)
          } catch (err) {
            refundRedeem()
            sendBodyError(res, err, rebuild ? { tooLargeBody: layer.storage.bodyTooLarge().body } : undefined)
            return
          }
        } else {
          req.resume()
        }
        let r
        try {
          r = await layer.manage.route({ method: req.method, pathname: url.pathname, query: url.searchParams, body, user, access, ip: clientIp, lang: String(req.headers['accept-language'] || '').slice(0, 512) })
        } finally {
          if (!isRedeemFailure(r)) refundRedeem()
        }
        if (r.status === 200 && r.changes?.length) publishChanges(r.changes)
        // A scoresheet PDF (lib/scoresheets.js): the file itself, never cached
        if (r.status === 200 && r.file) {
          res.writeHead(200, {
            ...noStore,
            'Content-Type': r.file.contentType,
            'Content-Length': String(r.file.data.length),
            'Content-Disposition': `${r.file.disposition === 'attachment' ? 'attachment' : 'inline'}; filename="${r.file.filename}"`
          })
          res.end(r.file.data)
          return
        }
        const headers = { ...noStore, ...(r.status >= 500 ? { 'Retry-After': '5' } : {}), ...(r.headers || {}) }
        sendJson(res, r.status, r.body, headers)
      } catch (err) {
        console.error('[manage] error:', err?.message || err)
        captureServerError(err, { view: `manage ${routeLabel(req)}`, requestId: req.ovRequestId, status: 503 })
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
    const reqId = req.ovRequestId || newRequestId()
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
          ? isRateLimited(addressKey(req), DB_WRITE_IP_RATE_LIMIT_MAX, 'dbWriteIp')
          : isRateLimited(addressKey(req), DB_READ_RATE_LIMIT_MAX, 'db')) {
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

        // Reference tables: admins write, everyone else reads; the referee
        // directory's additions are open to the accounts that fill officials.
        // A referee directory insert: { capped } (PERM-07, refereeDirectoryInsert)
        let refereeInsert = null
        if (isWrite && (READ_ONLY_TABLES.has(table) || table === REFEREE_DIRECTORY)) {
          let allowed = false
          if (refereeDirectoryWriteAllowed(table, action, params)) {
            let scorer
            try {
              scorer = await fillsOfficials(layer, authUser.id)
            } catch (err) {
              console.warn('[DB] access check failed:', err?.message)
              logRejected(503, 'OV_DB_UNAVAILABLE')
              sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
              return
            }
            allowed = scorer && (action === 'insert' || (await refereeSportsKept(layer, params)))
          }
          const admin = await isAdminUser(layer, authUser.id)
          if (!allowed && !admin) {
            logRejected(403, 'OV_READ_ONLY_TABLE')
            sendJson(res, 403, { data: null, error: { message: 'This table is read-only for your account', code: 'OV_READ_ONLY_TABLE' } })
            return
          }
          if (table === REFEREE_DIRECTORY && action === 'insert') {
            if (!admin) {
              const checked = refereeDirectoryRows(params.data)
              if (checked.refusal) {
                logRejected(checked.refusal.status, checked.refusal.body.error.code)
                sendJson(res, checked.refusal.status, checked.refusal.body)
                return
              }
            }
            refereeInsert = { capped: !admin }
          }
        }

        // db/048: no filter or order on a date-of-birth column (they are NULL;
        // a value an older backend stored meanwhile is not probed either)
        const dobFilter = dobColumnFilter(table, params)
        if (dobFilter) {
          logRejected(400, 'OV_DOB_FILTER')
          sendJson(res, 400, { data: null, error: { message: 'Dates of birth are not kept: this column cannot be used as a filter', code: 'OV_DOB_FILTER' } })
          return
        }

        // Anonymous reads of tables with personal data (matches: rosters,
        // signatures, officials; svrz_games: the columns of before db/048,
        // when it kept the referees' dates of birth) get the public columns
        // only (lib/publicColumns.js ANON_DB_COLUMNS), and may filter/order on
        // plain columns only. The referee directory needs a role that fills
        // the sheet's officials (fillsOfficials, below). A signed-in caller reads full matches /
        // events rows only of the matches it created or edits (an admin: all);
        // other matches' rows get the anonymous projection, and a filter on a
        // non-public column then only matches its own rows (no probing of
        // hidden data). The token is only checked when the request asks for
        // more than the public view, so the scorer's frequent id lookups cost
        // nothing.
        let anonView = false
        let readOwner = null
        // The account of a read whose token was checked (below), if any
        let sessionReader = null
        // events: who may ask for voided rows too (params.include_voided, lib/pgQuery.js)
        let includeVoided = null
        // db/051: columns of the answer this reader may not see (OFFICIALS_ONLY_COLUMNS)
        let hiddenColumns = null
        // May `userId` read the referee directory? null: the roles could not
        // be read, already answered 503 (never a silent "no").
        const officialsFillerFor = async (userId) => {
          try {
            return await fillsOfficials(layer, userId)
          } catch (err) {
            console.warn('[DB] access check failed:', err?.message)
            logRejected(503, 'OV_DB_UNAVAILABLE')
            sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
            return null
          }
        }
        // The referee directory is read only by the accounts that fill a
        // scoresheet's officials (fillsOfficials: admins, indoor and beach
        // scorers), i.e. Match setup's "Database" picker of an official match.
        // Nobody else, signed in or not, gets even the names: 401 without a
        // session, 403 for any other account. A test or easy match has no use
        // for it either (the app hides the picker there).
        if (!isWrite && table === REFEREE_DIRECTORY) {
          let reader = null
          if (bearerFromHeaders(req.headers)) {
            try {
              reader = await layer.auth.verifyToken(req)
            } catch (err) {
              console.error('[auth] verifyToken failed:', err?.message)
              logRejected(503, 'auth_unavailable')
              sendJson(res, 503, { data: null, error: { message: 'Authentication service unavailable. Please try again.', code: 'auth_unavailable', retryable: true } }, { 'Retry-After': '5' })
              return
            }
          }
          if (!reader) {
            const code = bearerFromHeaders(req.headers) ? 'invalid_token' : 'OV_SIGN_IN_REQUIRED'
            logRejected(401, code)
            sendJson(res, 401, { data: null, error: { message: code === 'invalid_token' ? 'Invalid or expired session. Please sign in again.' : 'Sign in as a scorer to read the referee directory', code } })
            return
          }
          const full = await officialsFillerFor(reader.id)
          if (full === null) return
          if (!full) {
            logRejected(403, 'OV_REFEREE_DIRECTORY')
            sendJson(res, 403, { data: null, error: { message: 'The referee directory is only for scorers', code: 'OV_REFEREE_DIRECTORY' } })
            return
          }
          // db/056: which account added a referee is for admins
          if (!(await isAdminUser(layer, reader.id))) {
            if (columnFilterOf(params, REFEREE_DIRECTORY_ADMIN_COLUMNS)) {
              logRejected(400, 'OV_SECRET_FILTER')
              sendJson(res, 400, { data: null, error: { message: 'This column cannot be used as a filter by your account', code: 'OV_SECRET_FILTER' } })
              return
            }
            hiddenColumns = REFEREE_DIRECTORY_ADMIN_COLUMNS
          }
        }
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
            // A token that no longer verifies (signed out, expired): 401 like a
            // write, never the public view of a row the client may merge and
            // write back (the sync queue handles invalid_token). No token at
            // all keeps the public view.
            if (!reader && bearerFromHeaders(req.headers)) {
              logRejected(401, 'invalid_token')
              sendJson(res, 401, { data: null, error: { message: 'Invalid or expired session. Please sign in again.', code: 'invalid_token' } })
              return
            }
            sessionReader = reader
            // db/051: the referees' licence numbers only for the accounts that
            // fill a sheet's officials; any other session reads the rows
            // without them and may not filter or order on them. Roles that
            // cannot be read count as "no" here: the table is read-only for
            // the apps, so the schedule still loads, without the licences
            // (the scorer types them), and nothing is written back.
            const officialsOnly = reader && Object.hasOwn(OFFICIALS_ONLY_COLUMNS, table) ? OFFICIALS_ONLY_COLUMNS[table] : null
            if (officialsOnly) {
              let full = false
              try {
                full = await readsRefereeLicences(layer, reader.id)
              } catch (err) {
                console.warn('[DB] access check failed (the referees\' licences left out):', err?.message)
              }
              if (!full) {
                if (columnFilterOf(params, officialsOnly)) {
                  logRejected(400, 'OV_SECRET_FILTER')
                  sendJson(res, 400, { data: null, error: { message: 'This column cannot be used as a filter by your account', code: 'OV_SECRET_FILTER' } })
                  return
                }
                hiddenColumns = officialsOnly
              }
            }
            const fullReader = reader
            if (!fullReader) {
              if (check.badFilter) {
                logRejected(400, 'OV_SECRET_FILTER')
                sendJson(res, 400, { data: null, error: { message: reader ? 'This column cannot be used as a filter by your account' : 'This column cannot be used as a filter without a session', code: 'OV_SECRET_FILTER' } })
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
        // A match whose status leaves 'setup' drops the teams' uploaded rosters (lib/uploadedRoster.js)
        if (table === 'matches' && action === 'update') p.data = withPendingRostersCleared(p.data)
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

        // PERM-01: a new match under the key of a live relay room needs that
        // key's first game PIN, or comes without a PIN from the key's first
        // device (newRowRoomRefusal), before anything below acts on the write
        // (a held game's take-over); admins write unguarded
        if (table === 'matches' && (action === 'insert' || action === 'upsert') && params.data !== undefined && matchOwner && !matchOwner.admin) {
          let refused
          try {
            refused = await newRowRoomRefusal(layer, params.data, clientIp, deviceOf(request.device))
          } catch (err) {
            console.warn('[DB] relay room check failed:', err?.message)
            refused = { status: 503, body: DB_UNAVAILABLE_BODY, code: 'OV_DB_UNAVAILABLE' }
          }
          if (refused) {
            logRejected(refused.status, refused.code)
            sendJson(res, refused.status, refused.body, refused.status >= 500 ? { 'Retry-After': '5' } : {})
            return
          }
        }

        // One cloud match per official game (db/007): the friendly answer
        // before the write, with who holds the game. Approved scorers only:
        // a pending account gets pgQuery's 403 OV_SCORER_REQUIRED first, so
        // it never sees a scorer's name.
        // An update that moves a match onto another game or season gets the
        // same check (the stored rows with the update over them).
        // With the club rule on, a scorer of the home club takes over a game
        // an account outside the club holds while its match is still in
        // setup (lib/accounts.js takeOverHeldGame, audited), then writes.
        const officialWrite = (action === 'insert' || action === 'upsert') ? p.data !== undefined : action === 'update'
        if (table === 'matches' && officialWrite && matchOwner && !matchOwner.testOnly) {
          let claim
          try {
            // only the sports the caller can score in: the others get pgQuery's 403 first
            const sports = scoringSportsOf(matchOwner)
            const findClaim = () => action === 'update'
              ? layer.accounts.findTakenGameForUpdate({ userId: authUser.id, filters: p.filters, data: p.data, sports })
              : layer.accounts.findTakenGame({ userId: authUser.id, rows: p.data, sports })
            claim = await findClaim()
            if (claim && !claim.mine && !matchOwner.admin) {
              const t = await layer.accounts.takeOverHeldGame({ actorId: authUser.id, claim })
              if (t.released) {
                if (t.changes.length) publishChanges(t.changes)
                claim = await findClaim()
              }
            }
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

        // db/019: the match is scored on another device now. Only writes that
        // name their device (request.device, apps from the handover on): the
        // older apps are neither checked nor recorded. The check is part of
        // the write (lib/scorerDevice.js guardedWrite: one transaction, the
        // scorer row locked against a take-over), and a failing check fails
        // the write (5xx, the app sends it again): a write let through
        // unchecked is the one the device that took over never gets.
        const scoringDevice = isWrite && SCORER_TABLES.includes(table) && layer.scorer ? deviceOf(request.device) : null
        const scorerRefs = scoringDevice ? matchRefsOfWrite(table, action, p) : null

        // db/015: a delete of ONE event by its external_id (a correction of an
        // app from before the event history) voids the event, never deletes
        // it (lib/eventRevisions.js voidByExternalId). Whole-match deletes
        // (filter on match_id) are unchanged.
        const singleEventExt = table === 'events' && action === 'delete' ? singleExternalIdFilter(p.filters) : null
        if (singleEventExt && layer.revisions?.voidByExternalId) {
          const v = await layer.revisions.voidByExternalId({ eventExt: singleEventExt, user: authUser, matchOwner, scorerCheck: scorerCheckOf(layer, scoringDevice, matchOwner) })
          if (v) {
            if (v.status === 200 && v.changes?.length) publishChanges(v.changes)
            if (v.status >= 400) logRejected(v.status, v.body?.error?.code)
            sendJson(res, v.status, v.body, v.status >= 500 ? { 'Retry-After': '5' } : {})
            return
          }
        }

        // A read without a checked session, or by an account without a role:
        // anonReadOptions, and a slot of anonDbGate
        const anonymousRead = !isWrite && !authUser && (!sessionReader || await readsLikeAnonymous(layer, sessionReader.id))
        const runOpts = {
          proto: req.headers['x-ov-proto'],
          scope: ownerScoped ? { column: 'user_id', value: authUser.id } : undefined,
          matchOwner,
          // the acting account for db/007's triggers (closed_by)
          ...(isWrite ? { actorId: authUser.id } : {}),
          ...(readOwner ? { readOwner } : {}),
          ...(includeVoided ? { includeVoided } : {}),
          ...(anonymousRead ? anonReadOptions(table, p) : {})
        }
        // A PIN this write changes starts its count across callers again
        const pinWrites = table === 'matches' && isWrite ? await watchPinWrites(layer, action, p, authUser?.id || null) : null
        // The scoring device's writes: checked, run and adopted in one transaction
        const runRequest = async () => {
          if (refereeInsert) return refereeDirectoryInsert(layer, authUser.id, p, runOpts, refereeInsert)
          if (!scoringDevice) return layer.db.runQuery({ table, action, params: p }, runOpts)
          const g = await layer.scorer.guardedWrite({
            device: scoringDevice,
            refs: scorerRefs,
            table,
            action,
            matchOwner,
            userId: authUser.id,
            write: (client) => layer.db.runQuery({ table, action, params: p }, { ...runOpts, client })
          })
          return g.moved ? { status: 409, body: scorerMovedBody(g.moved) } : g.result
        }
        let r
        if (anonymousRead) {
          // A caller that gives up while queued: its read is not run
          let gone = false
          const onGone = () => { if (!res.writableEnded) gone = true }
          res.on('close', onGone)
          try {
            r = await anonDbGate.run(runRequest, { abandoned: () => gone })
          } catch (err) {
            if (err?.code === 'GATE_ABANDONED') return
            if (err?.code !== 'AUTH_BUSY') throw err
            logRejected(503, 'OV_DB_BUSY')
            sendJson(res, 503, { data: null, error: { message: 'Server busy, please retry', code: 'OV_DB_BUSY', retryable: true } }, { 'Retry-After': '2' })
            return
          } finally {
            res.off('close', onGone)
          }
        } else {
          r = await runRequest()
        }
        // Take-over inline: a scorer's match insert/upsert refused only for
        // ownership (a match set up before ownership existed, or created by
        // another account) that carries the match's own game PIN proves it,
        // like POST /api/match/claim: the account becomes an editor and the
        // write is retried once. Old apps get the take-over without a client
        // change. A match closed past the claim's window gets no editor:
        // 409 OV_MATCH_CLOSED, as the claim (and that retry) answered.
        if (r.status === 403 && r.body?.error?.code === 'OV_NOT_MATCH_OWNER' && table === 'matches' &&
            (action === 'insert' || action === 'upsert') && matchOwner && !matchOwner.admin) {
          const took = await claimByUpsertPin(layer, authUser.id, params.data, clientIp)
          if (took === 'claimed') r = await runRequest()
          else if (took === 'closed') r = { status: 409, body: CLOSED_MATCH_BODY }
        }
        if (table === 'matches' && isWrite) r = await enrichGameTaken(layer, authUser.id, r, p.data, matchOwner)
        // An update of ONE match (by its external_id) that matched no row,
        // because the server lacks the match (a database restored to an
        // earlier time): 404 OV_MATCH_UNKNOWN, so the app sends the match
        // again from its own data instead of counting the update as sent. A
        // stored match the caller may not write is refused above (403). A
        // match deleted on purpose is 404 OV_MATCH_DELETED: not sent again.
        if (r.status === 200 && table === 'matches' && action === 'update' && Array.isArray(r.changes) && r.changes.length === 0) {
          const ext = singleExternalIdFilter(p.filters)
          const state = ext ? await matchState(layer, ext, authUser.id, deviceOf(request.device)?.id ?? null) : 'stored'
          if (state !== 'stored') r = { status: 404, body: state === 'deleted' ? MATCH_DELETED_BODY : MATCH_UNKNOWN_BODY }
        }
        if (r.status === 200 && r.changes?.length) {
          publishChanges(r.changes)
          if (table === 'matches') {
            await layer.accounts.auditClaimedGames({ actorId: authUser.id, changes: r.changes })
            // an official match's rosters to its teams' saved teams and clubs' lists, later (lib/rosterSaveBack.js)
            layer.saveBack?.note(r.changes)
          }
        }
        if (r.status === 200 && pinWrites) await pinWrites.done()
        // 4xx/5xx from pgQuery (OV_UNSCOPED_EXTERNAL_ID, OV_CLIENT_TOO_OLD,
        // OV_UNSCOPED_WRITE, constraint errors, ...): code only, no details
        // (they can quote row values).
        if (r.status >= 400) logRejected(r.status, r.body?.error?.code)
        // redactSecrets is belt and braces: pgQuery never returns secret columns.
        // db/048: a date-of-birth column is answered as null (pgQuery's nullColumns already do)
        const redacted = withoutColumns(withoutDobColumns(table, redactSecrets(table, r.body.data)), hiddenColumns)
        // Anonymous: public columns; a match's rosters only with the match
        // token of its PIN check (referee/bench fallback, lib/matchAccess.js).
        // The token is bound to its role: the role's connection must still be on.
        // Only a token from the database's PIN check (it names matches.id) unlocks
        // database rows; a relay room's token grants the relay copy only.
        const verified = anonView || readOwner ? matchTokens.verify(req.headers['x-ov-match-token']) : null
        const granted = verified?.u ? verified : null
        // this address holds the match's token (the live hub's token-less rule, liveRowGranted)
        if (granted) noteAddressProof(ipBucketKey(getClientIp(req)), granted)
        const grantedPins = granted?.s ? await connectionPinsOf(layer, granted.u) : null
        // grantedRole: a bench token gets the other team's people as shirt
        // numbers, as on the relay (publicColumns relayBundleView)
        const grantOpts = { grantedExternalId: granted?.m || null, grantedMatchUuid: granted?.u || null, grantRow: (row) => matchTokens.stillGrantsRow(granted, row, grantedPins), grantedRole: granted?.r ?? null }
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
        // The read settles for a client that left while queued, for an
        // upload that went silent and for one that trickles past the total
        // limit, so every slot comes back (readJsonBody).
        await restoreGate.run(async () => {
          let body
          try {
            body = await readJsonBody(req, MAX_RESTORE_BODY_SIZE, { idleMs: RESTORE_BODY_IDLE_MS, totalMs: RESTORE_BODY_TOTAL_MS })
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
          // PERM-01: a restore that creates the match under the key of a
          // live relay room needs that key's first game PIN, or comes without
          // a PIN from the key's first device (newRowRoomRefusal)
          if (!matchOwner.admin && body?.match && typeof body.match === 'object') {
            let refused
            try {
              refused = await newRowRoomRefusal(layer, [body.match], getClientIp(req), deviceOf(body.device))
            } catch (err) {
              console.warn('[match/restore] relay room check failed:', err?.message)
              refused = { status: 503, body: DB_UNAVAILABLE_BODY }
            }
            if (refused) {
              sendJson(res, refused.status, refused.body, refused.status >= 500 ? { 'Retry-After': '5' } : {})
              return
            }
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
          // db/019: a restore made before another device took the match over
          // (queued on a device the scorer left, sent late; age_ms: how long
          // ago, by the app's clock) must not replace that device's score.
          // Checked inside the restore's transaction (a take-over waits for it).
          const scorerCheck = scorerCheckOf(layer, deviceOf(body?.device), matchOwner, { ageMs: body?.age_ms ?? null })
          const pinWrites = body?.match && typeof body.match === 'object' ? await watchPinWrites(layer, 'upsert', { data: body.match }, user.id) : null
          let r = await layer.restore.restoreMatch(body, { proto: req.headers['x-ov-proto'], matchOwner, actorId: user.id, scorerCheck })
          r = await enrichGameTaken(layer, user.id, r, body?.match ? [body.match] : [], matchOwner)
          if (r.status === 200) {
            if (pinWrites) await pinWrites.done()
            publishChanges(r.changes)
            await layer.accounts.auditClaimedGames({ actorId: user.id, changes: r.changes })
            layer.saveBack?.note(r.changes)
            // A backup restored onto a device is that device's take-over (db/019):
            // it scores the match from now on, the previous device is told.
            await claimScorerDevice(layer, { external_id: body?.match?.external_id, device: body?.device }, matchOwner, user.id, 'match/restore')
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
        // db/019: the device sending the revisions (body.device; a revision's
        // own device_id is the one that made it, which may be the same
        // installation under an older id). Apps that name none are not
        // checked. Checked inside the revisions' transaction.
        const scorerCheck = scorerCheckOf(layer, deviceOf(body?.device), matchOwner)
        const r = await layer.revisions.apply({ body, user, matchOwner, scorerCheck })
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
  // POST /api/match/scorer {external_id, device: {id, platform}, claim} — the
  // scoring-device handover (db/019, lib/scorerDevice.js). claim (default):
  // this device scores the match from now on ("continue on this device",
  // "Take back scoring here"); the previous device is told over the relay
  // (scorer-moved) and its next write gets 409 OV_SCORER_MOVED. claim false:
  // is this device the scorer? The creator, an editor or an admin only.
  if (url.pathname === '/api/match/scorer' && req.method === 'POST') {
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
          body = await readJsonBody(req)
        } catch (err) {
          sendBodyError(res, err)
          return
        }
        let matchOwner
        try {
          matchOwner = await matchOwnerFor(layer, user)
        } catch (err) {
          console.warn('[match/scorer] access check failed:', err?.message)
          sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
          return
        }
        const r = await layer.scorer.claim({ body, matchOwner, userId: user.id })
        if (r.status === 200 && r.body.data?.moved) scorerMoved(r, deviceOf(body?.device)?.id)
        sendJson(res, r.status, r.body, r.status >= 500 ? { 'Retry-After': '5' } : {})
      } catch (err) {
        sendLayerError('match/scorer', err)
      }
    })()
    return
  }

  // POST /api/match/known {external_id} — the sync queue asks before it sends
  // a match again whose sets or events found no match on the server: 200
  // {state: 'stored'|'deleted'|'unknown'}. Only 'unknown' (lost to a restore)
  // is sent again; a deleted match stays deleted. Signed-in callers only;
  // 'deleted' only to the match's creator, editors and admins, and to a
  // request naming a device that scored it (`device`, matchState).
  if (url.pathname === '/api/match/known' && req.method === 'POST') {
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
          body = await readJsonBody(req)
        } catch (err) {
          sendBodyError(res, err)
          return
        }
        const ext = body?.external_id
        if (typeof ext !== 'string' || ext === '' || ext.length > 200) {
          sendJson(res, 400, { data: null, error: { message: 'Invalid request', code: 'OV_INVALID_REQUEST' } })
          return
        }
        // the asking device (the apps send it since 2611 SR-1): a device that scored the match hears 'deleted'
        sendJson(res, 200, { data: { state: await matchState(layer, ext, user.id, deviceOf(body?.device)?.id ?? null) }, error: null })
      } catch (err) {
        sendLayerError('match/known', err)
      }
    })()
    return
  }

  if (url.pathname === '/api/match/claim' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(addressKey(req), RESTORE_PIN_IP_RATE_LIMIT_MAX, 'restorePin')) {
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
        // Signed in: an admin, or the creator or an editor of the match, is
        // not refused by a lock of the address range (the guessers'),
        // lib/matchRestore.js trustedFor
        const r = await layer.restore.claimMatch(body, { userId: user.id, limitKey: layer.ipKey(clientIp), trust: pinTrustOf(layer, user.id, null) })
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

  // POST /api/match/upload-roster {matchExternalId, team, pin, roster} — the
  // Upload Roster app's cloud write (signatures in the body are ignored since 24.11.2026).
  // Authorised by the team's upload PIN of THAT match (no account: coaches are
  // not the match's scorer, and the ownership guard would refuse them). Writes
  // only connections.pending_{home|away}_roster, checked by the app's own
  // rules (lib/uploadedRoster.js), never the match's signatures (they are
  // given at the coin toss); the scorer accepts the pending roster in Match Setup. The status is
  // tested again in the write: an upload never lands after the coin toss.
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
        const { matchExternalId, team, pin, roster } = body || {}
        if (typeof matchExternalId !== 'string' || !matchExternalId || matchExternalId.length > 128 ||
            (team !== 'home' && team !== 'away') || !isValidPin(pin) ||
            !roster || typeof roster !== 'object' || Array.isArray(roster)) {
          sendJson(res, 400, { success: false, error: 'Invalid request' })
          return
        }
        // No signatures from an upload (owner 24.11.2026, tester bug: one team's
        // signatures went up with the other team's roster): the coach and the
        // captain sign at the coin toss. An older page still sends them: ignored,
        // so nothing is written into the match's signatures
        const checked = checkUploadedRoster({ ...roster, coachSignature: null, captainSignature: null })
        if (!checked.ok) {
          sendJson(res, 400, { success: false, error: `Invalid roster (${uploadedRosterProblemText(checked.problems)})` })
          return
        }
        const pinKey = team === 'home' ? 'upload_home' : 'upload_away'
        // This team's upload PIN of this match: the scope validate-connection-pin
        // uses for it, apart from the referee and bench connects (per address,
        // and per match across callers)
        const scope = pinScope.match(matchExternalId, pinKey)
        if (pinFailureLimiter.isLimited(ipKey, scope)) {
          sendTooMany({ success: false, error: 'Too many failed attempts. Please wait 10 minutes before trying again.' }, '600')
          return
        }
        let counted = true
        res.once('finish', () => { if (res.statusCode !== 403 && counted) { counted = false; pinFailureLimiter.refund(ipKey, scope) } })
        const layer = await getDataLayer()
        const found = await layer.db.runQuery({
          table: 'matches',
          action: 'select',
          params: {
            columns: 'id, status, connection_pins',
            filters: [{ type: 'eq', column: 'external_id', value: matchExternalId }],
            limit: 1
          }
        }, { internal: true })
        if (found.status !== 200) {
          sendJson(res, 500, { success: false, error: 'Upload failed' })
          return
        }
        const row = found.body.data?.[0]
        // No such match: no PIN to guess, nothing counted across callers
        if (!row) pinFailureLimiter.matchRefund([[matchExternalId, pinKey]], ipKey)
        if (!row || !layer.pins.matches(pinKey, String(pin).trim(), row.connection_pins?.[pinKey])) {
          sendJson(res, 403, { success: false, error: 'Invalid upload PIN' })
          return
        }
        const locked = () => sendJson(res, 409, { success: false, error: 'The roster of this match is locked (coin toss done)' })
        if (row.status !== 'setup') {
          locked()
          return
        }
        const pendingKey = team === 'home' ? 'pending_home_roster' : 'pending_away_roster'
        const pending = checked.roster
        // The row locked from its status and signatures to the write: a coin
        // toss in between refuses the upload, and the other team's upload at
        // the same moment waits for this one instead of dropping its signatures
        const out = await layer.db.withTransaction(async (client) => {
          const { rows: [now] } = await client.query('SELECT status, signatures FROM public.matches WHERE id = $1 FOR UPDATE', [row.id])
          if (!now || now.status !== 'setup') return { locked: true }
          const data = { connections: { [pendingKey]: pending } } // merged into the stored object (pgQuery mergeJsonColumns)
          const signatures = signaturesAfterUpload(now.signatures, team, pending)
          if (signatures) data.signatures = signatures
          const r = await layer.db.runQuery({
            table: 'matches',
            action: 'update',
            params: { data, filters: [{ type: 'eq', column: 'id', value: row.id }] }
          }, { internal: true, client })
          if (r.status !== 200) throw Object.assign(new Error(`upload write ${r.status} ${r.body?.error?.code || ''}`), { status: r.status })
          return { changes: r.changes }
        })
        if (out.locked) {
          locked()
          return
        }
        publishChanges(out.changes)
        sendJson(res, 200, { success: true })
      } catch (err) {
        console.error('[upload-roster] Error:', err.message)
        sendJson(res, err?.status >= 500 ? 503 : 500, { success: false, error: 'Upload failed' })
      }
    })()
    return
  }

  // POST /api/match/restore-by-pin {gameN, pin} — anonymous, exact match on
  // game number AND game PIN, attempt-limited per caller (lib/matchRestore.js).
  // {claim: true, device, external_id?}: the caller continues the match on
  // this device (the restore dialog's Confirm, "Take back scoring here"): the
  // game PIN it proved makes the device the scorer (db/019), signed in or
  // not, before the match is read for it (scorer in the answer). With
  // external_id, only that match is claimed. The search for backups sends
  // no claim: looking a match up never takes it over.
  if (url.pathname === '/api/match/restore-by-pin' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(addressKey(req), RESTORE_PIN_IP_RATE_LIMIT_MAX, 'restorePin')) {
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
        const claimDevice = layer.scorer && body?.claim === true ? deviceOf(body?.device) : null
        const takeOver = claimDevice ? (m) => takeOverByPin(layer, m, claimDevice, editorUserId, body?.external_id) : null
        // A signed-in admin, creator or editor of a match of the game number,
        // or the device the database names as its scorer, is not refused by a
        // lock of the address range (the guessers'), lib/matchRestore.js trustedFor
        const trust = pinTrustOf(layer, editorUserId, layer.scorer ? deviceOf(body?.device) : null)
        const r = await layer.restore.restoreByPin(body, { limitKey: layer.ipKey(clientIp), editorUserId, takeOver, trust })
        if (r.status === 200 && editorUserId && r.body.data?.access === 'editor') {
          await layer.accounts.auditClaimPin({ actorId: editorUserId, matchId: r.body.data.match?.id, via: 'restore-by-pin' })
        } else if (r.status === 200) {
          // every other read by game PIN too, anonymous ones included
          await layer.accounts.auditRestorePin({ actorId: editorUserId, matchId: r.body.data?.match?.id, access: r.body.data?.access || 'full' })
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
  // default 'scoresheets'; README "Who can read a scoresheet") and uploaded
  // only at the paths the scorer apps write; a scoresheet PDF (and an
  // OpenBeach JSON of a match) is stored only for a match the caller may
  // write (lib/scoresheets.js storeFile, db/033); a download of a missing
  // object answers 200 with
  // OV_STORAGE_NOT_FOUND (no log/backup yet is normal, not a browser error).
  // POST /api/scoresheet/test-mail { pdf (base64), teams, result }: a test
  // match's scoresheet to the signed-in scorer's own address (lib/finalMail.js;
  // never stored): an account that scores (either sport) with a confirmed
  // address only. The body holds the PDF: the storage's body cap.
  if (url.pathname === '/api/scoresheet/test-mail' && req.method === 'POST') {
    if (!DB_MODE) {
      sendNoDb()
      return
    }
    ;(async () => {
      try {
        const layer = await getDataLayer()
        const user = await layer.auth.requireUser(req, res)
        if (!user) return
        if (isRateLimited(user.id, TEST_MAIL_RATE_LIMIT_MAX, 'testMail')) {
          req.resume()
          sendJson(res, 429, TOO_MANY, { 'Retry-After': '60' })
          return
        }
        let canScore
        try {
          const a = await layer.access.get(user.id)
          canScore = a.apps ? Object.values(a.apps).some((s) => s?.canScore === true) : a.canScore === true
        } catch (err) {
          console.warn('[Test mail] access check failed:', err?.message)
          req.resume()
          sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
          return
        }
        if (!canScore) {
          req.resume()
          sendJson(res, 403, { data: null, error: { message: 'Your account is not approved as a scorer yet', code: 'OV_SCORER_REQUIRED' } })
          return
        }
        let body
        try {
          body = await readJsonBody(req, layer.storage.maxBodyBytes)
        } catch (err) {
          sendBodyError(res, err)
          return
        }
        const r = await layer.finalMail.testMail({ userId: user.id, body, lang: String(req.headers['accept-language'] || '').slice(0, 512) })
        sendJson(res, r.status, r.body)
      } catch (err) {
        sendLayerError('Test mail', err, { data: null, error: { message: 'Email unavailable', code: 'OV_MAIL_UNAVAILABLE' } })
      }
    })()
    return
  }

  // GET /api/global/live/<code> — the Global tool's live page for TVs
  // (lib/globalLive.js): the courts of a tournament code, score summaries
  // only, for any page (the livescore site, a school's own screen)
  // GET /tv/<code> and /tv/tv.js — the live page for any screen, smart TVs
  // included (lib/tvPage.js: plain HTML and ES5, same-origin polling)
  // /tv without a code: the code entry form; /tv/go?code=…: its answer
  if (req.method === 'GET' && (url.pathname === '/tv' || url.pathname === '/tv/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    res.end(tvEntryHtml({ wrong: url.searchParams.get('wrong') === '1' }))
    return
  }
  if (req.method === 'GET' && url.pathname === '/tv/go') {
    const code = String(url.searchParams.get('code') || '').toUpperCase().replace(/[\s-]/g, '')
    const screen = screenNumber(String(url.searchParams.get('court') || '').trim())
    // a live screen code (with a court, if given), or a league game number
    const to = isLiveCode(code) ? (screen ? `/tv/${code}/${screen}` : `/tv/${code}`) : (/^[0-9]{1,7}$/.test(code) ? `/tv/${code}` : '/tv/?wrong=1')
    res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' })
    res.end()
    return
  }
  if (req.method === 'GET' && url.pathname === '/tv/tv.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' })
    res.end(TV_JS)
    return
  }
  // /tv/<game number> (1-7 digits; a code is always 8): one league game;
  // /tv/<code>/<court>: one court of a live screen
  const tvGameRoute = req.method === 'GET' ? /^\/tv\/([0-9]{1,7})\/?$/.exec(url.pathname) : null
  if (tvGameRoute) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    res.end(tvPageHtml({ game: tvGameRoute[1] }))
    return
  }
  const tvScreenRoute = req.method === 'GET' ? /^\/tv\/([^/]{1,40})\/([0-9]{1,2})\/?$/.exec(url.pathname) : null
  if (tvScreenRoute) {
    const code = String(tvScreenRoute[1]).toUpperCase().replace(/[\s-]/g, '')
    const screen = screenNumber(tvScreenRoute[2])
    if (!isLiveCode(code) || !screen) {
      res.writeHead(302, { Location: '/tv/?wrong=1', 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    res.end(tvPageHtml({ code, screen }))
    return
  }
  const tvRoute = req.method === 'GET' ? /^\/tv\/([^/]{1,40})\/?$/.exec(url.pathname) : null
  if (tvRoute) {
    const code = String(tvRoute[1]).toUpperCase().replace(/[\s-]/g, '')
    if (!isLiveCode(code)) {
      // back to the form, with a hint (a TV user typed it with a remote)
      res.writeHead(302, { Location: '/tv/?wrong=1', 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    res.end(tvPageHtml(code))
    return
  }

  // POST /api/global/live/<code> — a scorer device whose relay is not the
  // cloud (the desktop app, a venue relay with internet) sends its court
  // itself: { court, liveState, match, homeTeam, awayTeam, sets, listed }. The court
  // token (a hash of the match's own secret) keeps it one court with the
  // relay path; the summary is cut down in lib/globalLive.js courtSummary.
  // No account: a court the relay proved takes no push (409), a full code or
  // store only gives way to ended or stale courts (503), new codes and courts
  // per address and hour are capped (429; lib/globalLive.js put).
  if (req.method === 'POST' && /^\/api\/global\/live\/[^/]{1,40}$/.test(url.pathname)) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.removeHeader('Access-Control-Allow-Credentials')
    if (isRateLimited(ipBucketKey(getClientIp(req)), GLOBAL_LIVE_PUSH_RATE_LIMIT_MAX, 'global-live-push')) {
      req.resume()
      sendTooMany()
      return
    }
    const code = url.pathname.slice('/api/global/live/'.length)
    ;(async () => {
      let body
      try {
        body = await readJsonBody(req, GLOBAL_LIVE_PUSH_BODY_MAX)
      } catch (err) {
        sendBodyError(res, err, { tooLargeBody: { data: null, error: { message: 'Too large', code: 'OV_TOO_LARGE' } } })
        return
      }
      if (!isLiveCode(code) || !isCourtToken(body?.court) || !body?.liveState || typeof body.liveState !== 'object') {
        sendJson(res, 400, { data: null, error: { message: 'Bad request', code: 'OV_BAD_REQUEST' } }, { 'Cache-Control': 'no-store' })
        return
      }
      const entry = { match: body.match && typeof body.match === 'object' ? body.match : {}, homeTeam: body.homeTeam, awayTeam: body.awayTeam, sets: Array.isArray(body.sets) ? body.sets.slice(0, 5) : [] }
      const r = globalLive.put(code, body.court, body.liveState, entry, { screen: screenOf(body.screen, entry), listed: body.listed === true, source: ipBucketKey(getClientIp(req)) })
      if (r.ok) sendJson(res, 200, { data: { ok: true }, error: null }, { 'Cache-Control': 'no-store' })
      else if (r.reason === 'bound') sendJson(res, 409, { data: { ok: false }, error: { message: 'This court comes over the relay', code: 'OV_COURT_BOUND' } }, { 'Cache-Control': 'no-store' })
      else if (r.reason === 'rate') sendJson(res, 429, { data: { ok: false }, error: { message: 'Too many new live courts from this address', code: 'OV_RATE_LIMITED' } }, { 'Cache-Control': 'no-store', 'Retry-After': '600' })
      else sendJson(res, 503, { data: { ok: false }, error: { message: 'Live store full', code: 'OV_BUSY' } }, { 'Cache-Control': 'no-store' })
    })().catch((err) => {
      console.error('[GlobalLive] push failed:', String(err?.message || err).slice(0, 200))
      if (!res.headersSent) sendJson(res, 500, { data: null, error: { message: 'Failed', code: 'OV_ERROR' } })
    })
    return
  }

  // GET /api/global/live/game/<game number> — one league game for the TV page
  // (/tv/<game number>): the public live row on the cloud (publicApi
  // gameLiveRow, test rows never), the relay's own room on a venue relay
  const gameLiveRoute = req.method === 'GET' ? /^\/api\/global\/live\/game\/([0-9]{1,7})$/.exec(url.pathname) : null
  if (gameLiveRoute) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.removeHeader('Access-Control-Allow-Credentials')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    if (isRateLimited(ipBucketKey(getClientIp(req)), GLOBAL_LIVE_RATE_LIMIT_MAX, 'global-live')) {
      sendTooMany()
      return
    }
    const n = gameLiveRoute[1]
    const answer = (court) => sendJson(res, 200, { data: { code: `game/${n}`, updatedAt: court?.updatedAt ?? null, courts: court ? [court] : [] }, error: null }, { 'Cache-Control': 'no-store' })
    if (DB_MODE) {
      ;(async () => {
        const layer = await getDataLayer()
        answer(gameSummary(await layer.publicApi.gameLiveRow(n)))
      })().catch((err) => {
        console.error('[GlobalLive] game failed:', String(err?.message || err).slice(0, 200))
        if (!res.headersSent) sendJson(res, 503, { data: null, error: { message: 'Unavailable', code: 'OV_UNAVAILABLE' } }, { 'Retry-After': '5' })
      })
      return
    }
    // a venue relay: the indoor room of that game number that has a live
    // state (OpenBeach numbers its games per tournament)
    let found = null
    for (const [key, entry] of activeMatches) {
      if (String(entry?.gameNumber ?? '') === n && entry.liveState && entry.sportType !== 'beach') { found = { id: `game-${n}`, ...courtSummary(entry.liveState, entry), screen: null }; break }
      void key
    }
    answer(found)
    return
  }

  // GET /api/global/live — the public livescore's list (lib/globalLive.js
  // list): only the courts whose scorer opted in to it
  if (req.method === 'GET' && (url.pathname === '/api/global/live' || url.pathname === '/api/global/live/')) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.removeHeader('Access-Control-Allow-Credentials')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    if (isRateLimited(ipBucketKey(getClientIp(req)), GLOBAL_LIVE_RATE_LIMIT_MAX, 'global-live')) {
      sendTooMany()
      return
    }
    sendJson(res, 200, { data: globalLive.list(), error: null }, { 'Cache-Control': 'no-store' })
    return
  }

  const globalLiveRoute = req.method === 'GET' ? /^\/api\/global\/live\/([^/]{1,40})$/.exec(url.pathname) : null
  if (globalLiveRoute) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.removeHeader('Access-Control-Allow-Credentials')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    if (isRateLimited(ipBucketKey(getClientIp(req)), GLOBAL_LIVE_RATE_LIMIT_MAX, 'global-live')) {
      sendTooMany()
      return
    }
    const code = globalLiveRoute[1]
    if (!isLiveCode(code)) {
      sendJson(res, 404, { data: null, error: { message: 'Not found', code: 'OV_NOT_FOUND' } }, { 'Cache-Control': 'no-store' })
      return
    }
    // nothing live yet is an empty page, not an error: the TV waits for the first rally
    const screen = screenNumber(url.searchParams.get('screen'))
    sendJson(res, 200, { data: globalLive.get(code, { screen }) || { code, updatedAt: null, courts: [] }, error: null }, { 'Cache-Control': 'no-store' })
    return
  }

  // The opt-in cloud copy of a Global match (db/046, lib/globalMatches.js), no
  // account: the match's own key and PIN. POST /api/global/cloud/{save,load,
  // share,delete}; the read-only share link GET /api/global/shared/<token>
  // (and /pdf); a tournament's list GET /api/global/organizer/<code> (and
  // /<id>/pdf). DATABASE_URL mode only. Keys, PINs and tokens are never logged.
  const globalCloudPost = req.method === 'POST' ? /^\/api\/global\/cloud\/(save|load|share|delete)$/.exec(url.pathname) : null
  const globalSharedGet = req.method === 'GET' ? /^\/api\/global\/shared\/([^/]{1,64})(\/pdf)?$/.exec(url.pathname) : null
  const globalOrganizerGet = req.method === 'GET' ? /^\/api\/global\/organizer\/([^/]{1,40})(?:\/([^/]{1,64})\/pdf)?$/.exec(url.pathname) : null
  if (globalCloudPost || globalSharedGet || globalOrganizerGet || url.pathname.startsWith('/api/global/cloud/')) {
    if (!globalCloudPost) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.removeHeader('Access-Control-Allow-Credentials')
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    }
    if (!globalCloudPost && !globalSharedGet && !globalOrganizerGet) {
      req.resume()
      sendJson(res, 405, { data: null, error: { message: 'Method not allowed', code: 'OV_METHOD' } })
      return
    }
    // writes and the anonymous reads count apart, and a read per the kind of
    // page that sent it: a foreign page's images cannot spend the budget the
    // app's own saves and reads need (audit 2026-11-23 SEC-42)
    const cloudLimited = globalCloudPost
      ? isRateLimited(ipBucketKey(getClientIp(req)), GLOBAL_IP_RATE_LIMIT_MAX, 'global-cloud-write')
      : isRateLimited(`${ipBucketKey(getClientIp(req))}\n${requestPageKind(req)}`, GLOBAL_CLOUD_READ_RATE_LIMIT_MAX, 'global-cloud-read')
    if (cloudLimited) {
      req.resume()
      sendTooMany()
      return
    }
    if (!DB_MODE) {
      req.resume()
      sendJson(res, 503, { data: null, error: { message: 'No cloud on this server', code: 'OV_NO_CLOUD' } }, { 'Cache-Control': 'no-store' })
      return
    }
    const sendPdf = (buf) => {
      if (!buf) {
        sendJson(res, 404, { data: null, error: { message: 'Not found', code: 'OV_NOT_FOUND' } }, { 'Cache-Control': 'no-store' })
        return
      }
      // a download, never a page of this origin (PERM-15): attachment, no
      // sniffing, and a sandbox with nothing allowed should a browser render it
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Content-Disposition': 'attachment; filename="scoresheet.pdf"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" })
      res.end(buf)
    }
    // a refusal says when to come back: a PIN lock its end, a busy or full cloud soon
    const cloudHeaders = (r) => ({ 'Cache-Control': 'no-store', ...(r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : r.status === 429 ? { 'Retry-After': '60' } : r.status >= 500 ? { 'Retry-After': '5' } : {}) })
    ;(async () => {
      try {
        const gm = await getGlobalMatches()
        if (globalSharedGet) {
          if (globalSharedGet[2]) sendPdf(await gm.sharedPdf(globalSharedGet[1]))
          else { const r = await gm.shared(globalSharedGet[1]); sendJson(res, r.status, r.body, { 'Cache-Control': 'no-store' }) }
          return
        }
        if (globalOrganizerGet) {
          const code = String(globalOrganizerGet[1]).toUpperCase()
          if (globalOrganizerGet[2]) sendPdf(await gm.organizerPdf(code, globalOrganizerGet[2]))
          else { const r = await gm.organizerList(code); sendJson(res, r.status, r.body, { 'Cache-Control': 'no-store' }) }
          return
        }
        const action = globalCloudPost[1]
        await runGlobalGated(action === 'save' ? 'save' : 'load', ipBucketKey(getClientIp(req)), async () => {
          let body
          try {
            body = await readJsonBody(req, action === 'save' ? GLOBAL_CLOUD_BODY_MAX : GLOBAL_CLOUD_SMALL_BODY_MAX, { idleMs: RESTORE_BODY_IDLE_MS, totalMs: RESTORE_BODY_TOTAL_MS })
          } catch (err) {
            sendBodyError(res, err, { tooLargeBody: { data: null, error: { message: 'Match too large', code: 'OV_GLOBAL_TOO_LARGE' } } })
            return
          }
          const b = body && typeof body === 'object' ? body : {}
          // the caller's address: the network budgets and the PIN lock (never stored)
          const who = { ip: getClientIp(req) }
          const r = action === 'save'
            ? await gm.save(b.key, b.pin, { bundle: b.bundle, summary: b.summary, organizer: b.organizer ?? null, ...('pdf' in b ? { pdf: b.pdf } : {}) }, who)
            : action === 'load' ? await gm.load(b.key, b.pin, who)
              : action === 'share' ? await gm.setShare(b.key, b.pin, b.on === true, who)
                : await gm.del(b.key, b.pin, who)
          sendJson(res, r.status, r.body, cloudHeaders(r))
        }, { abandoned: () => req.destroyed })
      } catch (err) {
        if (err?.code === 'AUTH_BUSY') {
          req.resume()
          sendJson(res, 503, { data: null, error: { message: 'Server busy, retry shortly', code: 'OV_BUSY', retryable: true } }, { 'Retry-After': '5', Connection: 'close' })
          return
        }
        if (err?.code === 'GATE_ABANDONED') return
        // the code only: the message of a pg error may quote a parameter
        console.error('[Global cloud] failed:', String(err?.code || 'error').slice(0, 40))
        if (!res.headersSent) sendJson(res, 503, { data: null, error: { message: 'Cloud unavailable', code: 'OV_GLOBAL_UNAVAILABLE' } }, { 'Retry-After': '5' })
      }
    })()
    return
  }

  // POST /api/global/{save,load} — the Global tool's backup and finished
  // scoresheet, no account and no database (lib/globalStore.js): the random
  // key the device made is the only way to a file. Needs the storage root.
  if (url.pathname.startsWith('/api/global/')) {
    if (req.method !== 'POST') {
      req.resume()
      sendJson(res, 405, { data: null, error: { message: 'Method not allowed', code: 'OV_METHOD' } })
      return
    }
    if (isRateLimited(ipBucketKey(getClientIp(req)), GLOBAL_IP_RATE_LIMIT_MAX, 'global')) {
      req.resume()
      sendTooMany()
      return
    }
    const action = url.pathname.slice('/api/global/'.length)
    if (action !== 'save' && action !== 'load') {
      req.resume()
      sendJson(res, 404, { data: null, error: { message: 'Not found', code: 'OV_NOT_FOUND' } })
      return
    }
    ;(async () => {
      try {
        const store = await getGlobalStore()
        await runGlobalGated(action, ipBucketKey(getClientIp(req)), async () => {
          let body
          try {
            body = await readJsonBody(req, action === 'load' ? GLOBAL_LOAD_BODY_MAX : store.maxBodyBytes, { idleMs: RESTORE_BODY_IDLE_MS, totalMs: RESTORE_BODY_TOTAL_MS })
          } catch (err) {
            sendBodyError(res, err, { tooLargeBody: { data: null, error: { message: 'File too large', code: 'OV_GLOBAL_TOO_LARGE' } } })
            return
          }
          // the caller's address: its network's share of the store (never stored)
          const { status, body: out, retryAfter } = await store.handle(action, body, { ip: getClientIp(req) })
          // a network's day spent: when it ends (the app keeps a refused final upload until then)
          sendJson(res, status, out, { 'Cache-Control': 'no-store', ...(status >= 500 ? { 'Retry-After': '5' } : status === 429 ? { 'Retry-After': String(retryAfter > 0 ? retryAfter : 3600) } : {}) })
        }, { abandoned: () => req.destroyed })
      } catch (err) {
        if (err?.code === 'AUTH_BUSY') {
          req.resume() // discard the unread body
          sendJson(res, 503, { data: null, error: { message: 'Server busy, retry shortly', code: 'OV_BUSY', retryable: true } }, { 'Retry-After': '5', Connection: 'close' })
          return
        }
        if (err?.code === 'GATE_ABANDONED') return // the client left while queued
        console.error('[Global] failed:', err?.code || '', String(err?.message || err).slice(0, 200))
        sendJson(res, 503, { data: null, error: { message: 'Storage unavailable', code: 'OV_GLOBAL_UNAVAILABLE' } }, { 'Retry-After': '5' })
      }
    })()
    return
  }

  if (url.pathname.startsWith('/api/storage/') && req.method === 'POST') {
    if (isRateLimited(addressKey(req), STORAGE_IP_RATE_LIMIT_MAX, 'storage')) {
      sendTooMany()
      return
    }
    if (!DB_MODE) {
      sendNoDb({ data: null, error: { message: 'Storage not configured on server', code: 'OV_STORAGE_NOT_CONFIGURED' } })
      return
    }
    const action = url.pathname.slice('/api/storage/'.length)
    const upload = action === 'upload'
    ;(async () => {
      try {
        const layer = await getDataLayer()
        const user = await layer.auth.requireUser(req, res)
        if (!user) return
        // the account's share of the bodies being read and the bytes they
        // hold (SEC-18); the process's slot only once the body is here (GCS-R5)
        const kind = upload ? 'upload' : 'read'
        await runStorageAccountGated(kind, user.id, async () => {
          const lease = storageBodyBytes[kind].lease()
          try {
            let body
            try {
              body = await readJsonBody(req, upload ? layer.storage.maxBodyBytes : STORAGE_SMALL_BODY_MAX, { ...storageBodyLimits(req, upload), lease })
            } catch (err) {
              sendBodyError(res, err, { tooLargeBody: layer.storage.bodyTooLarge().body })
              return
            }
            await storageGates[kind].run(async () => {
              // Match backups and app logs (bucket backup, {userId}/...): accounts
              // with a role only (scorer, referee, manager or admin, either sport).
              // Any self-registered account could otherwise fill the volume to the
              // free-space floor every account's backups share; each account also
              // has a total of its own (lib/storage.js maxOwnerBytes).
              if (action === 'upload' && body && body.bucket === 'backup') {
                let hasRole
                try {
                  hasRole = (await layer.access.get(user.id)).roles.length > 0
                } catch (err) {
                  console.warn('[Storage] access check failed:', err?.message)
                  sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
                  return
                }
                if (!hasRole) {
                  sendJson(res, 403, { data: null, error: { message: 'Cloud backups need an account with a role', code: 'OV_STORAGE_FORBIDDEN' } })
                  return
                }
              }
              // Scoresheets of official matches: approved scorers only, of the sport
              // of the path (beach/... needs beach scoring rights)
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
                // Only the paths the scorer apps write ({day}/game….pdf|json,
                // beach/{day}/game….pdf|json): a file at a day folder's name, or one
                // below a scoresheet's name, would turn every later upload of that
                // day or match into a conflict (lib/scoresheets.js isScoresheetUploadPath)
                if (!layer.isScoresheetUploadPath(body.path)) {
                  sendJson(res, 400, { data: null, error: { message: 'Not a scoresheet path', code: 'OV_STORAGE_INVALID_PATH' } })
                  return
                }
                // a day folder is the match's scheduled date: none lies more than a
                // week ahead, and such a folder escaped the retention (SEC-16)
                if ((await import('./lib/storage.js')).scoresheetDayTooFar(body.path)) {
                  sendJson(res, 400, { data: null, error: { message: 'The scoresheet\'s day is too far in the future', code: 'OV_STORAGE_INVALID_PATH' } })
                  return
                }
              }
              // A scoresheet PDF is stored only for a match the caller may write,
              // and a closed match's PDF stays; an OpenBeach JSON of a match is
              // written only by an account that may write it (lib/scoresheets.js, db/033)
              const sheetFile = body && body.bucket === 'scoresheets' &&
                ((action === 'upload' && layer.isMatchScoresheetFile(body.path)) ||
                  (action === 'remove' && Array.isArray(body.paths) && body.paths.some(layer.isScoresheetPdf)))
              if (sheetFile) {
                let matchOwner
                try {
                  matchOwner = await matchOwnerFor(layer, user)
                } catch (err) {
                  console.warn('[Storage] access check failed:', err?.message)
                  sendJson(res, 503, DB_UNAVAILABLE_BODY, { 'Retry-After': '5' })
                  return
                }
                const r = action === 'upload'
                  ? await layer.scoresheets.storeFile({ userId: user.id, matchOwner, body })
                  : await layer.scoresheets.removeFiles({ userId: user.id, admin: matchOwner.admin === true, body })
                sendJson(res, r.status, r.body, r.status >= 500 ? { 'Retry-After': '5' } : {})
                return
              }
              const { status, body: out } = await layer.storage.handle(action, body, { userId: user.id })
              sendJson(res, status, out)
              // (a request read to its end is destroyed: only its socket says the client left)
            }, { abandoned: () => !req.socket || req.socket.destroyed })
          } finally {
            lease.release()
          }
        }, { abandoned: () => req.destroyed })
      } catch (err) {
        if (err?.code === 'AUTH_BUSY') {
          req.resume() // discard the unread body
          sendJson(res, 503, { data: null, error: { message: 'Server busy, retry shortly', code: 'OV_BUSY', retryable: true } }, { 'Retry-After': '5', Connection: 'close' })
          return
        }
        if (err?.code === 'GATE_ABANDONED') return // the client left while queued
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
        // The cloud (SEC-64): https, and each role's own site when it serves
        // no app pages (the cloud image: its /referee is 404); a venue relay
        // or a server with public/: its own pages
        const baseUrl = `${IS_CLOUD ? 'https' : 'http'}://${host}`
        const roleSites = IS_CLOUD && !HAS_STATIC

        // Generate QR codes as inline SVG
        const generateQRCodes = async (roles) => Promise.all(
          roles.map(async (role) => {
            const url = roleUrl(role, { cloud: roleSites, baseUrl })
            const svg = await QRCode.toString(url, { type: 'svg', width: 200, margin: 1 })
            return { ...role, url, svg }
          })
        )
        const [indoorQR, beachQR] = await Promise.all([
          generateQRCodes(INDOOR_ROLES),
          generateQRCodes(BEACH_ROLES)
        ])

        // Active matches info: a venue relay's own page, for the hall. The
        // cloud's root is public to the whole internet: no team names of the
        // matches being scored, no counts (the internal /health has those).
        const matchList = []
        if (!IS_CLOUD) for (const [matchId, matchData] of activeMatches.entries()) {
          // Per entry: one crafted room must never turn the landing page into
          // 500 for everyone. A sync stores only validated team names; a room
          // recovered from storage is not validated, so landingMatchRow keeps
          // only names (and a time) the page can print.
          try {
            matchList.push(landingMatchRow(matchId, matchData))
          } catch (err) {
            console.error('[Landing] skipped a room:', err?.message)
          }
        }

        const html = renderLandingPage({
          baseUrl,
          cloud: roleSites,
          clientCount: IS_CLOUD ? null : connections.size,
          matchCount: IS_CLOUD ? null : activeMatches.size,
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
}

// Create WebSocket server. HTTP and WebSocket share one port (PORT): upgrades
// are routed here. `?purpose=live` sockets (DATABASE_URL mode) go to the
// realtime hub's own small-frame, no-deflate server; everything else is a role
// socket (scoreboard/referee/bench/livescore relay) on this one.
//
// permessage-deflate is negotiated as before, for what the devices send:
// older scorers upload whole bundles, compressed by their browsers. The cloud
// sends nothing compressed (threshold Infinity; ws applies the threshold
// because server_no_context_takeover is always negotiated): ws keeps a zlib
// deflate context per socket once it has compressed one message, about 150 KB
// in the production image, which was the backend's first memory wall at a
// national peak (1,000 tablets: 224 MB of RSS against 76 MB, load test
// 2026-10-26), and every bundle was deflated once per tablet. The relay's
// bundles carry no undo snapshots any more (relayEvents): plain, they are
// smaller than whole and deflated were. A venue relay (--local) has a hall's
// few tablets on its Wi-Fi: it still compresses what is above 1 KB.
const wss = new WebSocketServer({
  noServer: true,
  // Increase limits for match data
  maxPayload: 10 * 1024 * 1024, // 10MB
  perMessageDeflate: {
    ...(IS_CLOUD ? {} : { zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 } }),
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: IS_CLOUD ? Infinity : 1024
  }
})

wss.on('error', (err) => {
  // Listen errors (EADDRINUSE) reach server.on('error'); a noServer wss never sees them.
  console.error('❌ WebSocket server error:', err.message)
})

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => { /* client went away mid-handshake */ })
  // Browsers apply no same-origin rule to WebSockets: without this any web
  // page opened on a device made it a relay client (joined rooms, tried PINs
  // from its visitors' addresses, held a hall's connection slots). A page of
  // an origin the origin rule (lib/cors.js) does not trust is refused, role
  // and live sockets alike; a socket without an Origin (the native apps' and
  // the board bridge's) is no page and connects as before.
  const origin = req.headers.origin
  if (origin !== undefined && !isTrustedOrigin(origin, { host: req.headers.host })) {
    transportRefusals.upgradeOrigin++
    socket.once('finish', () => socket.destroy())
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return
  }
  // ws:// on the cloud (SEC-61): older apps set to http://backend.openvolley.app
  // open their relay socket that way. Accepted as before, and counted.
  if (IS_CLOUD && isPlainVisitor(req.headers)) notePlainHttp(req, 'ws')
  if (realtimeHub && isLiveRequest(req)) {
    relaySummary.count('live upgrades')
    realtimeHub.handleUpgrade(req, socket, head, { ip: getClientIp(req) })
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

// Server-side ping for role sockets: every 30 s, and a socket that missed the
// previous pong is terminated. Behind Cloudflare it keeps them open (it closes
// WebSockets idle for 100 s); on a venue relay (--local) it ends the socket of
// a phone that left the hall's Wi-Fi or went to sleep (no close frame), which
// otherwise kept its slot (MAX_CONNECTIONS_PER_IP) and its rooms until TCP
// gave up, minutes or hours later, as the LAN relays do (lanRelayCore).
// Browsers, the desktop apps and the LedBox bridge answer pings on their own.
const roleHeartbeat = realtimeHub ? realtimeHub.heartbeat : createHeartbeat({ intervalMs: 30000 })

// --- Admission of role sockets (audit 2611 SEC-04) ---------------------------
// An idle socket needs no PIN, room or message, and ws answers the heartbeat
// pings by itself: ten address buckets (one IPv6 /56, or ten IPv4 addresses)
// held all MAX_CONNECTIONS slots, and every later scorer, referee and bench
// socket was refused with 1013. Now:
//   - a protected socket is never pushed out (protectedSockets): on the cloud
//     one that proved a room the DATABASE proved (isDbProvedRoom: its owner,
//     a PIN or match token of the match, its scoreboard code), the first
//     ROOM_PROTECTED_OWNERS owners and ROOM_PROTECTED_FOLLOWERS others of
//     each such room. A room nobody's database row proved protects nobody:
//     anyone may sync a made-up room with a game PIN of their choice, and
//     every socket sending that PIN owned it (review of the SEC-04 fix: 2000
//     sockets of one /56 "proved" their own room and held every slot). On a
//     venue relay (no internet callers) any proof counts, as before;
//   - at the total cap the socket that makes room is chosen fairly
//     (roleVictim): among the sockets in no room the relay holds (waiting
//     in a made-up or not yet synced room counts as none) the oldest of the
//     network that holds the most of them, else among all unprotected ones
//     the newest of the network that holds the most. A newcomer of that
//     network itself is refused: a flood never pushes out another
//     network's sockets, and a lone board or tablet of a hall that connected
//     before it stays (review of the SEC-04 fix: the oldest PIN-less board
//     went first). The network: the IPv6 /48, the IPv4 /24 (cloud), else
//     the address bucket. (A hall's unprotected sockets are its PIN-less
//     boards: its scorer, referee and benches proved the match. Only a
//     flood from more networks than the cap holds per hall socket reaches
//     them.);
//   - at the cap of one address bucket or (cloud) one wider network, only a
//     socket in no room the relay holds makes room, else the newcomer is
//     refused, as before the fix;
//   - on the cloud, unprotected sockets count per IPv6 /56 and /48 and per
//     IPv4 /24 too (ROLE_NET_CAPS), as many as one address may hold per /56
//     and twice that per /48 and /24;
//   - while the relay holds more than half its slots, an unprotected socket
//     in no room the relay holds for ROLE_IDLE_MS is closed (a scorer with a
//     match not on the relay yet, a test match, keeps its socket when the
//     relay is not under load).
const ROLE_NET_CAPS = Object.freeze({ v6net56: MAX_CONNECTIONS_PER_IP, v6net48: 2 * MAX_CONNECTIONS_PER_IP, v4net24: 2 * MAX_CONNECTIONS_PER_IP })
const ROLE_IDLE_MS = Number(process.env.OV_ROLE_IDLE_MS) > 0 ? Math.floor(Number(process.env.OV_ROLE_IDLE_MS)) : 60 * 1000
const ROLE_IDLE_LOAD = 0.5
// a socket in no room makes room only once it is this old: a newer one may still be joining
const ROLE_EVICT_MIN_AGE_MS = Math.min(2000, Math.floor(ROLE_IDLE_MS / 4))
// per room the database proved: the sockets its proof protects (a scorer and
// its second device; referee, benches, line judges, boards and their reconnects)
const ROOM_PROTECTED_OWNERS = 4
const ROOM_PROTECTED_FOLLOWERS = 12
let roleEvictions = 0
let roleIdleClosed = 0

/** The wider networks of an address bucket that ROLE_NET_CAPS count (cloud), as [kind, key]. */
function roleNetsOf(ip, ipKey) {
  if (!IS_CLOUD || isLoopbackIp(ip)) return []
  const v6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4})::\/64$/.exec(ipKey)
  if (v6) {
    const net48 = `${v6[1]}:${v6[2]}:${v6[3]}`
    return [['v6net56', `${net48}:${(parseInt(v6[4], 16) & 0xff00).toString(16)}::/56`], ['v6net48', `${net48}::/48`]]
  }
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ipKey)
  return v4 ? [['v4net24', `${v4[1]}.0/24`]] : []
}

/** The network a socket makes room for (roleVictim): the widest of roleNetsOf, else its address bucket. */
function roleGroupOf(ip, ipKey, nets) {
  if (nets.length > 0) return nets[nets.length - 1].join(' ')
  return IS_CLOUD ? ipKey : ip
}

/** Did this socket prove anything: a claim (or one being checked), an accepted PIN or token, a scoreboard code? (venue relay) */
function socketProved(c) {
  if (c.ownedMatches.size > 0 || c.claimCheck || c.codeRooms.size > 0) return true
  for (const a of c.matchAccess.values()) if (a.verified === true || a.token) return true
  return false
}

/** A PIN or match token this socket offered for `matchId` that grants the room now (compared already: nothing counted here). */
function accessProvedRoom(clientInfo, matchId, entry) {
  const a = clientInfo.matchAccess.get(matchId)
  if (!a || !entry?.match) return false
  if (a.token && tokenGrantsRelay(a.token, matchId, entry.match)) return true
  return a.verified === true && !!a.pin && pinGrantsAccess(entry.match, a.pin)
}

/** Is the socket in a room the relay holds (not only waiting for one, or for a made-up id)? */
function inHeldRoom(c) {
  for (const id of c.rooms) if (rooms.get(id)?.clients.has(c.id)) return true
  return false
}

/**
 * The sockets nothing pushes out (see above), as a Set of client ids. The
 * first to prove a room keep its places (connections keeps arrival order).
 */
function protectedSockets() {
  const ids = new Set()
  if (!IS_CLOUD) {
    for (const c of connections.values()) if (!c.gone && socketProved(c)) ids.add(c.id)
    return ids
  }
  if (!DB_MODE) return ids
  const taken = new Map() // matchId -> { owner, follower }
  const take = (c, matchId, kind) => {
    let n = taken.get(matchId)
    if (!n) taken.set(matchId, (n = { owner: 0, follower: 0 }))
    if (n[kind] >= (kind === 'owner' ? ROOM_PROTECTED_OWNERS : ROOM_PROTECTED_FOLLOWERS)) return false
    n[kind]++
    ids.add(c.id)
    return true
  }
  for (const c of connections.values()) {
    if (c.gone) continue
    let done = false
    for (const matchId of c.ownedMatches) {
      if (isDbProvedRoom(activeMatches.get(matchId)) && take(c, matchId, 'owner')) { done = true; break }
    }
    if (done) continue
    for (const matchId of c.codeRooms.keys()) {
      if (isDbProvedRoom(activeMatches.get(matchId)) && take(c, matchId, 'follower')) { done = true; break }
    }
    if (done) continue
    for (const matchId of c.matchAccess.keys()) {
      const entry = activeMatches.get(matchId)
      if (isDbProvedRoom(entry) && accessProvedRoom(c, matchId, entry) && take(c, matchId, 'follower')) break
    }
  }
  return ids
}

/**
 * The network of `pool` holding the most sockets, and its victim (`pick`:
 * 'oldest' or 'newest'), or null when the newcomer's own network would then
 * hold as many or more.
 */
function fairVictim(pool, newcomerGroup, pick) {
  const groups = new Map()
  for (const c of pool) {
    let g = groups.get(c.roleGroup)
    if (!g) groups.set(c.roleGroup, (g = { n: 0, oldest: c, newest: c }))
    g.n++
    g.newest = c // pool keeps arrival order
  }
  let most = null
  for (const g of groups.values()) if (!most || g.n > most.n) most = g
  if (!most) return null
  const own = (groups.get(newcomerGroup)?.n || 0) + 1
  if (own >= most.n) return null
  return pick === 'oldest' ? most.oldest : most.newest
}

/**
 * The socket that makes room for a newcomer of `newcomerGroup` among the
 * unprotected `candidates` (arrival order), or null (the newcomer is
 * refused). `fair` (the total cap): see above; else (one address or network)
 * the oldest socket in no room the relay holds.
 */
function roleVictim(candidates, newcomerGroup, fair) {
  const now = Date.now()
  const idle = candidates.filter((c) => !inHeldRoom(c) && now - c.openedAt >= ROLE_EVICT_MIN_AGE_MS)
  if (!fair) return idle[0] ?? null
  // the idle ones first; when they leave nobody to pick (one parked socket
  // per network), the network holding the most of all
  return (idle.length > 0 ? fairVictim(idle, newcomerGroup, 'oldest') : null) ?? fairVictim(candidates, newcomerGroup, 'newest')
}

/** Close a socket that proved nothing to make room; it leaves the relay's books at once. */
function evictSocket(c, reason) {
  roleEvictions++
  relaySummary.count('pushed out (unprotected, at a cap)')
  try { c.ws.close(1013, reason) } catch { /* already gone */ }
  handleClientDisconnect(c)
}

/**
 * Make room for one more socket under each cap it falls under; a refusal
 * ({ code, reason }) when no socket may make room (see above), else null.
 */
function admitRoleSocket(ip, ipKey, nets) {
  const group = roleGroupOf(ip, ipKey, nets)
  let guarded = null
  const unprotected = (list) => {
    if (!guarded) guarded = protectedSockets()
    return list.filter((c) => !c.gone && !guarded.has(c.id))
  }
  if (connections.size >= MAX_CONNECTIONS) {
    const victim = roleVictim(unprotected([...connections.values()]), group, true)
    if (!victim) return { code: 1013, reason: 'Server connection limit reached' }
    evictSocket(victim, 'Server connection limit reached')
  }
  // a LAN relay counts per address: every tablet of a venue LAN shares one IPv6 /64
  const sameAddress = [...connections.values()].filter((c) => !c.gone && (IS_CLOUD ? c.ipKey === ipKey : c.ip === ip))
  if (sameAddress.length >= MAX_CONNECTIONS_PER_IP) {
    const victim = roleVictim(unprotected(sameAddress), group, false)
    if (!victim) return { code: 1008, reason: 'Too many connections from this IP' }
    evictSocket(victim, 'Too many connections from this IP')
  }
  for (const [kind, key] of nets) {
    const inNet = unprotected([...connections.values()].filter((c) => c.roleNets?.[kind] === key))
    if (inNet.length < ROLE_NET_CAPS[kind]) continue
    const victim = roleVictim(inNet, group, false)
    if (!victim) return { code: 1008, reason: 'Too many connections from this network' }
    evictSocket(victim, 'Too many connections from this network')
  }
  return null
}

// Unprotected sockets in no room the relay holds, closed after ROLE_IDLE_MS
// while the relay is under load (above ROLE_IDLE_LOAD of MAX_CONNECTIONS)
const roleIdleSweep = setInterval(() => {
  if (connections.size <= MAX_CONNECTIONS * ROLE_IDLE_LOAD) return
  const now = Date.now()
  const guarded = protectedSockets()
  const idle = [...connections.values()].filter((c) => !c.gone && !guarded.has(c.id) && now - c.openedAt >= ROLE_IDLE_MS && !inHeldRoom(c))
  for (const c of idle) {
    roleIdleClosed++
    relaySummary.count('closed (idle, under load)')
    try { c.ws.close(1013, 'Idle connection closed, retry shortly') } catch { /* gone */ }
    handleClientDisconnect(c)
  }
}, Math.max(1000, Math.min(30000, Math.floor(ROLE_IDLE_MS / 2))))
roleIdleSweep.unref?.()

wss.on('connection', (ws, req) => {
  if (heapPressure() * 100 >= ADMIT_HEAP_PCT) {
    admissionRefused++
    relaySummary.count('refused (relay busy)')
    ws.close(1013, 'Relay busy, retry shortly')
    return
  }

  const clientId = randomBytes(8).toString('hex')
  const ip = getClientIp(req)
  // Every relay limit (connections, claims, wrong PINs) is keyed on the
  // address bucket: IPv4 as is, IPv6 by /64 (one subscriber holds a whole /64,
  // so a per-address key would be no limit at all).
  const ipKey = ipBucketKey(ip)
  const nets = roleNetsOf(ip, ipKey)

  // The caps: all sockets, per address bucket, per wider network (cloud)
  const refusal = admitRoleSocket(ip, ipKey, nets)
  if (refusal) {
    relaySummary.count('refused (connection caps)')
    ws.close(refusal.code, refusal.reason)
    return
  }

  const clientInfo = {
    ws,
    id: clientId,
    ip,
    ipKey,
    // The room this socket joined or synced last (of `rooms`)
    matchId: null,
    // Room keys this socket is in, or waits for (a match the relay does not
    // hold yet, admitWaiting), oldest first: at most MAX_SOCKET_ROOMS
    rooms: new Set(),
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
    device: null, // subscribe-match label: 'referee' | 'bench' | 'livescore' | 'display'
    deviceTeam: null,
    // A display's announcement (subscribe-match device 'display'):
    // { settingsUrl, at }, settingsUrl already checked (displaySettingsUrl)
    display: null,
    // Room key -> code hash: the rooms this socket follows by a scoreboard code
    codeRooms: new Map(),
    // The installation a scoreboard names in sync-match-data (db/019, the
    // scoring device): its claims are checked against match_scorer_devices
    scorerDevice: null,
    // This socket's window of the frame budget (frameBudget)
    frames: {},
    // { matchId, moved } while a claim's database check runs (verifyRelayClaim)
    claimCheck: null,
    // The wider networks ROLE_NET_CAPS count this socket in (cloud), by kind,
    // and the one it makes room for at the total cap (roleVictim)
    roleNets: Object.fromEntries(nets),
    roleGroup: roleGroupOf(ip, ipKey, nets),
    openedAt: Date.now(),
    // Left the relay's books (closed, or pushed out at a cap: handleClientDisconnect)
    gone: false,
    connectedAt: new Date().toISOString()
  }

  connections.set(clientId, clientInfo)
  roleHeartbeat.track(ws)

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
    // pushed out at a cap or closed as idle: its close is under way
    if (clientInfo.gone) return
    // Per-client WebSocket rate limiting; a scoreboard's bench answers (a
    // socket that owns a match) on their own budget, dropped (not closed)
    // when over it; any other socket keeps the normal limit
    if (clientInfo.ownedMatches.size > 0 && isBenchResponseFrame(data)) {
      if (isWsRateLimited(clientId, benchBudgetKey(clientId), WS_BENCH_RESPONSE_MAX)) {
        relaySummary.count('refused (bench-response budget)')
        return
      }
    } else if (isWsRateLimited(clientId)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }))
      ws.close(1008, 'Rate limit exceeded')
      return
    }
    // The frame's bytes, before anything parses it: a socket that owns no
    // room sends only a few large frames (its claim), one that owns only
    // rooms no database proved a budget per socket and address, see
    // createFrameBudget and frameProofOf
    const frame = frameBudget.check(clientInfo.frames, relayAddressOf(clientInfo), data.length, frameProofOf(clientInfo))
    if (frame !== 'ok') {
      transportRefusals.frames++
      relaySummary.count('refused (frame budget)')
      if (frame === 'close') {
        transportRefusals.socketsClosed++
        ws.close(1009, 'Message too big')
        return
      }
      ws.send(JSON.stringify({ type: 'error', code: 'too-large', message: 'Message too large for the relay' }))
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
    // Refused before it is parsed: more JSON values than any bundle has. Up
    // to the 10 MB frame limit, tiny values parse to over 200 MB of heap.
    if (frameTooLarge(data)) {
      relaySummary.count('refused (too-large)')
      ws.send(JSON.stringify({ type: 'error', code: 'too-large', message: 'Message too large for the relay' }))
      return undefined
    }
    const message = JSON.parse(data.toString())
    // Refused before anything keeps or sends it on: the relay stores what a
    // socket syncs (activeMatches, liveState) and stringifies it for every
    // subscriber and every GET /api/match/:id. JSON.stringify of a value nested
    // a few thousand levels deep throws RangeError, and in the request handler
    // that throw ends the backend.
    if (jsonTooDeep(message)) {
      ws.send(JSON.stringify({ type: 'error', code: 'bad-request', message: 'Message nested too deeply' }))
      return undefined
    }

    // Handle different message types
    switch (message.type) {
      case 'join_match':
        // Client joins a match room
        handleJoinMatch(clientInfo, message)
        sendScorerPresence(clientInfo, normalizeMatchId(message.matchId))
        break

      case 'leave_match':
        // Client leaves match room (the one named, else every one)
        handleLeaveMatch(clientInfo, message.matchId ?? null)
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
        // Scoreboard's computed live-state (same message as the LAN relays).
        // DATABASE_URL mode: also a match_live_state db-change for live
        // subscribers (livescore, scorer alarm), even when HTTP sync is down;
        // not one the relay refused (too large, relay memory full).
        // A test (rehearsal) match stays in the relay's memory: never in the
        // database. So does a Global match and a guest match (the Swiss "New
        // match" signed out): no account, no row, a real match that stays
        // local (frontend domain/matchKind isLocalOnly)
        const roomMatch = activeMatches.get(resolveMatchKey(clientInfo, message.matchId))?.match
        const isTestRoom = relayRoomIsLocal(roomMatch)
        const liveTaken = handleLiveStateUpdate(clientInfo, message)
        // The live screen for TVs (lib/globalLive.js): any match (league,
        // test, Easy, Global; OpenBeach too) whose scorer opted in with a live
        // screen code; the summary only, from the state the relay just took
        // from the room's owner
        if (liveTaken && message.globalLive != null) {
          const liveKey = resolveMatchKey(clientInfo, message.matchId)
          const entry = activeMatches.get(liveKey)
          if (entry?.liveState && clientInfo.ownedMatches?.has(liveKey)) {
            // one court per match whichever way it comes (relay or HTTP push):
            // the match's court token when it sends one, else the room's; one
            // court per room (the store keeps the token a room started with)
            const screen = screenOf(message.globalLiveScreen, entry)
            const listed = message.globalLiveListed === true
            const r = globalLive.put(message.globalLive, isCourtToken(message.globalLiveCourt) ? message.globalLiveCourt : null, entry.liveState, entry, {
              screen, listed, room: liveKey, official: isDbProvedRoom(entry), source: relayAddressOf(clientInfo)
            })
            if (r.ok) forwardGlobalLive(message.globalLive, r.token, entry.liveState, entry, screen, listed)
          }
        }
        if (liveTaken && liveStateRelay && !isTestRoom) {
          // the live subscribers prove no PIN: no covered line-up (relayLiveStateView)
          const liveKey = resolveMatchKey(clientInfo, message.matchId)
          const liveState = relayLiveStateView(message.liveState, null, activeMatches.get(liveKey)?.match, activeMatches.get(liveKey)?.events)
          liveStateRelay.handle(clientInfo, { ...message, matchId: liveKey, liveState }).then((r) => {
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
        // subscribe-match { code }: a scoreboard follows by the scorer's code
        if (message.code !== undefined && message.code !== null && (message.matchId === undefined || message.matchId === null || message.matchId === '')) {
          handleCodeSubscribe(clientInfo, message)
          break
        }
        // Frontend format for joining a match room (used by referee/bench/livescore)
        // Adapt to join_match format
        handleJoinMatch(clientInfo, {
          ...message,
          matchId: message.matchId,
          role: message.role || 'subscriber'
        })
        clientInfo.device = DEVICE_LABELS.includes(message.device) ? message.device : clientInfo.device
        clientInfo.deviceTeam = VALID_TEAMS.includes(message.team) ? message.team : clientInfo.deviceTeam
        sendBenchRequestsOnJoin(clientInfo, normalizeMatchId(message.matchId))
        sendScorerPresence(clientInfo, normalizeMatchId(message.matchId))
        if (message.device === DISPLAY_DEVICE) noteDisplay(clientInfo, message.settingsUrl)
        break

      case 'unsubscribe-match': {
        // One room left, the socket's others kept (the relay livescore
        // follows several matches on one socket), as on the LAN relays
        const key = normalizeMatchId(message.matchId)
        if (key) {
          unfollowDisplayCode(clientInfo, key)
          handleLeaveMatch(clientInfo, key)
        }
        break
      }

      case 'display-code-set':
        handleDisplayCodeSet(clientInfo, message)
        break

      case 'bench-request':
        handleBenchRequest(clientInfo, message)
        break

      case 'bench-response':
        handleBenchResponse(clientInfo, message)
        break

      default:
        console.log(`❓ Unknown message type: ${logValue(message.type)}`)
    }
  } catch (err) {
    // A parse error quotes the frame: its message only, printable
    console.error('❌ Error parsing message:', err instanceof SyntaxError ? sanitizeLog(err.message) : err)
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

  // Update client info (a socket may watch several rooms: the last join names it)
  clientInfo.role = validatedRole
  clientInfo.team = validatedTeam

  // The PIN / token this socket offers for the match (subscribe-match),
  // compared now when the relay holds the match
  registerRelayAccess(clientInfo, matchId, message)
  // A referee or bench role is answered only once its PIN or token was
  // accepted; any other socket is a subscriber (it gets the summary)
  const joinedRole = (validatedRole === 'referee' || validatedRole === 'bench') && !provedRoleOf(clientInfo, matchId) ? 'subscriber' : validatedRole

  // A match the relay does not hold creates no room: the socket waits for
  // it (in its rooms, capped) and is let in by the match's first accepted
  // sync (admitWaiting). Any id used to create a room, so idle sockets
  // filled MAX_ROOMS and no new match got the relay.
  const room = rooms.get(matchId)
  if (!room) {
    rememberRoom(clientInfo, matchId)
    clientInfo.matchId = matchId
    clientInfo.ws.send(JSON.stringify({ type: 'joined_match', matchId, role: joinedRole, roomSize: 0, waiting: true }))
    return
  }
  enterRoom(clientInfo, matchId)

  if (LOG_EACH_CONNECTION) console.log(`🎯 ${clientInfo.id} (${validatedRole}) joined match ${logValue(matchId)} (Room size: ${room.clients.size})`)
  else relaySummary.count('room joins')

  // Notify client
  clientInfo.ws.send(JSON.stringify({
    type: 'joined_match',
    matchId,
    role: joinedRole,
    roomSize: room.clients.size
  }))

  // Initial snapshot, like the LAN relays: late subscribers don't wait for the
  // scoreboard's next sync. PIN-free; the summary unless a PIN was proved.
  const stored = activeMatches.get(matchId)
  if (stored?.match) {
    clientInfo.ws.send(JSON.stringify(matchDataMessage('match-full-data', matchId, stored, undefined, relayViewOfClient(clientInfo, matchId, stored))))
  }

  // Notify other clients in room
  broadcastToRoom(matchId, {
    type: 'client_joined',
    clientId: clientInfo.id,
    role: joinedRole,
    roomSize: room.clients.size
  }, clientInfo.id) // Exclude sender
}

/** Remember `matchId` among the socket's rooms (newest last); over MAX_SOCKET_ROOMS the oldest is left. */
function rememberRoom(clientInfo, matchId) {
  clientInfo.rooms.delete(matchId)
  while (clientInfo.rooms.size >= MAX_SOCKET_ROOMS) leaveRoom(clientInfo, clientInfo.rooms.values().next().value)
  clientInfo.rooms.add(matchId)
}

/** Put the socket in the room of `matchId` (created when the relay has none). */
function enterRoom(clientInfo, matchId) {
  let room = rooms.get(matchId)
  if (!room) {
    room = { matchId, clients: new Set(), createdAt: new Date().toISOString(), lastActivity: Date.now() }
    rooms.set(matchId, room)
  }
  room.clients.add(clientInfo.id)
  room.lastActivity = Date.now()
  rememberRoom(clientInfo, matchId)
  clientInfo.matchId = matchId
  return room
}

/**
 * The first accepted sync of a match created its room: the sockets that
 * subscribed to it before (waiting in their rooms) are let in, each with the
 * snapshot a join gets: the bundle of the view its PIN or token proved
 * (relayViewOfClient), the summary without one. The view, never an access
 * level: matchDataMessage takes any truthy view as a proved one, so 'summary'
 * gave a PIN-less socket access 'full' with the bundle of the bench of
 * neither team, and a referee that waited that bundle instead of its own.
 */
function admitWaiting(matchId) {
  const room = rooms.get(matchId)
  const entry = activeMatches.get(matchId)
  if (!room || !entry?.match) return
  for (const c of connections.values()) {
    if (!c.rooms.has(matchId) || room.clients.has(c.id) || c.ws.readyState !== 1) continue
    room.clients.add(c.id)
    sendToClient(c, matchDataMessage('match-full-data', matchId, entry, undefined, relayViewOfClient(c, matchId, entry)))
    sendBenchRequestsOnJoin(c, matchId)
  }
}

// --- Scorer presence (scorer-presence) ---------------------------------------
// The referee and bench tablets warn when the scorer's device is gone (closed
// laptop, crashed app, lost Wi-Fi): before, they only saw a frozen score.
// Present: an OPEN socket in the room holds the match's claim (proved it with
// an accepted sync, ownedMatches). Told to a socket as the last answer to its
// join (its room waiting: false), and to the room's other sockets when it
// flips (after the sync's match-data-update): the room keeps what they were
// told last (room.scorerPresent), so a sync that changes nothing sends
// nothing. Checked after each change of a room's sockets or claims, never in
// between: a take-over within one sync never reads as gone. A deleted match
// is match-deleted only. No PIN, device or address in it. Same message as the LAN relays
// (lanRelayCore.cjs, src-tauri/src/relay.rs).
const scorerPresenceMessage = (matchId, present) => ({ type: 'scorer-presence', matchId, present, timestamp: Date.now() })

/** Whether an open socket in the room of `matchId` holds its claim. */
function scorerPresentIn(matchId, room = rooms.get(matchId)) {
  if (!room) return false
  for (const id of room.clients) {
    const c = connections.get(id)
    if (c && c.ws.readyState === 1 && c.ownedMatches.has(matchId)) return true
  }
  return false
}

/**
 * A socket that has just joined `matchId` (join_match, subscribe-match): the
 * last answer to the join, after the snapshot and the bench requests. A room
 * the relay does not hold yet has no scorer (the tablet counts from now).
 */
function sendScorerPresence(clientInfo, matchId) {
  if (!matchId || !clientInfo.rooms.has(matchId) || clientInfo.ws.readyState !== 1) return
  sendToClient(clientInfo, scorerPresenceMessage(matchId, scorerPresentIn(matchId)))
}

/** Tell the room's sockets that do not hold its claim when its scorer came or went; nothing when it did not change. */
function updateScorerPresence(matchId) {
  const room = matchId ? rooms.get(matchId) : null
  if (!room) return
  const present = scorerPresentIn(matchId, room)
  if (present === (room.scorerPresent === true)) return
  room.scorerPresent = present
  const data = JSON.stringify(scorerPresenceMessage(matchId, present))
  for (const id of room.clients) {
    const c = connections.get(id)
    if (c && c.ws.readyState === 1 && !c.ownedMatches.has(matchId)) sendToRoomMember(c, data)
  }
}

// --- Scoreboard displays (display-presence, lib/displayPresence.js) ---------
// A display (an LED board's controller) subscribes with device 'display' and
// may name its settings page (settingsUrl, private-LAN http(s) only). The
// match's scorer, and only the scorer (the sockets that proved the match),
// is told whether a display follows and that page: as the answer to its
// first accepted sync on a socket, and when it changes (a display in, out,
// or naming another page). Same message as the LAN relays.
//
// The cloud relay counts a display (and passes its page on) only for a room
// it proved: it follows the room by its scoreboard code, or proved a PIN or
// match token of the match (displayProvedRoom), or it is behind the same
// public address as the room's scorer (displayAtScorersVenue: the hall's
// NAT). Room keys are public there (/api/match/list, the public API): any
// socket naming itself a display set the scorer's "Scoreboard settings" to a
// LAN page of its choice (audit 2611 SEC-45). Point Hub with "OpenVolley
// online" follows the hall's cloud match by itself with no PIN or code
// (followCloudScorer: the match /api/match/list lists to the hall, by the
// same address rule), as the boards in the halls do today: the address rule
// keeps their "Scoreboard settings" row (review of the SEC-45 fix). A venue
// relay keeps the rule of every LAN relay (lanRelayCore, relay.rs): any
// display in the room counts. The scorer's app shows the page's host and
// asks before it opens it, on every relay (the guard against a phone on the
// hall's Wi-Fi).
let displaySeq = 0
const DISPLAY_NEEDS_PROOF = IS_CLOUD

/** A display's subscribe-match: its announcement, for every room it follows. */
function noteDisplay(clientInfo, rawUrl) {
  clientInfo.display = { settingsUrl: displaySettingsUrl(rawUrl), at: ++displaySeq }
  for (const id of clientInfo.rooms) updateDisplayPresence(id)
}

/**
 * Did this socket prove the room of `matchId`? By its scoreboard code
 * (handleCodeSubscribe), the game PIN (ownedMatches), or a PIN or token of
 * the match it offered and the relay accepted: what was compared already,
 * nothing compared or counted here (a PIN offered while the room was not
 * held is compared by admitWaiting, before the scorer is told).
 */
function displayProvedRoom(clientInfo, matchId, entry = activeMatches.get(matchId)) {
  if (clientInfo.codeRooms.has(matchId) || clientInfo.ownedMatches.has(matchId)) return true
  return accessProvedRoom(clientInfo, matchId, entry)
}

/**
 * Is this display behind the same public address (bucket) as a scoring
 * socket of the room (`scorerKeys`: their ipKeys)? The rule of
 * /api/match/list (cloudListsMatch): the venue's own boards behind its NAT.
 */
function displayAtScorersVenue(clientInfo, scorerKeys) {
  return isPublicIp(clientInfo.ip) && scorerKeys.has(clientInfo.ipKey)
}

/** The room's display state: its open display sockets (in it or waiting for it; on the cloud, that proved it or share its scorer's address). */
function displayStateIn(matchId) {
  const displays = []
  const entry = activeMatches.get(matchId)
  let scorerKeys = null
  for (const c of connections.values()) {
    if (!c.display || c.device !== DISPLAY_DEVICE || c.ws.readyState !== 1 || !c.rooms.has(matchId)) continue
    if (DISPLAY_NEEDS_PROOF && !displayProvedRoom(c, matchId, entry)) {
      if (!scorerKeys) scorerKeys = new Set(ownersOf(matchId).map((o) => o.ipKey))
      if (!displayAtScorersVenue(c, scorerKeys)) continue
    }
    displays.push(c.display)
  }
  return displayStateOf(displays)
}

/** display-presence to one socket that has just proved the match. */
function sendDisplayPresence(clientInfo, matchId) {
  const state = displayStateIn(matchId)
  const room = rooms.get(matchId)
  if (room) room.displayTold = displayStateKey(state)
  sendToClient(clientInfo, displayPresenceMessage(matchId, state))
}

/** Tell the room's scorer sockets when its display state changed; nothing when it did not. */
function updateDisplayPresence(matchId) {
  const room = matchId ? rooms.get(matchId) : null
  if (!room) return
  const state = displayStateIn(matchId)
  const key = displayStateKey(state)
  if (key === (room.displayTold ?? '0')) return
  room.displayTold = key
  const data = JSON.stringify(displayPresenceMessage(matchId, state))
  for (const c of matchOwners(matchId)) sendToRoomMember(c, data)
}

// --- Scoreboard codes (lib/displayCodes.js, docs/scoreboard-code-spec.md) ----
// Same messages as the LAN relays: display-code-set from the room's scorer
// socket (answered with display-code-state, never the code), subscribe-match
// { code } from a board (display-code, then the PIN-less summary: the public
// live state only), and display-code ended when the code ends.

function handleDisplayCodeSet(clientInfo, message) {
  const key = resolveMatchKey(clientInfo, message.matchId)
  const matchId = key || normalizeMatchId(message.matchId)
  if (!key || !clientInfo.ownedMatches.has(key)) {
    sendToClient(clientInfo, codeStateMessage(matchId, { ok: false, reason: 'not-match-owner' }))
    return
  }
  const r = displayCodes.set({ room: key, code: message.code, issuedAt: message.issuedAt, owner: clientInfo.id })
  sendToClient(clientInfo, codeStateMessage(key, r))
}

function handleCodeSubscribe(clientInfo, message) {
  const r = displayCodes.resolve(message.code, { ipKey: clientInfo.ipKey || clientInfo.ip || `ws:${clientInfo.id}` })
  sendToClient(clientInfo, codeAnswerMessage(r))
  if (!r.ok) return
  const before = clientInfo.codeRooms.get(r.room)
  if (before && before !== r.hash) displayCodeFollowers.get(before)?.delete(clientInfo.id)
  clientInfo.codeRooms.set(r.room, r.hash)
  if (!displayCodeFollowers.has(r.hash)) displayCodeFollowers.set(r.hash, new Set())
  displayCodeFollowers.get(r.hash).add(clientInfo.id)
  // as a PIN-less display subscribing to the room: never a PIN or token next to a code
  handleJoinMatch(clientInfo, { matchId: r.room, role: 'subscriber' })
  clientInfo.device = DISPLAY_DEVICE
  sendBenchRequestsOnJoin(clientInfo, r.room)
  sendScorerPresence(clientInfo, r.room)
  noteDisplay(clientInfo, message.settingsUrl)
}

/** The socket no longer follows `room` by a code (it left, or the socket closed). */
function unfollowDisplayCode(clientInfo, room) {
  const hash = clientInfo.codeRooms.get(room)
  if (!hash) return
  clientInfo.codeRooms.delete(room)
  const set = displayCodeFollowers.get(hash)
  if (!set) return
  set.delete(clientInfo.id)
  if (set.size === 0) displayCodeFollowers.delete(hash)
}

/** A code ended (replaced, revoked, expired, its room dropped): its boards are told and leave the room. */
function onDisplayCodeEnd(room, hash, reason) {
  const ids = displayCodeFollowers.get(hash)
  displayCodeFollowers.delete(hash)
  for (const id of ids || []) {
    const c = connections.get(id)
    if (!c || c.codeRooms.get(room) !== hash) continue
    c.codeRooms.delete(room)
    if (c.ws.readyState === 1) sendToClient(c, codeEndedMessage(room))
    if (c.rooms.has(room)) leaveRoom(c, room)
  }
  // run out: the scorer's sockets hear it (a revoke or a new code was answered already)
  if (reason === 'expired') for (const c of matchOwners(room)) sendToClient(c, codeStateMessage(room, { ok: false, reason: 'expired' }))
}

/**
 * The role a socket proved for the match with that role's PIN or match token,
 * for the scorer's tablet status: { role: 'referee' | 'bench', team }, else
 * null. The roles the bench requests take (relayRoleOf), comparing nothing
 * new: a PIN not checked yet (offered before the match reached the relay)
 * counts as none. A socket's own label (join_match role, subscribe-match
 * device) proves nothing, nor does the game PIN (the scorer's own devices).
 */
function provedRoleOf(clientInfo, matchId, entry = activeMatches.get(matchId)) {
  const role = relayRoleOf(clientInfo, matchId, entry, { compare: false })
  if (role === 'referee') return { role: 'referee', team: null }
  return role === 'home' || role === 'away' ? { role: 'bench', team: role } : null
}

// --- PIN-proved relay access (lib/matchAccess.js) ---------------------------
// Every PIN the relay compares for a caller (subscribe-match / join_match pin,
// a scoreboard's game-PIN claim) is limited twice: per socket (5 wrong PINs a
// minute) and in the brute-force budget of the HTTP PIN checks
// (pinFailureLimiter: 20 wrong PINs per 10 minutes per address bucket, IPv6 by
// /64, and scope: that match's PINs, or its game PIN for a claim; 60 per
// address bucket in all; per match and PIN type per address range). Over
// either limit nothing is compared (no guessing oracle).
const RELAY_PIN_FAILURE_LIMIT = 5
const MAX_ACCESS_KEYS = 16

/**
 * The PIN types pinGrantsAccess compares for a relayed match, and those of
 * them not locked for the caller's address range (pinFailureLimiter; all of
 * them for a check the server trusts beyond the PIN, `scopeOnly`): a locked
 * type is left out of the comparison, the right PIN of another type still
 * opens the match, and a wrong PIN counts against each type it was compared
 * with.
 * @returns {{ any: boolean, open: string[] }} any: the match has a PIN at all
 */
function relayPinTypes(matchId, entry, ipKey, { scopeOnly = false } = {}) {
  const types = [...new Set(relayPinsByType(entry?.match, { sport: entry?.sportType }).map(([type]) => type))]
  return { any: types.length > 0, open: scopeOnly ? types : pinFailureLimiter.openKinds(matchId, types, ipKey) }
}

/**
 * A PIN offered for a relayed match on an HTTP read (GET /api/match/:id,
 * /api/server/connections), counted in pinFailureLimiter: 'ok', 'wrong', or
 * 'rate-limited' (nothing compared: the address's budget, or every PIN type
 * of the match locked for the caller's address range).
 */
function relayPinCheck(ipKey, matchId, entry, pin) {
  const { any, open } = relayPinTypes(matchId, entry, ipKey)
  const scope = pinScope.match(matchId)
  if ((any && open.length === 0) || pinFailureLimiter.isLimited(ipKey, scope, { kinds: open })) return 'rate-limited'
  if (pinTypeOf(entry?.match, pin, { sport: entry?.sportType, types: open }) === null) {
    // A tablet polling with a PIN the scorer has changed since: the same
    // wrong PIN again is no new guess
    pinFailureLimiter.repeated(ipKey, scope, String(pin).trim(), { kinds: open })
    return 'wrong'
  }
  pinFailureLimiter.refund(ipKey, scope, { kinds: open })
  return 'ok'
}

/**
 * relayPinAttempt of a PIN offered for a relayed match's access
 * (subscribe-match), by its PIN types. The room's own scoring device (a
 * socket that synced the room as its scorer, isRoomScorer) is trusted beyond
 * the PIN: counted in the match's scope only, never refused by a lock of its
 * address range (scopeOnly, as its scoreboard claim). A match token never
 * gets here (registerRelayAccess takes it without a PIN).
 */
function relayAccessAttempt(clientInfo, matchId, entry, pin) {
  const scopeOnly = isRoomScorer(entry, clientInfo.scorerDevice ? { id: clientInfo.scorerDevice } : null)
  const { any, open } = relayPinTypes(matchId, entry, clientInfo.ipKey, { scopeOnly })
  if (any && open.length === 0) return 'rate-limited'
  return relayPinAttempt(clientInfo, pinScope.match(matchId), () => pinTypeOf(entry.match, pin, { sport: entry.sportType, types: open }) !== null, { kinds: open, pin, scopeOnly })
}

/**
 * One counted PIN comparison for this socket.
 * @param {string} scope pinScope of what compare() compares against
 * @param {() => boolean} compare
 * @param {{ scopeOnly?: boolean, kinds?: string[], across?: string[][], pin?: string }} [budget]
 *   scopeOnly: the address's ceiling and the counts across callers are left
 *   out (pinFailureLimiter; the match's own scorer device, see
 *   verifyRelayClaim); kinds: the PIN types compare() compares, for a scope
 *   of all the match's PINs; across: the [match, PIN type] pairs compare()
 *   compares, counted across callers in place of the scope's (database rows,
 *   verifyRelayClaim); pin: the PIN compared (the same wrong PIN again from
 *   the address is no new guess for the budget, pinFailureLimiter.repeated)
 * @returns {'ok'|'wrong'|'rate-limited'}
 */
function relayPinAttempt(clientInfo, scope, compare, budget = {}) {
  const wsKey = `pin-ws:${clientInfo.id}`
  if ((windowEntry(claimFailures, wsKey)?.count || 0) >= RELAY_PIN_FAILURE_LIMIT) return 'rate-limited'
  // isLimited counts the attempt up front; a right PIN is refunded
  if (pinFailureLimiter.isLimited(clientInfo.ipKey, scope, budget)) return 'rate-limited'
  if (compare()) {
    pinFailureLimiter.refund(clientInfo.ipKey, scope, budget)
    return 'ok'
  }
  if (budget.pin != null) pinFailureLimiter.repeated(clientInfo.ipKey, scope, String(budget.pin).trim(), budget)
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
/** matches.connection_pins of one match (stored form), for a token's PIN check; null when unreadable. */
async function connectionPinsOf(layer, matchUuid) {
  try {
    const { status, body } = await layer.db.runQuery({
      table: 'matches',
      action: 'select',
      params: { columns: 'connection_pins', filters: [{ type: 'eq', column: 'id', value: matchUuid }] }
    }, { internal: true, maxRows: 1 })
    const row = status === 200 && Array.isArray(body?.data) ? body.data[0] : null
    return row?.connection_pins && typeof row.connection_pins === 'object' ? row.connection_pins : null
  } catch {
    return null
  }
}

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
    noteRelayAccessProof(clientInfo, matchId, entry, { token })
    return
  }
  if (!pin) {
    clientInfo.ws.send(JSON.stringify({ type: 'error', code: 'access-denied', message: 'This match token is not valid (any more): check the PIN again', matchId }))
    return
  }
  if (entry?.match) {
    const r = relayAccessAttempt(clientInfo, matchId, entry, pin)
    if (r === 'rate-limited') {
      clientInfo.ws.send(JSON.stringify({ type: 'error', code: 'rate-limited', message: 'Too many wrong PINs. Wait a few minutes.', matchId }))
      return
    }
    if (r === 'wrong') {
      clientInfo.ws.send(JSON.stringify({ type: 'error', code: 'pin-invalid', message: 'Wrong PIN for this match', matchId }))
      return
    }
    remember({ pin, verified: true })
    noteRelayAccessProof(clientInfo, matchId, entry, { pin })
  } else {
    remember({ pin, verified: false })
  }
}

/**
 * A role socket's PIN or token the relay accepted for a room the database
 * proved (cloud): its address proved the match rows the room is bound to
 * (entry.dbRows), for the live hub's token-less rule (liveRowGranted). The
 * game PIN (the scorer's devices) names no live-state role.
 */
function noteRelayAccessProof(clientInfo, matchId, entry, { token = null, pin = null }) {
  if (!isDbProvedRoom(entry) || !entry?.match) return
  const payload = token ? matchTokens.verify(token) : null
  if (payload?.u) {
    noteAddressProof(clientInfo.ipKey, payload)
    return
  }
  const role = payload ? payload.r : pinTypeOf(entry.match, pin, { sport: entry.sportType })
  const bound = entry.dbRows
  if (!isTokenRole(role) || !bound || bound.pin !== gamePinOf(entry.match)) return
  for (const id of bound.ids) noteAddressProof(clientInfo.ipKey, { u: id, r: role, m: String(matchId) })
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
    const r = relayAccessAttempt(clientInfo, matchId, entry, a.pin)
    if (r === 'ok') {
      a.verified = true
      a.token = null
      noteRelayAccessProof(clientInfo, matchId, entry, { pin: a.pin })
      return true
    }
    clientInfo.matchAccess.delete(matchId)
    if (r === 'rate-limited' && clientInfo.ws.readyState === 1) {
      clientInfo.ws.send(JSON.stringify({ type: 'error', code: 'rate-limited', message: 'Too many wrong PINs. Wait a few minutes.', matchId }))
    }
  }
  return false
}

/**
 * The bundle this socket gets (lib/publicColumns.js relayBundleView): 'scorer'
 * (it owns the room, or proved the game PIN: the scorer's own devices),
 * 'referee', 'home' / 'away' (that bench), or null: the summary (no PIN proved).
 */
function relayViewOfClient(clientInfo, matchId, entry) {
  if (!hasRelayAccess(clientInfo, matchId, entry)) return null
  if (clientInfo.ownedMatches.has(matchId)) return 'scorer'
  const a = clientInfo.matchAccess.get(matchId)
  if (a?.token && tokenGrantsRelay(a.token, matchId, entry?.match)) return relayViewOf(matchTokens.verify(a.token)?.r)
  if (a?.pin) return relayViewOf(pinTypeOf(entry?.match, a.pin, { sport: entry?.sportType }))
  return null
}

// A room member whose unsent data is above this when a bundle or action is to
// go out is dropped: it reconnects and gets the latest bundle, which carries
// the whole match. A tablet that stopped reading (a dead Wi-Fi link the
// heartbeat has not caught yet) otherwise kept every bundle queued in the
// backend's memory. The live hub drops its sockets at 256 KB; a bundle late
// in a match is about 250 KB, so 1 MB is a tablet several syncs behind.
const ROLE_MAX_BUFFERED_BYTES = 1024 * 1024

/** Send `data` to a room member; false when it was dropped as too slow (see above). */
function sendToRoomMember(clientInfo, data) {
  const ws = clientInfo.ws
  if (ws.bufferedAmount > ROLE_MAX_BUFFERED_BYTES) {
    relaySummary.count('slow sockets dropped')
    ws.terminate()
    return false
  }
  ws.send(data)
  return true
}

/** match-full-data / match-data-update to a room: each socket its view or the summary. */
function broadcastMatchData(matchId, type, entry, scoreboardTs, excludeClientId = null, extra = {}) {
  const room = rooms.get(normalizeMatchId(matchId))
  if (!room || !entry) return
  // one serialisation per view ('' is the summary)
  const byView = new Map()
  let sent = 0
  room.clients.forEach((clientId) => {
    if (clientId === excludeClientId) return
    const clientInfo = connections.get(clientId)
    if (!clientInfo || clientInfo.ws.readyState !== 1) return
    const view = relayViewOfClient(clientInfo, matchId, entry) || ''
    let data = byView.get(view)
    if (data === undefined) {
      data = JSON.stringify({ ...matchDataMessage(type, matchId, entry, scoreboardTs, view || null), ...extra })
      byView.set(view, data)
    }
    if (sendToRoomMember(clientInfo, data)) sent++
  })
  if (LOG_EACH_CONNECTION) console.log(`📡 Match data to ${sent} clients in room ${logValue(matchId)}`)
}

// 'scoreboard' is never accepted from a join message
function joinRole(requested) {
  return requested === 'scoreboard' ? 'subscriber' : requested
}

// Handle client leaving match room: the one named (unsubscribe-match,
// leave_match { matchId }), else every room the socket is in or waits for
function handleLeaveMatch(clientInfo, rawId = null) {
  const key = rawId === null ? null : resolveMatchKey(clientInfo, rawId)
  if (rawId !== null && !key) return
  for (const id of key ? [key] : [...clientInfo.rooms]) leaveRoom(clientInfo, id)
  if (clientInfo.rooms.size === 0) {
    clientInfo.matchId = null
    clientInfo.role = null
  }
}

/** Take the socket out of one room; the room's last socket out holds its claim (holdRoom). */
function leaveRoom(clientInfo, matchId) {
  forgetRoom(clientInfo, matchId)
  const room = rooms.get(matchId)
  if (!room || !room.clients.delete(clientInfo.id)) return

  if (LOG_EACH_CONNECTION) console.log(`👋 ${clientInfo.id} left match ${logValue(matchId)} (Room size: ${room.clients.size})`)
  else relaySummary.count('room leaves')

  // Notify other clients
  broadcastToRoom(matchId, {
    type: 'client_left',
    clientId: clientInfo.id,
    role: clientInfo.role,
    roomSize: room.clients.size
  }, clientInfo.id)

  // The scorer's last socket out: its tablets are told (scorer-presence)
  if (room.clients.size > 0) updateScorerPresence(matchId)
  // A display out: the scorer is told (display-presence)
  if (clientInfo.display) updateDisplayPresence(matchId)

  // Clean up empty room
  if (room.clients.size === 0) {
    holdRoom(matchId)
    if (LOG_EACH_CONNECTION) console.log(`🗑️  Empty room deleted: ${logValue(matchId)} (its claim is held for the take-over grace)`)
    else relaySummary.count('empty rooms deleted')
  }
}

/** The socket's own record of a room it is no longer in or waiting for. */
function forgetRoom(clientInfo, matchId) {
  clientInfo.rooms.delete(matchId)
  if (clientInfo.matchId === matchId) clientInfo.matchId = [...clientInfo.rooms].pop() ?? null
}

/**
 * A room emptied (its last socket left): its stored match goes, but the
 * claim on its key (the PINs, the scoring device and its take-overs, the
 * owners, its open bench requests) is held for the take-over grace
 * (heldRoomOf): a first sync of the key must carry the stored game PIN as a
 * sync of the held room had to. The relay used to drop both at once, so the
 * next sync without any PIN owned the key, and the scorer coming back with
 * the right PIN was refused. After the grace (counted from when the room's
 * last scoreboard went, else from now) everything goes together
 * (releaseRoomClaim). The bundle itself is not kept: its memory is given back
 * at once.
 */
function holdRoom(matchId) {
  const entry = activeMatches.get(matchId)
  rooms.delete(matchId)
  activeMatches.delete(matchId)
  heldRooms.delete(matchId)
  if (!entry?.match) {
    releaseRoomClaim(matchId)
    return
  }
  makeHeldRoom(entry.relayNet ?? null)
  const match = { status: entry.match.status }
  for (const k of MATCH_SECRET_FIELDS) if (entry.match[k] !== undefined) match[k] = entry.match[k]
  // whether it is a local-only room (relayRoomIsLocal): its claims are not
  // proved by a database row (verifyRelayClaim)
  for (const k of ['test', 'global', 'guest']) if (entry.match[k] === true) match[k] = true
  heldRooms.set(matchId, {
    matchId,
    since: entry.orphanedAt ?? Date.now(),
    match,
    firstSyncAt: entry.firstSyncAt ?? null,
    sportType: entry.sportType,
    scorerDevice: entry.scorerDevice,
    scorerClaim: entry.scorerClaim,
    movedClaims: entry.movedClaims,
    supersededClaims: entry.supersededClaims,
    dbRows: entry.dbRows,
    relayAddress: entry.relayAddress,
    relayNet: entry.relayNet ?? null,
    relayOfficial: entry.relayOfficial
  })
}

/**
 * Room in heldRooms for one more claim of `net` (relayNetOf): one address
 * keeps at most MAX_ROOMS_PER_ADDRESS held claims (over it, its own oldest
 * goes, a lapsed one first), the relay MAX_HELD_ROOMS (over it, the oldest
 * of the address holding the most). The oldest of all used to go, so the
 * rooms other addresses synced and left pushed a scorer's claim out within
 * its grace, and a sync without its game PIN owned the key.
 */
function makeHeldRoom(net) {
  const byNet = new Map()
  for (const h of heldRooms.values()) {
    const list = byNet.get(h.relayNet) ?? []
    list.push(h)
    byNet.set(h.relayNet, list)
  }
  const oldest = (list) => list.find((h) => h.lapsed) ?? list[0]
  const own = net !== null ? byNet.get(net) : null
  if (own && own.length >= MAX_ROOMS_PER_ADDRESS) {
    releaseHeld(oldest(own))
  } else if (heldRooms.size >= MAX_HELD_ROOMS) {
    let most = null
    for (const list of byNet.values()) if (!most || list.length > most.length) most = list
    releaseHeld(oldest(most))
  }
}

/** Release one held claim: a lapsed one is only forgotten (its claim went with its grace). */
function releaseHeld(held) {
  if (held.lapsed) heldRooms.delete(held.matchId)
  else releaseRoomClaim(held.matchId)
}

/**
 * The held claim of an emptied room (holdRoom) while its grace runs, else
 * null. Once the grace is over the claim goes (releaseRoomClaim): the key is
 * new to the next sync. Of a match still in play with a game PIN the scorer
 * was gone too long for, that PIN is kept (a lapsed entry, for ROOM_TTL_MS):
 * the next claim takes the key, but the scorer may reclaim it once with its
 * own PIN (handleSyncMatchData moves it to displacedPins), as after a stale
 * take-over of a room a tablet kept open. The next sync without any PIN used
 * to own the key for good, the scorer back with the right PIN refused.
 */
function heldRoomOf(matchId) {
  const held = heldRooms.get(matchId)
  if (!held || held.lapsed) return null
  const finished = isFinishedMatch(held.match)
  if (Date.now() - held.since < (finished ? ORPHAN_TAKEOVER_MS : STALE_TAKEOVER_MS)) return held
  const pin = finished ? null : gamePinOf(held.match)
  releaseRoomClaim(matchId)
  if (pin !== null) heldRooms.set(matchId, { matchId, lapsed: true, pin, since: Date.now(), relayNet: held.relayNet })
  return null
}

/** The held claims whose grace is over go (heldRoomOf), lapsed ones after ROOM_TTL_MS. */
function sweepHeldRooms() {
  const now = Date.now()
  for (const held of [...heldRooms.values()]) {
    if (!held.lapsed) heldRoomOf(held.matchId)
    else if (now - held.since >= ROOM_TTL_MS) heldRooms.delete(held.matchId)
  }
}

/**
 * The end of a room key's claim, whatever ended it (the grace of an emptied
 * room, delete-match, the TTL sweep): no socket owns the key any more, its
 * bench requests and displaced PIN go. Ownership used to outlive the room, so
 * an earlier owner kept speaking for the key next to the scorer who created
 * the room again, and the next owner was sent the benches' open requests.
 */
function releaseRoomClaim(matchId) {
  // its scoreboard code ends with it (the boards that followed by it are told)
  displayCodes.dropRoom(matchId)
  heldRooms.delete(matchId)
  displacedPins.delete(matchId)
  benchRequests.drop(matchId)
  for (const c of connections.values()) c.ownedMatches.delete(matchId)
}

/** Drop a room with its stored match and its claim at once (delete-match, the TTL sweep). */
function dropRoom(matchId) {
  const room = rooms.get(matchId)
  if (room) {
    for (const id of room.clients) {
      const member = connections.get(id)
      if (member) forgetRoom(member, matchId)
    }
  }
  rooms.delete(matchId)
  activeMatches.delete(matchId)
  releaseRoomClaim(matchId)
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

  if (LOG_EACH_CONNECTION) console.log(`📤 Match update broadcasted to room ${logValue(matchId)}`)
  else relaySummary.count('match updates broadcast')
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

  if (LOG_EACH_CONNECTION) console.log(`⚡ Action broadcasted to room ${logValue(matchId)}: ${logValue(action.type)}`)
  else relaySummary.count('actions broadcast')
}

// Handle client disconnect (once: a socket pushed out at a cap left the books before its close event)
function handleClientDisconnect(clientInfo) {
  if (clientInfo.gone) return
  clientInfo.gone = true
  // Matches no other connected socket owns become claimable after a grace period
  for (const matchId of clientInfo.ownedMatches) {
    const entry = activeMatches.get(matchId)
    const stillOwned = [...connections.values()].some(c => c !== clientInfo && c.ownedMatches.has(matchId))
    if (entry && !stillOwned) entry.orphanedAt = Date.now()
  }
  for (const room of [...clientInfo.codeRooms.keys()]) unfollowDisplayCode(clientInfo, room)
  handleLeaveMatch(clientInfo)
  connections.delete(clientInfo.id)
  wsRateLimitMap.delete(clientInfo.id)
  wsRateLimitMap.delete(benchBudgetKey(clientInfo.id))
  benchRequestLimiter.forget(clientInfo.id)
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

// PERM-01 (audit 2611): the origin of a room key on the cloud relay: the game
// PIN and the scoring device (db/019 device id, never broadcast) of the key's
// first granted sync, kept ROOM_TTL_MS after the key's last sync, through
// take-overs and past the end of a held claim (its grace, its lapse). A new
// matches row under the key needs this PIN, or comes without a PIN from this
// device (newRowRoomRefusal). The room's current PIN was not enough: past the grace
// (60 s for a finished match) any socket takes the key over with a PIN of its
// own, or the finished match's claim is simply gone, and the scorer's pending
// first insert was refused, or anyone's went through. The relay's memory: a
// restart forgets every origin; over ROOM_ORIGIN_MAX the longest idle go.
const ROOM_ORIGIN_MAX = 50000
const roomOrigins = new Map() // matchId -> { pin, device, seenAt }, the longest idle first

function roomOriginOf(matchId) {
  const o = roomOrigins.get(matchId)
  if (!o) return null
  if (Date.now() - o.seenAt < ROOM_TTL_MS) return o
  roomOrigins.delete(matchId)
  return null
}

/** The origins idle past ROOM_TTL_MS go (the map is kept longest idle first). */
function sweepRoomOrigins() {
  const now = Date.now()
  for (const [matchId, o] of roomOrigins) {
    if (now - o.seenAt < ROOM_TTL_MS) break
    roomOrigins.delete(matchId)
  }
}

/**
 * A granted sync of `matchId` (handleSyncMatchData, `kind` claimMatch's): the
 * key's first one records its origin, with the PIN a take-over displaced
 * when there is one (the PIN the relay still lets reclaim the key); every
 * later one keeps it ROOM_TTL_MS longer. Only the first one's own line fills
 * in what it lacked: the game PIN its owner attached afterwards (a match
 * created before Save), the device a sync proving that PIN names.
 */
function noteRoomOrigin(matchId, kind, pin, deviceId) {
  if (!DB_MODE) return
  const now = Date.now()
  let o = roomOriginOf(matchId)
  if (o) {
    roomOrigins.delete(matchId) // set again as the newest
    if (kind === 'owner' && o.pin === null && pin !== null) o.pin = pin
    if ((kind === 'owner' || kind === 'proved') && o.device === null && deviceId !== null &&
        o.pin !== null && pin !== null && safeEqualStr(pin, o.pin)) o.device = deviceId
    o.seenAt = now
  } else {
    while (roomOrigins.size >= ROOM_ORIGIN_MAX) roomOrigins.delete(roomOrigins.keys().next().value)
    const displaced = displacedPins.get(matchId)
    o = displaced !== undefined
      ? { pin: displaced, device: null, seenAt: now }
      : { pin, device: deviceId, seenAt: now }
  }
  roomOrigins.set(matchId, o)
}

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
 * - a match new to the relay is claimed by its first scoreboard (a room that
 *   emptied within the take-over grace is not new: heldRoomOf);
 * - a stored match with a game PIN requires the same PIN;
 * - a stored match without one (test match) may be written by anyone, but only
 *   an existing owner may attach a game PIN to it;
 * - a match nobody has owned for ORPHAN_TAKEOVER_MS (finished) or
 *   STALE_TAKEOVER_MS (in play) may be taken over; an unfinished one taken
 *   over with another PIN may be reclaimed once by its own PIN.
 * A socket that never proved the match and leaves the game PIN out is asked
 * for it ('pins-required'): the scorer's sync after a reconnect or relay
 * restart, not a guess, so it is not counted.
 * Wrong-PIN claims are limited per socket and in the brute-force budget of the
 * HTTP PIN checks (pinFailureLimiter, per address bucket and this match's
 * game-PIN scope: other devices' typos behind the same venue NAT never stop a
 * scoreboard re-proving its own match); over either limit a claim needing
 * proof is refused BEFORE the PIN is compared (no guessing oracle). A granted
 * claim is refunded.
 * opts.dbProved: the game PIN was just proved against the match's database
 * row (cloud, see verifyRelayClaim): the database is the authority, so a relay
 * copy held under another PIN (a squatter) is reclaimed. opts.knownScorer:
 * and by the device the database names as the match's scorer: its claim is
 * counted in the match's scope only, not in the address's ceiling nor across
 * callers; the same for the room's own scoring device (opts.device,
 * isRoomScorer).
 */
function claimMatch(clientInfo, matchId, incomingMatch, opts = {}) {
  // The stored match, else the held claim of a room that emptied (holdRoom):
  // the same rules, PINs and scoring device
  const existing = activeMatches.get(matchId) || heldRoomOf(matchId)
  const wasOwner = clientInfo.ownedMatches.has(matchId)
  const incomingPin = gamePinOf(incomingMatch)
  const grant = (kind) => ({ ok: true, kind })
  const denyNew = () => (wasOwner ? null : newClaimDenied(clientInfo, matchId))

  if (!existing || !existing.match) {
    const denied = denyNew()
    if (denied) return { ok: false, code: denied }
    // The database proved this claim: no earlier socket speaks for the key
    // next to it, as on a reclaim
    if (opts.dbProved && incomingPin !== null) {
      displacedPins.delete(matchId)
      for (const c of connections.values()) if (c !== clientInfo) c.ownedMatches.delete(matchId)
    }
    return grant(wasOwner ? 'owner' : 'new')
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
  const scope = pinScope.match(matchId, 'game')
  const budget = { scopeOnly: opts.knownScorer === true || isRoomScorer(existing, opts.device) }
  if (counted && pinFailureLimiter.isLimited(clientInfo.ipKey, scope, budget)) return { ok: false, code: 'rate-limited' }
  const refund = () => { if (counted) pinFailureLimiter.refund(clientInfo.ipKey, scope, budget) }
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
 * match uuid the live-state relay would publish to, matchKeyFromSyncedMatch),
 * the synced game PIN must be that one. A wrong PIN is a counted guess
 * (relayPinAttempt). A match not in the database, or stored without a game
 * PIN, is left to the relay's own rules. A database error refuses the claim
 * ('claim-unverified', the app syncs again): it used to let it through, and a
 * sync could make the lookup fail on purpose (a NUL in its seed key) and take
 * a match's room without its game PIN. The seed key is never looked up: it is
 * the room key (relayKeyOf; one the relay cannot take is refused, badSeedKey).
 *
 * `device` (db/019): the installation the sync names. The game PIN is known
 * to every device the match was ever scored on, so it cannot tell the scorer
 * from the device it left: a laptop that comes back online after the match
 * was continued on a phone re-syncs its older copy at once, before its app
 * has heard of the move, and the referee and benches jumped back to it
 * (stress test 2026-10-25). A device the database does not name as the
 * match's scorer is refused ('scorer-moved'), as its HTTP writes are (409
 * OV_SCORER_MOVED). A sync that names no device (an older app) is not checked.
 * The device the database does name as the scorer is re-proving its own
 * match (a reconnect, a relay restart): its game PIN is counted in that
 * match's scope only, not in the address's ceiling across all PINs
 * (pinFailureLimiter scopeOnly). Behind a venue NAT the hall's wrong PINs for
 * other matches and PIN types used to spend that ceiling, and the
 * scoreboard's re-claim was then refused for 10 minutes (its referee and
 * benches froze). A guesser does not know the scorer's device id (it is never
 * broadcast) and still has the scope's limit.
 * The comparison is counted under the matches whose game PIN it compares (the
 * rows found, dbPinKey), never under the room key: the caller picks that
 * (seed_key), and a fresh one each time passed the per-match lock and added
 * a key of its own to the budget's table. The room is then bound to the rows
 * (`dbRows`, bindRoomRows).
 * @returns {Promise<{ ok: true, dbProved: boolean, knownScorer: boolean, dbRows: string[] } | { ok: false, code: string }>}
 */
async function verifyRelayClaim(clientInfo, matchId, match, device = null) {
  // PERM-01 (audit 2611): any account may insert a test match under any free
  // external_id, and room keys are public (/api/match/list). A row filed
  // under the key of a room that never reaches the database (a guest,
  // Global or test match) "proved" the filer's game PIN: the room's scorer
  // was refused and evicted (claimMatch's dbProved reclaim). A local-only
  // room claimed as a local-only match is the relay's alone (its owner and
  // game PIN), with no database lookup. A claim of it as an official match
  // is still looked up, but a test row never proves a claim (test matches
  // are local-only), nor, for a local-only room, a row created since the
  // relay first held the key: that room's match is never in the database,
  // so such a row is someone else's. A new row under a key the relay knows
  // needs the key's first game PIN anyway (newRowRoomRefusal).
  const room = activeMatches.get(matchId) || heldRoomOf(matchId)
  const localRoom = !!room?.match && relayRoomIsLocal(room.match)
  if (localRoom && relayRoomIsLocal(match)) return { ok: true, dbProved: false, knownScorer: false, dbRows: [] }
  const keys = [{ column: 'external_id', value: matchId }]
  const synced = matchKeyFromSyncedMatch(match)
  if (synced?.column === 'id') keys.push(synced)
  let layer
  let rows
  try {
    layer = await getDataLayer()
    rows = await Promise.all(keys.map(async (key) => {
      const r = await layer.db.runQuery({
        table: 'matches',
        action: 'select',
        params: { columns: 'id, external_id, game_pin, test, created_at', filters: [{ type: 'eq', column: key.column, value: key.value }], limit: 1 }
      }, { internal: true })
      if (r.body.error) throw new Error(r.body.error.code || 'lookup failed')
      return r.body.data?.[0] || null
    }))
  } catch (err) {
    console.warn('[relay] database check of a scoreboard claim failed (refused, the scoreboard syncs again):', err?.message)
    return { ok: false, code: 'claim-unverified' }
  }
  const newerThanRoom = (r) => localRoom && room.firstSyncAt != null && r.created_at != null &&
    new Date(r.created_at).getTime() >= room.firstSyncAt
  const known = rows.filter((r) => r && r.id != null && r.test !== true && !newerThanRoom(r))
  // Only the room key's own row speaks for the room (proves the claim, names
  // its scorer, evicts the room's other owners: claimMatch's dbProved
  // reclaim). The row the sync names by uuid (match.externalId) may be any
  // row, the claimant's own under a key of its own: it "proved" the
  // claimant's PIN for any room key (MW-R1, audit 2611). Its game PIN is
  // still compared (a wrong one refuses the sync, as before), and a right one
  // binds the room's live states to it (dbRows), nothing more.
  const own = known.filter((r) => r.external_id != null && String(r.external_id) === matchId)
  const hasPin = (r) => r.game_pin != null && String(r.game_pin).trim() !== ''
  // Who scores the match, read before the PIN is compared (the answer waits
  // for the PIN all the same)
  let scorer = null
  if (device && layer.scorer && own.length > 0) {
    try {
      scorer = await layer.scorer.check({ device, refs: { externalIds: [], ids: own.map((r) => String(r.id)) } })
    } catch (err) {
      // as on /api/db: never in the way of a match day
      console.warn('[relay] scoring-device check of a scoreboard claim failed (allowed):', err?.message)
    }
  }
  const proving = own.some(hasPin)
  const knownScorer = scorer?.mine === true && proving
  // The two keys may name the same row
  const stored = [...new Map(known.filter(hasPin).map((r) => [String(r.id), r])).values()]
  if (stored.length > 0) {
    const pin = gamePinOf(match)
    if (pin === null) return { ok: false, code: 'pins-required' }
    const across = stored.map((row) => [dbPinKey(row), 'game'])
    const r = relayPinAttempt(clientInfo, pinScope.match(dbPinKey(stored[0]), 'game'), () => stored.every((row) => layer.pins.matches('game', pin, row.game_pin)), { scopeOnly: knownScorer, across })
    if (r === 'rate-limited') return { ok: false, code: 'rate-limited' }
    if (r === 'wrong') return { ok: false, code: 'not-match-owner' }
  }
  if (scorer?.moved) return { ok: false, code: 'scorer-moved' }
  return { ok: true, dbProved: proving, knownScorer, dbRows: stored.map((row) => String(row.id)) }
}

// The key pinFailureLimiter counts a database match under: its external_id,
// as every other PIN check of it (claim, validate-connection-pin), else its id
function dbPinKey(row) {
  return row?.external_id != null && String(row.external_id) !== '' ? String(row.external_id) : String(row?.id)
}

// A relay room whose game PIN a counted check proved against database rows
// (verifyRelayClaim, the live-state relay's verifyMatch) is bound to them:
// entry.dbRows { pin, ids }. Its live states go to those rows without being
// counted again. Kept with the PIN it was proved with: a room whose game PIN
// changed since (a take-over, a reclaim) is bound to nothing.
const MAX_BOUND_ROWS = 8
function boundRowsAfter(bound, pin, ids) {
  if (pin === null) return null
  const all = new Set(bound && bound.pin === pin ? bound.ids : [])
  for (const id of ids) {
    all.delete(String(id)) // re-added as the newest
    all.add(String(id))
  }
  while (all.size > MAX_BOUND_ROWS) all.delete(all.values().next().value)
  return all.size > 0 ? { pin, ids: all } : null
}
function bindRoomRows(entry, pin, ids) {
  if (entry) entry.dbRows = boundRowsAfter(entry.dbRows, pin, ids)
}
function isBoundRow(entry, pin, id) {
  return !!entry?.dbRows && entry.dbRows.pin === pin && entry.dbRows.ids.has(String(id))
}

/**
 * Is this sync from the room's own scoring device (a reconnect: Wi-Fi drop,
 * tablet sleep)? The installation the room's last granted sync named
 * (entry.scorerDevice; never broadcast). Its claim of the room's game PIN is
 * counted per address and scope only, not across callers (pinFailureLimiter
 * scopeOnly): other callers' wrong claims locked the game PIN of a match the
 * database does not hold (a relay-only match, the venue relay), and its own
 * scoreboard's reconnect was then refused for 10 minutes, its referee and
 * benches without data. A sync that names no device (older apps) is not it.
 */
function isRoomScorer(entry, device) {
  return !!device && !!entry?.scorerDevice && entry.scorerDevice === device.id
}

// Venue relay (--local, no database): the scoring device of a room comes
// from the syncs themselves. A sync names its device with a claim of the
// match (`device.claim`: a random id the app makes anew each time the device
// continues the match: restore, take back). Once another device's sync took
// the room over, a sync that still carries a claim it took over is refused
// ('scorer-moved'), until the device that took it over has been gone as long
// as a stale take-over waits. The game PIN cannot tell (every device the
// match was scored on knows it): a laptop back on the Wi-Fi re-synced its
// older copy over the phone that continued the match, and the referee and
// benches jumped back to it. Same rules as the LAN relays
// (frontend/electron/lanRelayCore.cjs isMovedClaim / noteScorer). A sync
// without a claim (older apps) is not checked. The room's entry keeps
// scorerClaim ({ id, claim }) and movedClaims (device id -> claim).
// A sync also names the claims of the copies its device continued the match
// from (`device.supersedes`, a backup restore): older copies, refused like a
// claim taken over. The take-overs live in memory only: after a restart of
// this relay a laptop's older copy synced after the phone that had continued
// the match took the room from it for good (2026-10-27); every sync of the
// newer copy names the older claims, so the relay knows them again from its
// first one. The entry keeps them in supersededClaims (Set of claims).
const MAX_MOVED_DEVICES = 16
const MAX_CLAIM_LENGTH = 64
const MAX_SUPERSEDED_CLAIMS = 8
const MAX_SUPERSEDED_PER_ROOM = 32

const isVenueClaimString = (c) => typeof c === 'string' && c.length > 0 && c.length <= MAX_CLAIM_LENGTH

/** A sync's device with its claim ({ id, claim, supersedes }), or null (not checked). */
function venueDeviceClaim(raw) {
  const device = deviceOf(raw)
  const claim = raw && typeof raw === 'object' ? raw.claim : null
  if (!device || !isVenueClaimString(claim)) return null
  const supersedes = Array.isArray(raw.supersedes)
    ? [...new Set(raw.supersedes.slice(0, MAX_SUPERSEDED_CLAIMS).filter((c) => isVenueClaimString(c) && c !== claim))]
    : []
  return { id: device.id, claim, supersedes }
}

function isMovedVenueClaim(matchId, device) {
  // a room that emptied keeps its take-overs for the grace (holdRoom)
  const entry = activeMatches.get(matchId) || heldRoomOf(matchId)
  const scorer = entry?.scorerClaim
  if (!scorer || scorer.id === device.id) return false
  if (entry.movedClaims?.get(device.id) !== device.claim && !entry.supersededClaims?.has(device.claim)) return false
  const grace = isFinishedMatch(entry.match) ? ORPHAN_TAKEOVER_MS : STALE_TAKEOVER_MS
  return !(ownersOf(matchId).length === 0 && entry.orphanedAt && Date.now() - entry.orphanedAt >= grace)
}

/**
 * The room's scorerClaim / movedClaims / supersededClaims after a granted
 * sync of `device` (claim kind `kind`); `previous` is the room's entry before
 * it. A take-over by another device remembers that one's claim as moved, and
 * its sockets stop speaking for the room and are told ('scorer-moved'). The
 * claims its copy was continued from are older copies, its own claim never.
 */
function venueScorerAfter(clientInfo, matchId, previous, device, kind) {
  const fresh = kind === 'takeover' || kind === 'new'
  const prev = fresh ? null : previous?.scorerClaim
  const moved = new Map(fresh ? [] : previous?.movedClaims || [])
  moved.delete(device.id)
  const older = new Set(fresh ? [] : previous?.supersededClaims || [])
  older.delete(device.claim)
  for (const c of device.supersedes) {
    older.delete(c) // re-added as the newest
    older.add(c)
  }
  while (older.size > MAX_SUPERSEDED_PER_ROOM) older.delete(older.values().next().value)
  if (prev && prev.id !== device.id) {
    moved.set(prev.id, prev.claim)
    while (moved.size > MAX_MOVED_DEVICES) moved.delete(moved.keys().next().value)
    const data = JSON.stringify({ type: 'scorer-moved', matchId, timestamp: Date.now() })
    for (const c of connections.values()) {
      if (c === clientInfo || c.scorerDevice !== prev.id || !c.ownedMatches.delete(matchId)) continue
      if (c.ws.readyState === 1) { try { c.ws.send(data) } catch { /* closing */ } }
    }
  }
  return { scorerClaim: device, movedClaims: moved, supersededClaims: older }
}

const CLAIM_ERRORS = {
  'not-match-owner': 'Match is owned by another scoreboard (game PIN mismatch)',
  'rate-limited': 'Too many failed scoreboard claims. Wait a few minutes.',
  'too-many-matches': 'This address already drives the maximum number of matches',
  'pins-required': 'Send this match again with its PINs (the relay lost it, or this connection has not proved it yet)',
  'claim-unverified': 'The server could not check this match right now. It is tried again with the next sync.',
  'room-limit': 'Server room limit reached',
  'scorer-moved': 'This match is now scored on another device',
  'too-large': 'Match data too large for the relay',
  'relay-full': 'The relay cannot keep more match data right now. Try again in a few minutes.'
}

// The address a socket's stored match data counts against (relayMemoryRefusal);
// null for the relay host itself
const relayAddressOf = (clientInfo) => (isLoopbackIp(clientInfo.ip) ? null : (IS_CLOUD ? clientInfo.ipKey : clientInfo.ip))
// The wider network of that address (MAX_ROOMS_PER_ADDRESS for the rooms the
// database did not prove, held claims): the /56 of an IPv6 /64 bucket on the
// cloud (ipBucketKey "2001:db8:0:1::/64"), else the address itself
function relayNetOf(clientInfo) {
  const address = relayAddressOf(clientInfo)
  const v6 = IS_CLOUD && address !== null ? /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4})::\/64$/.exec(address) : null
  return v6 ? `${v6[1]}:${v6[2]}:${v6[3]}:${(parseInt(v6[4], 16) & 0xff00).toString(16)}::/56` : address
}
// A room the database proved (cloud): its scorer synced the game PIN of the
// match's database row (relayOfficial). None on a venue relay.
const isDbProvedRoom = (entry) => DB_MODE && entry?.relayOfficial === true

/**
 * 'room-limit' when a new room of this socket (`dbProved`: the database proved
 * its game PIN) would take the relay past one of its room caps, else null:
 * MAX_ROOMS_PER_ADDRESS for the address (the rooms its syncs keep, whoever
 * keeps them open), as many per /56 for rooms the database did not prove
 * (cloud), MAX_ANON_ROOMS for all of those (DATABASE_URL), MAX_ROOMS in all.
 * At a cap the room no connected socket owns whose scorer left first is ended
 * to make room (endIdleRoom), an address's own rooms first. A room kept open
 * by watchers alone used to keep its slot for good: idle sockets of a few
 * /64s filled the relay and no new match got a room.
 */
function roomLimitRefusal(clientInfo, dbProved) {
  const address = relayAddressOf(clientInfo)
  const net = relayNetOf(clientInfo)
  const unproved = (e) => !isDbProvedRoom(e)
  const caps = []
  if (address !== null) caps.push([MAX_ROOMS_PER_ADDRESS, (e) => e.relayAddress === address])
  if (IS_CLOUD && !dbProved && net !== null && net !== address) caps.push([MAX_ROOMS_PER_ADDRESS, (e) => e.relayNet === net && unproved(e)])
  if (DB_MODE && !dbProved) caps.push([MAX_ANON_ROOMS, unproved])
  caps.push([MAX_ROOMS, () => true])
  for (const [max, inCap] of caps) {
    let n = 0
    for (const entry of activeMatches.values()) if (inCap(entry)) n++
    if (n >= max && !endIdleRoom(inCap)) return 'room-limit'
  }
  return null
}

/**
 * End one room among those `inCap` takes that no connected socket owns: the
 * one whose scorer left first, rooms the database did not prove first. Its
 * bundle goes and its claim is held for what is left of its take-over grace
 * (holdRoom), as when its last socket leaves: its watchers wait for the match
 * again (admitWaiting lets them back in with its next first sync), its scorer
 * coming back with the game PIN continues it. Nothing reaches such a room
 * meanwhile anyway: no socket may sync it. Returns whether one was ended.
 */
function endIdleRoom(inCap) {
  const owned = new Set()
  for (const c of connections.values()) for (const id of c.ownedMatches) owned.add(id)
  let pick = null
  for (const [id, entry] of activeMatches) {
    if (owned.has(id) || !inCap(entry)) continue
    const rank = [isDbProvedRoom(entry) ? 1 : 0, entry.orphanedAt ?? 0]
    if (!pick || rank[0] < pick.rank[0] || (rank[0] === pick.rank[0] && rank[1] < pick.rank[1])) pick = { id, rank }
  }
  if (!pick) return false
  holdRoom(pick.id)
  relaySummary.count('rooms ended for a new one')
  console.log(`🗑️  Room ${pick.id} ended for a new room (no socket owns it; its claim is held for the take-over grace)`)
  return true
}

/**
 * 'relay-full' when `bytes` (approxHeapBytes) for room `matchId` would take
 * the relay past its memory budget; else null. The room's own bundle and live
 * state are left out: they are the ones replaced, so replacing a stored room's
 * bundle never adds a room. At most MAX_ROOMS entries to add up.
 *
 * A room the relay does not hold yet (`newRoom`) is refused at the lower
 * new-room marks, so the headroom above is kept for the rooms already in play
 * (they grow with every rally and must not freeze when the relay fills). A room
 * the database does not know as an official match (`official` false, cloud
 * only) may not take the slice reserved for official matches; official matches
 * and venue rooms use the whole budget.
 */
function relayMemoryRefusal(clientInfo, matchId, bytes, { newRoom = false, official = true } = {}) {
  const address = relayAddressOf(clientInfo)
  let total = bytes
  let fromAddress = bytes
  let anon = official ? 0 : bytes
  for (const [id, entry] of activeMatches) {
    if (id === matchId) continue
    const held = (entry.bundleBytes || 0) + (entry.liveStateBytes || 0)
    total += held
    if (address !== null && entry.relayAddress === address) fromAddress += held
    if (!entry.relayOfficial) anon += held
  }
  if (total > RELAY_MEMORY.total) return 'relay-full'
  if (address !== null && fromAddress > RELAY_MEMORY.perAddress) return 'relay-full'
  if (newRoom && total > RELAY_MEMORY.newRoomTotal) return 'relay-full'
  if (newRoom && address !== null && fromAddress > RELAY_MEMORY.newRoomPerAddress) return 'relay-full'
  if (!official && anon > RELAY_MEMORY.anonTotal) return 'relay-full'
  return null
}

function sendRelayRefusal(clientInfo, code, matchId, message = CLAIM_ERRORS[code]) {
  relaySummary.count(`refused (${code})`)
  clientInfo.ws.send(JSON.stringify({ type: 'error', code, message, matchId }))
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

  // Refused before anything reads it (lib/relayLimits.js): a PIN that is not
  // text or a number (String() of {"toString":1} throws, and the PIN check of
  // GET /api/match/:id ended the backend with it), a PIN field the relay only
  // carries over that is larger than any app's, a list that is no array or
  // longer than any match has
  const problem = relayBundleProblem(message, MATCH_PIN_FIELDS, MATCH_PIN_TYPE_ONLY_FIELDS, MATCH_CARRIED_PIN_FIELDS)
  if (problem) {
    sendRelayRefusal(clientInfo, problem.code, relayKeyOf(normalizeMatchId(message.matchId), message.match), problem.message)
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
  if (badSeedKey(match)) {
    sendRelayRefusal(clientInfo, 'bad-request', matchId, 'Invalid match key (seed_key: at most 128 characters, no control characters)')
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

  // What the relay would keep (without the undo snapshots) and whether its
  // memory has room for it; the room's last bundle is replaced, not added.
  // A cloud claim comes back here after its database check and checks the
  // memory again with what the relay holds then.
  // A room the relay does not hold yet is new (shed first when the relay is
  // nearly full); replacing a stored room's bundle keeps a match in play going.
  // Official (the database proved its game PIN, or the venue relay with no
  // database, or a first pass whose database check runs next and re-decides)
  // reserves memory an anonymous room cannot take; a room continued by its
  // owner keeps the status its last sync earned.
  const stored = activeMatches.get(matchId)
  const newRoom = !stored
  const official = !DB_MODE || opts.dbProved === true ||
    (!opts.dbChecked && !clientInfo.ownedMatches.has(matchId)) ||
    (clientInfo.ownedMatches.has(matchId) && (stored || heldRoomOf(matchId))?.relayOfficial === true)
  // Counted first as the sync sends it, before its claim is made: what any
  // claim keeps at least. It depends on the message alone, so a cloud claim's
  // second pass reuses it. A sync that continues the room also keeps the stored
  // PINs it leaves out and the room's live state; they are counted once the
  // claim says so (below). A take-over or reclaim keeps neither, so what the
  // room's last holder stored never counts against it.
  const storedEvents = opts.storedEvents ?? relayEvents(events)
  const countBundle = (m) => approxHeapBytes([m, homeTeam, awayTeam, homePlayers, awayPlayers, sets, storedEvents])
  const memoryRefusalOf = (bytes, liveStateBytes = 0) => (bytes > MAX_RELAY_BUNDLE_BYTES
    ? 'too-large'
    : relayMemoryRefusal(clientInfo, matchId, bytes + liveStateBytes, { newRoom, official }))
  let bundleBytes = opts.bundleBytes ?? countBundle(match)
  const memoryRefusal = memoryRefusalOf(bundleBytes)
  if (memoryRefusal) {
    sendRelayRefusal(clientInfo, memoryRefusal, matchId)
    return
  }

  // Cloud: a claim of a room this socket does not own yet is checked against
  // the database first (verifyRelayClaim), then made. Returns the promise, so
  // the socket's next messages wait for it.
  const device = deviceOf(message.device)
  if (DB_MODE && !opts.dbChecked && !clientInfo.ownedMatches.has(matchId)) {
    // The device this sync names, before the check: a take-over committed
    // while it runs (notifyScorerMoved) marks this claim moved, and it is
    // refused when the check ends. It used to make the socket the owner,
    // with the copy of the device the match had just left.
    if (device) clientInfo.scorerDevice = device.id
    const check = { matchId, moved: false }
    clientInfo.claimCheck = check
    const done = () => { if (clientInfo.claimCheck === check) clientInfo.claimCheck = null }
    return verifyRelayClaim(clientInfo, matchId, match, device).then((v) => {
      done()
      if (clientInfo.ws.readyState !== 1 || !connections.has(clientInfo.id)) return
      if (v.code === 'scorer-moved' || (v.ok && check.moved)) {
        // The app asks POST /api/match/scorer whether it still scores the
        // match (ScorerMovedModal), as when it is told in the room
        clientInfo.ws.send(JSON.stringify({ type: 'scorer-moved', matchId, timestamp: Date.now() }))
        return
      }
      if (!v.ok) {
        clientInfo.ws.send(JSON.stringify({ type: 'error', code: v.code, message: CLAIM_ERRORS[v.code] || 'Refused', matchId }))
        return
      }
      handleSyncMatchData(clientInfo, message, { dbChecked: true, dbProved: v.dbProved, knownScorer: v.knownScorer, dbRows: v.dbRows, storedEvents, bundleBytes })
    }, (err) => {
      done()
      throw err
    })
  }

  // Venue relay: a claim another device took over, refused before any PIN
  // is compared (isMovedVenueClaim)
  const venueDevice = DB_MODE ? null : venueDeviceClaim(message.device)
  if (venueDevice && isMovedVenueClaim(matchId, venueDevice)) {
    clientInfo.ownedMatches.delete(matchId)
    updateScorerPresence(matchId)
    clientInfo.ws.send(JSON.stringify({ type: 'error', code: 'scorer-moved', message: CLAIM_ERRORS['scorer-moved'], matchId }))
    return
  }

  const claimed = claimMatch(clientInfo, matchId, match, { dbProved: opts.dbProved === true, knownScorer: opts.knownScorer === true, device })
  if (!claimed.ok) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      code: claimed.code,
      message: CLAIM_ERRORS[claimed.code] || 'Refused',
      matchId
    }))
    return
  }

  // A sync that continues the room (its owner, or a proof of the stored game
  // PIN) keeps the stored PINs it leaves out (PINs are sent only when they
  // change), and the room's last live state while the same game PIN keeps the
  // match: never across a takeover, reclaim or PIN change (it would describe
  // another match: sides, sets won, 'ended', ...). Counted here, with the
  // memory checked again, before anything is stored. Refusing here leaves
  // nothing to undo: claimMatch changes nothing for such a claim but refund a
  // correct PIN. A room that emptied within the grace is continued from its
  // held claim (holdRoom): its PINs and scoring device, no bundle.
  const previous = activeMatches.get(matchId) || heldRoomOf(matchId)
  const continues = claimed.kind === 'owner' || claimed.kind === 'proved'
  const carried = continues && previous?.match ? carryMatchSecrets(previous.match, match) : match
  const carryLiveState = continues && gamePinOf(previous?.match) === gamePinOf(carried)
  const carriedLiveStateBytes = carryLiveState ? (previous?.liveStateBytes || 0) : 0
  if (carried !== match || carriedLiveStateBytes > 0) {
    if (carried !== match) bundleBytes = countBundle(carried)
    const refusal = memoryRefusalOf(bundleBytes, carriedLiveStateBytes)
    if (refusal) {
      sendRelayRefusal(clientInfo, refusal, matchId)
      return
    }
    match = carried
  }

  // Whether the database knows this as an official match (cloud), for the
  // memory budget and the room caps: proved now, or carried by its owner's
  // later syncs (which do not re-check the database). Venue rooms (no
  // database) are all official.
  const relayOfficial = !DB_MODE || opts.dbProved === true ||
    ((claimed.kind === 'owner' || claimed.kind === 'proved' || claimed.kind === 'reclaim') && previous?.relayOfficial === true)

  // Enforce the room caps before storing anything (roomLimitRefusal)
  if (!rooms.has(matchId)) {
    const refusal = roomLimitRefusal(clientInfo, DB_MODE && relayOfficial)
    if (refusal) {
      sendRelayRefusal(clientInfo, refusal, matchId)
      return
    }
  }

  // A scoreboard switching matches leaves its previous room first
  if (clientInfo.matchId && clientInfo.matchId !== matchId) {
    leaveRoom(clientInfo, clientInfo.matchId)
  }

  if (rawMatchId && rawMatchId !== matchId) {
    clientInfo.aliases.delete(rawMatchId)
    if (clientInfo.aliases.size >= MAX_ALIASES) clientInfo.aliases.delete(clientInfo.aliases.keys().next().value)
    clientInfo.aliases.set(rawMatchId, matchId)
  }

  // Store/update match in activeMatches with all the data (a sync carries no
  // live state: the room's last one is kept as decided above).
  // The sport of the room: openbeach syncs team1/team2 (or names its sport);
  // a sync without teams keeps the sport the same scorer set before.
  const beachSync = !!(message.team1Team || message.team2Team || message.team1Players || message.team2Players) ||
    match.sportType === 'beach' || match.sport_type === 'beach'
  const sportType = beachSync
    ? 'beach'
    : ((claimed.kind === 'owner' || claimed.kind === 'proved') && previous?.sportType) || 'indoor'
  if (device) clientInfo.scorerDevice = device.id
  // A PIN the scorer changed (regenerated) starts its count across callers
  // again: the wrong guesses of the old one say nothing about it
  if (previous?.match && (claimed.kind === 'owner' || claimed.kind === 'proved' || claimed.kind === 'reclaim')) {
    const was = new Map(relayPinsByType(previous.match, { sport: previous.sportType, open: false }))
    const now = new Map(relayPinsByType(match, { sport: sportType, open: false }))
    const changed = [...new Set([...was.keys(), ...now.keys()])].filter((type) => was.get(type) !== now.get(type))
    if (changed.length) pinFailureLimiter.pinChanged(matchId, changed)
  }
  const venueScorer = venueDevice
    ? venueScorerAfter(clientInfo, matchId, previous, venueDevice, claimed.kind)
    : (claimed.kind === 'takeover' || claimed.kind === 'new' ? {} : { scorerClaim: previous?.scorerClaim, movedClaims: previous?.movedClaims, supersededClaims: previous?.supersededClaims })
  // The room's scoring device (isRoomScorer) and the database rows its game
  // PIN was proved for (bindRoomRows), until the room is taken over
  const fresh = claimed.kind === 'takeover' || claimed.kind === 'new'
  match = stampRelayOrder(match)
  activeMatches.set(matchId, {
    ...venueScorer,
    scorerDevice: device ? device.id : (fresh ? null : previous?.scorerDevice ?? null),
    dbRows: boundRowsAfter(fresh ? null : previous?.dbRows, gamePinOf(match), opts.dbRows || []),
    // when the relay first held this key (kept while it holds it, take-overs
    // too): a matches row created since cannot prove a claim of a local-only
    // room (verifyRelayClaim)
    firstSyncAt: previous?.firstSyncAt ?? Date.now(),
    matchId,
    sportType,
    match,
    homeTeam,
    awayTeam,
    homePlayers,
    awayPlayers,
    sets,
    events: storedEvents,
    liveState: carryLiveState ? previous?.liveState : undefined,
    // the relay memory it takes (relayMemoryRefusal), whose it is and whether
    // the database knows it as an official match
    bundleBytes,
    liveStateBytes: carryLiveState ? previous?.liveStateBytes : undefined,
    relayAddress: relayAddressOf(clientInfo),
    relayNet: relayNetOf(clientInfo),
    relayOfficial,
    gameNumber: match?.gameN || match?.gameNumber || match?.game_n,
    updatedAt: new Date().toISOString(),
    updatedBy: clientInfo.id
  })
  // A key whose held claim lapsed (heldRoomOf: its scorer gone past the grace
  // of a match in play) is new, but that claim's game PIN may reclaim it once
  // from this one, as after a stale take-over
  const lapsed = heldRooms.get(matchId)?.lapsed ? heldRooms.get(matchId) : null
  heldRooms.delete(matchId)
  if (lapsed && opts.dbProved !== true && (gamePinOf(match) === null || !safeEqualStr(gamePinOf(match), lapsed.pin))) {
    displacedPins.set(matchId, lapsed.pin)
  }
  // the key's first PIN and device (what a new row under it needs)
  noteRoomOrigin(matchId, claimed.kind, gamePinOf(match), device ? device.id : null)
  const newlyOwned = !clientInfo.ownedMatches.has(matchId)
  clientInfo.ownedMatches.add(matchId)
  // Bench requests of a set that is over are dropped; a scorer that has just
  // (re)proved the match gets the open ones again. A take-over or a new claim
  // proved no PIN the benches asked under: their open requests (line-ups
  // too) go, they were replayed to whoever took a room a tablet kept open.
  if (fresh) benchRequests.drop(matchId)
  benchRequests.prune(matchId, currentSetOfBundle(activeMatches.get(matchId)))
  if (newlyOwned && !fresh) replayBenchRequests(clientInfo, matchId)

  // The room (created by the match's first accepted sync), with this socket in it
  const created = !rooms.has(matchId)
  enterRoom(clientInfo, matchId)
  clientInfo.role = 'scoreboard'

  // Broadcast to other clients in the room. Subscribers (referee/bench/livescore)
  // must never receive the connection PINs — wireBundle strips them — and get
  // the bundle only after the PIN step (the summary otherwise).
  broadcastMatchData(matchId, 'match-data-update', activeMatches.get(matchId), message._timestamp, clientInfo.id, { timestamp: new Date().toISOString() })
  // The tablets that subscribed before the room existed
  if (created) admitWaiting(matchId)
  // Once the claim is made: a take-over within this sync (claimMatch,
  // venueScorerAfter) never reads as the scorer gone
  updateScorerPresence(matchId)
  // A socket that has just proved the match hears whether a display follows it
  if (newlyOwned) sendDisplayPresence(clientInfo, matchId)

  if (LOG_EACH_CONNECTION) console.log(`📤 Match data synced for ${logValue(matchId)} (Game #${logValue(match?.gameN || 'unknown')})`)
  else relaySummary.count('match bundles synced')
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

  if (LOG_EACH_CONNECTION) console.log(`⚡ Match action broadcasted to room ${logValue(matchId)}: ${logValue(action)}`)
  else relaySummary.count('match actions broadcast')
}

// A live state no more than this many bytes bigger than the room's last one is
// a routine replacement (score, rotation): it adds almost nothing to the heap,
// so the relay's memory never refuses it and a match in play keeps publishing.
const LIVE_STATE_GROWTH_SLACK = 8 * 1024

// Handle live-state-update (scoreboard's computed live state). False: refused
// because it is too large (over the live hub's own limit), so the database
// live-state path is skipped too. True otherwise, including when the relay's
// memory is full: the relay then does not store or broadcast it, but the
// database path (livescore, scorer alarm) still publishes it — that path has
// its own limit and must not depend on the relay's memory.
function handleLiveStateUpdate(clientInfo, message) {
  const matchId = resolveMatchKey(clientInfo, message.matchId)
  if (!requireMatchOwner(clientInfo, matchId, 'live-state-update')) return true
  if (!message.liveState || typeof message.liveState !== 'object') return true
  const stored = activeMatches.get(matchId)
  // The live hub's size limit (a real one is a few KB)
  if (JSON.stringify(message.liveState).length > MAX_LIVE_STATE_BYTES) {
    sendRelayRefusal(clientInfo, 'too-large', matchId, 'Live state too large for the relay')
    return false
  }
  // The relay's memory, only when the live state grows materially past the
  // room's last one (a routine replacement adds almost nothing): the room is
  // already stored, so this never refuses a match in play for its own updates.
  const liveStateBytes = approxHeapBytes(message.liveState)
  const grew = liveStateBytes > (stored?.liveStateBytes || 0) + LIVE_STATE_GROWTH_SLACK
  const memoryRefusal = stored && grew
    ? relayMemoryRefusal(clientInfo, matchId, (stored.bundleBytes || 0) + liveStateBytes, { official: stored.relayOfficial !== false })
    : null
  if (memoryRefusal) {
    // Not stored or broadcast here, but the database live-state path still runs
    sendRelayRefusal(clientInfo, memoryRefusal, matchId)
    return true
  }
  message.liveState = stampRelayOrder(message.liveState)
  if (stored) {
    stored.liveState = message.liveState
    // The accounted size only moves when the memory check ran (grew): a sync of
    // sub-slack updates would otherwise creep the baseline up step by step and
    // never re-trigger the check, so the room's live state could reach the hub's
    // 256 KB cap while the budget still saw near-zero. Now it lags real by at
    // most the slack, which the budget's headroom absorbs.
    if (grew) stored.liveStateBytes = liveStateBytes
  }
  broadcastLiveState(matchId, message.liveState, stored, clientInfo.id)
  return true
}

// The order the relay received a room's live states and bundles in: the
// viewers order the states of two scorer devices by it (frontend
// serverDataSync newerLiveState), not by the devices' clocks, which differ
// after a hand-over in a hall without internet time. One counter for every
// room (only its order matters); the epoch tells a restarted relay's counter
// apart, whose numbers start again.
const RELAY_ORDER_EPOCH = randomBytes(6).toString('base64url')
let relayOrderSeq = 0
function stampRelayOrder(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
  return { ...obj, _relayEpoch: RELAY_ORDER_EPOCH, _relaySeq: ++relayOrderSeq }
}

// live-state-update to a room, each socket by its view: a socket without a
// PIN gets the public live state (publicLiveState: no line-ups, substitutions,
// sanctions), a PIN-proved one the state as it came, unless it carries a
// covered line-up (an older scorer app; lib/publicColumns.js
// relayLiveStateView): then the referee and the covered team's bench as it
// came, every other socket without that line-up.
function broadcastLiveState(matchId, liveState, entry, excludeClientId) {
  const room = rooms.get(normalizeMatchId(matchId))
  if (!room) return
  // one serialisation per view ('' is no PIN)
  const byView = new Map()
  room.clients.forEach((clientId) => {
    if (clientId === excludeClientId) return
    const clientInfo = connections.get(clientId)
    if (!clientInfo || clientInfo.ws.readyState !== 1) return
    const view = relayViewOfClient(clientInfo, matchId, entry) || ''
    let data = byView.get(view)
    if (data === undefined) {
      const shown = view ? relayLiveStateView(liveState, view, entry?.match, entry?.events) : publicLiveState(relayLiveStateView(liveState, null, entry?.match, entry?.events))
      data = JSON.stringify({ type: 'live-state-update', matchId, liveState: shown })
      byView.set(view, data)
    }
    sendToRoomMember(clientInfo, data)
  })
}

// Remove a match from the relay: tell its room first, then drop room + state.
function removeMatch(matchId) {
  if (liveStateRelay) {
    const key = matchKeyFromSyncedMatch(activeMatches.get(matchId)?.match)
    if (key) liveStateRelay.invalidate(key.value)
  }
  broadcastToRoom(matchId, { type: 'match-deleted', matchId })
  dropRoom(matchId)
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
      updateScorerPresence(matchId)
      continue
    }
    removeMatch(matchId)
    cleared++
  }
  console.log(`🗑️  Cleared ${cleared} match(es) owned by ${clientInfo.id}${keepMatchId ? ` (kept ${logValue(keepMatchId)})` : ''}`)
}

// Handle delete-match
function handleDeleteMatch(clientInfo, message) {
  const matchId = resolveMatchKey(clientInfo, message.matchId)
  if (!matchId) return
  if (!requireMatchOwner(clientInfo, matchId, 'delete-match')) return

  removeMatch(matchId)
  console.log(`🗑️  Deleted match ${logValue(matchId)}`)
}

// --- Bench requests (lib/benchRequests.js) ------------------------------------
// A bench tablet sends its team's line-up, a time-out request or a prepared
// substitution; only the match's scoreboard gets it, only that bench gets the
// answer, the referee sockets a note of time-out / substitution requests. The
// same messages and rules as lanRelayCore and the Tauri relay
// (tests/helpers/benchRequestContract.js).
const benchRequests = createBenchRequestStore()
const benchRequestLimiter = createWindowLimiter()

/**
 * The role this socket proved for the match: 'home' / 'away' (that bench's
 * PIN or token while its connection is on), 'referee', else null. The game
 * PIN (the scorer's own devices) is none of them. `compare: false` takes a
 * PIN already proved only (the tablet status, provedRoleOf); else a PIN not
 * compared yet is compared now, counted (hasRelayAccess).
 */
function relayRoleOf(clientInfo, matchId, entry = activeMatches.get(matchId), { compare = true } = {}) {
  if (!clientInfo || !matchId || !entry?.match) return null
  const a = clientInfo.matchAccess.get(matchId)
  if (!a) return null
  if (a.token && tokenGrantsRelay(a.token, matchId, entry.match)) return tokenRoleOf(matchTokens.verify(a.token))
  if (a.pin && (compare ? hasRelayAccess(clientInfo, matchId, entry) : a.verified)) return pinRoleOf(entry.match, a.pin)
  return null
}

function roomMembers(matchId, pred) {
  const room = rooms.get(matchId)
  const out = []
  if (!room) return out
  for (const id of room.clients) {
    const c = connections.get(id)
    if (c && c.ws.readyState === 1 && pred(c)) out.push(c)
  }
  return out
}

const matchOwners = (matchId) => [...connections.values()].filter(c => c.ws.readyState === 1 && c.ownedMatches.has(matchId))

function sendToClient(clientInfo, msg) {
  try { clientInfo.ws.send(JSON.stringify(msg)) } catch { /* closing */ }
}

function benchRefused(clientInfo, matchId, reason, id = null) {
  sendToClient(clientInfo, { type: 'error', code: 'bench-request-refused', reason, message: `Bench request refused: ${reason}`, ...(id ? { id } : {}), ...(matchId ? { matchId } : {}) })
}

function toReferees(matchId, msg) {
  const text = JSON.stringify(msg)
  for (const c of roomMembers(matchId, (m) => relayRoleOf(m, matchId) === 'referee')) sendToRoomMember(c, text)
}

function handleBenchRequest(clientInfo, message) {
  const matchId = normalizeMatchId(message.matchId)
  const id = typeof message.request?.id === 'string' ? message.request.id.slice(0, 64) : null
  if (benchRequestLimiter.hit(clientInfo.id)) return benchRefused(clientInfo, matchId, 'rate-limited', id)
  const entry = matchId ? activeMatches.get(matchId) : null
  if (!entry) return benchRefused(clientInfo, matchId, 'no-match', id)
  const team = message.team
  if (team !== 'home' && team !== 'away') return benchRefused(clientInfo, matchId, 'bad-team', id)
  if (relayRoleOf(clientInfo, matchId, entry) !== team) return benchRefused(clientInfo, matchId, 'not-this-bench', id)
  const checked = normalizeBenchRequest(message.request)
  if (!checked.ok) return benchRefused(clientInfo, matchId, checked.reason, id)
  const request = checked.request
  benchRequests.prune(matchId, currentSetOfBundle(entry))
  const kept = benchRequests.add(matchId, team, request)
  if (!kept.ok) return benchRefused(clientInfo, matchId, kept.reason, request.id)
  const owners = matchOwners(matchId)
  const at = kept.entry?.at ?? Date.now()
  const out = JSON.stringify({ type: 'bench-request', matchId, team, request, status: kept.entry ? kept.entry.status : 'cancelled', at })
  for (const o of owners) sendToRoomMember(o, out)
  for (const old of kept.superseded) if (old.request.kind !== 'lineup') toReferees(matchId, refereeInfo(matchId, old, 'superseded'))
  if (kept.cancelled && kept.cancelled.request.kind !== 'lineup') toReferees(matchId, refereeInfo(matchId, kept.cancelled, 'cancelled'))
  if (kept.entry && request.kind !== 'lineup') toReferees(matchId, refereeInfo(matchId, kept.entry))
  sendToClient(clientInfo, {
    type: 'bench-request-ack',
    matchId,
    team,
    id: request.id,
    status: kept.entry ? 'pending' : 'cancelled',
    delivered: owners.length,
    superseded: kept.superseded.map(e => e.request.id),
    ...(kept.cancelled ? { cancelId: kept.cancelled.request.id } : {})
  })
}

function handleBenchResponse(clientInfo, message) {
  const matchId = resolveMatchKey(clientInfo, message.matchId)
  if (!requireMatchOwner(clientInfo, matchId, 'bench-response')) return
  const team = message.team
  const checked = normalizeBenchResponse(message)
  if ((team !== 'home' && team !== 'away') || !checked.ok) return benchRefused(clientInfo, matchId, checked.ok ? 'bad-team' : checked.reason)
  const { id, status, reason } = checked.response
  const e = benchRequests.answer(matchId, team, id, status, reason || null)
  if (!e) return benchRefused(clientInfo, matchId, 'unknown-request', id)
  const out = JSON.stringify({ type: 'bench-response', matchId, team, id, kind: e.request.kind, setIndex: e.request.setIndex, status, ...(reason ? { reason } : {}) })
  for (const b of roomMembers(matchId, (m) => relayRoleOf(m, matchId) === team)) sendToRoomMember(b, out)
  // The other scoreboard sockets of the match (App + Scoreboard share one; a second device may not)
  for (const o of matchOwners(matchId)) if (o !== clientInfo) sendToRoomMember(o, out)
  if (e.request.kind !== 'lineup') toReferees(matchId, refereeInfo(matchId, e, status))
}

/** A bench that (re)subscribes: its team's requests; a referee: the open time-out / substitution requests. */
function sendBenchRequestsOnJoin(clientInfo, matchId) {
  if (!matchId) return
  const role = relayRoleOf(clientInfo, matchId)
  if (role === 'home' || role === 'away') {
    sendToClient(clientInfo, { type: 'bench-request-state', matchId, team: role, requests: benchRequests.ofTeam(matchId, role).map(benchView) })
  } else if (role === 'referee') {
    for (const e of benchRequests.open(matchId)) if (e.request.kind !== 'lineup') sendToClient(clientInfo, refereeInfo(matchId, e))
  }
}

/** The scorer's socket that has just proved the match: every open request again. */
function replayBenchRequests(clientInfo, matchId) {
  for (const e of benchRequests.open(matchId)) {
    sendToClient(clientInfo, { type: 'bench-request', matchId, team: e.team, request: e.request, status: e.status, at: e.at, replay: true })
  }
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
      if (sendToRoomMember(clientInfo, data)) sent++
    }
  })

  if (LOG_EACH_CONNECTION) console.log(`📡 Broadcasted to ${sent} clients in room ${logValue(matchId)}`)
  else relaySummary.count('room broadcasts')
}

// Periodic cleanup of stale connections, of the held claims of emptied
// rooms whose grace is over (heldRoomOf releases them), and of the room
// keys' origins idle past ROOM_TTL_MS
setInterval(() => {
  connections.forEach((clientInfo, clientId) => {
    if (clientInfo.ws.readyState === 3) { // WebSocket.CLOSED
      handleClientDisconnect(clientInfo)
    }
  })
  sweepHeldRooms()
  sweepRoomOrigins()
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
    // Schema (lib/schemaVersion.js): a db/ migration of this image not applied
    // yet (scripts/migrate.mjs), or a guard trigger, unique index or trigger
    // function missing, disabled or old. Logged, checked again every few
    // minutes (a change is logged); for /health: refreshSchemaStatus().
    import('./lib/schemaVersion.js').then((sv) => sv.checkSchemaAtStart(layer.db.pool))
      .catch((err) => console.warn('[DB] schema check not run:', err.message))
    // Activity log retention (db/016): 10 min after start, then daily
    const purgeActivity = () => layer.activity.purge()
      .then((r) => { if (r.unlinked || r.linked) console.log('[Activity] purge', JSON.stringify(r)) })
      .catch((err) => { console.warn('[Activity] purge failed:', err.message); captureServerError(err, { kind: 'job.failed', view: 'activity purge' }) })
    setTimeout(purgeActivity, 10 * 60 * 1000).unref()
    setInterval(purgeActivity, 24 * 60 * 60 * 1000).unref()
    // The error tracker (db/050): the server errors from before the data
    // layer; retention 12 min after start, then daily; the digest (mail, push,
    // bell; lib/errorAlerts.js) every minute, cloud only, ERROR_ALERTS=off stops it
    for (const [err, o] of pendingServerErrors.splice(0)) void layer.errors.captureServer(err, o)
    const purgeErrors = () => layer.errors.purge()
      .then((r) => { if (r.events || r.groups) console.log('[Errors] purge', JSON.stringify(r)) })
      .catch((err) => console.warn('[Errors] purge failed:', err.message))
    setTimeout(purgeErrors, 12 * 60 * 1000).unref()
    setInterval(purgeErrors, 24 * 60 * 60 * 1000).unref()
    if (!IS_LOCAL && String(process.env.ERROR_ALERTS || '').toLowerCase() !== 'off') {
      const tickMs = Number(process.env.ERROR_ALERT_TICK_MS) >= 1000 ? Number(process.env.ERROR_ALERT_TICK_MS) : 60 * 1000
      setInterval(() => { void layer.errorAlerts.tick() }, tickMs).unref()
      const a = layer.errorAlerts.stats()
      console.log(`[Errors] alerts on: mail ${a.mail ? 'to ERROR_ALERT_EMAIL' : 'off (ERROR_ALERT_EMAIL or SMTP not set)'}, push ${a.push ? 'to NTFY_TOPIC' : 'off (NTFY_URL / NTFY_TOPIC not set)'}, bell for super admins${a.suppressed ? ' (ERROR_ALERTS=log: nothing is sent)' : ''}`)
    }
    // Rosters sent ahead (db/023, db/035): deleted at expires_at, hourly,
    // also while no team or scorer calls a roster route
    layer.teams?.startSweeps?.()
    // An official match's rosters to the saved teams and club lists
    // (lib/rosterSaveBack.js): what waited when the last process stopped, a
    // minute after start
    setTimeout(() => {
      layer.saveBack?.catchUp().then((n) => { if (n) console.log(`[Save-back] ${n} recent official match(es) queued`) })
    }, 60 * 1000).unref()
    // Expired sessions, hourly
    setInterval(() => {
      layer.auth.sweepExpiredSessions().catch((err) => { console.warn('[Auth] session sweep failed:', err.message); captureServerError(err, { kind: 'job.failed', view: 'session sweep' }) })
      layer.auth.sweepExpiredTokens().catch((err) => console.warn('[Auth] email-link sweep failed:', err.message))
    }, 60 * 60 * 1000).unref()
    // backup/backups/** older than 30 days and stale temp files: 5 min after start, then daily
    // While the host backup is stale or missing, keep every backup/ file (the
    // nightly snapshot may be the only other copy, and it is not being made):
    // maxAgeMs Infinity deletes no file but still clears stale temp files.
    const runSweep = async () => {
      try {
        // the nightly files run copies backup/: without a fresh one, keep every file
        const { lastFilesBackupAgeMin } = await readLastFilesBackup()
        const state = backupState(lastFilesBackupAgeMin)
        const paused = state === 'stale' || state === 'unknown'
        if (paused) {
          console.error(`❌ [Storage] backup/ sweep PAUSED: the host's files backup is ${state} ` +
            `(last_files_backup age ${lastFilesBackupAgeMin ?? 'n/a'} min, limit ${BACKUP_MAX_AGE_HOURS} h, STATUS_DIR ${STATUS_DIR}). ` +
            'No backup file is deleted until the backup job runs again.')
        }
        const r = await layer.storage.sweep(paused ? { maxAgeMs: Infinity } : undefined)
        console.log('[Storage] sweep', JSON.stringify({ ...r, backupSweep: paused ? 'paused' : 'ran' }))
      } catch (err) {
        console.error('[Storage] sweep failed:', err.message)
        captureServerError(err, { kind: 'job.failed', view: 'storage sweep' })
      }
      // The app logs (backup/<account>/logs/**, utils/logger.js uploads):
      // 30 days, also while the backup sweep waits (they are no match record)
      try {
        const r = await layer.storage.sweepAppLogs()
        if (r.deletedFiles || r.removedDirs) console.log('[Storage] app log sweep', JSON.stringify({ deletedFiles: r.deletedFiles, deletedBytes: r.deletedBytes, removedDirs: r.removedDirs }))
      } catch (err) {
        console.error('[Storage] app log sweep failed:', err.message)
      }
    }
    setTimeout(runSweep, 5 * 60 * 1000).unref()
    setInterval(runSweep, 24 * 60 * 60 * 1000).unref()
    // Personal data kept for a time only: the club licence lists of past
    // seasons (db/037, lib/licences.js) and the sent game rosters 14 days
    // after their game (lib/teams.js, also run by its routes): 15 min after
    // start, then daily, also without any request
    const sweepClubData = () => Promise.all([
      layer.licences.sweep(),
      layer.teams.sweep({ force: true })
    ]).catch((err) => { console.warn('[Club data] sweep failed:', err.message); captureServerError(err, { kind: 'job.failed', view: 'club data sweep' }) })
    setTimeout(sweepClubData, 15 * 60 * 1000).unref()
    setInterval(sweepClubData, 24 * 60 * 60 * 1000).unref()
    // Match records past their season and app_settings.retention_years
    // (db/042, lib/retention.js; privacy policy section 16): matches with
    // their rows, scoresheet files, svrz_games. 20 min after start, then
    // daily; RETENTION_SWEEP=off (a dev copy) leaves everything.
    if (String(process.env.RETENTION_SWEEP || '').toLowerCase() !== 'off') {
      const sweepRetention = () => layer.retention.sweep()
        .then((r) => { if (r.matches || r.scoresheetFiles || r.scoresheetRecords || r.svrzGames || r.svrzRemoved || r.skipped) console.log('[Retention] sweep', JSON.stringify(r)) })
        .catch((err) => console.warn('[Retention] sweep failed:', err.message))
      setTimeout(sweepRetention, 20 * 60 * 1000).unref()
      setInterval(sweepRetention, 24 * 60 * 60 * 1000).unref()
    }
    // The final scoresheet by email (db/021, lib/finalMail.js): every minute
    // (FINAL_MAIL_SWEEP_MS), cloud only (a venue relay has no mailer). It
    // sends nothing while the Settings switch is off.
    if (!IS_LOCAL && layer.finalMail.enabled) {
      const sweepMs = Number(process.env.FINAL_MAIL_SWEEP_MS) >= 1000 ? Number(process.env.FINAL_MAIL_SWEEP_MS) : 60 * 1000
      setInterval(() => {
        layer.finalMail.sweep().then((r) => {
          if (r && !r.skipped && Object.keys(r).length) console.log('[Final mail] sweep', JSON.stringify(r))
        })
      }, sweepMs).unref()
    }
    // VolleyManager -> svrz_games, daily at 22:30 UTC (replaces the Supabase
    // vm-sync Edge Function). Cloud only; needs VM credentials; VM_SYNC=off disables.
    // The VolleyManager account is shared with svrz_rc and a club app and has ONE
    // active role (lib/vmSync.js VM_ROLE_FOR_GAMES). 22:30 UTC is inside svrz_rc's
    // referee-role window (22:00-00:59 UTC: its games sync, the same role as this
    // one), which the club app's club-role jobs keep out of, so switching roles here
    // can never make one of them read under the wrong role. Listed in svrz_rc's
    // infrastructure.md and the club app's INFRA.md ("The shared VolleyManager
    // account"); move it only together with those tables.
    // A run that is no success (failed, partial, no game written) is tried
    // again after 15, 30 and 60 minutes, and a backend that starts with the
    // last success more than 26 h old catches up: both only inside that
    // referee-role window (VM_SYNC_WINDOW_UTC, default 22:00-01:00; 'any' once
    // OpenVolley has a VolleyManager account of its own). /health shows the
    // last success and the next try (vmSyncStatus).
    // VM_ICAL_FEEDS (since 27.11.2026): the public league calendars instead of
    // the login, which VolleyManager refuses. Set, it wins over the credentials:
    // no login, no role, and no referees in the schedule.
    // VM_GAME_CENTER_REGIONS (since 27.11.2026, e.g. "SVRZ"): the Swiss Volley
    // Game Center (svrz.ch's public schedule). Set, it wins over both: no login,
    // and the referees with their SV numbers come back.
    const vmIcalSet = !!process.env.VM_ICAL_FEEDS?.trim()
    const vmGameCenterSet = !!process.env.VM_GAME_CENTER_REGIONS?.trim()
    if (!IS_LOCAL && process.env.VM_SYNC !== 'off' && (vmGameCenterSet || vmIcalSet || (process.env.VM_USERNAME && process.env.VM_PASSWORD))) {
      import('./lib/vmSync.js').then((vm) => {
        const vmWindow = vm.windowFromEnv() // throws on a bad VM_SYNC_DAYS_* value
        const allowedWindow = vm.runWindowFromEnv() // throws on a bad VM_SYNC_WINDOW_UTC
        const feeds = vm.icalFeedsFromEnv() // throws on an entry that is no VolleyManager calendar
        const gameCenterRegions = vm.gameCenterRegionsFromEnv() // throws on a bad region code
        const noLogin = gameCenterRegions.length > 0 || feeds.length > 0
        // The calendars need no shared login, so no role window: daily at 09:00
        // Zurich, retries and catch-ups at any hour. The login keeps 22:30 UTC.
        const slot = noLogin ? { hourLocal: 9, minuteLocal: 0, tz: 'Europe/Zurich' } : { hourLocal: 22, minuteLocal: 30, tz: 'UTC' }
        const schedule = vm.scheduleVmSync({
          ...slot,
          run: () => vm.runVmSync({
            pool: layer.db.pool,
            window: vmWindow,
            feeds,
            gameCenterRegions,
            credentials: { username: process.env.VM_USERNAME, password: process.env.VM_PASSWORD },
            // the shared account's referee-delegate role (lib/vmSync.js VM_ROLE_FOR_GAMES)
            ...(process.env.VM_ROLE_ATTRIBUTE_GAMES ? { roleAttribute: process.env.VM_ROLE_ATTRIBUTE_GAMES } : {}),
            // the key of the register of people erased on request (db/052, lib/redactedPeople.js)
            redactionSecret: process.env.OV_PIN_SECRET || null
          }).catch((err) => { captureServerError(err, { kind: 'job.failed', view: 'vm sync' }); throw err }),
          retryDelaysMs: vm.VM_SYNC_RETRY_DELAYS_MS,
          allowedWindow: noLogin ? null : allowedWindow,
          catchUp: () => vm.readSyncRecord(layer.db.pool)
        })
        vmSync = { lib: vm, schedule }
        const source = gameCenterRegions.length ? `Game Center ${gameCenterRegions.join(', ')}, no login` : feeds.length ? `${feeds.length} league calendars, no login` : 'login'
        console.log(`[VM sync] scheduled (${source}), next run ` + (schedule.nextRunAt()?.toISOString() ?? 'n/a'))
      }).catch((err) => {
        console.error('❌ [VM sync] not started:', err.message)
      })
    } else if (!IS_LOCAL) {
      console.warn(`[VM sync] off (${process.env.VM_SYNC === 'off' ? 'VM_SYNC=off' : 'none of VM_GAME_CENTER_REGIONS, VM_ICAL_FEEDS, VM_USERNAME / VM_PASSWORD set'}): the official schedule is not refreshed`)
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
  try { publicStreams?.closeAll() } catch { /* ignore */ }
  for (const c of connections.values()) {
    try { c.ws.close(1001, 'Server shutting down') } catch { /* ignore */ }
  }
  server.close()
  Promise.resolve(dataLayer?.db.close()).catch(() => {}).finally(() => process.exit(0))
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
// A promise nobody waited for: logged and reported (lib/errorTracker.js), and
// the server keeps running (every relay room, PIN budget and sign session
// lives in this process; before, Node 22 ended it).
process.on('unhandledRejection', (reason) => {
  console.error('❌ [Server] unhandled rejection:', reason?.stack || reason)
  captureServerError(reason instanceof Error ? reason : new Error(String(reason?.message || reason)), { kind: 'server.unhandled' })
})
// An exception nothing caught: reported, then the process ends as before
// (restart: unless-stopped brings it back; the push monitor sees the restart),
// a moment later so the report can be written
process.on('uncaughtException', (err) => {
  console.error('❌ [Server] uncaught exception:', err?.stack || err)
  captureServerError(err, { kind: 'server.uncaught' })
  setTimeout(() => process.exit(1), 1500)
})

server.listen(PORT, () => {
  // The image's healthcheck watchdog kills this pid when /health/live stops answering
  if (process.env.OV_PID_FILE) {
    try { writeFileSync(process.env.OV_PID_FILE, String(process.pid)) } catch (err) { console.warn('[Server] pid file not written:', err.message) }
  }
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
