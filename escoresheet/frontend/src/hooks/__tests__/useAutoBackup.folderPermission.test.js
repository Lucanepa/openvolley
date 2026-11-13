// The backup folder chosen in Options, at the next start in a browser that
// asks for its permission again (audit logic-hooks-misc-1): it was asked for
// from an effect, without a tap, the browser refused, and the folder was
// forgotten. It stays, on "Reconnect folder", and is asked for on that tap.
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../../db/db', () => ({ db: { events: { hook: () => ({ unsubscribe () {} }) }, sets: { hook: () => ({ unsubscribe () {} }) }, matches: { hook: () => ({ unsubscribe () {} }) } } }))
const handle = {
  name: 'Backups',
  queryPermission: vi.fn(async () => 'prompt'),
  requestPermission: vi.fn(async () => { throw Object.assign(new Error('needs a user gesture'), { name: 'SecurityError' }) })
}
vi.mock('../../utils/backupManager', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    isFileSystemAccessSupported: () => true,
    getStoredDirectoryHandle: vi.fn(async () => handle),
    clearStoredDirectoryHandle: vi.fn(async () => {})
  }
})

describe('useAutoBackup: a stored backup folder the browser asks about again', () => {
  it('is kept on "prompt", never asked for without a tap, and asked for on Reconnect', async () => {
    const { default: useAutoBackup } = await import('../useAutoBackup')
    const { clearStoredDirectoryHandle } = await import('../../utils/backupManager')
    const { result } = renderHook(() => useAutoBackup(null))
    await waitFor(() => expect(result.current.needsReconnect).toBe(true))
    expect(result.current.backupDirName).toBe('Backups')
    expect(handle.requestPermission).not.toHaveBeenCalled()
    expect(clearStoredDirectoryHandle).not.toHaveBeenCalled()

    handle.requestPermission.mockResolvedValueOnce('granted')
    await act(async () => { expect(await result.current.reconnectBackupDir()).toBe(true) })
    expect(handle.requestPermission).toHaveBeenCalledTimes(1)
    expect(result.current.needsReconnect).toBe(false)
  })
})
