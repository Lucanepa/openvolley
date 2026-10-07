/**
 * Event history: every undo, delete and edit of a logged event leaves a row in
 * `event_history` (Dexie v20) and, for a cloud match, a sync job that voids or
 * edits the server's copy (POST /api/match/event-revisions). Nothing is lost
 * when a point is undone: the server keeps the row, marked voided, and the
 * revision says who undid it, when and why.
 *
 * Done with Dexie table hooks on db.events (like utils/nativeBackup/
 * matchWriteHook), so every delete and edit is seen whichever screen made it.
 * The caller says WHY through withActivityContext({ reason }) around the
 * action (scoring is serialised by the scoreboard's event mutex, so one
 * module-level context is enough); without one a delete is 'delete' and an
 * edit 'other'.
 *
 * Writes happen
 *  - inside the same transaction when it includes event_history and
 *    sync_queue (EVENT_HISTORY_SCOPE: the atomic scoring actions), else
 *  - right after it commits, in one transaction of their own.
 *
 * Whole-match wipes (delete a match, replace it by a backup) are not undo:
 * they go through wipeMatchEvents / withoutEventHistory and write nothing.
 * Table.clear() fires no hooks.
 */
import Dexie from 'dexie'
import { eventExtId } from '../utils/syncIds'
import { deviceId, currentAccountId, appVersion } from '../utils/identity'
import { randomUuid } from '../utils/deviceId'
import {
  editOf, applyMods, withoutSnapshot, serverColumnsOfEdit, revisionSyncJob, normalizeReason,
  plainCopy
} from '../domain/eventRevisions'

/** Tables an action's transaction must include for the history to be written atomically. */
export const EVENT_HISTORY_SCOPE = Object.freeze(['event_history', 'sync_queue', 'activity_log'])

// ---------------------------------------------------------------------------
// Context: why the current action deletes or edits events
// ---------------------------------------------------------------------------
let context = null

/**
 * Run `fn` with `ctx` ({ reason, actionId? }) as the reason of the deletes and
 * edits it makes. Nested calls keep the outer action id unless they set one.
 */
export async function withActivityContext(ctx, fn) {
  const prev = context
  context = {
    reason: ctx?.reason ?? prev?.reason ?? null,
    actionId: ctx?.actionId ?? prev?.actionId ?? null
  }
  try {
    return await fn()
  } finally {
    context = prev
  }
}

/** The current context (tests, the activity log). */
export const currentActivityContext = () => context

// ---------------------------------------------------------------------------
// Whole-match wipes
// ---------------------------------------------------------------------------
const suppressed = new Map() // matchId -> nesting count

/** Run `fn` without history for the events of `matchId` (a wipe, a restore). */
export async function withoutEventHistory(matchId, fn) {
  suppressed.set(matchId, (suppressed.get(matchId) || 0) + 1)
  try {
    return await fn()
  } finally {
    const n = (suppressed.get(matchId) || 1) - 1
    if (n <= 0) suppressed.delete(matchId)
    else suppressed.set(matchId, n)
  }
}

// Every match (Table.clear(): Dexie 4 runs the deleting hook for each row of a
// clear while a hook is subscribed; "clear all data" is not an undo)
const ALL_MATCHES = Symbol('all matches')
const isSuppressed = (matchId) => suppressed.has(ALL_MATCHES) || suppressed.has(matchId)

/**
 * Delete every event of a match without history (the match is deleted or
 * replaced, nothing is undone). dropHistory also removes the match's history
 * rows (the match itself goes away).
 */
export async function wipeMatchEvents(database, matchId, { dropHistory = false } = {}) {
  if (matchId == null) return 0
  return withoutEventHistory(matchId, async () => {
    const n = await database.events.where('matchId').equals(matchId).delete()
    if (dropHistory && database.event_history) {
      try {
        await database.event_history.where('matchId').equals(matchId).delete()
      } catch (e) {
        console.warn('[EventHistory] could not drop the history of a deleted match:', e?.message)
      }
    }
    return n
  })
}

