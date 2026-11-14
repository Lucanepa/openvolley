/**
 * Native auto-backup for the OpenVolley apps (desktop Tauri, Android Capacitor).
 * One engine per app session, shared by useAutoBackup (App) and the scoreboard
 * Options modal.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { detectBackupPlatform, isNativeBackupPlatform, createPlatformStore } from './platform'
import { createNativeBackupEngine } from './engine'
import { isContinuedElsewhere } from '../matchReopen'

export { detectBackupPlatform, isNativeBackupPlatform } from './platform'
export { subscribeMatchWrites } from './matchWriteHook'

let enginePromise = null
let engine = null
const EMPTY_STATUS = { folder: null, lastBackup: null, lastFile: null, error: null, count: 0 }

/** The app's backup engine, or null in a browser. */
export function getNativeBackupEngine() {
  if (!isNativeBackupPlatform(detectBackupPlatform())) return Promise.resolve(null)
  if (!enginePromise) {
    enginePromise = (async () => {
      const [store, { exportMatchData }, { db }, sealer] = await Promise.all([
        createPlatformStore(),
        import('../backupManager'),
        import('../../db/db'),
        import('../backupFile').then(m => m.sessionSealer())
      ])
      // No new file of a copy another device went on with: its state is older
      // than the match's (2026-10-29, match 406970). The match row alone gives
      // the PINs whose keys are derived when the match is opened. The session's
      // sealer: the cloud copy and the downloads share the match's PIN keys.
      engine = createNativeBackupEngine({
        store,
        exportMatch: exportMatchData,
        readMatch: (matchId) => db.matches.get(matchId),
        sealer,
        skipMatch: isContinuedElsewhere,
        // Every file also goes to the USB sticks plugged in (desktop; utils/stickBackup)
        onWritten: (matchId, written) => import('../stickBackup').then(m => m.mirrorWrittenToSticks(matchId, written))
      })
      engine.subscribe(emit)
      emit()
      return engine
    })().catch((e) => {
      console.error('[NativeBackup] cannot start:', e)
      enginePromise = null
      return null
    })
  }
  return enginePromise
}

// useSyncExternalStore plumbing (works before the engine has loaded)
const listeners = new Set()
function emit() {
  for (const l of listeners) l()
}
function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const getSnapshot = () => (engine ? engine.getStatus() : EMPTY_STATUS)

/** Live backup status { folder, lastBackup, lastFile, error, count } for the UI. */
export function useNativeBackupStatus() {
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    getNativeBackupEngine().then(e => e?.loadFolder())
  }, [])
  return status
}

/** How long the app's quit waits at most for the last backup file. */
export const QUIT_BACKUP_WAIT_MS = 1500

/**
 * Before the app quits (appLifecycle), and on Android when it goes to the
 * background: the backups queued now are written at once (the last scoring
 * write's file, still in its quiet window or being written); resolves when
 * they are, or after timeoutMs at the latest, so a quit never waits longer,
 * whatever the disk does. At once in a browser and when the engine never
 * started. Never throws.
 */
export async function flushNativeBackups(timeoutMs = QUIT_BACKUP_WAIT_MS) {
  if (!enginePromise) return
  let timer
  try {
    await Promise.race([
      enginePromise.then(e => e?.flush({ writesOnly: true })),
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })
    ])
  } catch (e) {
    console.warn('[NativeBackup] last backup before quitting:', e?.message || e)
  } finally {
    clearTimeout(timer)
  }
}

// After the start's own work (the database, the first screen)
export const HOUSEKEEPING_DELAY_MS = 5000

// The Capacitor app's OS: 'android', 'ios', or null when it cannot tell
function capacitorOs(win) {
  try {
    return win?.Capacitor?.getPlatform?.() || null
  } catch {
    return null
  }
}

/**
 * At app start (main.jsx), a few seconds in: on Android the files older
 * versions left in the public Documents folder are moved into the app's own
 * folder (once per install, androidFiles.moveLegacyFiles) and the saved
 * scoresheet PDFs older than the backups' 30 days are deleted; on both apps
 * the rotation of the backup folders runs (it waited for the first backup of
 * a session, so a tablet that was only switched on kept every old file).
 * Nothing in a browser. Never throws.
 * Android only, not every Capacitor app: on iOS the Documents, Data and
 * External folders are one folder, which a move would empty.
 */
export async function startNativeFileHousekeeping({
  delayMs = HOUSEKEEPING_DELAY_MS,
  platform = detectBackupPlatform(),
  win = typeof window !== 'undefined' ? window : undefined
} = {}) {
  if (!isNativeBackupPlatform(platform)) return
  await new Promise(resolve => setTimeout(resolve, delayMs))
  try {
    if (platform === 'capacitor' && capacitorOs(win) === 'android') {
      const [fs, { moveLegacyFiles, pruneScoresheetPdfs }] = await Promise.all([
        import('@capacitor/filesystem'),
        import('./androidFiles')
      ])
      await moveLegacyFiles(fs).catch(e => console.warn('[AndroidFiles] moving the old files:', e?.message || e))
      await pruneScoresheetPdfs(fs).catch(e => console.warn('[AndroidFiles] PDF clean-up:', e?.message || e))
    }
    const engine = await getNativeBackupEngine()
    await engine?.cleanup()
  } catch (e) {
    console.warn('[NativeBackup] start-up clean-up:', e?.message || e)
  }
}

/**
 * Options, Export to Documents (Android): each match's newest backup and the
 * saved PDFs copied to a new Documents/OpenVolley/export-<time> folder.
 * Resolves to androidFiles.exportToDocuments's result (a file that could
 * not be copied is counted in `failed`); throws when Documents cannot be
 * written at all.
 */
export async function exportNativeFilesToDocuments() {
  const [fs, { exportToDocuments }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('./androidFiles')
  ])
  return exportToDocuments(fs)
}

/** Opens the backup folder in the file manager (desktop). */
export async function openNativeBackupFolder() {
  const e = await getNativeBackupEngine()
  if (!e?.store?.canOpenFolder) return false
  return e.store.openFolder()
}

/**
 * Native file picker opened on the backup folder (desktop). Resolves to the
 * parsed backup, null when cancelled, or undefined when the platform has no
 * native picker (use the browser file input instead).
 */
export async function pickNativeBackupFile() {
  const e = await getNativeBackupEngine()
  if (!e?.store?.canPickFile) return undefined
  return e.store.pickFile()
}
