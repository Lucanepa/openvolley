// Stress test 2026-10-25 (setend-backup-not-restorable-silent-restore-errors):
// Confirm restore of a set-end download did nothing and said nothing, and a
// damaged backup file opened no preview and said nothing either. The Restore
// dialogs kept every error in state (restoreError) but never showed it.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
vi.mock('../utils/backupManager', async (importOriginal) => ({
  ...(await importOriginal()),
  selectBackupFile: vi.fn(),
  restoreMatchFromJson: vi.fn()
}))
import { db } from '../db/db'
import { restoreMatchFromJson, selectBackupFile, BACKUP_UNREADABLE_ERROR } from '../utils/backupManager'
import en from '../i18n/locales/en.json'
import { offline, online, mountApp, button } from './appMount'

beforeAll(offline)
afterAll(online)
beforeEach(async () => {
  cleanup()
  vi.mocked(selectBackupFile).mockReset()
  vi.mocked(restoreMatchFromJson).mockReset()
  await Promise.all(db.tables.map(table => table.clear()))
})

const alerts = () => [...document.querySelectorAll('[role="alert"]')].map(n => n.textContent)

async function pickFile() {
  mountApp()
  await waitFor(() => expect(button('Restore match')).toBeTruthy())
  fireEvent.click(button('Restore match'))
  await waitFor(() => expect(button(en.settings.backup.selectBackupFile)).toBeTruthy())
  fireEvent.click(button(en.settings.backup.selectBackupFile))
}

describe('App: the Restore dialogs say why a restore failed', () => {
  it('a damaged file: the dialog says it cannot be read', async () => {
    selectBackupFile.mockRejectedValue(Object.assign(new Error('Invalid JSON file'), { code: BACKUP_UNREADABLE_ERROR }))
    await pickFile()
    await waitFor(() => expect(alerts()).toContain(en.settings.backup.restoreErrors.unreadable))
    expect(button(en.settings.backup.preview.confirmRestore)).toBeFalsy()
  })

  it('Confirm restore fails: the preview stays and says why', async () => {
    selectBackupFile.mockResolvedValue({ version: 1, match: { seed_key: 'match_1_x', status: 'live' }, homeTeam: { name: 'Home' }, awayTeam: { name: 'Away' }, sets: [], events: [] })
    restoreMatchFromJson.mockRejectedValue(new Error('disk full'))
    await pickFile()
    await waitFor(() => expect(button(en.settings.backup.preview.confirmRestore)).toBeTruthy())
    fireEvent.click(button(en.settings.backup.preview.confirmRestore))
    await waitFor(() => expect(alerts()).toContain(en.settings.backup.restoreErrors.failed.replace('{{error}}', 'disk full')))
    expect(button(en.settings.backup.preview.confirmRestore)).toBeTruthy()
  })

  it('a set-end download is previewed and restored as the match it holds', async () => {
    selectBackupFile.mockResolvedValue({
      exportDate: '2026-10-25T18:40:00.000Z', exportReason: 'set_1_end', matchId: 2,
      matches: [{ id: 1, seed_key: 'old', homeTeamId: 1, awayTeamId: 2 }, { id: 2, seed_key: 'match_2_y', status: 'live', homeTeamId: 3, awayTeamId: 4 }],
      teams: [{ id: 1, name: 'Last week' }, { id: 2, name: 'Last week away' }, { id: 3, name: 'Today home' }, { id: 4, name: 'Today away' }],
      players: [], sets: [{ id: 5, matchId: 2, index: 1, homePoints: 25, awayPoints: 7, finished: true }], events: [], referees: [], scorers: []
    })
    restoreMatchFromJson.mockResolvedValue(null)
    await pickFile()
    await waitFor(() => expect(button(en.settings.backup.preview.confirmRestore)).toBeTruthy())
    expect(document.body.textContent).toContain('Today home')
    expect(document.body.textContent).not.toContain('Last week')
    fireEvent.click(button(en.settings.backup.preview.confirmRestore))
    await waitFor(() => expect(restoreMatchFromJson).toHaveBeenCalledTimes(1))
    expect(restoreMatchFromJson.mock.calls[0][0]).toMatchObject({ version: 1, match: { seed_key: 'match_2_y' }, homeTeam: { name: 'Today home' } })
  })
})