// ---------------------------------------------------------------------------
// Seed key cache (sync hooks cannot read the match row)
// ---------------------------------------------------------------------------
const seedCache = new Map() // matchId -> { seedKey, test }

/** Remember a match's seed_key / test flag (filled by the matches hooks). */
export function rememberSeedKey(matchId, seedKey, test) {
  if (matchId == null) return
  const prev = seedCache.get(matchId) || {}
  seedCache.set(matchId, {
    seedKey: seedKey === undefined ? prev.seedKey ?? null : seedKey || null,
    test: test === undefined ? prev.test ?? false : test === true
  })
  if (seedCache.size > 200) seedCache.delete(seedCache.keys().next().value)
}

async function matchInfo(database, matchId) {
  try {
    const m = await database.matches.get(matchId)
    if (m) rememberSeedKey(matchId, m.seed_key ?? null, m.test === true)
    return m ? { seedKey: m.seed_key || null, test: m.test === true } : seedCache.get(matchId) || null
  } catch {
    return seedCache.get(matchId) || null
  }
}

// ---------------------------------------------------------------------------
// High-water seq: an undone seq is never given out again
// ---------------------------------------------------------------------------
/**
 * The highest seq of an event of this match that has history (0 when none);
 * with { from, to } only seqs in that range (the sub-events of one base seq).
 */
