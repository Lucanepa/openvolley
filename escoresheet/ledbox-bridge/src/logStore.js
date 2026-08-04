// Central structured log for the appliance — one ring buffer in memory, a rotated JSONL
// trail on disk, and a live feed the /logs page tails over SSE.
//
//   every module --log.info(scope, msg, data)--> LogStore ──┬─▶ ring buffer  (GET /api/logs)
//                                                           ├─▶ subscribers  (GET /api/logs/stream)
//                                                           ├─▶ console      (journalctl -u ledbox-bridge)
//                                                           └─▶ data/logs/*.jsonl (rotated)
//
// Three rules this module lives by:
//
//  1. **It can never throw.** A logger that breaks scoring is worse than no logger, so every
//     entry point is wrapped and failures are dropped silently. Same isolation principle as
//     historyStore and livePush.
//  2. **It buffers writes.** The board runs off an SD card; one fsync per scored point is how
//     you kill it. Lines accumulate and flush on a timer (or when the buffer fills), and the
//     total on disk is capped by rotation.
//  3. **It redacts.** The scorer PIN and the Directus token pass through several of the call
//     sites below; neither may ever reach the log file or the /logs page.
//
// ONE process-wide instance (`log`), configured at boot by appliance.js. The modules under it
// import it directly rather than taking a logger param — they are constructed from the bridge,
// the appliance, the tests and five selftests, and threading a logger through all of those
// would be pure noise. Unconfigured it mirrors to console and keeps the ring in memory, which
// is exactly what a test wants.

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
export const LEVEL_NAMES = Object.keys(LEVELS)

const DEFAULTS = {
  file: null,             // active JSONL path; null = memory + console only
  maxEntries: 2000,       // ring buffer size (what /api/logs can serve instantly)
  maxBytes: 5 * 1024 * 1024,
  maxFiles: 3,            // active + 2 rotated ≈ 15 MB ceiling
  level: 'info',          // 'debug' turns on the per-push / per-request firehose
  console: true,          // mirror to stdout so journalctl keeps working
  flushMs: 1000,          // batch window for disk writes
  flushAt: 50,            // …or this many lines, whichever comes first
}

// Values under these keys never reach the log. Matched on the KEY, at any depth.
const SECRET_KEY = /(pin|token|secret|password|authorization|cookie|apikey|api_key)/i

const MAX_STR = 600     // truncate any single string
const MAX_KEYS = 40     // per object
const MAX_ITEMS = 50    // per array
const MAX_DEPTH = 4

