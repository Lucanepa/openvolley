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
 * Errors come back as {data:null, error:{message, code}} with an HTTP status.
 *
 * Usage (see README "Storage" section for the server.js wiring):
 *   import { createStorage, storageOptionsFromEnv } from './lib/storage.js'
 *   const storage = createStorage(storageOptionsFromEnv(process.env))
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
export const DEFAULT_CONTENT_TYPES = Object.freeze(['application/json', 'text/plain', 'application/pdf'])
export const SIGNED_URL_REMOVED = true

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULTS = Object.freeze({
  maxFileBytes: 5 * MiB,          // server.js caps the JSON body at 5 MB anyway (~3.7 MB of file)
  maxDownloadBytes: 64 * MiB,     // guard for migrated/foreign files
  minFreeBytes: { backup: 2 * GiB },
  listDefaultLimit: 100,          // supabase-js default
  listMaxLimit: 1000,
  maxPathLength: 1024,
  maxSegments: 32,
  maxSegmentBytes: 255,
  tmpMaxAgeMs: 60 * 60 * 1000,
  sweepMaxAgeMs: 30 * DAY_MS
})

const EXT_CONTENT_TYPES = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.pdf': 'application/pdf'
}

const SORT_COLUMNS = new Set(['name', 'created_at', 'updated_at', 'last_accessed_at'])
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// Control characters, backslash, and invisible / bidi-override code points.
const FORBIDDEN_CHARS_RE = /[\u0000-\u001f\u007f\\​-‏‪-‮⁠-⁯﻿￹-￻]/
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
    if (Buffer.byteLength(seg, 'utf8') > maxSegmentBytes) return null
    // Compatibility forms must not smuggle in dots or separators (e.g. U+FF0E, U+2025, U+FF0F).
    const k = seg.normalize('NFKC')
    if (k.startsWith('.') || k.includes('/') || k.includes('\\') || FORBIDDEN_CHARS_RE.test(k)) return null
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

