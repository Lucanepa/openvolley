import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  // the key, with the minutes of the periodic download when given
  useTranslation: () => ({ t: (key, opts) => (opts?.minutes != null ? `${key} ${opts.minutes}` : key) })
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
    expect(screen.getByTestId('native-backup-privacy')).toHaveTextContent(/^options\.nativeBackupPrivacy( options\.nativeBackupRecoveryNote)?$/)

    fireEvent.click(screen.getByRole('button', { name: 'options.openBackupFolder' }))
    expect(backup.openBackupFolder).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'options.restoreFromBackupFile' }))
    expect(onRestoreFromFile).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'options.downloadBackupNow' })).toBeNull()
  })

  it('Android: shows the app folder and that copies go out by Export to Documents, no open-folder button', () => {
    render(<HomeOptionsModal {...baseProps} backup={nativeBackup({ platform: 'capacitor', canOpenBackupFolder: false, backupFolder: '/data/user/0/com.openvolley.escoresheet/files/OpenVolley/backups' })} />)
    expect(screen.getByTestId('native-backup-folder')).toHaveTextContent('/data/user/0/com.openvolley.escoresheet/files/OpenVolley/backups')
    expect(screen.getByText('options.nativeBackupCopyHint')).toBeInTheDocument()
    // inside the app, removed with it; an exported copy is the user's
    expect(screen.getByTestId('native-backup-privacy')).toHaveTextContent(/^options\.nativeBackupPrivacyAndroid( options\.nativeBackupRecoveryNote)?$/)
    expect(screen.queryByRole('button', { name: 'options.openBackupFolder' })).toBeNull()
    expect(screen.getByRole('button', { name: 'options.exportToDocuments' })).toBeInTheDocument()
  })

  it('Android: Export to Documents copies the files out and says where', async () => {
    const exportToDocuments = vi.fn(async () => ({ folder: 'Documents/OpenVolley/export-20261113-1200', backups: 2, scoresheets: 1, failed: 1 }))
    render(<HomeOptionsModal {...baseProps} backup={nativeBackup({ platform: 'capacitor', canOpenBackupFolder: false, exportToDocuments })} />)
    fireEvent.click(screen.getByRole('button', { name: 'options.exportToDocuments' }))
    expect(await screen.findByTestId('export-to-documents-result')).toHaveTextContent('options.exportedToDocuments options.exportToDocumentsSomeFailed')
    expect(exportToDocuments).toHaveBeenCalledTimes(1)
  })

  it('the desktop app has no Export to Documents (its folder is the user\'s own)', () => {
    render(<HomeOptionsModal {...baseProps} backup={nativeBackup()} />)
    expect(screen.queryByRole('button', { name: 'options.exportToDocuments' })).toBeNull()
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

  // UI tour 14.11 (o40): after Close match, "Download backup now" started no
  // download and said nothing (useAutoBackup has no match to back up). With
  // no open match the button is off and the screen says why.
  it('browsers: Download backup now with no open match is off and says why', () => {
    const manualBackup = vi.fn()
    render(<HomeOptionsModal {...baseProps} backup={{ nativeMode: false, hasFileSystemAccess: false, autoBackupEnabled: false, toggleAutoBackup: vi.fn(), activeMatchId: null, manualBackup }} />)
    const button = screen.getByRole('button', { name: 'options.downloadBackupNow' })
    expect(button).toBeDisabled()
    expect(screen.getByText('options.noMatchToBackUp')).toBeInTheDocument()
    expect(button).toHaveAttribute('aria-describedby', screen.getByText('options.noMatchToBackUp').id)
  })

  it('browsers: Download backup now with an open match downloads it', () => {
    const manualBackup = vi.fn()
    render(<HomeOptionsModal {...baseProps} backup={{ nativeMode: false, hasFileSystemAccess: false, autoBackupEnabled: false, toggleAutoBackup: vi.fn(), activeMatchId: 4, manualBackup }} />)
    fireEvent.click(screen.getByRole('button', { name: 'options.downloadBackupNow' }))
    expect(manualBackup).toHaveBeenCalled()
    expect(screen.queryByText('options.noMatchToBackUp')).toBeNull()
  })

  // Review 8a: App clears matchId on Home, so an unfinished match the device
  // offers to Continue is backed up through backupMatchId, not refused.
  it('browsers: on Home the Continue match is backed up', () => {
    const manualBackup = vi.fn()
    render(<HomeOptionsModal {...baseProps} backupMatchId={7} backup={{ nativeMode: false, hasFileSystemAccess: false, autoBackupEnabled: false, toggleAutoBackup: vi.fn(), activeMatchId: null, manualBackup }} />)
    const button = screen.getByRole('button', { name: 'options.downloadBackupNow' })
    expect(button).not.toBeDisabled()
    expect(screen.queryByText('options.noMatchToBackUp')).toBeNull()
    fireEvent.click(button)
    expect(manualBackup).toHaveBeenCalledWith(7)
  })

  it('apps: on Home the Continue match can be saved now', () => {
    const backup = nativeBackup({ activeMatchId: null })
    render(<HomeOptionsModal {...baseProps} backup={backup} backupMatchId={9} />)
    fireEvent.click(screen.getByRole('button', { name: 'options.saveBackupNow' }))
    expect(backup.manualBackup).toHaveBeenCalledWith(9)
  })

  // useAutoBackup downloads at the set end and the match end, and every few
  // minutes when the match changed; the list also named the set start and a
  // timeout, which never download
  it('browsers without a folder: the list says when a backup is downloaded', () => {
    render(<HomeOptionsModal {...baseProps} backup={{ nativeMode: false, hasFileSystemAccess: false, autoBackupEnabled: true, backupFrequency: 5, toggleAutoBackup: vi.fn() }} />)
    expect(screen.getByText('options.autoDownloadWhen')).toBeInTheDocument()
    const list = screen.getByTestId('browser-auto-download')
    expect([...list.children].map(row => row.textContent.replace('✓', '').trim())).toEqual([
      'options.setEnd',
      'options.matchEnd',
      'options.autoDownloadEveryMinutes 5'
    ])
  })
})
