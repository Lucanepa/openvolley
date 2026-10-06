import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const storage = vi.hoisted(() => ({ uploads: [], downloads: 0, result: null }))
vi.mock('../../lib/apiClient', () => ({
  AUTH_TOKEN_STORAGE_KEY: 'api_auth_token',
  apiStorage: {
    from: (bucket) => ({
      upload: async (path, body, options) => {
        storage.uploads.push({ bucket, path, body, options })
        return storage.result || { data: { path }, error: null }
      },
      download: async () => {
        storage.downloads++
        return { data: null, error: { code: 'OV_STORAGE_NOT_FOUND' } }
      }
    })
  }
}))

import {
  captureConsole,
  getLogs,
  getUnsentLogs,
  uploadLogsToCloud,
  uploadBackupToCloud,
  triggerContinuousBackup,
  persistPendingLogs,
  restorePendingLogs,
  buildLogChunk,
  setDebugLogging,
  isDebugOnlyMessage,
  resetLoggerForTests,
  LOG_CURSOR_KEY,
  LOG_PENDING_KEY,
  LOG_UPLOAD_MIN_INTERVAL_MS
} from '../logger'

const signIn = () => localStorage.setItem('api_auth_token', JSON.stringify({ access_token: 't', expires_at: Date.now() / 1000 + 3600 }))
const sink = () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
const lines = (body) => body.split('\n').filter(Boolean)

beforeEach(() => {
  localStorage.clear()
  resetLoggerForTests()
  setDebugLogging(false, { persist: false })
  storage.uploads = []
  storage.downloads = 0
  storage.result = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('console capture without debug logging', () => {
  it('keeps warnings and errors on the console and in the buffer', () => {
    const out = sink()
    captureConsole('warn', ['[X] careful'], out)
    captureConsole('error', ['[X] broken'], out)
    expect(out.warn).toHaveBeenCalledWith('[X] careful')
    expect(out.error).toHaveBeenCalledWith('[X] broken')
    expect(getLogs().map(e => e.level)).toEqual(['warn', 'error'])
  })

  it('does not echo console.log, keeps it as a breadcrumb, drops per-rally traces and console.debug', () => {
    const out = sink()
    captureConsole('log', ['[SyncQueue] Processing 1 queued items'], out)
    captureConsole('log', ['[PERF] logEvent START: point'], out)
    captureConsole('log', ['[PERF:snapshot] After match'], out)
    captureConsole('log', ['[DEBUG] Run window.debugLiberoStatus()'], out)
    captureConsole('log', ['[SET_END_DEBUG] STEP 1'], out)
    captureConsole('log', ['[LiveState] Syncing to Supabase:', { a: 1 }], out)
    captureConsole('debug', ['anything'], out)
    expect(out.log).not.toHaveBeenCalled()
    expect(out.debug).not.toHaveBeenCalled()
    expect(getLogs().map(e => e.message)).toEqual(['[SyncQueue] Processing 1 queued items'])
  })

  it('shows and keeps everything once debug logging is on', () => {
    setDebugLogging(true, { persist: false })
    const out = sink()
    captureConsole('log', ['[PERF] logEvent START: point'], out)
    captureConsole('debug', ['detail'], out)
    expect(out.log).toHaveBeenCalledTimes(1)
    expect(out.debug).toHaveBeenCalledTimes(1)
    expect(getLogs()).toHaveLength(2)
  })

  it('remembers the debug switch on this device', () => {
    expect(setDebugLogging(true)).toBe(true)
    expect(localStorage.getItem('ov_debug')).toBe('1')
    expect(setDebugLogging(false)).toBe(false)
    expect(localStorage.getItem('ov_debug')).toBeNull()
  })

  it('recognises the debug-only prefixes only at the start of the first argument', () => {
    expect(isDebugOnlyMessage('[PERF:liveState] TOTAL: 3ms')).toBe(true)
    expect(isDebugOnlyMessage('[LiveState] Synced successfully')).toBe(true)
    expect(isDebugOnlyMessage('[LiveState] SET_END next set')).toBe(false)
    expect(isDebugOnlyMessage('[SyncQueue] [PERF] x')).toBe(false)
    expect(isDebugOnlyMessage({ PERF: 1 })).toBe(false)
  })
})

describe('log upload', () => {
  it('sends nothing without a session and keeps the lines for later', async () => {
    captureConsole('warn', ['one'], sink())
    expect(await uploadLogsToCloud('m1', 7)).toBeNull()
    expect(storage.uploads).toHaveLength(0)
    expect(getUnsentLogs()).toHaveLength(1)
  })

  it('uploads only the lines added since the last successful upload, without downloading', async () => {
    signIn()
    captureConsole('warn', ['one'], sink())
    captureConsole('warn', ['two'], sink())
    const first = await uploadLogsToCloud('m1', 7)
    expect(first).toMatch(/^logs\/game_7\/logs_\d{8}_\d{6}_[0-9a-z]+\.txt$/)
    captureConsole('warn', ['three'], sink())
    await uploadLogsToCloud('m1', 7)

    expect(storage.downloads).toBe(0)
    expect(storage.uploads).toHaveLength(2)
    expect(lines(storage.uploads[0].body).map(l => l.split('] ').pop())).toEqual(['one', 'two'])
    expect(lines(storage.uploads[1].body).map(l => l.split('] ').pop())).toEqual(['three'])
    expect(storage.uploads[0].path).not.toBe(storage.uploads[1].path)
    // Nothing new: nothing sent
    expect(await uploadLogsToCloud('m1', 7)).toBeNull()
    expect(storage.uploads).toHaveLength(2)
  })

  it('keeps the cursor across a reload (localStorage)', async () => {
    signIn()
    captureConsole('warn', ['before reload'], sink())
    await uploadLogsToCloud('m1', 7)
    const cursor = Number(localStorage.getItem(LOG_CURSOR_KEY))
    expect(cursor).toBe(getLogs()[0].seq)

    // A reload: memory is gone, the cursor is not
    resetLoggerForTests()
    captureConsole('warn', ['after reload'], sink())
    expect(getLogs()[0].seq).toBeGreaterThan(cursor)
    await uploadLogsToCloud('m1', 7)
    expect(lines(storage.uploads[1].body)).toHaveLength(1)
    expect(storage.uploads[1].body).toContain('after reload')
  })

  it('keeps unsent lines across a reload and does not send uploaded ones again', async () => {
    signIn()
    captureConsole('warn', ['sent'], sink())
    await uploadLogsToCloud('m1', 7)
    captureConsole('warn', ['not sent yet'], sink())
    persistPendingLogs()
    expect(JSON.parse(localStorage.getItem(LOG_PENDING_KEY))).toHaveLength(1)

    resetLoggerForTests()
    expect(restorePendingLogs()).toBe(1)
    expect(localStorage.getItem(LOG_PENDING_KEY)).toBeNull()
    captureConsole('warn', ['new session'], sink())
    await uploadLogsToCloud('m1', 7)
    const body = storage.uploads[1].body
    expect(body).toContain('not sent yet')
    expect(body).toContain('new session')
    expect(body).not.toContain('] sent')
  })

  it('retries a failed upload with the same lines, skips lines refused for good', async () => {
    signIn()
    captureConsole('warn', ['a'], sink())
    storage.result = { data: null, error: { message: 'Bad gateway', status: 502 } }
    expect(await uploadLogsToCloud('m1', 7)).toBeNull()
    storage.result = null
    await uploadLogsToCloud('m1', 7)
    expect(storage.uploads[1].body).toContain('] a')

    captureConsole('warn', ['b'], sink())
    storage.result = { data: null, error: { message: 'File too large', code: 'OV_STORAGE_TOO_LARGE', status: 413 } }
    await uploadLogsToCloud('m1', 7)
    storage.result = null
    captureConsole('warn', ['c'], sink())
    await uploadLogsToCloud('m1', 7)
    const last = storage.uploads[storage.uploads.length - 1].body
    expect(last).toContain('] c')
    expect(last).not.toContain('] b')
  })

  it('a session that expired counts as signed out', async () => {
    localStorage.setItem('api_auth_token', JSON.stringify({ access_token: 't', expires_at: Date.now() / 1000 - 10 }))
    captureConsole('warn', ['x'], sink())
    expect(await uploadLogsToCloud('m1', 7)).toBeNull()
    expect(storage.uploads).toHaveLength(0)
  })

  it('cuts a chunk over the size cap from its oldest lines', () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, timestamp: 't', level: 'warn', message: `line ${i} ${'x'.repeat(100)}` }))
    const text = buildLogChunk(entries, 4000)
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4000)
    expect(text).toMatch(/^\[logger\] \d+ older lines left out/)
    expect(text).toContain('line 199')
    expect(text).not.toContain('line 0 ')
  })
})

