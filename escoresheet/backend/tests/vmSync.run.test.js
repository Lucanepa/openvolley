import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runVmSync, scheduleVmSync, syncHealth, runWindowFromEnv, ADVISORY_LOCK_KEY, VM_SYNC_RETRY_DELAYS_MS, SYNC_STALE_AFTER_MS } from '../lib/vmSync.js'
import { main as cliMain, parseArgs, EXIT } from '../scripts/vm-sync.mjs'
import {
  createFakeVolleyManager, makeGame, FAKE_USER, FAKE_PASSWORD, FAKE_CSRF, FAKE_SESSION_1, FAKE_SESSION_2
} from './helpers/fakeVolleyManager.js'

const http = { sleep: async () => {}, backoffMs: 1, timeoutMs: 2000 }
const creds = { username: FAKE_USER, password: FAKE_PASSWORD }
const NOW = new Date('2026-10-05T04:00:00Z')

function memLogger() {
  const lines = []
  const push = (lvl) => (...a) => lines.push(`${lvl} ${a.join(' ')}`)
  return { lines, log: push('log'), warn: push('warn'), error: push('error') }
}

/**
 * pg Pool stand-in: one shared advisory-lock table, a log table and a
 * recorder. `failUpsert` makes the upsert statement throw; `stored` are the
 * svrz_games rows ({ game_number, datetime }) the window holds before the run.
 */
