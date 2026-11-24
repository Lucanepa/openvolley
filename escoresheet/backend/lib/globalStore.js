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
 * the bare disk. Refused: a backup that is not the app's encrypted backup file
 * (frontend utils/backupCrypto/envelope.js: only its own fields, a ciphertext
 * and at least one key slot; the privacy policy says the backup is encrypted,
 * so plain names and birth dates are never kept, whatever client sends them)
 * or a scoresheet that does not start with %PDF-; more than maxBytesPerKey per
 * key; more than maxKeys keys or maxTotalBytes in total (counted on EVERY
 * write, a key that grows too), or a write that would leave less than
 * minFreeBytes + reserveBytes free on the volume (minFreeBytes: the floor
 * lib/storage.js keeps for the league's backups and scoresheets, which share
 * it; the reserve keeps the Global store from taking the volume down to the
 * very floor those stop at): a full store says 507, the app keeps the file on
 * the device and retries. Each file is written to {root}/.tmp, fsynced and
 * renamed (lib/storage.js sweeps leftovers there). Keys untouched for
 * retentionDays are deleted (the privacy policy's 180 days): a sweep at most
 * every sweepEveryMs, on any request and on server.js's timer (maybeSweep),
 * so it also runs when nobody saves any more.
 *
 * Node built-ins only. Pure: the HTTP layer (server.js) does the rate limit
 * per IP and the body cap, and passes the caller's address (handle's ctx.ip).
 *
 * Shares (audit 2026-11-23 SEC-17: one anonymous caller filled the store and
 * every later save got 507 for 180 days):
 *   - per network and day (lib/globalQuota.js, in memory; IPv6 /64, /56 and
 *     /48, an IPv4 address and its /24): new keys and bytes added (a file
 *     that replaces one counts what it adds), 429 OV_GLOBAL_QUOTA beyond;
 *   - a full store (maxKeys / maxTotalBytes) no longer refuses everyone: it
 *     evicts the keys of the networks (IPv6 /48, IPv4 /24) that created more
 *     than evictShare of it since the start, the newest created first, at
 *     most maxEvictPerSave per save, never the key being saved. Who created a
 *     key is known in memory only (addresses are never stored), so a genuine
 *     key is never chosen for its size or for not being loaded again (GCS-R2:
 *     final backups and PDFs are rarely loaded and far larger than a flood's
 *     files); such a network's own new key, and everything when no network is
 *     over its share, gets 507 as before, and the data stays;
 *   - onAlert (server.js: the error tracker) when the store passes
 *     alertShare of a cap and when it evicts, at most hourly.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { addressPrefix, createNetworkBudget, createOncePer } from './globalQuota.js'

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
  // the volume's free-space floor: at least lib/storage.js's highest
  // (backup/ stops at 2 GiB free), so the Global store never eats the room
  // official matches need (server.js passes the configured floors)
  minFreeBytes: 2 * 1024 * MiB,
  // kept free above that floor: a full Global store must not stop the
  // league's backup/ writes, which stop at the same floor
  reserveBytes: 1024 * MiB,
  retentionDays: 180,
  sweepEveryMs: 60 * 60 * 1000,
  // per network and day (SEC-17): a tournament day of 60 matches behind one
  // address adds about 600 MB (the final backup and PDFs of each). One IPv4
  // address is a whole sports hall behind its NAT: it gets its /24's share
  // (v4Max; 2611 review, SR-4: 1 GiB was about 100 matches)
  perNetwork: Object.freeze([
    Object.freeze({ name: '/64', v6Bits: 64, v4Bits: 32, max: Object.freeze({ keys: 200, bytes: 1024 * MiB }), v4Max: Object.freeze({ keys: 1000, bytes: 2048 * MiB }) }),
    Object.freeze({ name: '/56', v6Bits: 56, v4Bits: 32, max: Object.freeze({ keys: 500, bytes: 2048 * MiB }), v4Max: Object.freeze({ keys: 1000, bytes: 2048 * MiB }) }),
    // an IPv6 /48 (a tunnel broker's has 256 /56s) and an IPv4 /24 (GCS-R4)
    Object.freeze({ name: '/48', v6Bits: 48, v4Bits: 24, max: Object.freeze({ keys: 1000, bytes: 2048 * MiB }) })
  ]),
  alertShare: 0.5,
  maxEvictPerSave: 200,
  // a network that created more than this share of the keys or bytes since
  // the start is the one a full store takes room from (GCS-R2)
  evictShare: 0.1
})

/** Largest JSON body the HTTP layer should read for save (base64 + the envelope). */
export const maxBodyBytesFor = (maxFileBytes = DEFAULTS.maxFileBytes) => Math.ceil(maxFileBytes * 4 / 3) + 4096