/** server.js rate limiting: approved-match scoresheets must never be throttled. */
export function isRateLimitExempt({ bucket, path: p } = {}) {
  return bucket === 'scoresheets' && typeof p === 'string' && p.endsWith('_final.json')
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
 * maxWrites uploads and maxBytes per user. Exempt paths (default: scoresheets
 * *_final.json) always pass and are not counted.
 */
export function createWriteQuota({ windowMs = 60_000, maxWrites = 300, maxBytes = 200 * MiB, exempt = isRateLimitExempt, now = Date.now } = {}) {
  const usage = new Map()
  let lastPrune = now()
  return function checkQuota({ userId, bucket, path: p, size }) {
    if (exempt && exempt({ bucket, path: p })) return true
    const t = now()
    if (t - lastPrune > windowMs) {
      for (const [k, v] of usage) if (t - v.start >= windowMs) usage.delete(k)
      lastPrune = t
    }
    const key = userId || 'anonymous'
    let u = usage.get(key)
    if (!u || t - u.start >= windowMs) {
      u = { start: t, writes: 0, bytes: 0 }
      usage.set(key, u)
    }
    if (u.writes + 1 > maxWrites || u.bytes + size > maxBytes) {
      return { ok: false, message: 'Storage write quota exceeded, try again later' }
    }
    u.writes += 1
    u.bytes += size
    return true
  }
}

/**
 * Options from environment variables:
 *   STORAGE_DIR                 root (default /data/storage)
 *   STORAGE_BACKUP_MIN_FREE_MB  free-space floor for backup/ writes (default 2048)
 *   STORAGE_MAX_FILE_MB         per-object size cap (default 5)
 *   STORAGE_OWNER_SCOPE         off | require | prefix (default off; Phase 7 security release)
 */
export function storageOptionsFromEnv(env = process.env) {
  const opts = { root: env.STORAGE_DIR || DEFAULT_ROOT }
  if (env.STORAGE_BACKUP_MIN_FREE_MB !== undefined && env.STORAGE_BACKUP_MIN_FREE_MB !== '') {
    const mb = Number(env.STORAGE_BACKUP_MIN_FREE_MB)
    if (Number.isFinite(mb) && mb >= 0) opts.minFreeBytes = { backup: Math.round(mb * MiB) }
  }
  if (env.STORAGE_MAX_FILE_MB) {
    const mb = Number(env.STORAGE_MAX_FILE_MB)
    if (Number.isFinite(mb) && mb > 0) opts.maxFileBytes = Math.round(mb * MiB)
  }
  const scope = (env.STORAGE_OWNER_SCOPE || '').trim().toLowerCase()
  if (scope === 'require' || scope === 'prefix') opts.ownerScope = scope
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
 * @param {Object<string,number>} [options.minFreeBytes={backup: 2 GiB}] per-bucket free-space floor
 * @param {(ctx:{userId,bucket,path,size,contentType}) => (boolean|{ok:boolean,message?:string}|Promise)} [options.checkQuota]
 *        per-user write quota hook; false / {ok:false} refuses with 429
 * @param {false|'require'|'prefix'|Function} [options.ownerScope=false]
 *        'require': the first path segment must be the caller's user id;
 *        'prefix': the user id is prepended transparently;
 *        function({op,userId,bucket,path}) -> path string to use, or null/false to refuse (403)
 * @param {string[]} [options.ownerScopeBuckets] buckets the owner scope applies to (default: all)
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
  const checkQuota = options.checkQuota || null
  const ownerScope = options.ownerScope || false
  const ownerScopeBuckets = new Set(options.ownerScopeBuckets || buckets)
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
    if (out === null || out === undefined || out === false) throw err.forbidden()
    const scoped = parseStoragePath(String(out), { allowEmpty: op === 'list', ...pathLimits })
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

    const rr = await assertWritable()
    await assertFreeSpace(rr, bucket, buf.length)
    await runQuota({ userId: userId ?? null, bucket, path: segs.join('/'), size: buf.length, contentType: ct })

    const { dir, target } = await resolve(bucket, diskSegs, { create: true })
    const doUpsert = upsert !== false

    // Existing entry checks (a symlink or folder at the target is never replaced).
    try {
      const st = await fsp.lstat(target)
      if (st.isSymbolicLink()) throw err.symlink()
      if (!st.isFile()) throw err.conflict()
      if (!doUpsert) throw err.exists()
    } catch (e) {
      if (!isCode(e, 'ENOENT')) throw e
    }

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
      if (doUpsert) {
        await fsp.rename(tmp, target)
      } else {
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
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }
    await syncDir(dir)

    const key = diskSegs.join('/')
    const clientPath = segs.join('/')
    return { path: clientPath, id: objectId(bucket, key), fullPath: `${bucket}/${clientPath}` }
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
   * search (case-insensitive substring of the name). A missing folder gives [].
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
    const entries = []
    await Promise.all(dirents.map(async (d) => {
      const name = d.name
      if (name.startsWith('.')) return
      if (search && !name.toLowerCase().includes(search)) return
      if (d.isDirectory()) {
        entries.push(folderEntry(name))
      } else if (d.isFile()) {
        try {
          const st = await fsp.lstat(path.join(r.dir, name))
          if (st.isFile()) entries.push(fileEntry(bucket, keyPrefix + name, name, st))
        } catch {
          // raced with a delete: skip
        }
      }
      // symlinks, sockets, devices: never listed
    }))

    entries.sort((a, b) => {
      if (column !== 'name') {
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
      }
      const c = a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      return desc ? -c : c
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
    const result = { deletedFiles: 0, deletedBytes: 0, removedDirs: 0, tmpRemoved }
    if (!r) return result
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
          await walk(full)
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
    return result
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
        const buf = await download({ bucket: body.bucket, path: body.path, userId })
        return { status: 200, body: { data: buf.toString('base64'), error: null } }
      }
      if (action === 'list') {
        const data = await list({ bucket: body.bucket, path: body.path, options: body.options, userId })
        return { status: 200, body: { data, error: null } }
      }
      return { status: 404, body: { data: null, error: { message: 'Not found', code: 'OV_STORAGE_UNKNOWN_ACTION' } } }
    } catch (e) {
      if (e instanceof StorageError) {
        return { status: e.status, body: { data: null, error: { message: e.message, code: e.code } } }
      }
      logger.error?.(`[Storage] ${action} failed:`, e?.code || '', e?.message)
      return { status: 500, body: { data: null, error: { message: 'Storage operation failed', code: 'OV_STORAGE_INTERNAL' } } }
    }
  }

  return {
    root,
    buckets: [...buckets],
    upload,
    download,
    list,
    sweep,
    health,
    handle
  }
}
