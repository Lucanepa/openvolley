import { describe, it, expect, vi } from 'vitest'
import { createNativeBackupEngine } from '../engine'
import { eventFileName, LATEST_FILE } from '../rotation'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0, 0)

function memoryStore(initial = {}) {
  const dirs = new Map(Object.entries(initial).map(([d, names]) => [d, new Map(names.map(n => [n, '{}']))]))
  return {
    dirs,
    info: vi.fn(async () => ({ folder: '/backups' })),
    write: vi.fn(async (dir, name, text, { latest } = {}) => {
      if (!dirs.has(dir)) dirs.set(dir, new Map())
      dirs.get(dir).set(name, text)
      if (latest) dirs.get(dir).set(LATEST_FILE, text)
    }),
    list: vi.fn(async () => [...dirs].map(([dir, files]) => ({ dir, files: [...files.keys()].map(name => ({ name })) }))),
    remove: vi.fn(async (dir, names) => { for (const n of names) dirs.get(dir)?.delete(n) })
  }
}

function matchState() {
  const state = {
    match: { id: 1, gameN: 12, seed_key: 'seed1', status: 'live' },
    homeTeam: { name: 'A' },
    awayTeam: { name: 'B' },
    homePlayers: [],
    awayPlayers: [],
    sets: [{ index: 1, homePoints: 0, awayPoints: 0 }],
    events: []
  }
  return {
    state,
    exportMatch: vi.fn(async () => ({ version: 1, lastUpdated: new Date().toISOString(), ...structuredClone(state) })),
    point(team) {
      const seq = state.events.length + 1
      state.events.push({ type: 'point', seq, payload: { team } })
      state.sets[0][team === 'home' ? 'homePoints' : 'awayPoints']++
    }
  }
}

function setup(opts = {}) {
  let now = T0
  const store = opts.store || memoryStore()
  const m = matchState()
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const engine = createNativeBackupEngine({
    store,
    exportMatch: opts.exportMatch || m.exportMatch,
    now: () => new Date(now),
    settleMs: 0,
    maxPerMatch: opts.maxPerMatch ?? 500,
    log
  })
  return { engine, store, m, log, tick: (ms = 1000) => { now += ms } }
}

const eventFiles = (store, dir = 'game12-seed1') => [...(store.dirs.get(dir)?.keys() || [])].filter(n => n !== LATEST_FILE).sort()

