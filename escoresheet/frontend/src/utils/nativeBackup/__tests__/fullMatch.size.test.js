// A full 5-set match through the backup engine: how big the files get, how much
// stays on disk, and what one backup costs to serialize late in set 5.
// (Node timings, not a tablet's: they show the trend, the budget is checked
// on sizes.)
import { describe, it, expect } from 'vitest'
import { createNativeBackupEngine, serializeBackup } from '../engine'
import { planMatchRotation, DEFAULT_MAX_BYTES_PER_MATCH, LATEST_FILE } from '../rotation'

const T0 = Date.UTC(2026, 9, 6, 18, 0, 0)
const SET_SCORES = [[25, 23], [23, 25], [25, 22], [22, 25], [15, 13]]

const player = (n) => ({ number: n, name: `Player ${n}`, firstName: 'First', lastName: `Last${n}`, dob: '2000-01-01', libero: n === 12 ? 'libero1' : null, isCaptain: n === 1 })

// About what Scoreboard.captureFullStateSnapshot stores on every event
function snapshot(setIndex, home, away, seq) {
  return {
    currentSetIndex: setIndex,
    pointsA: home,
    pointsB: away,
    setsWonA: Math.floor(setIndex / 2),
    setsWonB: Math.floor((setIndex - 1) / 2),
    teamAKey: 'home',
    sideA: setIndex % 2 ? 'left' : 'right',
    servingTeam: seq % 2 ? 'A' : 'B',
    lineupA: { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 },
    lineupB: { I: 11, II: 12, III: 13, IV: 14, V: 15, VI: 16 },
    liberoA: { libero1: 12, replaced: 5, position: 'V' },
    liberoB: { libero1: 18, replaced: 15, position: 'V' },
    timeoutsA: [{ at: '2026-10-06T18:10:00.000Z', score: '8:6' }],
    timeoutsB: [],
    substitutionsA: [{ in: 7, out: 3, score: '12:10' }, { in: 3, out: 7, score: '18:15' }],
    substitutionsB: [{ in: 17, out: 13, score: '14:14' }],
    sanctionsA: [], sanctionsB: [{ type: 'warning', role: 'coach' }],
    rotationHistoryA: Array.from({ length: 6 }, (_, i) => i + 1),
    rotationHistoryB: Array.from({ length: 6 }, (_, i) => i + 11),
    matchStatus: 'live',
    set5CourtSwitched: false,
    notes: 'x'.repeat(600)
  }
}

function fullMatch() {
  const state = {
    version: 1,
    match: { id: 1, gameN: 1042, seed_key: 'match_1759774800000_k3j9xq', status: 'live', gamePin: '123456', hall: 'Hall', officials: [{ role: 'referee', name: 'Ref' }] },
    homeTeam: { id: 1, name: 'Home' },
    awayTeam: { id: 2, name: 'Away' },
    homePlayers: Array.from({ length: 14 }, (_, i) => player(i + 1)),
    awayPlayers: Array.from({ length: 14 }, (_, i) => player(i + 11)),
    sets: [],
    events: []
  }
  const steps = [] // one entry per scoring action that triggers a backup
  let seq = 0
  SET_SCORES.forEach(([h, a], i) => {
    const setIndex = i + 1
    const set = { id: setIndex, index: setIndex, homePoints: 0, awayPoints: 0, finished: false }
    steps.push(() => {
      state.sets.push(set)
      state.events.push({ id: ++seq, seq, setIndex, type: 'set_start', ts: new Date(T0 + seq * 30000).toISOString(), stateSnapshot: snapshot(setIndex, 0, 0, seq) })
    })
    const order = []
    for (let k = 0; k < Math.max(h, a) * 2; k++) {
      if (k % 2 === 0 && order.filter(t => t === 'home').length < h) order.push('home')
      else if (order.filter(t => t === 'away').length < a) order.push('away')
      else order.push('home')
    }
    order.slice(0, h + a).forEach((team, k) => {
      steps.push(() => {
        // the rally start is stored too (no backup of its own)
        state.events.push({ id: ++seq, seq, setIndex, type: 'rally_start', ts: new Date(T0 + seq * 30000).toISOString(), stateSnapshot: snapshot(setIndex, set.homePoints, set.awayPoints, seq) })
        set[team === 'home' ? 'homePoints' : 'awayPoints']++
        state.events.push({ id: ++seq, seq, setIndex, type: 'point', payload: { team }, ts: new Date(T0 + seq * 30000).toISOString(), stateSnapshot: snapshot(setIndex, set.homePoints, set.awayPoints, seq) })
      })
      if (k === 10 || k === 30) {
        steps.push(() => state.events.push({ id: ++seq, seq, setIndex, type: 'timeout', payload: { team }, stateSnapshot: snapshot(setIndex, set.homePoints, set.awayPoints, seq) }))
      }
      if (k === 15 || k === 25) {
        steps.push(() => state.events.push({ id: ++seq, seq, setIndex, type: 'substitution', payload: { team, in: 7, out: 3 }, stateSnapshot: snapshot(setIndex, set.homePoints, set.awayPoints, seq) }))
      }
    })
    steps.push(() => {
      set.finished = true
      state.events.push({ id: ++seq, seq, setIndex, type: 'set_end', stateSnapshot: snapshot(setIndex, set.homePoints, set.awayPoints, seq) })
    })
  })
  steps.push(() => { state.match.status = 'ended' })
  return { state, steps }
}

