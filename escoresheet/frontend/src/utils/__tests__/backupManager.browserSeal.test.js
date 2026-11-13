import { describe, it, expect } from 'vitest'
import { backupFileText } from '../backupManager'
import { isEncryptedBackup, openEnvelope } from '../backupCrypto/envelope'

const data = (match) => ({ match, homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, homePlayers: [{ name: 'Secret Player' }], sets: [], events: [] })

describe('browser backup files (folder, download)', () => {
  it('a match with PINs is encrypted: no PIN or player in the clear, the game PIN and the referee PIN open it', async () => {
    const text = await backupFileText(11, data({ gameN: 3, seed_key: 's', gamePin: '123456', refereePin: '654321' }))
    expect(text).not.toContain('123456')
    expect(text).not.toContain('Secret Player')
    const env = JSON.parse(text)
    expect(isEncryptedBackup(env)).toBe(true)
    expect(env.readable).toMatchObject({ gameN: 3, homeTeam: 'A', awayTeam: 'B' })
    const byGame = await openEnvelope(env, '123456')
    expect(byGame.data.homePlayers[0].name).toBe('Secret Player')
    expect(byGame.data.secretsRemoved).toBe(true)
    expect(byGame.data.match.gamePin).toBeUndefined()
    expect((await openEnvelope(env, '654321')).unlockedWith.field).toBe('refereePin')
  }, 60000)

  it('a test match has no PIN to open it with: plain', async () => {
    const text = await backupFileText(12, data({ gameN: 1, test: true }))
    expect(isEncryptedBackup(JSON.parse(text))).toBe(false)
  })
})