// The encrypted backup file's fields (frontend utils/backupCrypto/envelope.js), nothing else
const ENVELOPE_FORMAT = 'openvolley-encrypted-backup'
const ENVELOPE_FIELDS = new Set(['format', 'formatVersion', 'about', 'readable', 'cipher', 'slots', 'ciphertext'])
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
/** Is `json` the app's encrypted backup file (and nothing in the clear beside it)? */
export function isSealedBackup(json) {
  if (!isObject(json) || json.format !== ENVELOPE_FORMAT || !Number.isInteger(json.formatVersion)) return false
  if (Object.keys(json).some((k) => !ENVELOPE_FIELDS.has(k))) return false
  if (typeof json.ciphertext !== 'string' || !B64_RE.test(json.ciphertext)) return false
  if (!Array.isArray(json.slots) || !json.slots.length || !json.slots.every(isObject)) return false
  if (json.readable != null && !isObject(json.readable)) return false
  return isObject(json.cipher)
}
const kindOf = (kind) => (typeof kind === 'string' && Object.hasOwn(KINDS, kind) ? KINDS[kind] : null)

const fail = (status, code, message) => ({ status, body: { data: null, error: { message, code } } })
const ok = (data) => ({ status: 200, body: { data, error: null } })

export function createGlobalStore({ root, logger = console, now = Date.now, statfs = (p) => fsp.statfs(p), onAlert = null, ...limits } = {}) {
  if (!root) throw new TypeError('globalStore: root required')
  const o = { ...DEFAULTS, ...limits }
  const base = path.join(root, 'global')
  let lastSweep = 0
  let sweeping = null
  const budget = createNetworkBudget({ limits: o.perNetwork, now })
  // GCS-R2: the keys this process saw created, key -> { net, bytes } (in
  // creation order), and net -> { keys: Set, bytes }. Memory only: a key
  // created before the start has no known creator and is never evicted.
  const created = new Map()
  const holdings = new Map()
  const creatorOf = (ip) => addressPrefix(ip, 48, 24)
  function forgetKey(k) {
    const c = created.get(k)
    if (!c) return
    created.delete(k)
    const h = holdings.get(c.net)
    if (!h) return
    h.keys.delete(k)
    h.bytes -= c.bytes
    if (!h.keys.size) holdings.delete(c.net)
  }
  function noteKey(k, net, adds, isNew) {
    if (isNew) {
      forgetKey(k)
      while (created.size >= o.maxKeys + 100) forgetKey(created.keys().next().value)
      created.set(k, { net, bytes: 0 })
      let h = holdings.get(net)
      if (!h) { h = { keys: new Set(), bytes: 0 }; holdings.set(net, h) }
      h.keys.add(k)
    }
    const c = created.get(k)
    if (!c) return
    c.bytes = Math.max(0, c.bytes + adds)
    const h = holdings.get(c.net)
    if (h) h.bytes = Math.max(0, h.bytes + adds)
  }
  const overShare = (net) => {
    const h = holdings.get(net)
    return !!h && (h.keys.size > o.maxKeys * o.evictShare || h.bytes > o.maxTotalBytes * o.evictShare)
  }
  let evicting = Promise.resolve()
  const alertOnce = createOncePer(60 * 60_000, now)
  const alert = (name, message) => {
    if (!alertOnce(name)) return
    logger.error?.(`[Global] ALERT ${message}`)
    try { onAlert?.(message) } catch { /* an alert never fails a request */ }
  }
  const mb = (n) => Math.round(n / MiB)
  // { at, keys, bytes }: walked at most every USAGE_TTL_MS (and after a
  // sweep), kept up to date by every write in between: a walk of 20000 keys
  // on each new key's save cost every caller its disk time
  let counted = null
  const USAGE_TTL_MS = 10 * 60_000

  async function sentinel() {
    try { return (await fsp.lstat(path.join(root, '.ovdata'))).isFile() } catch { return false }
  }
  const dirOf = (key) => path.join(base, key.slice(0, 2), key)

  /** Would `size` more bytes leave the volume above its floor? null: unknown (statfs failed). */
  async function roomFor(size) {
    try {
      const st = await statfs(root)
      return Number(st.bavail) * Number(st.bsize) - size >= o.minFreeBytes + o.reserveBytes
    } catch (e) {
      logger.error?.('[Global] statfs failed:', e?.message)
      return null
    }
  }

  async function usage() {
    if (counted && now() - counted.at < USAGE_TTL_MS) return counted
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
    sweeping ||= sweepNow().finally(() => { sweeping = null })
    return sweeping
  }
  /** A sweep when the last is sweepEveryMs old (any request, server.js's timer); null when not due. */
  function maybeSweep() {
    if (now() - lastSweep <= o.sweepEveryMs) return Promise.resolve(null)
    return sweep()
  }
  async function sweepNow() {
    budget.sweep()
    const cutoff = now() - o.retentionDays * 86400_000
    let removed = 0
    for (const a of await fsp.readdir(base).catch(() => [])) {
      for (const k of await fsp.readdir(path.join(base, a)).catch(() => [])) {
        const dir = path.join(base, a, k)
        let newest = 0
        for (const f of await fsp.readdir(dir).catch(() => [])) {
          newest = Math.max(newest, (await fsp.stat(path.join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs)
        }
        if (newest < cutoff) { await fsp.rm(dir, { recursive: true, force: true }); forgetKey(k); removed++ }
      }
    }
    counted = null
    return removed
  }

  /**
   * Make room for `bytes` more (and one more key when newKey) for a save
   * from network `net`, by removing keys of the networks over their share
   * (evictShare), the largest holder of what is short first, its newest
   * created keys first; never `keep`, never a key whose creator is unknown,
   * nothing for a network over its share itself. Returns whether there is
   * room now. One eviction at a time.
   */
  function evictFor({ keep, bytes, newKey, net }) {
    const run = evicting.then(async () => {
      let u = await usage()
      const fits = () => u.bytes + bytes <= o.maxTotalBytes && (!newKey || u.keys < o.maxKeys)
      if (fits() || overShare(net)) return fits()
      const keysShort = newKey && u.keys >= o.maxKeys
      const nets = [...holdings].filter(([n]) => n !== net && overShare(n))
        .sort(([, a], [, b]) => (keysShort ? b.keys.size - a.keys.size : b.bytes - a.bytes))
      let removed = 0
      for (const [, h] of nets) {
        for (const k of [...h.keys].reverse()) {
          if (fits() || removed >= o.maxEvictPerSave) break
          if (k === keep) continue
          const dir = dirOf(k)
          let size = 0
          for (const f of await fsp.readdir(dir).catch(() => [])) size += (await fsp.stat(path.join(dir, f)).catch(() => ({ size: 0 }))).size
          await fsp.rm(dir, { recursive: true, force: true })
          forgetKey(k)
          removed++
          u = { ...u, keys: u.keys - 1, bytes: Math.max(0, u.bytes - size) }
          if (counted) counted = { ...counted, keys: u.keys, bytes: u.bytes }
        }
      }
      if (removed) {
        logger.warn?.(`[Global] the store was full: ${removed} key(s) of networks over their share evicted to make room`)
        alert('evicted', `the Global store is full (${mb(u.bytes)} MB in ${u.keys} keys, caps ${mb(o.maxTotalBytes)} MB / ${o.maxKeys}): the newest keys of networks over a ${Math.round(o.evictShare * 100)}% share were evicted`)
      }
      return fits()
    })
    evicting = run.catch(() => {})
    return run
  }

  async function save(body, ctx = {}) {
    const { key, kind, contentType, fileBase64 } = body || {}
    const spec = kindOf(kind)
    if (typeof key !== 'string' || !KEY_RE.test(key) || !spec) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid request')
    const type = String(contentType || '').split(';')[0].trim().toLowerCase()
    if (!spec.types.includes(type)) return fail(415, 'OV_GLOBAL_TYPE', 'File type not allowed')
    if (typeof fileBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(fileBase64)) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid file')
    const data = Buffer.from(fileBase64, 'base64')
    if (!data.length) return fail(400, 'OV_GLOBAL_INVALID', 'Empty file')
    if (data.length > o.maxFileBytes) return fail(413, 'OV_GLOBAL_TOO_LARGE', 'File too large')
    if (spec.ext === 'pdf' && data.subarray(0, 5).toString('latin1') !== '%PDF-') return fail(415, 'OV_GLOBAL_TYPE', 'Not a PDF')
    if (spec.ext === 'json') {
      let json
      try { json = JSON.parse(data.toString('utf8')) } catch { return fail(400, 'OV_GLOBAL_INVALID', 'Not JSON') }
      if (!isSealedBackup(json)) return fail(400, 'OV_GLOBAL_NOT_SEALED', 'Only an encrypted backup is stored')
    }
    if (!(await sentinel())) { logger.error?.('[Global] sentinel missing; refusing writes'); return fail(503, 'OV_GLOBAL_UNAVAILABLE', 'Storage unavailable') }

    const dir = dirOf(key)
    const existing = await fsp.readdir(dir).catch(() => null)
    const name = `${kind}.${spec.ext}`
    const file = path.join(dir, name)
    const had = (existing || []).includes(name)
    // this key's other files, and the size of the file this one replaces
    let others = 0
    let replaced = 0
    for (const f of existing || []) {
      const size = (await fsp.stat(path.join(dir, f)).catch(() => ({ size: 0 }))).size
      if (f === name) replaced = size
      else others += size
    }
    if (others + data.length > o.maxBytesPerKey) return fail(413, 'OV_GLOBAL_TOO_LARGE', 'Too much data for this match')
    // this network's share of the day (SEC-17): new keys and what the write adds
    const ip = typeof ctx?.ip === 'string' ? ctx.ip : null
    const adds = Math.max(0, data.length - replaced)
    const over = budget.over(ip, { keys: existing ? 0 : 1, bytes: adds })
    if (over) {
      logger.warn?.(`[Global] refusing a write: a network's daily ${over.what} budget (${over.limit}) is spent`)
      // when that network's day ends (the app keeps a refused final upload until then)
      return { ...fail(429, 'OV_GLOBAL_QUOTA', 'Too much stored from this network today, try again later'), retryAfter: Math.ceil(over.retryMs / 1000) }
    }
    // the store's totals on every write: a key that grows counts as a new one
    // does; a full store makes room (evictFor) rather than refusing everyone
    const u = await usage()
    if ((!existing && u.keys >= o.maxKeys) || u.bytes - replaced + data.length > o.maxTotalBytes) {
      if (!(await evictFor({ keep: key, bytes: data.length - replaced, newKey: !existing, net: creatorOf(ip) }))) {
        alert('full', `the Global store is full (${mb(u.bytes)} MB in ${u.keys} keys, caps ${mb(o.maxTotalBytes)} MB / ${o.maxKeys}) and no network is over its share: new data is refused`)
        return fail(507, 'OV_GLOBAL_FULL', 'Storage is full, try again later')
      }
    }
    const room = await roomFor(data.length)
    if (room === null) return fail(503, 'OV_GLOBAL_UNAVAILABLE', 'Storage unavailable')
    if (!room) {
      logger.warn?.('[Global] refusing a write: the volume is at its free-space floor')
      return fail(507, 'OV_GLOBAL_FULL', 'Storage is full, try again later')
    }
    await fsp.mkdir(dir, { recursive: true })
    const tmp = path.join(root, '.tmp')
    await fsp.mkdir(tmp, { recursive: true })
    const tmpFile = path.join(tmp, `global-${crypto.randomBytes(8).toString('hex')}`)
    const fh = await fsp.open(tmpFile, 'wx', 0o600)
    try {
      await fh.writeFile(data)
      await fh.sync()
    } catch (e) {
      await fh.close().catch(() => {})
      await fsp.rm(tmpFile, { force: true }).catch(() => {})
      throw e
    }
    await fh.close()
    await fsp.rename(tmpFile, file)
    if (counted) {
      counted.bytes += data.length - replaced
      if (!existing) counted.keys++
      if (counted.bytes >= o.maxTotalBytes * o.alertShare || counted.keys >= o.maxKeys * o.alertShare) {
        alert('half', `the Global store is over ${Math.round(o.alertShare * 100)}% full (${mb(counted.bytes)} MB in ${counted.keys} keys, caps ${mb(o.maxTotalBytes)} MB / ${o.maxKeys})`)
      }
    }
    budget.charge(ip, { keys: existing ? 0 : 1, bytes: adds })
    noteKey(key, creatorOf(ip), data.length - replaced, !existing)
    return ok({ kind, bytes: data.length, replaced: had })
  }

  async function load(body) {
    const { key, kind } = body || {}
    const spec = kindOf(kind)
    if (typeof key !== 'string' || !KEY_RE.test(key) || !spec) return fail(400, 'OV_GLOBAL_INVALID', 'Invalid request')
    try {
      const data = await fsp.readFile(path.join(dirOf(key), `${kind}.${spec.ext}`))
      return ok({ fileBase64: data.toString('base64'), contentType: spec.types[0] })
    } catch (e) {
      if (e?.code === 'ENOENT') return { status: 200, body: { data: null, error: { message: 'Not found', code: 'OV_GLOBAL_NOT_FOUND' } } }
      throw e
    }
  }

  async function handle(action, body, ctx = {}) {
    // retention runs on any request, a load too (and on server.js's timer)
    maybeSweep().catch((e) => logger.warn?.('[Global] sweep failed:', e?.message))
    if (action === 'save') return save(body, ctx)
    if (action === 'load') return load(body)
    return fail(404, 'OV_NOT_FOUND', 'Not found')
  }

  /** What the keys a network created since the start hold (tests). */
  const createdBy = (ip) => { const h = holdings.get(creatorOf(ip)); return h ? { keys: h.keys.size, bytes: h.bytes } : { keys: 0, bytes: 0 } }

  return { handle, sweep, maybeSweep, usage, budget, createdBy, maxBodyBytes: maxBodyBytesFor(o.maxFileBytes) }
}
