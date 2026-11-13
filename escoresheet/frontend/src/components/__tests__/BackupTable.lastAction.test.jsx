import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

// One t for every render, as react-i18next's
const t = vi.hoisted(() => (key, opts) => (opts?.count != null ? `${key} ${opts.count}` : key))
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
vi.mock('../../utils/backupManager', () => ({ fetchCloudBackup: (path) => download(path) }))

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
    expect(screen.getByText('live')).toBeInTheDocument()
    expect(loadBackup).toHaveBeenCalledTimes(2)
    // no "show more" when every file is read
    expect(screen.queryByRole('button', { name: /showMoreLastActions/ })).toBeNull()
  })
})
