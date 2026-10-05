/**
 * Local-filesystem object storage: the self-hosted replacement for Supabase
 * Storage behind POST /api/storage/{upload,download,list}.
 *
 * Layout on disk:
 *   {root}/.ovdata                 sentinel; without it every write is refused
 *   {root}/.tmp/                   temp files for atomic writes (same filesystem)
 *   {root}/{bucket}/{path}         objects (buckets: scoresheets, backup)
 *
 * Request/response shapes mirror what frontend/src/lib/apiClient.js (apiStorage)
 * sends and what supabase-js returned, so the client does not change:
 *   upload   {bucket, path, fileBase64, contentType, upsert} -> {data:{path,id,fullPath}, error:null}
 *   download {bucket, path}                                   -> {data:<base64>, error:null}
 *   list     {bucket, path, options:{limit,offset,sortBy,search}} -> {data:[{name,id,created_at,updated_at,last_accessed_at,metadata}], error:null}
 *   signed-url                                                -> 404 (removed, no caller)
 * Errors come back as {data:null, error:{message, code}} with an HTTP status,
 * except a download of a missing object: 200 {data:null, error:{code:
 * 'OV_STORAGE_NOT_FOUND'}} (a normal answer, e.g. no log file or backup yet;
 * a 404 made every browser log a console error).
 *
 * Uploader-only buckets (options.uploaderReadBuckets, from the environment
 * 'scoresheets'): the account that CREATES an object owns it. The owner record
 * is {root}/.owners/{bucket}/{sha256(key)}.json = {"key", "owners":[...]}.
 *   - download: owners only (403 OV_STORAGE_FORBIDDEN for anyone else);
 *   - upload to an existing object: owners only (403 otherwise), so uploading
 *     to a path never adds the caller to someone else's object;
 *   - list: only the objects the caller owns (folders are always shown);
 *   - record and commit of one key run under one in-process lock, so a reader
 *     never sees an object with a stale record (one server process per root).
 * The scorer app names its scoresheets with a 128-bit random part
 * ({date}/game{n}_k{32 hex}_final.json), so a stranger cannot claim the path of
 * a real scoresheet before the scorer uploads it.
 *
 * Usage (see README "Self-hosted storage" section for the server.js wiring):
 *   import { createStorage, storageOptionsFromEnv } from './lib/storage.js'
 *   const storage = createStorage(storageOptionsFromEnv(process.env))
 *   // read the JSON body with a cap of storage.maxBodyBytes (not MAX_MATCH_BODY_SIZE);
 *   // when it is exceeded answer with storage.bodyTooLarge() (413 OV_STORAGE_TOO_LARGE)
 *   const { status, body } = await storage.handle('upload', parsedJsonBody, { userId })
 *
 * No dependencies beyond node: built-ins. Node >= 22 (fs.statfs, String#isWellFormed).
 */

import { promises as fsp, constants as fsc } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const DEFAULT_ROOT = '/data/storage'
export const DEFAULT_BUCKETS = Object.freeze(['scoresheets', 'backup'])
export const SENTINEL_NAME = '.ovdata'
export const TMP_DIR_NAME = '.tmp'
export const OWNERS_DIR_NAME = '.owners'
export const DEFAULT_CONTENT_TYPES = Object.freeze(['application/json', 'text/plain', 'application/pdf'])
export const SIGNED_URL_REMOVED = true

/** Owner list cap per object (uploads only ever record one; the rest is operator grants). */
export const MAX_OWNERS = 16

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULTS = Object.freeze({
  maxFileBytes: 5 * MiB,          // server.js must read bodies up to storage.maxBodyBytes for this to hold
  maxDownloadBytes: 64 * MiB,     // guard for migrated/foreign files
  // Free-space floor per bucket. backup/ stops first, so the last 2 GiB stay
  // for scoresheets; scoresheets/ keeps a small floor so the volume never hits ENOSPC.
  minFreeBytes: Object.freeze({ scoresheets: 256 * MiB, backup: 2 * GiB }),
  listDefaultLimit: 100,          // supabase-js default
  listMaxLimit: 1000,
  maxPathLength: 1024,
  maxSegments: 32,
  maxSegmentBytes: 255,
  tmpMaxAgeMs: 60 * 60 * 1000,
  sweepMaxAgeMs: 30 * DAY_MS,
  sweepDirGraceMs: 5 * 60 * 1000  // sweep never removes a folder touched this recently
})

/** Base64 + JSON envelope overhead allowance for the HTTP body cap. */
const BODY_OVERHEAD_BYTES = 64 * 1024

/** JSON body size server.js must accept so an upload of maxFileBytes is not cut off. */
export function maxBodyBytesFor(maxFileBytes) {
  return Math.ceil((maxFileBytes * 4) / 3) + BODY_OVERHEAD_BYTES
}

const EXT_CONTENT_TYPES = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.pdf': 'application/pdf'
}

const SORT_COLUMNS = new Set(['name', 'created_at', 'updated_at', 'last_accessed_at'])
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// Written with \u escapes only, so no invisible character sits in the source.
//   \u0000-\u001f \u007f-\u009f  C0, DEL, C1 controls (incl. U+0085 NEL)
//   \u00ad \u061c \u180e         soft hyphen, Arabic letter mark, Mongolian vowel separator
//   \u200b-\u200f                zero-width space/joiners, LRM/RLM
//   \u2028-\u202e                line/paragraph separators, bidi embeddings/overrides
//   \u2060-\u206f                word joiner, invisible operators, bidi isolates
//   \ufeff \ufff9-\ufffb         BOM / ZWNBSP, interlinear annotation
//   \u2044 \u2215 \u2216 \u29f8 \u29f9 \ufe68 \uff0f \uff3c
//                                slash / backslash look-alikes that NFKC keeps as-is
//   \\ : < > " | ? *             backslash, and characters Windows (NTFS) refuses or
//                                reads specially (':' opens an alternate data stream)
const FORBIDDEN_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u2044\u2215\u2216\u29f8\u29f9\ufe68\uff0f\uff3c\\:<>"|?*]/
// Windows device names, with or without an extension (CON, nul.json, COM1.txt, ...).
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

