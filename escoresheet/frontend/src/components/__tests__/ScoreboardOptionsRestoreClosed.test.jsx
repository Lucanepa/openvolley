import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const showAlert = vi.fn()
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, params) => (params?.error ? `${key}: ${params.error}` : key), i18n: { language: 'en' } })
}))
vi.mock('../../contexts/AlertContext', () => ({ useAlert: () => ({ showAlert }) }))
// the app's backup folder (Android): Options > Backup > Restore from a backup file
vi.mock('../../utils/nativeBackup', () => ({
  detectBackupPlatform: () => 'capacitor',
  isNativeBackupPlatform: () => true,
  useNativeBackupStatus: () => ({ folder: '/storage/emulated/0/Documents/OpenVolley/backups', lastBackup: null, error: null }),
  openNativeBackupFolder: vi.fn(),
  pickNativeBackupFile: vi.fn()
}))
vi.mock('../../utils/backupManager', () => ({
  restoreMatchInPlace: vi.fn(),
  listCloudBackups: vi.fn(),
  fetchCloudBackup: vi.fn(),
  selectBackupFile: vi.fn(),
  getBackupSettings: () => ({ autoBackupEnabled: true })
}))
vi.mock('../../diagnostics/reload', () => ({ reloadWithReason: vi.fn() }))
vi.mock('../../db/db', () => ({ db: { matches: { get: vi.fn(async () => ({ id: 7, seed_key: 'match_1792518507614_u2sbmb' })) } } }))
vi.mock('../../utils/activity', () => ({ canOpenLogFolder: async () => false, openLogFolder: async () => false }))

import ScoreboardOptionsModal from '../options/ScoreboardOptionsModal'
import { pickNativeBackupFile } from '../../utils/nativeBackup'
import { restoreMatchInPlace } from '../../utils/backupManager'
import { reloadWithReason } from '../../diagnostics/reload'

const backup = { match: { seed_key: 'match_1792518507614_u2sbmb', status: 'live' }, sets: [{ index: 3, homePoints: 12, awayPoints: 10 }], events: [] }

async function restoreFromFile() {
  render(<ScoreboardOptionsModal open={true} onClose={() => {}} matchId={7} matchOptions={{}} displayOptions={{}} />)
  fireEvent.click(screen.getByRole('button', { name: 'options.restoreFromBackupFile' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'options.restore' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'options.restore' }))
  await waitFor(() => expect(showAlert).toHaveBeenCalledTimes(1))
}

// 2026-10-23: a backup of a match the server had closed was restored and
// left a sync error nothing could clear. backupManager refuses it now
// (err.code 'OV_MATCH_CLOSED', nothing written); the scoring screen's
// options say so plainly and do not reload.
describe('Scoreboard options: restoring a backup of a match closed on the server', () => {
  beforeEach(() => {
    showAlert.mockClear()
    reloadWithReason.mockClear()
    pickNativeBackupFile.mockResolvedValue(backup)
  })

  it('says the match is closed on the server, no reload', async () => {
    restoreMatchInPlace.mockRejectedValueOnce(Object.assign(new Error('This match is closed on the server'), { code: 'OV_MATCH_CLOSED' }))
    await restoreFromFile()
    expect(showAlert).toHaveBeenCalledWith('cloudBlock.restoreRefused', 'error')
    expect(reloadWithReason).not.toHaveBeenCalled()
  })

  it('any other failure keeps its own message', async () => {
    restoreMatchInPlace.mockRejectedValueOnce(new Error('disk full'))
    await restoreFromFile()
    expect(showAlert).toHaveBeenCalledWith('options.alerts.failedToRestoreBackup: disk full', 'error')
    expect(reloadWithReason).not.toHaveBeenCalled()
  })
})