function fakePool({ failUpsert = null, failLogInsert = false, failClose = false, stored = [] } = {}) {
  const state = { lockHeldBy: null, log: new Map(), nextId: 1, queries: [], released: [], staleClosed: 0, clients: [], stored, removed: [] }
  let clientSeq = 0
  const closeRow = (params) => {
    const [id, fetched, created, updated, unchanged, errors, status, message, withoutFormat, removed] = params
    Object.assign(state.log.get(id), { fetched, created, updated, unchanged, errors, status, message, withoutFormat, removed, finished: true })
    return { rowCount: 1 }
  }
  return {
    state,
    // pool.query: a fresh connection (used to close the log row when the run's one died)
    async query(text, params = []) {
      state.queries.push({ client: 'pool', text, params })
      if (/UPDATE public\.svrz_sync_log\s+SET finished_at/.test(text)) return closeRow(params)
      throw new Error(`fakePool.query: unexpected query ${text.slice(0, 60)}`)
    },
    async connect() {
      const id = ++clientSeq
      const client = Object.assign(new EventEmitter(), {
        dead: false,
        async query(text, params = []) {
          state.queries.push({ client: id, text, params })
          if (client.dead) throw new Error('Client was closed and is not queryable')
          if (/pg_try_advisory_lock/.test(text)) {
            assert.equal(params[0], ADVISORY_LOCK_KEY)
            if (state.lockHeldBy == null) { state.lockHeldBy = id; return { rows: [{ ok: true }] } }
            return { rows: [{ ok: false }] }
          }
          if (/pg_advisory_unlock/.test(text)) {
            if (state.lockHeldBy === id) state.lockHeldBy = null
            return { rows: [{ pg_advisory_unlock: true }] }
          }
          if (/UPDATE public\.svrz_sync_log\s+SET status = 'failed'/.test(text)) {
            return { rowCount: state.staleClosed }
          }
          if (/INSERT INTO public\.svrz_sync_log/.test(text)) {
            if (failLogInsert) throw new Error('db down')
            const row = { id: state.nextId++, status: 'running', message: params[0] }
            state.log.set(row.id, row)
            return { rows: [{ id: row.id }] }
          }
          if (/INSERT INTO public\.svrz_games \(/.test(text)) {
            if (failUpsert) throw new Error(failUpsert)
            const n = JSON.parse(params[0]).length
            return { rows: [{ created: n, updated: 0, unchanged: 0 }] }
          }
          if (/SELECT game_number, datetime FROM public\.svrz_games/.test(text)) return { rows: state.stored }
          if (/DELETE FROM public\.svrz_games_removed/.test(text)) return { rowCount: 0 }
          if (/DELETE FROM public\.svrz_games g/.test(text)) {
            state.removed.push(...params[0])
            return { rows: params[0].map((n) => ({ game_number: n })), rowCount: params[0].length }
          }
          if (/UPDATE public\.svrz_sync_log\s+SET finished_at/.test(text)) {
            if (failClose) throw new Error('close failed')
            return closeRow(params)
          }
          throw new Error(`fakePool: unexpected query ${text.slice(0, 60)}`)
        },
        release(err) { state.released.push({ client: id, err: err ?? null, listeners: client.listenerCount('error') }) }
      })
      state.clients.push(client)
      return client
    }
  }
}

const secretsIn = (s) => [FAKE_PASSWORD, FAKE_CSRF, FAKE_SESSION_1, FAKE_SESSION_2].filter((x) => s.includes(x))

describe('runVmSync (fake pool, fake VolleyManager)', () => {
  it('success: logs running then success, counts, releases lock and client', async () => {
    const vm = createFakeVolleyManager({ games: [makeGame(1), makeGame(2), makeGame(3, { shortName: 'NLA' })] })
    const pool = fakePool()
    const logger = memLogger()
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger, pageDelayMs: 0 })
    assert.equal(r.status, 'success')
    assert.equal(r.fetched, 3)
    assert.equal(r.kept, 2)
    assert.equal(r.excluded, 1)
    assert.equal(r.created, 2)
    const row = pool.state.log.get(r.logId)
    assert.equal(row.status, 'success')
    assert.equal(row.created, 2)
    assert.match(row.message, /^\[2026-10-04 → 2026-10-19\] Synced 2 games/)
    assert.equal(pool.state.lockHeldBy, null, 'lock released')
    assert.equal(pool.state.released.length, 1)
    assert.equal(pool.state.released[0].err, null)
    assert.deepEqual(secretsIn(logger.lines.join('\n')), [])
    // the Zurich window reached VM
    const search = vm.calls.find((c) => c.path.startsWith('/api/indoorvolleyball.refadmin/'))
    assert.equal(new URLSearchParams(search.body).get('searchConfiguration[propertyFilters][0][dateRange][from]'), '2026-10-03T22:00:00.000Z')
  })

  it('a login failure after the running row closes it as failed, without credentials', async () => {
    const vm = createFakeVolleyManager({ password: 'other' })
    const pool = fakePool()
    const logger = memLogger()
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger })
    assert.equal(r.status, 'failed')
    const row = pool.state.log.get(r.logId)
    assert.equal(row.finished, true)
    assert.equal(row.status, 'failed')
    assert.match(row.message, /login failed/)
    assert.deepEqual(secretsIn(row.message), [])
    assert.ok(!row.message.includes(FAKE_USER))
    assert.deepEqual(secretsIn(logger.lines.join('\n')), [])
    assert.equal(pool.state.lockHeldBy, null)
  })

  it('a network failure (VM unreachable) closes the row as failed', async () => {
    const pool = fakePool()
    const fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) }
    const r = await runVmSync({ pool, fetch, baseUrl: 'https://vm.test.invalid', http, now: NOW, credentials: creds, logger: memLogger() })
    assert.equal(r.status, 'failed')
    assert.match(pool.state.log.get(r.logId).message, /network error \(ENOTFOUND\)/)
  })

  it('an upsert error that echoes a secret is redacted and marks the run failed', async () => {
    const vm = createFakeVolleyManager({ games: [makeGame(1)] })
    const pool = fakePool({ failUpsert: `boom ${FAKE_PASSWORD} ${FAKE_CSRF}` })
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger(), pageDelayMs: 0 })
    assert.equal(r.status, 'failed')
    assert.equal(r.errors, 1)
    const row = pool.state.log.get(r.logId)
    assert.match(row.message, /boom \[redacted\] \[redacted\]/)
  })

  it('an incomplete fetch is partial', async () => {
    const games = Array.from({ length: 3 }, (_, i) => makeGame(i + 1))
    const vm = createFakeVolleyManager({ games, failSearchAt: 2 })
    const pool = fakePool()
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger(), batchSize: 2, pageSize: 2, pageDelayMs: 0 })
    assert.equal(r.status, 'partial')
    assert.match(pool.state.log.get(r.logId).message, /INCOMPLETE: 2\/3/)
  })

  it('skips without a log row when another run holds the lock', async () => {
    const vm = createFakeVolleyManager({ games: [makeGame(1)] })
    const pool = fakePool()
    pool.state.lockHeldBy = 999
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger() })
    assert.equal(r.status, 'skipped')
    assert.equal(pool.state.log.size, 0)
    assert.equal(vm.calls.length, 0, 'no VM traffic')
    assert.equal(pool.state.lockHeldBy, 999, 'other holder untouched')
    assert.equal(pool.state.released.length, 1)
  })

  it('closes abandoned running rows before starting', async () => {
    const vm = createFakeVolleyManager({ games: [] })
    const pool = fakePool()
    pool.state.staleClosed = 2
    const logger = memLogger()
    await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger })
    assert.ok(logger.lines.some((l) => /closed 2 abandoned/.test(l)))
    const stale = pool.state.queries.find((q) => /SET status = 'failed'/.test(q.text))
    assert.deepEqual(stale.params, ['60', 3600])
  })

  it('a database failure before the log row still releases the lock', async () => {
    const vm = createFakeVolleyManager()
    const pool = fakePool({ failLogInsert: true })
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger() })
    assert.equal(r.status, 'failed')
    assert.equal(r.logId, null)
    assert.equal(pool.state.lockHeldBy, null)
    assert.equal(vm.calls.length, 0)
  })

  it('a database connection dropping mid-run is handled: no uncaught error, client discarded, row closed on a fresh connection', async () => {
    const pool = fakePool()
    const logger = memLogger()
    const vm = createFakeVolleyManager({ games: [makeGame(1)] })
    let killed = false
    // The connection dies while the run is busy with VolleyManager
    const fetch = async (url, init) => {
      if (!killed) {
        killed = true
        const c = pool.state.clients[0]
        c.dead = true
        // With no 'error' listener this would throw (EventEmitter semantics = uncaught in pg)
        c.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }))
      }
      return vm.fetch(url, init)
    }
    const r = await runVmSync({ pool, fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger, pageDelayMs: 0 })
    assert.equal(r.status, 'failed', 'the upsert on the dead connection failed')
    assert.ok(logger.lines.some((l) => /database connection lost: terminating connection/.test(l)))
    const row = pool.state.log.get(r.logId)
    assert.equal(row.finished, true)
    assert.equal(row.status, 'failed')
    assert.ok(pool.state.queries.some((q) => q.client === 'pool' && /SET finished_at/.test(q.text)), 'closed via pool.query')
    assert.ok(!pool.state.queries.some((q) => /pg_advisory_unlock/.test(q.text)), 'no unlock on a dead session')
    assert.equal(pool.state.released.length, 1)
    assert.match(pool.state.released[0].err?.message ?? '', /terminating connection/, 'released with the error: discarded')
    assert.equal(pool.state.clients[0].listenerCount('error'), 0, 'listener removed')
  })

  it('a failing close on the run connection is retried once on a fresh connection', async () => {
    const vm = createFakeVolleyManager({ games: [makeGame(1)] })
    const pool = fakePool({ failClose: true })
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger(), pageDelayMs: 0 })
    assert.equal(r.status, 'success')
    assert.equal(pool.state.log.get(r.logId).status, 'success')
    assert.ok(pool.state.queries.some((q) => q.client === 'pool' && /SET finished_at/.test(q.text)))
    assert.equal(pool.state.lockHeldBy, null, 'the run connection is still fine: unlocked normally')
    assert.equal(pool.state.released[0].err, null)
    assert.equal(pool.state.released[0].listeners, 1, 'our listener is still attached at release time (pg-pool re-adds its own)')
    assert.equal(pool.state.clients[0].listenerCount('error'), 0)
  })

  it('dry run reports raw datetime samples and warns about offset-less values', async () => {
    const vm = createFakeVolleyManager({ games: [
      makeGame(1, { startingDateTime: '2026-10-10T16:00:00Z' }),
      makeGame(2, { startingDateTime: '2026-10-10T18:00:00' }),
      makeGame(3, { startingDateTime: '2026-10-10 18:00:00' })
    ] })
    const logger = memLogger()
    const r = await runVmSync({ dryRun: true, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger, pageDelayMs: 0 })
    assert.deepEqual(r.datetimeSamples, ['2026-10-10T16:00:00Z', '2026-10-10T18:00:00', '2026-10-10 18:00:00'])
    assert.equal(r.offsetlessDatetimes, 1)
    assert.equal(r.unparsedDatetimes, 1)
    assert.ok(logger.lines.some((l) => /^warn .*1 startingDateTime value\(s\) without Z\/offset/.test(l)))
    assert.ok(logger.lines.some((l) => /^warn .*not ISO 8601/.test(l)))
  })

  it('dry run needs no pool', async () => {
    const vm = createFakeVolleyManager({ games: [makeGame(1)] })
    const r = await runVmSync({ dryRun: true, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger(), pageDelayMs: 0 })
    assert.equal(r.status, 'success')
    assert.equal(r.kept, 1)
    assert.match(r.message, /Dry run/)
  })

  it('counts the games written without a format and names the leagues left out', async () => {
    const vm = createFakeVolleyManager({ games: [
      makeGame(1, { winSets: 'two_win_sets' }), makeGame(2, { winSets: null }), makeGame(3, { shortName: 'NLA', groupDisplay: '' })
    ] })
    const pool = fakePool()
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger(), pageDelayMs: 0 })
    assert.equal(r.status, 'success')
    assert.equal(r.withoutFormat, 1)
    assert.equal(r.written, 2)
    const row = pool.state.log.get(r.logId)
    assert.equal(row.withoutFormat, 1)
    assert.match(row.message, /1 without a format/)
    assert.match(row.message, /1 NL excluded \(NLA\)/)
  })

  // NOW is 2026-10-05T04:00Z; the window 2026-10-04 .. 2026-10-19 (Zurich)
  const upcoming = (n, at = '2026-10-10T16:00:00Z') => ({ game_number: String(n), datetime: at })

  it('a complete run moves the upcoming games VolleyManager no longer returns out of the schedule', async () => {
    const vm = createFakeVolleyManager({ games: [makeGame(1), makeGame(2, { shortName: 'NLA' })] })
    const pool = fakePool({ stored: [
      upcoming(1), upcoming(2), upcoming(7),
      upcoming(8, '2026-10-04T18:00:00Z'), // kicked off before the run: left alone
      upcoming(9, '2026-10-25T18:00:00Z'), // after the window: left alone
      upcoming(10, 'garbage')
    ] })
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger(), pageDelayMs: 0 })
    assert.equal(r.status, 'success', r.message)
    assert.deepEqual(pool.state.removed, ['7'])
    assert.equal(r.removed, 1)
    assert.equal(pool.state.log.get(r.logId).removed, 1)
    assert.match(r.message, /1 no longer in VolleyManager \(7\)/)
  })

  it('a partial run removes nothing', async () => {
    const games = Array.from({ length: 3 }, (_, i) => makeGame(i + 1))
    const vm = createFakeVolleyManager({ games, failSearchAt: 2 })
    const pool = fakePool({ stored: [upcoming(1), upcoming(2), upcoming(3), upcoming(7)] })
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger(), pageDelayMs: 0, pageSize: 2 })
    assert.equal(r.status, 'partial')
    assert.deepEqual(pool.state.removed, [])
  })

  it('no games at all while the schedule holds upcoming ones is no success, and removes nothing', async () => {
    const vm = createFakeVolleyManager({ games: [] })
    const pool = fakePool({ stored: [upcoming(7)] })
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger(), pageDelayMs: 0 })
    assert.equal(r.status, 'partial')
    assert.match(r.message, /VolleyManager returned no games; the schedule holds 1 upcoming/)
    assert.deepEqual(pool.state.removed, [])
  })

  it('most upcoming games missing at once is no success either: nothing removed, checked by a person', async () => {
    const stored = Array.from({ length: 30 }, (_, i) => upcoming(100 + i))
    const vm = createFakeVolleyManager({ games: Array.from({ length: 5 }, (_, i) => makeGame(100 + i)) })
    const pool = fakePool({ stored })
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger(), pageDelayMs: 0 })
    assert.equal(r.status, 'partial')
    assert.match(r.message, /25 of 30 upcoming games not returned/)
    assert.deepEqual(pool.state.removed, [])
  })

  it('a role switch that does not take fails the run before any game is read', async () => {
    const vm = createFakeVolleyManager({ games: [makeGame(1)], ignoreSwitch: true })
    const pool = fakePool({ stored: [upcoming(1)] })
    const r = await runVmSync({ pool, fetch: vm.fetch, baseUrl: vm.baseUrl, http, now: NOW, credentials: creds, logger: memLogger(), pageDelayMs: 0 })
    assert.equal(r.status, 'failed')
    assert.match(pool.state.log.get(r.logId).message, /not the referee-delegate role/)
    assert.ok(!vm.calls.some((c) => c.method === 'POST' && c.path.includes('searchForManagingAssociation')))
  })

  it('programming errors throw', async () => {
    await assert.rejects(runVmSync({ credentials: creds }), /pool/)
    await assert.rejects(runVmSync({ pool: fakePool(), credentials: creds, window: { date: 'x' } }), /YYYY-MM-DD/)
  })
})