// ==================== Errors ====================

export class StorageError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'StorageError'
    this.status = status
    this.code = code
  }
}

const err = {
  invalidRequest: (msg = 'Invalid request') => new StorageError(400, 'OV_STORAGE_INVALID_REQUEST', msg),
  invalidBucket: () => new StorageError(400, 'OV_STORAGE_INVALID_BUCKET', 'Invalid bucket'),
  invalidPath: () => new StorageError(400, 'OV_STORAGE_INVALID_PATH', 'Invalid file path'),
  symlink: () => new StorageError(403, 'OV_STORAGE_INVALID_PATH', 'Invalid file path'),
  forbidden: () => new StorageError(403, 'OV_STORAGE_FORBIDDEN', 'Not allowed to access this path'),
  notFound: () => new StorageError(404, 'OV_STORAGE_NOT_FOUND', 'Object not found'),
  exists: () => new StorageError(409, 'OV_STORAGE_EXISTS', 'The resource already exists'),
  conflict: () => new StorageError(409, 'OV_STORAGE_CONFLICT', 'Path conflicts with an existing folder or file'),
  tooLarge: () => new StorageError(413, 'OV_STORAGE_TOO_LARGE', 'File too large'),
  contentType: () => new StorageError(415, 'OV_STORAGE_CONTENT_TYPE', 'Content type not allowed'),
  quota: (msg) => new StorageError(429, 'OV_STORAGE_QUOTA', msg || 'Storage quota exceeded'),
  unavailable: () => new StorageError(503, 'OV_STORAGE_UNAVAILABLE', 'Storage is not available'),
  lowSpace: () => new StorageError(507, 'OV_STORAGE_LOW_SPACE', 'Not enough free storage space')
}

// ==================== Pure helpers (exported for tests and server.js) ====================

/**
 * Validate and normalise an object path into segments.
 * Returns an array of NFC-normalised segments, or null when the path is unsafe.
 * With allowEmpty (list), '' / null / undefined mean the bucket root and one
 * trailing '/' is tolerated.
 */
export function parseStoragePath(input, { allowEmpty = false, maxPathLength = DEFAULTS.maxPathLength, maxSegments = DEFAULTS.maxSegments, maxSegmentBytes = DEFAULTS.maxSegmentBytes } = {}) {
  if (input === undefined || input === null) return allowEmpty ? [] : null
  if (typeof input !== 'string') return null
  if (input.length > maxPathLength) return null
  if (!input.isWellFormed()) return null
  let s = input.normalize('NFC')
  if (allowEmpty) {
    if (s.endsWith('/')) s = s.slice(0, -1)
    if (s === '') return []
  }
  if (s === '' || s.startsWith('/')) return null
  if (FORBIDDEN_CHARS_RE.test(s)) return null
  const segs = s.split('/')
  if (segs.length > maxSegments) return null
  for (const seg of segs) {
    if (!seg) return null                       // leading, trailing or double slash
    if (seg.startsWith('.')) return null        // '.', '..', hidden names, our own .tmp/.ovdata
    if (seg.endsWith('.') || seg.endsWith(' ')) return null // Windows strips these: 'a.' and 'a' collide
    if (Buffer.byteLength(seg, 'utf8') > maxSegmentBytes) return null
    // Compatibility forms must not smuggle in dots or separators (e.g. U+FF0E, U+2025, U+FF0F).
    const k = seg.normalize('NFKC')
    if (k.startsWith('.') || k.includes('/') || FORBIDDEN_CHARS_RE.test(k)) return null
    if (WINDOWS_RESERVED_RE.test(k)) return null
  }
  return segs
}

/** Lower-cased media type without parameters ("text/plain; charset=utf-8" -> "text/plain"). */
export function normalizeContentType(contentType, fileName = '') {
  if (typeof contentType === 'string' && contentType.trim()) {
    return contentType.split(';')[0].trim().toLowerCase()
  }
  const ext = path.extname(fileName).toLowerCase()
  return EXT_CONTENT_TYPES[ext] || 'application/octet-stream'
}

/**
 * Approved-match scoresheets ({YYYY-MM-DD}/game{n}_final.json, exactly the
 * shape scoresheetUploader writes) are exempt from the write *count*; their
 * bytes are still counted (see createWriteQuota).
 */
const FINAL_SCORESHEET_RE = /^\d{4}-\d{2}-\d{2}\/game[^/]+_final\.json$/
export function isRateLimitExempt({ bucket, path: p } = {}) {
  return bucket === 'scoresheets' && typeof p === 'string' && FINAL_SCORESHEET_RE.test(p)
}