// Copy `value` into something safe to JSON.stringify and safe to show: bounded depth,
// bounded width, no cycles, no secrets, Errors unwrapped into readable fields.
function safeData(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === 'string') return value.length > MAX_STR ? `${value.slice(0, MAX_STR)}…(+${value.length - MAX_STR})` : value
  if (t === 'number' || t === 'boolean') return value
  if (t === 'bigint') return String(value)
  if (t === 'function') return `[function ${value.name || 'anonymous'}]`
  if (t === 'symbol') return String(value)
  if (value instanceof Error) {
    const out = { name: value.name, message: value.message }
    if (value.code) out.code = value.code
    // First frames only — a full stack in a ring buffer is mostly node internals.
    if (value.stack) out.stack = String(value.stack).split('\n').slice(0, 4).join('\n')
    return out
  }
  if (value instanceof Date) return value.toISOString()
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[array(${value.length})]` : '[object]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, MAX_ITEMS).map((v) => safeData(v, depth + 1, seen))
      if (value.length > MAX_ITEMS) out.push(`…(+${value.length - MAX_ITEMS} more)`)
      return out
    }
    if (t === 'object') {
      const out = {}
      let n = 0
      for (const k of Object.keys(value)) {
        if (n >= MAX_KEYS) { out['…'] = `(+${Object.keys(value).length - MAX_KEYS} more keys)`; break }
        n++
        // Redact by key name, but still record THAT the field was present — "pin: [redacted]"
        // is a useful diagnostic, the PIN itself is not.
        out[k] = SECRET_KEY.test(k) ? (value[k] ? '[redacted]' : '') : safeData(value[k], depth + 1, seen)
      }
      return out
    }
  } finally {
    seen.delete(value)
  }
  return String(value)
}

export class LogStore extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.setMaxListeners(0) // every open /logs tab is a subscriber
    this.opts = { ...DEFAULTS, ...opts }
    this.entries = []
    this.counts = { debug: 0, info: 0, warn: 0, error: 0 }
    this.startedAt = new Date().toISOString()
    this.dropped = 0        // entries below the active level (reported by stats())
    this._seq = 0
    this._buf = []
    this._timer = null
    this._bytes = 0
    this._exitHooked = false
    if (this.opts.file) this._initFile()
  }

  // Called once at boot with the real file path and level; safe to call again.
  configure(patch = {}) {
    const prevFile = this.opts.file
    this.opts = { ...this.opts, ...patch }
    if (this.opts.level && !LEVELS[this.opts.level]) this.opts.level = DEFAULTS.level
    if (this.opts.file && this.opts.file !== prevFile) this._initFile()
    return this
  }

  get level() { return this.opts.level }

  setLevel(level) {
    if (!LEVELS[level]) return this.opts.level
    this.opts.level = level
    return level
  }

  // --- writing -------------------------------------------------------------

  log(level, scope, msg, data) {
    try {
      const lv = LEVELS[level] ? level : 'info'
      this.counts[lv]++
      if (LEVELS[lv] < LEVELS[this.opts.level]) { this.dropped++; return null }
      const entry = {
        id: ++this._seq,
        ts: new Date().toISOString(),
        level: lv,
        scope: String(scope || 'app'),
        msg: String(msg ?? ''),
      }
      if (data !== undefined) {
        const safe = safeData(data)
        if (safe !== undefined) entry.data = safe
      }
      this.entries.push(entry)
      const over = this.entries.length - this.opts.maxEntries
      if (over > 0) this.entries.splice(0, over)
      if (this.opts.console) this._toConsole(entry)
      this._queue(entry)
      this.emit('entry', entry)
      return entry
    } catch {
      return null // a logger must never throw into its caller
    }
  }

  debug(scope, msg, data) { return this.log('debug', scope, msg, data) }
  info(scope, msg, data) { return this.log('info', scope, msg, data) }
  warn(scope, msg, data) { return this.log('warn', scope, msg, data) }
  error(scope, msg, data) { return this.log('error', scope, msg, data) }

  // A scope-bound view, so a module writes `log.debug('pushed', {...})` without repeating
  // its own name on every line.
  child(scope) {
    return {
      debug: (msg, data) => this.log('debug', scope, msg, data),
      info: (msg, data) => this.log('info', scope, msg, data),
      warn: (msg, data) => this.log('warn', scope, msg, data),
      error: (msg, data) => this.log('error', scope, msg, data),
    }
  }

  _toConsole(e) {
    // Keeps the shape the appliance already printed ("<iso> [scope] message"), so nothing
    // about reading `journalctl -u ledbox-bridge` changes.
    const tail = e.data === undefined ? '' : ` ${safeStringify(e.data)}`
    const line = `${e.ts} [${e.scope}] ${e.msg}${tail}`
    if (e.level === 'error' || e.level === 'warn') console.error(line)
    else console.log(line)
  }

  // --- persistence ---------------------------------------------------------

  _initFile() {
    try {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true })
      this._bytes = fs.existsSync(this.opts.file) ? fs.statSync(this.opts.file).size : 0
    } catch {
      this.opts.file = null // unwritable location: stay memory-only rather than fail at boot
      return
    }
    if (!this._exitHooked) {
      this._exitHooked = true
      // Losing the last second of logs to a shutdown is exactly when they matter most.
      process.on('exit', () => { try { this.flush() } catch { /* nothing left to do */ } })
    }
  }

  _queue(entry) {
    if (!this.opts.file) return
    this._buf.push(JSON.stringify(entry))
    // An error is why someone opens this file — don't let it sit in a buffer through a crash.
    if (entry.level === 'error' || this._buf.length >= this.opts.flushAt) return this.flush()
    if (!this._timer) {
      this._timer = setTimeout(() => this.flush(), this.opts.flushMs)
      if (this._timer.unref) this._timer.unref() // never hold the process (or a test) open
    }
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (!this.opts.file || !this._buf.length) return
    const chunk = `${this._buf.join('\n')}\n`
    this._buf = []
    try {
      if (this._bytes + chunk.length > this.opts.maxBytes) this._rotate()
      fs.appendFileSync(this.opts.file, chunk)
      this._bytes += chunk.length
    } catch { /* best-effort: a full or read-only card must not stop the board */ }
  }

  // appliance.jsonl → appliance.1.jsonl → appliance.2.jsonl → deleted.
  _rotate() {
    const { file, maxFiles } = this.opts
    const ext = path.extname(file)
    const stem = file.slice(0, -ext.length || undefined)
    const nth = (n) => `${stem}.${n}${ext}`
    try { fs.rmSync(nth(maxFiles - 1), { force: true }) } catch { /* ignore */ }
    for (let n = maxFiles - 2; n >= 1; n--) {
      try { if (fs.existsSync(nth(n))) fs.renameSync(nth(n), nth(n + 1)) } catch { /* ignore */ }
    }
    try { if (fs.existsSync(file)) fs.renameSync(file, nth(1)) } catch { /* ignore */ }
    this._bytes = 0
  }

  // Every log file that currently exists, newest first — the export endpoint concatenates them.
  files() {
    if (!this.opts.file) return []
    const { file, maxFiles } = this.opts
    const ext = path.extname(file)
    const stem = file.slice(0, -ext.length || undefined)
    const out = []
    for (let n = 0; n < maxFiles; n++) {
      const p = n === 0 ? file : `${stem}.${n}${ext}`
      try { if (fs.existsSync(p)) out.push({ path: p, bytes: fs.statSync(p).size }) } catch { /* ignore */ }
    }
    return out
  }

  // --- reading -------------------------------------------------------------

  /**
   * Filter the ring buffer. `sinceId` powers the SSE catch-up (give me what I missed),
   * `q` is a case-insensitive substring match over scope + message + data.
   * Returns newest-last so the page can append in order.
   */
  query({ level, scope, q, sinceId, limit = 500 } = {}) {
    let out = this.entries
    if (sinceId != null) {
      const n = Number(sinceId)
      if (Number.isFinite(n)) out = out.filter((e) => e.id > n)
    }
    if (level && LEVELS[level]) {
      const min = LEVELS[level]
      out = out.filter((e) => LEVELS[e.level] >= min)
    }
    if (scope) {
      const wanted = new Set(String(scope).split(',').map((s) => s.trim()).filter(Boolean))
      if (wanted.size) out = out.filter((e) => wanted.has(e.scope))
    }
    if (q) {
      const needle = String(q).toLowerCase()
      out = out.filter((e) => (
        e.scope.toLowerCase().includes(needle) ||
        e.msg.toLowerCase().includes(needle) ||
        (e.data !== undefined && safeStringify(e.data).toLowerCase().includes(needle))
      ))
    }
    const n = Math.max(1, Math.min(Number(limit) || 500, this.opts.maxEntries))
    return out.length > n ? out.slice(-n) : out.slice()
  }

  // Every scope seen since boot, so the page can offer real filter chips rather than a
  // hardcoded list that drifts.
  scopes() {
    return [...new Set(this.entries.map((e) => e.scope))].sort()
  }

  stats() {
    return {
      level: this.opts.level,
      levels: LEVEL_NAMES,
      counts: { ...this.counts },
      dropped: this.dropped,
      buffered: this.entries.length,
      maxEntries: this.opts.maxEntries,
      lastId: this._seq,
      startedAt: this.startedAt,
      scopes: this.scopes(),
      files: this.files().map((f) => ({ name: path.basename(f.path), bytes: f.bytes })),
    }
  }

  subscribe(fn) {
    this.on('entry', fn)
    return () => this.off('entry', fn)
  }

  // Wipe memory AND disk — the /logs page offers this before a match so the trail is clean.
  clear() {
    this.entries = []
    this.dropped = 0
    this.counts = { debug: 0, info: 0, warn: 0, error: 0 }
    this._buf = []
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    for (const f of this.files()) {
      try { fs.rmSync(f.path, { force: true }) } catch { /* ignore */ }
    }
    this._bytes = 0
  }
}

// Stringify that can't throw on a cycle (safeData already broke them, but this is also
// used on raw values in _toConsole).
function safeStringify(v) {
  try { return JSON.stringify(v) ?? String(v) } catch { return '[unserializable]' }
}

/**
 * The process-wide logger. Modules import this; appliance.js calls `log.configure()` once
 * at boot to point it at data/logs/ and set the level.
 */
export const log = new LogStore()

/**
 * Route Node's process-level failures into the log too, so a crash leaves a trail on disk
 * rather than only in whatever terminal happened to be attached.
 */
export function installProcessLogging(store = log) {
  process.on('unhandledRejection', (reason) => { store.error('process', 'unhandledRejection', reason) })
  process.on('uncaughtException', (err) => { store.error('process', 'uncaughtException', err); store.flush() })
  process.on('warning', (w) => { store.warn('process', `node warning: ${w.name}`, { message: w.message }) })
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { store.info('process', `received ${sig} — shutting down`); store.flush() })
  }
}
