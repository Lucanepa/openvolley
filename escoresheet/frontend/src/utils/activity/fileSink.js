/**
 * The activity log as daily files in the apps, next to the native backups:
 *   desktop:  <data dir>/OpenVolley/logs/activity-YYYY-MM-DD.jsonl
 *             (src-tauri/src/activity.rs: activity_append, activity_open_dir)
 *   Android:  Documents/OpenVolley/logs/activity-YYYY-MM-DD.jsonl
 *             (@capacitor/filesystem, the folders the backups use)
 *   browser:  none (Dexie only)
 * One JSON object per line; written every 2 s or 50 lines and on quit. At
 * most 30 daily files and 50 MB are kept. Never throws into the app.
 */
import { detectBackupPlatform } from '../nativeBackup/platform'

export const LOG_SUBDIR = 'OpenVolley/logs'
export const FILE_FLUSH_MS = 2000
export const FILE_FLUSH_LINES = 50
export const KEEP_FILES = 30
export const KEEP_BYTES = 50 * 1024 * 1024
const FILE_RE = /^activity-\d{4}-\d{2}-\d{2}\.jsonl$/

export const activityFileName = (date = new Date()) => `activity-${date.toISOString().slice(0, 10)}.jsonl`

/** The line of a stored row (no local bookkeeping). */
export function activityLine(row) {
  const { lid: _lid, synced: _synced, ...rest } = row || {}
  return JSON.stringify(rest)
}

/** Which files to delete: oldest beyond keepFiles or keepBytes (the newest stays). */
export function planLogPrune(files, { keepFiles = KEEP_FILES, keepBytes = KEEP_BYTES } = {}) {
  const list = (files || []).filter(f => FILE_RE.test(f.name)).sort((a, b) => (a.name < b.name ? 1 : -1))
  const out = []
  let total = 0
  list.forEach((f, i) => {
    total += f.size || 0
    if (i > 0 && (i >= keepFiles || total > keepBytes)) out.push(f.name)
  })
  return out
}

function tauriWriter(invoke) {
  return {
    async write(lines) {
      for (let i = 0; i < lines.length; i += 500) {
        await invoke('activity_append', { lines: lines.slice(i, i + 500) })
      }
    },
    async openFolder() {
      await invoke('activity_open_dir')
      return true
    }
  }
}

function capacitorWriter({ Filesystem, Directory, Encoding }, { log = console } = {}) {
  const candidates = [Directory.Documents, Directory.External, Directory.Data].filter(Boolean)
  let ready = null
  let lastPrune = 0

  async function probe() {
    for (const dir of candidates) {
      try {
        try {
          await Filesystem.mkdir({ path: LOG_SUBDIR, directory: dir, recursive: true })
        } catch (e) {
          if (!/exist/i.test(String(e?.message || e))) throw e
        }
        await Filesystem.stat({ path: LOG_SUBDIR, directory: dir })
        return dir
      } catch (e) {
        log.warn?.(`[Activity] ${dir} is not writable for logs, trying the next folder:`, e?.message || e)
      }
    }
    throw new Error('No writable folder for logs on this device')
  }
  const directory = () => {
    if (!ready) ready = probe().catch((e) => { ready = null; throw e })
    return ready
  }

  async function prune(dir) {
    if (Date.now() - lastPrune < 60 * 60 * 1000) return
    lastPrune = Date.now()
    try {
      const { files } = await Filesystem.readdir({ path: LOG_SUBDIR, directory: dir })
      for (const name of planLogPrune((files || []).map(f => ({ name: f.name, size: f.size || 0 })))) {
        try { await Filesystem.deleteFile({ path: `${LOG_SUBDIR}/${name}`, directory: dir }) } catch { /* left by an older install */ }
      }
    } catch (e) {
      log.warn?.('[Activity] log prune failed:', e?.message || e)
    }
  }

  return {
    async write(lines) {
      const dir = await directory()
      const path = `${LOG_SUBDIR}/${activityFileName()}`
      const data = lines.join('\n') + '\n'
      try {
        await Filesystem.appendFile({ path, data, directory: dir, encoding: Encoding.UTF8 })
      } catch {
        // the day's first line: appendFile needs the file on some versions
        await Filesystem.writeFile({ path, data, directory: dir, encoding: Encoding.UTF8, recursive: true })
      }
      await prune(dir)
    },
    async openFolder() {
      return false
    }
  }
}

/**
 * @param {{ platform?: string, win?: Window, load?: () => Promise<object> }} [opts]
 * @returns {Promise<null | { add(rows: object[]): void, flush(): Promise<void>, openFolder(): Promise<boolean>, canOpenFolder: boolean }>}
 */
export async function createActivityFileSink({ platform = detectBackupPlatform(), win = typeof window !== 'undefined' ? window : undefined, load = () => import('@capacitor/filesystem') } = {}) {
  let writer = null
  try {
    if (platform === 'tauri') writer = tauriWriter((cmd, args) => win.__TAURI_INTERNALS__.invoke(cmd, args))
    else if (platform === 'capacitor') writer = capacitorWriter(await load())
  } catch (e) {
    console.warn('[Activity] no log file writer:', e?.message || e)
  }
  if (!writer) return null

  let lines = []
  let timer = null
  let chain = Promise.resolve()

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const batch = lines
    lines = []
    if (!batch.length) return chain
    chain = chain.then(() => writer.write(batch)).catch((e) => console.warn('[Activity] log file write failed:', e?.message || e))
    return chain
  }

  return {
    canOpenFolder: platform === 'tauri',
    add(rows) {
      for (const r of rows || []) lines.push(activityLine(r))
      if (lines.length >= FILE_FLUSH_LINES) flush()
      else if (!timer) timer = setTimeout(flush, FILE_FLUSH_MS)
    },
    flush,
    openFolder: () => writer.openFolder().catch(() => false)
  }
}
