// Audit LOG-07 (round 3): a guest match (the Swiss "New match" signed out)
// keeps its every-action backup only in the keyed store, under its backup
// code (utils/globalCloud uploadGlobalBackup), and Match setup tells the
// scorer to keep the code and the referee PIN. The restore by code took only
// a Global match (globalRestoreData: match.global === true), so the stored
// backup could never be restored: a dead tablet lost the match. Now the code
// restores either kind as the kind it is, and the restored match stays local
// only (no sync job, never the league's server).
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const store = vi.hoisted(() => ({ files: new Map() }))
vi.mock('../backendConfig', async (orig) => ({ ...(await orig()), getCloudApiUrl: (p) => `https://api.test${p}` }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: vi.fn(() => { throw new Error('no network in this test') }),
  apiStorage: { from: vi.fn() },
  apiMatchRestoreByPin: vi.fn(),
  apiMatchScorer: vi.fn(async () => ({ data: null, error: { status: 0, network: true } })),
  writingDevice: () => ({ id: '00000000-0000-4000-8000-000000000001', platform: 'web' }),
  OV_PROTO: '2'
}))

import { db } from '../../db/db'
import { uploadGlobalBackup, loadGlobal, globalRestoreData } from '../globalCloud'
import { openWithKnownPins } from '../backupFile'
import { matchBackupFromFile, restoreMatchFromJson } from '../backupManager'
import { isLocalOnly, isGuestMatch, usesKeyStore } from '../../domain/matchKind'
import { eventHistorySettled } from '../../db/eventHistory'

const KEY = 'AbCdEfGhIjKlMnOpQrStUv'
const REFEREE_PIN = '482913'
const checks = { checkServer: async () => { throw new Error('a local-only match asks no server') }, cloudLiveState: async () => { throw new Error('no server') } }

// as App createKeyStoreMatch('guest') makes it, played into set 2
const keyStoreBackup = (kind) => ({
  version: 1,
  lastUpdated: '2026-11-23T10:00:00.000Z',
  match: {
    id: 4, status: 'live', test: false, [kind]: true, globalKey: KEY, refereePin: REFEREE_PIN,
    seedKey: 'test-match-default-a1b2c3d4e5f6', externalId: 'test-match-default', gameN: 7, gamePin: '135790'
  },
  homeTeam: { name: 'Synthetic Home' },
  awayTeam: { name: 'Synthetic Away' },
  homePlayers: [{ number: 5, firstName: 'A', lastName: 'B' }],
  awayPlayers: [{ number: 7, firstName: 'C', lastName: 'D' }],
  sets: [{ index: 1, homePoints: 25, awayPoints: 18, finished: true }, { index: 2, homePoints: 3, awayPoints: 1, finished: false }],
  events: [
    { seq: 1, type: 'coin_toss', setIndex: 1, payload: {}, ts: '2026-11-23T09:00:00.000Z' },
    { seq: 2, type: 'point', setIndex: 1, payload: { team: 'home' }, ts: '2026-11-23T09:01:00.000Z' },
    { seq: 3, type: 'point', setIndex: 2, payload: { team: 'away' }, ts: '2026-11-23T09:31:00.000Z' }
  ]
})

beforeEach(async () => {
  store.files.clear()
  await db.open()
  await Promise.all(db.tables.map(t => t.clear()))
  vi.stubGlobal('fetch', vi.fn(async (url, { body }) => {
    const req = JSON.parse(body)
    const id = `${req.key}/${req.kind}`
    if (url.endsWith('/api/global/save')) {
      store.files.set(id, Buffer.from(req.fileBase64, 'base64').toString('utf8'))
      return new Response(JSON.stringify({ data: { kind: req.kind }, error: null }), { status: 200 })
    }
    const text = store.files.get(id)
    return new Response(JSON.stringify(text == null
      ? { data: null, error: { code: 'OV_GLOBAL_NOT_FOUND' } }
      : { data: { fileBase64: Buffer.from(text).toString('base64'), contentType: 'application/json' }, error: null }), { status: 200 })
  }))
})
afterEach(() => vi.unstubAllGlobals())

// The Restore match dialog's "Find backup" (App restoreByCodeSection), step by step
async function restoreByCode(code, pin) {
  const text = await loadGlobal(code, 'backup')
  if (!text) return { error: 'notFound' }
  const unlocked = matchBackupFromFile(await openWithKnownPins(JSON.parse(text), [pin]))
  const data = globalRestoreData(unlocked)
  if (!data) return { error: 'notGlobal' }
  const id = await restoreMatchFromJson(data, checks)
  await eventHistorySettled()
  return { id }
}

describe('a guest match comes back from its online backup', () => {
  it('stored under its code, restored with the code and the referee PIN, still a local-only guest match', async () => {
    expect(await uploadGlobalBackup(keyStoreBackup('guest'), 4)).toBe(`global/${KEY}/backup`)
    const r = await restoreByCode(KEY, REFEREE_PIN)
    expect(r.error).toBeUndefined()
    const match = await db.matches.get(r.id)
    expect(match).toMatchObject({ guest: true, test: false, globalKey: KEY, status: 'live' })
    expect(match.global).not.toBe(true)
    expect(isGuestMatch(match)).toBe(true)
    expect(isLocalOnly(match)).toBe(true)
    expect(await db.sets.where('matchId').equals(r.id).count()).toBe(2)
    expect(await db.events.where('matchId').equals(r.id).count()).toBe(3)
    // never sent to the league's server: no restore job, no set or event job
    expect(await db.sync_queue.toArray()).toEqual([])
  }, 60000)

  it('a Global match stays a Global match', async () => {
    await uploadGlobalBackup(keyStoreBackup('global'), 4)
    const r = await restoreByCode(KEY, REFEREE_PIN)
    const match = await db.matches.get(r.id)
    expect(match).toMatchObject({ global: true, test: false, globalKey: KEY })
    expect(match.guest).not.toBe(true)
    expect(isLocalOnly(match)).toBe(true)
    expect(await db.sync_queue.toArray()).toEqual([])
  }, 60000)
})

describe('globalRestoreData keeps the kind of a key-store match', () => {
  it('a guest backup: guest, not Global, not practice', () => {
    const d = globalRestoreData({ match: { id: 1, guest: true, test: false, seedKey: 'x' }, sets: [] })
    expect(d.match).toMatchObject({ guest: true, test: false, seedKey: 'x' })
    expect(d.match.global).toBeUndefined()
    expect(usesKeyStore(d.match) && isLocalOnly(d.match) && isGuestMatch(d.match)).toBe(true)
  })
  it('still refuses an official or a practice match, and flags that are not true', () => {
    for (const d of [{ match: { test: false } }, { match: { test: true } }, { match: { guest: 'true' } }, { match: { guest: false, global: false } }]) {
      expect(globalRestoreData(d)).toBeNull()
    }
  })
})
