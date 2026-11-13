import { describe, it, expect, vi } from 'vitest'
import { argon2id } from 'hash-wasm'
import { argon2idOptions } from '../argon2'
import { BACKUP_DAMAGED, BACKUP_WRONG_PIN, ENVELOPE_FORMAT, fromBase64, openEnvelope, openEnvelopeWithRecoveryKey, randomBytes, readableHeader, toBase64 } from '../envelope'
import { createBackupSealer } from '../sealer'
import { checkKdfParams, derivePinKey, KDF_PARAMS } from '../kdf'
import { BUILT_IN_RECOVERY_KEY, configuredRecoveryKey, generateRecoveryKeyPair, importRecoveryPrivateKey, importRecoveryPublicKey } from '../recovery'
import { openBackupText } from '../../../../scripts/backup-recovery.mjs'

// Cheap Argon2id for the round trips (the app's own cost is tested in envelope.test.js)
const FAST = { alg: 'argon2id', memoryKiB: 8192, iterations: 1, parallelism: 1 }

function backup(overrides = {}) {
  return {
    version: 1,
    match: { id: 1, gameN: 2077, seed_key: 'match_2_y', status: 'live', gamePin: '123456', refereePin: '654321', ...overrides },
    homeTeam: { name: 'Lakeside' },
    awayTeam: { name: 'Hillview' },
    homePlayers: [{ number: 4, firstName: 'Mia', lastName: 'Example', dob: '2010-02-03' }],
    awayPlayers: [],
    sets: [{ index: 1, homePoints: 12, awayPoints: 9 }],
    events: [{ seq: 1, type: 'point', payload: { team: 'home' } }]
  }
}
const plainOf = (data) => {
  const { gamePin, refereePin, ...match } = data.match
  return JSON.stringify({ ...data, match, secretsRemoved: true })
}
async function sealedWith(options = {}, data = backup()) {
  const sealer = createBackupSealer({ params: FAST, recoveryKey: '', ...options })
  const { text } = await sealer.seal(1, data, plainOf(data), '2026-11-13T18:00:00.000Z')
  return JSON.parse(text)
}

describe('the recovery slot (the strong key beside the PINs)', () => {
  it('a build with a recovery key wraps every data key for it: the private half opens the file without any PIN', async () => {
    const pair = await generateRecoveryKeyPair()
    const envelope = await sealedWith({ recoveryKey: pair.publicKey })
    expect(envelope.slots.map(s => s.kind)).toEqual(['pin', 'pin', 'recovery'])
    const slot = envelope.slots[2]
    expect(slot).toMatchObject({ kind: 'recovery', key: pair.id })
    expect(Object.keys(slot).sort()).toEqual(['alg', 'epk', 'iv', 'key', 'kind', 'wrappedKey'])

    const opened = await openEnvelopeWithRecoveryKey(envelope, await importRecoveryPrivateKey(pair.privateKey))
    expect(opened.data).toEqual(JSON.parse(plainOf(backup())))
    expect(opened.unlockedWith).toEqual({ recovery: pair.id })
    // the PINs still open it as before
    await expect(openEnvelope(envelope, '123456')).resolves.toMatchObject({ unlockedWith: { pin: 'game' } })
  })

  it('another key opens nothing; a file without a recovery slot says so', async () => {
    const pair = await generateRecoveryKeyPair()
    const other = await generateRecoveryKeyPair()
    const envelope = await sealedWith({ recoveryKey: pair.publicKey })
    await expect(openEnvelopeWithRecoveryKey(envelope, await importRecoveryPrivateKey(other.privateKey))).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
    const pinOnly = await sealedWith()
    expect(pinOnly.slots.map(s => s.kind)).toEqual(['pin', 'pin'])
    await expect(openEnvelopeWithRecoveryKey(pinOnly, await importRecoveryPrivateKey(pair.privateKey))).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
  })

  it('each match gets its own one-off key; the files of one match share their slots', async () => {
    const pair = await generateRecoveryKeyPair()
    const sealer = createBackupSealer({ params: FAST, recoveryKey: pair.publicKey })
    const data = backup()
    const a = JSON.parse((await sealer.seal(1, data, plainOf(data), 't1')).text)
    const b = JSON.parse((await sealer.seal(1, data, plainOf(data), 't2')).text)
    const c = JSON.parse((await sealer.seal(2, data, plainOf(data), 't3')).text)
    expect(b.slots[2]).toEqual(a.slots[2])
    expect(c.slots[2].epk).not.toBe(a.slots[2].epk)
  })

  it('a recovery key that does not import leaves the PIN slots (backups never stop over it)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const envelope = await sealedWith({ recoveryKey: btoa('not a key') })
    expect(envelope.slots.map(s => s.kind)).toEqual(['pin', 'pin'])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('recovery key'), expect.anything())
    error.mockRestore()
  })

  it('a recovery slot edited to another key id or one-off key no longer opens', async () => {
    const pair = await generateRecoveryKeyPair()
    const key = await importRecoveryPrivateKey(pair.privateKey)
    const envelope = await sealedWith({ recoveryKey: pair.publicKey })
    const otherEpk = (await sealedWith({ recoveryKey: pair.publicKey })).slots[2].epk
    const edited = { ...envelope, slots: envelope.slots.map(s => (s.kind === 'recovery' ? { ...s, epk: otherEpk } : s)) }
    await expect(openEnvelopeWithRecoveryKey(edited, key)).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
  })

  it('the recovery tool (scripts/backup-recovery.mjs) opens a file the app wrote', async () => {
    const pair = await generateRecoveryKeyPair()
    const envelope = await sealedWith({ recoveryKey: pair.publicKey })
    const text = await openBackupText(JSON.stringify(envelope), `${pair.privateKey}\n`)
    expect(JSON.parse(text).homePlayers[0].dob).toBe('2010-02-03')
    expect(text).not.toMatch(/123456|654321/)
  })

  it('the build\'s own recovery key, when one is set, is a P-256 public key', async () => {
    for (const key of [BUILT_IN_RECOVERY_KEY, configuredRecoveryKey()].filter(Boolean)) {
      await expect(importRecoveryPublicKey(key)).resolves.toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{16}$/) })
    }
  })
})

