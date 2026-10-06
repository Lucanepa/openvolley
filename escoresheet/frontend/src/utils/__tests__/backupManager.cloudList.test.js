import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/db', () => ({ db: {} }))
vi.mock('../backendConfig', () => ({ getApiUrl: (p) => `http://backend.test${p}`, getCloudApiUrl: (p) => `http://backend.test${p}` }))

const storage = vi.hoisted(() => ({ listArgs: null, result: null }))
vi.mock('../../lib/apiClient', () => ({
  apiFrom: vi.fn(),
  apiStorage: {
    from: () => ({
      list: async (path, options) => {
        storage.listArgs = { path, options }
        return storage.result
      }
    })
  }
}))

import { listCloudBackups } from '../backupManager'

describe('listCloudBackups', () => {
  beforeEach(() => {
    storage.listArgs = null
  })

  it('lists the given game folder newest first with an explicit page size', async () => {
    storage.result = {
      data: [
        // name order would put scoreleft9 before scoreleft25
        { name: 'backup_g7_set1_scoreleft9_scoreright3_20260105_101500_000.json', created_at: '2026-01-05T10:15:00Z' },
        { name: 'backup_g7_set1_scoreleft25_scoreright20_20260105_103000_500.json', created_at: '2026-01-05T10:30:00Z' },
        { name: 'backup_g7_set2_scoreleft1_scoreright0_20260105_103100_000.json', created_at: '2026-01-05T10:31:00Z' },
        { name: 'notes.txt' }
      ],
      error: null
    }

    const backups = await listCloudBackups(null, 7)

    expect(storage.listArgs.path).toBe('backups/backup_g7')
    expect(storage.listArgs.options.limit).toBe(100)
    expect(storage.listArgs.options.sortBy).toEqual({ column: 'created_at', order: 'desc' })
    expect(backups.map(b => `${b.setIndex}:${b.leftScore}`)).toEqual(['2:1', '1:25', '1:9'])
    expect(backups[0].path).toBe('backups/backup_g7/backup_g7_set2_scoreleft1_scoreright0_20260105_103100_000.json')
    expect(backups[0].created_at).toBe('2026-01-05T10:31:00Z')
  })

  it('throws on error so the caller can show it', async () => {
    storage.result = { data: null, error: { message: 'Storage list failed', status: 503 } }
    await expect(listCloudBackups(null, 1)).rejects.toMatchObject({ status: 503 })
  })
})