describe('every-action backup', () => {
  it('uploads nothing while signed out', async () => {
    const getBackupData = vi.fn(async () => ({ match: { gameN: 7 }, sets: [] }))
    await triggerContinuousBackup('m1', getBackupData, 7)
    expect(getBackupData).not.toHaveBeenCalled()
    expect(await uploadBackupToCloud('m1', { match: { gameN: 7 } })).toBeNull()
    expect(storage.uploads).toHaveLength(0)
  })

  it('sends logs at most once a minute while backups keep going every 2 s', async () => {
    signIn()
    vi.useFakeTimers({ now: new Date('2026-10-06T08:00:00Z') })
    const getBackupData = async () => ({ match: { gameN: 7 }, sets: [] })
    const logUploads = () => storage.uploads.filter(u => u.path.startsWith('logs/')).length
    const backupUploads = () => storage.uploads.filter(u => u.path.startsWith('backups/')).length

    for (let i = 0; i < 10; i++) {
      captureConsole('warn', [`rally ${i}`], sink())
      await triggerContinuousBackup('m1', getBackupData, 7)
      await vi.advanceTimersByTimeAsync(3000)
    }
    expect(backupUploads()).toBe(10)
    expect(logUploads()).toBe(1)

    await vi.advanceTimersByTimeAsync(LOG_UPLOAD_MIN_INTERVAL_MS)
    captureConsole('warn', ['later'], sink())
    await triggerContinuousBackup('m1', getBackupData, 7)
    await vi.advanceTimersByTimeAsync(10)
    expect(logUploads()).toBe(2)
    // Each line went up exactly once
    const all = storage.uploads.filter(u => u.path.startsWith('logs/')).flatMap(u => lines(u.body))
    expect(all.filter(l => l.endsWith('rally 0'))).toHaveLength(1)
    expect(all).toHaveLength(11)
  })

  it('a set/match end upload is not rate limited', async () => {
    signIn()
    captureConsole('warn', ['a'], sink())
    await uploadLogsToCloud('m1', 7)
    captureConsole('warn', ['set end'], sink())
    expect(await uploadLogsToCloud('m1', 7)).not.toBeNull()
    expect(storage.uploads).toHaveLength(2)
  })
})
