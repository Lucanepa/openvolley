// Audit LOG-07 (round 3): the restore by backup code was in the Global tool
// only, and guest matches (the Swiss "New match" signed out) exist only in
// the Swiss tool. Signed out, the Swiss tool's Restore match now has the
// backup code field: code + referee PIN bring the guest match back as a
// guest match on this device.
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { waitFor, fireEvent, cleanup } from '@testing-library/react'
vi.mock('../utils/parseRosterPdf', () => ({ parseRosterPdf: vi.fn() })) // pdf.js worker import
import { db } from '../db/db'
import en from '../i18n/locales/en.json'
import { offline, online, mountApp, button } from './appMount'
import { uploadGlobalBackup } from '../utils/globalCloud'
import { isGuestMatch, isLocalOnly } from '../domain/matchKind'
import { createBackupSealer } from '../utils/backupCrypto/sealer'

const KEY = 'AbCdEfGhIjKlMnOpQrStUv'
const REFEREE_PIN = '482913'
const store = new Map()

const guestBackup = () => ({
  version: 1,
  lastUpdated: '2026-11-23T10:00:00.000Z',
  match: {
    id: 4, status: 'live', test: false, guest: true, globalKey: KEY, refereePin: REFEREE_PIN,
    seedKey: 'test-match-default-a1b2c3d4e5f6', externalId: 'test-match-default', gameN: 7
  },
  homeTeam: { name: 'Guest Home' },
  awayTeam: { name: 'Guest Away' },
  homePlayers: [{ number: 5, firstName: 'A', lastName: 'B' }],
  awayPlayers: [],
  sets: [{ index: 1, homePoints: 25, awayPoints: 18, finished: true }, { index: 2, homePoints: 3, awayPoints: 1, finished: false }],
  events: [{ seq: 1, type: 'point', setIndex: 1, payload: { team: 'home' }, ts: '2026-11-23T09:01:00.000Z' }]
})

// the keyed store (backend lib/globalStore.js) behind /api/global/save|load; everything else offline
function keyedStore() {
  globalThis.fetch.mockImplementation(async (url, init) => {
    const path = String(url)
    if (!/\/api\/global\/(save|load)$/.test(path)) throw new TypeError('offline (test)')
    const req = JSON.parse(init.body)
    const id = `${req.key}/${req.kind}`
    if (path.endsWith('/save')) {
      store.set(id, Buffer.from(req.fileBase64, 'base64').toString('utf8'))
      return new Response(JSON.stringify({ data: { kind: req.kind }, error: null }), { status: 200 })
    }
    const text = store.get(id)
    return new Response(JSON.stringify(text == null
      ? { data: null, error: { code: 'OV_GLOBAL_NOT_FOUND' } }
      : { data: { fileBase64: Buffer.from(text).toString('base64'), contentType: 'application/json' }, error: null }), { status: 200 })
  })
}

beforeAll(offline)
afterAll(online)
beforeEach(async () => {
  cleanup()
  store.clear()
  await Promise.all(db.tables.map(table => table.clear()))
  localStorage.removeItem('api_auth_token')
  localStorage.setItem('ov-tool-mode', 'swiss')
  keyedStore()
})

describe('App: the Swiss tool restores a guest match by its backup code', () => {
  it('signed out: code field in Restore match, the referee PIN opens it, a local-only guest match again', async () => {
    // the dead tablet's last every-action backup
    expect(await uploadGlobalBackup(guestBackup(), 4)).toBe(`global/${KEY}/backup`)

    mountApp()
    await waitFor(() => expect(button('Restore match')).toBeTruthy(), { timeout: 10000 })
    fireEvent.click(button('Restore match'))
    await waitFor(() => expect(document.querySelector('[data-testid="restore-global"]')).toBeTruthy())
    expect(document.querySelector('[data-testid="restore-global"]').textContent).toContain(en.restoreGlobal.titleCode)

    fireEvent.change(document.querySelector('[data-testid="restore-global-code"]'), { target: { value: KEY } })
    fireEvent.click(document.querySelector('[data-testid="restore-global-button"]'))
    const pinField = () => document.querySelector('[data-testid="backup-unlock-dialog"] input')
    await waitFor(() => expect(pinField()).toBeTruthy())
    fireEvent.change(pinField(), { target: { value: REFEREE_PIN } })
    fireEvent.click(button(en.settings.backup.unlock.open))
    await waitFor(() => expect(button(en.settings.backup.preview.confirmRestore)).toBeTruthy())
    expect(document.body.textContent).not.toContain(en.restoreGlobal.notGlobal)
    fireEvent.click(button(en.settings.backup.preview.confirmRestore))

    await waitFor(async () => expect(await db.matches.count()).toBe(1), { timeout: 10000 })
    const match = await db.matches.toCollection().first()
    expect(match).toMatchObject({ guest: true, test: false, globalKey: KEY })
    expect(isGuestMatch(match) && isLocalOnly(match)).toBe(true)
    expect(await db.sets.where('matchId').equals(match.id).count()).toBe(2)
    // never a job for the league's server
    expect((await db.sync_queue.toArray()).filter(j => ['match', 'set', 'event'].includes(j.resource))).toEqual([])
  }, 40000)

  it('a code that holds an official match is refused under the field, naming both kinds; nothing restored', async () => {
    const official = { ...guestBackup(), match: { seed_key: 'match_1_official', status: 'live', gameN: 1042, test: false, refereePin: REFEREE_PIN } }
    const { text } = await createBackupSealer().seal(1, official, JSON.stringify({ ...official, match: { ...official.match, refereePin: undefined } }), '2026-11-23T10:00:00.000Z')
    store.set(`${KEY}/backup`, text)

    mountApp()
    await waitFor(() => expect(button('Restore match')).toBeTruthy(), { timeout: 10000 })
    fireEvent.click(button('Restore match'))
    await waitFor(() => expect(document.querySelector('[data-testid="restore-global"]')).toBeTruthy())
    fireEvent.change(document.querySelector('[data-testid="restore-global-code"]'), { target: { value: KEY } })
    fireEvent.click(document.querySelector('[data-testid="restore-global-button"]'))
    const pinField = () => document.querySelector('[data-testid="backup-unlock-dialog"] input')
    await waitFor(() => expect(pinField()).toBeTruthy())
    fireEvent.change(pinField(), { target: { value: REFEREE_PIN } })
    fireEvent.click(button(en.settings.backup.unlock.open))
    await waitFor(() => expect(document.querySelector('[data-testid="restore-global"]').textContent).toContain(en.restoreGlobal.notGlobal))
    expect(en.restoreGlobal.notGlobal).toMatch(/Global match/)
    expect(en.restoreGlobal.notGlobal).toMatch(/without an account/)
    expect(button(en.settings.backup.preview.confirmRestore)).toBeFalsy()
    expect(await db.matches.count()).toBe(0)
  }, 40000)
})
