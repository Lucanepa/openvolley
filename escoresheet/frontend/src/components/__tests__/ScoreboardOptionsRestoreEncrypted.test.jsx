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
  getBackupSettings: () => ({ autoBackupEnabled: true }),
  matchBackupFromFile: (data) => data
}))
vi.mock('../../diagnostics/reload', () => ({ reloadWithReason: vi.fn() }))
vi.mock('../../db/db', () => ({ db: { matches: { get: vi.fn(async () => ({ id: 7, seed_key: 'match_1792518507614_u2sbmb' })) } } }))
vi.mock('../../utils/activity', () => ({ canOpenLogFolder: async () => false, openLogFolder: async () => false }))

import ScoreboardOptionsModal from '../options/ScoreboardOptionsModal'
import { pickNativeBackupFile } from '../../utils/nativeBackup'
import { restoreMatchInPlace } from '../../utils/backupManager'
import { reloadWithReason } from '../../diagnostics/reload'
import { createBackupSealer } from '../../utils/backupCrypto/sealer'

const backup = {
  version: 1,
  lastUpdated: '2026-10-29T19:00:00.000Z',
  match: { seed_key: 'match_1792518507614_u2sbmb', status: 'live', gameN: 9 },
  homeTeam: { name: 'Home' },
  awayTeam: { name: 'Away' },
  sets: [{ index: 3, homePoints: 12, awayPoints: 10 }],
  events: [],
  secretsRemoved: true
}

async function encrypted() {
  const data = { ...backup, match: { ...backup.match, gamePin: '123456', refereePin: '654321' } }
  return JSON.parse((await createBackupSealer().seal(7, data, JSON.stringify(backup), backup.lastUpdated)).text)
}

const pinField = () => screen.getByLabelText('settings.backup.unlock.pinLabel')
const openButton = () => screen.getByRole('button', { name: 'settings.backup.unlock.open' })

function openRestoreFromFile() {
  render(<ScoreboardOptionsModal open={true} onClose={() => {}} matchId={7} matchOptions={{}} displayOptions={{}} />)
  fireEvent.click(screen.getByRole('button', { name: 'options.restoreFromBackupFile' }))
}

// The scoring screen's Options: the same PIN question before the "Confirm
// restore" of restoreMatchInPlace
describe('Scoreboard options: restoring the open match from an encrypted backup file', () => {
  beforeEach(() => {
    showAlert.mockClear()
    reloadWithReason.mockClear()
    restoreMatchInPlace.mockReset()
  })

  it('asks for the PIN: a wrong one says so, the right one leads to the confirmation and restores with it', async () => {
    pickNativeBackupFile.mockResolvedValue(await encrypted())
    openRestoreFromFile()
    await waitFor(() => expect(pinField()).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'options.restore' })).toBeNull()

    fireEvent.change(pinField(), { target: { value: '000000' } })
    fireEvent.click(openButton())
    await waitFor(() => expect(screen.getByText('settings.backup.unlock.wrongPin')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'options.restore' })).toBeNull()

    fireEvent.change(pinField(), { target: { value: '123456' } })
    fireEvent.click(openButton())
    await waitFor(() => expect(screen.getByRole('button', { name: 'options.restore' })).toBeTruthy())
    expect(screen.queryByLabelText('settings.backup.unlock.pinLabel')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'options.restore' }))
    await waitFor(() => expect(restoreMatchInPlace).toHaveBeenCalledTimes(1))
    expect(restoreMatchInPlace.mock.calls[0][0]).toBe(7)
    expect(restoreMatchInPlace.mock.calls[0][1]).toMatchObject({
      match: { seed_key: 'match_1792518507614_u2sbmb' },
      sets: [{ index: 3, homePoints: 12 }],
      unlockedWith: { pin: 'game', field: 'gamePin', value: '123456' }
    })
    await waitFor(() => expect(reloadWithReason).toHaveBeenCalledWith('backup-restored'))
  })

  it('Cancel goes back to the options: no confirmation, no restore', async () => {
    pickNativeBackupFile.mockResolvedValue(await encrypted())
    openRestoreFromFile()
    await waitFor(() => expect(pinField()).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    await waitFor(() => expect(screen.queryByLabelText('settings.backup.unlock.pinLabel')).toBeNull())
    expect(screen.queryByRole('button', { name: 'options.restore' })).toBeNull()
    expect(screen.getByRole('button', { name: 'options.restoreFromBackupFile' })).toBeTruthy()
    expect(restoreMatchInPlace).not.toHaveBeenCalled()
    expect(showAlert).not.toHaveBeenCalled()
  })

  it('a plain backup file goes straight to the confirmation, as before', async () => {
    pickNativeBackupFile.mockResolvedValue(structuredClone(backup))
    openRestoreFromFile()
    await waitFor(() => expect(screen.getByRole('button', { name: 'options.restore' })).toBeTruthy())
    expect(screen.queryByLabelText('settings.backup.unlock.pinLabel')).toBeNull()
  })
})
