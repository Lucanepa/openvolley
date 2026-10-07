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

// More events than this in one transaction (a backup restore, a test match
// generator) are one 'event.bulk_add' entry
export const BULK_EVENTS = 20
// How long an event.add waits for its state snapshot (the score)
export const SNAPSHOT_WAIT_MS = 2000

function afterCommit(tx, fn) {
  const run = () => {
    try { fn() } catch (e) { console.warn('[Activity] hook callback failed:', e) }
  }
  try {
    if (tx && typeof tx.on === 'function') {
      tx.on('complete', run)
      return
    }
  } catch { /* fall through */ }
  setTimeout(run, 0)
}

/**
 * @param {import('dexie').Dexie} db
 * @param {{ record: Function, rememberMatch: Function }} writer
 * @returns {() => void} uninstall
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
        afterCommit(tx, () => {
          if (tx) batches.delete(tx)
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
      batch.push({ key, event: obj, at })
    }
    if (primKey != null) onKey(primKey)
    else self.onsuccess = onKey
  })
  add(db.events, 'updating', function (mods, primKey, obj) {
    if (!waiting.has(primKey) || !mods) return
    const snap = 'stateSnapshot' in mods ? mods.stateSnapshot : null
    if (!snap) return
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
  add(db.sets, 'deleting', function (primKey, obj, tx) {
    if (!obj) return
    afterCommit(tx, () => record('set.delete', { set: obj.index ?? null, home: obj.homePoints ?? null, away: obj.awayPoints ?? null }, { matchId: obj.matchId, setIndex: obj.index }))
  })

  // ---- the match row
  add(db.matches, 'creating', function (primKey, obj, tx) {
    if (!obj) return
    const self = this
    const onKey = (key) => {
      writer.rememberMatch(key, obj.seed_key ?? null, obj.test === true)
      afterCommit(tx, () => record('match.create', { status: obj.status ?? null, test: obj.test === true }, { matchId: key }))
    }
    if (primKey != null) onKey(primKey)
    else self.onsuccess = onKey
  })
  add(db.matches, 'updating', function (mods, primKey, obj, tx) {
    if (!mods) return
    if ('seed_key' in mods || 'test' in mods) {
      writer.rememberMatch(primKey, 'seed_key' in mods ? mods.seed_key : obj?.seed_key, 'test' in mods ? mods.test === true : obj?.test === true)
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
    afterCommit(tx, () => record('match.roster', { team, number: obj.number ?? null, op: 'remove' }, { matchId }))
  })

  return () => {
    for (const off of offs.splice(0)) {
      try { off() } catch { /* gone */ }
    }
    for (const w of waiting.values()) clearTimeout(w.timer)
    waiting.clear()
  }
}
