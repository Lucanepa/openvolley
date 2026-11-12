import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    i18n: { language: 'en' }
  })
}))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert: vi.fn() }) }))
// the desktop app: Options > Backup has the USB stick row
vi.mock('../../utils/nativeBackup', () => ({
  detectBackupPlatform: () => 'tauri',
  isNativeBackupPlatform: () => true,
  useNativeBackupStatus: () => ({ folder: '/home/u/.local/share/OpenVolley/backups', lastBackup: null, error: null }),
  openNativeBackupFolder: vi.fn(),
  pickNativeBackupFile: vi.fn()
}))
const stickState = { current: { supported: true, sticks: [], lastCopy: null, writing: false, error: null } }
vi.mock('../../utils/stickBackup', () => ({
  STICK_FULL_BYTES: 16 * 1024 * 1024,
  useStickBackup: () => stickState.current,
  copyMatchToSticks: vi.fn()
}))
vi.mock('../../ui/uiStore.js', async (orig) => {
  const real = await orig()
  return { ...real, toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }
})
vi.mock('../../utils/backupManager', () => ({
  restoreMatchInPlace: vi.fn(),
  listCloudBackups: vi.fn(),
  fetchCloudBackup: vi.fn(),
  selectBackupFile: vi.fn(),
  getBackupSettings: () => ({ autoBackupEnabled: true }),
  matchBackupFromFile: (data) => data
}))
vi.mock('../../diagnostics/reload', () => ({ reloadWithReason: vi.fn() }))
vi.mock('../../db/db', () => ({ db: { matches: { get: vi.fn(async () => ({ id: 7 })) } } }))
vi.mock('../../utils/activity', () => ({ canOpenLogFolder: async () => false, openLogFolder: async () => false }))

import ScoreboardOptionsModal from '../options/ScoreboardOptionsModal'
import { copyMatchToSticks } from '../../utils/stickBackup'
import { toast } from '../../ui/uiStore.js'

const STICK = { id: 'a1', label: 'KINGSTON', fs: 'vfat', freeBytes: 7_500_000_000, totalBytes: 16e9, readOnly: false, locked: false, hasFolder: true }

const open = (matchId = 7) =>
  render(<ScoreboardOptionsModal open={true} onClose={() => {}} matchId={matchId} matchOptions={{}} displayOptions={{}} />)
const copyButton = () => screen.getByTestId('stick-copy-now')

describe('Scoreboard options: USB stick', () => {
  beforeEach(() => {
    copyMatchToSticks.mockReset()
    toast.success.mockClear()
    toast.error.mockClear()
    stickState.current = { supported: true, sticks: [], lastCopy: null, writing: false, error: null }
  })

  it('without a stick: a hint, and nothing to copy to', () => {
    open()
    expect(screen.getByTestId('stick-none').textContent).toContain('options.stickNone')
    expect(copyButton().disabled).toBe(true)
  })

  it('lists the sticks with their free space and state', () => {
    stickState.current = {
      ...stickState.current,
      sticks: [
        STICK,
        { ...STICK, id: 'b2', label: 'OLD', readOnly: true },
        { ...STICK, id: 'c3', label: 'TINY', freeBytes: 1_000_000 },
        { ...STICK, id: 'd4', label: 'E:', locked: true, freeBytes: null }
      ]
    }
    open()
    const list = screen.getByTestId('stick-list')
    expect(list.textContent).toContain('KINGSTON')
    expect(list.textContent).toContain('options.stickFree {"size":"7.5 GB"}')
    expect(list.textContent).toContain('options.stickReadOnly')
    expect(list.textContent).toContain('options.stickFull')
    expect(list.textContent).toContain('options.stickLocked')
    expect(copyButton().disabled).toBe(false)
  })

  it('copies and says where to; a failed stick is named with its reason', async () => {
    stickState.current = { ...stickState.current, sticks: [STICK] }
    copyMatchToSticks.mockResolvedValue({ status: 'ok', results: [{ id: 'a1', label: 'KINGSTON', ok: true }] })
    open()
    fireEvent.click(copyButton())
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(copyMatchToSticks).toHaveBeenCalledWith(7)
    expect(toast.success.mock.calls[0][0]).toBe('options.stickCopied {"sticks":"KINGSTON"}')

    copyMatchToSticks.mockResolvedValue({
      status: 'partial',
      results: [{ id: 'a1', label: 'KINGSTON', ok: true }, { id: 'b2', label: 'SD', ok: false, error: 'full', message: '1 bytes free' }]
    })
    fireEvent.click(copyButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.error.mock.calls[0][0]).toContain('options.stickCopied {"sticks":"KINGSTON"}')
    expect(toast.error.mock.calls[0][0]).toContain('options.stickErrFull {"stick":"SD"')
  })

  it('a backup that could not be saved is an error toast', async () => {
    stickState.current = { ...stickState.current, sticks: [STICK] }
    copyMatchToSticks.mockResolvedValue({ status: 'backupFailed', results: [], error: 'disk full' })
    open()
    fireEvent.click(copyButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.error.mock.calls[0][0]).toBe('options.stickBackupFailed {"error":"disk full"}')
  })

  it('needs an open match', () => {
    stickState.current = { ...stickState.current, sticks: [STICK] }
    open(null)
    expect(copyButton().disabled).toBe(true)
    expect(screen.getByText('options.stickStartMatch')).toBeTruthy()
  })
})
