import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { setAppEntry } from '../../utils/appEntry'

// A browser (phone / tablet / Safari / Firefox): no Tauri, no Capacitor, no
// File System Access, so a backup is a file download. The bug: a phone that
// scanned a "Connect tablets" QR code downloaded a match backup of the start
// of the game. Downloads must come only from the scoretable page and only for
// a real change of the match, never from opening or loading it.

// Dexie stand-in with the table hook API the write hook uses
const { fakeDb } = vi.hoisted(() => {
  const hookTable = () => {
    const subs = { creating: new Set(), updating: new Set(), deleting: new Set() }
    return {
      subs,
      hook(type, fn) {
        if (fn) subs[type].add(fn)
        return { unsubscribe: (f) => subs[type].delete(f) }
      }
    }
  }
  const fakeDb = { events: hookTable(), sets: hookTable(), matches: hookTable() }
  // Runs the hooks of one write and commits its transaction
  fakeDb.write = (table, type, ...args) => {
    const complete = []
    const tx = { on: (e, fn) => { if (e === 'complete') complete.push(fn) } }
    for (const fn of fakeDb[table].subs[type]) fn(...args, tx)
    complete.forEach(fn => fn())
  }
  return { fakeDb }
})

vi.mock('../../db/db', () => ({ db: fakeDb }))
vi.mock('../../utils/backupManager', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, downloadMatchBackup: vi.fn(async () => 'backup.json'), writeMatchBackup: vi.fn() }
})

const point = () => act(() => fakeDb.write('events', 'creating', undefined, { matchId: 7, type: 'point' }))
const minutes = (n) => act(() => { vi.advanceTimersByTime(n * 60 * 1000) })

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.setItem('autoBackupEnabled', 'true') // switched on in this browser
  localStorage.setItem('backupFrequencyMinutes', '5')
})
afterEach(() => {
  vi.useRealTimers()
  setAppEntry(null)
  localStorage.clear()
})

async function setup(entry) {
  setAppEntry(entry)
  const { default: useAutoBackup } = await import('../useAutoBackup')
  const { downloadMatchBackup } = await import('../../utils/backupManager')
  downloadMatchBackup.mockClear()
  return { ...renderHook(() => useAutoBackup(7)), downloadMatchBackup }
}

describe('useAutoBackup in a browser', () => {
  it('never downloads just because a match was opened', async () => {
    const { result, downloadMatchBackup, unmount } = await setup('scorer')
    expect(result.current.nativeMode).toBe(false)
    expect(result.current.hasFileSystemAccess).toBe(false)
    expect(result.current.autoBackupEnabled).toBe(true)
    minutes(30)
    expect(downloadMatchBackup).not.toHaveBeenCalled()
    // the start of a set (0:0) and a timeout are no download either
    act(() => result.current.triggerEventBackup('set_start'))
    act(() => result.current.triggerEventBackup('timeout'))
    expect(downloadMatchBackup).not.toHaveBeenCalled()
    unmount()
  })

  it('downloads every N minutes only after the match changed, and at set / match end', async () => {
    const { result, downloadMatchBackup, unmount } = await setup('scorer')
    point()
    minutes(4)
    expect(downloadMatchBackup).not.toHaveBeenCalled() // 5 minutes after opening
    minutes(1)
    expect(downloadMatchBackup).toHaveBeenCalledTimes(1)
    expect(downloadMatchBackup).toHaveBeenCalledWith(7)
    await act(async () => {}) // the download settles
    minutes(15) // nothing new since: no second file
    expect(downloadMatchBackup).toHaveBeenCalledTimes(1)
    // a "rally started" is not a change worth a file
    act(() => fakeDb.write('events', 'creating', undefined, { matchId: 7, type: 'rally_start' }))
    minutes(10)
    expect(downloadMatchBackup).toHaveBeenCalledTimes(1)
    // a write of another match neither
    act(() => fakeDb.write('events', 'creating', undefined, { matchId: 8, type: 'point' }))
    minutes(10)
    expect(downloadMatchBackup).toHaveBeenCalledTimes(1)

    act(() => result.current.triggerEventBackup('set_end'))
    expect(downloadMatchBackup).toHaveBeenCalledTimes(2)
    act(() => result.current.triggerEventBackup('match_end'))
    expect(downloadMatchBackup).toHaveBeenCalledTimes(3)
    unmount()
  })

  it('a point scored while a file is being saved still gets the next file', async () => {
    const { downloadMatchBackup, unmount } = await setup('scorer')
    let finish
    downloadMatchBackup.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    point()
    minutes(5)
    expect(downloadMatchBackup).toHaveBeenCalledTimes(1)
    point() // the file above was read before this point
    await act(async () => { finish('backup.json') })
    minutes(5)
    expect(downloadMatchBackup).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('a failed download keeps the change for the next try', async () => {
    const { downloadMatchBackup, unmount } = await setup('scorer')
    downloadMatchBackup.mockImplementationOnce(async () => { throw new Error('blocked') })
    point()
    minutes(5)
    await act(async () => {})
    expect(downloadMatchBackup).toHaveBeenCalledTimes(1)
    minutes(1) // still changed, and no file since: tried again
    expect(downloadMatchBackup).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('does nothing on a referee, bench, livescore or unmarked page, even switched on', async () => {
    for (const entry of ['referee', 'bench', 'livescore', 'scoresheet', null]) {
      const { result, downloadMatchBackup, unmount } = await setup(entry)
      point()
      minutes(30)
      act(() => result.current.triggerEventBackup('set_end'))
      act(() => result.current.triggerEventBackup('match_end'))
      act(() => result.current.triggerBackup())
      let manual
      await act(async () => { manual = await result.current.manualBackup(7) })
      expect(manual, String(entry)).toBe(false)
      expect(downloadMatchBackup, String(entry)).not.toHaveBeenCalled()
      expect(fakeDb.events.subs.creating.size, String(entry)).toBe(0) // no write hook either
      unmount()
    }
  })
})

describe('downloadMatchBackup', () => {
  it('refuses on any page but the scoretable, before reading the match', async () => {
    const { downloadMatchBackup } = await vi.importActual('../../utils/backupManager')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      for (const entry of ['referee', 'bench', 'livescore', null]) {
        setAppEntry(entry)
        await expect(downloadMatchBackup(7), String(entry)).rejects.toThrow(/scoretable only/)
      }
      expect(click).not.toHaveBeenCalled()
    } finally {
      click.mockRestore()
    }
  })
})
