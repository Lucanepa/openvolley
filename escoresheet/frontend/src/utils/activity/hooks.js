/**
 * Activity entries from the database writes themselves (Dexie table hooks,
 * as utils/nativeBackup/matchWriteHook): every event added, every undo /
 * delete / edit (db/eventHistory), set start / end / reopen / delete, the
 * match row's status, coin toss, signatures, approvals, remarks, forfeit and
 * manual changes, and roster changes of the open match's teams. Whichever
 * screen wrote them. Recorded after the transaction commits, never inside it.
 */
import {
  eventActivityData, historyKind, historyActivityData, matchUpdateEntries, setUpdateEntry
} from '../../domain/activitySummary'
import { LOCAL_ONLY_EVENT_TYPES } from '../../domain/eventRevisions'
import { onEventHistory } from '../../db/eventHistory'
import { getActiveMatch, setActiveMatch } from './activeMatch'
import { isLocalOnly } from '../../domain/matchKind'

// More events than this in one transaction (a backup restore, a test match
// generator) are one 'event.bulk_add' entry
export const BULK_EVENTS = 20
// How long an event.add waits for its state snapshot (the score)
export const SNAPSHOT_WAIT_MS = 2000

// Callbacks after a transaction's commit, in the order they were added: Dexie
// fires a transaction's 'complete' listeners last-added first, which wrote a
// transaction's entries in reverse (review 6a). One listener per transaction
// runs its queue in order.
const commitQueues = new WeakMap() // tx -> [fn]
function afterCommit(tx, fn) {
  const run = (f) => {
    try { f() } catch (e) { console.warn('[Activity] hook callback failed:', e) }
  }
  try {
    if (tx && typeof tx.on === 'function') {
      let queue = commitQueues.get(tx)
      if (!queue) {
        queue = []
        commitQueues.set(tx, queue)
        tx.on('complete', () => {
          commitQueues.delete(tx)
          for (const f of queue) run(f)
        })
      }
      queue.push(fn)
      return
    }
  } catch { /* fall through */ }
  setTimeout(() => run(fn), 0)
}

/**
 * @param {import('dexie').Dexie} db
 * @param {{ record: Function, rememberMatch: Function }} writer
 * @returns {(() => void) & { flushWaiting: () => void }} uninstall (+ flushWaiting: tell the adds still waiting now)
 */
