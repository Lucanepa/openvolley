import { describe, it, expect, vi } from 'vitest'
import { exportPdfToDocuments, exportToDocuments, moveLegacyFiles, MOVED_MARKER, PDF_SUBDIR, pruneScoresheetPdfs } from '../androidFiles'
import { BACKUP_SUBDIR } from '../platform'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const Directory = { Documents: 'DOCUMENTS', External: 'EXTERNAL', Data: 'DATA' }

// @capacitor/filesystem over a map: `${directory}:${path}` -> { data, mtime }
function fakeFs({ files = {}, permission = 'granted', unmovable = [] } = {}) {
  const store = new Map(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? { data: v, mtime: NOW } : v]))
  const dirs = new Set()
  const key = (directory, path) => `${directory}:${path}`
  const childrenOf = (directory, path) => {
    const prefix = `${key(directory, path)}/`
    const out = new Map()
    for (const k of [...store.keys(), ...dirs]) {
      if (!k.startsWith(prefix)) continue
      const [head, ...tail] = k.slice(prefix.length).split('/')
      if (!head) continue
      const isDir = tail.length > 0 || dirs.has(k)
      if (!out.has(head) || isDir) out.set(head, isDir ? 'directory' : 'file')
    }
    return out
  }
  const Filesystem = {
    checkPermissions: vi.fn(async () => ({ publicStorage: permission })),
    mkdir: vi.fn(async ({ path, directory }) => {
      const parts = path.split('/')
      for (let i = 1; i <= parts.length; i++) dirs.add(key(directory, parts.slice(0, i).join('/')))
    }),
    stat: vi.fn(async ({ path, directory }) => {
      if (store.has(key(directory, path))) return { type: 'file' }
      if (dirs.has(key(directory, path))) return { type: 'directory' }
      throw new Error('File does not exist')
    }),
    readdir: vi.fn(async ({ path, directory }) => {
      const children = childrenOf(directory, path)
      if (!children.size && !dirs.has(key(directory, path))) throw new Error('Folder does not exist')
      return {
        files: [...children].map(([name, type]) => ({
          name, type, mtime: type === 'file' ? store.get(key(directory, `${path}/${name}`)).mtime : 0
        }))
      }
    }),
    copy: vi.fn(async ({ from, to, directory, toDirectory }) => {
      if (unmovable.includes(key(directory, from))) throw new Error('EACCES')
      const file = store.get(key(directory, from))
      if (!file) throw new Error('missing')
      store.set(key(toDirectory, to), { ...file })
    }),
    deleteFile: vi.fn(async ({ path, directory }) => {
      if (!store.delete(key(directory, path))) throw new Error('missing')
    }),
    rmdir: vi.fn(async ({ path, directory }) => {
      if (childrenOf(directory, path).size) throw new Error('Folder is not empty')
      dirs.delete(key(directory, path))
    })
  }
  return { fs: { Filesystem, Directory }, store }
}

const memoryStorage = () => {
  const m = new Map()
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }
}
const quiet = { info: vi.fn(), warn: vi.fn() }
const keys = (store, prefix) => [...store.keys()].filter(k => k.startsWith(prefix)).sort()

describe('the first start of this version: files older versions left in Documents move into the app', () => {
  it('moves every backup and PDF from Documents (and the old external fallback), and leaves Documents empty', async () => {
    const { fs, store } = fakeFs({
      files: {
        [`DOCUMENTS:${BACKUP_SUBDIR}/game7-s1/20261101T100000.000Z-00003.json`]: 'e3',
        [`DOCUMENTS:${BACKUP_SUBDIR}/game7-s1/latest.json`]: 'l7',
        [`DOCUMENTS:${PDF_SUBDIR}/7_Home_Away.pdf`]: 'pdf7',
        [`EXTERNAL:${BACKUP_SUBDIR}/game8-s2/latest.json`]: 'l8'
      }
    })
    const storage = memoryStorage()
    expect(await moveLegacyFiles(fs, { storage, log: quiet })).toEqual({ moved: 4, left: 0 })
    expect(keys(store, 'DOCUMENTS:')).toEqual([])
    expect(keys(store, 'EXTERNAL:')).toEqual([])
    expect(store.get(`DATA:${BACKUP_SUBDIR}/game7-s1/20261101T100000.000Z-00003.json`).data).toBe('e3')
    expect(store.get(`DATA:${BACKUP_SUBDIR}/game7-s1/latest.json`).data).toBe('l7')
    expect(store.get(`DATA:${BACKUP_SUBDIR}/game8-s2/latest.json`).data).toBe('l8')
    expect(store.get(`DATA:${PDF_SUBDIR}/7_Home_Away.pdf`).data).toBe('pdf7')
    // once per install
    expect(storage.getItem(MOVED_MARKER)).toBe('1')
    store.set(`DOCUMENTS:${BACKUP_SUBDIR}/game9-s3/latest.json`, { data: 'l9', mtime: NOW })
    expect(await moveLegacyFiles(fs, { storage, log: quiet })).toMatchObject({ skipped: true })
    expect(store.has(`DOCUMENTS:${BACKUP_SUBDIR}/game9-s3/latest.json`)).toBe(true)
  })

  it('keeps the app\'s own newer latest.json and a PDF of the same name; a file it may not move stays, logged', async () => {
    const { fs, store } = fakeFs({
      files: {
        [`DOCUMENTS:${BACKUP_SUBDIR}/game7-s1/latest.json`]: 'old',
        [`DATA:${BACKUP_SUBDIR}/game7-s1/latest.json`]: 'new',
        [`DOCUMENTS:${PDF_SUBDIR}/a.pdf`]: 'documents a',
        [`DATA:${PDF_SUBDIR}/a.pdf`]: 'app a',
        [`DOCUMENTS:${BACKUP_SUBDIR}/game1-x/latest.json`]: 'from an earlier install'
      },
      unmovable: [`DOCUMENTS:${BACKUP_SUBDIR}/game1-x/latest.json`]
    })
    const log = { info: vi.fn(), warn: vi.fn() }
    expect(await moveLegacyFiles(fs, { storage: memoryStorage(), log })).toEqual({ moved: 1, left: 1 })
    expect(store.get(`DATA:${BACKUP_SUBDIR}/game7-s1/latest.json`).data).toBe('new')
    expect(store.has(`DOCUMENTS:${BACKUP_SUBDIR}/game7-s1/latest.json`)).toBe(false)
    expect(store.get(`DATA:${PDF_SUBDIR}/a.pdf`).data).toBe('app a')
    expect(store.get(`DATA:${PDF_SUBDIR}/a (1).pdf`).data).toBe('documents a')
    expect(store.has(`DOCUMENTS:${BACKUP_SUBDIR}/game1-x/latest.json`)).toBe(true)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('game1-x'), 'EACCES')
  })

  it('Android 10 and older without the storage permission: Documents is not touched (a start never asks)', async () => {
    const { fs, store } = fakeFs({ permission: 'prompt', files: { [`DOCUMENTS:${BACKUP_SUBDIR}/g/latest.json`]: 'x' } })
    await moveLegacyFiles(fs, { storage: memoryStorage(), log: quiet })
    expect(store.has(`DOCUMENTS:${BACKUP_SUBDIR}/g/latest.json`)).toBe(true)
    expect(fs.Filesystem.readdir.mock.calls.map(([o]) => o.directory)).not.toContain('DOCUMENTS')
  })
})