export async function maxVoidedSeq(database, matchId, { from, to } = {}) {
  if (matchId == null || !database?.event_history) return 0
  try {
    const last = await database.event_history
      .where('[matchId+seq]')
      .between([matchId, from ?? Dexie.minKey], [matchId, to ?? Dexie.maxKey], true, true)
      .last()
    const seq = Number(last?.seq)
    return Number.isFinite(seq) ? seq : 0
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Listeners (the activity log)
// ---------------------------------------------------------------------------
const listeners = new Set()

/** Called with every history row after it is stored. Returns an unsubscribe. */
export function onEventHistory(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify(rows) {
  for (const fn of listeners) {
    for (const row of rows) {
      try { fn(row) } catch (e) { console.warn('[EventHistory] listener failed:', e) }
    }
  }
}

// ---------------------------------------------------------------------------
// Rows and their writes
// ---------------------------------------------------------------------------
function baseRow(op, eventId, event, ctx) {
  return {
    revUid: randomUuid(),
    matchId: event?.matchId ?? null,
    eventId,
    eventExt: null,
    seq: Number.isFinite(Number(event?.seq)) ? Number(event.seq) : 0,
    setIndex: event?.setIndex ?? null,
    type: event?.type ?? null,
    op,
    reason: normalizeReason(ctx?.reason, op === 'void' ? 'delete' : 'other'),
    actionId: ctx?.actionId ?? null,
    ts: new Date().toISOString(),
    deviceId: deviceId(),
    accountId: currentAccountId(),
    appVersion: appVersion()
  }
}

/** Store rows (+ their sync jobs) in `tx` when it has the tables, else after it commits. */
function persist(database, tx, rows) {
  if (!rows.length) return
  const names = tx?.storeNames || []
  const inTx = names.includes('event_history') && names.includes('sync_queue')
  if (inTx) {
    try {
      const hist = tx.table('event_history')
      const queue = tx.table('sync_queue')
      const deferred = []
      for (const row of rows) {
        const cached = seedCache.get(row.matchId)
        if (cached) row.eventExt = cached.seedKey ? eventExtId(cached.seedKey, row.eventId) : null
        hist.add(row).catch(e => console.warn('[EventHistory] in-transaction write failed:', e?.message))
        if (cached) {
          const job = revisionSyncJob(row, cached, eventExtId)
          if (job) queue.add(job).catch(e => console.warn('[EventHistory] in-transaction job failed:', e?.message))
        } else {
          deferred.push(row)
        }
      }
      tx.on('complete', () => {
        notify(rows)
        if (deferred.length) queueJobsLater(database, deferred)
      })
      return
    } catch (e) {
      console.warn('[EventHistory] in-transaction write impossible, writing after commit:', e?.message)
    }
  }
  collectAfterCommit(database, tx, rows)
}

// Rows of one transaction are written together once it commits
const pendingByTx = new WeakMap()

function collectAfterCommit(database, tx, rows) {
  if (tx && typeof tx === 'object' && typeof tx.on === 'function') {
    let batch = pendingByTx.get(tx)
    if (!batch) {
      batch = []
      pendingByTx.set(tx, batch)
      try {
        tx.on('complete', () => {
          pendingByTx.delete(tx)
          writeLater(database, batch)
        })
      } catch {
        pendingByTx.delete(tx)
        setTimeout(() => writeLater(database, batch), 0)
      }
    }
    batch.push(...rows)
    return
  }
  setTimeout(() => writeLater(database, rows), 0)
}

const writeQueue = { p: Promise.resolve() }

/** The last op (void / restore) of each event of a match that has one. */
async function lastVoidOps(database, matchId) {
  const out = new Map()
  const rows = await database.event_history.where('matchId').equals(matchId).toArray()
  rows.sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
  for (const h of rows) if (h.op === 'void' || h.op === 'restore') out.set(h.eventId, h.op)
  return out
}

// After-commit writes run one after the other, in hook order
function writeLater(database, input) {
  writeQueue.p = writeQueue.p.then(async () => {
    if (!input?.length) return
    const byMatch = new Map()
    for (const row of input) {
      if (!byMatch.has(row.matchId)) byMatch.set(row.matchId, await matchInfo(database, row.matchId))
    }
    let stored = []
    await database.transaction('rw', database.event_history, database.sync_queue, async () => {
      // An add under an explicit id only restores an event voided here before
      const opsByMatch = new Map()
      const rows = []
      for (const row of input) {
        if (row.op === 'restore') {
          if (!opsByMatch.has(row.matchId)) opsByMatch.set(row.matchId, await lastVoidOps(database, row.matchId))
          const ops = opsByMatch.get(row.matchId)
          if (ops.get(row.eventId) !== 'void') continue
          ops.set(row.eventId, 'restore')
        }
        const info = byMatch.get(row.matchId)
        row.eventExt = info?.seedKey ? eventExtId(info.seedKey, row.eventId) : null
        rows.push(row)
      }
      if (!rows.length) return
      await database.event_history.bulkAdd(rows)
      const jobs = rows.map(r => revisionSyncJob(r, byMatch.get(r.matchId), eventExtId)).filter(Boolean)
      if (jobs.length) await database.sync_queue.bulkAdd(jobs)
      stored = rows
    })
    if (stored.length) notify(stored)
  }).catch(e => console.warn('[EventHistory] could not store the history of an event change:', e?.message || e))
  return writeQueue.p
}

function queueJobsLater(database, rows) {
  writeQueue.p = writeQueue.p.then(async () => {
    const jobs = []
    for (const row of rows) {
      const info = await matchInfo(database, row.matchId)
      if (info?.seedKey && !row.eventExt) {
        row.eventExt = eventExtId(info.seedKey, row.eventId)
        if (row.id != null) await database.event_history.update(row.id, { eventExt: row.eventExt })
      }
      const job = revisionSyncJob(row, info, eventExtId)
      if (job) jobs.push(job)
    }
    if (jobs.length) await database.sync_queue.bulkAdd(jobs)
  }).catch(e => console.warn('[EventHistory] could not queue the sync of an event change:', e?.message || e))
}

/** Wait for the history writes scheduled so far (tests, before an export). */
export function eventHistorySettled() {
  return writeQueue.p
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
let installedOn = null

/**
 * Install the db.events hooks (once per database). Called by db/db.js at
 * module load; tests call it with their own database.
 */
export function installEventHistoryHooks(database) {
  if (!database?.events?.hook || !database.event_history) return
  if (installedOn === database) return
  installedOn = database

  // clear() empties the table without history (see ALL_MATCHES): a full-range
  // deleteRange of events runs with every match suppressed. Outside the hooks
  // middleware (level 2), which fires the deleting hook for each row.
  if (typeof database.use === 'function') {
    database.use({
      stack: 'dbcore',
      name: 'OvEventHistoryClear',
      level: 10,
      create (down) {
        return {
          ...down,
          table (name) {
            const t = down.table(name)
            if (name !== 'events') return t
            return {
              ...t,
              mutate (req) {
                if (req?.type !== 'deleteRange' || req.range?.type !== 3) return t.mutate(req)
                suppressed.set(ALL_MATCHES, (suppressed.get(ALL_MATCHES) || 0) + 1)
                const leave = () => {
                  const n = (suppressed.get(ALL_MATCHES) || 1) - 1
                  if (n <= 0) suppressed.delete(ALL_MATCHES)
                  else suppressed.set(ALL_MATCHES, n)
                }
                let p
                try {
                  p = t.mutate(req)
                } catch (e) {
                  leave()
                  throw e
                }
                return Promise.resolve(p).finally(leave)
              }
            }
          }
        }
      }
    })
  }

  database.events.hook('deleting', function (primKey, obj, tx) {
    try {
      if (!obj || isSuppressed(obj.matchId)) return
      const row = baseRow('void', primKey, obj, context)
      row.before = withoutSnapshot(obj)
      persist(database, tx, [row])
    } catch (e) {
      console.warn('[EventHistory] delete hook failed:', e)
    }
  })

  database.events.hook('updating', function (mods, primKey, obj, tx) {
    try {
      if (!obj || isSuppressed(obj.matchId)) return
      const changed = editOf(mods, obj)
      if (!changed) return
      const afterFull = applyMods(obj, mods, Dexie.setByKeyPath)
      const row = baseRow('edit', primKey, afterFull, context)
      row.seq = Number.isFinite(Number(obj.seq)) ? Number(obj.seq) : row.seq
      row.before = withoutSnapshot(obj)
      row.after = withoutSnapshot(afterFull)
      row.changed = changed
      row.serverAfter = serverColumnsOfEdit(obj, afterFull)
      persist(database, tx, [row])
    } catch (e) {
      console.warn('[EventHistory] update hook failed:', e)
    }
  })

  // An event put back under its old id (undo of a decision change restores
  // the sub-events it removed): the server copy is un-voided.
  database.events.hook('creating', function (primKey, obj, tx) {
    try {
      if (primKey == null || !obj || isSuppressed(obj.matchId)) return
      const row = baseRow('restore', primKey, obj, context)
      row.after = withoutSnapshot(obj)
      row.serverAfter = serverColumnsOfEdit(obj, obj)
      collectAfterCommit(database, tx, [row])
    } catch (e) {
      console.warn('[EventHistory] create hook failed:', e)
    }
  })

  // seed_key cache for in-transaction sync jobs
  if (database.matches?.hook) {
    database.matches.hook('creating', function (primKey, obj, tx) {
      const remember = (key) => rememberSeedKey(key, obj?.seed_key ?? null, obj?.test === true)
      if (primKey != null) remember(primKey)
      else this.onsuccess = (key) => remember(key)
      void tx
    })
    database.matches.hook('updating', function (mods, primKey, obj) {
      if (mods && ('seed_key' in mods || 'test' in mods)) {
        rememberSeedKey(primKey, 'seed_key' in mods ? mods.seed_key : obj?.seed_key, 'test' in mods ? mods.test === true : obj?.test === true)
      }
    })
  }
}

/** Plain copy of a history row for exports (no Dexie internals). */
export const historyRowForExport = (row) => plainCopy(row)