function memoryStore() {
  const files = new Map()
  let written = 0
  return {
    files,
    get written() { return written },
    info: async () => ({ folder: '/b' }),
    write: async (dir, name, text) => {
      written += text.length
      files.set(name, text)
      files.set(LATEST_FILE, text)
      return {}
    },
    list: async () => [],
    remove: async (_dir, names) => { for (const n of names) files.delete(n) }
  }
}

describe('a full 5-set match', () => {
  it('stays within the per-match byte budget and is thinned once finished', async () => {
    const { state, steps } = fullMatch()
    const store = memoryStore()
    let now = T0
    const engine = createNativeBackupEngine({
      store,
      exportMatch: async () => structuredClone(state),
      now: () => new Date(now),
      quietMs: 0,
      idle: (fn) => fn(),
      log: { info() {}, warn() {}, error() {} }
    })
    for (const step of steps) {
      step()
      engine.notify(1)
      await engine.flush()
      now += 30_000
    }

    const eventFiles = [...store.files].filter(([n]) => n !== LATEST_FILE)
    const keptBytes = eventFiles.reduce((n, [, t]) => n + t.length, 0)
    const finalSize = store.files.get(LATEST_FILE).length

    // serialize cost of one backup at the end of set 5 (median of 9)
    const times = []
    for (let i = 0; i < 9; i++) {
      const t = performance.now()
      const { build } = serializeBackup(structuredClone(state))
      build(new Date().toISOString())
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)

    console.info('[full match]', JSON.stringify({
      events: state.events.length,
      backups: steps.length,
      finalFileKB: Math.round(finalSize / 1024),
      perEventBytes: Math.round(finalSize / state.events.length),
      writtenMB: +(store.written / 1048576).toFixed(1),
      keptFiles: eventFiles.length,
      keptMB: +(keptBytes / 1048576).toFixed(1),
      serializeMsAtSet5: +times[4].toFixed(1)
    }))

    expect(state.events.length).toBeGreaterThan(450)
    expect(finalSize).toBeLessThan(2 * 1024 * 1024)
    // without the budget this match writes the whole written volume to disk
    expect(store.written).toBeGreaterThan(DEFAULT_MAX_BYTES_PER_MATCH)
    expect(keptBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES_PER_MATCH)
    expect(eventFiles.at(-1)[1]).toBe(store.files.get(LATEST_FILE)) // the newest file is the final state

    // the next day the finished match is thinned to its newest 10 files
    const files = eventFiles.map(([name, t]) => ({ name, size: t.length }))
    const doomed = planMatchRotation(files, { now: now + 24 * 3600_000 })
    const left = files.filter(f => !doomed.includes(f.name))
    expect(left).toHaveLength(10)
    expect(left.reduce((n, f) => n + f.size, 0)).toBeLessThan(10 * finalSize + 1)
  }, 60_000)
})
