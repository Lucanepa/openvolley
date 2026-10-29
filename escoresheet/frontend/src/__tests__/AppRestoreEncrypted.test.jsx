// The app backup files of a match with a PIN are encrypted (utils/backupCrypto):
// Restore match > Select backup file asks for the game PIN or the referee PIN
// before the preview. A wrong PIN says so and lets the scorer try again,
// Cancel goes back to the Restore dialog, and a plain (older) file restores
// as before, without the question.
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
import { restoreMatchFromJson, selectBackupFile } from '../utils/backupManager'
import { createBackupSealer } from '../utils/backupCrypto/sealer'
import en from '../i18n/locales/en.json'
import { offline, online, mountApp, button } from './appMount'

const tu = en.settings.backup.unlock

const backup = {
  version: 1,
  lastUpdated: '2026-10-29T19:00:00.000Z',
  match: { seed_key: 'match_1_x', status: 'live', gameN: 1042, scheduledAt: '2026-10-29T18:00:00.000Z' },
  homeTeam: { name: 'Volley Home' },
  awayTeam: { name: 'Volley Away' },
  homePlayers: [{ number: 7, firstName: 'Anna', lastName: 'Muster' }],
  awayPlayers: [],
  sets: [{ index: 1, homePoints: 25, awayPoints: 20, finished: true }, { index: 2, homePoints: 3, awayPoints: 1 }],
  events: [],
  secretsRemoved: true
}

// What the app writes for a match with these PINs
async function encrypted() {
  const data = { ...backup, match: { ...backup.match, gamePin: '123456', refereePin: '654321' } }
  const { text } = await createBackupSealer().seal(1, data, JSON.stringify(backup), '2026-10-29T19:00:00.000Z')
  return JSON.parse(text)
}

beforeAll(offline)
afterAll(online)
beforeEach(async () => {
  cleanup()
  vi.mocked(selectBackupFile).mockReset()
  vi.mocked(restoreMatchFromJson).mockReset()
  await Promise.all(db.tables.map(table => table.clear()))
})

const alerts = () => [...document.querySelectorAll('[role="alert"]')].map(n => n.textContent)
const pinField = () => document.querySelector('[data-testid="backup-unlock-dialog"] input')

async function pickFile() {
  mountApp()
  await waitFor(() => expect(button('Restore match')).toBeTruthy())
  fireEvent.click(button('Restore match'))
  await waitFor(() => expect(button(en.settings.backup.selectBackupFile)).toBeTruthy())
  fireEvent.click(button(en.settings.backup.selectBackupFile))
}

function typePin(pin) {
  fireEvent.change(pinField(), { target: { value: pin } })
  fireEvent.click(button(tu.open))
}

describe('App: restoring an encrypted backup file', () => {
  it('asks for a PIN; a wrong one says so, the right one opens the preview and restores, keeping that PIN', async () => {
    selectBackupFile.mockResolvedValue(await encrypted())
    restoreMatchFromJson.mockResolvedValue(null)
    await pickFile()
    await waitFor(() => expect(pinField()).toBeTruthy())
    const dialog = document.querySelector('[data-testid="backup-unlock-dialog"]')
    expect(dialog.textContent).toContain(tu.intro)
    // what the file shows in the clear: which match it is
    expect(dialog.textContent).toContain('Volley Home – Volley Away')
    expect(dialog.textContent).toContain('Game 1042')
    expect(dialog.textContent).toContain('25:20')
    expect(dialog.textContent).not.toContain('Muster')
    expect(button(en.settings.backup.preview.confirmRestore)).toBeFalsy()

    typePin('111111')
    await waitFor(() => expect(alerts()).toContain(tu.wrongPin))
    expect(pinField()).toBeTruthy() // still asking
    expect(button(en.settings.backup.preview.confirmRestore)).toBeFalsy()

    typePin('654321')
    await waitFor(() => expect(button(en.settings.backup.preview.confirmRestore)).toBeTruthy())
    expect(pinField()).toBeFalsy()
    expect(document.body.textContent).toContain('Volley Home')
    fireEvent.click(button(en.settings.backup.preview.confirmRestore))
    await waitFor(() => expect(restoreMatchFromJson).toHaveBeenCalledTimes(1))
    expect(restoreMatchFromJson.mock.calls[0][0]).toMatchObject({
      version: 1,
      match: { seed_key: 'match_1_x' },
      homePlayers: [{ lastName: 'Muster' }],
      unlockedWith: { pin: 'referee', field: 'refereePin', value: '654321' }
    })
  })

  it('Cancel goes back to the Restore dialog, nothing previewed or restored', async () => {
    selectBackupFile.mockResolvedValue(await encrypted())
    await pickFile()
    await waitFor(() => expect(pinField()).toBeTruthy())
    fireEvent.click(button(en.common.cancel))
    await waitFor(() => expect(pinField()).toBeFalsy())
    await waitFor(() => expect(button(en.settings.backup.selectBackupFile)).toBeTruthy())
    expect(button(en.settings.backup.preview.confirmRestore)).toBeFalsy()
    expect(restoreMatchFromJson).not.toHaveBeenCalled()
  })

  it('a plain (older) backup file is previewed at once, without a PIN', async () => {
    selectBackupFile.mockResolvedValue(structuredClone(backup))
    restoreMatchFromJson.mockResolvedValue(null)
    await pickFile()
    await waitFor(() => expect(button(en.settings.backup.preview.confirmRestore)).toBeTruthy())
    expect(pinField()).toBeFalsy()
    fireEvent.click(button(en.settings.backup.preview.confirmRestore))
    await waitFor(() => expect(restoreMatchFromJson).toHaveBeenCalledTimes(1))
    expect('unlockedWith' in restoreMatchFromJson.mock.calls[0][0]).toBe(false)
  })
})