describe('native backup engine', () => {
  it('writes one file per scoring event plus latest.json, in the backup format', async () => {
    const { engine, store, m, tick } = setup()
    for (let i = 0; i < 3; i++) {
      m.point(i % 2 ? 'away' : 'home')
      engine.notify(1)
      await engine.flush()
      tick()
    }
    const files = eventFiles(store)
    expect(files).toEqual([eventFileName(T0, 1), eventFileName(T0 + 1000, 2), eventFileName(T0 + 2000, 3)])

    const latest = JSON.parse(store.dirs.get('game12-seed1').get(LATEST_FILE))
    expect(latest).toMatchObject({ version: 1, match: { gameN: 12 }, sets: [{ homePoints: 2, awayPoints: 1 }] })
    expect(latest.events).toHaveLength(3)
    expect(typeof latest.lastUpdated).toBe('string')
    expect(engine.getStatus()).toMatchObject({ folder: '/backups', count: 3, error: null, lastFile: `game12-seed1/${files[2]}` })
  })

  it('coalesces an unchanged state (no duplicate file)', async () => {
    const { engine, store, m } = setup()
    m.point('home')
    engine.notify(1)
    await engine.flush()
    engine.notify(1)
    engine.notify(1)
    await engine.flush()
    expect(eventFiles(store)).toHaveLength(1)
  })

  it('folds a burst of writes of one action into one backup of the final state', async () => {
    const { engine, store, m } = setup()
    m.point('home')
    engine.notify(1) // event added
    engine.notify(1) // snapshot stored
    engine.notify(1) // set score updated
    await engine.flush()
    expect(m.exportMatch).toHaveBeenCalledTimes(1)
    expect(eventFiles(store)).toHaveLength(1)
  })

  it('records an undo as a new backup', async () => {
    const { engine, store, m, tick } = setup()
    m.point('home')
    engine.notify(1)
    await engine.flush()
    tick()
    m.state.events.pop()
    m.state.sets[0].homePoints = 0
    engine.notify(1)
    await engine.flush()
    const files = eventFiles(store)
    expect(files).toHaveLength(2)
    expect(files[1]).toMatch(/-00000\.json$/)
  })

  it('backupNow writes even when nothing changed', async () => {
    const { engine, store, m } = setup()
    m.point('home')
    engine.notify(1)
    await engine.flush()
    await engine.backupNow(1)
    expect(eventFiles(store)).toHaveLength(2)
  })

  it('never throws: a failing write becomes a status error and the next event retries', async () => {
    const store = memoryStore()
    const { engine, m, log } = setup({ store })
    store.write.mockRejectedValueOnce(new Error('disk full'))
    m.point('home')
    expect(() => engine.notify(1)).not.toThrow()
    await engine.flush()
    expect(engine.getStatus().error).toBe('disk full')
    expect(log.error).toHaveBeenCalled()

    engine.notify(1) // same state, but it was never written: retried
    await engine.flush()
    expect(engine.getStatus().error).toBeNull()
    expect(eventFiles(store)).toHaveLength(1)
  })

  it('ignores a match that no longer exists', async () => {
    const { engine, store } = setup({ exportMatch: async () => { throw new Error('Match not found') } })
    engine.notify(99)
    await engine.flush()
    expect(store.write).not.toHaveBeenCalled()
    expect(engine.getStatus().error).toBe('Match not found')
  })

  it('caps each match at maxPerMatch event files, oldest deleted first', async () => {
    const { engine, store, m, tick } = setup({ maxPerMatch: 3 })
    for (let i = 0; i < 5; i++) {
      m.point('home')
      engine.notify(1)
      await engine.flush()
      tick()
    }
    const files = eventFiles(store)
    expect(files).toEqual([eventFileName(T0 + 2000, 3), eventFileName(T0 + 3000, 4), eventFileName(T0 + 4000, 5)])
    expect(store.dirs.get('game12-seed1').has(LATEST_FILE)).toBe(true)
  })

  it('removes other matches’ event backups older than 30 days at the first backup, keeping latest.json', async () => {
    const old = eventFileName(T0 - 45 * DAY, 10)
    const recent = eventFileName(T0 - 2 * DAY, 11)
    const store = memoryStore({ 'game1-old': [old, LATEST_FILE], 'game2-recent': [recent, LATEST_FILE] })
    const { engine, m } = setup({ store })
    m.point('home')
    engine.notify(1)
    await engine.flush()
    expect([...store.dirs.get('game1-old').keys()]).toEqual([LATEST_FILE])
    expect([...store.dirs.get('game2-recent').keys()].sort()).toEqual([recent, LATEST_FILE].sort())
    expect(store.list).toHaveBeenCalledTimes(1)

    m.point('home')
    engine.notify(1)
    await engine.flush()
    expect(store.list).toHaveBeenCalledTimes(1) // once per session
  })

  it('gives every file a unique, increasing name even within one millisecond', async () => {
    const { engine, store, m } = setup() // clock never advances
    for (let i = 0; i < 3; i++) {
      m.point('home')
      engine.notify(1)
      await engine.flush()
    }
    const files = eventFiles(store)
    expect(new Set(files).size).toBe(3)
    expect(files).toEqual([...files].sort())
  })

  it('notifies status listeners', async () => {
    const { engine, m } = setup()
    const seen = []
    const off = engine.subscribe(s => seen.push(s.count))
    m.point('home')
    engine.notify(1)
    await engine.flush()
    off()
    m.point('home')
    engine.notify(1)
    await engine.flush()
    expect(seen).toEqual([1])
  })
})
