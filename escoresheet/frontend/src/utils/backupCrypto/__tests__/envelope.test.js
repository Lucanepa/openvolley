import { describe, it, expect, vi } from 'vitest'
import { argon2id } from 'hash-wasm'
import { argon2idOptions } from '../argon2'
import { BACKUP_DAMAGED, BACKUP_NEWER, BACKUP_WRONG_PIN, fromBase64, isEncryptedBackup, openEnvelope, readableHeader, toBase64 } from '../envelope'
import { backupPins, createBackupSealer } from '../sealer'
import { checkKdfParams, derivePinKey, KDF_PARAMS } from '../kdf'

// The real Argon2id, at the app's parameters, counted (sealer: once per match and PIN)
const countingDerive = () => vi.fn((pin, salt, params) => derivePinKey(pin, salt, params))

function backup(overrides = {}) {
  return {
    version: 1,
    lastUpdated: '2026-10-29T18:00:00.000Z',
    match: { id: 1, gameN: 1042, seed_key: 'match_1_x', status: 'live', scheduledAt: '2026-10-29T18:00:00.000Z', gamePin: '123456', refereePin: '654321', hall: 'Saalsporthalle', officials: [{ role: 'r1', firstName: 'Rita', lastName: 'Ref' }], ...overrides },
    homeTeam: { name: 'Volley Home' },
    awayTeam: { name: 'Volley Away' },
    homePlayers: [{ number: 7, firstName: 'Anna', lastName: 'Muster', dob: '2004-05-06' }],
    awayPlayers: [],
    sets: [{ index: 2, homePoints: 3, awayPoints: 1 }, { index: 1, homePoints: 25, awayPoints: 20, finished: true }],
    events: [{ seq: 1, type: 'point', payload: { team: 'home' } }]
  }
}
// the file's own JSON: the backup without its PINs (nativeBackup/redact)
const plainOf = (data) => {
  const { gamePin, refereePin, ...match } = data.match
  return JSON.stringify({ ...data, match, secretsRemoved: true })
}

async function sealed(data = backup(), sealer = createBackupSealer()) {
  const { text, encrypted } = await sealer.seal(1, data, plainOf(data), '2026-10-29T18:42:00.000Z')
  return { text, encrypted, envelope: JSON.parse(text) }
}

