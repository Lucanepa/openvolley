// SEC-51, SEC-52 (owner decision 9: the same rule as Android). The iOS app
// wrote its match backups, activity logs and scoresheet PDFs with directory
// DATA / EXTERNAL, which @capacitor/filesystem maps to Documents on iOS, and
// Info.plist published Documents to the Files app and over USB, editable in
// place; nothing kept the app's data out of iCloud and computer backups; the
// iOS open/share plugin handed out any existing file:// URL. From the audit
// PoC src/__audit__/native_shells/ios-documents.test.js (round 3).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { appFilesDirectories, canExportToDocuments, createCapacitorStore } from '../platform.js'
import { moveLegacyFiles, pruneScoresheetPdfs, MOVED_MARKER, PDF_SUBDIR } from '../androidFiles.js'
import { writePdfNative } from '../../openAppWindow.js'
import { createActivityFileSink } from '../../activity/fileSink.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fe = path.resolve(here, '../../../..')
const ios = (f) => readFileSync(path.join(fe, 'ios/App/App', f), 'utf8')

// @capacitor/filesystem's Directory enum values (definitions.ts)
const Directory = { Documents: 'DOCUMENTS', Data: 'DATA', Library: 'LIBRARY', LibraryNoCloud: 'LIBRARY_NO_CLOUD', Cache: 'CACHE', External: 'EXTERNAL', ExternalStorage: 'EXTERNAL_STORAGE' }
const Encoding = { UTF8: 'utf8' }
const IOS_WIN = { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' } }

// iOS: Documents, Data and External are one folder (Documents), Library/NoCloud another
const folderOf = (directory) => (['DOCUMENTS', 'DATA', 'EXTERNAL'].includes(directory) ? 'Documents' : directory === 'LIBRARY_NO_CLOUD' ? 'Library/NoCloud' : directory)

/** A recording @capacitor/filesystem over a map of `${folder}/${path}`. */
function fakeFs (files = {}) {
  const store = new Map(Object.entries(files))
  const calls = []
  const key = (directory, p) => `${folderOf(directory)}/${p}`
  const children = (directory, p) => {
    const prefix = `${key(directory, p)}/`
    const out = new Map()
    for (const k of store.keys()) {
      if (!k.startsWith(prefix)) continue
      const [head, ...rest] = k.slice(prefix.length).split('/')
      out.set(head, rest.length ? 'directory' : 'file')
    }
    return out
  }
  const Filesystem = {
    async mkdir (o) { calls.push({ op: 'mkdir', ...o }) },
    async stat (o) {
      calls.push({ op: 'stat', ...o })
      if (store.has(key(o.directory, o.path)) || children(o.directory, o.path).size || /\/(backups|logs|scoresheets)$/.test(o.path)) return { type: 'directory' }
      throw new Error('File does not exist')
    },
    async getUri (o) { return { uri: `file:///var/mobile/Containers/Data/Application/X/${key(o.directory, o.path)}` } },
    async readdir (o) {
      const c = children(o.directory, o.path)
      return { files: [...c].map(([name, type]) => ({ name, type, mtime: Date.UTC(2026, 9, 1) })) }
    },
    async writeFile (o) {
      calls.push({ op: 'writeFile', ...o })
      store.set(key(o.directory, o.path), o.data)
      return { uri: `file:///var/mobile/Containers/Data/Application/X/${key(o.directory, o.path)}` }
    },
    async appendFile (o) { calls.push({ op: 'appendFile', ...o }); store.set(key(o.directory, o.path), (store.get(key(o.directory, o.path)) || '') + o.data) },
    async readFile (o) { return { data: store.get(key(o.directory, o.path)) } },
    async copy (o) { calls.push({ op: 'copy', ...o }); store.set(key(o.toDirectory, o.to), store.get(key(o.directory, o.from))) },
    async deleteFile (o) { calls.push({ op: 'deleteFile', ...o }); store.delete(key(o.directory, o.path)) },
    async rmdir () {},
    async checkPermissions () { return { publicStorage: 'granted' } }
  }
  return { Filesystem, Directory, Encoding, calls, store }
}

describe('iOS: the app files live in Library/NoCloud, not in Documents (SEC-51)', () => {
  it('the app folder: Library/NoCloud on iOS, as before on Android', () => {
    expect(appFilesDirectories(Directory, 'ios')).toEqual(['LIBRARY_NO_CLOUD'])
    expect(appFilesDirectories(Directory, 'android')).toEqual(['DATA', 'EXTERNAL'])
    expect(appFilesDirectories(Directory, null)).toEqual(['DATA', 'EXTERNAL'])
    expect(canExportToDocuments('ios')).toBe(false)
    expect(canExportToDocuments('android')).toBe(true)
  })

  it('backups, PDFs and logs are written to Library/NoCloud', async () => {
    const fs1 = fakeFs()
    const store = createCapacitorStore(fs1, { log: { warn () {}, info () {} }, os: 'ios' })
    await store.write('game900102-abc', '20261123T100000.000Z-00001.json', '{"sealed":true}')
    expect(fs1.calls.find(c => c.op === 'writeFile')).toMatchObject({ directory: 'LIBRARY_NO_CLOUD', path: 'OpenVolley/backups/game900102-abc/20261123T100000.000Z-00001.json' })
    expect(fs1.calls.some(c => ['DATA', 'DOCUMENTS', 'EXTERNAL'].includes(c.directory))).toBe(false)

    const fs2 = fakeFs()
    const pdf = await writePdfNative(fs2, new Uint8Array([37, 80, 68, 70]).buffer, 'Scoresheet_900102.pdf', { os: 'ios' })
    expect(fs2.calls.find(c => c.op === 'writeFile').directory).toBe('LIBRARY_NO_CLOUD')
    expect(pdf.path).toBe('OpenVolley/scoresheets/Scoresheet_900102.pdf')
    expect(pdf.uri).toContain('/Library/NoCloud/OpenVolley/scoresheets/')

    const fs3 = fakeFs()
    const sink = await createActivityFileSink({ platform: 'capacitor', win: IOS_WIN, load: async () => fs3 })
    sink.add([{ kind: 'point', matchExt: '900102', accountId: 'acc-1' }])
    await sink.flush()
    const logWrite = fs3.calls.find(c => c.op === 'appendFile')
    expect(logWrite.directory).toBe('LIBRARY_NO_CLOUD')
    expect(logWrite.path).toMatch(/^OpenVolley\/logs\/activity-\d{4}-\d{2}-\d{2}\.jsonl$/)
  })

  it('what older versions left in Documents moves in at the first start, once', async () => {
    const fs = fakeFs({
      'Documents/OpenVolley/backups/game1/20261101T100000.000Z-00001.json': '{"a":1}',
      'Documents/OpenVolley/backups/game1/latest.json': '{"a":1}',
      'Documents/OpenVolley/scoresheets/Scoresheet_1.pdf': '%PDF-1.7',
      'Documents/OpenVolley/logs/activity-2026-11-01.jsonl': '{"k":1}\n'
    })
    const result = await moveLegacyFiles(fs, { os: 'ios', log: { warn () {}, info () {} } })
    expect(result).toMatchObject({ moved: 4, left: 0 })
    const keys = [...fs.store.keys()]
    expect(keys.filter(k => k.startsWith('Documents/'))).toEqual([])
    for (const p of ['OpenVolley/backups/game1/latest.json', 'OpenVolley/scoresheets/Scoresheet_1.pdf', 'OpenVolley/logs/activity-2026-11-01.jsonl', MOVED_MARKER]) {
      expect(keys, p).toContain(`Library/NoCloud/${p}`)
    }
    expect(await moveLegacyFiles(fs, { os: 'ios' })).toMatchObject({ skipped: true })
  })

  it('the PDFs follow the 30 days there too', async () => {
    const fs = fakeFs({ 'Library/NoCloud/OpenVolley/scoresheets/Old.pdf': '%PDF' })
    expect(await pruneScoresheetPdfs(fs, { os: 'ios', now: Date.UTC(2026, 10, 23), log: { warn () {}, info () {} } })).toBe(1)
    expect(fs.store.has(`Library/NoCloud/${PDF_SUBDIR}/Old.pdf`)).toBe(false)
  })
})

describe('iOS: the Files app does not show the app folder (SEC-51)', () => {
  it('Info.plist has no Files sharing and no open-in-place', () => {
    const plist = ios('Info.plist')
    expect(plist).not.toMatch(/<key>UIFileSharingEnabled<\/key>/)
    expect(plist).not.toMatch(/<key>LSSupportsOpeningDocumentsInPlace<\/key>/)
  })

  it('OpenVolleyFiles hands out only a saved PDF (or match-end ZIP) of an OpenVolley/scoresheets folder of the app (as on Android)', () => {
    const swift = ios('ScoresheetFilesPlugin.swift')
    const check = swift.slice(swift.indexOf('static func allowedPdf'), swift.indexOf('@objc func open'))
    expect(check).toMatch(/resolvingSymlinksInPath\(\)\.standardizedFileURL/)
    expect(check).toMatch(/types\.contains\(file\.pathExtension\.lowercased\(\)\)/)
    // the PDF, and the match-end ZIP "Share all files" writes there (shareFile.js); nothing else
    expect(swift).toContain('static let types: Set<String> = ["pdf", "zip"]')
    expect(check).toMatch(/!isDir\.boolValue/)
    expect(check).toMatch(/hasPrefix\(prefix\)/)
    expect(swift).toContain('static let subdir = ["OpenVolley", "scoresheets"]')
    expect(check).toMatch(/ScoresheetFilesPlugin\.allowedPdf\(url, container: URL\(fileURLWithPath: NSHomeDirectory\(\)/)
    // no file is handed out on fileExists alone any more
    expect(check).not.toMatch(/guard FileManager\.default\.fileExists\(atPath: url\.path\)/)
  })

  it('the page offers Share, not Export to Documents, on iOS', () => {
    const page = readFileSync(path.join(fe, 'src/utils/openAppWindow.js'), 'utf8')
    expect(page).toMatch(/if \(toDocuments\) actions\.append\(actionButton\(doc, t\('appWindow\.exportPdf'/)
    const options = readFileSync(path.join(fe, 'src/components/options/HomeOptionsModal.jsx'), 'utf8')
    expect(options).toContain("backup.platform === 'capacitor' && toDocuments && <ExportToDocuments")
  })
})

describe('iOS: app data is kept out of iCloud and computer backups (SEC-52)', () => {
  it('AppDelegate excludes the app folders at launch, SceneDelegate again in the background', () => {
    const app = ios('AppDelegate.swift')
    expect(app).toMatch(/didFinishLaunchingWithOptions[\s\S]{0,200}AppData\.excludeFromBackup\(\)/)
    expect(app).toMatch(/isExcludedFromBackup = true/)
    expect(app).toMatch(/for name in \["NoCloud", "WebKit"\]/)
    expect(app).toMatch(/\.documentDirectory/)
    expect(app).toMatch(/url\.lastPathComponent != "Caches"/)
    expect(ios('SceneDelegate.swift')).toMatch(/func sceneDidEnterBackground\(_ scene: UIScene\) \{\s*AppData\.excludeFromBackup\(\)/)
  })
})
