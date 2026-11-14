/**
 * globalStore — the Global tool's server side (owner 2026-11-14). No account,
 * no database row, no club/game/player data: only a match's backup file and
 * its finished scoresheet, kept under a random key the device made.
 *
 *   POST /api/global/save  { key, kind, contentType, fileBase64 } -> { data: { kind, bytes }, error: null }
 *   POST /api/global/load  { key, kind }                          -> { data: { fileBase64, contentType }, error: null }
 *
 * The key (128 random bits, base64url, made by the app and kept in the match
 * on the device) is the only capability: nobody lists, searches or reads by
 * anything else, so a stranger cannot guess a path. kind: 'backup' (the
 * match's JSON, replaced on every save), 'scoresheet' (PDF, replaced) and
 * 'scoresheet-final' (PDF of the closed match, replaced).
 *
 * Layout: {root}/global/{key[0..2]}/{key}/{kind}.{json|pdf}. Needs the storage
 * root's .ovdata sentinel (lib/storage.js) so a missing volume never writes to
 * the bare disk. Refused: a body that is not JSON (backup) or does not start
 * with %PDF- (scoresheets); more than MAX_KINDS files or MAX_BYTES_PER_KEY per
 * key; more than maxKeys keys or maxTotalBytes in total (a full store says 507,
 * the app keeps the file on the device and retries). Keys untouched for
 * retentionDays are deleted (sweep at most hourly, on a request).
 *
 * Node built-ins only. Pure: the HTTP layer (server.js) does the rate limit
 * per IP and the body cap.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/
export const KINDS = Object.freeze({
  backup: { ext: 'json', types: ['application/json'] },
  scoresheet: { ext: 'pdf', types: ['application/pdf'] },
  'scoresheet-final': { ext: 'pdf', types: ['application/pdf'] }
})
const MiB = 1024 * 1024
export const DEFAULTS = Object.freeze({
  maxFileBytes: 12 * MiB,
  maxBytesPerKey: 40 * MiB,
  maxKeys: 20000,
  maxTotalBytes: 4 * 1024 * MiB,
  retentionDays: 180,
  sweepEveryMs: 60 * 60 * 1000
})

/** Largest JSON body the HTTP layer should read for save (base64 + the envelope). */
export const maxBodyBytesFor = (maxFileBytes = DEFAULTS.maxFileBytes) => Math.ceil(maxFileBytes * 4 / 3) + 4096

const fail = (status, code, message) => ({ status, body: { data: null, error: { message, code } } })
const ok = (data) => ({ status: 200, body: { data, error: null } })