describe('encrypted backup file', () => {
  it('round trip: the game PIN and the referee PIN each open it', async () => {
    const data = backup()
    const { envelope, encrypted } = await sealed(data)
    expect(encrypted).toBe(true)
    expect(isEncryptedBackup(envelope)).toBe(true)

    const byGame = await openEnvelope(envelope, '123456')
    expect(byGame.data).toEqual(JSON.parse(plainOf(data)))
    expect(byGame.unlockedWith).toEqual({ pin: 'game', field: 'gamePin', value: '123456' })

    const byReferee = await openEnvelope(envelope, ' 654321 ')
    expect(byReferee.data).toEqual(byGame.data)
    expect(byReferee.unlockedWith).toEqual({ pin: 'referee', field: 'refereePin', value: '654321' })
  })

  it('a wrong PIN (or none) fails cleanly, and the right one still opens it after', async () => {
    const { envelope } = await sealed()
    await expect(openEnvelope(envelope, '000000')).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
    await expect(openEnvelope(envelope, '')).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
    await expect(openEnvelope(envelope, '123456')).resolves.toMatchObject({ unlockedWith: { pin: 'game' } })
  })

  it('tampered ciphertext, a tampered readable header or a cut file fail as damaged', async () => {
    const { envelope } = await sealed()
    const bytes = fromBase64(envelope.ciphertext)
    bytes[10] ^= 1
    await expect(openEnvelope({ ...envelope, ciphertext: toBase64(bytes) }, '123456')).rejects.toMatchObject({ code: BACKUP_DAMAGED })
    const edited = { ...envelope, readable: { ...envelope.readable, sets: [{ index: 1, home: 25, away: 0 }] } }
    await expect(openEnvelope(edited, '123456')).rejects.toMatchObject({ code: BACKUP_DAMAGED })
    await expect(openEnvelope({ ...envelope, ciphertext: envelope.ciphertext.slice(0, 40) }, '654321')).rejects.toMatchObject({ code: BACKUP_DAMAGED })
    // a damaged slot is a slot that no PIN opens
    const slots = envelope.slots.map(s => ({ ...s, wrappedKey: toBase64(fromBase64(s.wrappedKey).map((b, i) => (i === 0 ? b ^ 1 : b))) }))
    await expect(openEnvelope({ ...envelope, slots }, '123456')).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
  })

  it('a file of a newer format says so instead of "wrong PIN"', async () => {
    const { envelope } = await sealed()
    await expect(openEnvelope({ ...envelope, formatVersion: 2 }, '123456')).rejects.toMatchObject({ code: BACKUP_NEWER })
  })

  it('the readable header holds only the game number, teams, scheduled date, set scores and lastUpdated', async () => {
    const { text, envelope } = await sealed()
    expect(Object.keys(envelope).sort()).toEqual(['about', 'cipher', 'ciphertext', 'format', 'formatVersion', 'readable', 'slots'])
    expect(envelope.readable).toEqual({
      gameN: 1042,
      homeTeam: 'Volley Home',
      awayTeam: 'Volley Away',
      scheduledAt: '2026-10-29T18:00:00.000Z',
      sets: [{ index: 1, home: 25, away: 20 }, { index: 2, home: 3, away: 1 }],
      lastUpdated: '2026-10-29T18:42:00.000Z'
    })
    // names, birth dates, officials, the hall, the events and the PINs: not in the clear
    for (const secret of ['Anna', 'Muster', '2004-05-06', 'Rita', 'Saalsporthalle', 'point', 'seed_key', 'match_1_x', '123456', '654321']) {
      expect(text).not.toContain(secret)
    }
    // the slots: one per PIN, its own salt, the KDF as written
    expect(envelope.slots.map(s => [s.kind, s.pin])).toEqual([['pin', 'game'], ['pin', 'referee']])
    expect(envelope.slots[0].kdf.salt).not.toBe(envelope.slots[1].kdf.salt)
    expect(envelope.slots[0].kdf).toMatchObject({ alg: 'argon2id', memoryKiB: 32768, iterations: 3, parallelism: 1 })
  })

  it('an envelope is not mistaken for a plain backup by an older app (no version, match, sets or events at the top)', async () => {
    const { envelope } = await sealed()
    for (const k of ['version', 'match', 'matches', 'sets', 'events']) expect(k in envelope).toBe(false)
  })

  it('the file contains neither PIN, not even inside the ciphertext', async () => {
    const { envelope } = await sealed()
    const { data } = await openEnvelope(envelope, '123456')
    expect(JSON.stringify(data)).not.toMatch(/123456|654321/)
    expect(data.secretsRemoved).toBe(true)
  })

  it('slot kinds this app does not know (a later recovery slot) are skipped', async () => {
    const { envelope } = await sealed()
    const withRecovery = { ...envelope, slots: [{ kind: 'recovery', keyId: 'server-2027', wrappedKey: 'AAAA' }, ...envelope.slots] }
    await expect(openEnvelope(withRecovery, '654321')).resolves.toMatchObject({ unlockedWith: { pin: 'referee' } })
  })

  it('a slot asking for an absurd KDF cost is ignored, never run', async () => {
    const { envelope } = await sealed()
    const derive = vi.fn(derivePinKey)
    const greedy = { ...envelope, slots: envelope.slots.map(s => ({ ...s, kdf: { ...s.kdf, memoryKiB: 8 * 1024 * 1024 } })) }
    await expect(openEnvelope(greedy, '123456', { derive })).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
    expect(derive).not.toHaveBeenCalled()
    expect(() => checkKdfParams({ ...KDF_PARAMS, iterations: 1000 })).toThrow(/out of range/)
  })
})

