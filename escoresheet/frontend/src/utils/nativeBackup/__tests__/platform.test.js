import { describe, it, expect, vi } from 'vitest'
import { detectBackupPlatform, isNativeBackupPlatform, createTauriStore, createCapacitorStore, BACKUP_SUBDIR } from '../platform'

describe('detectBackupPlatform', () => {
  it('recognises the desktop app, the Android app and plain browsers', () => {
    expect(detectBackupPlatform({ __TAURI_INTERNALS__: { invoke: () => {} } })).toBe('tauri')
    expect(detectBackupPlatform({ Capacitor: { isNativePlatform: () => true } })).toBe('capacitor')
    expect(detectBackupPlatform({ Capacitor: { isNativePlatform: () => false } })).toBe('web')
    expect(detectBackupPlatform({})).toBe('web')
    expect(detectBackupPlatform(undefined)).toBe('web')
    expect(detectBackupPlatform({ Capacitor: { isNativePlatform: () => { throw new Error('bridge') } } })).toBe('web')
  })

  it('treats only the apps as native', () => {
    expect(isNativeBackupPlatform('tauri')).toBe(true)
    expect(isNativeBackupPlatform('capacitor')).toBe(true)
    expect(isNativeBackupPlatform('web')).toBe(false)
  })
})

describe('createTauriStore', () => {
  it('maps every operation to the backup_* commands', async () => {
    const invoke = vi.fn(async (cmd) => {
      if (cmd === 'backup_info') return { dir: '/home/u/.local/share/OpenVolley/backups' }
      if (cmd === 'backup_list') return [{ dir: 'game1-x', files: [{ name: 'latest.json', size: 3, modifiedMs: 1 }] }]
      if (cmd === 'backup_pick_file') return '{"version":1,"match":{}}'
      return null
    })
    const store = createTauriStore(invoke)

    expect(await store.info()).toEqual({ folder: '/home/u/.local/share/OpenVolley/backups' })
    await store.info()
    expect(invoke.mock.calls.filter(c => c[0] === 'backup_info')).toHaveLength(1) // cached

    expect(await store.write('game1-x', 'a.json', '{}', { latest: true })).toEqual({})
    expect(invoke).toHaveBeenCalledWith('backup_write', { matchDir: 'game1-x', fileName: 'a.json', contents: '{}', latest: true })

    expect(await store.list()).toEqual([{ dir: 'game1-x', files: [{ name: 'latest.json', size: 3 }] }])

    await store.remove('game1-x', [])
    expect(invoke.mock.calls.some(c => c[0] === 'backup_remove')).toBe(false)
    await store.remove('game1-x', ['a.json'])
    expect(invoke).toHaveBeenCalledWith('backup_remove', { matchDir: 'game1-x', fileNames: ['a.json'] })

    expect(await store.openFolder()).toBe(true)
    expect(invoke).toHaveBeenCalledWith('backup_open_dir')
    expect(await store.pickFile()).toEqual({ version: 1, match: {} })
  })

  it('passes on the warning when only latest.json could not be replaced', async () => {
    const store = createTauriStore(async () => 'cannot write latest.json: in use')
    expect(await store.write('game1-x', 'a.json', '{}')).toEqual({ warning: 'cannot write latest.json: in use' })
  })

  it('returns null when the file dialog is cancelled', async () => {
    const store = createTauriStore(async () => null)
    expect(await store.pickFile()).toBeNull()
  })
})

function fakeFilesystem({ refuse = [] } = {}) {
  const files = new Map() // `${directory}:${path}` -> text
  const dirs = new Set()
  const Directory = { Documents: 'DOCUMENTS', External: 'EXTERNAL', Data: 'DATA' }
  const Filesystem = {
    mkdir: vi.fn(async ({ path, directory }) => {
      if (refuse.includes(directory)) throw new Error('Permission denied')
      dirs.add(`${directory}:${path}`)
    }),
    stat: vi.fn(async ({ path, directory }) => {
      if (!dirs.has(`${directory}:${path}`)) throw new Error('missing')
      return { type: 'directory' }
    }),
    getUri: vi.fn(async ({ path, directory }) => ({ uri: `file:///storage/emulated/0/${directory}/${path}` })),
    writeFile: vi.fn(async ({ path, data, directory }) => {
      files.set(`${directory}:${path}`, data)
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) dirs.add(`${directory}:${parts.slice(0, i).join('/')}`)
    }),
    readdir: vi.fn(async ({ path, directory }) => {
      const prefix = `${directory}:${path}/`
      const children = new Map()
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const [head, ...tail] = rest.split('/')
        if (!head) continue
        const isDir = tail.length > 0 || dirs.has(key)
        if (!children.has(head) || isDir) children.set(head, isDir ? 'directory' : 'file')
      }
      return { files: [...children].map(([name, type]) => ({ name, type, size: type === 'file' ? files.get(prefix + name).length : 0 })) }
    }),
    copy: vi.fn(async ({ from, to, directory, toDirectory }) => {
      const key = `${directory}:${from}`
      if (!files.has(key)) throw new Error('missing')
      files.set(`${toDirectory ?? directory}:${to}`, files.get(key))
    }),
    deleteFile: vi.fn(async ({ path, directory }) => { files.delete(`${directory}:${path}`) })
  }
  return { Filesystem, Directory, Encoding: { UTF8: 'utf8' }, files }
}