export function createGlobalStore({ root, logger = console, now = Date.now, ...limits } = {}) {
  if (!root) throw new TypeError('globalStore: root required')
  const o = { ...DEFAULTS, ...limits }
  const base = path.join(root, 'global')
  let lastSweep = 0
  let counted = null // { at, keys, bytes }

  async function sentinel() {
    try { return (await fsp.lstat(path.join(root, '.ovdata'))).isFile() } catch { return false }
  }
  const dirOf = (key) => path.join(base, key.slice(0, 2), key)

  async function usage() {
    if (counted && now() - counted.at < 60_000) return counted
    let keys = 0; let bytes = 0
    for (const a of await fsp.readdir(base).catch(() => [])) {
      for (const k of await fsp.readdir(path.join(base, a)).catch(() => [])) {
        keys++
        for (const f of await fsp.readdir(path.join(base, a, k)).catch(() => [])) {
          bytes += (await fsp.stat(path.join(base, a, k, f)).catch(() => ({ size: 0 }))).size
        }
      }
    }
    counted = { at: now(), keys, bytes }
    return counted
  }

  /** Delete keys untouched for retentionDays. Returns the number removed. */
  async function sweep() {
    lastSweep = now()
    const cutoff = now() - o.retentionDays * 86400_000
    let removed = 0
    for (const a of await fsp.readdir(base).catch(() => [])) {
      for (const k of await fsp.readdir(path.join(base, a)).catch(() => [])) {
        const dir = path.join(base, a, k)
        let newest = 0
        for (const f of await fsp.readdir(dir).catch(() => [])) {
          newest = Math.max(newest, (await fsp.stat(path.join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs)
        }
        if (newest < cutoff) { await fsp.rm(dir, { recursive: true, force: true }); removed++ }
      }
    }
    counted = null
    return removed
  }

  async function save(body) {
    const { key, kind, contentType, fileBase64 } = body || {}
    if (typeof key !== 'string' || !KEY_RE.test(key) || !KINDS[kind]) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid request')
    const spec = KINDS[kind]
    const type = String(contentType || '').split(';')[0].trim().toLowerCase()
    if (!spec.types.includes(type)) return fail(415, 'OV_GLOBAL_TYPE', 'File type not allowed')
    if (typeof fileBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(fileBase64)) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid file')
    const data = Buffer.from(fileBase64, 'base64')
    if (!data.length) return fail(400, 'OV_GLOBAL_INVALID', 'Empty file')
    if (data.length > o.maxFileBytes) return fail(413, 'OV_GLOBAL_TOO_LARGE', 'File too large')
    if (spec.ext === 'pdf' && data.subarray(0, 5).toString('latin1') !== '%PDF-') return fail(415, 'OV_GLOBAL_TYPE', 'Not a PDF')
    if (spec.ext === 'json') {
      try { JSON.parse(data.toString('utf8')) } catch { return fail(400, 'OV_GLOBAL_INVALID', 'Not JSON') }
    }
    if (!(await sentinel())) { logger.error?.('[Global] sentinel missing; refusing writes'); return fail(503, 'OV_GLOBAL_UNAVAILABLE', 'Storage unavailable') }
    if (now() - lastSweep > o.sweepEveryMs) sweep().catch((e) => logger.warn?.('[Global] sweep failed:', e?.message))

    const dir = dirOf(key)
    const existing = await fsp.readdir(dir).catch(() => null)
    const file = path.join(dir, `${kind}.${spec.ext}`)
    const had = (existing || []).includes(`${kind}.${spec.ext}`)
    if (!existing) {
      const u = await usage()
      if (u.keys >= o.maxKeys || u.bytes + data.length > o.maxTotalBytes) return fail(507, 'OV_GLOBAL_FULL', 'Storage is full, try again later')
    } else {
      let bytes = 0
      for (const f of existing) if (f !== `${kind}.${spec.ext}`) bytes += (await fsp.stat(path.join(dir, f)).catch(() => ({ size: 0 }))).size
      if (bytes + data.length > o.maxBytesPerKey) return fail(413, 'OV_GLOBAL_TOO_LARGE', 'Too much data for this match')
    }
    await fsp.mkdir(dir, { recursive: true })
    const tmp = path.join(root, '.tmp')
    await fsp.mkdir(tmp, { recursive: true })
    const tmpFile = path.join(tmp, `global-${crypto.randomBytes(8).toString('hex')}`)
    await fsp.writeFile(tmpFile, data, { mode: 0o600 })
    await fsp.rename(tmpFile, file)
    counted = null
    return ok({ kind, bytes: data.length, replaced: had })
  }

  async function load(body) {
    const { key, kind } = body || {}
    if (typeof key !== 'string' || !KEY_RE.test(key) || !KINDS[kind]) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid request')
    const spec = KINDS[kind]
    try {
      const data = await fsp.readFile(path.join(dirOf(key), `${kind}.${spec.ext}`))
      return ok({ fileBase64: data.toString('base64'), contentType: spec.types[0] })
    } catch (e) {
      if (e?.code === 'ENOENT') return { status: 200, body: { data: null, error: { message: 'Not found', code: 'OV_GLOBAL_NOT_FOUND' } } }
      throw e
    }
  }

  async function handle(action, body) {
    if (action === 'save') return save(body)
    if (action === 'load') return load(body)
    return fail(404, 'OV_NOT_FOUND', 'Not found')
  }

  return { handle, sweep, usage, maxBodyBytes: maxBodyBytesFor(o.maxFileBytes) }
}
