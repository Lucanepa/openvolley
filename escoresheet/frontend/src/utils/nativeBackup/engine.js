/**
 * Native auto-backup engine: writes one backup file per scoring event.
 *
 * notify(matchId) is called after every committed write of the match (event,
 * set, match row, players). It never blocks the caller: the work runs in the
 * background, one match backup at a time.
 *
 *  - Quiet window: a backup starts only once the match has had no write for
 *    quietMs (re-armed by every notify), and at the latest maxWaitMs after the
 *    first one. A point is several writes (event, its snapshot, the set score)
 *    that can be spread over more than 100 ms on a slow tablet: they make ONE
 *    file of the finished state, never a half-written one.
 *  - Then it waits for an idle moment (requestIdleCallback) before reading
 *    IndexedDB and serializing, so the scorer's next tap goes first.
 *  - A state equal to the last one written (ignoring heartbeats, sessions and
 *    sync stamps) is skipped.
 *  - Rotation of older backups runs after the first file of the session is
 *    written, in small chunks on idle.
 *
 * Errors are logged and reported as status, never thrown or alerted.
 */

import {
  DEFAULT_IDLE_AFTER_HOURS,
  DEFAULT_IDLE_KEEP,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_MAX_BYTES_PER_MATCH,
  DEFAULT_MAX_PER_MATCH,
  eventFileName,
  isEventFile,
  latestEventSeq,
  matchFolderName,
  planMatchRotation
} from './rotation'
import { redactMatch, stableMatch, SECRETS_REMOVED } from './redact'
import { emitActivity } from '../activity/bus'

const REMOVE_CHUNK = 20

/**
 * The file text and the coalescing key of a backup, each top-level part
 * serialized once (the events are the bulk of it). The file has the
 * exportMatchData/downloadMatchBackup format without the match PINs, with
 * `secretsRemoved` and `lastUpdated` added. The key leaves out lastUpdated
 * and the match's bookkeeping fields.
 */
export function serializeBackup(data) {
  const parts = []
  const keyParts = []
  for (const [k, v] of Object.entries(data || {})) {
    if (k === 'lastUpdated' || k === SECRETS_REMOVED) continue
    const value = k === 'match' ? redactMatch(v) : v
    const json = JSON.stringify(value)
    if (json === undefined) continue
    const prop = `${JSON.stringify(k)}:${json}`
    parts.push(prop)
    keyParts.push(k === 'match' ? `${JSON.stringify(k)}:${JSON.stringify(stableMatch(value))}` : prop)
  }
  return {
    key: `{${keyParts.join(',')}}`,
    build: (iso) => `{${[...parts, `"${SECRETS_REMOVED}":true`, `"lastUpdated":${JSON.stringify(iso)}`].join(',')}}`
  }
}

const defaultIdle = (fn) => {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(() => fn(), { timeout: 1000 })
  } else {
    setTimeout(fn, 0)
  }
}

