import { describe, it, expect, vi, beforeEach } from 'vitest'

// The cloud bucket: what goes up, and what a restore downloads back
const bucket = vi.hoisted(() => ({ files: new Map() }))
vi.mock('../../lib/apiClient', async (orig) => {
  const real = await orig()
  return {
    ...real,
    apiStorage: {
      from: () => ({
        upload: async (path, body) => {
          bucket.files.set(path, body)
          return { data: { path }, error: null }
        },
        download: async (path) => (bucket.files.has(path)
          ? { data: new Blob([bucket.files.get(path)]), error: null }
          : { data: null, error: { code: 'OV_STORAGE_NOT_FOUND' } })
      })
    }
  }
})

import { AUTH_TOKEN_STORAGE_KEY } from '../../lib/apiClient'
import { uploadBackupToCloud } from '../logger'
import { fetchCloudBackup } from '../backupManager'
import { backupFileText, openWithKnownPins } from '../backupFile'
import { isEncryptedBackup } from '../backupCrypto/envelope'

const SECRETS = ['123456', '654321', '333333', '444444', 'sess-77', '2011-03-04', 'SIGNATURE-PNG', 'Kid']

function backup(match = {}) {
  return {
    version: 1,
    lastUpdated: '2026-11-13T18:00:00.000Z',
    match: {
      id: 9, gameN: 3141, seed_key: 'match_9_z', status: 'live',
      gamePin: '123456', refereePin: '654321', homeTeamPin: '333333', awayTeamUploadPin: '444444', sessionId: 'sess-77',
      homeCaptainSignature: 'data:image/png;base64,SIGNATURE-PNG',
      ...match
    },
    homeTeam: { name: 'North' },
    awayTeam: { name: 'South' },
    homePlayers: [{ number: 5, firstName: 'Kid', lastName: 'Player', dob: '2011-03-04' }],
    awayPlayers: [],
    sets: [{ index: 2, homePoints: 10, awayPoints: 8 }],
    events: [{ seq: 1, type: 'point' }]
  }
}

beforeEach(() => {
  bucket.files.clear()
  localStorage.clear()
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, JSON.stringify({ access_token: 't', expires_at: Date.now() / 1000 + 3600, user: { id: 'u1' } }))
})

describe('the cloud copy (set end, match end, every minute)', () => {
  it('is the app backup file: no PIN, session id, birth date, name or signature in the clear', async () => {
    const path = await uploadBackupToCloud(9, backup())
    expect(path).toMatch(/^backups\/backup_g3141\/backup_g3141_set2_scoreleft10_scoreright8_\d{8}_\d{6}_\d{3}\.json$/)
    const body = bucket.files.get(path)
    for (const secret of SECRETS) expect(body).not.toContain(secret)
    expect(isEncryptedBackup(JSON.parse(body))).toBe(true)
  }, 60000)

  it('a restore that knows the game PIN gets the backup inside, without the PINs; a wrong PIN leaves it for the PIN dialog', async () => {
    const path = await uploadBackupToCloud(9, backup())
    const opened = await fetchCloudBackup(path, { pins: ['123456'] })
    expect(opened.homePlayers[0].dob).toBe('2011-03-04')
    expect(opened.secretsRemoved).toBe(true)
    expect(opened.unlockedWith).toEqual({ pin: 'game', field: 'gamePin', value: '123456' })
    for (const f of ['gamePin', 'refereePin', 'homeTeamPin', 'awayTeamUploadPin', 'sessionId']) expect(opened.match[f]).toBeUndefined()
    // ... but its connection PINs, inside the encryption, for a restore on
    // another device (never the game PIN or the session id)
    expect(opened.connectionPins).toEqual({ referee: '654321', bench_home: '333333', upload_away: '444444' })
    expect(isEncryptedBackup(await fetchCloudBackup(path, { pins: ['000000'] }))).toBe(true)
    expect(isEncryptedBackup(await fetchCloudBackup(path))).toBe(true)
  }, 60000)

  it('a test match has no PIN to open it with: plain, as the app backup files', async () => {
    const path = await uploadBackupToCloud(10, backup({ test: true, gamePin: null, refereePin: null }))
    const file = JSON.parse(bucket.files.get(path))
    expect(isEncryptedBackup(file)).toBe(false)
    expect(file.secretsRemoved).toBe(true)
    expect(file.match.homeTeamPin).toBeUndefined()
    expect(file.connectionPins).toBeUndefined()
    expect(bucket.files.get(path)).not.toContain('333333')
    expect(await fetchCloudBackup(path, { pins: ['123456'] })).toEqual(file)
  })

  it('an older plain cloud copy comes back as it is', async () => {
    bucket.files.set('backups/backup_g1/old.json', JSON.stringify({ version: 1, match: { gameN: 1, gamePin: '111111' }, sets: [], events: [] }))
    expect(await fetchCloudBackup('backups/backup_g1/old.json', { pins: ['111111'] })).toMatchObject({ match: { gamePin: '111111' } })
  })
})

describe('the set-end download', () => {
  it('writes the app backup file, not the match row with its PINs', async () => {
    const text = await backupFileText(9, backup())
    for (const secret of SECRETS) expect(text).not.toContain(secret)
    const opened = await openWithKnownPins(JSON.parse(text), ['', null, '654321'])
    expect(opened.unlockedWith.field).toBe('refereePin')
    expect(opened.homePlayers[0].firstName).toBe('Kid')
    expect(opened.connectionPins).toBeUndefined()
  }, 60000)
})