describe('scheduleVmSync', () => {
  function fakeTimers(start) {
    let now = start.getTime()
    const timers = []
    return {
      now: () => new Date(now),
      setTimer: (fn, ms) => { const t = { fn, at: now + ms, unref() {} }; timers.push(t); return t },
      clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) },
      async advanceToNext() {
        timers.sort((a, b) => a.at - b.at)
        const t = timers.shift()
        now = t.at
        t.fn()
        await new Promise((r) => setImmediate(r))
      },
      timers
    }
  }

  it('runs daily at 06:00 Zurich across the DST switch and never twice for one slot', async () => {
    const clock = fakeTimers(new Date('2026-10-24T12:00:00Z'))
    const runs = []
    const s = scheduleVmSync({ hourLocal: 6, run: async () => { runs.push(clock.now().toISOString()) }, logger: memLogger(), ...clock })
    assert.equal(s.nextRunAt().toISOString(), '2026-10-25T05:00:00.000Z')
    for (let i = 0; i < 12; i++) await clock.advanceToNext() // includes the 6 h re-check hops
    assert.deepEqual(runs, ['2026-10-25T05:00:00.000Z', '2026-10-26T05:00:00.000Z', '2026-10-27T05:00:00.000Z'])
    s.stop()
    assert.equal(clock.timers.length, 0)
    assert.equal(s.nextRunAt(), null)
  })

  it('skips a slot while the previous run is still going, and survives a throwing run', async () => {
    let release
    let calls = 0
    const logger = memLogger()
    const s = scheduleVmSync({
      run: () => { calls++; if (calls === 2) throw new Error('kaput'); return new Promise((r) => { release = r }) },
      logger,
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {}
    })
    const first = s.runNow()
    await new Promise((r) => setImmediate(r))
    const second = s.runNow() // overlapping: skipped, hands back the running promise
    assert.equal(second, first)
    assert.equal(calls, 1)
    assert.ok(logger.lines.some((l) => /still in progress/.test(l)))
    release()
    await first
    await s.runNow() // throws inside, logged
    assert.equal(calls, 2)
    assert.ok(logger.lines.some((l) => /run failed: kaput/.test(l)))
    s.stop()
  })

  const failed = { status: 'failed' }
  const good = { status: 'success', written: 12 }

  it('a failed run is tried again the same day with growing delays, then waits for the next slot', async () => {
    const clock = fakeTimers(new Date('2026-10-24T22:00:00Z'))
    const runs = []
    const s = scheduleVmSync({ hourLocal: 22, minuteLocal: 30, tz: 'UTC', run: async () => { runs.push(clock.now().toISOString()); return failed }, logger: memLogger(), retryDelaysMs: VM_SYNC_RETRY_DELAYS_MS, ...clock })
    for (let i = 0; i < 4; i++) await clock.advanceToNext()
    assert.deepEqual(runs, ['2026-10-24T22:30:00.000Z', '2026-10-24T22:45:00.000Z', '2026-10-24T23:15:00.000Z', '2026-10-25T00:15:00.000Z'])
    assert.equal(s.status().nextRetryAt, null, 'no fourth retry')
    await clock.advanceToNext() // the 6 h re-check hops, then the next slot
    while (runs.length < 5) await clock.advanceToNext()
    assert.equal(runs[4], '2026-10-25T22:30:00.000Z')
    s.stop()
  })

  it('a success ends the retries; zero games written is no success', async () => {
    const clock = fakeTimers(new Date('2026-10-24T22:00:00Z'))
    const answers = [failed, { status: 'success', written: 0 }, good]
    const runs = []
    const s = scheduleVmSync({ hourLocal: 22, minuteLocal: 30, tz: 'UTC', run: async () => { runs.push(clock.now().toISOString()); return answers.shift() }, logger: memLogger(), retryDelaysMs: VM_SYNC_RETRY_DELAYS_MS, ...clock })
    for (let i = 0; i < 3; i++) await clock.advanceToNext()
    assert.equal(runs.length, 3)
    assert.equal(s.status().nextRetryAt, null)
    assert.equal(s.status().lastRun.status, 'success')
    s.stop()
  })

  it('retries and catch-ups only start inside the allowed window (the shared account\'s referee-role hours)', async () => {
    const clock = fakeTimers(new Date('2026-10-24T22:00:00Z'))
    const runs = []
    const allowedWindow = runWindowFromEnv({}) // 22:00-01:00 UTC
    const s = scheduleVmSync({ hourLocal: 22, minuteLocal: 30, tz: 'UTC', run: async () => { runs.push(clock.now().toISOString()); return failed }, logger: memLogger(), retryDelaysMs: [15 * 60000, 3 * 3600000], allowedWindow, ...clock })
    await clock.advanceToNext()
    await clock.advanceToNext()
    assert.deepEqual(runs, ['2026-10-24T22:30:00.000Z', '2026-10-24T22:45:00.000Z'])
    assert.equal(s.status().nextRetryAt, null, 'a retry at 01:45 UTC would be outside the window')
    s.stop()
    assert.deepEqual(runWindowFromEnv({ VM_SYNC_WINDOW_UTC: 'any' }), null)
    assert.deepEqual(runWindowFromEnv({ VM_SYNC_WINDOW_UTC: '20:30-23:00' }), { from: 20 * 60 + 30, to: 23 * 60 })
    assert.throws(() => runWindowFromEnv({ VM_SYNC_WINDOW_UTC: '25:00-01:00' }), /VM_SYNC_WINDOW_UTC/)
  })

  it('at start, a stale or missing last success is caught up inside the window; a fresh one waits for the slot', async () => {
    const record = (agoMs) => async () => ({ lastSuccess: agoMs == null ? null : { finishedAt: new Date(Date.parse('2026-10-24T23:00:00Z') - agoMs).toISOString() }, lastRun: null })
    for (const [ago, start, expectRun] of [
      [null, '2026-10-24T23:00:00Z', true],
      [SYNC_STALE_AFTER_MS + 60000, '2026-10-24T23:00:00Z', true],
      [3600000, '2026-10-24T23:00:00Z', false],
      [null, '2026-10-24T12:00:00Z', false] // outside the window: the 22:30 slot does it
    ]) {
      const clock = fakeTimers(new Date(start))
      const runs = []
      const s = scheduleVmSync({
        hourLocal: 22, minuteLocal: 30, tz: 'UTC', run: async () => { runs.push(clock.now().toISOString()); return good },
        logger: memLogger(), allowedWindow: runWindowFromEnv({}), catchUp: record(ago), startDelayMs: 60000, ...clock
      })
      await clock.advanceToNext() // the start check
      await new Promise((r) => setImmediate(r))
      assert.equal(runs.length > 0, expectRun, `${ago} at ${start}`)
      s.stop()
    }
  })

  it('validates its options', () => {
    assert.throws(() => scheduleVmSync({}), /run/)
    assert.throws(() => scheduleVmSync({ run: () => {}, hourLocal: 24 }), /0-23/)
    assert.throws(() => scheduleVmSync({ run: () => {}, tz: 'Mars/Olympus' }), RangeError)
  })
})