export function createNativeBackupEngine({
  store,
  exportMatch,
  now = () => new Date(),
  clock = () => Date.now(),
  quietMs,
  settleMs, // older name of quietMs
  maxWaitMs = 1500,
  idle = defaultIdle,
  maxPerMatch = DEFAULT_MAX_PER_MATCH,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  maxBytesPerMatch = DEFAULT_MAX_BYTES_PER_MATCH,
  idleKeep = DEFAULT_IDLE_KEEP,
  idleAfterHours = DEFAULT_IDLE_AFTER_HOURS,
  log = console
}) {
  const quiet = quietMs ?? settleMs ?? 150
  const rotation = { maxPerMatch, maxAgeDays, maxBytesPerMatch, idleKeep, idleAfterHours }
  const pending = new Map() // matchId -> { force }
  const lastKey = new Map() // matchId -> coalescing key of the last file written
  const known = new Map() // matchDir -> [{ name, size }] event files on disk
  const writtenDirs = new Set() // folders this session writes (rotated after each write)
  const listeners = new Set()
  let running = null
  let timer = null
  let batchStart = null // clock() of the first notify not yet picked up
  let lastStamp = 0
  let cleanup = null // the session's rotation of older folders (started after the first write)
  let settled = null
  let resolveSettled = null

  let status = { folder: null, lastBackup: null, lastFile: null, error: null, count: 0 }
  const setStatus = (patch) => {
    status = { ...status, ...patch }
    for (const l of listeners) {
      try { l(status) } catch { /* listener errors never reach the engine */ }
    }
  }

  const nextIdle = () => new Promise(resolve => {
    try { idle(resolve) } catch { resolve() }
  })

  function busy() {
    if (!settled) settled = new Promise(r => { resolveSettled = r })
  }
  let writeWaiters = [] // backupNow callers: resolved once the queued files are written
  function maybeSettled() {
    if (timer || running || pending.size) return
    for (const resolve of writeWaiters.splice(0)) resolve()
    if (cleanup && !cleanup.done) return
    const r = resolveSettled
    settled = null
    resolveSettled = null
    r?.()
  }

  function addKnown(dir, files) {
    const byName = new Map((known.get(dir) || []).map(f => [f.name, f]))
    for (const f of files) if (isEventFile(f.name) && !byName.has(f.name)) byName.set(f.name, f)
    known.set(dir, [...byName.values()])
  }
  function dropKnown(dir, names) {
    const gone = new Set(names)
    known.set(dir, (known.get(dir) || []).filter(f => !gone.has(f.name)))
  }

  async function removeInChunks(dir, names) {
    for (let i = 0; i < names.length; i += REMOVE_CHUNK) {
      await store.remove(dir, names.slice(i, i + REMOVE_CHUNK))
      if (i + REMOVE_CHUNK < names.length) await nextIdle()
    }
  }

  // Once per session, after the first file is written: list every folder,
  // rotate the ones this session does not write (age, count, size, idle
  // thinning) and learn the files already in the ones it does.
  function startCleanup() {
    if (cleanup) return
    const job = { done: false }
    cleanup = job
    job.promise = (async () => {
      await nextIdle()
      try {
        const dirs = await store.list()
        let removed = 0
        for (const d of dirs) {
          const files = (d.files || []).map(f => (typeof f === 'string' ? { name: f, size: 0 } : { name: f.name, size: f.size || 0 }))
          addKnown(d.dir, files)
          if (writtenDirs.has(d.dir)) continue // rotated by its next backup
          const names = planMatchRotation(known.get(d.dir), { now: now().getTime(), ...rotation })
          if (!names.length) continue
          dropKnown(d.dir, names)
          await nextIdle()
          await removeInChunks(d.dir, names)
          removed += names.length
        }
        if (removed) log.info?.(`[NativeBackup] rotation removed ${removed} old backup file(s)`)
      } catch (e) {
        log.warn?.('[NativeBackup] rotation skipped:', e?.message || e)
      } finally {
        job.done = true
        maybeSettled()
      }
    })()
  }

  function nextStamp() {
    // strictly increasing, so two backups in the same millisecond never collide
    const t = Math.max(now().getTime(), lastStamp + 1)
    lastStamp = t
    return new Date(t)
  }

  async function backupOnce(matchId, { force = false } = {}) {
    const data = await exportMatch(matchId)
    if (!data?.match) return null
    const { key, build } = serializeBackup(data)
    if (!force && lastKey.get(matchId) === key) return null // same scoring state: coalesced

    const stamp = nextStamp()
    const dir = matchFolderName(data.match, matchId)
    const name = eventFileName(stamp, latestEventSeq(data))
    const text = build(stamp.toISOString())
    const result = await store.write(dir, name, text, { latest: true })
    if (result?.warning) log.warn?.('[NativeBackup]', result.warning)
    lastKey.set(matchId, key)
    writtenDirs.add(dir)
    addKnown(dir, [{ name, size: text.length }])

    const doomed = planMatchRotation(known.get(dir), { now: stamp.getTime(), ...rotation })
    if (doomed.length) {
      dropKnown(dir, doomed)
      try {
        await store.remove(dir, doomed)
      } catch (e) {
        log.warn?.('[NativeBackup] could not delete old backups:', e?.message || e)
      }
    }
    startCleanup()
    return { dir, name, at: stamp }
  }

  // The matches queued when the quiet window ended; writes that land while
  // they are exported start a new quiet window (start().finally).
  async function drain() {
    const batch = [...pending]
    pending.clear()
    for (const [matchId, opts] of batch) {
      try {
        const written = await backupOnce(matchId, opts)
        if (written) {
          let folder = status.folder
          if (!folder) {
            try { folder = (await store.info())?.folder || null } catch { /* label only */ }
          }
          setStatus({ folder, lastBackup: written.at, lastFile: `${written.dir}/${written.name}`, error: null, count: status.count + 1 })
        }
      } catch (e) {
        log.error?.('[NativeBackup] backup failed:', e)
        emitActivity('backup.error', { message: e?.message || String(e) }, { level: 'error', matchId })
        setStatus({ error: e?.message || String(e) })
      }
    }
  }

  function start() {
    timer = null
    if (running) return
    batchStart = null
    running = (async () => {
      await nextIdle() // the scorer's own work first
      await drain()
    })().finally(() => {
      running = null
      if (pending.size) schedule()
      else maybeSettled()
    })
  }

  // (Re)arm the quiet window; a backup already exporting picks the next
  // notify up when it ends.
  function schedule() {
    if (running) return
    if (timer) clearTimeout(timer)
    const waited = batchStart == null ? 0 : clock() - batchStart
    timer = setTimeout(start, Math.max(0, Math.min(quiet, maxWaitMs - waited)))
  }

  return {
    /** A write of this match was committed: back it up (in the background). */
    notify(matchId, { force = false } = {}) {
      if (matchId == null) return
      busy()
      if (batchStart == null) batchStart = clock()
      const prev = pending.get(matchId)
      pending.set(matchId, { force: force || !!prev?.force })
      schedule()
    },
    /** Write a backup now, even when the state did not change. Resolves when written (not waiting for rotation). */
    async backupNow(matchId) {
      const written = new Promise(resolve => writeWaiters.push(resolve))
      this.notify(matchId, { force: true })
      await written
      return status
    },
    /** Resolves once every queued backup is written and the rotation is done (tests, shutdown). */
    async flush() {
      while (settled) await settled
    },
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Resolve the folder label without writing anything (Options UI). */
    async loadFolder() {
      try {
        const folder = (await store.info())?.folder || null
        if (folder !== status.folder) setStatus({ folder })
        return folder
      } catch (e) {
        setStatus({ error: e?.message || String(e) })
        return null
      }
    },
    store
  }
}