/** Stable UUID-shaped id for an object key (supabase returned a uuid). */
export function objectId(bucket, key) {
  const h = crypto.createHash('sha256').update(`${bucket}/${key}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function decodeBase64(b64) {
  if (typeof b64 !== 'string') throw err.invalidRequest('fileBase64 must be a base64 string')
  const clean = b64.replace(/\s+/g, '')
  if (clean.length % 4 === 1 || !BASE64_RE.test(clean)) throw err.invalidRequest('fileBase64 is not valid base64')
  return Buffer.from(clean, 'base64')
}

function clampInt(v, def, min, max) {
  const n = Number(v)
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function isCode(e, ...codes) {
  return e && codes.includes(e.code)
}

/**
 * Ready-made per-user write quota for the checkQuota hook: a fixed window of
 * maxWrites uploads and maxBytes per user. Exempt paths (default: approved
 * scoresheets, see isRateLimitExempt) skip the write count but are charged to
 * their own byte budget (exemptMaxBytes, default = maxBytes), so ordinary
 * writes cannot starve them and they cannot be used to bypass the byte cap.
 */
export function createWriteQuota({ windowMs = 60_000, maxWrites = 300, maxBytes = 200 * MiB, exemptMaxBytes = maxBytes, exempt = isRateLimitExempt, now = Date.now } = {}) {
  const usage = new Map()
  let lastPrune = now()
  const refuse = { ok: false, message: 'Storage write quota exceeded, try again later' }
  return function checkQuota({ userId, bucket, path: p, size }) {
    const isExempt = Boolean(exempt && exempt({ bucket, path: p }))
    const t = now()
    if (t - lastPrune > windowMs) {
      for (const [k, v] of usage) if (t - v.start >= windowMs) usage.delete(k)
      lastPrune = t
    }
    const key = userId || 'anonymous'
    let u = usage.get(key)
    if (!u || t - u.start >= windowMs) {
      u = { start: t, writes: 0, bytes: 0, exemptBytes: 0 }
      usage.set(key, u)
    }
    if (isExempt) {
      if (u.exemptBytes + size > exemptMaxBytes) return refuse
      u.exemptBytes += size
      return true
    }
    if (u.writes + 1 > maxWrites || u.bytes + size > maxBytes) return refuse
    u.writes += 1
    u.bytes += size
    return true
  }
}

/**
 * Options from environment variables:
 *   STORAGE_DIR                      root (default /data/storage)
 *   STORAGE_BACKUP_MIN_FREE_MB       free-space floor for backup/ writes (default 2048)
 *   STORAGE_SCORESHEETS_MIN_FREE_MB  free-space floor for scoresheets/ writes (default 256)
 *   STORAGE_MAX_FILE_MB              per-object size cap (default 5)
 *   STORAGE_OWNER_SCOPE              off | require | prefix (default off; Phase 7 security release)
 *   STORAGE_UPLOADER_READ_BUCKETS    comma-separated buckets only an object's uploader may
 *                                    download (default 'scoresheets'; 'none' turns it off)
 * Throws on a value it does not understand, so a typo fails at startup
 * instead of silently running with the default.
 */
export function storageOptionsFromEnv(env = process.env) {
  const opts = { root: env.STORAGE_DIR || DEFAULT_ROOT }
  const megabytes = (name, { allowZero }) => {
    const raw = env[name]
    if (raw === undefined || String(raw).trim() === '') return undefined
    const mb = Number(raw)
    if (!Number.isFinite(mb) || mb < 0 || (!allowZero && mb === 0)) {
      throw new TypeError(`storage: invalid ${name}=${JSON.stringify(raw)}`)
    }
    return Math.round(mb * MiB)
  }
  const floors = {}
  const backupFloor = megabytes('STORAGE_BACKUP_MIN_FREE_MB', { allowZero: true })
  const sheetsFloor = megabytes('STORAGE_SCORESHEETS_MIN_FREE_MB', { allowZero: true })
  if (backupFloor !== undefined) floors.backup = backupFloor
  if (sheetsFloor !== undefined) floors.scoresheets = sheetsFloor
  if (Object.keys(floors).length) opts.minFreeBytes = floors
  const maxFile = megabytes('STORAGE_MAX_FILE_MB', { allowZero: false })
  if (maxFile !== undefined) opts.maxFileBytes = maxFile
  const scope = (env.STORAGE_OWNER_SCOPE || '').trim().toLowerCase()
  if (scope === 'require' || scope === 'prefix') opts.ownerScope = scope
  else if (scope !== '' && scope !== 'off') {
    throw new TypeError(`storage: STORAGE_OWNER_SCOPE must be off, require or prefix (got ${JSON.stringify(env.STORAGE_OWNER_SCOPE)})`)
  }
  const readRaw = env.STORAGE_UPLOADER_READ_BUCKETS
  const readList = readRaw === undefined || String(readRaw).trim() === '' ? 'scoresheets' : String(readRaw).trim().toLowerCase()
  if (readList === 'none') {
    opts.uploaderReadBuckets = []
  } else {
    const names = readList.split(',').map((b) => b.trim()).filter(Boolean)
    if (!names.length || names.some((b) => !DEFAULT_BUCKETS.includes(b))) {
      throw new TypeError(`storage: STORAGE_UPLOADER_READ_BUCKETS must be none or a list of ${DEFAULT_BUCKETS.join(', ')} (got ${JSON.stringify(readRaw)})`)
    }
    opts.uploaderReadBuckets = [...new Set(names)]
  }
  return opts
}

// ==================== Factory ====================

/**
 * @param {object} [options]
 * @param {string}   [options.root='/data/storage']
 * @param {string[]} [options.buckets=['scoresheets','backup']]
 * @param {number}   [options.maxFileBytes=5 MiB]
 * @param {number}   [options.maxDownloadBytes=64 MiB]
 * @param {string[]} [options.allowedContentTypes] media types accepted on upload
 * @param {Object<string,number>} [options.minFreeBytes={scoresheets: 256 MiB, backup: 2 GiB}] per-bucket free-space floor
 * @param {(ctx:{userId,bucket,path,size,contentType}) => (boolean|{ok:boolean,message?:string}|Promise)} [options.checkQuota]
 *        per-user write quota hook, called once the write is otherwise known to
 *        succeed (after the path, existence and free-space checks);
 *        false / {ok:false} refuses with 429
 * @param {false|'require'|'prefix'|Function} [options.ownerScope=false]
 *        'require': the first path segment must be the caller's user id;
 *        'prefix': the user id is prepended transparently;
 *        function({op,userId,bucket,path}) returning (or resolving to):
 *          true          allow, path unchanged (predicate style)
 *          string        allow, use this path instead (re-validated)
 *          anything else (false, null, undefined, objects, numbers) -> 403
 * @param {string[]} [options.ownerScopeBuckets] buckets the owner scope applies to (default: all)
 * @param {string[]} [options.uploaderReadBuckets=[]] buckets whose objects only
 *        the accounts that uploaded them may download (owner records under
 *        {root}/.owners; an upload there needs a userId)
 * @param {Function} [options.statfs] injectable fs.statfs (tests)
 * @param {Function} [options.now] injectable clock (ms)
 * @param {object}   [options.logger=console]
 */
export function createStorage(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT)
  const buckets = new Set(options.buckets || DEFAULT_BUCKETS)
  const maxFileBytes = options.maxFileBytes ?? DEFAULTS.maxFileBytes
  const maxDownloadBytes = options.maxDownloadBytes ?? DEFAULTS.maxDownloadBytes
  const allowedContentTypes = new Set((options.allowedContentTypes || DEFAULT_CONTENT_TYPES).map((t) => t.toLowerCase()))
  const minFreeBytes = { ...DEFAULTS.minFreeBytes, ...(options.minFreeBytes || {}) }
  const listDefaultLimit = options.listDefaultLimit ?? DEFAULTS.listDefaultLimit
  const listMaxLimit = options.listMaxLimit ?? DEFAULTS.listMaxLimit
  const maxBodyBytes = maxBodyBytesFor(maxFileBytes)
  const sweepDirGraceMs = options.sweepDirGraceMs ?? DEFAULTS.sweepDirGraceMs
  const checkQuota = options.checkQuota || null
  const ownerScope = options.ownerScope || false
  const ownerScopeBuckets = new Set(options.ownerScopeBuckets || buckets)
  const uploaderReadBuckets = new Set(options.uploaderReadBuckets || [])
  const statfs = options.statfs || ((p) => fsp.statfs(p))
  const now = options.now || Date.now
  const logger = options.logger || console
  const pathLimits = {
    maxPathLength: options.maxPathLength ?? DEFAULTS.maxPathLength,
    maxSegments: options.maxSegments ?? DEFAULTS.maxSegments,
    maxSegmentBytes: options.maxSegmentBytes ?? DEFAULTS.maxSegmentBytes
  }
  const O_NOFOLLOW = fsc.O_NOFOLLOW || 0

  if (ownerScope && !['require', 'prefix'].includes(ownerScope) && typeof ownerScope !== 'function') {
    throw new TypeError(`storage: unknown ownerScope ${String(ownerScope)}`)
  }
  for (const b of uploaderReadBuckets) {
    if (!buckets.has(b)) throw new TypeError(`storage: uploaderReadBuckets has unknown bucket ${String(b)}`)
  }

  // ---------- path resolution ----------

  function assertBucket(bucket) {
    if (typeof bucket !== 'string' || !buckets.has(bucket)) throw err.invalidBucket()
  }

  function parse(p, allowEmpty = false) {
    const segs = parseStoragePath(p, { allowEmpty, ...pathLimits })
    if (!segs) throw err.invalidPath()
    return segs
  }

  /** Apply the owner-scoping policy; returns the segments actually used on disk. */
  async function scope(op, bucket, segs, userId) {
    if (!ownerScope || !ownerScopeBuckets.has(bucket)) return segs
    if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) throw err.forbidden()
    if (ownerScope === 'prefix') return [userId, ...segs]
    if (ownerScope === 'require') {
      if (segs[0] !== userId) throw err.forbidden()
      return segs
    }
    const out = await ownerScope({ op, userId, bucket, path: segs.join('/') })
    if (out === true) return segs
    if (typeof out !== 'string') throw err.forbidden()
    const scoped = parseStoragePath(out, { allowEmpty: op === 'list', ...pathLimits })
    if (!scoped) throw err.forbidden()
    return scoped
  }

  async function realRoot() {
    try {
      const rr = await fsp.realpath(root)
      const st = await fsp.stat(rr)
      if (!st.isDirectory()) throw err.unavailable()
      return rr
    } catch (e) {
      if (e instanceof StorageError) throw e
      throw err.unavailable()
    }
  }

  /**
   * Make sure `dir` is a real directory (not a symlink), creating it when asked.
   * Returns false when it does not exist and create is off.
   */
  async function ensureDir(dir, create) {
    let st
    try {
      st = await fsp.lstat(dir)
    } catch (e) {
      if (!isCode(e, 'ENOENT')) throw e
      if (!create) return false
      try {
        await fsp.mkdir(dir, { mode: 0o750 })
      } catch (e2) {
        if (!isCode(e2, 'EEXIST')) throw e2
      }
      st = await fsp.lstat(dir)
    }
    if (st.isSymbolicLink()) throw err.symlink()
    if (!st.isDirectory()) {
      if (create) throw err.conflict()
      return false
    }
    return true
  }

  /**
   * Resolve bucket + segments to an absolute path inside {realRoot}/{bucket},
   * walking every directory component with lstat so no symlink is followed.
   * Returns { rr, bucketDir, dir, target } or null if a directory is missing
   * (only when create is false).
   */
  async function resolve(bucket, segs, { create = false, isDir = false } = {}) {
    const rr = await realRoot()
    const bucketDir = path.join(rr, bucket)
    const target = path.resolve(bucketDir, ...segs)
    if (target !== bucketDir && !target.startsWith(bucketDir + path.sep)) throw err.invalidPath()
    if (!(await ensureDir(bucketDir, create))) return null
    const dirSegs = isDir ? segs : segs.slice(0, -1)
    let cur = bucketDir
    for (const seg of dirSegs) {
      cur = path.join(cur, seg)
      if (!(await ensureDir(cur, create))) return null
    }
    // Belt and braces: the canonical path must be exactly what we built.
    const canon = await fsp.realpath(cur)
    if (canon !== cur) throw err.symlink()
    return { rr, bucketDir, dir: cur, target }
  }

  // ---------- guards ----------

  async function sentinelPresent(rr) {
    try {
      const st = await fsp.lstat(path.join(rr, SENTINEL_NAME))
      return st.isFile()
    } catch {
      return false
    }
  }

  async function assertWritable() {
    let rr
    try {
      rr = await realRoot()
    } catch (e) {
      logger.error?.('[Storage] root not available:', root)
      throw e
    }
    if (!(await sentinelPresent(rr))) {
      logger.error?.(`[Storage] sentinel ${SENTINEL_NAME} missing in ${root}; refusing writes (volume not mounted?)`)
      throw err.unavailable()
    }
    return rr
  }

  async function freeBytes(rr) {
    const st = await statfs(rr)
    return Number(st.bavail) * Number(st.bsize)
  }

  async function assertFreeSpace(rr, bucket, size) {
    let free
    try {
      free = await freeBytes(rr)
    } catch (e) {
      logger.error?.('[Storage] statfs failed:', e.message)
      throw err.unavailable()
    }
    const floor = minFreeBytes[bucket] || 0
    if (free - size < floor) {
      logger.warn?.(`[Storage] refusing ${bucket}/ write: ${Math.round(free / MiB)} MB free, floor ${Math.round(floor / MiB)} MB`)
      throw err.lowSpace()
    }
  }

  async function runQuota(ctx) {
    if (!checkQuota) return
    const r = await checkQuota(ctx)
    if (r === false) throw err.quota()
    if (r && typeof r === 'object' && r.ok === false) throw err.quota(r.message)
  }

  // ---------- owner records (uploader-only buckets) ----------

  // One record per object, under a hashed name: no nested folders to walk, and
  // the record can never collide with an object or another record.
  async function ownersFile(rr, bucket, key, create) {
    const dir = path.join(rr, OWNERS_DIR_NAME)
    if (!(await ensureDir(dir, create))) return null
    const bucketDir = path.join(dir, bucket)
    if (!(await ensureDir(bucketDir, create))) return null
    const h = crypto.createHash('sha256').update(key).digest('hex')
    return path.join(bucketDir, `${h}.json`)
  }

  async function readOwners(rr, bucket, key) {
    const file = await ownersFile(rr, bucket, key, false)
    if (!file) return []
    let fh
    try {
      fh = await fsp.open(file, fsc.O_RDONLY | O_NOFOLLOW)
      const rec = JSON.parse(await fh.readFile('utf8'))
      return Array.isArray(rec?.owners) ? rec.owners.filter((o) => typeof o === 'string') : []
    } catch (e) {
      if (isCode(e, 'ENOENT')) return []
      if (e instanceof SyntaxError) {
        logger.error?.('[Storage] unreadable owner record for', bucket)
        return []
      }
      throw e
    } finally {
      await fh?.close().catch(() => {})
    }
  }

  // Owner check, record write and object commit of one key run one after the
  // other (in-process: one server process per storage root).
  const ownerLocks = new Map()
  function withOwnerLock(id, fn) {
    const prev = ownerLocks.get(id) || Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => {})
    ownerLocks.set(id, tail)
    tail.then(() => { if (ownerLocks.get(id) === tail) ownerLocks.delete(id) })
    return run
  }

  const ownerLockId = (bucket, key) => `${bucket}/${key}`

  /**
   * Replace the owner record of bucket/key (atomic rewrite). Callers hold the
   * key's owner lock. The record keeps the key so sweep() can drop records
   * whose object is gone.
   */
  async function writeOwners(rr, bucket, key, owners) {
    const file = await ownersFile(rr, bucket, key, true)
    const tmpDir = path.join(rr, TMP_DIR_NAME)
    await ensureDir(tmpDir, true)
    const tmp = path.join(tmpDir, `${crypto.randomUUID()}.part`)
    try {
      const fh = await fsp.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | O_NOFOLLOW, 0o640)
      try {
        await fh.writeFile(JSON.stringify({ key, owners: [...new Set(owners)].slice(0, MAX_OWNERS) }))
        await fh.sync()
      } finally {
        await fh.close()
      }
      await fsp.rename(tmp, file)
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }
  }

  /** lstat of an object; null when there is none. */
  async function objectStat(bucket, segs) {
    const r = await resolve(bucket, segs)
    if (!r) return null
    try {
      return await fsp.lstat(r.target)
    } catch (e) {
      if (isCode(e, 'ENOENT', 'ENOTDIR')) return null
      throw e
    }
  }

  /**
   * Operator tool (scripts/storage-owner.mjs, never reachable over HTTP): read
   * or change who may read an existing object in an uploader-only bucket, e.g.
   * to hand a scoresheet stored before owner records existed to the scorer who
   * uploaded it. mode 'add' appends userIds, 'set' replaces the list ([] = nobody).
   * Returns the new owner list.
   */
  async function setOwners({ bucket, path: p, userIds = [], mode = 'add' } = {}) {
    assertBucket(bucket)
    if (!uploaderReadBuckets.has(bucket)) throw err.invalidBucket()
    if (!['add', 'set'].includes(mode)) throw err.invalidRequest('mode must be add or set')
    if (!Array.isArray(userIds) || userIds.some((u) => typeof u !== 'string' || !USER_ID_RE.test(u))) throw err.invalidRequest('invalid user id')
    const segs = parse(p)
    const rr = await assertWritable()
    const key = segs.join('/')
    return withOwnerLock(ownerLockId(bucket, key), async () => {
      const st = await objectStat(bucket, segs)
      if (!st || !st.isFile()) throw err.notFound()
      const owners = mode === 'set' ? userIds : [...(await readOwners(rr, bucket, key)), ...userIds]
      await writeOwners(rr, bucket, key, owners)
      return readOwners(rr, bucket, key)
    })
  }

  /** Current owners of an object (operator tool). */
  async function getOwners({ bucket, path: p } = {}) {
    assertBucket(bucket)
    const segs = parse(p)
    const rr = await realRoot()
    return readOwners(rr, bucket, segs.join('/'))
  }

  // ---------- operations ----------

  /**
   * Store an object atomically (temp file in {root}/.tmp, fsync, rename/link).
   * upsert defaults to true (as server.js did); upsert:false on an existing
   * object fails with 409 OV_STORAGE_EXISTS without touching it.
   */
  async function upload({ bucket, path: p, fileBase64, data, contentType, upsert, userId } = {}) {
    assertBucket(bucket)
    const segs = parse(p)
    const diskSegs = await scope('write', bucket, segs, userId)
    const ct = normalizeContentType(contentType, segs[segs.length - 1])
    if (!allowedContentTypes.has(ct)) throw err.contentType()
    let buf
    if (data !== undefined) {
      if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw err.invalidRequest('data must be a Buffer')
      buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    } else {
      buf = decodeBase64(fileBase64)
    }
    if (buf.length > maxFileBytes) throw err.tooLarge()

    // Uploader-only bucket: no account, no object (nobody could read it back)
    const uploaderOnly = uploaderReadBuckets.has(bucket)
    if (uploaderOnly && (typeof userId !== 'string' || !USER_ID_RE.test(userId))) throw err.forbidden()

    const rr = await assertWritable()
    await assertFreeSpace(rr, bucket, buf.length)

    const key = diskSegs.join('/')
    const write = () => writeObject({ rr, bucket, segs, diskSegs, key, buf, ct, doUpsert: upsert !== false, userId, uploaderOnly })
    await (uploaderOnly ? withOwnerLock(ownerLockId(bucket, key), write) : write())

    const clientPath = segs.join('/')
    return { path: clientPath, id: objectId(bucket, key), fullPath: `${bucket}/${clientPath}` }
  }

  async function writeObject({ rr, bucket, segs, diskSegs, key, buf, ct, doUpsert, userId, uploaderOnly }) {
    let { dir, target } = await resolve(bucket, diskSegs, { create: true })

    // Existing entry checks (a symlink or folder at the target is never replaced).
    let existing = false
    try {
      const st = await fsp.lstat(target)
      if (st.isSymbolicLink()) throw err.symlink()
      if (!st.isFile()) throw err.conflict()
      existing = true
    } catch (e) {
      if (!isCode(e, 'ENOENT')) throw e
    }
    // Only an owner may replace an object in an uploader-only bucket (also
    // before the 409, so a stranger cannot even probe for it). Objects stored
    // before owner records existed have none: nobody replaces them.
    if (existing && uploaderOnly && !(await readOwners(rr, bucket, key)).includes(userId)) throw err.forbidden()
    if (existing && !doUpsert) throw err.exists()

    // Charged only for a write that is otherwise going ahead (no quota spent on 4xx refusals).
    await runQuota({ userId: userId ?? null, bucket, path: segs.join('/'), size: buf.length, contentType: ct })

    // A new object: its creator is its only owner, replacing any stale record
    // left by an object that is gone. Written before the commit and under the
    // key's lock, so the object is never readable under an older record; a
    // failed commit leaves a record for a missing object, which the next
    // creator replaces and sweep() removes. An existing object keeps its record.
    if (uploaderOnly && !existing) await writeOwners(rr, bucket, key, [userId])

    const tmpDir = path.join(rr, TMP_DIR_NAME)
    await ensureDir(tmpDir, true)
    const tmp = path.join(tmpDir, `${crypto.randomUUID()}.part`)
    try {
      const fh = await fsp.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | O_NOFOLLOW, 0o640)
      try {
        await fh.writeFile(buf)
        await fh.sync()
      } finally {
        await fh.close()
      }
      try {
        await commit(tmp, target, doUpsert)
      } catch (e) {
        if (!isCode(e, 'ENOENT')) throw e
        // The target folder vanished between resolve() and the rename (sweep()
        // removing a folder it had just emptied): recreate it and retry once.
        ;({ dir, target } = await resolve(bucket, diskSegs, { create: true }))
        await commit(tmp, target, doUpsert)
      }
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }
    await syncDir(dir)
  }

  /** Move the finished temp file into place (rename for upsert, link() otherwise). */
  async function commit(tmp, target, doUpsert) {
    if (doUpsert) {
      await fsp.rename(tmp, target)
      return
    }
    // link() fails atomically with EEXIST if someone else won the race.
    try {
      await fsp.link(tmp, target)
    } catch (e) {
      if (isCode(e, 'EEXIST')) throw err.exists()
      if (!isCode(e, 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV')) throw e
      // Filesystem without hard links: best-effort non-atomic fallback.
      try {
        await fsp.lstat(target)
        throw err.exists()
      } catch (e2) {
        if (!isCode(e2, 'ENOENT')) throw e2
      }
      await fsp.rename(tmp, target)
    }
  }

  async function syncDir(dir) {
    let fh
    try {
      fh = await fsp.open(dir, fsc.O_RDONLY)
      await fh.sync()
    } catch {
      // best effort (not supported on every platform)
    } finally {
      await fh?.close().catch(() => {})
    }
  }

  /** Read an object; returns a Buffer. */
  async function download({ bucket, path: p, userId } = {}) {
    assertBucket(bucket)
    const segs = parse(p)
    const diskSegs = await scope('read', bucket, segs, userId)
    const r = await resolve(bucket, diskSegs)
    if (!r) throw err.notFound()
    let fh
    try {
      const st = await fsp.lstat(r.target)
      if (st.isSymbolicLink()) throw err.symlink()
      if (!st.isFile()) throw err.notFound()
      fh = await fsp.open(r.target, fsc.O_RDONLY | O_NOFOLLOW)
      const fst = await fh.stat()
      if (!fst.isFile()) throw err.notFound()
      // Uploader-only bucket: an existing object is read only by its owners
      // (objects stored before owners were recorded have none: 403 for all)
      if (uploaderReadBuckets.has(bucket)) {
        const owners = typeof userId === 'string' ? await readOwners(r.rr, bucket, diskSegs.join('/')) : []
        if (!owners.includes(userId)) throw err.forbidden()
      }
      if (fst.size > maxDownloadBytes) throw err.tooLarge()
      return await fh.readFile()
    } catch (e) {
      if (isCode(e, 'ENOENT', 'ENOTDIR')) throw err.notFound()
      if (isCode(e, 'ELOOP')) throw err.symlink()
      throw e
    } finally {
      await fh?.close().catch(() => {})
    }
  }

  function fileEntry(bucket, key, name, st) {
    const born = st.birthtimeMs > 0 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs
    const created = new Date(born).toISOString()
    const updated = st.mtime.toISOString()
    const mimetype = normalizeContentType(undefined, name)
    return {
      name,
      id: objectId(bucket, key),
      created_at: created,
      updated_at: updated,
      last_accessed_at: updated,
      metadata: {
        eTag: `"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`,
        size: st.size,
        mimetype,
        cacheControl: 'max-age=3600',
        lastModified: updated,
        contentLength: st.size,
        httpStatusCode: 200
      }
    }
  }

  function folderEntry(name) {
    return { name, id: null, created_at: null, updated_at: null, last_accessed_at: null, metadata: null }
  }

  /**
   * List the immediate children of a folder, supabase-style. Folders appear as
   * {name, id:null, ...null}. Options: limit (default 100, max 1000), offset,
   * sortBy {column: name|created_at|updated_at|last_accessed_at, order: asc|desc},
   * search (case-insensitive prefix of the name, like supabase's ILIKE search || '%').
   * A missing folder gives [].
   */
  async function list({ bucket, path: p, options, userId } = {}) {
    assertBucket(bucket)
    const segs = parse(p ?? '', true)
    const diskSegs = await scope('list', bucket, segs, userId)
    const opts = options && typeof options === 'object' ? options : {}
    const limit = clampInt(opts.limit, listDefaultLimit, 1, listMaxLimit)
    const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const column = SORT_COLUMNS.has(opts.sortBy?.column) ? opts.sortBy.column : 'name'
    const desc = String(opts.sortBy?.order || 'asc').toLowerCase() === 'desc'
    const search = typeof opts.search === 'string' ? opts.search.slice(0, 256).toLowerCase() : ''

    const r = await resolve(bucket, diskSegs, { isDir: true })
    if (!r) return []
    let dirents
    try {
      dirents = await fsp.readdir(r.dir, { withFileTypes: true })
    } catch (e) {
      if (isCode(e, 'ENOENT', 'ENOTDIR')) return []
      throw e
    }
    const keyPrefix = diskSegs.length ? diskSegs.join('/') + '/' : ''
    // Filter on the dirent alone first; symlinks, sockets and devices are never listed.
    let candidates = dirents.filter((d) => {
      if (d.name.startsWith('.')) return false
      if (search && !d.name.toLowerCase().startsWith(search)) return false
      return d.isDirectory() || d.isFile()
    })
    // Uploader-only bucket: a caller sees only the objects it owns (the names
    // carry the unguessable part of a scoresheet path); folders are shown.
    if (uploaderReadBuckets.has(bucket)) {
      const uid = typeof userId === 'string' ? userId : null
      const visible = await Promise.all(candidates.map(async (d) =>
        d.isDirectory() || (uid !== null && (await readOwners(r.rr, bucket, keyPrefix + d.name)).includes(uid))))
      candidates = candidates.filter((_, i) => visible[i])
    }
    const byName = (a, b) => {
      const c = a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      return desc ? -c : c
    }
    const toEntries = async (ds) => {
      const out = await Promise.all(ds.map(async (d) => {
        if (d.isDirectory()) return folderEntry(d.name)
        try {
          const st = await fsp.lstat(path.join(r.dir, d.name))
          return st.isFile() ? fileEntry(bucket, keyPrefix + d.name, d.name, st) : null
        } catch {
          return null // raced with a delete: skip
        }
      }))
      return out.filter(Boolean)
    }

    if (column === 'name') {
      // Every caller sorts by name: page on the names, stat only that page
      // (backup/backups/backup_g1 can hold tens of thousands of snapshots).
      candidates.sort(byName)
      return toEntries(candidates.slice(offset, offset + limit))
    }

    const entries = await toEntries(candidates)
    entries.sort((a, b) => {
      const av = a[column]
      const bv = b[column]
      if (av !== bv) {
        // Postgres semantics: NULLS LAST for ASC, NULLS FIRST for DESC.
        if (av === null) return desc ? -1 : 1
        if (bv === null) return desc ? 1 : -1
        const c = av < bv ? -1 : 1
        return desc ? -c : c
      }
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
    return entries.slice(offset, offset + limit)
  }

  /**
   * Delete files older than maxAgeMs below bucket/prefix (default backup/backups,
   * 30 days), then remove emptied folders. Symlinks are never followed. Also
   * removes stale temp files. Needs the sentinel. Returns counts.
   */
  async function sweep({ bucket = 'backup', prefix = 'backups', maxAgeMs = DEFAULTS.sweepMaxAgeMs } = {}) {
    assertBucket(bucket)
    const rr = await assertWritable()
    const tmpRemoved = await sweepTemp(rr)
    const segs = parse(prefix, true)
    const r = await resolve(bucket, segs, { isDir: true })
    const result = { deletedFiles: 0, deletedBytes: 0, removedDirs: 0, tmpRemoved, ownerRecordsRemoved: 0 }
    if (!r) {
      result.ownerRecordsRemoved = await sweepOwners(rr)
      return result
    }
    const cutoff = now() - maxAgeMs

    // readdir({withFileTypes}) does not follow symlinks: they report
    // isSymbolicLink() and are neither descended into nor deleted.
    async function walk(dir) {
      let dirents
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const d of dirents) {
        const full = path.join(dir, d.name)
        if (d.isDirectory()) {
          // mtime taken before our own deletions touch it: a folder created or
          // written to in the last few minutes may be an upload in flight
          // (resolve() made it, the rename has not landed yet), so keep it.
          let recent = true
          try {
            recent = (await fsp.lstat(full)).mtimeMs > now() - sweepDirGraceMs
          } catch {
            // raced: leave it alone
          }
          await walk(full)
          if (recent) continue
          try {
            await fsp.rmdir(full)
            result.removedDirs++
          } catch {
            // not empty
          }
        } else if (d.isFile()) {
          try {
            const st = await fsp.lstat(full)
            if (st.isFile() && st.mtimeMs < cutoff) {
              await fsp.unlink(full)
              result.deletedFiles++
              result.deletedBytes += st.size
            }
          } catch {
            // raced
          }
        }
      }
    }

    await walk(r.dir)
    result.ownerRecordsRemoved = await sweepOwners(rr)
    return result
  }

  /**
   * Remove owner records whose object no longer exists, so a stale record can
   * never hand read rights to an object written later at the same path (the
   * upload of a new object replaces the record anyway; this is the clean-up).
   * Records touched in the last sweepDirGraceMs are kept (an upload in flight
   * writes the record just before its commit), and each check runs under the
   * key's owner lock.
   */
  async function sweepOwners(rr) {
    let removed = 0
    for (const bucket of uploaderReadBuckets) {
      const dir = path.join(rr, OWNERS_DIR_NAME, bucket)
      let names
      try {
        const st = await fsp.lstat(dir)
        if (!st.isDirectory()) continue
        names = await fsp.readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) continue
        const full = path.join(dir, name)
        try {
          const st = await fsp.lstat(full)
          if (!st.isFile() || st.mtimeMs > now() - sweepDirGraceMs) continue
          let rec
          try {
            rec = JSON.parse(await fsp.readFile(full, 'utf8'))
          } catch {
            continue // unreadable: leave it for an operator
          }
          const key = typeof rec?.key === 'string' ? rec.key : null
          const segs = key ? parseStoragePath(key, pathLimits) : null
          if (!segs || crypto.createHash('sha256').update(key).digest('hex') !== name.slice(0, 64)) continue
          await withOwnerLock(ownerLockId(bucket, key), async () => {
            const obj = await objectStat(bucket, segs)
            if (obj) return
            const again = await fsp.lstat(full).catch(() => null)
            if (!again || again.mtimeMs > now() - sweepDirGraceMs) return
            await fsp.unlink(full)
            removed++
          })
        } catch {
          // raced
        }
      }
    }
    return removed
  }

  async function sweepTemp(rr) {
    const tmpDir = path.join(rr, TMP_DIR_NAME)
    let removed = 0
    try {
      const st = await fsp.lstat(tmpDir)
      if (!st.isDirectory() || st.isSymbolicLink()) return 0
      const cutoff = now() - DEFAULTS.tmpMaxAgeMs
      for (const name of await fsp.readdir(tmpDir)) {
        const full = path.join(tmpDir, name)
        try {
          const fst = await fsp.lstat(full)
          if (fst.isFile() && fst.mtimeMs < cutoff) {
            await fsp.unlink(full)
            removed++
          }
        } catch {
          // raced
        }
      }
    } catch {
      // no temp dir yet
    }
    return removed
  }

  /**
   * Fields for /health: { sentinel, storageWritable, diskFreeMB, lowSpace }.
   * Never throws.
   */
  async function health() {
    const out = { sentinel: false, storageWritable: false, diskFreeMB: null, lowSpace: null }
    let rr
    try {
      rr = await realRoot()
    } catch {
      return out
    }
    out.sentinel = await sentinelPresent(rr)
    try {
      await fsp.access(rr, fsc.W_OK)
      out.storageWritable = out.sentinel
    } catch {
      out.storageWritable = false
    }
    try {
      const free = await freeBytes(rr)
      out.diskFreeMB = Math.floor(free / MiB)
      out.lowSpace = Object.values(minFreeBytes).some((floor) => free < floor)
    } catch {
      // leave nulls
    }
    return out
  }

  /**
   * HTTP adapter. action is the last segment of /api/storage/<action>; body is
   * the parsed JSON request body; ctx.userId is the verified caller.
   * Always resolves to { status, body } where body is {data, error}.
   */
  async function handle(action, body, ctx = {}) {
    try {
      if (action === 'signed-url') {
        return { status: 404, body: { data: null, error: { message: 'Signed URLs are not available', code: 'OV_STORAGE_NO_SIGNED_URL' } } }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw err.invalidRequest()
      const userId = ctx.userId ?? null
      if (action === 'upload') {
        const data = await upload({
          bucket: body.bucket,
          path: body.path,
          fileBase64: body.fileBase64,
          contentType: body.contentType,
          upsert: body.upsert,
          userId
        })
        return { status: 200, body: { data, error: null } }
      }
      if (action === 'download') {
        let buf
        try {
          buf = await download({ bucket: body.bucket, path: body.path, userId })
        } catch (e) {
          // A missing object is an answer, not a failure (first log append, no
          // backup yet): 200 with the error, so browsers log no console error.
          // apiStorage returns it as { data: null, error } either way.
          if (e instanceof StorageError && e.code === 'OV_STORAGE_NOT_FOUND') {
            return { status: 200, body: { data: null, error: { message: e.message, code: e.code } } }
          }
          throw e
        }
        return { status: 200, body: { data: buf.toString('base64'), error: null } }
      }
      if (action === 'list') {
        const data = await list({ bucket: body.bucket, path: body.path, options: body.options, userId })
        return { status: 200, body: { data, error: null } }
      }
      return { status: 404, body: { data: null, error: { message: 'Not found', code: 'OV_STORAGE_UNKNOWN_ACTION' } } }
    } catch (e) {
      return errorResult(e, action)
    }
  }

  /** The {status, body} for a request body larger than maxBodyBytes (server.js: 413, never a generic 400). */
  function bodyTooLarge() {
    return errorResult(err.tooLarge())
  }

  function errorResult(e, action = '') {
    if (e instanceof StorageError) {
      return { status: e.status, body: { data: null, error: { message: e.message, code: e.code } } }
    }
    logger.error?.(`[Storage] ${action} failed:`, e?.code || '', e?.message)
    return { status: 500, body: { data: null, error: { message: 'Storage operation failed', code: 'OV_STORAGE_INTERNAL' } } }
  }

  return {
    root,
    buckets: [...buckets],
    uploaderReadBuckets: [...uploaderReadBuckets],
    maxFileBytes,
    maxBodyBytes,
    upload,
    download,
    list,
    sweep,
    health,
    handle,
    bodyTooLarge,
    getOwners,
    setOwners
  }
}
