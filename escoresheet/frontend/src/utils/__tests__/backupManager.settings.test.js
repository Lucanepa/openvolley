import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/db', () => ({ db: {} }))
vi.mock('../../lib/apiClient', () => ({ apiFrom: vi.fn(), apiStorage: { from: vi.fn() } }))

import { getBackupSettings, saveBackupSettings } from '../backupManager'

beforeEach(() => {
  for (const key of ['autoBackupEnabled', 'nativeAutoBackupEnabled', 'backupFrequencyMinutes', 'autoDownloadAtSetEnd']) localStorage.removeItem(key)
})

describe('backup settings', () => {
  it('defaults: the apps back up, browsers do not; the set-end download is on everywhere', () => {
    expect(getBackupSettings()).toEqual({ autoBackupEnabled: false, backupFrequencyMinutes: 5, autoDownloadAtSetEnd: true })
    expect(getBackupSettings({ native: true })).toEqual({ autoBackupEnabled: true, backupFrequencyMinutes: 5, autoDownloadAtSetEnd: true })
  })

  // The scoreboard's "Auto-download data at set end" lived in its state only:
  // every new scoreboard (a reload, the next match) turned it back on
  it('the set-end download keeps its switch, under its own key', () => {
    saveBackupSettings({ autoDownloadAtSetEnd: false })
    expect(localStorage.getItem('autoDownloadAtSetEnd')).toBe('false')
    expect(getBackupSettings().autoDownloadAtSetEnd).toBe(false)
    expect(getBackupSettings({ native: true }).autoDownloadAtSetEnd).toBe(false)
    // the other settings are left alone
    expect(localStorage.getItem('autoBackupEnabled')).toBeNull()
    saveBackupSettings({ autoDownloadAtSetEnd: true })
    expect(getBackupSettings().autoDownloadAtSetEnd).toBe(true)
    saveBackupSettings({ autoBackupEnabled: true })
    expect(localStorage.getItem('autoDownloadAtSetEnd')).toBe('true')
  })
})