describe('syncHealth: what /health shows of the schedule sync', () => {
  const at = Date.parse('2026-10-25T08:00:00Z')
  const run = (status, ago, written = 120) => ({ status, startedAt: new Date(at - ago - 60000).toISOString(), finishedAt: new Date(at - ago).toISOString(), written })
  it('ok after a recent success with games', () => {
    const h = syncHealth({ lastRun: run('success', 9 * 3600000), lastSuccess: run('success', 9 * 3600000) }, { now: at })
    assert.equal(h.state, 'ok')
    assert.deepEqual(h.reasons, [])
    assert.equal(h.lastSuccessGames, 120)
  })
  it('degraded: never, stale, no games, or a failed last run', () => {
    assert.deepEqual(syncHealth({ lastRun: null, lastSuccess: null }, { now: at }).reasons, ['never_succeeded'])
    assert.deepEqual(syncHealth({ lastRun: run('success', 30 * 3600000), lastSuccess: run('success', 30 * 3600000) }, { now: at }).reasons, ['stale'])
    assert.deepEqual(syncHealth({ lastRun: run('success', 3600000, 0), lastSuccess: run('success', 3600000, 0) }, { now: at }).reasons, ['no_games'])
    const h = syncHealth({ lastRun: run('failed', 3600000), lastSuccess: run('success', 25 * 3600000) }, { now: at })
    assert.equal(h.state, 'degraded')
    assert.deepEqual(h.reasons, ['last_run_failed'])
    assert.equal(h.lastRunStatus, 'failed')
  })
})

