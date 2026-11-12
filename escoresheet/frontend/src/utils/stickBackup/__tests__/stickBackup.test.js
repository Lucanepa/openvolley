import { describe, it, expect, vi, afterEach } from 'vitest'
import { createStickPlatform, stickErrorCode } from '../platform'
import { createStickBackup, compactStamp, deviceTagOf, STICK_POLL_MS } from '../index'

const STICK_A = { id: 'a1', label: 'KINGSTON', fs: 'vfat', freeBytes: 8e9, totalBytes: 16e9, readOnly: false, locked: false, hasFolder: true }
const STICK_B = { id: 'b2', label: 'SD', fs: 'exfat', freeBytes: 1e6, totalBytes: 2e9, readOnly: false, locked: false, hasFolder: false }

function fakeEngine() {
  let n = 0
  let last = null
  return {
    backupNow: vi.fn(async () => {
      n += 1
      last = { dir: 'game7-seed', name: `20261112T10000${n}.000Z-0000${n}.json`, at: new Date() }
      return { error: null }
    }),
    lastWrittenOf: vi.fn(() => last)
  }
}

function fakePlatform(sticks, failures = {}) {
  return {
    list: vi.fn(async () => sticks),
    mirror: vi.fn(async ({ stickIds, destFile }) =>
      sticks
        .filter(s => !stickIds || stickIds.includes(s.id))
        .map(s => {
          const error = failures[s.id]?.(destFile)
          return error ? { id: s.id, label: s.label, ok: false, verified: false, error, message: error } : { id: s.id, label: s.label, ok: true, verified: true, sha256: 'x', bytes: 3 }
        }))
  }
}

const NOW = new Date('2026-11-12T10:15:07.123Z')

afterEach(() => {
  vi.useRealTimers()
})

describe('stick platform', () => {
  it('is null outside the desktop app', () => {
    expect(createStickPlatform({})).toBeNull()
    expect(createStickPlatform(undefined)).toBeNull()
    expect(createStickPlatform({ Capacitor: { isNativePlatform: () => true } })).toBeNull()
  })

  it('maps every operation to the stick_* commands', async () => {
    const invoke = vi.fn(async (cmd) => (cmd === 'stick_list' ? [STICK_A] : cmd === 'stick_read' ? '{}' : []))
    const p = createStickPlatform({ __TAURI_INTERNALS__: { invoke } })
    expect(await p.list()).toEqual([STICK_A])
    await p.mirror({ matchDir: 'game7-seed', sourceFile: 's.json', destFile: 'd.json' })
    expect(invoke).toHaveBeenCalledWith('stick_mirror', { stickIds: null, matchDir: 'game7-seed', sourceFile: 's.json', destFile: 'd.json', verify: true })
    await p.listBackups('a1')
    expect(invoke).toHaveBeenCalledWith('stick_list_backups', { stickId: 'a1' })
    expect(await p.read('a1', 'game7-seed', 'd.json')).toBe('{}')
    expect(invoke).toHaveBeenCalledWith('stick_read', { stickId: 'a1', matchDir: 'game7-seed', fileName: 'd.json' })
    await p.remove('a1', 'game7-seed', ['d.json'])
    expect(invoke).toHaveBeenCalledWith('stick_remove', { stickId: 'a1', matchDir: 'game7-seed', fileNames: ['d.json'] })
  })

  it('reads the error code of a refused call', () => {
    expect(stickErrorCode(new Error('removed: the stick is not there any more'))).toBe('removed')
    expect(stickErrorCode('full: 3 bytes free')).toBe('full')
    expect(stickErrorCode('something else')).toBe('io')
    expect(stickErrorCode(null)).toBe('io')
  })
})

