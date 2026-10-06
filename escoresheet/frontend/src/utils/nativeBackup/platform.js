/**
 * Native auto-backup: platform abstraction.
 *
 * - tauri:     the desktop app. Writes go through the app's own backup_* Rust
 *              commands (src-tauri/src/backup.rs), which only ever touch
 *              <data dir>/OpenVolley/backups.
 * - capacitor: the Android (and iOS) app, via @capacitor/filesystem. Android
 *              writes to the public Documents/OpenVolley/backups folder so the
 *              owner can copy the files off the tablet (USB, Files app).
 * - web:       a browser, including the LAN tablets served by the desktop
 *              app. No native store: useAutoBackup keeps the browser
 *              behaviour (File System Access folder / downloads).
 *
 * Every store has the same shape:
 *   info()                               -> { folder: string }
 *   write(dir, name, text, { latest })   writes <dir>/<name> (+ <dir>/latest.json)
 *                                        -> { warning? } (latest.json not updated: not an error)
 *   list()                               -> [{ dir, files: [{ name, size }] }]
 *   remove(dir, names)
 *   openFolder()                         -> true when a file manager was opened
 *   pickFile()                           -> parsed JSON | null (cancelled) | undefined (not supported)
 *   canOpenFolder / canPickFile          booleans for the UI
 */

import { LATEST_FILE } from './rotation'

export const BACKUP_SUBDIR = 'OpenVolley/backups'

/** 'tauri' | 'capacitor' | 'web' */
export function detectBackupPlatform(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win) return 'web'
  try {
    if (typeof win.__TAURI_INTERNALS__?.invoke === 'function') return 'tauri'
    if (win.Capacitor?.isNativePlatform?.()) return 'capacitor'
  } catch {
    // a half-initialised bridge is treated as a browser
  }
  return 'web'
}

export const isNativeBackupPlatform = (platform) => platform === 'tauri' || platform === 'capacitor'

/** Desktop store backed by the backup_* Tauri commands. */
export function createTauriStore(invoke) {
  let folder = null
  return {
    platform: 'tauri',
    canOpenFolder: true,
    canPickFile: true,
    async info() {
      if (!folder) folder = (await invoke('backup_info'))?.dir || null
      return { folder }
    },
    async write(dir, name, text, { latest = true } = {}) {
      // Ok(Some(warning)) when only latest.json could not be replaced (Windows:
      // a virus scan or the Explorer preview holds it); the event file is saved.
      const warning = await invoke('backup_write', { matchDir: dir, fileName: name, contents: text, latest })
      return warning ? { warning } : {}
    },
    async list() {
      const dirs = await invoke('backup_list')
      return (dirs || []).map(d => ({ dir: d.dir, files: (d.files || []).map(f => ({ name: f.name, size: f.size || 0 })) }))
    },
    async remove(dir, names) {
      if (!names?.length) return
      await invoke('backup_remove', { matchDir: dir, fileNames: names })
    },
    async openFolder() {
      await invoke('backup_open_dir')
      return true
    },
    async pickFile() {
      const text = await invoke('backup_pick_file')
      if (text == null) return null
      return JSON.parse(text)
    }
  }
}