describe('authenticated slots (envelope version 2)', () => {
  it('swapped slot labels: the game PIN is never taken for the referee PIN', async () => {
    const envelope = await sealedWith()
    const [game, referee] = envelope.slots
    const swapped = { ...envelope, slots: [{ ...game, pin: 'referee' }, { ...referee, pin: 'game' }] }
    await expect(openEnvelope(swapped, '123456')).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
    await expect(openEnvelope(swapped, '654321')).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
  })

  it('a slot\'s KDF parameters or salt edited: that slot no longer opens', async () => {
    const envelope = await sealedWith()
    // the same key comes out (the extra field is not a KDF input), but the slot is bound to what it said
    const padded = { ...envelope, slots: envelope.slots.map(s => ({ ...s, kdf: { ...s.kdf, note: 'x' } })) }
    await expect(openEnvelope(padded, '123456')).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
  })

  it('a slot taken out or added: the file is damaged', async () => {
    const envelope = await sealedWith()
    await expect(openEnvelope({ ...envelope, slots: [envelope.slots[0]] }, '123456')).rejects.toMatchObject({ code: BACKUP_DAMAGED })
    const extra = { ...envelope, slots: [...envelope.slots, { kind: 'later', note: 'unknown kind' }] }
    await expect(openEnvelope(extra, '654321')).rejects.toMatchObject({ code: BACKUP_DAMAGED })
  })

  it('a file asking for far more than the app\'s KDF cost is never derived', async () => {
    const envelope = await sealedWith()
    const derive = vi.fn(derivePinKey)
    const greedy = { ...envelope, slots: envelope.slots.map(s => ({ ...s, kdf: { ...s.kdf, memoryKiB: 131072, iterations: 16 } })) }
    await expect(openEnvelope(greedy, '123456', { derive })).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
    expect(derive).not.toHaveBeenCalled()
    // twice the app's cost is the most a slot may ask for
    expect(checkKdfParams({ ...KDF_PARAMS, iterations: 6 })).toMatchObject({ iterations: 6 })
    expect(checkKdfParams({ ...KDF_PARAMS, memoryKiB: 65536 })).toMatchObject({ memoryKiB: 65536 })
    expect(() => checkKdfParams({ ...KDF_PARAMS, memoryKiB: 65536, iterations: 4 })).toThrow(/out of range/)
    expect(() => checkKdfParams({ ...KDF_PARAMS, memoryKiB: 131072 })).toThrow(/out of range/)
  })
})

// A file 3.0.9 to 3.1.x wrote: version 1, the readable header as the only
// additional data, wraps without additional data
async function versionOneFile(data = backup()) {
  const s = globalThis.crypto.subtle
  const dataKey = await s.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const slots = []
  for (const [pin, value] of [['game', '123456'], ['referee', '654321']]) {
    const salt = randomBytes(16)
    const raw = await argon2id(argon2idOptions(value, salt, FAST))
    const kek = await s.importKey('raw', raw, { name: 'AES-GCM' }, false, ['wrapKey'])
    const iv = randomBytes(12)
    const wrapped = await s.wrapKey('raw', dataKey, kek, { name: 'AES-GCM', iv })
    slots.push({ kind: 'pin', pin, kdf: { ...FAST, salt: toBase64(salt) }, iv: toBase64(iv), wrappedKey: toBase64(new Uint8Array(wrapped)) })
  }
  const readable = readableHeader(data, '2026-10-30T10:00:00.000Z')
  const iv = randomBytes(12)
  const additionalData = new TextEncoder().encode(JSON.stringify({ format: ENVELOPE_FORMAT, formatVersion: 1, readable }))
  const ciphertext = await s.encrypt({ name: 'AES-GCM', iv, additionalData }, dataKey, new TextEncoder().encode(plainOf(data)))
  return { format: ENVELOPE_FORMAT, formatVersion: 1, about: 'x', readable, cipher: { alg: 'AES-256-GCM', iv: toBase64(iv) }, slots, ciphertext: toBase64(new Uint8Array(ciphertext)) }
}

describe('version 1 files (written before) still open', () => {
  it('with the game PIN and with the referee PIN', async () => {
    const v1 = await versionOneFile()
    await expect(openEnvelope(v1, '123456')).resolves.toMatchObject({ unlockedWith: { field: 'gamePin' }, data: { secretsRemoved: true } })
    await expect(openEnvelope(v1, '654321')).resolves.toMatchObject({ unlockedWith: { field: 'refereePin' } })
    await expect(openEnvelope(v1, '000000')).rejects.toMatchObject({ code: BACKUP_WRONG_PIN })
    const bytes = fromBase64(v1.ciphertext)
    bytes[3] ^= 1
    await expect(openEnvelope({ ...v1, ciphertext: toBase64(bytes) }, '123456')).rejects.toMatchObject({ code: BACKUP_DAMAGED })
  })

  it('new files are version 2', async () => {
    expect((await sealedWith()).formatVersion).toBe(2)
  })
})