describe('file names', () => {
  it('stamps in UTC, fixed width', () => {
    expect(compactStamp(NOW)).toBe('20261112T101507Z')
    expect(compactStamp('2027-01-02T03:04:05Z')).toBe('20270102T030405Z')
  })

  it('tags a computer with 8 hex of SHA-256 of its id', async () => {
    // sha256("abc") = ba7816bf...
    expect(await deviceTagOf('abc')).toBe('ba7816bf')
    expect(await deviceTagOf(null)).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('copy to stick now', () => {
  const setup = (sticks, failures) => {
    const platform = fakePlatform(sticks, failures)
    const engine = fakeEngine()
    const sb = createStickBackup({ platform, getEngine: async () => engine, deviceTag: async () => 'abcd1234', now: () => NOW, doc: null, log: { warn() {}, error() {} } })
    return { platform, engine, sb }
  }

  it('saves the match, then copies latest and a manual copy to every stick', async () => {
    const { platform, engine, sb } = setup([STICK_A, STICK_B])
    const out = await sb.copyMatch(7)
    expect(out.status).toBe('ok')
    expect(engine.backupNow).toHaveBeenCalledWith(7)
    const [first, second] = platform.mirror.mock.calls.map(c => c[0])
    expect(first).toMatchObject({ stickIds: null, matchDir: 'game7-seed', sourceFile: '20261112T100001.000Z-00001.json', destFile: 'abcd1234-latest.json', verify: true })
    expect(second).toMatchObject({ stickIds: ['a1', 'b2'], destFile: 'abcd1234-manual-20261112T101507Z.json', verify: true })
    expect(sb.getState().lastCopy).toMatchObject({ at: NOW, matchId: 7, dir: 'game7-seed' })
    expect(sb.getState().writing).toBe(false)
  })

  it('reports each stick that failed, and copies the manual file only where latest worked', async () => {
    const { platform, sb } = setup([STICK_A, STICK_B], { b2: () => 'full' })
    const out = await sb.copyMatch(7)
    expect(out.status).toBe('partial')
    expect(out.results.find(r => r.id === 'b2')).toMatchObject({ ok: false, error: 'full', label: 'SD' })
    expect(platform.mirror.mock.calls[1][0].stickIds).toEqual(['a1'])
  })

  it('a failure of the manual copy counts too', async () => {
    const { sb } = setup([STICK_A], { a1: (dest) => (dest.includes('-manual-') ? 'removed' : null) })
    const out = await sb.copyMatch(7)
    expect(out.status).toBe('failed')
    expect(out.results[0]).toMatchObject({ error: 'removed', label: 'KINGSTON' })
    expect(sb.getState().lastCopy).toBeNull()
  })

  it('no stick: nothing copied', async () => {
    const { sb } = setup([])
    expect((await sb.copyMatch(7)).status).toBe('noStick')
  })

  it('a backup that could not be saved copies nothing', async () => {
    const { platform, engine, sb } = setup([STICK_A])
    engine.backupNow.mockResolvedValue({ error: 'disk full' })
    engine.lastWrittenOf.mockReturnValue(null)
    const out = await sb.copyMatch(7)
    expect(out).toMatchObject({ status: 'backupFailed', error: 'disk full' })
    expect(platform.mirror).not.toHaveBeenCalled()
  })

  it('two taps make one copy', async () => {
    const { engine, sb } = setup([STICK_A])
    const [a, b] = [sb.copyMatch(7), sb.copyMatch(7)]
    expect(a).toBe(b)
    await a
    expect(engine.backupNow).toHaveBeenCalledTimes(1)
  })

  it('outside the desktop app it does nothing', async () => {
    const sb = createStickBackup({ platform: null, getEngine: async () => null })
    expect(sb.getState().supported).toBe(false)
    expect((await sb.copyMatch(7)).status).toBe('unsupported')
    expect(typeof sb.startPolling()).toBe('function')
  })
})

describe('stick list polling', () => {
  it('polls while someone looks and the page is visible', async () => {
    vi.useFakeTimers()
    const doc = new EventTarget()
    doc.hidden = false
    const platform = fakePlatform([STICK_A])
    const sb = createStickBackup({ platform, getEngine: async () => null, doc, log: { warn() {} } })
    const stop = sb.startPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(platform.list).toHaveBeenCalledTimes(1)
    expect(sb.getState().sticks).toEqual([STICK_A])
    await vi.advanceTimersByTimeAsync(STICK_POLL_MS)
    expect(platform.list).toHaveBeenCalledTimes(2)

    // hidden: no listing; visible again: at once
    doc.hidden = true
    await vi.advanceTimersByTimeAsync(STICK_POLL_MS * 3)
    expect(platform.list).toHaveBeenCalledTimes(2)
    doc.hidden = false
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(platform.list).toHaveBeenCalledTimes(3)

    stop()
    await vi.advanceTimersByTimeAsync(STICK_POLL_MS * 3)
    expect(platform.list).toHaveBeenCalledTimes(3)
  })

  it('a failed listing is an error, not a crash', async () => {
    const platform = { list: vi.fn(async () => { throw new Error('io: boom') }) }
    const sb = createStickBackup({ platform, getEngine: async () => null, doc: null, log: { warn() {} } })
    expect(await sb.refresh()).toEqual([])
    expect(sb.getState().error).toBe('io: boom')
  })
})
