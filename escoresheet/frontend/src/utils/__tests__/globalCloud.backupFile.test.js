import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The Global store (backend lib/globalStore.js) as a map of key/kind -> body
const store = vi.hoisted(() => ({ files: new Map() }))
vi.mock('../backendConfig', async (orig) => ({ ...(await orig()), getCloudApiUrl: (p) => `https://api.test${p}` }))

import { uploadGlobalBackup, uploadGlobalFinal, loadGlobal } from '../globalCloud'
import { openWithKnownPins } from '../backupFile'
import { isEncryptedBackup } from '../backupCrypto/envelope'

const KEY = 'AbCdEfGhIjKlMnOpQrStUv'
const SECRETS = ['654321', '333333', 'sess-77', '2011-03-04', 'SIGNATURE-PNG', 'Kid']

function backup(match = {}) {
  return {
    version: 1,
    lastUpdated: '2026-11-14T18:00:00.000Z',
    match: {
      id: 9, status: 'live', test: true, global: true, globalKey: KEY,
      refereePin: '654321', homeTeamPin: '333333', sessionId: 'sess-77',
      homeCaptainSignature: 'data:image/png;base64,SIGNATURE-PNG',
      ...match
    },
    homeTeam: { name: 'North' },
    awayTeam: { name: 'South' },
    homePlayers: [{ number: 5, firstName: 'Kid', lastName: 'Player', dob: '2011-03-04' }],
    awayPlayers: [],
    sets: [{ index: 1, homePoints: 10, awayPoints: 8 }],
    events: [{ seq: 1, type: 'point' }]
  }
}

beforeEach(() => {
  store.files.clear()
  localStorage.clear()
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

describe('the Global store copy is an app backup file (utils/backupFile)', () => {
  it('every-minute backup: no PIN, session id, birth date, name or signature in the clear; the referee PIN opens it', async () => {
    expect(await uploadGlobalBackup(backup(), 9)).toBe(`global/${KEY}/backup`)
    const body = store.files.get(`${KEY}/backup`)
    for (const secret of SECRETS) expect(body).not.toContain(secret)
    const file = JSON.parse(await loadGlobal(KEY, 'backup'))
    expect(isEncryptedBackup(file)).toBe(true)
    const opened = await openWithKnownPins(file, ['654321'])
    expect(opened.homePlayers[0].dob).toBe('2011-03-04')
    expect(opened.match.global).toBe(true)
    expect(opened.match.globalKey).toBe(KEY)
    expect(opened.match.refereePin).toBeUndefined()
    // the connection PINs ride inside the encryption, for a restore on another device
    expect(opened.connectionPins).toMatchObject({ referee: '654321', bench_home: '333333' })
  }, 60000)

  it('the closed match: the final backup sealed the same way, the PDF as it is', async () => {
    const pdfBlob = new Blob(['%PDF-1.4 x'], { type: 'application/pdf' })
    const r = await uploadGlobalFinal({ match: backup().match, matchId: 9, pdfBlob, backupData: backup() }, { retries: 0 })
    expect(r.ok).toBe(true)
    expect(store.files.get(`${KEY}/scoresheet-final`)).toBe('%PDF-1.4 x')
    const body = store.files.get(`${KEY}/backup`)
    for (const secret of SECRETS) expect(body).not.toContain(secret)
    expect(isEncryptedBackup(JSON.parse(body))).toBe(true)
  }, 60000)

  it('a match without a PIN stays plain, still without its secrets', async () => {
    await uploadGlobalBackup(backup({ refereePin: null }), 9)
    const file = JSON.parse(store.files.get(`${KEY}/backup`))
    expect(isEncryptedBackup(file)).toBe(false)
    expect(file.secretsRemoved).toBe(true)
    expect(store.files.get(`${KEY}/backup`)).not.toContain('333333')
    expect(store.files.get(`${KEY}/backup`)).not.toContain('sess-77')
  }, 60000)

  it('not a Global match: nothing sent', async () => {
    expect(await uploadGlobalBackup(backup({ global: false }), 9)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
})
