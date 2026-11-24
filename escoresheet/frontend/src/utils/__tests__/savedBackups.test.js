import { describe, it, expect } from 'vitest'
import { describeBackup, listDeviceBackups, listDriveBackups, listFolderBackups } from '../savedBackups'

const plain = (home, away, gameN) => JSON.stringify({ match: { gameN, scheduledAt: '2026-11-14T18:00' }, homeTeam: { name: home }, awayTeam: { name: away }, sets: [], events: [] })

describe('saved backups', () => {
  it('describes a plain file and an encrypted envelope by their clear parts', () => {
    expect(describeBackup(JSON.parse(plain('A', 'B', 12))).title).toBe('#12  A – B')
    const env = { format: 'openvolley-encrypted-backup', readable: { gameN: 5, homeTeam: 'X', awayTeam: 'Y', scheduledAt: 's' } }
    expect(describeBackup(env)).toEqual({ title: '#5  X – Y', sub: 's' })
    expect(describeBackup(null, 'dir').title).toBe('dir')
  })

  it('lists this device newest first, read() gives the parsed file', async () => {
    const store = {
      list: async () => [
        { dir: 'game1-a', files: [{ name: 'latest.json', modifiedMs: 100 }, { name: 'e1.json', modifiedMs: 99 }] },
        { dir: 'game2-b', files: [{ name: 'latest.json', modifiedMs: 200 }] },
        { dir: 'game3-c', files: [{ name: 'e.json', modifiedMs: 300 }] }
      ],
      read: async (dir) => plain(dir, 'Z', dir === 'game1-a' ? 1 : 2)
    }
    const out = await listDeviceBackups(store)
    expect(out.map(e => e.key)).toEqual(['device:game2-b', 'device:game1-a'])
    expect(out[0].title).toBe('#2  game2-b – Z')
    expect((await out[1].read()).match.gameN).toBe(1)
  })

  it('lists every stick latest file with the clear header, ignores event files', async () => {
    const platform = {
      list: async () => [{ id: 's1', label: 'KINGSTON' }],
      listBackups: async () => [{ dir: 'game7-x', files: [
        { name: 'abcd1234-latest.json', modifiedMs: 5, header: { encrypted: true, readable: { gameN: 7, homeTeam: 'H', awayTeam: 'A' } } },
        { name: 'abcd1234-manual-2026.json', modifiedMs: 9 }
      ] }],
      read: async () => plain('H', 'A', 7)
    }
    const out = await listDriveBackups(platform)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ source: 'drive', where: 'KINGSTON', title: '#7  H – A', encrypted: true })
    expect((await out[0].read()).match.gameN).toBe(7)
  })

  it('lists a browser folder newest first', async () => {
    const fh = (name, t, text) => ({ kind: 'file', name, getFile: async () => ({ lastModified: t, text: async () => text }) })
    const handle = { name: 'USB', async *values() { yield fh('a.json', 1, plain('A', 'B', 1)); yield fh('b.json', 2, plain('C', 'D', 2)); yield fh('x.txt', 3, '') } }
    const out = await listFolderBackups(handle)
    expect(out.map(e => e.title)).toEqual(['#2  C – D', '#1  A – B'])
    expect(out[0].where).toBe('USB')
  })

  it('nothing listed without a store, platform or folder', async () => {
    expect(await listDeviceBackups(null)).toEqual([])
    expect(await listDriveBackups(null)).toEqual([])
    expect(await listFolderBackups(null)).toEqual([])
  })
})
