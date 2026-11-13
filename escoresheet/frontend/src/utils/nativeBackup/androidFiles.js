/**
 * The Android app's own files: the match backups (platform.js
 * createCapacitorStore) and the saved scoresheet PDFs (openAppWindow
 * savePdf), both in the app's own folder (platform.appFilesDirectories:
 * internal storage). No other app, file manager or USB cable reaches them,
 * and they go with the app when it is uninstalled. Owner decision 2026-11:
 * the public Documents folder kept every roster, birth date and signature
 * open to whoever held the tablet, and after an uninstall.
 *
 * - moveLegacyFiles: at the first start of this version, the files older
 *   versions wrote to Documents/OpenVolley (or to the app's external folder,
 *   their fallback) are moved in, so the restore list still has them and
 *   nothing stays behind. Once per install; a file that cannot be moved
 *   (one an earlier install of the app left, on Android 11 and newer) stays
 *   where it is and is logged.
 * - pruneScoresheetPdfs: the PDFs follow the backups' age limit (30 days),
 *   at every start.
 * - exportToDocuments: the explicit copy out (Options, Export to Documents):
 *   each match's newest backup and every PDF into a new
 *   Documents/OpenVolley/export-<time> folder. Those copies are the user's:
 *   the app never deletes them.
 *
 * Every function takes the @capacitor/filesystem module ({ Filesystem,
 * Directory }) and never throws for one file.
 */

import { appFilesDirectories, BACKUP_SUBDIR } from './platform'
import { DEFAULT_MAX_AGE_DAYS, LATEST_FILE } from './rotation'

export const PDF_SUBDIR = 'OpenVolley/scoresheets'
export const EXPORT_PARENT = 'OpenVolley'
export const MOVED_MARKER = 'ov.androidFilesMoved'

const DAY_MS = 24 * 60 * 60 * 1000
const message = (e) => e?.message || String(e)

async function list(Filesystem, path, directory) {
  try {
    const { files } = await Filesystem.readdir({ path, directory })
    return files || []
  } catch {
    return [] // no such folder
  }
}

async function mkdirs(Filesystem, path, directory) {
  try {
    await Filesystem.mkdir({ path, directory, recursive: true })
  } catch (e) {
    if (!/exist/i.test(message(e))) throw e
  }
}

async function exists(Filesystem, path, directory) {
  try {
    await Filesystem.stat({ path, directory })
    return true
  } catch {
    return false
  }
}

