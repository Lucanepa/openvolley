import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key })
}))

const state = vi.hoisted(() => ({ platform: 'tauri', status: { error: null } }))
vi.mock('../../utils/nativeBackup', () => ({
  detectBackupPlatform: () => state.platform,
  isNativeBackupPlatform: (p) => p === 'tauri' || p === 'capacitor',
  useNativeBackupStatus: () => state.status
}))

import NativeBackupAlert from '../options/NativeBackupAlert'

describe('NativeBackupAlert (scoreboard toolbar)', () => {
  beforeEach(() => {
    state.platform = 'tauri'
    state.status = { error: null }
  })

  it('shows nothing while backups succeed', () => {
    render(<NativeBackupAlert onOpen={() => {}} />)
    expect(screen.queryByTestId('native-backup-alert')).toBeNull()
  })

  it('shows a badge with the error while backups fail, which opens Options', () => {
    state.status = { error: 'Command backup_write not allowed by ACL' }
    const onOpen = vi.fn()
    render(<NativeBackupAlert onOpen={onOpen} />)
    const badge = screen.getByTestId('native-backup-alert')
    expect(badge.getAttribute('title')).toContain('not allowed by ACL')
    fireEvent.click(badge)
    expect(onOpen).toHaveBeenCalled()
  })

  it('never shows in a browser', () => {
    state.platform = 'web'
    state.status = { error: 'x' }
    render(<NativeBackupAlert onOpen={() => {}} />)
    expect(screen.queryByTestId('native-backup-alert')).toBeNull()
  })
})
