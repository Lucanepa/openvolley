import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', async () => {
  const en = (await import('../../i18n/locales/en.json')).default
  const get = (k) => k.split('.').reduce((o, p) => o?.[p], en)
  return { useTranslation: () => ({ t: (k, o) => String(get(k) ?? o?.defaultValue ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => o?.[n] ?? ''), i18n: { language: 'en' } }) }
})
vi.mock('../../utils/stickBackup', () => ({
  useStickBackup: () => ({ sticks: [{ id: 'a', label: 'KINGSTON' }], auto: null }),
  getStickAutoEnabled: () => true,
  setStickAutoEnabled: vi.fn()
}))
vi.mock('../../utils/nativeBackup', () => ({ useNativeBackupStatus: () => ({ folder: '/home/u/OpenVolley/backups' }) }))

import BackupTargetsPanel from '../BackupTargetsPanel'

const base = { platform: 'web', nativeMode: false, hasFileSystemAccess: false, autoBackupEnabled: true, backupDirName: null, needsReconnect: false, toggleAutoBackup: vi.fn(), selectBackupDir: vi.fn(), reconnectBackupDir: vi.fn() }

describe('BackupTargetsPanel', () => {
  it('desktop: cloud is on without a switch, device folder and stick are shown', () => {
    render(<BackupTargetsPanel backup={{ ...base, platform: 'tauri', nativeMode: true, backupFolder: '/x' }} />)
    expect(screen.getByText('On: saved to the cloud while you score.')).toBeTruthy()
    expect(screen.getByText('/home/u/OpenVolley/backups')).toBeTruthy()
    expect(screen.getByText('KINGSTON')).toBeTruthy()
  })

  it('a test match is never in the cloud', () => {
    render(<BackupTargetsPanel backup={{ ...base, platform: 'tauri', nativeMode: true }} test />)
    expect(screen.getByText('Test match: never sent to the cloud.')).toBeTruthy()
  })

  it('Chrome: a remembered folder asks one tap to reconnect', () => {
    const reconnect = vi.fn()
    render(<BackupTargetsPanel backup={{ ...base, hasFileSystemAccess: true, backupDirName: 'USB', needsReconnect: true, reconnectBackupDir: reconnect }} />)
    fireEvent.click(screen.getByTestId('backup-reconnect'))
    expect(reconnect).toHaveBeenCalled()
  })

  it('Safari: downloads, no folder button', () => {
    render(<BackupTargetsPanel backup={base} />)
    expect(screen.getByText(/downloads a file at set end/)).toBeTruthy()
    expect(screen.queryByTestId('backup-pick-folder')).toBeNull()
  })
})
