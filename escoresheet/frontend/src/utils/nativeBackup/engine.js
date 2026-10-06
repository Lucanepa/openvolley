/**
 * Native auto-backup engine: writes one backup file per scoring event.
 *
 * notify(matchId) is called after every committed write of the match (event,
 * set or match status). It never blocks the caller: the work runs in the
 * background, one match backup at a time. Triggers that arrive while a backup
 * is waiting fold into it (it reads the newest state when it starts), and a
 * state identical to the last one written is skipped, so a point (event +
 * snapshot + set update) produces one file. Errors are logged and reported as
 * status, never thrown or alerted.
 */

import {
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_MAX_PER_MATCH,
  eventFileName,
  isEventFile,
  latestEventSeq,
  matchFolderName,
  planMatchRotation,
  planRotation
} from './rotation'

/** Backup JSON without the volatile lastUpdated stamp (the coalescing key). */
function serialize(data) {
  const { lastUpdated: _ignored, ...rest } = data || {}
  return JSON.stringify(rest)
}

/** Same file format as exportMatchData/downloadMatchBackup, lastUpdated last. */
function withLastUpdated(body, iso) {
  return `${body.slice(0, -1)}${body.length > 2 ? ',' : ''}"lastUpdated":${JSON.stringify(iso)}}`
}

export function createNativeBackupEngine({
  store,
  exportMatch,
  now = () => new Date(),
  settleMs = 120,
  maxPerMatch = DEFAULT_MAX_PER_MATCH,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  log = console
}) {
  const pending = new Map() // matchId -> { force }
  const lastBody = new Map() // matchId -> last written body
  const known = new Map() // matchDir -> event file names on disk (sorted)
  const listeners = new Set()
  let running = null
  let lastStamp = 0
  let cleanupDone = null

  let status = { folder: null, lastBackup: null, lastFile: null, error: null, count: 0 }
  const setStatus = (patch) => {
    status = { ...status, ...patch }
    for (const l of listeners) {
      try { l(status) } catch { /* listener errors never reach the engine */ }
    }
  }

  // Once per session: list everything, apply the 30-day / per-match rotation
  // and remember the current event files of every match folder.
  async function startupCleanup() {
    try {
      const dirs = await store.list()
      for (const d of dirs) known.set(d.dir, d.files.map(f => f.name).filter(isEventFile).sort())
      const plan = planRotation(dirs, { now: now().getTime(), maxPerMatch, maxAgeDays })
      for (const { dir, names } of plan) {
        await store.remove(dir, names)
        const left = new Set(names)
        known.set(dir, (known.get(dir) || []).filter(n => !left.has(n)))
      }
      if (plan.length) log.info?.(`[NativeBackup] rotation removed ${plan.reduce((n, p) => n + p.names.length, 0)} old backup file(s)`)
    } catch (e) {
      log.warn?.('[NativeBackup] rotation skipped:', e?.message || e)
    }
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
    const body = serialize(data)
    if (!force && lastBody.get(matchId) === body) return null // identical state: coalesced

    if (!cleanupDone) cleanupDone = startupCleanup()
    await cleanupDone

    const stamp = nextStamp()
    const dir = matchFolderName(data.match, matchId)
    const name = eventFileName(stamp, latestEventSeq(data))
    await store.write(dir, name, withLastUpdated(body, stamp.toISOString()), { latest: true })
    lastBody.set(matchId, body)

    const names = known.get(dir) || []
    names.push(name)
    known.set(dir, names)
    const doomed = planMatchRotation(names, { now: stamp.getTime(), maxPerMatch, maxAgeDays })
    if (doomed.length) {
      const gone = new Set(doomed)
      known.set(dir, names.filter(n => !gone.has(n)))
      try {
        await store.remove(dir, doomed)
      } catch (e) {
        log.warn?.('[NativeBackup] could not delete old backups:', e?.message || e)
      }
    }
    return { dir, name, at: stamp }
  }

  async function drain() {
    // let the scorer's own writes (snapshot, sync queue, UI) finish first
    await new Promise(r => setTimeout(r, settleMs))
    while (pending.size) {
      const [matchId, opts] = pending.entries().next().value
      pending.delete(matchId)
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
        setStatus({ error: e?.message || String(e) })
      }
    }
  }

  function kick() {
    if (running) return running
    running = drain().finally(() => {
      running = null
      if (pending.size) kick()
    })
    return running
  }

  return {
    /** A write of this match was committed: back it up (in the background). */
    notify(matchId, { force = false } = {}) {
      if (matchId == null) return
      const prev = pending.get(matchId)
      pending.set(matchId, { force: force || !!prev?.force })
      kick()
    },
    /** Write a backup now, even when the state did not change. Resolves when written. */
    async backupNow(matchId) {
      this.notify(matchId, { force: true })
      while (running) await running
      return status
    },
    /** Resolves once every queued backup is written (tests, shutdown). */
    async flush() {
      while (running) await running
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
