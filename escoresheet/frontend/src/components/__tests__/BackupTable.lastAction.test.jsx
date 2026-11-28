import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

// One t for every render, as react-i18next's; lang.prefix stands for the
// language the texts come in
const lang = vi.hoisted(() => ({ prefix: '' }))
const t = vi.hoisted(() => (key, opts) => lang.prefix + (opts?.count != null ? `${key} ${opts.count}` : key))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))

// Every whole-file download the list starts, however it reaches the bucket
const downloads = vi.hoisted(() => ({ calls: [], inFlight: 0, most: 0, release: [] }))
const download = vi.hoisted(() => (path) => {
  downloads.calls.push(path)
  downloads.inFlight++
  downloads.most = Math.max(downloads.most, downloads.inFlight)
  return new Promise(resolve => {
    downloads.release.push(() => {
      downloads.inFlight--
      resolve({ version: 1, match: {}, events: [{ seq: 1, type: 'timeout' }] })
    })
  })
})
vi.mock('../../utils/logger', () => ({ loadCloudBackup: (path) => download(path) }))
// A test may answer with the PINs the list passes (cloud.fetch)
const cloud = vi.hoisted(() => ({ fetch: null }))
vi.mock('../../utils/backupManager', () => ({ fetchCloudBackup: (path, opts) => (cloud.fetch ? cloud.fetch(path, opts) : download(path)) }))

import BackupTable, { LAST_ACTION_MORE, LAST_ACTION_NEWEST } from '../BackupTable'

// 40 cloud snapshots a minute apart (the list holds up to 100)
const backups = Array.from({ length: 40 }, (_, i) => {
  const minute = String(i).padStart(2, '0')
  return {
    name: `backup_g7_set2_scoreleft${i}_scoreright3_20261113_19${minute}00_000.json`,
    path: `backups/backup_g7/backup_g7_set2_scoreleft${i}_scoreright3_20261113_19${minute}00_000.json`,
    gameN: 7, setIndex: 2, leftScore: i, rightScore: 3, date: '20261113', time: `19${minute}00`, ms: '000', source: 'cloud'
  }
})

async function settle() {
  // answer the downloads one by one, as they come
  for (let i = 0; i < 20 && downloads.release.length; i++) {
    await act(async () => { downloads.release.shift()() })
  }
}

beforeEach(() => {
  downloads.calls = []
  downloads.inFlight = 0
  downloads.most = 0
  downloads.release = []
  cloud.fetch = null
  lang.prefix = ''
})