// `name`, else `name (1).ext`, `(2)` ...: a file already there is never overwritten
async function freeName(Filesystem, folder, directory, name) {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`
    if (!(await exists(Filesystem, `${folder}/${candidate}`, directory))) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

/** The app's own folder for these files (the first of platform.appFilesDirectories that takes a folder). */
export async function appDirectory({ Filesystem, Directory }, subdir = BACKUP_SUBDIR) {
  for (const directory of appFilesDirectories(Directory)) {
    try {
      await mkdirs(Filesystem, subdir, directory)
      return directory
    } catch {
      // the next one
    }
  }
  throw new Error('No writable app folder on this device')
}

// May the app read the public folders without asking? (Android 10 and older:
// only with the storage permission, which a start must never ask for)
async function publicFoldersReadable(Filesystem) {
  try {
    if (typeof Filesystem.checkPermissions !== 'function') return true
    const { publicStorage } = await Filesystem.checkPermissions()
    return publicStorage === 'granted'
  } catch {
    return false
  }
}

/**
 * Moves the backups and PDFs an older version left in Documents/OpenVolley
 * (and the external folder) into the app's own folder. Once per install
 * (MOVED_MARKER in `storage`); resolves to { moved, left }.
 */
export async function moveLegacyFiles(fs, { storage = globalThis.localStorage, log = console } = {}) {
  const { Filesystem, Directory } = fs
  try {
    if (storage?.getItem(MOVED_MARKER) === '1') return { moved: 0, left: 0, skipped: true }
  } catch { /* no storage: move (again) */ }
  const backupDir = await appDirectory(fs, BACKUP_SUBDIR)
  const pdfDir = await appDirectory(fs, PDF_SUBDIR)
  const sources = []
  if (Directory.Documents && await publicFoldersReadable(Filesystem)) sources.push(Directory.Documents)
  if (Directory.External && Directory.External !== backupDir) sources.push(Directory.External)
  let moved = 0
  let left = 0
  const move = async (from, directory, to, toDirectory) => {
    try {
      await Filesystem.copy({ from, to, directory, toDirectory })
      await Filesystem.deleteFile({ path: from, directory })
      moved++
    } catch (e) {
      left++
      log.warn?.(`[AndroidFiles] cannot move ${from}:`, message(e))
    }
  }
  for (const source of sources) {
    for (const entry of await list(Filesystem, BACKUP_SUBDIR, source)) {
      if (entry.type !== 'directory') continue
      const from = `${BACKUP_SUBDIR}/${entry.name}`
      await mkdirs(Filesystem, from, backupDir).catch(() => {})
      for (const file of await list(Filesystem, from, source)) {
        if (file.type === 'directory') continue
        // the app's own latest.json (written since this start) is newer
        if (file.name === LATEST_FILE && await exists(Filesystem, `${from}/${LATEST_FILE}`, backupDir)) {
          try {
            await Filesystem.deleteFile({ path: `${from}/${file.name}`, directory: source })
          } catch { left++ }
          continue
        }
        await move(`${from}/${file.name}`, source, `${from}/${file.name}`, backupDir)
      }
      try { await Filesystem.rmdir({ path: from, directory: source }) } catch { /* not empty */ }
    }
    for (const file of await list(Filesystem, PDF_SUBDIR, source)) {
      if (file.type === 'directory') continue
      const name = await freeName(Filesystem, PDF_SUBDIR, pdfDir, file.name)
      await move(`${PDF_SUBDIR}/${file.name}`, source, `${PDF_SUBDIR}/${name}`, pdfDir)
    }
    for (const path of [BACKUP_SUBDIR, PDF_SUBDIR, EXPORT_PARENT]) {
      try { await Filesystem.rmdir({ path, directory: source }) } catch { /* not empty, or not there */ }
    }
  }
  if (moved || left) log.info?.(`[AndroidFiles] moved ${moved} file(s) into the app folder${left ? `, ${left} could not be moved` : ''}`)
  try { storage?.setItem(MOVED_MARKER, '1') } catch { /* asked again next start */ }
  return { moved, left }
}

/** Deletes the saved PDFs older than maxAgeDays (the backups' age limit). Resolves to the number deleted. */
export async function pruneScoresheetPdfs(fs, { now = Date.now(), maxAgeDays = DEFAULT_MAX_AGE_DAYS, log = console } = {}) {
  const { Filesystem, Directory } = fs
  let removed = 0
  for (const directory of appFilesDirectories(Directory)) {
    for (const file of await list(Filesystem, PDF_SUBDIR, directory)) {
      if (file.type === 'directory' || !Number(file.mtime)) continue
      if (now - Number(file.mtime) <= maxAgeDays * DAY_MS) continue
      try {
        await Filesystem.deleteFile({ path: `${PDF_SUBDIR}/${file.name}`, directory })
        removed++
      } catch (e) {
        log.warn?.('[AndroidFiles] cannot delete', file.name, message(e))
      }
    }
  }
  if (removed) log.info?.(`[AndroidFiles] removed ${removed} scoresheet PDF(s) older than ${maxAgeDays} days`)
  return removed
}

const stampOf = (date) => date.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')

/**
 * Copies each match's newest backup (latest.json, as <match folder>.json) and
 * every saved PDF into a new Documents/OpenVolley/export-<yyyymmdd-hhmm> folder.
 * @returns {Promise<{ folder: string, backups: number, scoresheets: number, failed: number }>}
 */
export async function exportToDocuments(fs, { now = new Date(), log = console } = {}) {
  const { Filesystem, Directory } = fs
  if (!Directory.Documents) throw new Error('No Documents folder on this device')
  // a new folder each time: an earlier export is never overwritten
  const target = `${EXPORT_PARENT}/${await freeName(Filesystem, EXPORT_PARENT, Directory.Documents, `export-${stampOf(now)}`)}`
  let backups = 0
  let scoresheets = 0
  let failed = 0
  const copy = async (from, directory, to) => {
    try {
      await Filesystem.copy({ from, to, directory, toDirectory: Directory.Documents })
      return true
    } catch (e) {
      failed++
      log.warn?.(`[AndroidFiles] cannot export ${from}:`, message(e))
      return false
    }
  }
  for (const directory of appFilesDirectories(Directory)) {
    const matches = (await list(Filesystem, BACKUP_SUBDIR, directory)).filter(e => e.type === 'directory')
    if (matches.length) await mkdirs(Filesystem, `${target}/backups`, Directory.Documents)
    for (const entry of matches) {
      const files = await list(Filesystem, `${BACKUP_SUBDIR}/${entry.name}`, directory)
      if (!files.some(f => f.name === LATEST_FILE)) continue
      if (await copy(`${BACKUP_SUBDIR}/${entry.name}/${LATEST_FILE}`, directory, `${target}/backups/${entry.name}.json`)) backups++
    }
    const pdfs = (await list(Filesystem, PDF_SUBDIR, directory)).filter(f => f.type !== 'directory')
    if (pdfs.length) await mkdirs(Filesystem, `${target}/scoresheets`, Directory.Documents)
    for (const file of pdfs) {
      if (await copy(`${PDF_SUBDIR}/${file.name}`, directory, `${target}/scoresheets/${file.name}`)) scoresheets++
    }
  }
  return { folder: `Documents/${target}`, backups, scoresheets, failed }
}

/**
 * Copies one saved PDF to Documents/OpenVolley/scoresheets (the PDF view's
 * Export to Documents), under a free name. Resolves to the path shown.
 */
export async function exportPdfToDocuments(fs, name) {
  const { Filesystem, Directory } = fs
  if (!Directory.Documents) throw new Error('No Documents folder on this device')
  let source = null
  for (const directory of appFilesDirectories(Directory)) {
    if (await exists(Filesystem, `${PDF_SUBDIR}/${name}`, directory)) { source = directory; break }
  }
  if (!source) throw new Error('The PDF is no longer in the app')
  await mkdirs(Filesystem, PDF_SUBDIR, Directory.Documents)
  const free = await freeName(Filesystem, PDF_SUBDIR, Directory.Documents, name)
  await Filesystem.copy({ from: `${PDF_SUBDIR}/${name}`, to: `${PDF_SUBDIR}/${free}`, directory: source, toDirectory: Directory.Documents })
  return `Documents/${PDF_SUBDIR}/${free}`
}