describe('the session sealer', () => {
  it('derives each PIN once per match across many files; every file has its own IV', async () => {
    const derive = countingDerive()
    const sealer = createBackupSealer({ derive })
    const data = backup()
    const ivs = new Set()
    const slotsSeen = new Set()
    for (let i = 0; i < 8; i++) {
      data.events.push({ seq: i + 2, type: 'point', payload: { team: 'away' } })
      const { text } = await sealer.seal(1, data, plainOf(data), new Date(Date.UTC(2026, 9, 29, 18, 0, i)).toISOString())
      const env = JSON.parse(text)
      ivs.add(env.cipher.iv)
      slotsSeen.add(JSON.stringify(env.slots))
    }
    expect(derive).toHaveBeenCalledTimes(2) // the game PIN and the referee PIN, once each
    expect(ivs.size).toBe(8)
    expect(slotsSeen.size).toBe(1) // one data key for the match this session

    // another match: its own keys (own salts)
    await sealer.seal(2, backup({ id: 2 }), plainOf(backup()), '2026-10-29T19:00:00.000Z')
    expect(derive).toHaveBeenCalledTimes(4)
  })

  it('a changed PIN: only that PIN is derived again, the new files have a new data key and do not open with the old PIN', async () => {
    const derive = countingDerive()
    const sealer = createBackupSealer({ derive })
    const data = backup()
    const before = JSON.parse((await sealer.seal(1, data, plainOf(data), '2026-10-29T18:00:00.000Z')).text)
    data.match.refereePin = '111222'
    const after = JSON.parse((await sealer.seal(1, data, plainOf(data), '2026-10-29T18:00:01.000Z')).text)
    expect(derive).toHaveBeenCalledTimes(3)
    expect(after.slots[0].wrappedKey).not.toBe(before.slots[0].wrappedKey)
    expect(after.slots[0].kdf.salt).toBe(before.slots[0].kdf.salt) // the game PIN's key is kept
    await expect(openEnvelope(after, '654321')).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
    await expect(openEnvelope(after, '111222')).resolves.toMatchObject({ unlockedWith: { pin: 'referee' } })
    await expect(openEnvelope(before, '654321')).resolves.toBeTruthy()
  })

  it('a match with no game PIN and no referee PIN is written plain, as before', async () => {
    const derive = countingDerive()
    const sealer = createBackupSealer({ derive })
    const data = backup({ gamePin: null, refereePin: '' })
    const plain = plainOf(data)
    expect(await sealer.seal(1, data, plain, 'x')).toEqual({ text: plain, encrypted: false })
    expect(derive).not.toHaveBeenCalled()
  })

  it('one PIN is enough: a match with only a referee PIN gets one slot', async () => {
    const { envelope } = await sealed(backup({ gamePin: undefined }))
    expect(envelope.slots.map(s => s.pin)).toEqual(['referee'])
    await expect(openEnvelope(envelope, '654321')).resolves.toBeTruthy()
  })

  it('a failing derivation fails the file (never a plain one) and is retried at the next', async () => {
    const derive = vi.fn().mockRejectedValueOnce(new Error('out of memory')).mockImplementation(derivePinKey)
    const sealer = createBackupSealer({ derive })
    const data = backup({ refereePin: null })
    await expect(sealer.seal(1, data, plainOf(data), 'x')).rejects.toThrow('out of memory')
    const { encrypted } = await sealer.seal(1, data, plainOf(data), 'y')
    expect(encrypted).toBe(true)
  })

  it('backupPins reads the local and the cloud spellings', () => {
    expect(backupPins({ game_pin: 123456, connection_pins: { referee: '222222' } })).toEqual([{ pin: 'game', value: '123456' }, { pin: 'referee', value: '222222' }])
    expect(backupPins({ test: true })).toEqual([])
  })
})

describe('the KDF', () => {
  it('is Argon2id: the key matches hash-wasm run directly with the same parameters', async () => {
    const salt = new Uint8Array(16).fill(7)
    const key = await derivePinKey('123456', salt)
    expect(key).toHaveLength(32)
    expect([...key]).toEqual([...await argon2id(argon2idOptions('123456', salt, KDF_PARAMS))])
  })
})

describe('readableHeader', () => {
  it('reads the cloud spellings and empty backups', () => {
    expect(readableHeader({ match: { game_n: '12', scheduled_at: '2026-11-01' }, sets: [{ index: 1, home_points: 2, away_points: 3 }] }, 't')).toEqual({
      gameN: '12', homeTeam: null, awayTeam: null, scheduledAt: '2026-11-01', sets: [{ index: 1, home: 2, away: 3 }], lastUpdated: 't'
    })
    expect(readableHeader(null)).toMatchObject({ gameN: null, sets: [] })
  })
})
