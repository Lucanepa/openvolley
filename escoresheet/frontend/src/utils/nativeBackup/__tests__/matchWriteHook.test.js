import { describe, it, expect, vi } from 'vitest'
import { subscribeMatchWrites, isVolatileMatchUpdate } from '../matchWriteHook'

// Minimal stand-in for Dexie's table.hook(type, fn) / table.hook(type).unsubscribe(fn)
function hookTable() {
  const subs = { creating: new Set(), updating: new Set(), deleting: new Set() }
  return {
    subs,
    hook(type, fn) {
      if (fn) subs[type].add(fn)
      return { unsubscribe: (f) => subs[type].delete(f) }
    }
  }
}

function fakeTransaction() {
  const complete = []
  return {
    on: (event, fn) => { if (event === 'complete') complete.push(fn) },
    commit: () => complete.forEach(fn => fn())
  }
}

function fakeDb() {
  const db = { events: hookTable(), sets: hookTable(), matches: hookTable() }
  const run = (table, type, ...args) => {
    const tx = fakeTransaction()
    for (const fn of db[table].subs[type]) fn(...args, tx)
    return tx
  }
  db.create = (table, key, obj) => run(table, 'creating', key, obj)
  db.update = (table, key, obj, mods) => run(table, 'updating', mods, key, obj)
  db.remove = (table, key, obj) => run(table, 'deleting', key, obj)
  return db
}

describe('subscribeMatchWrites', () => {
  it('fires after the commit of every event write of the match (add, edit, undo)', () => {
    const db = fakeDb()
    const onWrite = vi.fn()
    subscribeMatchWrites(db, 7, onWrite)

    const tx = db.create('events', undefined, { matchId: 7, type: 'point' })
    expect(onWrite).not.toHaveBeenCalled() // never inside the transaction
    tx.commit()
    expect(onWrite).toHaveBeenCalledTimes(1)

    db.update('events', 1, { matchId: 7 }, { stateSnapshot: {} }).commit()
    db.remove('events', 1, { matchId: 7, type: 'point' }).commit() // undo
    for (const type of ['timeout', 'substitution', 'sanction', 'libero_entry', 'set_start', 'set_end', 'match_end']) {
      db.create('events', undefined, { matchId: 7, type }).commit()
    }
    expect(onWrite).toHaveBeenCalledTimes(10)

    // "rally started" alone is not backed up (the point right after is);
    // undoing it is
    db.create('events', undefined, { matchId: 7, type: 'rally_start' }).commit()
    expect(onWrite).toHaveBeenCalledTimes(10)
    db.remove('events', 2, { matchId: 7, type: 'rally_start' }).commit()
    expect(onWrite).toHaveBeenCalledTimes(11)
  })

  it('fires for set writes and match row changes, ignoring other matches and bookkeeping', () => {
    const db = fakeDb()
    const onWrite = vi.fn()
    subscribeMatchWrites(db, 7, onWrite)

    db.update('sets', 3, { matchId: 7 }, { homePoints: 5 }).commit()
    db.create('sets', undefined, { matchId: 7, index: 2 }).commit()
    db.update('matches', 7, { id: 7 }, { status: 'ended' }).commit()
    expect(onWrite).toHaveBeenCalledTimes(3)

    db.create('events', undefined, { matchId: 8 }).commit()
    db.update('sets', 4, { matchId: 8 }, { homePoints: 1 }).commit()
    db.update('matches', 8, { id: 8 }, { status: 'ended' }).commit()
    db.update('matches', 7, { id: 7 }, { refereeHeartbeat: 123 }).commit()
    db.update('matches', 7, { id: 7 }, { sessionId: 'x' }).commit()
    expect(onWrite).toHaveBeenCalledTimes(3)
  })

  it('unsubscribes every hook', () => {
    const db = fakeDb()
    const onWrite = vi.fn()
    const off = subscribeMatchWrites(db, 7, onWrite)
    off()
    db.create('events', undefined, { matchId: 7 }).commit()
    expect(onWrite).not.toHaveBeenCalled()
    for (const t of ['events', 'sets', 'matches']) {
      for (const type of ['creating', 'updating', 'deleting']) expect(db[t].subs[type].size).toBe(0)
    }
  })

  it('a throwing callback never reaches the writer', () => {
    const db = fakeDb()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    subscribeMatchWrites(db, 7, () => { throw new Error('boom') })
    expect(() => db.create('events', undefined, { matchId: 7 }).commit()).not.toThrow()
    warn.mockRestore()
  })

  it('is a no-op without a match', () => {
    const db = fakeDb()
    const off = subscribeMatchWrites(db, null, vi.fn())
    expect(db.events.subs.creating.size).toBe(0)
    off()
  })
})

describe('isVolatileMatchUpdate', () => {
  it('only treats pure bookkeeping updates as volatile', () => {
    expect(isVolatileMatchUpdate({ benchHomeHeartbeat: 1 })).toBe(true)
    expect(isVolatileMatchUpdate({ sessionId: 'a', updatedAt: 'x' })).toBe(true)
    expect(isVolatileMatchUpdate({ sessionId: 'a', status: 'ended' })).toBe(false)
    expect(isVolatileMatchUpdate({ sanctions: {} })).toBe(false)
    expect(isVolatileMatchUpdate({})).toBe(false)
  })

  it('ignores keys Dexie reports although their value did not change (arrays by reference)', () => {
    const stored = { id: 7, officials: [{ role: 'referee', name: 'A' }], bench_home: [], coinToss: { team_a: 'home' }, updatedAt: 'old' }
    // what Dexie passes for db.matches.update(7, { updatedAt }) (the heartbeat)
    const heartbeat = { officials: [{ role: 'referee', name: 'A' }], bench_home: [], updatedAt: 'new' }
    expect(isVolatileMatchUpdate(heartbeat, stored)).toBe(true)
    expect(isVolatileMatchUpdate({ ...heartbeat, officials: [] }, stored)).toBe(false)
    expect(isVolatileMatchUpdate({ 'coinToss.team_a': 'away', updatedAt: 'new' }, stored)).toBe(false)
    expect(isVolatileMatchUpdate({ 'coinToss.team_a': 'home', updatedAt: 'new' }, stored)).toBe(true)
  })

  it('a heartbeat on the match row does not start a backup', () => {
    const db = fakeDb()
    const onWrite = vi.fn()
    subscribeMatchWrites(db, 7, onWrite)
    const stored = { id: 7, officials: [{ name: 'A' }], updatedAt: 'old' }
    db.update('matches', 7, stored, { officials: [{ name: 'A' }], updatedAt: 'new' }).commit()
    expect(onWrite).not.toHaveBeenCalled()
  })
})