describe('scripts/vm-sync.mjs', () => {
  it('parses window options', () => {
    assert.deepEqual(parseArgs(['--date', '2026-10-10']).window, { date: '2026-10-10' })
    assert.deepEqual(parseArgs(['--from=2026-10-01', '--to', '2026-10-31']).window, { from: '2026-10-01', to: '2026-10-31' })
    assert.deepEqual(parseArgs(['--days-back', '0', '--days-ahead', '30']).window, { daysBack: 0, daysAhead: 30 })
    assert.throws(() => parseArgs(['--from', '2026-10-01']), /go together/)
    assert.throws(() => parseArgs(['--date', '2026-10-10', '--days-ahead', '3']), /only one/)
    assert.throws(() => parseArgs(['--date']), /needs a value/)
    assert.throws(() => parseArgs(['--nope']), /Unknown/)
  })

  const quiet = async (fn) => {
    const orig = { log: console.log, error: console.error, warn: console.warn }
    const out = []
    console.log = console.error = console.warn = (...a) => out.push(a.join(' '))
    try { return { code: await fn(), out: out.join('\n') } } finally { Object.assign(console, orig) }
  }

  it('exit codes: usage, missing env, success, failed, skipped', async () => {
    assert.equal((await quiet(() => cliMain(['--bogus'], {}))).code, EXIT.usage)
    assert.equal((await quiet(() => cliMain([], {}))).code, EXIT.usage)
    const env = { DATABASE_URL: 'postgres://unused', VM_USERNAME: FAKE_USER, VM_PASSWORD: FAKE_PASSWORD }
    const vm = createFakeVolleyManager({ games: [] })
    const deps = { fetch: vm.fetch, baseUrl: vm.baseUrl, http }
    const ok = await quiet(() => cliMain(['--date', '2026-10-10'], env, { ...deps, createPool: async () => fakePool() }))
    assert.equal(ok.code, EXIT.success)
    assert.deepEqual(secretsIn(ok.out), [])

    const bad = await quiet(() => cliMain([], { ...env, VM_PASSWORD: 'wrong-password' }, { ...deps, createPool: async () => fakePool() }))
    assert.equal(bad.code, EXIT.failed)
    assert.ok(!bad.out.includes('wrong-password'))

    const locked = fakePool()
    locked.state.lockHeldBy = 1234
    assert.equal((await quiet(() => cliMain([], env, { ...deps, createPool: async () => locked }))).code, EXIT.skipped)
  })
})
