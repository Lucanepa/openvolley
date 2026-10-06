import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key })
}))
vi.mock('../../contexts/AlertContext', () => ({
  useAlert: () => ({ showAlert: vi.fn() })
}))
vi.mock('../SupportFeedbackModal', () => ({ default: () => null }))

import HomeOptionsModal from '../options/HomeOptionsModal'

const baseProps = {
  open: true,
  onClose: () => {},
  matchOptions: {},
  displayOptions: {},
  wakeLock: {}
}

const nativeBackup = (overrides = {}) => ({
  nativeMode: true,
  platform: 'tauri',
  autoBackupEnabled: true,
  backupFolder: '/home/scorer/.local/share/OpenVolley/backups',
  canOpenBackupFolder: true,
  activeMatchId: null,
  lastBackup: null,
  backupError: null,
  toggleAutoBackup: vi.fn(),
  openBackupFolder: vi.fn(async () => true),
  manualBackup: vi.fn(),
  ...overrides
})

describe('Options > Backup', () => {
  it('apps: automatic backup at every event, the folder, open + restore, no browser warning', () => {
    const backup = nativeBackup()
    const onRestoreFromFile = vi.fn()
    render(<HomeOptionsModal {...baseProps} backup={backup} onRestoreFromFile={onRestoreFromFile} />)

    expect(screen.queryByText('options.limitedBrowserSupport')).toBeNull()
    expect(screen.getByText('options.nativeBackupOn')).toBeInTheDocument()
    expect(screen.getByTestId('native-backup-folder')).toHaveTextContent('/home/scorer/.local/share/OpenVolley/backups')

    fireEvent.click(screen.getByRole('button', { name: 'options.openBackupFolder' }))
    expect(backup.openBackupFolder).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'options.restoreFromBackupFile' }))
    expect(onRestoreFromFile).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'options.downloadBackupNow' })).toBeNull()
  })

  it('Android: shows the path and how to copy it, no open-folder button', () => {
    render(<HomeOptionsModal {...baseProps} backup={nativeBackup({ platform: 'capacitor', canOpenBackupFolder: false, backupFolder: '/storage/emulated/0/Documents/OpenVolley/backups' })} />)
    expect(screen.getByTestId('native-backup-folder')).toHaveTextContent('/storage/emulated/0/Documents/OpenVolley/backups')
    expect(screen.getByText('options.nativeBackupCopyHint')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'options.openBackupFolder' })).toBeNull()
  })

  it('apps: switched off, and a failed write shown as a status (not an alert)', () => {
    const backup = nativeBackup({ autoBackupEnabled: false, backupError: 'disk full' })
    render(<HomeOptionsModal {...baseProps} backup={backup} />)
    expect(screen.getByText('options.nativeBackupOff')).toBeInTheDocument()
    const status = screen.getByRole('status')
    expect(within(status).getByText(/disk full/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('apps: Save a backup now only with an open match', () => {
    const backup = nativeBackup({ activeMatchId: 3 })
    render(<HomeOptionsModal {...baseProps} backup={backup} />)
    fireEvent.click(screen.getByRole('button', { name: 'options.saveBackupNow' }))
    expect(backup.manualBackup).toHaveBeenCalled()
  })

  it('browsers keep the folder / download options and the browser notice', () => {
    render(<HomeOptionsModal {...baseProps} backup={{ nativeMode: false, hasFileSystemAccess: false, autoBackupEnabled: false, toggleAutoBackup: vi.fn() }} />)
    expect(screen.getByText('options.limitedBrowserSupport')).toBeInTheDocument()
    expect(screen.getByText('options.limitedBrowserSupportDesc')).toBeInTheDocument()
    expect(screen.queryByTestId('native-backup-folder')).toBeNull()
  })
})