describe('createCapacitorStore', () => {
  it('writes the event file and latest.json under Documents/OpenVolley/backups', async () => {
    const fs = fakeFilesystem()
    const store = createCapacitorStore(fs, { log: { warn: () => {} } })
    await store.write('game5-s', '20261006T100000.000Z-00001.json', '{"v":1}')
    expect(fs.files.get(`DOCUMENTS:${BACKUP_SUBDIR}/game5-s/20261006T100000.000Z-00001.json`)).toBe('{"v":1}')
    expect(fs.files.get(`DOCUMENTS:${BACKUP_SUBDIR}/game5-s/latest.json`)).toBe('{"v":1}')
    expect(fs.Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({ encoding: 'utf8', recursive: true }))
    // the match JSON crosses the bridge once: latest.json is a native copy
    expect(fs.Filesystem.writeFile).toHaveBeenCalledTimes(1)
    expect(fs.Filesystem.copy).toHaveBeenCalledWith({
      from: `${BACKUP_SUBDIR}/game5-s/20261006T100000.000Z-00001.json`,
      to: `${BACKUP_SUBDIR}/game5-s/latest.json`,
      directory: 'DOCUMENTS',
      toDirectory: 'DOCUMENTS'
    })
    expect(await store.info()).toEqual({ folder: `/storage/emulated/0/DOCUMENTS/${BACKUP_SUBDIR}` })
    expect(store.canOpenFolder).toBe(false)
  })

  it('keeps the event file when latest.json cannot be overwritten (left by a previous install)', async () => {
    const fs = fakeFilesystem()
    const warn = vi.fn()
    const store = createCapacitorStore(fs, { log: { warn } })
    fs.Filesystem.copy.mockRejectedValue(new Error('EACCES'))
    const result = await store.write('game5-s', 'a.json', '{}')
    expect(result.warning).toMatch(/latest\.json.*EACCES/)
    expect(fs.files.has(`DOCUMENTS:${BACKUP_SUBDIR}/game5-s/a.json`)).toBe(true)
  })

  it('writes latest.json itself when the plugin has no copy', async () => {
    const fs = fakeFilesystem()
    delete fs.Filesystem.copy
    const store = createCapacitorStore(fs, { log: { warn: () => {} } })
    await store.write('game5-s', 'a.json', '{"v":2}')
    expect(fs.files.get(`DOCUMENTS:${BACKUP_SUBDIR}/game5-s/latest.json`)).toBe('{"v":2}')
  })

  it('falls back to the app folder when Documents is refused', async () => {
    const fs = fakeFilesystem({ refuse: ['DOCUMENTS'] })
    const store = createCapacitorStore(fs, { log: { warn: () => {} } })
    await store.write('game5-s', 'a.json', '{}', { latest: false })
    expect(fs.files.has(`EXTERNAL:${BACKUP_SUBDIR}/game5-s/a.json`)).toBe(true)
    expect(fs.files.has(`EXTERNAL:${BACKUP_SUBDIR}/game5-s/latest.json`)).toBe(false)
    expect((await store.info()).folder).toContain('EXTERNAL')
  })

  it('lists match folders and deletes files, tolerating failures', async () => {
    const fs = fakeFilesystem()
    const warn = vi.fn()
    const store = createCapacitorStore(fs, { log: { warn } })
    await store.write('game1-a', 'x.json', '{}')
    await store.write('game2-b', 'y.json', '{}')
    const listed = await store.list()
    expect(listed.map(d => d.dir).sort()).toEqual(['game1-a', 'game2-b'])
    expect(listed.find(d => d.dir === 'game1-a').files.map(f => f.name).sort()).toEqual(['latest.json', 'x.json'])
    expect(listed.find(d => d.dir === 'game1-a').files.every(f => f.size === 2)).toBe(true)

    fs.Filesystem.deleteFile.mockRejectedValueOnce(new Error('EACCES'))
    await store.remove('game1-a', ['x.json', 'latest.json'])
    expect(warn).toHaveBeenCalled()
    expect(fs.files.has(`DOCUMENTS:${BACKUP_SUBDIR}/game1-a/latest.json`)).toBe(false)
  })
})