const fileUriToPath = (uri) => {
  try {
    return decodeURIComponent(String(uri).replace(/^file:\/\//, ''))
  } catch {
    return String(uri)
  }
}

/**
 * Android/iOS store backed by @capacitor/filesystem. Starts on Documents (public,
 * user-visible, survives an uninstall); if that is refused (Android 9 and older
 * without the storage permission) it falls back to the app's external files
 * folder for the rest of the session.
 * @param {{ Filesystem, Directory, Encoding }} fs the plugin module
 */
export function createCapacitorStore({ Filesystem, Directory, Encoding }, { log = console } = {}) {
  const candidates = [Directory.Documents, Directory.External, Directory.Data].filter(Boolean)
  let dirIndex = 0
  let ready = null // Promise of the working directory
  let folder = null

  const base = () => candidates[dirIndex]

  async function probe() {
    for (; dirIndex < candidates.length; dirIndex++) {
      try {
        try {
          await Filesystem.mkdir({ path: BACKUP_SUBDIR, directory: base(), recursive: true })
        } catch (e) {
          // "already exists" is fine; anything else surfaces on the stat below
          if (!/exist/i.test(String(e?.message || e))) throw e
        }
        await Filesystem.stat({ path: BACKUP_SUBDIR, directory: base() })
        try {
          const { uri } = await Filesystem.getUri({ path: BACKUP_SUBDIR, directory: base() })
          folder = fileUriToPath(uri)
        } catch {
          folder = `${base()}/${BACKUP_SUBDIR}`
        }
        return base()
      } catch (e) {
        log.warn?.(`[NativeBackup] ${base()} is not writable, trying the next folder:`, e?.message || e)
      }
    }
    throw new Error('No writable folder for backups on this device')
  }

  const directory = () => {
    if (!ready) ready = probe().catch((e) => { ready = null; dirIndex = 0; throw e })
    return ready
  }

  const writeOne = (dirName, path, text) => Filesystem.writeFile({
    path, data: text, directory: dirName, encoding: Encoding.UTF8, recursive: true
  })

  return {
    platform: 'capacitor',
    canOpenFolder: false,
    canPickFile: false,
    async info() {
      await directory()
      return { folder }
    },
    async write(dir, name, text, { latest = true } = {}) {
      const d = await directory()
      const path = `${BACKUP_SUBDIR}/${dir}/${name}`
      await writeOne(d, path, text)
      if (!latest) return {}
      const latestPath = `${BACKUP_SUBDIR}/${dir}/${LATEST_FILE}`
      try {
        // A native copy: the match JSON crosses the WebView bridge once, not twice
        if (typeof Filesystem.copy === 'function') {
          await Filesystem.copy({ from: path, to: latestPath, directory: d, toDirectory: d })
        } else {
          await writeOne(d, latestPath, text)
        }
        return {}
      } catch (e) {
        // The event file is saved. On Android 11+ a latest.json left by a
        // previous install of the app cannot be overwritten: not an error.
        return { warning: `cannot update ${dir}/${LATEST_FILE}: ${e?.message || e}` }
      }
    },
    async list() {
      const d = await directory()
      const { files: entries } = await Filesystem.readdir({ path: BACKUP_SUBDIR, directory: d })
      const dirs = []
      for (const entry of entries || []) {
        if (entry.type !== 'directory') continue
        try {
          const { files } = await Filesystem.readdir({ path: `${BACKUP_SUBDIR}/${entry.name}`, directory: d })
          dirs.push({ dir: entry.name, files: (files || []).filter(f => f.type !== 'directory').map(f => ({ name: f.name, size: f.size || 0 })) })
        } catch (e) {
          log.warn?.('[NativeBackup] cannot list', entry.name, e?.message || e)
        }
      }
      return dirs
    },
    async remove(dir, names) {
      const d = await directory()
      for (const name of names || []) {
        try {
          await Filesystem.deleteFile({ path: `${BACKUP_SUBDIR}/${dir}/${name}`, directory: d })
        } catch (e) {
          // a file left by a previous install cannot be deleted on Android 11+
          log.warn?.('[NativeBackup] cannot delete', `${dir}/${name}`, e?.message || e)
        }
      }
    },
    async openFolder() {
      return false
    },
    async pickFile() {
      return undefined
    }
  }
}

/** The store for this platform, or null in a browser. */
export async function createPlatformStore(platform = detectBackupPlatform(), win = typeof window !== 'undefined' ? window : undefined) {
  if (platform === 'tauri') {
    return createTauriStore((cmd, args) => win.__TAURI_INTERNALS__.invoke(cmd, args))
  }
  if (platform === 'capacitor') {
    const mod = await import('@capacitor/filesystem')
    return createCapacitorStore(mod)
  }
  return null
}
