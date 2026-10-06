import { describe, it, expect, vi, afterEach } from 'vitest'
import { createNativeBackupEngine, serializeBackup } from '../engine'
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
    list: vi.fn(async () => [...dirs].map(([dir, files]) => ({ dir, files: [...files].map(([name, text]) => ({ name, size: text.length })) }))),
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
    quietMs: 0,
    idle: (fn) => fn(),
    maxPerMatch: opts.maxPerMatch ?? 500,
    ...(opts.engine || {}),
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

  it('backupNow resolves once the file is written, without waiting for the rotation of old folders', async () => {
    const store = memoryStore({ 'game1-old': [eventFileName(T0 - 45 * DAY, 1), eventFileName(T0 - 44 * DAY, 2)] })
    let releaseList
    store.list.mockImplementation(() => new Promise(r => { releaseList = r }))
    const { engine, m } = setup({ store })
    m.point('home')
    const status = await engine.backupNow(1)
    expect(status).toMatchObject({ count: 1, error: null })
    expect(eventFiles(store)).toHaveLength(1)
    await vi.waitFor(() => expect(store.list).toHaveBeenCalled())
    releaseList([])
    await engine.flush()
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

  it('removes other matches’ event backups older than 30 days after the first backup, keeping latest.json and the newest file', async () => {
    const old = eventFileName(T0 - 45 * DAY, 10)
    const older = eventFileName(T0 - 46 * DAY, 9)
    const recent = eventFileName(T0 - 2 * DAY, 11)
    const store = memoryStore({ 'game1-old': [older, old, LATEST_FILE], 'game2-recent': [recent, LATEST_FILE] })
    const { engine, m } = setup({ store })
    m.point('home')
    engine.notify(1)
    await engine.flush()
    expect([...store.dirs.get('game1-old').keys()].sort()).toEqual([old, LATEST_FILE].sort())
    expect([...store.dirs.get('game2-recent').keys()].sort()).toEqual([recent, LATEST_FILE].sort())
    expect(store.list).toHaveBeenCalledTimes(1)
    // the match's own file was written before the folders were listed
    expect(store.write.mock.invocationCallOrder[0]).toBeLessThan(store.list.mock.invocationCallOrder[0])

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

  it('applies the rotation to files a previous session left in the match folder', async () => {
    const earlier = Array.from({ length: 4 }, (_, i) => eventFileName(T0 - 60_000 + i * 1000, i + 1))
    const store = memoryStore({ 'game12-seed1': [...earlier, LATEST_FILE] })
    const { engine, m, tick } = setup({ store, maxPerMatch: 3 })
    for (let i = 0; i < 2; i++) {
      m.point('home')
      engine.notify(1)
      await engine.flush()
      tick()
    }
    expect(eventFiles(store)).toHaveLength(3)
    expect(eventFiles(store)).toEqual(expect.arrayContaining([eventFileName(T0 + 1000, 2)]))
  })

  it('removes PINs and session ids from the file, and says so', async () => {
    const { engine, store, m } = setup()
    Object.assign(m.state.match, {
      gamePin: '111111', refereePin: '222222', homeTeamPin: '333333', awayTeamPin: '444444',
      homeTeamUploadPin: '555555', awayTeamUploadPin: '666666', sessionId: 'sess-1',
      connection_pins: { referee: '222222' }, game_pin: '111111', hall: 'Saalsporthalle'
    })
    m.point('home')
    engine.notify(1)
    await engine.flush()
    const text = store.dirs.get('game12-seed1').get(LATEST_FILE)
    for (const secret of ['111111', '222222', '333333', '444444', '555555', '666666', 'sess-1']) {
      expect(text).not.toContain(secret)
    }
    const latest = JSON.parse(text)
    expect(latest.secretsRemoved).toBe(true)
    expect(latest.match).toMatchObject({ hall: 'Saalsporthalle', seed_key: 'seed1' })
    expect(m.state.match.gamePin).toBe('111111') // the stored match is untouched
  })

  it('writes no file when only heartbeats, sessions or updatedAt changed', async () => {
    const { engine, store, m } = setup()
    m.point('home')
    engine.notify(1)
    await engine.flush()
    Object.assign(m.state.match, { updatedAt: '2026-10-06T12:00:10Z', refereeHeartbeat: 5, sessionId: 'other', _syncedAt: 9 })
    engine.notify(1)
    await engine.flush()
    expect(eventFiles(store)).toHaveLength(1)
    m.state.match.status = 'ended'
    engine.notify(1)
    await engine.flush()
    expect(eventFiles(store)).toHaveLength(2)
  })

  it('keeps going when only latest.json could not be replaced', async () => {
    const store = memoryStore()
    const realWrite = store.write.getMockImplementation()
    store.write.mockImplementation(async (...args) => {
      await realWrite(...args)
      return { warning: 'cannot write latest.json: in use' }
    })
    const { engine, m, log } = setup({ store })
    m.point('home')
    engine.notify(1)
    await engine.flush()
    expect(engine.getStatus()).toMatchObject({ error: null, count: 1 })
    expect(log.warn).toHaveBeenCalledWith('[NativeBackup]', 'cannot write latest.json: in use')
  })

  it('keeps each match within the byte budget', async () => {
    const { engine, store, m, tick } = setup({ engine: { maxBytesPerMatch: 1000 } })
    for (let i = 0; i < 12; i++) {
      m.point('home')
      engine.notify(1)
      await engine.flush()
      tick()
    }
    const dir = store.dirs.get('game12-seed1')
    const total = eventFiles(store).reduce((n, f) => n + dir.get(f).length, 0)
    expect(total).toBeLessThanOrEqual(1000)
    expect(eventFiles(store).at(-1)).toBe(eventFileName(T0 + 11_000, 12))
  })
})

describe('native backup engine timing', () => {
  afterEach(() => vi.useRealTimers())

  function timedSetup(opts = {}) {
    vi.useFakeTimers({ now: T0 })
    const store = memoryStore()
    const m = matchState()
    const engine = createNativeBackupEngine({
      store,
      exportMatch: m.exportMatch,
      idle: (fn) => setTimeout(fn, 0),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...opts
    })
    return { engine, store, m }
  }

  it('waits for a quiet window: notifies at 0, 100 and 200 ms make one file', async () => {
    const { engine, store, m } = timedSetup({ quietMs: 150 })
    m.point('home')
    engine.notify(1)
    await vi.advanceTimersByTimeAsync(100)
    engine.notify(1)
    await vi.advanceTimersByTimeAsync(100)
    engine.notify(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(m.exportMatch).not.toHaveBeenCalled() // 100 ms after the last write: still quiet
    await vi.advanceTimersByTimeAsync(100)
    await engine.flush()
    expect(m.exportMatch).toHaveBeenCalledTimes(1)
    expect(eventFiles(store)).toHaveLength(1)
  })

  it('writes at the latest maxWaitMs after the first write, even when writes keep coming', async () => {
    const { engine, store, m } = timedSetup({ quietMs: 150, maxWaitMs: 1500 })
    for (let t = 0; t < 1500; t += 100) {
      m.point('home')
      engine.notify(1)
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(10)
    expect(m.exportMatch).toHaveBeenCalledTimes(1)
    expect(eventFiles(store)).toHaveLength(1)
  })

  it('a write that lands while a backup is exported waits for its own quiet window', async () => {
    const { engine, store, m } = timedSetup({ quietMs: 150 })
    let release
    m.exportMatch.mockImplementationOnce(() => new Promise(r => { release = r }))
    m.point('home')
    engine.notify(1)
    await vi.advanceTimersByTimeAsync(160) // export of the first state starts
    expect(m.exportMatch).toHaveBeenCalledTimes(1)
    m.point('home')
    engine.notify(1) // committed during the export
    release({ version: 1, ...structuredClone({ ...m.state, events: m.state.events.slice(0, 1) }) })
    await vi.advanceTimersByTimeAsync(10)
    expect(m.exportMatch).toHaveBeenCalledTimes(1) // not straight away
    await vi.advanceTimersByTimeAsync(200)
    await engine.flush()
    expect(m.exportMatch).toHaveBeenCalledTimes(2)
    expect(eventFiles(store)).toHaveLength(2)
  })

  it('makes one complete file from the scoreboard write sequence of a point on a slow tablet', async () => {
    // Scoreboard: add the event (commit) -> capture the state snapshot (slow) ->
    // store it on the event -> update the set score
    const { engine, store, m } = timedSetup({ quietMs: 150 })
    const seq = m.state.events.length + 1
    m.state.events.push({ type: 'point', seq, payload: { team: 'home' } })
    engine.notify(1)
    await vi.advanceTimersByTimeAsync(130) // snapshot takes 130 ms
    m.state.events[seq - 1].stateSnapshot = { homePoints: 1 }
    engine.notify(1)
    await vi.advanceTimersByTimeAsync(40)
    m.state.sets[0].homePoints = 1
    engine.notify(1)
    await vi.advanceTimersByTimeAsync(400)
    await engine.flush()

    expect(eventFiles(store)).toHaveLength(1)
    const latest = JSON.parse(store.dirs.get('game12-seed1').get(LATEST_FILE))
    expect(latest.events.at(-1).stateSnapshot).toEqual({ homePoints: 1 })
    expect(latest.sets[0].homePoints).toBe(1)
  })
})

describe('serializeBackup', () => {
  it('writes the backup format and keys on the scoring state only', () => {
    const data = { version: 1, lastUpdated: 'x', match: { id: 1, gamePin: '9', updatedAt: 'a' }, sets: [], events: [{ seq: 1 }] }
    const a = serializeBackup(data)
    const b = serializeBackup({ ...data, lastUpdated: 'y', match: { ...data.match, updatedAt: 'b' } })
    expect(a.key).toBe(b.key)
    expect(JSON.parse(a.build('2026-10-06T12:00:00.000Z'))).toEqual({
      version: 1, match: { id: 1, updatedAt: 'a' }, sets: [], events: [{ seq: 1 }], secretsRemoved: true, lastUpdated: '2026-10-06T12:00:00.000Z'
    })
  })
})