describe('saved scoresheet PDFs follow the backups\' 30 days', () => {
  it('deletes the PDFs older than 30 days in the app folder, at start', async () => {
    const { fs, store } = fakeFs({
      files: {
        [`DATA:${PDF_SUBDIR}/old.pdf`]: { data: 'o', mtime: NOW - 31 * DAY },
        [`DATA:${PDF_SUBDIR}/recent.pdf`]: { data: 'r', mtime: NOW - 29 * DAY },
        [`DOCUMENTS:${PDF_SUBDIR}/exported.pdf`]: { data: 'e', mtime: NOW - 90 * DAY }
      }
    })
    expect(await pruneScoresheetPdfs(fs, { now: NOW, log: quiet })).toBe(1)
    expect(keys(store, `DATA:${PDF_SUBDIR}`)).toEqual([`DATA:${PDF_SUBDIR}/recent.pdf`])
    // a copy exported to Documents is the user's
    expect(store.has(`DOCUMENTS:${PDF_SUBDIR}/exported.pdf`)).toBe(true)
  })
})

describe('Export to Documents', () => {
  it('copies each match\'s newest backup and every PDF to a new Documents/OpenVolley/export-<time> folder', async () => {
    const { fs, store } = fakeFs({
      files: {
        [`DATA:${BACKUP_SUBDIR}/game7-s1/20261113T100000.000Z-00009.json`]: 'e9',
        [`DATA:${BACKUP_SUBDIR}/game7-s1/latest.json`]: 'l7',
        [`DATA:${BACKUP_SUBDIR}/game8-s2/20261113T110000.000Z-00001.json`]: 'no latest',
        [`DATA:${PDF_SUBDIR}/7_Home_Away.pdf`]: 'pdf7'
      }
    })
    const at = new Date(NOW)
    const result = await exportToDocuments(fs, { now: at, log: quiet })
    expect(result).toEqual({ folder: 'Documents/OpenVolley/export-20261113-1200', backups: 1, scoresheets: 1, failed: 0 })
    expect(keys(store, 'DOCUMENTS:')).toEqual([
      'DOCUMENTS:OpenVolley/export-20261113-1200/backups/game7-s1.json',
      'DOCUMENTS:OpenVolley/export-20261113-1200/scoresheets/7_Home_Away.pdf'
    ])
    expect(store.get('DOCUMENTS:OpenVolley/export-20261113-1200/backups/game7-s1.json').data).toBe('l7')
    // the app's own files stay where they are
    expect(store.has(`DATA:${BACKUP_SUBDIR}/game7-s1/latest.json`)).toBe(true)
    // the same minute again: a new folder, the first export is kept
    expect((await exportToDocuments(fs, { now: at, log: quiet })).folder).toBe('Documents/OpenVolley/export-20261113-1200 (1)')
  })

  it('one PDF from the PDF view, under a free name', async () => {
    const { fs, store } = fakeFs({ files: { [`DATA:${PDF_SUBDIR}/a.pdf`]: 'a', [`DOCUMENTS:${PDF_SUBDIR}/a.pdf`]: 'earlier copy' } })
    expect(await exportPdfToDocuments(fs, 'a.pdf')).toBe(`Documents/${PDF_SUBDIR}/a (1).pdf`)
    expect(store.get(`DOCUMENTS:${PDF_SUBDIR}/a (1).pdf`).data).toBe('a')
    expect(store.get(`DOCUMENTS:${PDF_SUBDIR}/a.pdf`).data).toBe('earlier copy')
    await expect(exportPdfToDocuments(fs, 'gone.pdf')).rejects.toThrow(/no longer/)
  })
})