export function installActivityHooks(db, writer) {
  const offs = []
  const add = (table, type, fn) => {
    if (!table?.hook) return
    table.hook(type, fn)
    offs.push(() => table.hook(type).unsubscribe(fn))
  }
  const record = (kind, data, opts) => writer.record(kind, data, opts)

  // The open match follows the writes: a match-scoped write of another match
  // (a restore, the scoreboard of another match) moves the log context there.
  const follow = (matchId) => {
    if (matchId == null || getActiveMatch()?.id === matchId) return
    Promise.resolve(db.matches?.get?.(matchId)).then((m) => { if (m) setActiveMatch(m) }).catch(() => {})
  }

  // ---- events: added (score from the snapshot, which logEvent writes right after)
  const waiting = new Map() // event id -> { event, timer }
  const emitAdd = (id) => {
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    clearTimeout(w.timer)
    const e = w.event
    record('event.add', eventActivityData(e), { matchId: e.matchId, setIndex: e.setIndex, eventSeq: e.seq, ts: w.at })
  }
  const batches = new WeakMap()
  // Adds not committed yet, by event id: a scorer action (useScorerActions)
  // writes the event AND its snapshot in one transaction, so the snapshot
  // update comes before the commit, while the add is not waiting yet
  const uncommitted = new Map() // event id -> batch entry
  const forget = (list) => {
    for (const b of list) if (uncommitted.get(b.key) === b) uncommitted.delete(b.key)
  }
  add(db.events, 'creating', function (primKey, obj, tx) {
    if (!obj) return
    const self = this
    // The entry keeps the time of the add, not of the snapshot that follows
    // (up to SNAPSHOT_WAIT_MS later), so the log stays in the order of play
    const at = new Date().toISOString()
    const onKey = (key) => {
      let batch = tx ? batches.get(tx) : null
      if (!batch) {
        batch = []
        if (tx) batches.set(tx, batch)
        // Rolled back: none of its adds happened (and their ids can be given out again)
        try { if (tx && typeof tx.on === 'function') tx.on('abort', () => forget(batch)) } catch { /* no abort event */ }
        afterCommit(tx, () => {
          if (tx) batches.delete(tx)
          forget(batch)
          const byMatch = new Map()
          for (const b of batch) {
            if (!byMatch.has(b.event.matchId)) byMatch.set(b.event.matchId, [])
            byMatch.get(b.event.matchId).push(b)
          }
          for (const [matchId, list] of byMatch) {
            follow(matchId)
            if (list.length > BULK_EVENTS) {
              const counts = {}
              for (const b of list) counts[b.event.type] = (counts[b.event.type] || 0) + 1
              const types = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t}:${n}`)
              record('event.bulk_add', { count: list.length, types }, { matchId })
              continue
            }
            for (const b of list) {
              const e = { ...b.event, id: b.key }
              if (LOCAL_ONLY_EVENT_TYPES.includes(e.type) || e.stateSnapshot) {
                record('event.add', eventActivityData(e), { matchId: e.matchId, setIndex: e.setIndex, eventSeq: e.seq, ts: b.at })
              } else {
                waiting.set(b.key, { event: e, at: b.at, timer: setTimeout(() => emitAdd(b.key), SNAPSHOT_WAIT_MS) })
              }
            }
          }
        })
      }
      const entry = { key, event: obj, at }
      batch.push(entry)
      if (key != null) uncommitted.set(key, entry)
    }
    if (primKey != null) onKey(primKey)
    else self.onsuccess = onKey
  })
  add(db.events, 'updating', function (mods, primKey, obj) {
    if (!mods) return
    const snap = 'stateSnapshot' in mods ? mods.stateSnapshot : null
    if (!snap) return
    // Added in the same transaction: told with its score right after the commit
    const pending = uncommitted.get(primKey)
    if (pending) {
      pending.event = { ...pending.event, stateSnapshot: snap }
      return
    }
    if (!waiting.has(primKey)) return
    waiting.get(primKey).event = { ...waiting.get(primKey).event, stateSnapshot: snap }
    setTimeout(() => emitAdd(primKey), 0)
    void obj
  })
  add(db.events, 'deleting', function (primKey) {
    // undone before its snapshot: the add is still told (the undo follows)
    if (waiting.has(primKey)) emitAdd(primKey)
  })

  // ---- events: undo / delete / edit / restore (db/eventHistory rows)
  offs.push(onEventHistory((row) => {
    record(historyKind(row), historyActivityData(row), {
      matchId: row.matchId,
      setIndex: row.setIndex,
      eventSeq: row.seq,
      eventExt: row.eventExt
    })
  }))

  // ---- sets
  add(db.sets, 'creating', function (primKey, obj, tx) {
    if (!obj) return
    afterCommit(tx, () => record('set.start', { set: obj.index ?? null, home: obj.homePoints ?? 0, away: obj.awayPoints ?? 0 }, { matchId: obj.matchId, setIndex: obj.index }))
  })
  add(db.sets, 'updating', function (mods, primKey, obj, tx) {
    const entry = setUpdateEntry(mods, obj)
    if (!entry) return
    afterCommit(tx, () => {
      record(entry.kind, entry.data, { matchId: obj?.matchId, setIndex: obj?.index })
      if (entry.kind === 'set.end') writer.setEnded?.()
    })
  })
  // ---- removals: a match removed from this device (Close match, Home's
  // remove) takes its sets, players and teams with it in one transaction.
  // That is local clean-up, not a data change: the server keeps the match.
  // One 'match.local_remove' entry says so, instead of a "Set removed" and a
  // "Roster changed ... remove" per row (UI tour 14.11). A set or player
  // removed while its match stays is logged as before.
  // Each row and each match keeps its own place in the log: every one has its
  // own after-commit callback, in the order of the deletes; the first to run
  // settles the whole transaction (which rows went with a removed match, and
  // the counts) once every delete in it is known.
  const removals = new WeakMap() // tx -> { matches: Map(id -> counts), teamMatch: Map(teamId -> matchId), rows: [], settled }
  const removalOf = (tx) => {
    let r = removals.get(tx)
    if (r) return r
    r = { matches: new Map(), teamMatch: new Map(), rows: [], settled: false }
    removals.set(tx, r)
    return r
  }
  // The removed match a row went with, or null (the row's removal is logged)
  const ownerOf = (r, row) => {
    if (row.matchId != null && r.matches.has(row.matchId)) return row.matchId
    if (row.teamId != null && r.teamMatch.has(row.teamId)) return r.teamMatch.get(row.teamId)
    return null
  }
  const settle = (tx, r) => {
    if (r.settled) return
    r.settled = true
    removals.delete(tx)
    for (const row of r.rows) {
      row.owner = ownerOf(r, row)
      // a team removed with no removed match of its own: its rows are not
      // counted anywhere, so they are logged (as before) and not lost
      if (row.owner == null) continue
      r.matches.get(row.owner)[row.count] += 1
    }
  }
  const removed = (tx, row) => {
    if (!tx || typeof tx.on !== 'function') { afterCommit(tx, () => record(row.kind, row.data, row.opts)); return }
    const r = removalOf(tx)
    r.rows.push(row)
    afterCommit(tx, () => {
      settle(tx, r)
      if (row.owner == null) record(row.kind, row.data, row.opts)
    })
  }

  add(db.sets, 'deleting', function (primKey, obj, tx) {
    if (!obj) return
    removed(tx, {
      kind: 'set.delete', count: 'sets', matchId: obj.matchId,
      data: { set: obj.index ?? null, home: obj.homePoints ?? null, away: obj.awayPoints ?? null },
      opts: { matchId: obj.matchId, setIndex: obj.index }
    })
  })
  add(db.matches, 'deleting', function (primKey, obj, tx) {
    if (primKey == null) return
    if (!tx || typeof tx.on !== 'function') { afterCommit(tx, () => record('match.local_remove', { sets: 0, players: 0 }, { matchId: primKey })); return }
    const r = removalOf(tx)
    const counts = { sets: 0, players: 0 }
    r.matches.set(primKey, counts)
    // its teams' players go with it, whichever match the hook saw as active
    for (const teamId of [obj?.homeTeamId, obj?.awayTeamId]) {
      if (teamId != null) r.teamMatch.set(teamId, primKey)
    }
    afterCommit(tx, () => {
      settle(tx, r)
      record('match.local_remove', counts, { matchId: primKey })
    })
  })

  // ---- the match row
  add(db.matches, 'creating', function (primKey, obj, tx) {
    if (!obj) return
    const self = this
    const onKey = (key) => {
      writer.rememberMatch(key, obj.seed_key ?? null, isLocalOnly(obj))
      afterCommit(tx, () => record('match.create', { status: obj.status ?? null, test: obj.test === true }, { matchId: key }))
    }
    if (primKey != null) onKey(primKey)
    else self.onsuccess = onKey
  })
  add(db.matches, 'updating', function (mods, primKey, obj, tx) {
    if (!mods) return
    if ('seed_key' in mods || 'test' in mods || 'global' in mods) {
      writer.rememberMatch(primKey, 'seed_key' in mods ? mods.seed_key : obj?.seed_key, isLocalOnly({ ...obj, ...mods }))
    }
    let entries
    try {
      entries = matchUpdateEntries(mods, obj)
    } catch {
      entries = []
    }
    const active = getActiveMatch()
    const teamsMoved = active?.id === primKey && ('homeTeamId' in mods || 'awayTeamId' in mods || 'gameNumber' in mods || 'game_n' in mods || 'gameN' in mods || 'seed_key' in mods)
    if (!entries.length && !teamsMoved) return
    afterCommit(tx, () => {
      for (const e of entries) record(e.kind, e.data, { matchId: primKey, level: e.level })
      if (teamsMoved) setActiveMatch({ ...obj, ...mods, id: primKey })
    })
  })

  // ---- players of the open match's teams
  const teamOf = (teamId) => {
    const a = getActiveMatch()
    if (!a || teamId == null) return null
    if (teamId === a.homeTeamId) return 'home'
    if (teamId === a.awayTeamId) return 'away'
    return null
  }
  const rosterFields = (mods, obj) => Object.keys(mods || {})
    .filter(k => !/^_|synced|updatedat/i.test(k))
    .filter(k => JSON.stringify(mods[k]) !== JSON.stringify(obj?.[k]))
  add(db.players, 'creating', function (primKey, obj, tx) {
    const team = teamOf(obj?.teamId)
    if (!team) return
    const matchId = getActiveMatch()?.id
    afterCommit(tx, () => record('match.roster', { team, number: obj.number ?? null, op: 'add' }, { matchId }))
  })
  add(db.players, 'updating', function (mods, primKey, obj, tx) {
    const team = teamOf(obj?.teamId)
    if (!team) return
    const fields = rosterFields(mods, obj)
    if (!fields.length) return
    const matchId = getActiveMatch()?.id
    afterCommit(tx, () => record('match.roster', { team, number: ('number' in mods ? mods.number : obj.number) ?? null, fields, op: 'update' }, { matchId }))
  })
  add(db.players, 'deleting', function (primKey, obj, tx) {
    const team = teamOf(obj?.teamId)
    if (!team) return
    const matchId = getActiveMatch()?.id
    removed(tx, {
      kind: 'match.roster', count: 'players', matchId, teamId: obj.teamId,
      data: { team, number: obj.number ?? null, op: 'remove' },
      opts: { matchId }
    })
  })

  const uninstall = () => {
    for (const off of offs.splice(0)) {
      try { off() } catch { /* gone */ }
    }
    for (const w of waiting.values()) clearTimeout(w.timer)
    waiting.clear()
  }
  // The app goes (quit, page hidden for good): the adds still waiting for
  // their snapshot are told now, or they would be lost with the page
  uninstall.flushWaiting = () => {
    for (const id of [...waiting.keys()]) emitAdd(id)
  }
  return uninstall
}