describe('restore list: "Last action"', () => {
  it('reads only the newest backups, one at a time, and the older ones on a tap', async () => {
    render(<BackupTable backups={backups} onBackupSelect={() => {}} />)
    await waitFor(() => expect(downloads.calls.length).toBeGreaterThan(0))
    await settle()
    expect(downloads.calls).toHaveLength(LAST_ACTION_NEWEST)
    expect(downloads.most).toBe(1)
    // the newest first (19:39, 19:38, 19:37)
    expect(downloads.calls[0]).toContain('_193900_')
    expect(downloads.calls[2]).toContain('_193700_')
    expect(screen.getAllByText('backupTable.eventTypes.timeout')).toHaveLength(LAST_ACTION_NEWEST)

    fireEvent.click(screen.getByRole('button', { name: `backupTable.showMoreLastActions ${LAST_ACTION_MORE}` }))
    await waitFor(() => expect(downloads.calls.length).toBeGreaterThan(LAST_ACTION_NEWEST))
    await settle()
    expect(downloads.calls).toHaveLength(LAST_ACTION_NEWEST + LAST_ACTION_MORE)
    expect(new Set(downloads.calls).size).toBe(downloads.calls.length)
    expect(downloads.most).toBe(1)
  })

  it('an encrypted copy no PIN opens says so; the cloud match row needs no download', async () => {
    const loadBackup = vi.fn(async (path) => (path.endsWith('_193900_000.json')
      ? { format: 'openvolley-encrypted-backup', formatVersion: 2, readable: {} }
      : { version: 1, events: [] }))
    render(<BackupTable backups={[...backups.slice(38), { name: 'database_g7', source: 'database', gameN: 7, status: 'live', updated_at: '2026-11-13T19:45:00Z' }]} loadBackup={loadBackup} onBackupSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('backupTable.locked')).toBeInTheDocument())
    expect(screen.getByText('backupTable.noActions')).toBeInTheDocument()
    expect(screen.getByText('backupTable.status.live')).toBeInTheDocument()
    expect(loadBackup).toHaveBeenCalledTimes(2)
    // no "show more" when every file is read
    expect(screen.queryByRole('button', { name: /showMoreLastActions/ })).toBeNull()
  })

  // Home restore list: the game PIN field stays editable under the list. A
  // wrong PIN corrected after the list loaded left every row at "—"
  it('reads the newest rows again when the PINs change', async () => {
    const asked = []
    cloud.fetch = async (path, { pins } = {}) => {
      asked.push([path, pins])
      return pins?.includes('123456')
        ? { version: 1, events: [{ seq: 1, type: 'timeout' }] }
        : { format: 'openvolley-encrypted-backup', formatVersion: 2, readable: {} }
    }
    const two = backups.slice(38)
    const { rerender } = render(<BackupTable backups={two} unlockPins={['111111']} onBackupSelect={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('backupTable.locked')).toHaveLength(2))
    rerender(<BackupTable backups={two} unlockPins={['123456']} onBackupSelect={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('backupTable.eventTypes.timeout')).toHaveLength(2))
    expect(asked).toHaveLength(4)
    expect(asked.slice(2).every(([, pins]) => pins.join() === '123456')).toBe(true)
  })

  // 28.11.2026: "Point", "Set end" stayed English in de/fr/it: the text was
  // made when the file was read, in the language of that moment
  it('the last action and the cloud match\'s status follow the language shown now', async () => {
    const loadBackup = vi.fn(async () => ({ version: 1, events: [{ seq: 1, type: 'point' }, { seq: 2, type: 'set_end' }] }))
    const rows = [backups[39], { name: 'database_g7', source: 'database', gameN: 7, status: 'ended', updated_at: '2026-11-13T19:45:00Z' }]
    const { rerender } = render(<BackupTable backups={rows} loadBackup={loadBackup} onBackupSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('backupTable.eventTypes.setEnd')).toBeInTheDocument())
    expect(screen.getByText('backupTable.status.ended')).toBeInTheDocument()
    lang.prefix = 'de:'
    rerender(<BackupTable backups={rows} loadBackup={loadBackup} onBackupSelect={() => {}} />)
    expect(screen.getByText('de:backupTable.eventTypes.setEnd')).toBeInTheDocument()
    expect(screen.getByText('de:backupTable.status.ended')).toBeInTheDocument()
    // not read again for it
    expect(loadBackup).toHaveBeenCalledTimes(1)
  })
})

// 28.11.2026: a best-of-3 decider (the tie-break slot, set 5 in the file
// names) showed as set 5; the scoring screen says set 3
describe('restore list: the set column', () => {
  const file = (setIndex, minute) => ({
    name: `backup_g7_set${setIndex}_home8_away6_20261113_19${minute}00_000.json`,
    path: `backups/backup_g7/backup_g7_set${setIndex}_home8_away6_20261113_19${minute}00_000.json`,
    gameN: 7, setIndex, homeScore: 8, awayScore: 6, date: '20261113', time: `19${minute}00`, ms: '000', source: 'cloud'
  })
  const setCells = (container) => [...container.querySelectorAll('button > span:nth-child(2)')].map(el => el.textContent)

  it('a best-of-3 decider reads set 3, best of 5 keeps set 5', () => {
    const loadBackup = async () => null
    const three = render(<BackupTable backups={[file(5, '10'), file(2, '05')].map(b => ({ ...b, bestOf: 3 }))} loadBackup={loadBackup} onBackupSelect={() => {}} />)
    expect(setCells(three.container)).toEqual(['3', '2'])
    three.unmount()
    const five = render(<BackupTable backups={[file(5, '10'), file(4, '05')].map(b => ({ ...b, bestOf: 5 }))} loadBackup={loadBackup} onBackupSelect={() => {}} />)
    expect(setCells(five.container)).toEqual(['5', '4'])
  })

  it('without the list\'s best of, the read file\'s match says it', async () => {
    const loadBackup = vi.fn(async () => ({ version: 1, match: { bestOf: 3 }, events: [{ seq: 1, type: 'point' }] }))
    const { container } = render(<BackupTable backups={[file(5, '10')]} loadBackup={loadBackup} onBackupSelect={() => {}} />)
    await waitFor(() => expect(screen.getByText('backupTable.eventTypes.point')).toBeInTheDocument())
    expect(setCells(container)).toEqual(['3'])
  })
})
